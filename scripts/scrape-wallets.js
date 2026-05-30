require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function scrapeWallets() {
  console.log('🔍 Starting x402 wallet scraper...');
  const { data } = await axios.get('https://api.agentic.market/v1/services?limit=1000', { timeout: 15000 });
  const services = data.services || [];
  console.log(`Found ${services.length} services to probe`);

  let found = 0, failed = 0, skipped = 0;

  for (const service of services) {
    const endpoints = (service.endpoints || []).slice(0, 3);
    for (const ep of endpoints) {
      const url = ep.url;
      if (!url || !url.startsWith('https://')) { skipped++; continue; }

      try {
        const method = (ep.method || 'GET').toUpperCase();
        const resp = method === 'POST'
          ? await axios.post(url, {}, { timeout: 8000, validateStatus: () => true })
          : await axios.get(url, { timeout: 8000, validateStatus: () => true });

        if (resp.status === 402) {
          const accepts = resp.data?.accepts || [];
          for (const a of accepts) {
            const payTo = a.payTo;
            if (payTo && payTo.startsWith('0x')) {
              const { error } = await supabase.from('x402_wallets').upsert({
                service_name: service.name,
                service_id: service.id,
                service_category: service.category || 'Other',
                endpoint_url: url,
                pay_to: payTo.toLowerCase(),
                network: a.network || 'eip155:8453',
                price_usdc: a.maxAmountRequired ? parseInt(a.maxAmountRequired) / 1e6 : null,
                asset_address: a.asset || null,
                domain: service.domain || service.provider || null,
                last_seen: new Date().toISOString()
              }, { onConflict: 'endpoint_url' });

              if (!error) {
                found++;
                if (found % 25 === 0) console.log(`  ✅ ${found} wallets collected...`);
              } else {
                console.error('  DB error:', error.message);
              }
            }
          }
        }
      } catch(e) { failed++; }

      await sleep(800);
    }
  }

  console.log(`\n✅ Done: ${found} wallets, ${failed} failed, ${skipped} skipped`);

  // Show summary
  const { data: rows, count } = await supabase.from('x402_wallets').select('service_category', { count: 'exact' });
  console.log('Total in DB:', count);
  if (rows) {
    const cats = {};
    rows.forEach(r => cats[r.service_category] = (cats[r.service_category]||0)+1);
    console.log('By category:', JSON.stringify(Object.entries(cats).sort((a,b)=>b[1]-a[1]).slice(0,8)));
  }
}

scrapeWallets().catch(console.error);
