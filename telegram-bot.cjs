/**
 * Dogo POS - 24/7 Telegram Admin Bot & Remote Command Controller
 * 
 * Bot Name: @DogoPOSbot
 * 
 * Configuration:
 *   Configure TELEGRAM_BOT_TOKEN in .env or config/secrets/.env
 *   (Do not hardcode API tokens directly in source code)
 * 
 * Usage:
 *   node telegram-bot.cjs
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// Safely load environment variables from .env or config/secrets/.env
function loadLocalEnv() {
  const possiblePaths = [
    path.join(__dirname, '.env'),
    path.join(__dirname, 'config', 'secrets', '.env'),
    path.join(__dirname, 'config', '.env')
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

const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
// SECURITY: only these chat IDs may use data commands. Without an allowlist
// anyone on Telegram could pull your merchant list, store names and MRR just
// by messaging @DogoPOSbot. Set TELEGRAM_ADMIN_CHAT_ID (comma-separate for
// several admins). /start, /help and /id still answer strangers so a new
// admin can discover their chat ID; everything else is refused.
const ADMIN_CHAT_IDS = (process.env.TELEGRAM_ADMIN_CHAT_ID || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://uzwomzkzqrpiumtnniik.supabase.co';
const SUPABASE_ANON_KEY = (process.env.SUPABASE_ANON_KEY || '').trim();
if (!SUPABASE_ANON_KEY) {
  console.error('\n❌ ERROR: SUPABASE_ANON_KEY is not set!');
  console.error('   Add it to .env or config/secrets/.env — see config/secrets/.env.example\n');
  process.exit(1);
}

if (!BOT_TOKEN) {
  console.error('\n❌ ERROR: TELEGRAM_BOT_TOKEN is not set!');
  console.error('Please configure your private token in .env or config/secrets/.env:');
  console.error('  TELEGRAM_BOT_TOKEN=your_token_from_botfather\n');
  console.error('See config/secrets/.env.example for details.\n');
  process.exit(1);
}

let lastUpdateId = 0;

function sendTelegramMessage(chatId, text) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });

    const options = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve({ ok: false, error: body });
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function fetchSupabase(endpoint) {
  return new Promise((resolve) => {
    const url = new URL(endpoint, SUPABASE_URL);
    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));
    req.end();
  });
}

async function handleCommand(msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const userName = msg.from.first_name || msg.from.username || 'Admin';
  const cmd = text.split(' ')[0].toLowerCase();
  // Allowlist gate: /start, /help and /id are safe (they only echo the
  // caller's own chat ID for onboarding); every data command requires a
  // listed admin chat.
  const isAllowed = ADMIN_CHAT_IDS.includes(String(chatId));
  const isOpenCommand = (cmd === '/start' || cmd === '/help' || cmd === '/id');
  if (!isAllowed && !isOpenCommand) {
    console.warn(`[Telegram] REFUSED ${cmd} from unlisted chat ${chatId} (${userName})`);
    if (ADMIN_CHAT_IDS.length === 0) {
      await sendTelegramMessage(chatId,
        '\u26d4 Bot commands are locked. Set TELEGRAM_ADMIN_CHAT_ID on the server ' +
        '(your chat ID: <code>' + chatId + '</code>) and restart the bot.');
    }
    return;
  }

  console.log(`[Telegram] Command received: ${cmd} from ${userName} (${chatId})`);

  if (cmd === '/start' || cmd === '/help') {
    const reply = `👋 <b>Hello ${userName}! Welcome to Dogo POS Bot.</b>\n\n` +
      `🔑 <b>Your Telegram Chat ID:</b> <code>${chatId}</code>\n` +
      `<i>(Copy this ID into your Admin Console at /admin to receive real-time push alerts!)</i>\n\n` +
      `<b>Available Control Commands:</b>\n` +
      `• 📊 <b>/stats</b> - Live platform metrics & store counts\n` +
      `• 💰 <b>/mrr</b> - Monthly recurring revenue summary\n` +
      `• 🏪 <b>/stores</b> - List registered merchant stores\n` +
      `• 🩺 <b>/health</b> - Real-time infrastructure latency check\n` +
      `• 🆔 <b>/id</b> - Display your numeric chat ID\n\n` +
      `<i>You will also automatically receive push notifications when merchants subscribe or pay with M-Pesa.</i>`;
    await sendTelegramMessage(chatId, reply);
    return;
  }

  if (cmd === '/id') {
    await sendTelegramMessage(chatId, `🆔 <b>Your Telegram Chat ID is:</b> <code>${chatId}</code>`);
    return;
  }

  if (cmd === '/health') {
    // Measured facts only: DB latency + how this process is configured.
    const tStart = Date.now();
    const res = await fetchSupabase('/rest/v1/businesses?select=count');
    const latency = Date.now() - tStart;
    const ok = Array.isArray(res);

    const mpesaLive = !!(process.env.MPESA_CONSUMER_KEY && process.env.MPESA_CONSUMER_SECRET);
    const paystackLive = !!process.env.PAYSTACK_SECRET_KEY;
    const darajaMode = process.env.MPESA_ENVIRONMENT === 'production' ? 'production' : 'sandbox';

    const reply = `🩺 <b>Dogo POS Infrastructure Health</b>\n\n` +
      `• <b>Database:</b> ${ok ? '🟢 Connected' : '🔴 Unreachable'} (${latency}ms)\n` +
      `• <b>M-Pesa Daraja:</b> ${mpesaLive ? '🟢 Credentials set (' + darajaMode + ')' : '🟠 No credentials — sandbox/local only'}\n` +
      `• <b>Paystack:</b> ${paystackLive ? '🟢 Secret key set' : '🟠 No secret key'}\n` +
      `• <b>Bot allowlist:</b> ${ADMIN_CHAT_IDS.length} admin chat(s)\n` +
      `• <b>Uptime:</b> ${Math.floor(process.uptime() / 60)} min`;
    await sendTelegramMessage(chatId, reply);
    return;
  }

  if (cmd === '/stats' || cmd === '/stores' || cmd === '/mrr') {
    const businesses = await fetchSupabase('/rest/v1/businesses?select=id,name,business_type,active&limit=15');
    const list = Array.isArray(businesses) ? businesses : [];
    const totalStores = list.length;
    const activeCount = list.filter(b => b.active !== false).length;

    if (cmd === '/stats') {
      const reply = `📊 <b>Dogo POS Live Platform Overview</b>\n\n` +
        `🏪 <b>Total Stores:</b> ${totalStores}\n` +
        `🟢 <b>Active Stores:</b> ${activeCount}\n` +
        `\n` +        `<i>Send /stores to view store list or /mrr for revenue breakdown.</i>`;
      await sendTelegramMessage(chatId, reply);
      return;
    }

    if (cmd === '/stores') {
      let storeLines = list.map((b, i) => `${i + 1}. <b>${b.name || 'Store'}</b> (${b.business_type || 'Retail'}) - ${b.active ? '🟢' : '🔴'}`).join('\n');
      const reply = `🏪 <b>Registered Dogo POS Stores (${list.length}):</b>\n\n` + (storeLines || 'No stores found.');
      await sendTelegramMessage(chatId, reply);
      return;
    }

    if (cmd === '/mrr') {
      const reply = `💰 <b>Dogo POS Recurring Revenue (MRR)</b>\n\n` +
        `• <b>Core POS Plan:</b> KES 999 / mo\n` +
        `• <b>Control POS + eTIMS:</b> KES 1,999 / mo\n` +
        `• <b>Active Stores:</b> ${activeCount}\n\n` +
        `👉 <i>Log into Admin Console at /admin to view verified M-Pesa ledger.</i>`;
      await sendTelegramMessage(chatId, reply);
      return;
    }
  }

  // Unknown command
  await sendTelegramMessage(chatId, `❓ Unknown command. Type <b>/help</b> or <b>/stats</b>.`);
}

function pollUpdates() {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${lastUpdateId ? lastUpdateId + 1 : 0}&timeout=25`;

  https.get(url, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', async () => {
      try {
        const data = JSON.parse(body);
        if (data.ok && Array.isArray(data.result)) {
          for (const update of data.result) {
            lastUpdateId = update.update_id;
            if (update.message && update.message.text) {
              await handleCommand(update.message);
            }
          }
        }
      } catch (e) {}
      // Poll again immediately
      setImmediate(pollUpdates);
    });
  }).on('error', (err) => {
    console.error('Polling error:', err.message);
    setTimeout(pollUpdates, 3000);
  });
}

console.log('----------------------------------------------------');
console.log('🤖 Dogo POS Telegram Bot Service Started!');
console.log(`Bot: @DogoPOSbot`);
console.log('Listening for commands: /start, /stats, /health, /mrr, /stores');
console.log('----------------------------------------------------');

pollUpdates();
