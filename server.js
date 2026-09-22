import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { paymentRouter } from './payments/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;
const HOST = '0.0.0.0';

// Body parsing with rawBody retention for webhook cryptographic signatures (HMAC verification)
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: true }));

// Serve static assets from the root directory
app.use(express.static(__dirname));

// Payment modules API endpoints
app.use('/api/payments', paymentRouter);

// Route for the platform admin console
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

// Single-page application fallback for other web routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`Dogo POS server running at http://${HOST}:${PORT}`);
});

