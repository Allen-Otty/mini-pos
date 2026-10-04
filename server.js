import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { paymentRouter } from './payments/index.js';

// Safely load environment variables from .env or config/secrets/.env
function loadLocalEnv() {
  const possiblePaths = [
    path.join(process.cwd(), '.env'),
    path.join(process.cwd(), 'config', 'secrets', '.env'),
    path.join(process.cwd(), 'config', '.env')
  ];

  for (const envPath of possiblePaths) {
    if (fs.existsSync(envPath)) {
      try {
        const raw = fs.readFileSync(envPath, 'utf8');
        const lines = raw.split(/\r?\n/);
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eq = trimmed.indexOf('=');
          if (eq > 0) {
            const key = trimmed.slice(0, eq).trim();
            const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
            if (!process.env[key]) process.env[key] = val;
          }
        }
        break;
      } catch (e) {}
    }
  }
}
loadLocalEnv();

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

// Serve static assets from the root directory (disabling default index.html auto-serving for root)
app.use(express.static(__dirname, { index: false }));

// Payment modules API endpoints
app.use('/api/payments', paymentRouter);

// Route for the platform admin console
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

// Explicit route for legacy full app if requested
app.get('/legacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Primary root route: serve dashboard.html (the permanent new look)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Application fallback for other web routes: serve existing static files or dashboard.html
app.get('*', (req, res) => {
  const cleanPath = req.path.replace(/^\/+/, '');
  const targetFile = path.join(__dirname, cleanPath);
  if (cleanPath && fs.existsSync(targetFile) && fs.statSync(targetFile).isFile()) {
    return res.sendFile(targetFile);
  }
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

function startupCheck() {
  const has = (k) => Boolean(process.env[k] && process.env[k].trim());
  const mask = (k) => has(k) ? 'set' : 'MISSING';
  const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY'];
  const gateway = {
    'M-Pesa Daraja': ['MPESA_CONSUMER_KEY', 'MPESA_CONSUMER_SECRET', 'MPESA_PASSKEY', 'MPESA_SHORTCODE'],
    'Paystack': ['PAYSTACK_SECRET_KEY'],
    'KCB Buni': ['KCB_SHARED_SECRET'],
    'Airtel Money': ['AIRTEL_CLIENT_ID', 'AIRTEL_CLIENT_SECRET']
  };

  console.log('\n================ Dogo POS startup check ================');
  let missingRequired = [];
  for (const k of required) if (!has(k)) missingRequired.push(k);
  console.log(`Auth (Supabase):  ${missingRequired.length === 0 ? 'OK' : 'BROKEN — ' + missingRequired.join(', ') + ' missing; authenticated endpoints will 503'}`);

  const mpesaProd = process.env.MPESA_ENVIRONMENT === 'production';
  for (const [name, keys] of Object.entries(gateway)) {
    const missing = keys.filter(k => !has(k));
    const prodEnv = process.env[keys[0].replace(/_CONSUMER_KEY$/, '_ENVIRONMENT')] === 'production' ||
                    process.env.MPESA_ENVIRONMENT === 'production';
    if (missing.length === 0) {
      console.log(`${name.padEnd(16)} ${prodEnv ? 'PRODUCTION' : 'sandbox'} — ready`);
    } else {
      console.log(`${name.padEnd(16)} ${prodEnv ? '!! PRODUCTION BUT INCOMPLETE — missing: ' + missing.join(', ') : 'sandbox only (missing: ' + missing.join(', ') + ')'}`);
    }
  }

  if (!process.env.APP_URL) {
    console.log('APP_URL:          MISSING — Paystack callback + Daraja registration need your public HTTPS URL');
  }
  if (process.env.NODE_ENV === 'production' && mpesaProd && !has('MPESA_CONSUMER_KEY')) {
    console.log('\n*** PRODUCTION MODE BUT M-PESA CREDENTIALS MISSING — live payments WILL FAIL. ***');
  }
  console.log('=========================================================\n');
}

app.listen(PORT, HOST, () => {
  console.log(`Dogo POS server running at http://${HOST}:${PORT}`);
  startupCheck();
});

