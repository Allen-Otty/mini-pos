// Builds native/www: a self-contained, offline copy of the web app.
// - copies the web files from the repo root
// - bundles CDN libraries + fonts locally (from native/node_modules)
// - rewrites the HTML to use the local copies
// - disables the service worker inside native shells (files are already local)
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const native = path.join(root, 'native');
const www = path.join(native, 'www');
const nm = path.join(native, 'node_modules');
const vendor = path.join(www, 'assets', 'vendor');

function must(p) {
  if (!fs.existsSync(p)) throw new Error('Missing ' + p + ' - run "npm install" inside native/ first');
  return p;
}

fs.rmSync(www, { recursive: true, force: true });
fs.mkdirSync(vendor, { recursive: true });

for (const f of fs.readdirSync(root)) {
  if (f.endsWith('.html') || f === 'manifest.json') fs.copyFileSync(path.join(root, f), path.join(www, f));
}
for (const d of ['assets', 'icons', 'images', 'admin']) {
  if (fs.existsSync(path.join(root, d))) fs.cpSync(path.join(root, d), path.join(www, d), { recursive: true });
}

const cp = (from, to) => fs.cpSync(must(path.join(nm, from)), path.join(vendor, to), { recursive: true });
cp('@supabase/supabase-js/dist/umd/supabase.js', 'supabase.js');
cp('chart.js/dist/chart.umd.js', 'chart.js');
cp('html5-qrcode/html5-qrcode.min.js', 'html5-qrcode.min.js');
cp('tesseract.js/dist/tesseract.min.js', 'tesseract.min.js');
cp('@fortawesome/fontawesome-free/css', 'fa/css');
cp('@fortawesome/fontawesome-free/webfonts', 'fa/webfonts');

fs.mkdirSync(path.join(vendor, 'fonts'), { recursive: true });
const fontDir = must(path.join(nm, '@fontsource/instrument-sans/files'));
const faces = [];
for (const w of [400, 500, 600, 700]) {
  for (const st of ['normal', 'italic']) {
    const file = `instrument-sans-latin-${w}-${st}.woff2`;
    if (fs.existsSync(path.join(fontDir, file))) {
      fs.copyFileSync(path.join(fontDir, file), path.join(vendor, 'fonts', file));
      faces.push(`@font-face{font-family:'Instrument Sans';font-style:${st};font-weight:${w};font-display:swap;src:url(fonts/${file}) format('woff2');}`);
    }
  }
}
fs.writeFileSync(path.join(vendor, 'fonts.css'), faces.join('\n'));

fs.writeFileSync(path.join(vendor, 'dogo-config.js'),
  "// Set api_url to your hosted Dogo POS server (e.g. https://your-app.onrender.com) to enable\n" +
  "// KCB / Paystack / Airtel / M-Pesa payments inside the Android and Windows apps.\n" +
  "window.DOGO_CONFIG = window.DOGO_CONFIG || { api_url: '' };\n" +
  "document.addEventListener('DOMContentLoaded', function () { document.querySelectorAll('.js-web-only').forEach(function (e) { e.style.display = 'none'; }); });\n");

const rules = [
  [/https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@2/g, 'assets/vendor/supabase.js'],
  [/https:\/\/cdn\.jsdelivr\.net\/npm\/chart\.js/g, 'assets/vendor/chart.js'],
  [/https:\/\/unpkg\.com\/html5-qrcode@2\.3\.8\/html5-qrcode\.min\.js/g, 'assets/vendor/html5-qrcode.min.js'],
  [/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/html5-qrcode\/2\.3\.8\/html5-qrcode\.min\.js/g, 'assets/vendor/html5-qrcode.min.js'],
  [/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/tesseract\.js\/4\.1\.1\/tesseract\.min\.js/g, 'assets/vendor/tesseract.min.js'],
  [/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/font-awesome\/6\.5\.1\/css\/all\.min\.css/g, 'assets/vendor/fa/css/all.min.css'],
  [/https:\/\/fonts\.googleapis\.com\/css2\?family=Instrument\+Sans[^"']*/g, 'assets/vendor/fonts.css'],
];
const SW_OLD = "if ('serviceWorker' in navigator)";
const SW_NEW = "if ('serviceWorker' in navigator && !window.Capacitor && /^https?:$/.test(location.protocol))";

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? (e.name === 'vendor' ? [] : walk(path.join(dir, e.name))) : [path.join(dir, e.name)]);
}
let touched = 0;
for (const file of walk(www).filter(f => f.endsWith('.html'))) {
  const depth = path.relative(path.dirname(file), www).split(path.sep).filter(Boolean).length;
  const pre = '../'.repeat(depth);
  let s = fs.readFileSync(file, 'utf8');
  for (const [re, to] of rules) s = s.replace(re, pre + to);
  s = s.split(SW_OLD).join(SW_NEW);
  // '/admin' is served by the Express server on the website; inside the apps there is no server
  s = s.split('href="/admin" target="_blank"').join('href="' + pre + 'admin/index.html"');
  if (!s.includes('dogo-config.js')) s = s.replace('<head>', '<head>\n<script src="' + pre + 'assets/vendor/dogo-config.js"></script>');
  fs.writeFileSync(file, s);
  touched++;
}
console.log('native/www ready (' + touched + ' html files rewritten)');
