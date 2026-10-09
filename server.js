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

// Download route for release Android APK
app.get(['/dogo-pos.apk', '/download/apk', '/apk'], (req, res) => {
  const apkPath = path.join(__dirname, 'dogo-pos.apk');
  if (fs.existsSync(apkPath)) {
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', 'attachment; filename="dogo-pos.apk"');
    return res.sendFile(apkPath);
  }
  res.status(404).send('APK not found');
});

// Download route for Windows release .exe application
app.get(['/dogo-pos.exe', '/dogo-pos-setup.exe', '/download/exe', '/exe', '/download/windows', '/windows'], (req, res) => {
  const exePath = path.join(__dirname, 'dogo-pos.exe');
  if (fs.existsSync(exePath)) {
    res.setHeader('Content-Type', 'application/vnd.microsoft.portable-executable');
    res.setHeader('Content-Disposition', 'attachment; filename="dogo-pos.exe"');
    return res.sendFile(exePath);
  }
  res.status(404).send('Windows executable not found');
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

app.listen(PORT, HOST, () => {
  console.log(`Dogo POS server running at http://${HOST}:${PORT}`);
});

