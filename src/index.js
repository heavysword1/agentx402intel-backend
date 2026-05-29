require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true });
const express = require('express');
const cors = require('cors');
const path = require('path');
const dataRouter = require('./routes/data');

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 3028;

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'agentx402intel', port: PORT }));

// Serve public dashboard
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

// Public API
app.use('/api', dataRouter);

app.listen(PORT, () => console.log(`x402 Intel running on port ${PORT}`));
