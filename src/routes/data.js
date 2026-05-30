const { createClient } = require('@supabase/supabase-js');
if(!process.env.SUPABASE_URL) require('dotenv').config({ path: require('path').join(__dirname,'../../.env') });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');
const router = express.Router();
const cache = new NodeCache({ stdTTL: 300 });

router.get('/market-data', async (req, res) => {
  const cached = cache.get('market');
  if (cached) return res.json(cached);

  const result = { generated_at: new Date().toISOString() };

  // 1. Agentic Market full services list
  try {
    const { data } = await axios.get('https://api.agentic.market/v1/services?limit=1000', { timeout: 15000 });
    const services = data.services || [];
    const byCategory = {};
    services.forEach(s => {
      const c = s.category || 'Other';
      byCategory[c] = (byCategory[c] || 0) + 1;
    });

    // Price distribution
    const prices = [];
    services.forEach(s => (s.endpoints||[]).forEach(e => {
      const p = parseFloat(e.pricing?.amount || 0);
      if (p > 0) prices.push(p);
    }));
    prices.sort((a,b) => a-b);

    // New vs established (approximate by endpoint count)
    const newServices = services.filter(s => (s.endpoints||[]).length <= 2).length;
    const richServices = services.filter(s => (s.endpoints||[]).length >= 5).length;

    result.market = {
      total: data.total || services.length,
      fetched: services.length,
      by_category: Object.entries(byCategory).sort((a,b) => b[1]-a[1]).map(([cat,count]) => ({cat, count})),
      price_stats: {
        min: prices[0] || 0,
        max: prices[prices.length-1] || 0,
        median: prices[Math.floor(prices.length/2)] || 0,
        avg: prices.length ? Math.round(prices.reduce((a,b)=>a+b,0)/prices.length*10000)/10000 : 0,
        count: prices.length
      },
      service_stats: {
        single_endpoint: newServices,
        rich_5plus: richServices,
        avg_endpoints: Math.round(services.reduce((s,x)=>s+(x.endpoints||[]).length,0)/services.length*10)/10
      },
      services: services.map(s => ({
        name: s.name,
        category: s.category || 'Other',
        endpoints: (s.endpoints||[]).length,
        networks: (s.networks||[]).join(', '),
        price_min: Math.min(...(s.endpoints||[]).map(e => parseFloat(e.pricing?.amount||0)).filter(x=>x>0)) || null,
        price_max: Math.max(...(s.endpoints||[]).map(e => parseFloat(e.pricing?.amount||0))) || null,
        domain: s.domain || s.provider || ''
      }))
    };
  } catch(e) { result.market = { error: e.message }; }

  // 2. Demand signals from nginx probes (what the market is exploring — no private data)
  try {
    const fs = require('fs');
    const lines = [];
    try { lines.push(...fs.readFileSync('/var/log/nginx/access.log','utf8').split('\n')); } catch(e){}
    try { lines.push(...fs.readFileSync('/var/log/nginx/access.log.1','utf8').split('\n')); } catch(e){}

    // 402 probes = demand signal (agents exploring before buying)
    const probes = lines.filter(l =>
      (l.includes('GET /x402') || l.includes('POST /x402')) && l.includes(' 402 ') &&
      !l.includes('bazaar-settle') && !l.includes('settle-memory')
    );

    const probeCounts = {};
    const proberIPs = new Set();
    probes.forEach(l => {
      const m = l.match(/"(?:GET|POST) (\/x402[^\s?]+)/);
      const ip = l.split(' ')[0];
      if (m) probeCounts[m[1]] = (probeCounts[m[1]] || 0) + 1;
      if (ip && ip !== '-') proberIPs.add(ip);
    });

    // Category-level demand
    const catDemand = {};
    Object.entries(probeCounts).forEach(([ep, count]) => {
      const parts = ep.split('/');
      const service = parts[2] || 'unknown';
      catDemand[service] = (catDemand[service] || 0) + count;
    });

    result.demand = {
      total_probes_24h: probes.length,
      unique_probers: proberIPs.size,
      top_endpoints: Object.entries(probeCounts).sort((a,b)=>b[1]-a[1]).slice(0,15).map(([ep,n])=>({ep,n})),
      by_service: Object.entries(catDemand).sort((a,b)=>b[1]-a[1]).slice(0,12).map(([svc,n])=>({svc,n}))
    };
  } catch(e) { result.demand = { error: e.message }; }

  // 3. Volume leaderboard from scraped + indexed wallets
  try {
    const { data: leaders } = await supabase
      .from('x402_wallets')
      .select('service_name, service_category, domain, pay_to, total_usdc_received, tx_count')
      .gt('tx_count', 0)
      .order('total_usdc_received', { ascending: false })
      .limit(100);

    const walletMap = {};
    (leaders || []).forEach(r => {
      const key = r.pay_to;
      if (!walletMap[key]) walletMap[key] = { service: r.service_name, category: r.service_category, domain: r.domain, usdc: r.total_usdc_received || 0, txs: r.tx_count || 0 };
      else { walletMap[key].usdc = Math.max(walletMap[key].usdc, r.total_usdc_received||0); walletMap[key].txs = Math.max(walletMap[key].txs, r.tx_count||0); }
    });

    result.leaderboard = Object.values(walletMap).sort((a,b) => b.usdc - a.usdc).slice(0,20).map((r,i) => ({ rank:i+1, service:r.service, category:r.category, domain:r.domain, total_usdc:Math.round(r.usdc*100)/100, tx_count:r.txs }));

    const allStats = (leaders||[]);
    const uniqueWallets = new Set(allStats.map(r=>r.pay_to));
    const totalUsdc = Object.values(walletMap).reduce((s,r)=>s+r.usdc,0);
    const totalTxs = Object.values(walletMap).reduce((s,r)=>s+r.txs,0);
    result.ecosystem_stats = {
      total_usdc_volume: Math.round(totalUsdc*100)/100,
      total_transactions: totalTxs,
      active_services: uniqueWallets.size,
      avg_per_service: uniqueWallets.size ? Math.round(totalUsdc/uniqueWallets.size*100)/100 : 0
    };
  } catch(e) { result.leaderboard = { error: e.message }; result.ecosystem_stats = {}; }

  result.generated_at = new Date().toISOString();
  cache.set('market', result);
  res.json(result);
});

module.exports = router;
