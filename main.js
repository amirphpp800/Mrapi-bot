/*
Cloudflare Worker — Telegram WireGuard Bot (Enhanced)

Features:
- Telegram webhook handler
- Workers KV for persistence (binding name: BOT_KV)
- Optional join-to-use check (JOIN_CHAT)
- Upload: user sends a document -> stored metadata in KV -> returns private link /f/<token>
- Download: /f/<token>?uid=<telegram_id>&ref=<referrer_id>
- Enhanced admin panel with authentication, real-time stats, and file management
- Service toggle, file disable/enable, cost management
- Beautiful glassmorphism design with Persian support

Bindings required when deploying:
- KV namespace binding named BOT_KV

Sections (edit guide):
1) Config & Runtime
2) KV helpers
3) Telegram helpers (API wrappers, multipart upload)
4) Utility (time, formatting)
5) Settings & Date helpers
6) Session helpers
7) Inline UI helpers (links, dynamic menus)
8) HTTP entrypoints (fetch, routes)
9) Telegram webhook handling (updates, callbacks)
10) Features & flows:
   - Main menu, Profile & Account
   - Tickets, Balance Transfer
   - Missions, Lottery
   - File management, Gifts
   - Admin panel & Settings (Disable Buttons)
   - Backup (export)
11) Storage helpers (tickets, missions, lottery, files, users)
12) Public endpoints (backup, file download)
*/

import ranges from './ranges.js';
import { handleWireguardCallback, handleWireguardMyConfig } from './wg.js';

/* ==================== 1) Config & Runtime (EDIT HERE) ==================== */
// IMPORTANT: Set secrets in environment variables for production. The values
// below are fallbacks to help local testing. Prefer configuring via `env`.
// EDIT: TELEGRAM_TOKEN, ADMIN_IDS, ADMIN_KEY, WEBHOOK_URL, JOIN_CHAT
const TELEGRAM_TOKEN = "7591077984:AAGIkAtFPz8Qp7vBBSDVOozNC5zZvZFQlKU";

const ADMIN_IDS = []; // provide via env `ADMIN_IDS` (comma-separated)
const ADMIN_KEY = ""; // provide via env `ADMIN_KEY`
const WEBHOOK_URL = ""; // provide via env `WEBHOOK_URL`
const JOIN_CHAT = ""; // provide via env `JOIN_CHAT`

// Runtime configuration (populated per-request from env)
let RUNTIME = {
  tgToken: null,
  webhookUrl: null,
  webhookSecret: null,
  adminKey: null,
  adminIds: null,
  joinChat: null,
};

// Main admin and payments config (EDIT: customize display name and packages)
const MAIN_ADMIN_ID = (Array.isArray(ADMIN_IDS) && ADMIN_IDS.length ? ADMIN_IDS : [])[0];
const MAIN_ADMIN_USERNAME = 'minimalcraft'; // for display only
// EDIT: Payment packages (diamonds and prices)
const DIAMOND_PACKAGES = [
  { id: 'd10', diamonds: 10, price_toman: 15000 },
  { id: 'd15', diamonds: 15, price_toman: 25000 },
  { id: 'd25', diamonds: 25, price_toman: 35000 },
  { id: 'd35', diamonds: 35, price_toman: 45000 }
];
/* -------------------- New Admin Page (Tabbed UI) -------------------- */
async function handleAdminPage(req, env, url, ctx) {
  const key = url.searchParams.get('key');
  const adminKey = (RUNTIME.adminKey || ADMIN_KEY || '').trim();
  const authed = key === adminKey;
  if (!authed) {
    const html = `<!doctype html><html lang="fa" dir="rtl"><head>
      <meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
      <title>ورود مدیر</title>
      <style>
        body{margin:0;font-family:Segoe UI,Tahoma,Arial;background:#0b1220;color:#e5e7eb;display:flex;align-items:center;justify-content:center;min-height:100vh}
        .card{width:360px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.15);border-radius:16px;padding:24px;backdrop-filter:blur(10px)}
        h1{margin:0 0 10px 0}
        input{width:100%;padding:12px;border-radius:10px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#fff}
        button{width:100%;margin-top:10px;padding:12px;border:none;border-radius:10px;background:linear-gradient(135deg,#3b82f6,#1d4ed8);color:#fff;cursor:pointer}
      </style></head><body>
      <div class="card"><h1>🔐 ورود مدیر</h1>
        <form method="GET" action="/admin">
          <input type="password" name="key" placeholder="ADMIN_KEY" required/>
          <button type="submit">ورود</button>
        </form>
      </div></body></html>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  const users = (await kvGetJson(env, 'index:users')) || [];
  const enabled = (await kvGetJson(env, 'bot:enabled')) ?? true;
  const lastWebhookAt = (await kvGetJson(env, 'bot:last_webhook')) || 0;
  const connected = typeof lastWebhookAt === 'number' && (now() - lastWebhookAt) < 5 * 60 * 1000;
  const files = [];
  let totalDownloads = 0;
  for (const uid of users.slice(0, 100)) {
    const list = (await kvGetJson(env, `uploader:${uid}`)) || [];
    for (const t of list) {
      const f = await kvGetJson(env, `file:${t}`);
      if (f) { files.push(f); totalDownloads += f.downloads || 0; }
    }
  }
  const fileCount = files.length;
  const updateMode = (await kvGetJson(env, 'bot:update_mode')) || false;
  const settings = await getSettings(env);
  const webhookInfo = await tgGetWebhookInfo();
  const desiredWebhook = (RUNTIME.webhookUrl || WEBHOOK_URL || url.origin || '');

  const html = `<!doctype html><html lang="fa" dir="rtl"><head>
    <meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
    <title>پنل مدیریت</title>
    <style>
      :root{
        --bg:#0a0f1f; --bg2:#0d1326; --panel:#0f172a; --glass:rgba(255,255,255,.06);
        --muted:#9aa7bd; --accent:#6ea8fe; --accent2:#22d3ee; --accent3:#a78bfa;
        --ok:#22c55e; --bad:#ef4444; --border:rgba(255,255,255,.12)
      }
      *{box-sizing:border-box}
      body{margin:0;font-family:Segoe UI,Tahoma,Arial;background:linear-gradient(135deg,var(--bg),var(--bg2));color:#e5e7eb}
      .topbar{position:sticky;top:0;z-index:10;display:flex;align-items:center;justify-content:space-between;padding:16px 20px;background:rgba(13,19,38,.65);backdrop-filter:blur(10px);border-bottom:1px solid var(--border)}
      .brand{display:flex;align-items:center;gap:10px;font-weight:600}
      .brand .dot{width:10px;height:10px;border-radius:50%;background:radial-gradient(circle at 30% 30%, var(--accent), transparent)}
      .badge{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border-radius:999px;border:1px solid var(--border);background:var(--glass)}
      .ok{color:var(--ok)} .bad{color:var(--bad)}
      .container{max-width:1280px;margin:0 auto;padding:22px}
      .tabs{display:flex;gap:8px;flex-wrap:nowrap;margin:16px 0;overflow:auto;padding-bottom:6px}
      .tab{padding:10px 14px;border:1px solid var(--border);border-radius:12px;background:#111827;cursor:pointer;white-space:nowrap}
      .tab.active{border-color:var(--accent);box-shadow:0 0 0 1px rgba(110,168,254,.35) inset, 0 8px 24px rgba(110,168,254,.15)}
      .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}
      .card{background:linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.03));border:1px solid var(--border);border-radius:16px;padding:18px;position:relative;overflow:hidden}
      .card::after{content:'';position:absolute;inset:0;border-radius:16px;padding:1px;background:linear-gradient(135deg, rgba(110,168,254,.35), rgba(34,211,238,.15), rgba(167,139,250,.15));-webkit-mask:linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude}
      .stat{display:flex;align-items:center;gap:12px}
      .stat .icon{font-size:22px;opacity:.9}
      table{width:100%;border-collapse:collapse}
      th,td{padding:12px;border-bottom:1px solid rgba(255,255,255,.08);text-align:right}
      .table-wrap{overflow:auto}
      input,select{width:100%;padding:12px;border-radius:12px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#fff}
      .btn{display:inline-block;padding:10px 14px;border-radius:12px;border:none;background:linear-gradient(135deg,var(--accent),#1d4ed8);color:#fff;cursor:pointer;transition:.2s box-shadow,.2s transform}
      .btn:hover{transform:translateY(-1px);box-shadow:0 10px 24px rgba(110,168,254,.25)}
      .btn-danger{background:linear-gradient(135deg,#ef4444,#dc2626)} .btn-success{background:linear-gradient(135deg,#22c55e,#16a34a)}
      .muted{color:var(--muted);font-size:.92rem}
      .hidden{display:none}
      footer{opacity:.75;text-align:center;margin-top:24px;font-size:.9rem}
      @media (max-width: 640px){ .container{padding:14px} th,td{padding:10px} }
    </style>
  </head><body>
    <div class="topbar">
      <div class="brand"><span class="dot"></span><span>🤖 پنل مدیریت</span></div>
      <div class="badge">وبهوک: <span class="${connected?'ok':'bad'}">${connected?'آنلاین':'آفلاین'}</span></div>
    </div>
    <div class="container">
      <div class="tabs">
        <button class="tab active" data-tab="dash">داشبورد</button>
        <button class="tab" data-tab="users">کاربران</button>
        <button class="tab" data-tab="files">فایل‌ها</button>
        <button class="tab" data-tab="settings">تنظیمات</button>
        <button class="tab" data-tab="diag">عیب‌یابی</button>
      </div>

      <section id="tab-dash" class="card">
        <div class="grid">
          <div class="card stat"><div class="icon">👥</div><div><div class="muted">کاربران</div><h2>${users.length.toLocaleString('fa-IR')}</h2></div></div>
          <div class="card stat"><div class="icon">📁</div><div><div class="muted">فایل‌ها</div><h2>${fileCount.toLocaleString('fa-IR')}</h2></div></div>
          <div class="card stat"><div class="icon">📥</div><div><div class="muted">دانلودها</div><h2>${totalDownloads.toLocaleString('fa-IR')}</h2></div></div>
          <div class="card"><div class="muted">سرویس</div><h2 class="${enabled?'ok':'bad'}">${enabled?'فعال':'غیرفعال'}</h2>
            <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap;">
              <a class="btn ${enabled?'btn-danger':'btn-success'}" href="/admin?key=${adminKey}&action=toggle">${enabled?'غیرفعال':'فعال'}</a>
              <a class="btn" href="/admin?key=${adminKey}&action=setup-webhook">راه‌اندازی وبهوک</a>
            </div>
          </div>
        </div>
      </section>

      <section id="tab-users" class="card hidden">
        <div class="muted">نخستین ۳۰ کاربر</div>
        <div class="table-wrap"><table><thead><tr><th>آی‌دی</th><th>یوزرنیم</th><th>سکه</th><th>وضعیت</th><th>اقدام</th></tr></thead><tbody>
          ${(await Promise.all(users.slice(0,30).map(async uid=>{const u=await kvGetJson(env,`user:${uid}`)||{};const b=await isUserBlocked(env,uid);return `
            <tr><td>${uid}</td><td>${escapeHtml(u.username||'-')}</td><td>${(u.diamonds||0).toLocaleString('fa-IR')}</td><td>${b?'⛔️ مسدود':'🟢 فعال'}</td>
            <td>${b?`<a class=\"btn btn-success\" href=\"/admin?key=${adminKey}&op=unblock&uid=${uid}\">آنبلاک</a>`:`<a class=\"btn btn-danger\" href=\"/admin?key=${adminKey}&op=block&uid=${uid}\">Block</a>`}</td></tr>`;}))).join('')}
        </tbody></table></div>
      </section>

      <section id="tab-files" class="card hidden">
        <div class="muted">${Math.min(files.length,50)} فایل اخیر</div>
        <div class="table-wrap"><table><thead><tr><th>نام</th><th>دانلود</th><th>هزینه</th><th>وضعیت</th></tr></thead><tbody>
          ${files.slice(0,50).map(f=>`<tr><td>${escapeHtml(f.name||'-')}</td><td>${(f.downloads||0).toLocaleString('fa-IR')}</td><td>${(f.cost_points||0)}</td><td>${f.disabled?'🔴 غیرفعال':'🟢 فعال'}</td></tr>`).join('')}
        </tbody></table></div>
      </section>

      <section id="tab-settings" class="card hidden">
        <form method="GET" action="/admin">
          <input type="hidden" name="key" value="${adminKey}"/>
          <input type="hidden" name="action" value="save-settings"/>
          <div class="grid">
            <div class="card"><label class="muted">هزینه DNS</label><input name="cost_dns" type="number" value="${settings.cost_dns}"/></div>
            <div class="card"><label class="muted">هزینه WireGuard</label><input name="cost_wg" type="number" value="${settings.cost_wg}"/></div>
            <div class="card"><label class="muted">هزینه OpenVPN</label><input name="cost_ovpn" type="number" value="${settings.cost_ovpn}"/></div>
            <div class="card"><label class="muted">کانال اجباری</label><input name="join_chat" type="text" value="${RUNTIME.joinChat||''}" placeholder="مثلا @mychannel"/></div>
          </div>
          <div style="margin-top:12px"><button class="btn" type="submit">ذخیره تنظیمات</button></div>
        </form>
      </section>

      <section id="tab-diag" class="card hidden">
        <div class="grid">
          <div class="card"><div class="muted">توکن تلگرام</div><div>${(RUNTIME.tgToken||TELEGRAM_TOKEN)?'✅ تنظیم شده':'❌ تنظیم نشده'}</div></div>
          <div class="card"><div class="muted">وبهوک مطلوب</div><code>${desiredWebhook||'-'}</code></div>
          <div class="card"><div class="muted">وبهوک فعلی</div><code>${(webhookInfo&&webhookInfo.result&&webhookInfo.result.url)||'-'}</code></div>
          <div class="card"><div class="muted">آخرین Update</div>${lastWebhookAt?new Date(lastWebhookAt).toLocaleString('fa-IR'):'-'}</div>
        </div>
        <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;">
          <a class="btn" href="/admin?key=${adminKey}&action=setup-webhook">راه‌اندازی وبهوک</a>
          <a class="btn btn-danger" href="/admin?key=${adminKey}&action=delete-webhook">حذف وبهوک</a>
        </div>
      </section>

    </div>
    <footer>ساخته‌شده با ❤️ — رابط کاربری جدید با پالت رنگی بهبود یافته</footer>
    <script>
      const tabs=document.querySelectorAll('.tab');
      const sections={dash:'#tab-dash',users:'#tab-users',files:'#tab-files',settings:'#tab-settings',diag:'#tab-diag'};
      tabs.forEach(t=>t.addEventListener('click',()=>{tabs.forEach(x=>x.classList.remove('active'));t.classList.add('active');
        document.querySelectorAll('section.card').forEach(s=>s.classList.add('hidden'));
        const id=sections[t.dataset.tab]; if(id) document.querySelector(id).classList.remove('hidden');
      }));
    </script>
  </body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// EDIT: Bank/card details for manual payments
const BANK_CARD_NUMBER = '6219 8619 4308 4037';
const BANK_CARD_NAME = 'امیرحسین سیاهبالائی';

function getDiamondPackageById(id) {
  return DIAMOND_PACKAGES.find(p => p.id === id) || DIAMOND_PACKAGES[0];
}

const TELEGRAM_API = (token) => `https://api.telegram.org/bot${token}`;
const TELEGRAM_FILE_API = (token) => `https://api.telegram.org/file/bot${token}`;

// dynamic admins cache (refreshed per webhook)
let DYNAMIC_ADMIN_IDS = [];

/* ==================== 8) HTTP Entrypoint (router) ==================== */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Populate runtime config from env for this request
    try {
      populateRuntimeFromEnv(env);
    } catch (_) {}

    // Explicit Telegram webhook endpoint
    if (url.pathname === '/webhook' && request.method === 'POST') {
      try { await handleTelegramWebhook(request, env); } catch (_) {}
      return new Response('ok');
    }

    // Back-compat: accept POST to any path except /api/* as webhook, process inline
    if (request.method === 'POST' && !url.pathname.startsWith('/api/')) {
      try { await handleTelegramWebhook(request, env); } catch (_) {}
      return new Response('ok');
    }

    // Root page: Status only (no admin panel)
    if (url.pathname === '/' && request.method === 'GET') {
      // Gather lightweight status
      const users = (await kvGetJson(env, 'index:users')) || [];
      const enabled = (await kvGetJson(env, 'bot:enabled')) ?? true;
      const lastWebhookAt = (await kvGetJson(env, 'bot:last_webhook')) || 0;
      const connected = typeof lastWebhookAt === 'number' && (now() - lastWebhookAt) < 5 * 60 * 1000;
      const settings = await getSettings(env);
      const webhookInfo = await tgGetWebhookInfo();
      const desiredWebhook = (RUNTIME.webhookUrl || WEBHOOK_URL || url.origin || '');

      const row = (k, v) => `<tr><td style="padding:10px;border-bottom:1px solid rgba(255,255,255,.08);text-align:right">${k}</td><td style="padding:10px;border-bottom:1px solid rgba(255,255,255,.08);text-align:left">${v}</td></tr>`;
      const html = `<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
      <title>وضعیت ربات</title>
      <body style="margin:0;font-family:Segoe UI,Tahoma,Arial;background:#0b1220;color:#e5e7eb;">
        <div style="max-width:860px;margin:0 auto;padding:24px">
          <h1 style="margin:0 0 12px 0">📊 وضعیت کلی ربات</h1>
          <div style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.15);border-radius:16px;overflow:hidden">
            <table style="width:100%;border-collapse:collapse">
              ${row('سرویس', enabled ? '<span style="color:#22c55e">فعال</span>' : '<span style="color:#ef4444">غیرفعال</span>')}
              ${row('کاربران', users.length.toLocaleString('fa-IR'))}
              ${row('آخرین وبهوک', lastWebhookAt ? new Date(lastWebhookAt).toLocaleString('fa-IR') : '-')}
              ${row('اتصال وبهوک', connected ? '<span style="color:#22c55e">آنلاین</span>' : '<span style="color:#ef4444">آفلاین</span>')}
              ${row('Webhook مطلوب', desiredWebhook ? `<code>${desiredWebhook}</code>` : '-')}
              ${row('Webhook فعلی تلگرام', (webhookInfo&&webhookInfo.result&&webhookInfo.result.url) ? `<code>${webhookInfo.result.url}</code>` : '-')}
              ${row('هزینه‌ها (DNS/WG/OVPN)', `${settings.cost_dns}/${settings.cost_wg}/${settings.cost_ovpn}`)}
              ${row('توکن تلگرام', (RUNTIME.tgToken||'').length ? '✅' : '❌')}
            </table>
          </div>
          <div style="opacity:.75;margin-top:10px;font-size:.9rem">Health: <a href="/health" style="color:#6ea8fe">/health</a> — MiniApp: <a href="/miniapp" style="color:#6ea8fe">/miniapp</a></div>
        </div>
      </body></html>`;
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    // Mini app public page (Top Referrers) — GET
    if (url.pathname === '/miniapp' && request.method === 'GET') {
      return handleMiniApp(env);
    }

    // File public link
    if (url.pathname.startsWith('/f/')) return handleFileDownload(request, env, url);

    // Diagnostic: send a test message (temporary). Usage: /diag-send?key=ADMIN_KEY&uid=123&text=hi
    if (url.pathname === '/diag-send' && request.method === 'GET') {
      const key = url.searchParams.get('key') || '';
      const adminKey = (RUNTIME.adminKey || ADMIN_KEY || '').trim();
      if (!adminKey || key !== adminKey) {
        return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      }
      const uid = Number(url.searchParams.get('uid') || '');
      const text = url.searchParams.get('text') || 'ping';
      if (!Number.isFinite(uid) || uid <= 0) {
        return new Response(JSON.stringify({ ok: false, error: 'bad uid' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      const res = await tgApi('sendMessage', { chat_id: uid, text });
      return new Response(JSON.stringify(res || { ok: false }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Health check
    if (url.pathname === '/health') return new Response('ok');

    // 404
    return new Response('Not Found', { status: 404 });
  },
  // Daily cron handler (configure a Cron Trigger in Cloudflare dashboard)
  async scheduled(controller, env, ctx) {
    const run = runDailyTasks(env);
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(run); else await run;
  }
};

/* ==================== 2) KV helpers ==================== */
async function kvGetJson(env, key) {
  try {
    if (!env || !env.BOT_KV || typeof env.BOT_KV.get !== 'function') return null;
    const v = await env.BOT_KV.get(key);
    return v ? JSON.parse(v) : null;
  } catch (_) {
    return null;
  }
}
async function kvPutJson(env, key, obj) {
  try {
    if (!env || !env.BOT_KV || typeof env.BOT_KV.put !== 'function') return;
    return await env.BOT_KV.put(key, JSON.stringify(obj));
  } catch (_) { return; }
}
async function kvDelete(env, key) {
  try {
    if (!env || !env.BOT_KV || typeof env.BOT_KV.delete !== 'function') return;
    return await env.BOT_KV.delete(key);
  } catch (_) { return; }
}

/* ==================== 3) Telegram helpers ==================== */
function populateRuntimeFromEnv(env) {
  // Use hardcoded token as requested; ignore env for TELEGRAM_TOKEN
  RUNTIME.tgToken = TELEGRAM_TOKEN || '';
  RUNTIME.webhookUrl = env?.WEBHOOK_URL || WEBHOOK_URL || '';
  RUNTIME.webhookSecret = null; // secret disabled
  RUNTIME.adminKey = env?.ADMIN_KEY || ADMIN_KEY || '';
  RUNTIME.joinChat = env?.JOIN_CHAT || JOIN_CHAT || '';
  const adminIdsStr = env?.ADMIN_IDS || '';
  if (adminIdsStr && typeof adminIdsStr === 'string') {
    const parsed = adminIdsStr.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n));
    if (parsed.length) RUNTIME.adminIds = parsed;
  } else if (!RUNTIME.adminIds || !RUNTIME.adminIds.length) {
    RUNTIME.adminIds = (Array.isArray(ADMIN_IDS) ? ADMIN_IDS : []).map(Number).filter(Number.isFinite);
  }
}

function requireTelegramToken() {
  const token = RUNTIME.tgToken || TELEGRAM_TOKEN;
  if (!token) throw new Error('TELEGRAM_TOKEN is not configured');
  return token;
}

async function tgApi(method, body) {
  try {
    const token = requireTelegramToken();
    return fetch(`${TELEGRAM_API(token)}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).then(r => r.json());
  } catch (_) {
    // No token configured; avoid crashing the request path
    return { ok: false, error: 'no_token' };
  }
}
async function tgGet(path) {
  try {
    const token = requireTelegramToken();
    return fetch(`${TELEGRAM_API(token)}/${path}`).then(r => r.json());
  } catch (_) {
    // No token configured
    return null;
  }
}

// Upload helper for multipart/form-data requests (e.g., sendDocument with a file)
async function tgUpload(method, formData) {
  try {
    const token = requireTelegramToken();
    return fetch(`${TELEGRAM_API(token)}/${method}`, {
      method: 'POST',
      body: formData
    }).then(r => r.json());
  } catch (_) {
    return { ok: false, error: 'no_token' };
  }
}

// Edit-in-place helper to reduce chat clutter (handles media; falls back to send on failure)
async function safeUpdateText(chatId, text, reply_markup, cb, parse_mode) {
  try {
    if (cb && cb.message && cb.message.message_id) {
      const isMedia = Boolean(cb.message.photo || cb.message.video || cb.message.document || cb.message.animation);
      const method = isMedia ? 'editMessageCaption' : 'editMessageText';
      const payload = {
        chat_id: chatId,
        message_id: cb.message.message_id,
        reply_markup
      };
      if (parse_mode) payload.parse_mode = parse_mode;
      if (isMedia) payload.caption = text; else payload.text = text;
      const res = await tgApi(method, payload);
      if (res && res.ok) return res;
    }
  } catch (_) {
    // ignore and fall back to send
  }
  return await tgApi('sendMessage', { chat_id: chatId, text, reply_markup, parse_mode });
}

// Bot info helpers
async function getBotInfo(env) {
  const token = RUNTIME.tgToken || TELEGRAM_TOKEN;
  const cacheKey = `bot:me:${(token || '').slice(0, 12)}`;
  let info = await kvGetJson(env, cacheKey);
  if (!info) {
    const res = await tgGet('getMe');
    if (res && res.ok) {
      info = res.result;
      await kvPutJson(env, cacheKey, info);
    }
  }
  return info || null;
}
async function getBotUsername(env) {
  const info = await getBotInfo(env);
  return info && info.username ? info.username : null;
}

// Telegram webhook helpers
async function tgSetWebhook(url) {
  try {
    const token = requireTelegramToken();
    const res = await fetch(`${TELEGRAM_API(token)}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `url=${encodeURIComponent(url)}`
    });
    return await res.json();
  } catch (_) { return null; }
}
async function tgGetWebhookInfo() {
  try {
    return await tgGet('getWebhookInfo');
  } catch (_) { return null; }
}
async function tgDeleteWebhook() {
  try {
    return await tgGet('deleteWebhook');
  } catch (_) { return null; }
}

/* ==================== 4) Utility ==================== */
function makeToken(len = 10) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '').slice(0, len);
}
// Generate a unique 8-digit numeric purchase ID
async function generatePurchaseId(env, maxAttempts = 10) {
  for (let i = 0; i < maxAttempts; i++) {
    const id = String(Math.floor(10000000 + Math.random() * 90000000));
    const exists = await kvGetJson(env, `purchase:${id}`);
    if (!exists) return id;
  }
  const fallback = String(Math.floor(Date.now() % 100000000)).padStart(8, '0');
  return fallback;
}
function now() { return Date.now(); }
function formatDate(timestamp) {
  return new Date(timestamp).toLocaleDateString('fa-IR', { 
    year: 'numeric', month: 'short', day: 'numeric', 
    hour: '2-digit', minute: '2-digit' 
  });
}
function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024; const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Small delay helper (used for /update UX)
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ===== Private Server / DNS helpers =====
// Always source ranges from the local range.json file
async function getDnsCidrConfig(env) {
  // Ignore KV and any other sources; strictly use range.json
  return ranges || {};
}
function randomIntInclusive(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
// IPv4 helpers
function ip4ToInt(ip) {
  const parts = ip.split('.').map(n => Number(n));
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}
function intToIp4(num) {
  const p1 = (num >>> 24) & 255;
  const p2 = (num >>> 16) & 255;
  const p3 = (num >>> 8) & 255;
  const p4 = num & 255;
  return `${p1}.${p2}.${p3}.${p4}`;
}
function randomIp4FromCidr(cidr) {
  const [ip, prefixStr] = cidr.split('/');
  const prefix = Number(prefixStr);
  const base = ip4ToInt(ip);
  const hostBits = 32 - prefix;
  const size = 2 ** hostBits;
  if (size <= 2) return intToIp4(base);
  const start = (base >>> hostBits) << hostBits; // network
  const rnd = randomIntInclusive(1, size - 2); // avoid network and broadcast
  return intToIp4((start + rnd) >>> 0);
}
// IPv6 helpers
function ipv6ToBigInt(ipv6) {
  let [head, tail] = ipv6.split('::');
  let headParts = head ? head.split(':') : [];
  let tailParts = tail ? tail.split(':') : [];
  if (tail === undefined) { headParts = ipv6.split(':'); tailParts = []; }
  const totalParts = headParts.length + tailParts.length;
  const missing = 8 - totalParts;
  const hextets = [ ...headParts, ...Array(Math.max(0, missing)).fill('0'), ...tailParts ].map(h => h === '' ? '0' : h);
  let value = 0n;
  for (const h of hextets) { value = (value << 16n) + BigInt(parseInt(h, 16) || 0); }
  return value;
}
function bigIntToIpv6(value) {
  const parts = [];
  for (let i = 0; i < 8; i++) {
    const shift = BigInt(112 - i * 16);
    const part = (value >> shift) & 0xffffn;
    parts.push(part.toString(16));
  }
  return parts.join(':');
}
function randomBigInt(maxExclusive) {
  const a = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
  const b = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
  const rnd = (a << 53n) ^ b;
  return rnd % maxExclusive;
}
function randomIpv6FromCidr(cidr) {
  // New format: use first two hextets from CIDR as fixed part
  // Then generate: fixed0:fixed1:hhhh::hh (h = [0-9a-f])
  try {
    const [ip] = cidr.split('/');
    const normalized = bigIntToIpv6(ipv6ToBigInt(ip)); // expand to full 8 hextets (non-zero-padded)
    const parts = normalized.split(':');
    const p0 = (parts[0] || '2001');
    const p1 = (parts[1] || 'db8');
    const randHex = (len) => Array.from({ length: len }, () => '0123456789abcdef'[Math.floor(Math.random()*16)]).join('');
    const h3 = randHex(4);
    const h8 = randHex(2);
    return `${p0}:${p1}:${h3}::${h8}`;
  } catch (_) {
    // Fallback to old behavior in case of parsing issue
    const [ip, prefixStr] = cidr.split('/');
    const prefix = Number(prefixStr);
    const base = ipv6ToBigInt(ip);
    const hostBits = 128 - prefix;
    if (hostBits <= 0) return bigIntToIpv6(base);
    const max = 1n << BigInt(hostBits);
    let offset = randomBigInt(max);
    if (max > 2n) { if (offset === 0n) offset = 1n; }
    const mask = ((1n << BigInt(prefix)) - 1n) << BigInt(hostBits);
    const network = base & mask;
    return bigIntToIpv6(network + offset);
  }
}
async function generateDnsAddresses(env, countryCode) {
  const cfg = await getDnsCidrConfig(env);
  const c = cfg[countryCode];
  if (!c) throw new Error('country_not_supported');
  const pick = (arr) => arr[randomIntInclusive(0, arr.length - 1)];
  if (!Array.isArray(c.v4) || c.v4.length === 0) throw new Error('no_ipv4_ranges');
  if (!Array.isArray(c.v6) || c.v6.length === 0) throw new Error('no_ipv6_ranges');
  const v4cidr = pick(c.v4);
  const v6cidrA = pick(c.v6);
  const v6cidrB = pick(c.v6);
  const ip4 = randomIp4FromCidr(v4cidr);
  const ip6a = randomIpv6FromCidr(v6cidrA);
  let ip6b = randomIpv6FromCidr(v6cidrB);
  if (ip6b === ip6a) ip6b = randomIpv6FromCidr(v6cidrB);
  return { ip4, ip6a, ip6b };
}
function dnsCountryLabel(code) {
  if (code === 'DE') return 'آلمان';
  return code;
}
function countryFlag(code) {
  if (code === 'DE') return '🇩🇪';
  return code;
}
function base64UrlToBase64(u) {
  const s = u.replace(/-/g, '+').replace(/_/g, '/');
  return s + '='.repeat((4 - (s.length % 4)) % 4);
}
// moved to wg.js

/* ==================== 5) Settings & Date helpers ==================== */
let SETTINGS_MEMO = null;
let SETTINGS_MEMO_AT = 0;
async function getSettings(env) {
  const nowTs = now();
  if (SETTINGS_MEMO && (nowTs - SETTINGS_MEMO_AT) < 10000) return SETTINGS_MEMO;
  const s = (await kvGetJson(env, 'bot:settings')) || {};
  SETTINGS_MEMO = {
    welcome_message: s.welcome_message || '',
    daily_limit: Number(s.daily_limit || 0) || 0,
    button_labels: s.button_labels || {},
    disabled_buttons: s.disabled_buttons || {},
    disabled_locations: s.disabled_locations || { dns: {}, wg: {}, ovpn: {} },
    cost_dns: Number.isFinite(Number(s.cost_dns)) ? Number(s.cost_dns) : 1,
    cost_wg: Number.isFinite(Number(s.cost_wg)) ? Number(s.cost_wg) : 2,
    cost_ovpn: Number.isFinite(Number(s.cost_ovpn)) ? Number(s.cost_ovpn) : 6
  };
  SETTINGS_MEMO_AT = nowTs;
  return SETTINGS_MEMO;
}
async function setSettings(env, settings) {
  await kvPutJson(env, 'bot:settings', settings || {});
  SETTINGS_MEMO = settings || null; SETTINGS_MEMO_AT = now();
}
function isButtonDisabledCached(settings, key) {
  const map = settings && settings.disabled_buttons || {};
  return !!map[key];
}
async function isButtonDisabled(env, key) {
  const s = await getSettings(env);
  return isButtonDisabledCached(s, key);
}
function isLocationDisabledCached(settings, service, code) {
  const map = settings && settings.disabled_locations || { dns: {}, wg: {} };
  const svc = String(service || '').toLowerCase();
  const svcMap = map[svc] || {};
  return !!svcMap[code];
}
async function isLocationDisabled(env, service, code) {
  const s = await getSettings(env);
  return isLocationDisabledCached(s, service, code);
}
function labelFor(labels, key, fallback) {
  if (!labels) return fallback;
  return (labels[key] && String(labels[key]).trim()) || fallback;
}
function dayKey(ts = now()) {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${dd}`;
}
function weekKey(ts = now()) {
  const d = new Date(ts);
  // ISO week number
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((target - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// ---- File takers helpers (track which users downloaded each file) ----
async function addFileTaker(env, token, uid) {
  try {
    const key = `file:${token}:takers`;
    const list = (await kvGetJson(env, key)) || [];
    if (!list.find(x => String(x.id) === String(uid))) {
      list.unshift({ id: uid, at: now() });
      if (list.length > 500) list.length = 500; // cap
      await kvPutJson(env, key, list);
    }
  } catch (_) {}
}
async function getFileTakers(env, token, limit = 50) {
  const key = `file:${token}:takers`;
  const list = (await kvGetJson(env, key)) || [];
  return list.slice(0, limit);
}

/* -------------------- Security helpers -------------------- */
function isValidTokenFormat(token) {
  if (!token || typeof token !== 'string') return false;
  if (token.length < 8 || token.length > 64) return false;
  return /^[A-Za-z0-9_-]+$/.test(token);
}
async function checkRateLimit(env, uid, action, maxOps, windowMs) {
  try {
    const key = `rl:${action}:${uid}`;
    const rec = (await kvGetJson(env, key)) || { start: 0, count: 0 };
    const nowTs = now();
    if (!rec.start || (nowTs - rec.start) > windowMs) {
      await kvPutJson(env, key, { start: nowTs, count: 1 });
      return true;
    }
    if ((rec.count || 0) >= maxOps) return false;
    rec.count = (rec.count || 0) + 1;
    await kvPutJson(env, key, rec);
    return true;
  } catch (_) { return true; }
}

/* ==================== 6) Session helpers ==================== */
async function getSession(env, uid) {
  return (await kvGetJson(env, `session:${uid}`)) || {};
}
async function setSession(env, uid, session) {
  return kvPutJson(env, `session:${uid}`, session || {});
}

/* ==================== 7) Inline UI helpers ==================== */
function domainFromWebhook() {
  const w = RUNTIME.webhookUrl || WEBHOOK_URL;
  if (!w) return '';
  return `https://${new URL(w).host}`;
}
async function getShareLink(env, token) {
  const botUsername = await getBotUsername(env);
  const domain = domainFromWebhook();
  return botUsername ? `https://t.me/${botUsername}?start=d_${token}` : (domain ? `${domain}/f/${token}` : `/f/${token}`);
}
async function buildDynamicMainMenu(env, uid) {
  const isAdminUser = isAdmin(uid);
  const settings = await getSettings(env);

  // Build rows explicitly per requested order
  const rows = [];
  // Row 1: Account | Referral
  rows.push([
    { text: '👤 حساب کاربری', callback_data: 'SUB:ACCOUNT' },
    { text: '👥 زیرمجموعه گیری', callback_data: 'SUB:REFERRAL' }
  ]);
  // Row 2: Get by token | Gift code
  rows.push([
    { text: '🔑 دریافت با توکن', callback_data: 'GET_BY_TOKEN' },
    { text: '🎁 کد هدیه', callback_data: 'REDEEM_GIFT' }
  ]);
  // Row 3: Buy coins (admins also see My Files appended on this row)
  rows.push([
    { text: '💳 خرید سکه', callback_data: 'BUY_DIAMONDS' },
    ...(isAdminUser ? [{ text: '📂 مدیریت فایل‌ها', callback_data: 'MYFILES:0' }] : [])
  ]);

  // Bottom: Admin Panel (only for admins)
  if (isAdminUser) {
    rows.push([{ text: '🛠 پنل مدیریت', callback_data: 'ADMIN:PANEL' }]);
  }

  return { inline_keyboard: rows };
}

function buildAdminPanelKeyboard() {
  const rows = [];
  rows.push([
    { text: '📚 راهنما', callback_data: 'HELP' },
    { text: '📊 آمار', callback_data: 'ADMIN:STATS' }
  ]);
  rows.push([
    { text: '🛠 حالت آپدیت', callback_data: 'ADMIN:TOGGLE_UPDATE' }
  ]);
  rows.push([
    { text: '📢 ارسال اعلان', callback_data: 'ADMIN:BROADCAST' },
    { text: '⚙️ تنظیمات سرویس', callback_data: 'ADMIN:SETTINGS' }
  ]);
  rows.push([
    { text: '🧑‍💼 جزئیات کاربر', callback_data: 'ADMIN:USER_DETAILS' }
  ]);
  rows.push([
    { text: '📂 مدیریت فایل‌ها', callback_data: 'MYFILES:0' },
    { text: '📤 آپلود فایل', callback_data: 'ADMIN:UPLOAD' }
  ]);
  rows.push([
    { text: '📣 کانال‌های اجباری', callback_data: 'ADMIN:MANAGE_JOIN' }
  ]);
  rows.push([
    { text: '👑 مدیریت ادمین‌ها', callback_data: 'ADMIN:MANAGE_ADMINS' },
    { text: '🎁 مدیریت گیفت‌کد', callback_data: 'ADMIN:GIFTS' }
  ]);
  rows.push([
    { text: '🎯 افزودن سکه', callback_data: 'ADMIN:GIVEPOINTS' },
    { text: '➖ کسر سکه', callback_data: 'ADMIN:TAKEPOINTS' }
  ]);
  rows.push([
    { text: '❄️ فریز موجودی', callback_data: 'ADMIN:FREEZE' },
    { text: '🧊 آن‌فریز موجودی', callback_data: 'ADMIN:UNFREEZE' }
  ]);
  rows.push([
    { text: '🗄 تهیه پشتیبان', callback_data: 'ADMIN:BACKUP' },
    { text: '💳 مدیریت پرداخت‌ها', callback_data: 'ADMIN:PAYMENTS' }
  ]);
  rows.push([
    { text: '🧾 مدیریت تیکت‌ها', callback_data: 'ADMIN:TICKETS' }
  ]);
  rows.push([
    { text: '🛍 مدیریت خرید پنل', callback_data: 'ADMIN:PANEL_ITEMS' }
  ]);
  rows.push([{ text: '🏠 بازگشت به منو', callback_data: 'MENU' }]);
  return { inline_keyboard: rows };
}

function buildFileManageKeyboard(token, file, isAdminUser) {
  const rows = [];
  rows.push([
    { text: '📥 دریافت', callback_data: `SEND:${token}` },
    { text: '🔗 لینک', callback_data: `LINK:${token}` }
  ]);
  if (isAdminUser) {
    rows.push([
      { text: `💰 هزینه (${(file?.cost_points||0)})`, callback_data: `COST:${token}` },
      { text: file?.disabled ? '🟢 فعال‌سازی' : '🔴 غیرفعال', callback_data: `TOGGLE:${token}` },
      { text: '🗑 حذف', callback_data: `DEL:${token}` }
    ]);
    rows.push([
      { text: '👥 دریافت‌کنندگان', callback_data: `TAKERS:${token}` }
    ]);
    rows.push([
      { text: `🔒 محدودیت (${(file?.max_downloads||0) > 0 ? file.max_downloads : '∞'})`, callback_data: `LIMIT:${token}` },
      { text: `${file?.delete_on_limit ? '🗑 حذف پس از اتمام: روشن' : '🗑 حذف پس از اتمام: خاموش'}`, callback_data: `DELAFTER:${token}` }
    ]);
    rows.push([
      { text: '♻️ جایگزینی محتوا', callback_data: `REPLACE:${token}` }
    ]);
  } else {
    // Regular user: allow proposing new name or viewing details
    rows.push([
      { text: '✏️ تغییر نام', callback_data: `RENAME:${token}` }
    ]);
  }
  rows.push([{ text: '🏠 منو', callback_data: 'MENU' }]);
  return { inline_keyboard: rows };
}
function buildCostKeyboard(token) {
  return {
    inline_keyboard: [
      [
        { text: '1', callback_data: `COST_SET:${token}:1` },
        { text: '2', callback_data: `COST_SET:${token}:2` },
        { text: '3', callback_data: `COST_SET:${token}:3` },
        { text: '4', callback_data: `COST_SET:${token}:4` },
        { text: '5', callback_data: `COST_SET:${token}:5` }
      ],
      [
        { text: '6', callback_data: `COST_SET:${token}:6` },
        { text: '7', callback_data: `COST_SET:${token}:7` },
        { text: '8', callback_data: `COST_SET:${token}:8` },
        { text: '9', callback_data: `COST_SET:${token}:9` },
        { text: '10', callback_data: `COST_SET:${token}:10` }
      ],
      [
        { text: '🔢 مقدار دلخواه', callback_data: `COST_CUSTOM:${token}` },
        { text: '⬅️ بازگشت', callback_data: 'MYFILES:0' }
      ]
    ]
  };
}

function buildLimitKeyboard(token) {
  return {
    inline_keyboard: [
      [
        { text: '♾️ بدون محدودیت', callback_data: `LIMIT_SET:${token}:0` },
        { text: '1', callback_data: `LIMIT_SET:${token}:1` },
        { text: '3', callback_data: `LIMIT_SET:${token}:3` },
        { text: '5', callback_data: `LIMIT_SET:${token}:5` },
        { text: '10', callback_data: `LIMIT_SET:${token}:10` }
      ],
      [
        { text: '🔢 مقدار دلخواه', callback_data: `LIMIT_CUSTOM:${token}` },
        { text: '⬅️ بازگشت', callback_data: 'MYFILES:0' }
      ]
    ]
  };
}
async function buildMyFilesKeyboard(env, uid, page = 0, pageSize = 5) {
  const upKey = `uploader:${uid}`;
  const list = (await kvGetJson(env, upKey)) || [];
  const start = Math.max(0, page * pageSize);
  const slice = list.slice(start, start + pageSize);
  const files = [];
  for (const t of slice) {
    const f = await kvGetJson(env, `file:${t}`);
    if (f) files.push(f);
  }
  const isUserAdmin = isAdmin(uid);
  const rows = files.flatMap(f => ([(
    [{ text: `ℹ️ ${f.name || 'file'} — ⬇️ ${(f.downloads||0)}`, callback_data: `DETAILS:${f.token}:${page}` }]
  ), (
    [
      { text: `📥 دریافت`, callback_data: `SEND:${f.token}` },
      ...(isUserAdmin ? [{ text: `💰 هزینه (${f.cost_points||0})`, callback_data: `COST:${f.token}` }] : []),
      ...(isUserAdmin ? [{ text: f.disabled ? '🟢 فعال‌سازی' : '🔴 غیرفعال', callback_data: `TOGGLE:${f.token}` }] : []),
      ...(isUserAdmin ? [{ text: '🗑 حذف', callback_data: `DEL:${f.token}` }] : [])
    ]
  )]));
  const nav = [];
  if (start > 0) nav.push({ text: '⬅️ قبلی', callback_data: `MYFILES:${page-1}` });
  if (start + pageSize < list.length) nav.push({ text: 'بعدی ➡️', callback_data: `MYFILES:${page+1}` });
  if (nav.length) rows.push(nav);
  rows.push([{ text: '🏠 منو', callback_data: 'MENU' }]);
  const text = files.length
    ? `📂 ${files.length} فایل اخیر شما (صفحه ${page+1})`
    : 'هنوز فایلی ندارید.';
  return { text, reply_markup: { inline_keyboard: rows } };
}
async function sendMainMenu(env, chatId, uid) {
  try {
    const requireJoin = await getRequiredChannels(env);
    if (requireJoin.length && !isAdmin(uid)) {
      const joined = await isUserJoinedAllRequiredChannels(env, uid);
      if (!joined) { await presentJoinPrompt(env, chatId); return; }
    }
  } catch (_) {}
  await tgApi('sendMessage', { chat_id: chatId, text: 'لطفا یک گزینه را انتخاب کنید:', reply_markup: await buildDynamicMainMenu(env, uid) });
}

/* ==================== 9) Telegram webhook handling ==================== */
async function handleTelegramWebhook(req, env) {
  let body;
  try { body = await req.json(); } catch (e) { return new Response('invalid json', { status: 400 }); }
  await handleUpdate(body, env);
  return new Response('ok');
}

// Exported for Cloudflare Pages Functions: processes a Telegram update object
export async function handleUpdate(update, env, ctx) {
  try { populateRuntimeFromEnv(env); } catch (_) {}
  try { await kvPutJson(env, 'bot:last_webhook', now()); } catch (_) {}
  try { DYNAMIC_ADMIN_IDS = (await kvGetJson(env, 'bot:admins'))?.map(Number) || []; } catch (_) { DYNAMIC_ADMIN_IDS = []; }
  try { if (update && update.message) await onMessage(update.message, env); } catch (_) {}
  try { if (update && update.callback_query) await onCallback(update.callback_query, env); } catch (_) {}
}

/* -------------------- Message handlers -------------------- */
async function onMessage(msg, env) {
  const chatId = msg.chat.id;
  const from = msg.from || {};
  const uid = from.id;
  // Ignore non-private chats: the bot should not speak in groups; used only to check membership
  try {
    const chatType = msg.chat && msg.chat.type;
    if (chatType && chatType !== 'private') {
      return; // do nothing in groups/channels
    }
  } catch (_) {}

  // enforce block
  if (!isAdmin(uid)) {
    try {
      const blocked = await isUserBlocked(env, uid);
      if (blocked) {
        await tgApi('sendMessage', { chat_id: chatId, text: '⛔️ دسترسی شما توسط مدیر محدود شده است.' });
        return;
      }
    } catch (_) {}
  }

  // save/update user
  const userKey = `user:${uid}`;
  let user = (await kvGetJson(env, userKey)) || { 
    id: uid, username: from.username || null, first_name: from.first_name || '',
    diamonds: 0, referrals: 0, joined: false, created_at: now() 
  };
  user.username = from.username || user.username;
  user.first_name = from.first_name || user.first_name;
  user.last_seen = now();
  await kvPutJson(env, userKey, user);

  // ensure users index
  const usersIndex = (await kvGetJson(env, 'index:users')) || [];
  if (!usersIndex.includes(uid)) { usersIndex.push(uid); await kvPutJson(env, 'index:users', usersIndex); }

  // Lottery auto-enroll for new users
  if (usersIndex.length && usersIndex[usersIndex.length - 1] === uid) {
    try { await lotteryAutoEnroll(env, uid); } catch (_) {}
  }

  const text = (msg.text || '').trim();
  // /start: show menu or handle deep-link payloads
  if (text.startsWith('/start')) {
    const parts = text.split(/\s+/);
    const payload = parts[1] || '';
    // Support '/start d_<token>' deep-links to deliver content inside bot
    if (payload && payload.startsWith('d_')) {
      const token = payload.slice(2).trim();
      if (token) {
        await handleBotDownload(env, uid, chatId, token, null);
        return;
      }
    }
    // Default: show main menu (with join check inside)
    await sendMainMenu(env, chatId, uid);
    return;
  }
  // /update: simulate updating flow then show menu
  if (text === '/update') {
    await tgApi('sendMessage', { chat_id: chatId, text: 'در حال بروزرسانی به آخرین نسخه…' });
    await sleep(6500);
    await tgApi('sendMessage', { chat_id: chatId, text: 'بروزرسانی انجام شد ✅' });
    // Enforce join before showing menu
    const requireJoin0 = await getRequiredChannels(env);
    if (requireJoin0.length && !isAdmin(uid)) {
      const joinedAll0 = await isUserJoinedAllRequiredChannels(env, uid);
      if (!joinedAll0) { await presentJoinPrompt(env, chatId); return; }
    }
    await sendMainMenu(env, chatId, uid);
    return;
  }

  // Admin: lookup user by ID => /who <id>
  if (text.startsWith('/who') && isAdmin(uid)) {
    const parts = text.split(/\s+/);
    const targetId = Number(parts[1] || '');
    if (!Number.isFinite(targetId) || targetId <= 0) {
      await tgApi('sendMessage', { chat_id: chatId, text: 'استفاده: /who <uid>' });
      return;
    }
    const tKey = `user:${targetId}`;
    const u = (await kvGetJson(env, tKey)) || null;
    const upKey = `uploader:${targetId}`;
    const list = (await kvGetJson(env, upKey)) || [];
    let totalDownloads = 0;
    for (const tok of list.slice(0, 300)) {
      const f = await kvGetJson(env, `file:${tok}`);
      if (f && f.downloads) totalDownloads += f.downloads;
    }
    if (!u) {
      await tgApi('sendMessage', { chat_id: chatId, text: `کاربر ${targetId} یافت نشد.` });
      return;
    }
    const info = `👤 اطلاعات کاربر
آی‌دی: ${u.id}
یوزرنیم: ${u.username || '-'}
نام: ${u.first_name || '-'}
🪙 سکه: ${u.diamonds || 0}${u.frozen ? ' (فریز)' : ''}
زیرمجموعه‌ها: ${u.referrals || 0}
تاریخ عضویت: ${u.created_at ? formatDate(u.created_at) : '-'}
آخرین فعالیت: ${u.last_seen ? formatDate(u.last_seen) : '-'}
تعداد فایل‌های آپلودی: ${list.length}
جمع دانلود فایل‌ها: ${totalDownloads}`;
    await tgApi('sendMessage', { chat_id: chatId, text: info });
    return;
  }

  // session-driven flows
  const session = await getSession(env, uid);
  if (session.awaiting) {
    // Answering a quiz mission (legacy text-answer). One attempt only.
    if (session.awaiting?.startsWith('mis_quiz_answer:') && text) {
      const id = session.awaiting.split(':')[1];
      const m = await kvGetJson(env, `mission:${id}`);
      if (!m || !m.enabled || m.type !== 'quiz') { await setSession(env, uid, {}); await tgApi('sendMessage', { chat_id: chatId, text: 'ماموریت یافت نشد.' }); return; }
      const prog = await getUserMissionProgress(env, uid);
      const markKey = `${m.id}:${weekKey()}`;
      if ((prog.map||{})[markKey]) { await setSession(env, uid, {}); await tgApi('sendMessage', { chat_id: chatId, text: 'قبلاً پاسخ داده‌اید.' }); return; }
      const correct = String(m.config?.answer || '').trim().toLowerCase();
      const userAns = text.trim().toLowerCase();
      if (correct && userAns === correct) {
        await completeMissionIfEligible(env, uid, m);
        await setSession(env, uid, {});
        await tgApi('sendMessage', { chat_id: chatId, text: `✅ درست جواب دادید! ${m.reward} سکه دریافت کردید.` });
      } else {
        prog.map = prog.map || {}; prog.map[markKey] = now(); await setUserMissionProgress(env, uid, prog);
        await setSession(env, uid, {});
        await tgApi('sendMessage', { chat_id: chatId, text: '❌ پاسخ نادرست است. امکان پاسخ مجدد وجود ندارد.' });
      }
      return;
    }
    // Answering a weekly question/contest
    if (session.awaiting?.startsWith('mis_question_answer:') && text) {
      const id = session.awaiting.split(':')[1];
      const m = await kvGetJson(env, `mission:${id}`);
      if (!m || !m.enabled || m.type !== 'question') { await setSession(env, uid, {}); await tgApi('sendMessage', { chat_id: chatId, text: 'ماموریت یافت نشد.' }); return; }
      const prog = await getUserMissionProgress(env, uid);
      const markKey = `${m.id}:${weekKey()}`;
      if ((prog.map||{})[markKey]) { await setSession(env, uid, {}); await tgApi('sendMessage', { chat_id: chatId, text: 'قبلاً پاسخ داده‌اید.' }); return; }
      const correct = String(m.config?.answer || '').trim().toLowerCase();
      const userAns = text.trim().toLowerCase();
      if (correct && userAns === correct) {
        await completeMissionIfEligible(env, uid, m);
        await setSession(env, uid, {});
        await tgApi('sendMessage', { chat_id: chatId, text: `🏆 پاسخ صحیح! ${m.reward} سکه دریافت کردید.` });
      } else {
        prog.map = prog.map || {}; prog.map[markKey] = now(); await setUserMissionProgress(env, uid, prog);
        await setSession(env, uid, {});
        await tgApi('sendMessage', { chat_id: chatId, text: '❌ پاسخ نادرست است. امکان پاسخ مجدد وجود ندارد.' });
      }
      return;
    }
    // Set custom cost for a file
    // Balance: get receiver id
    if (session.awaiting === 'bal:to' && text) {
      const toId = Number(text.trim());
      if (!Number.isFinite(toId) || toId <= 0) { await tgApi('sendMessage', { chat_id: chatId, text: 'آی‌دی نامعتبر است.', reply_markup: { inline_keyboard: [[{ text: '❌ انصراف', callback_data: 'CANCEL' }]] } }); return; }
      if (String(toId) === String(uid)) { await tgApi('sendMessage', { chat_id: chatId, text: 'نمی‌توانید به خودتان انتقال دهید.', reply_markup: { inline_keyboard: [[{ text: '❌ انصراف', callback_data: 'CANCEL' }]] } }); return; }
      const usersIndex = (await kvGetJson(env, 'index:users')) || [];
      if (!usersIndex.includes(toId)) { await tgApi('sendMessage', { chat_id: chatId, text: 'کاربر مقصد یافت نشد.', reply_markup: { inline_keyboard: [[{ text: '❌ انصراف', callback_data: 'CANCEL' }]] } }); return; }
      await setSession(env, uid, { awaiting: `bal:amount:${toId}` });
      await tgApi('sendMessage', { chat_id: chatId, text: 'مبلغ انتقال (سکه) را وارد کنید (حداقل 2 و حداکثر 50):', reply_markup: { inline_keyboard: [[{ text: '❌ انصراف', callback_data: 'CANCEL' }]] } });
      return;
    }
    if (session.awaiting?.startsWith('setcost:') && text) {
      const token = session.awaiting.split(':')[1];
      const amt = Number(text.trim());
      await setSession(env, uid, {});
      if (!Number.isFinite(amt) || amt < 0) { await tgApi('sendMessage', { chat_id: chatId, text: 'عدد نامعتبر.' }); return; }
      const f = await kvGetJson(env, `file:${token}`);
      if (!f) { await tgApi('sendMessage', { chat_id: chatId, text: 'فایل یافت نشد.' }); return; }
      if (!isAdmin(uid)) { await tgApi('sendMessage', { chat_id: chatId, text: 'اجازه ندارید.' }); return; }
      f.cost_points = amt; await kvPutJson(env, `file:${token}`, f);
      await tgApi('sendMessage', { chat_id: chatId, text: `هزینه تنظیم شد: ${amt}` });
      return;
    }
    // Set custom download limit for a file
    if (session.awaiting?.startsWith('setlimit:') && text) {
      const token = session.awaiting.split(':')[1];
      const amt = Number(text.trim());
      await setSession(env, uid, {});
      if (!Number.isFinite(amt) || amt < 0) { await tgApi('sendMessage', { chat_id: chatId, text: 'عدد نامعتبر.' }); return; }
      const f = await kvGetJson(env, `file:${token}`);
      if (!f) { await tgApi('sendMessage', { chat_id: chatId, text: 'فایل یافت نشد.' }); return; }
      if (!isAdmin(uid)) { await tgApi('sendMessage', { chat_id: chatId, text: 'اجازه ندارید.' }); return; }
      f.max_downloads = Math.max(0, Math.floor(amt));
      await kvPutJson(env, `file:${token}`, f);
      await tgApi('sendMessage', { chat_id: chatId, text: `محدودیت دانلود تنظیم شد: ${f.max_downloads || 'نامحدود'}` });
      return;
    }
    // Balance: get amount
    if (session.awaiting?.startsWith('bal:amount:') && text) {
      const toId = Number(session.awaiting.split(':')[2]);
      const amount = Math.floor(Number(text.trim()));
      if (!Number.isFinite(amount) || amount < 2 || amount > 50) { await tgApi('sendMessage', { chat_id: chatId, text: 'مقدار نامعتبر. باید بین 2 تا 50 سکه باشد.', reply_markup: { inline_keyboard: [[{ text: '❌ انصراف', callback_data: 'CANCEL' }]] } }); return; }
      const fromUser = (await kvGetJson(env, `user:${uid}`)) || { id: uid, diamonds: 0 };
      if ((fromUser.diamonds || 0) < amount) { await tgApi('sendMessage', { chat_id: chatId, text: 'سکه کافی نیست.', reply_markup: { inline_keyboard: [[{ text: '❌ انصراف', callback_data: 'CANCEL' }]] } }); return; }
      await setSession(env, uid, {});
      const kb = { inline_keyboard: [
        [{ text: '✅ تایید و انتقال', callback_data: `BAL:CONFIRM:${toId}:${amount}` }],
        [{ text: '❌ انصراف', callback_data: 'CANCEL' }]
      ] };
      await tgApi('sendMessage', { chat_id: chatId, text: `تایید انتقال:\nگیرنده: ${toId}\nمبلغ: ${amount} سکه\n\nآیا تایید می‌کنید؟`, reply_markup: kb });
      return;
    }
    // User replies inside an existing ticket
    if (session.awaiting?.startsWith('tkt_user_reply:')) {
      const ticketId = session.awaiting.split(':')[1];
      const t = await getTicket(env, ticketId);
      if (!t || String(t.user_id) !== String(uid) || t.status === 'closed') { await setSession(env, uid, {}); await tgApi('sendMessage', { chat_id: chatId, text: 'ارسال نامعتبر.' }); return; }
      if (!text) { await tgApi('sendMessage', { chat_id: chatId, text: 'لطفاً پاسخ را به صورت متن ارسال کنید.' }); return; }
      await setSession(env, uid, {});
      await appendTicketMessage(env, ticketId, { from: 'user', by: uid, at: now(), text });
      // notify all admins
      try {
        const admins = await getAdminIds(env);
        for (const aid of admins) {
          try { await tgApi('sendMessage', { chat_id: aid, text: `پیام جدید در تیکت #${ticketId} از ${uid}:\n${text}` }); } catch (_) {}
        }
      } catch (_) {}
      await tgApi('sendMessage', { chat_id: chatId, text: '✅ پیام شما به تیکت افزوده شد.' });
      return;
    }
    // Admin ticket reply flow
    if (session.awaiting?.startsWith('admin_ticket_reply:')) {
      if (!isAdmin(uid)) { await setSession(env, uid, {}); await tgApi('sendMessage', { chat_id: chatId, text: 'فقط ادمین‌ها مجاز هستند.' }); return; }
      const ticketId = session.awaiting.split(':')[1];
      const t = await getTicket(env, ticketId);
      if (!t) { await setSession(env, uid, {}); await tgApi('sendMessage', { chat_id: chatId, text: 'تیکت یافت نشد.' }); return; }
      if (!text) { await tgApi('sendMessage', { chat_id: chatId, text: 'لطفاً پاسخ را به صورت متن ارسال کنید.' }); return; }
      // try sending the message to user first
      let delivered = false;
      try {
        await tgApi('sendMessage', { chat_id: t.user_id, text: `✉️ پاسخ پشتیبانی به تیکت #${t.id}:\n${text}` });
        delivered = true;
      } catch (_) { delivered = false; }
      if (!delivered) { await tgApi('sendMessage', { chat_id: chatId, text: '❌ ارسال پیام به کاربر انجام نشد (ممکن است کاربر پیام‌های ربات را مسدود کرده باشد).' }); return; }
      await setSession(env, uid, {});
      // append message to ticket only after successful delivery
      await appendTicketMessage(env, ticketId, { from: 'admin', by: uid, at: now(), text });
      await tgApi('sendMessage', { chat_id: chatId, text: '✅ پاسخ ارسال شد.' });
      return;
    }
    // User ticket creation steps (simplified: Category -> Description -> Submit)
    if (session.awaiting === 'ticket:new:category' && text) {
      const category = text.trim().slice(0, 50);
      const base = { category };
      await setSession(env, uid, { awaiting: `ticket:new:desc:${btoa(encodeURIComponent(JSON.stringify(base)))}` });
      await tgApi('sendMessage', { chat_id: chatId, text: 'شرح کامل تیکت را ارسال کنید:', reply_markup: { inline_keyboard: [[{ text: '❌ انصراف', callback_data: 'CANCEL' }]] } });
      return;
    }
    // Back-compat: if old subject step appears, treat input as description
    if (session.awaiting?.startsWith('ticket:new:subject:') && text) {
      const base64 = session.awaiting.split(':')[3];
      const base = JSON.parse(decodeURIComponent(atob(base64)));
      const desc = text.trim().slice(0, 2000);
      // Show confirmation
      const preview = `بررسی و تایید:\nدسته: ${base.category}\nشرح:\n${desc.slice(0, 200)}${desc.length>200?'...':''}`;
      const payload = btoa(encodeURIComponent(JSON.stringify({ category: base.category, desc })));
      await setSession(env, uid, {});
      await tgApi('sendMessage', { chat_id: chatId, text: preview, reply_markup: { inline_keyboard: [[{ text: '✅ ثبت', callback_data: `TKT:SUBMIT:${payload}` }],[{ text: '❌ انصراف', callback_data: 'CANCEL' }]] } });
      return;
    }
    if (session.awaiting?.startsWith('ticket:new:desc:') && text) {
      const base64 = session.awaiting.split(':')[3];
      const base = JSON.parse(decodeURIComponent(atob(base64)));
      const desc = text.trim().slice(0, 2000);
      // Show confirmation before submit
      const preview = `بررسی و تایید:\nدسته: ${base.category}\nشرح:\n${desc.slice(0, 200)}${desc.length>200?'...':''}`;
      const payload = btoa(encodeURIComponent(JSON.stringify({ category: base.category, desc })));
      await setSession(env, uid, {});
      await tgApi('sendMessage', { chat_id: chatId, text: preview, reply_markup: { inline_keyboard: [[{ text: '✅ ثبت', callback_data: `TKT:SUBMIT:${payload}` }],[{ text: '❌ انصراف', callback_data: 'CANCEL' }]] } });
      return;
    }
    // Admin generic upload flow (supports text/media/doc)
    if (session.awaiting === 'upload_wait') {
      if (!isAdmin(uid)) {
        await setSession(env, uid, {});
        await tgApi('sendMessage', { chat_id: chatId, text: 'فقط ادمین‌ها مجاز هستند.' });
        return;
      }
      const created = await handleAnyUpload(msg, env, { ownerId: uid });
      if (!created) {
        await tgApi('sendMessage', { chat_id: chatId, text: 'نوع محتوا پشتیبانی نمی‌شود. متن، سند، عکس، ویدیو، صدا یا ویس ارسال کنید.' });
        return;
      }
      await setSession(env, uid, {});
      const manageKb = buildFileManageKeyboard(created.token, created, true);
      const caption = created.type === 'text'
        ? `✅ متن ذخیره شد\nتوکن: ${created.token}`
        : `✅ آیتم ذخیره شد\nنام: ${created.name || created.type}\nتوکن: ${created.token}`;
      await tgApi('sendMessage', { chat_id: chatId, text: caption, reply_markup: manageKb });
      // Prompt cost 1-10 right after upload
      await tgApi('sendMessage', { chat_id: chatId, text: '💰 هزینه فایل را انتخاب کنید (۱ تا ۱۰):', reply_markup: buildCostKeyboard(created.token) });
      return;
    }
    // Admin upload categorized: text only
    if (session.awaiting === 'upload_wait_text' && text) {
      if (!isAdmin(uid)) { await setSession(env, uid, {}); await tgApi('sendMessage', { chat_id: chatId, text: 'فقط ادمین‌ها مجاز هستند.' }); return; }
      const created = await handleAnyUpload({ text }, env, { ownerId: uid });
      await setSession(env, uid, {});
      if (!created) { await tgApi('sendMessage', { chat_id: chatId, text: 'ثبت متن ناموفق بود.' }); return; }
      const manageKb = buildFileManageKeyboard(created.token, created, true);
      await tgApi('sendMessage', { chat_id: chatId, text: `✅ متن ذخیره شد\nتوکن: ${created.token}`, reply_markup: manageKb });
      await tgApi('sendMessage', { chat_id: chatId, text: '💰 هزینه فایل را انتخاب کنید (۱ تا ۱۰):', reply_markup: buildCostKeyboard(created.token) });
      return;
    }
    // Admin upload categorized: link
    if (session.awaiting === 'upload_wait_link' && text) {
      if (!isAdmin(uid)) { await setSession(env, uid, {}); await tgApi('sendMessage', { chat_id: chatId, text: 'فقط ادمین‌ها مجاز هستند.' }); return; }
      const link = String(text).trim();
      const isValid = /^https?:\/\//i.test(link);
      if (!isValid) { await tgApi('sendMessage', { chat_id: chatId, text: 'لینک نامعتبر است. باید با http یا https شروع شود.' }); return; }
      // store as text-type with name 'لینک'
      const created = await handleAnyUpload({ text: link }, env, { ownerId: uid });
      if (created) { created.name = 'لینک'; await kvPutJson(env, `file:${created.token}`, created); }
      await setSession(env, uid, {});
      if (!created) { await tgApi('sendMessage', { chat_id: chatId, text: 'ثبت لینک ناموفق بود.' }); return; }
      const manageKb = buildFileManageKeyboard(created.token, created, true);
      await tgApi('sendMessage', { chat_id: chatId, text: `✅ لینک ذخیره شد\nتوکن: ${created.token}`, reply_markup: manageKb });
      await tgApi('sendMessage', { chat_id: chatId, text: '💰 هزینه فایل را انتخاب کنید (۱ تا ۱۰):', reply_markup: buildCostKeyboard(created.token) });
      return;
    }
    // Admin upload categorized: document-only path
    if (session.awaiting === 'upload_wait_file') {
      if (!isAdmin(uid)) { await setSession(env, uid, {}); await tgApi('sendMessage', { chat_id: chatId, text: 'فقط ادمین‌ها مجاز هستند.' }); return; }
      if (!msg.document) { await tgApi('sendMessage', { chat_id: chatId, text: 'لطفاً فایل (document) ارسال کنید.' }); return; }
      const created = await handleAnyUpload(msg, env, { ownerId: uid });
      await setSession(env, uid, {});
      if (!created) { await tgApi('sendMessage', { chat_id: chatId, text: 'آپلود ناموفق بود.' }); return; }
      const manageKb = buildFileManageKeyboard(created.token, created, true);
      const caption = `✅ فایل ذخیره شد\nنام: ${created.name || created.type}\nتوکن: ${created.token}`;
      await tgApi('sendMessage', { chat_id: chatId, text: caption, reply_markup: manageKb });
      await tgApi('sendMessage', { chat_id: chatId, text: '💰 هزینه فایل را انتخاب کنید (۱ تا ۱۰):', reply_markup: buildCostKeyboard(created.token) });
      return;
    }
    // Bulk upload: append tokens on each successful upload
    if (session.awaiting === 'bulk_upload' || session.awaiting === 'bulk_meta') {
      await setSession(env, uid, {});
      await tgApi('sendMessage', { chat_id: chatId, text: 'اپلود گروهی غیرفعال شده است.' });
      return;
    }

    // Admin replace existing content
    if (session.awaiting?.startsWith('replace:')) {
      const token = session.awaiting.split(':')[1];
      if (!isAdmin(uid)) { await setSession(env, uid, {}); await tgApi('sendMessage', { chat_id: chatId, text: 'فقط ادمین‌ها مجاز هستند.' }); return; }
      const existed = await kvGetJson(env, `file:${token}`);
      if (!existed) { await setSession(env, uid, {}); await tgApi('sendMessage', { chat_id: chatId, text: 'آیتم یافت نشد.' }); return; }
      const updated = await handleAnyUpload(msg, env, { ownerId: existed.owner, replaceToken: token, original: existed });
      if (!updated) { await tgApi('sendMessage', { chat_id: chatId, text: 'نوع محتوا پشتیبانی نمی‌شود. متن، سند، عکس، ویدیو، صدا یا ویس ارسال کنید.' }); return; }
      await setSession(env, uid, {});
      await tgApi('sendMessage', { chat_id: chatId, text: `✅ محتوا جایگزین شد برای توکن ${token}` });
      return;
    }
    if (session.awaiting === 'support_wait') {
      await setSession(env, uid, {});
      await tgApi('sendMessage', { chat_id: chatId, text: 'لطفاً از پشتیبانی استفاده کنید: https://t.me/NeoDebug' });
      return;
    }

    // Payment receipt upload
    if (session.awaiting?.startsWith('payment_receipt:')) {
      const purchaseId = session.awaiting.split(':')[1];
      const pKey = `purchase:${purchaseId}`;
      const purchase = await kvGetJson(env, pKey);
      if (!purchase || purchase.user_id !== uid || purchase.status !== 'awaiting_receipt') {
        await setSession(env, uid, {});
        await tgApi('sendMessage', { chat_id: chatId, text: '⛔️ درخواست خرید نامعتبر یا منقضی است.' });
        return;
      }
      let fileId = null; let isPhoto = false;
      if (msg.photo && msg.photo.length) { fileId = msg.photo[msg.photo.length - 1].file_id; isPhoto = true; }
      else if (msg.document) { fileId = msg.document.file_id; }
      else if (msg.text) {
        await tgApi('sendMessage', { chat_id: chatId, text: 'برای ادامه، تصویر رسید پرداخت را به صورت عکس یا فایل ارسال کنید.' });
        return;
      }
      if (!fileId) {
        await tgApi('sendMessage', { chat_id: chatId, text: 'لطفاً تصویر رسید پرداخت را ارسال کنید.' });
        return;
      }
      purchase.receipt_file_id = fileId;
      purchase.status = 'pending_review';
      purchase.updated_at = now();
      await kvPutJson(env, pKey, purchase);
      await setSession(env, uid, {});

      // Build admin review message and actions depending on purchase type
      const isPanelPurchase = purchase.type === 'panel';
      const caption = isPanelPurchase
        ? `درخواست خرید پنل\nشناسه: ${purchase.id}\nکاربر: ${uid}${from.username ? ` (@${from.username})` : ''}\nپنل: ${purchase.panel_title || '-'}\nمبلغ: ${purchase.price_toman.toLocaleString('fa-IR')} تومان`
        : `درخواست خرید سکه\nشناسه: ${purchase.id}\nکاربر: ${uid}${from.username ? ` (@${from.username})` : ''}\nسکه: ${purchase.diamonds}\nمبلغ: ${purchase.price_toman.toLocaleString('fa-IR')} تومان`;
      const kb = isPanelPurchase
        ? { inline_keyboard: [[
            { text: '✉️ رفتن به پیوی کاربر', url: `tg://user?id=${uid}` },
            { text: '❌ رد', callback_data: `PAYREJ:${purchase.id}` }
          ]] }
        : { inline_keyboard: [[
            { text: '✅ تایید و افزودن سکه', callback_data: `PAYAPP:${purchase.id}` },
            { text: '❌ رد', callback_data: `PAYREJ:${purchase.id}` }
          ]] };
      try {
        const admins = await getAdminIds(env);
        let recipients = [];
        if (Array.isArray(admins) && admins.length) {
          recipients = admins;
        } else if (MAIN_ADMIN_ID) {
          recipients = [Number(MAIN_ADMIN_ID)];
        } else if (RUNTIME.adminIds && RUNTIME.adminIds.length) {
          recipients = RUNTIME.adminIds.map(Number);
        }
        if (!recipients.length) {
          await tgApi('sendMessage', { chat_id: chatId, text: '⛔️ مدیر پیکربندی نشده است. رسید ذخیره شد و پس از تنظیم مدیر بررسی می‌شود.' });
        } else {
          for (const aid of recipients) {
            try {
              if (isPhoto) {
                await tgApi('sendPhoto', { chat_id: aid, photo: fileId, caption, reply_markup: kb });
              } else {
                await tgApi('sendDocument', { chat_id: aid, document: fileId, caption, reply_markup: kb });
              }
            } catch (_) {}
          }
        }
      } catch (_) {}
      await tgApi('sendMessage', { chat_id: chatId, text: `✅ رسید دریافت شد.\nشناسه خرید: ${purchase.id}\nنتیجه بررسی به شما اعلام می‌شود.` });
      return;
    }
    if (session.awaiting === 'broadcast' && isAdmin(uid) && text) {
      await tgApi('sendMessage', { chat_id: chatId, text: 'در حال ارسال پیام به همه کاربران...' });
      const res = await broadcast(env, text);
      await setSession(env, uid, {});
      await tgApi('sendMessage', { chat_id: chatId, text: `پیام به همه کاربران ارسال شد و فرآیند به پایان رسید ✅\nموفق: ${res.successful}\nناموفق: ${res.failed}` });
      return;
    }
    if (session.awaiting === 'join_add' && isAdmin(uid) && text) {
      const channels = await getRequiredChannels(env);
      const ch = normalizeChannelIdentifier(text);
      if (!channels.includes(ch)) channels.push(ch);
      await setRequiredChannels(env, channels);
      await setSession(env, uid, {});
      await tgApi('sendMessage', { chat_id: chatId, text: `کانال ${ch} اضافه شد.` });
      return;
    }
    if (session.awaiting === 'add_admin' && isAdmin(uid) && text) {
      const id = Number(text.trim());
      if (!Number.isFinite(id)) { await tgApi('sendMessage', { chat_id: chatId, text: 'آی‌دی نامعتبر است.' }); return; }
      const admins = await getAdminIds(env);
      if (!admins.includes(id)) admins.push(id);
      await setAdminIds(env, admins);
      DYNAMIC_ADMIN_IDS = admins.slice();
      await setSession(env, uid, {});
      await tgApi('sendMessage', { chat_id: chatId, text: `ادمین ${id} اضافه شد.` });
      return;
    }
    
    if (session.awaiting === 'get_by_token' && text) {
      const token = text.trim();
      await setSession(env, uid, {});
      if (!isValidTokenFormat(token)) {
        await tgApi('sendMessage', { chat_id: chatId, text: 'توکن نامعتبر است.' });
        await tgApi('sendMessage', { chat_id: chatId, text: 'منوی اصلی:', reply_markup: await buildDynamicMainMenu(env, uid) });
        return;
      }
      const ok = await checkRateLimit(env, uid, 'get_by_token', 5, 60_000);
      if (!ok) { await tgApi('sendMessage', { chat_id: chatId, text: 'تعداد درخواست بیش از حد. لطفاً بعداً تلاش کنید.' }); return; }
      await handleBotDownload(env, uid, chatId, token, '');
      return;
    }
    if (session.awaiting === 'redeem_gift' && text) {
      await setSession(env, uid, {});
      const code = text.trim();
      const res = await redeemGiftCode(env, uid, code);
      await tgApi('sendMessage', { chat_id: chatId, text: res.message });
      // After redeem attempt (valid or invalid), return to main menu
      await tgApi('sendMessage', { chat_id: chatId, text: 'منوی اصلی:', reply_markup: await buildDynamicMainMenu(env, uid) });
      return;
    }
    if (session.awaiting === 'admin_user_details' && isAdmin(uid) && text) {
      await setSession(env, uid, {});
      const targetId = Number(String(text).trim());
      if (!Number.isFinite(targetId) || targetId <= 0) {
        await tgApi('sendMessage', { chat_id: chatId, text: 'آی‌دی نامعتبر است.', reply_markup: await buildDynamicMainMenu(env, uid) });
        return;
      }
      // Profile
      const u = (await kvGetJson(env, `user:${targetId}`)) || null;
      // Uploads summary
      const upList = (await kvGetJson(env, `uploader:${targetId}`)) || [];
      let totalDownloads = 0;
      const recentFiles = [];
      for (const tok of upList.slice(0, 50)) {
        const f = await kvGetJson(env, `file:${tok}`);
        if (f) { totalDownloads += f.downloads || 0; recentFiles.push(f); }
      }
      // Purchases (approved)
      const purchasesIdx = (await kvGetJson(env, 'index:purchases')) || [];
      const purchases = [];
      for (const id of purchasesIdx.slice(0, 500)) {
        const p = await kvGetJson(env, `purchase:${id}`);
        if (p && p.user_id === targetId && p.status === 'approved') purchases.push(p);
      }
      const coinsFromPurchases = purchases.reduce((s,p)=>s + Number(p.diamonds||0), 0);
      const purchasesLines = purchases.slice(0, 10).map(p => `#${String(p.id).padStart(8,'0')} — ${p.diamonds} سکه — ${(p.price_toman||0).toLocaleString('fa-IR')}ت — ${formatDate(p.processed_at||p.updated_at||p.created_at||0)}`).join('\n') || '—';
      // Gift redemptions (scan small index)
      const giftIdx = (await kvGetJson(env, 'gift:index')) || [];
      const giftsUsed = [];
      for (const code of giftIdx.slice(0, 200)) {
        const used = await kvGetJson(env, `giftused:${code}:${targetId}`);
        if (used) {
          const g = await kvGetJson(env, `gift:${code}`);
          giftsUsed.push({ code, amount: g?.amount||0, at: used.used_at||0 });
        }
      }
      const coinsFromGifts = giftsUsed.reduce((s,g)=>s + Number(g.amount||0), 0);
      const giftsLines = giftsUsed.slice(0, 10).map(g => `${g.code} — ${g.amount} سکه — ${g.at ? formatDate(g.at) : '-'}`).join('\n') || '—';
      const coinsNow = u ? (u.diamonds||0) : 0;
      const header = u
        ? `👤 کاربر: ${targetId}${u.username ? ` (@${u.username})` : ''}\n🪙 سکه فعلی: ${coinsNow}\n📈 معرفی‌ها: ${u.referrals||0}\n📅 عضویت: ${u.created_at ? formatDate(u.created_at) : '-'}\n🕒 آخرین فعالیت: ${u.last_seen ? formatDate(u.last_seen) : '-'}`
        : `کاربر ${targetId} یافت نشد.`;
      const uploadsSummary = `📂 فایل‌های آپلودشده: ${upList.length}\n📥 مجموع دانلودها: ${totalDownloads}`;
      const coinsSummary = `➕ دریافتی‌ها:\n- از خرید: ${coinsFromPurchases} سکه\n- از گیفت‌کد: ${coinsFromGifts} سکه`;
      const txt = `${header}\n\n${uploadsSummary}\n\n${coinsSummary}\n\n🧾 خریدهای تاییدشده (۱۰ تای اخیر):\n${purchasesLines}\n\n🎁 گیفت‌کدهای استفاده‌شده (۱۰ تای اخیر):\n${giftsLines}`;
      await tgApi('sendMessage', { chat_id: chatId, text: txt });
      return;
  }
  
  if (data.startsWith('COST:')) {
    const token = data.split(':')[1];
    if (!isAdmin(uid)) { await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'فقط ادمین' }); return; }
    if (!isValidTokenFormat(token)) { await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'توکن نامعتبر' }); return; }
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    await tgApi('sendMessage', { chat_id: chatId, text: 'هزینه دلخواه را انتخاب کنید:', reply_markup: buildCostKeyboard(token) });
    return;
  }
  if (data.startsWith('COST_SET:')) {
    const [, token, amountStr] = data.split(':');
    if (!isValidTokenFormat(token)) { await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'توکن نامعتبر' }); return; }
    const amount = parseInt(amountStr, 10) || 0;
    const file = await kvGetJson(env, `file:${token}`);
    if (file && isAdmin(uid)) {
      file.cost_points = amount; await kvPutJson(env, `file:${token}`, file);
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: `هزینه ${amount}` });
      const built = await buildMyFilesKeyboard(env, uid, 0);
      await tgApi('sendMessage', { chat_id: chatId, text: built.text, reply_markup: built.reply_markup });
    } else {
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'اجازه ندارید' });
    }
    return;
  }
  if (data.startsWith('COST_CUSTOM:')) {
    const token = data.split(':')[1];
    if (!isAdmin(uid)) { await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'فقط ادمین' }); return; }
    if (!isValidTokenFormat(token)) { await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'توکن نامعتبر' }); return; }
    await setSession(env, uid, { awaiting: `setcost:${token}` });
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    await tgApi('sendMessage', { chat_id: chatId, text: 'عدد هزینه دلخواه را ارسال کنید:' });
    return;
  }
  if (data.startsWith('LIMIT:')) {
    const token = data.split(':')[1];
    if (!isAdmin(uid)) { await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'فقط ادمین' }); return; }
    if (!isValidTokenFormat(token)) { await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'توکن نامعتبر' }); return; }
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    await tgApi('sendMessage', { chat_id: chatId, text: 'محدودیت دانلود را انتخاب کنید:', reply_markup: buildLimitKeyboard(token) });
    return;
  }
  if (data.startsWith('LIMIT_SET:')) {
    const [, token, amountStr] = data.split(':');
    if (!isValidTokenFormat(token)) { await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'توکن نامعتبر' }); return; }
    const amount = parseInt(amountStr, 10) || 0;
    const file = await kvGetJson(env, `file:${token}`);
    if (file && isAdmin(uid)) {
      file.max_downloads = Math.max(0, amount);
      await kvPutJson(env, `file:${token}`, file);
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: `حد: ${amount || '∞'}` });
      const built = await buildMyFilesKeyboard(env, uid, 0);
      await tgApi('sendMessage', { chat_id: chatId, text: built.text, reply_markup: built.reply_markup });
    } else {
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'اجازه ندارید' });
    }
    return;
  }
  if (data.startsWith('LIMIT_CUSTOM:')) {
    const token = data.split(':')[1];
    if (!isAdmin(uid)) { await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'فقط ادمین' }); return; }
    if (!isValidTokenFormat(token)) { await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'توکن نامعتبر' }); return; }
    await setSession(env, uid, { awaiting: `setlimit:${token}` });
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    await tgApi('sendMessage', { chat_id: chatId, text: 'عدد محدودیت دانلود را ارسال کنید (0 = نامحدود):' });
    return;
  }
  if (data.startsWith('DELAFTER:')) {
    const token = data.split(':')[1];
    if (!isValidTokenFormat(token)) { await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'توکن نامعتبر' }); return; }
    const file = await kvGetJson(env, `file:${token}`);
    if (!file) { await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'یافت نشد' }); return; }
    if (!isAdmin(uid)) { await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'فقط ادمین' }); return; }
    file.delete_on_limit = !file.delete_on_limit;
    await kvPutJson(env, `file:${token}`, file);
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: file.delete_on_limit ? 'حذف پس از اتمام: روشن' : 'خاموش' });
    const built = await buildMyFilesKeyboard(env, uid, 0);
    await tgApi('sendMessage', { chat_id: chatId, text: built.text, reply_markup: built.reply_markup });
    return;
  }
  if (data.startsWith('TOGGLE:')) {
    const token = data.split(':')[1];
    if (!isValidTokenFormat(token)) { await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'توکن نامعتبر' }); return; }
    const file = await kvGetJson(env, `file:${token}`);
    if (!file) { await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'یافت نشد' }); return; }
    if (!isAdmin(uid)) { await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'فقط ادمین' }); return; }
    file.disabled = !file.disabled; await kvPutJson(env, `file:${token}`, file);
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: file.disabled ? 'غیرفعال شد' : 'فعال شد' });
    const built = await buildMyFilesKeyboard(env, uid, 0);
    await tgApi('sendMessage', { chat_id: chatId, text: built.text, reply_markup: built.reply_markup });
    return;
  }
  if (data.startsWith('DEL:')) {
    const token = data.split(':')[1];
    if (!isValidTokenFormat(token)) { await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'توکن نامعتبر' }); return; }
    if (!isAdmin(uid)) { await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'فقط ادمین' }); return; }
    const file = await kvGetJson(env, `file:${token}`);
    if (!file) { await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'یافت نشد' }); return; }
    // remove from uploader index
    const upKey = `uploader:${file.owner}`;
    const upList = (await kvGetJson(env, upKey)) || [];
    const newList = upList.filter(t => t !== token);
    await kvPutJson(env, upKey, newList);
    // delete file meta
    await kvDelete(env, `file:${token}`);
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'حذف شد' });
    const built = await buildMyFilesKeyboard(env, uid, 0);
    await tgApi('sendMessage', { chat_id: chatId, text: built.text, reply_markup: built.reply_markup });
    return;
  }
  if (data.startsWith('REPLACE:')) {
    const token = data.split(':')[1];
    if (!isValidTokenFormat(token)) { await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'توکن نامعتبر' }); return; }
    if (!isAdmin(uid)) { await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'فقط ادمین' }); return; }
    const f = await kvGetJson(env, `file:${token}`);
    if (!f) { await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'یافت نشد' }); return; }
    await setSession(env, uid, { awaiting: `replace:${token}` });
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    await tgApi('sendMessage', { chat_id: chatId, text: `لطفاً محتوای جدید برای جایگزینی توکن ${token} را ارسال کنید (متن/رسانه).` });
    return;
  }

  if (data === 'ADMIN:GIVEPOINTS' && isAdmin(uid)) {
    await setSession(env, uid, { awaiting: 'givepoints_uid' });
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    await tgApi('sendMessage', { chat_id: chatId, text: 'آی‌دی عددی کاربر را وارد کنید:', reply_markup: { inline_keyboard: [[{ text: '❌ انصراف', callback_data: 'CANCEL' }]] } });
    return;
  }

  if (data === 'ADMIN:TAKEPOINTS' && isAdmin(uid)) {
    await setSession(env, uid, { awaiting: 'takepoints_uid' });
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    await tgApi('sendMessage', { chat_id: chatId, text: 'آی‌دی عددی کاربر برای کسر الماس را وارد کنید:', reply_markup: { inline_keyboard: [[{ text: '❌ انصراف', callback_data: 'CANCEL' }]] } });
    return;
  }
  if (data === 'ADMIN:FREEZE' && isAdmin(uid)) {
    await setSession(env, uid, { awaiting: 'freeze_uid' });
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    await tgApi('sendMessage', { chat_id: chatId, text: 'آی‌دی عددی کاربر برای فریز موجودی را وارد کنید:', reply_markup: { inline_keyboard: [[{ text: '❌ انصراف', callback_data: 'CANCEL' }]] } });
    return;
  }
  if (data === 'ADMIN:UNFREEZE' && isAdmin(uid)) {
    await setSession(env, uid, { awaiting: 'unfreeze_uid' });
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    await tgApi('sendMessage', { chat_id: chatId, text: 'آی‌دی عددی کاربر برای آن‌فریز موجودی را وارد کنید:', reply_markup: { inline_keyboard: [[{ text: '❌ انصراف', callback_data: 'CANCEL' }]] } });
    return;
  }

  if (data === 'ADMIN:TOGGLE_UPDATE' && isAdmin(uid)) {
    const current = (await kvGetJson(env, 'bot:update_mode')) || false;
    await kvPutJson(env, 'bot:update_mode', !current);
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: !current ? 'حالت آپدیت فعال شد' : 'حالت آپدیت غیرفعال شد' });
    await tgApi('sendMessage', { chat_id: chatId, text: `حالت آپدیت: ${!current ? 'فعال' : 'غیرفعال'}` });
    return;
  }
  // Removed ADMIN:TOGGLE_SERVICE per request
  if (data === 'ADMIN:BROADCAST' && isAdmin(uid)) {
    await setSession(env, uid, { awaiting: 'broadcast' });
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    await tgApi('sendMessage', { chat_id: chatId, text: 'متن پیام عمومی را ارسال کنید:' });
    return;
  }
  if (data.startsWith('PAYAPP:') && isAdmin(uid)) {
    const id = data.split(':')[1];
    const key = `purchase:${id}`;
    const purchase = await kvGetJson(env, key);
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    if (!purchase || purchase.status !== 'pending_review') {
      await tgApi('sendMessage', { chat_id: chatId, text: '⛔️ درخواست نامعتبر است.' });
      return;
    }
    if (purchase.type === 'panel') {
      await tgApi('sendMessage', { chat_id: chatId, text: 'این درخواست مربوط به پنل است. برای ادامه، از دکمه رفتن به پیوی استفاده کنید.' });
      return;
    }
    const userKey = `user:${purchase.user_id}`;
    const user = (await kvGetJson(env, userKey)) || { id: purchase.user_id, diamonds: 0 };
    user.diamonds = (user.diamonds || 0) + (purchase.diamonds || 0);
    await kvPutJson(env, userKey, user);
    purchase.status = 'approved'; purchase.processed_by = uid; purchase.processed_at = now();
    await kvPutJson(env, key, purchase);
    await tgApi('sendMessage', { chat_id: purchase.user_id, text: `✅ پرداخت شما تایید شد. ${purchase.diamonds} الماس به حساب شما اضافه شد.` });
    await tgApi('sendMessage', { chat_id: chatId, text: `انجام شد. ${purchase.diamonds} الماس به کاربر ${purchase.user_id} اضافه شد.` });
    return;
  }
  if (data.startsWith('PAYREJ:') && isAdmin(uid)) {
    const id = data.split(':')[1];
    const key = `purchase:${id}`;
    const purchase = await kvGetJson(env, key);
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    if (!purchase || purchase.status !== 'pending_review') {
      await tgApi('sendMessage', { chat_id: chatId, text: '⛔️ درخواست نامعتبر است.' });
      return;
    }
    purchase.status = 'rejected'; purchase.processed_by = uid; purchase.processed_at = now();
    await kvPutJson(env, key, purchase);
    const msg = purchase.type === 'panel'
      ? '❌ پرداخت شما تایید نشد. برای پیگیری با پشتیبانی در ارتباط باشید.'
      : '❌ پرداخت شما تایید نشد. لطفاً با پشتیبانی تماس بگیرید.';
    await tgApi('sendMessage', { chat_id: purchase.user_id, text: msg });
    await tgApi('sendMessage', { chat_id: chatId, text: `درخواست ${id} رد شد.` });
    return;
  }
  if (data.startsWith('OPENPM:') && isAdmin(uid)) {
    const target = Number(data.split(':')[1]);
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    const botUsername = await getBotUsername(env);
    const link = botUsername ? `https://t.me/${botUsername}?start=${target}` : '';
    await tgApi('sendMessage', { chat_id: chatId, text: link ? `برای رفتن به پیوی کاربر:
${link}

پس از انجام، وضعیت خرید را در سیستم خود به‌روزرسانی کنید.` : `یوزرنیم ربات تنظیم نشده است. به کاربر ${target} پیام دهید.` });
    return;
  }
  if (data === 'ADMIN:STATS' && isAdmin(uid)) {
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    const users = (await kvGetJson(env, 'index:users')) || [];
    const userCount = users.length;
    const enabled = (await kvGetJson(env, 'bot:enabled')) ?? true;
    const updateMode = (await kvGetJson(env, 'bot:update_mode')) || false;
    const lastWebhookAt = (await kvGetJson(env, 'bot:last_webhook')) || 0;
    const connected = typeof lastWebhookAt === 'number' && (now() - lastWebhookAt) < 5 * 60 * 1000;
    const admins = await getAdminIds(env);
    const joinReq = await getRequiredChannels(env);

    const LIMIT_USERS = 300;
    let totalFiles = 0;
    let totalDownloads = 0;
    let disabledFiles = 0;
    let filesCreated7d = 0;
    let usersCreated7d = 0;
    const sevenDaysAgo = now() - 7 * 24 * 60 * 60 * 1000;
    const topFiles = [];
    const uploaderStats = new Map();

    for (const uidIter of users.slice(0, LIMIT_USERS)) {
      const uMeta = (await kvGetJson(env, `user:${uidIter}`)) || {};
      if ((uMeta.created_at || 0) >= sevenDaysAgo) usersCreated7d++;
      const list = (await kvGetJson(env, `uploader:${uidIter}`)) || [];
      totalFiles += list.length;
      for (const t of list) {
        const f = await kvGetJson(env, `file:${t}`);
        if (!f) continue;
        totalDownloads += f.downloads || 0;
        if (f.disabled) disabledFiles++;
        if ((f.created_at || 0) >= sevenDaysAgo) filesCreated7d++;
        topFiles.push({ name: f.name || 'file', downloads: f.downloads || 0, token: f.token || t });
        const owner = f.owner;
        const s = uploaderStats.get(owner) || { files: 0, downloads: 0 };
        s.files += 1;
        s.downloads += f.downloads || 0;
        uploaderStats.set(owner, s);
      }
    }

    const topFilesText = topFiles
      .sort((a, b) => (b.downloads || 0) - (a.downloads || 0))
      .slice(0, 5)
      .map((f, i) => `${i + 1}. ${escapeHtml(f.name)} — ${f.downloads || 0} دانلود`)
      .join('\n') || '—';

    const topUploadersText = Array.from(uploaderStats.entries())
      .map(([owner, s]) => ({ owner, ...s }))
      .sort((a, b) => (b.downloads || 0) - (a.downloads || 0))
      .slice(0, 5)
      .map((u, i) => `${i + 1}. ${u.owner} — ${u.downloads} دانلود (${u.files} فایل)`) 
      .join('\n') || '—';

    const avgDownloads = totalFiles ? Math.round(totalDownloads / totalFiles) : 0;
    const statsText = `📊 آمار پیشرفته ربات\n\n` +
      `🔧 وضعیت سرویس: ${enabled ? '🟢 فعال' : '🔴 غیرفعال'}\n` +
      `🛠 حالت آپدیت: ${updateMode ? 'فعال' : 'غیرفعال'}\n` +
      `🔌 اتصال وبهوک: ${connected ? 'آنلاین' : 'آفلاین'}${lastWebhookAt ? ' (' + formatDate(lastWebhookAt) + ')' : ''}\n` +
      `👑 ادمین‌ها: ${admins.length}\n` +
      `📣 کانال‌های اجباری: ${joinReq.length}${joinReq.length ? ' — ' + joinReq.join(', ') : ''}\n\n` +
      `👥 کاربران کل: ${userCount.toLocaleString('fa-IR')}\n` +
      `🆕 کاربران ۷ روز اخیر: ${usersCreated7d.toLocaleString('fa-IR')} (نمونه‌گیری از ${Math.min(LIMIT_USERS, userCount)} کاربر نخست)\n\n` +
      `📁 فایل‌ها: ${totalFiles.toLocaleString('fa-IR')} (غیرفعال: ${disabledFiles.toLocaleString('fa-IR')})\n` +
      `📥 کل دانلودها: ${totalDownloads.toLocaleString('fa-IR')}\n` +
      `📈 میانگین دانلود به ازای هر فایل: ${avgDownloads.toLocaleString('fa-IR')}\n` +
      `🆕 فایل‌های ۷ روز اخیر: ${filesCreated7d.toLocaleString('fa-IR')}\n\n` +
      `🏆 برترین فایل‌ها (براساس دانلود):\n${topFilesText}\n\n` +
      `👤 برترین آپلودرها: \n${topUploadersText}`;

    await tgApi('sendMessage', { 
      chat_id: chatId, 
      text: statsText, 
      reply_markup: { inline_keyboard: [
        [{ text: '📊 جزئیات بیشتر', callback_data: 'ADMIN:STATS:DETAILS' }],
        [{ text: '🏷 معرفین برتر', callback_data: 'ADMIN:STATS:TOPREF' }, { text: '💰 خریداران برتر', callback_data: 'ADMIN:STATS:TOPBUY' }],
        [{ text: '🔄 تازه‌سازی', callback_data: 'ADMIN:STATS' }],
        [{ text: '🏠 منو', callback_data: 'MENU' }]
      ] }
    });
    return;
  }
  if (data === 'ADMIN:STATS:TOPREF' && isAdmin(uid)) {
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    const top = await computeTopReferrers(env, 10);
    const text = top.length
      ? '🏷 معرفین برتر (۱۰ نفر):\n' + top.map((u, i) => `${i+1}. ${u.id} ${u.username ? `(@${u.username})` : ''} — معرفی‌ها: ${u.referrals||0} | الماس: ${u.diamonds||0}`).join('\n')
      : '— هیچ داده‌ای یافت نشد.';
    const kb = { inline_keyboard: [
      [{ text: '⬅️ بازگشت', callback_data: 'ADMIN:STATS' }]
    ] };
    await tgApi('sendMessage', { chat_id: chatId, text, reply_markup: kb });
    return;
  }
  if (data === 'ADMIN:STATS:TOPBUY' && isAdmin(uid)) {
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    const top = await computeTopPurchasers(env, 10);
    const text = top.length
      ? '💰 خریداران برتر (۱۰ نفر):\n' + top.map((u, i) => `${i+1}. ${u.user_id} ${u.username ? `(@${u.username})` : ''} — خرید: ${u.count||0} | الماس: ${u.diamonds||0} | مبلغ: ${(u.amount||0).toLocaleString('fa-IR')}ت`).join('\n')
      : '— هیچ داده‌ای یافت نشد.';
    const kb = { inline_keyboard: [
      [{ text: '⬅️ بازگشت', callback_data: 'ADMIN:STATS' }]
    ] };
    await tgApi('sendMessage', { chat_id: chatId, text, reply_markup: kb });
    return;
  }
  if (data === 'ADMIN:STATS:DETAILS' && isAdmin(uid)) {
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    // Compute highest weekly points among users (sample limited)
    const users = (await kvGetJson(env, 'index:users')) || [];
    const wk = weekKey();
    let topUser = null; let topPts = -1;
    for (const u of users.slice(0, 500)) {
      const rec = (await kvGetJson(env, `points_week:${u}:${wk}`)) || { points: 0 };
      if ((rec.points || 0) > topPts) { topPts = rec.points || 0; topUser = u; }
    }
    const highestWeekly = topUser ? `${topUser} — ${topPts} الماس` : '—';
    const text = `📊 آمار جزئی\n\n🏆 بیشترین امتیاز کسب‌شده در این هفته: ${highestWeekly}\n\nدکمه‌های بیشتر:`;
    const rows = [
      [{ text: '🏆 بیشترین امتیاز هفته (تازه‌سازی)', callback_data: 'ADMIN:STATS:DETAILS' }],
      [{ text: '⬅️ بازگشت', callback_data: 'ADMIN:STATS' }]
    ];
    await tgApi('sendMessage', { chat_id: chatId, text, reply_markup: { inline_keyboard: rows } });
    return;
  }
  // ===== Tickets: Admin management panel
  if (data === 'ADMIN:TICKETS' && isAdmin(uid)) {
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    const list = await listTickets(env, { limit: 10 });
    const lines = list.length ? list.map(t => `#${t.id} | ${t.status || 'open'} | از ${t.user_id} | ${escapeHtml(t.subject || '-')}`).join('\n') : '—';
    const rows = [
      ...list.map(t => ([{ text: `🗂 ${t.id}`, callback_data: `ATK:VIEW:${t.id}` }])),
      [{ text: '🔄 تازه‌سازی', callback_data: 'ADMIN:TICKETS' }],
      [{ text: '🏠 منو', callback_data: 'MENU' }]
    ];
    await tgApi('sendMessage', { chat_id: chatId, text: `🧾 مدیریت تیکت‌ها\n\n${lines}`, reply_markup: { inline_keyboard: rows } });
    return;
  }
  if (data.startsWith('ATK:VIEW:') && isAdmin(uid)) {
    const id = data.split(':')[2];
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    const t = await getTicket(env, id);
    if (!t) { await tgApi('sendMessage', { chat_id: chatId, text: 'تیکت یافت نشد.' }); return; }
    const userBlocked = await isUserBlocked(env, t.user_id);
    const msgs = await getTicketMessages(env, id, 20);
    const history = msgs.map(m => `${m.from === 'admin' ? 'ادمین' : 'کاربر'} (${formatDate(m.at)}):\n${m.text}`).join('\n\n') || '—';
    const txt = `#${t.id} | ${t.status || 'open'}\nاز: ${t.user_id}${t.username ? ` (@${t.username})` : ''}\nدسته: ${t.category || '-'}\nموضوع: ${t.subject || '-'}\n${t.desc ? `\nشرح:\n${t.desc}\n` : ''}\nگفت‌وگو (آخرین ۲۰ پیام):\n${history}`;
    const kb = { inline_keyboard: [
      [{ text: '✉️ پاسخ', callback_data: `ATK:REPLY:${t.id}` }, { text: t.status === 'closed' ? '🔓 باز کردن' : '🔒 بستن', callback_data: `ATK:TOGGLE:${t.id}` }],
      [{ text: userBlocked ? '🟢 آنبلاک کاربر' : '⛔️ Block کاربر', callback_data: `ATK:BLK:${t.user_id}:${userBlocked ? 'UN' : 'BL'}` }],
      [{ text: '🗑 حذف تیکت', callback_data: `ATK:DEL:${t.id}` }],
      [{ text: '⬅️ بازگشت', callback_data: 'ADMIN:TICKETS' }]
    ] };
    await tgApi('sendMessage', { chat_id: chatId, text: txt, reply_markup: kb });
    return;
  }
  if (data.startsWith('ATK:REPLY:') && isAdmin(uid)) {
    const id = data.split(':')[2];
    await setSession(env, uid, { awaiting: `admin_ticket_reply:${id}` });
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    await tgApi('sendMessage', { chat_id: chatId, text: 'متن پاسخ را ارسال کنید:', reply_markup: { inline_keyboard: [[{ text: '❌ انصراف', callback_data: 'CANCEL' }]] } });
    return;
  }
  if (data.startsWith('ATK:TOGGLE:') && isAdmin(uid)) {
    const id = data.split(':')[2];
    const t = await getTicket(env, id);
    if (t) { t.status = t.status === 'closed' ? 'open' : 'closed'; await putTicket(env, t); }
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'بروزرسانی شد' });
    await tgApi('sendMessage', { chat_id: chatId, text: `وضعیت تیکت #${id}: ${t?.status || '-'}` });
    // notify the ticket owner if closed
    try {
      if (t && t.status === 'closed') {
        await tgApi('sendMessage', { chat_id: t.user_id, text: `📪 تیکت شما (#${t.id}) بسته شد. اگر نیاز به ادامه دارید، می‌توانید تیکت جدیدی ثبت کنید.` });
      }
    } catch (_) {}
    return;
  }
  if (data.startsWith('ATK:BLK:') && isAdmin(uid)) {
    const [, , userIdStr, op] = data.split(':');
    const targetId = Number(userIdStr);
    if (op === 'BL') await blockUser(env, targetId); else await unblockUser(env, targetId);
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: op === 'BL' ? 'مسدود شد' : 'آنبلاک شد' });
    await tgApi('sendMessage', { chat_id: chatId, text: `کاربر ${targetId} ${op === 'BL' ? 'مسدود' : 'آنبلاک'} شد.` });
    return;
  }
  if (data.startsWith('ATK:DEL:') && isAdmin(uid)) {
    const id = data.split(':')[2];
    await deleteTicket(env, id);
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'حذف شد' });
    await tgApi('sendMessage', { chat_id: chatId, text: `تیکت #${id} حذف شد.` });
    return;
  }
  if (data === 'ADMIN:MANAGE_JOIN' && isAdmin(uid)) {
    const channels = await getRequiredChannels(env);
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    const lines = channels.map((c, i) => `${i+1}. ${c}`).join('\n') || '—';
    await tgApi('sendMessage', { chat_id: chatId, text: `📣 کانال‌های اجباری فعلی:\n${lines}\n\nبرای افزودن/حذف، از دکمه‌ها استفاده کنید.`, reply_markup: { inline_keyboard: [
      [{ text: '➕ افزودن کانال', callback_data: 'ADMIN:JOIN_ADD' }],
      ...(channels.map((c, idx) => ([{ text: `❌ حذف ${c}`, callback_data: `ADMIN:JOIN_DEL:${idx}` }]))),
      [{ text: '🏠 منو', callback_data: 'MENU' }]
    ] } });
    return;
  }
  if (data === 'ADMIN:JOIN_ADD' && isAdmin(uid)) {
    await setSession(env, uid, { awaiting: 'join_add' });
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    await tgApi('sendMessage', { chat_id: chatId, text: 'شناسه کانال را ارسال کنید (با @ یا آی‌دی عددی):' });
    return;
  }
  if (data.startsWith('ADMIN:JOIN_DEL:') && isAdmin(uid)) {
    const idx = parseInt(data.split(':')[2], 10);
    const channels = await getRequiredChannels(env);
    if (idx >= 0 && idx < channels.length) {
      channels.splice(idx, 1);
      await setRequiredChannels(env, channels);
    }
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'به‌روزرسانی شد' });
    await tgApi('sendMessage', { chat_id: chatId, text: 'به‌روزرسانی انجام شد.', reply_markup: await buildDynamicMainMenu(env, uid) });
    return;
  }
  if (data === 'ADMIN:MANAGE_ADMINS' && isAdmin(uid)) {
    const admins = await getAdminIds(env);
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    await tgApi('sendMessage', { chat_id: chatId, text: `👑 ادمین‌ها:\n${admins.join(', ') || '—'}`, reply_markup: { inline_keyboard: [
      [{ text: '➕ افزودن ادمین', callback_data: 'ADMIN:ADD_ADMIN' }],
      ...(admins.filter(id => id !== Number(uid)).map(id => ([{ text: `❌ حذف ${id}`, callback_data: `ADMIN:DEL_ADMIN:${id}` }]))),
      [{ text: '🏠 منو', callback_data: 'MENU' }]
    ] } });
    return;
  }
  if (data === 'ADMIN:GIFTS' && isAdmin(uid)) {
    const list = await listGiftCodes(env, 20);
    const lines = list.map(g => `${g.code} | ${g.amount} سکه | ${g.disabled ? 'غیرفعال' : 'فعال'} | ${g.used||0}/${g.max_uses||'∞'}`).join('\n') || '—';
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    await tgApi('sendMessage', { chat_id: chatId, text: `🎁 گیفت‌کدها:\n${lines}`, reply_markup: { inline_keyboard: [
      [{ text: '➕ ایجاد گیفت‌کد', callback_data: 'ADMIN:GIFT_CREATE' }],
      ...list.map(g => ([
        { text: `${g.disabled ? '🟢 فعال‌سازی' : '🔴 غیرفعال'}`, callback_data: `ADMIN:GIFT_TOGGLE:${g.code}` },
        { text: '🗑 حذف', callback_data: `ADMIN:GIFT_DELETE:${g.code}` }
      ])),
      [{ text: '🔄 تازه‌سازی', callback_data: 'ADMIN:GIFTS' }],
      [{ text: '🏠 منو', callback_data: 'MENU' }]
    ] } });
    return;
  }
  if (data.startsWith('ADMIN:GIFT_TOGGLE:') && isAdmin(uid)) {
    const code = data.split(':')[2];
    const key = await giftCodeKey(code);
    const meta = await kvGetJson(env, key);
    if (meta) { meta.disabled = !meta.disabled; await kvPutJson(env, key, meta); }
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'بروزرسانی شد' });
    await tgApi('sendMessage', { chat_id: chatId, text: `کد ${code} ${meta?.disabled ? 'غیرفعال' : 'فعال'} شد.` });
    return;
  }
  if (data.startsWith('ADMIN:GIFT_DELETE:') && isAdmin(uid)) {
    const code = data.split(':')[2];
    const key = await giftCodeKey(code);
    await kvDelete(env, key);
    // remove from index
    const idx = (await kvGetJson(env, 'gift:index')) || [];
    const c = String(code).trim().toUpperCase();
    const next = idx.filter(x => x !== c);
    await kvPutJson(env, 'gift:index', next);
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'حذف شد' });
    await tgApi('sendMessage', { chat_id: chatId, text: `کد ${code} حذف شد.` });
    return;
  }
  if (data === 'ADMIN:GIFT_CREATE' && isAdmin(uid)) {
    await setSession(env, uid, { awaiting: `admin_create_gift:code:` });
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    await tgApi('sendMessage', { chat_id: chatId, text: 'کد دلخواه را وارد کنید (حروف/اعداد):' });
    return;
  }
  if (data === 'ADMIN:SETTINGS' && isAdmin(uid)) {
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    const s = await getSettings(env);
    await tgApi('sendMessage', { chat_id: chatId, text: `⚙️ تنظیمات سرویس:\n- محدودیت روزانه دانلود: ${s.daily_limit}\n- پیام خوش‌آمد: ${s.welcome_message ? 'تعریف شده' : '—'}\n- هزینه DNS اختصاصی: ${s.cost_dns} سکه\n- هزینه وایرگارد اختصاصی: ${s.cost_wg} سکه\n- هزینه OpenVPN: ${s.cost_ovpn||6} سکه`, reply_markup: { inline_keyboard: [
      [{ text: '💰 تنظیم هزینه‌ها', callback_data: 'ADMIN:SET:COSTS' }],
      [{ text: '🌐 مدیریت لوکیشن‌ها', callback_data: 'ADMIN:SET:LOCATIONS' }],
      [{ text: '🚫 مدیریت دکمه‌ها', callback_data: 'ADMIN:SET:BTNS' }],
      [{ text: '⬅️ بازگشت', callback_data: 'ADMIN:PANEL' }]
    ] } });
    return;
  }
  if (data === 'ADMIN:SET:COSTS' && isAdmin(uid)) {
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    const s = await getSettings(env);
    const rows = [
      [{ text: `DNS: ${s.cost_dns} سکه`, callback_data: 'NOOP' }, { text: '✏️ تغییر DNS', callback_data: 'ADMIN:SET:COST:DNS' }],
      [{ text: `WG: ${s.cost_wg} سکه`, callback_data: 'NOOP' }, { text: '✏️ تغییر WG', callback_data: 'ADMIN:SET:COST:WG' }],
      [{ text: `OVPN: ${s.cost_ovpn||6} سکه`, callback_data: 'NOOP' }, { text: '✏️ تغییر OVPN', callback_data: 'ADMIN:SET:COST:OVPN' }],
      [{ text: '⬅️ بازگشت', callback_data: 'ADMIN:SETTINGS' }]
    ];
    await tgApi('sendMessage', { chat_id: chatId, text: '💎 تنظیم هزینه سرویس‌ها:', reply_markup: { inline_keyboard: rows } });
    return;
  }
  if (data === 'ADMIN:SET:COST:DNS' && isAdmin(uid)) {
    await setSession(env, uid, { awaiting: 'set_cost_dns' });
    await tgApi('sendMessage', { chat_id: chatId, text: 'مقدار جدید هزینه DNS اختصاصی (سکه) را وارد کنید:' });
    return;
  }
  if (data === 'ADMIN:SET:COST:WG' && isAdmin(uid)) {
    await setSession(env, uid, { awaiting: 'set_cost_wg' });
    await tgApi('sendMessage', { chat_id: chatId, text: 'مقدار جدید هزینه وایرگارد اختصاصی (سکه) را وارد کنید:' });
    return;
  }
  if (data === 'ADMIN:SET:COST:OVPN' && isAdmin(uid)) {
    await setSession(env, uid, { awaiting: 'set_cost_ovpn' });
    await tgApi('sendMessage', { chat_id: chatId, text: 'مقدار جدید هزینه OpenVPN (سکه) را وارد کنید:' });
    return;
  }

  // Admin: user details
  if (data === 'ADMIN:USER_DETAILS' && isAdmin(uid)) {
    await setSession(env, uid, { awaiting: 'admin_user_details' });
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    await tgApi('sendMessage', { chat_id: chatId, text: 'آی‌دی عددی کاربر را وارد کنید:', reply_markup: { inline_keyboard: [[{ text: '❌ انصراف', callback_data: 'CANCEL' }]] } });
    return;
  }
  if (data === 'ADMIN:DISABLE_LOCS' && isAdmin(uid)) {
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    const s = await getSettings(env);
    const map = s.disabled_locations || { dns: {}, wg: {} };
    const countries = ['DE'];
    const dnsRows = countries.map(c => ([{ text: `${map.dns?.[c] ? '🟢 فعال‌سازی' : '🔴 غیرفعال'} DNS — ${countryFlag(c)} ${dnsCountryLabel(c)}`, callback_data: `ADMIN:LOC_TOGGLE:${c}:dns` }]));
    const wgRows = countries.map(c => ([{ text: `${map.wg?.[c] ? '🟢 فعال‌سازی' : '🔴 غیرفعال'} WG — ${countryFlag(c)} ${dnsCountryLabel(c)}`, callback_data: `ADMIN:LOC_TOGGLE:${c}:wg` }]));
    const rows = [
      [{ text: '🔽 DNS', callback_data: 'NOOP' }],
      ...dnsRows,
      [{ text: '🔽 WireGuard', callback_data: 'NOOP' }],
      ...wgRows,
      [{ text: '⬅️ بازگشت', callback_data: 'ADMIN:SETTINGS' }]
    ];
    await tgApi('sendMessage', { chat_id: chatId, text: '🌐 مدیریت وضعیت لوکیشن‌ها:', reply_markup: { inline_keyboard: rows } });
    return;
  }
  if (data.startsWith('ADMIN:LOC_TOGGLE:') && isAdmin(uid)) {
    const [, , code, svc] = data.split(':');
    const s = await getSettings(env);
    const map = s.disabled_locations || { dns: {}, wg: {} };
    const svcKey = (svc || '').toLowerCase();
    map[svcKey] = map[svcKey] || {};
    map[svcKey][code] = !map[svcKey][code];
    s.disabled_locations = map;
    await setSettings(env, s);
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'به‌روزرسانی شد' });
    // Re-render list
    const countries = ['ES','DE','FR','PH','JP','TR','SE','NL','DK','BE','CH','CN'];
    const dnsRows = countries.map(c => ([{ text: `${map.dns?.[c] ? '🟢 فعال‌سازی' : '🔴 غیرفعال'} DNS — ${countryFlag(c)} ${dnsCountryLabel(c)}`, callback_data: `ADMIN:LOC_TOGGLE:${c}:dns` }]));
    const wgRows = countries.map(c => ([{ text: `${map.wg?.[c] ? '🟢 فعال‌سازی' : '🔴 غیرفعال'} WG — ${countryFlag(c)} ${dnsCountryLabel(c)}`, callback_data: `ADMIN:LOC_TOGGLE:${c}:wg` }]));
    const rows = [
      [{ text: '🔽 DNS', callback_data: 'NOOP' }],
      ...dnsRows,
      [{ text: '🔽 WireGuard', callback_data: 'NOOP' }],
      ...wgRows,
      [{ text: '⬅️ بازگشت', callback_data: 'ADMIN:SETTINGS' }]
    ];
    await tgApi('sendMessage', { chat_id: chatId, text: '🌐 مدیریت وضعیت لوکیشن‌ها:', reply_markup: { inline_keyboard: rows } });
    return;
  }
  if (data === 'ADMIN:DISABLE_BTNS' && isAdmin(uid)) {
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    const s = await getSettings(env);
    const map = s.disabled_buttons || {};
    const items = [
      { key: 'GET_BY_TOKEN', label: labelFor(s.button_labels, 'get_by_token', '🔑 دریافت با توکن') },
      { key: 'SUB:REFERRAL', label: '👥 زیرمجموعه گیری' },
      { key: 'SUB:ACCOUNT', label: '👤 حساب کاربری' }
    ];

    const rows = items.map(it => ([{ text: `${map[it.key] ? '🟢 فعال‌سازی' : '🔴 غیرفعال'} ${it.label}` , callback_data: `ADMIN:BTN_TOGGLE:${encodeURIComponent(it.key)}` }]));
    rows.push([{ text: '⬅️ بازگشت', callback_data: 'ADMIN:SETTINGS' }]);
    await tgApi('sendMessage', { chat_id: chatId, text: '🚫 مدیریت دکمه‌ها:', reply_markup: { inline_keyboard: rows } });
    return;
  }
  if (data.startsWith('ADMIN:BTN_TOGGLE:') && isAdmin(uid)) {
    const key = decodeURIComponent(data.split(':')[2]);
    const s = await getSettings(env);
    const map = s.disabled_buttons || {};
    map[key] = !map[key];
    s.disabled_buttons = map;
    await setSettings(env, s);
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'به‌روزرسانی شد' });
    // Refresh list view with human-friendly labels
    const items = [
      { key: 'GET_BY_TOKEN', label: labelFor(s.button_labels, 'get_by_token', '🔑 دریافت با توکن') },
      { key: 'SUB:REFERRAL', label: '👥 زیرمجموعه گیری' },
      { key: 'SUB:ACCOUNT', label: '👤 حساب کاربری' }
    ];
    const rows = items.map(it => ([{ text: `${map[it.key] ? '🟢 فعال‌سازی' : '🔴 غیرفعال'} ${it.label}` , callback_data: `ADMIN:BTN_TOGGLE:${encodeURIComponent(it.key)}` }]));
    rows.push([{ text: '⬅️ بازگشت', callback_data: 'ADMIN:SETTINGS' }]);
    await tgApi('sendMessage', { chat_id: chatId, text: '🚫 مدیریت دکمه‌ها:', reply_markup: { inline_keyboard: rows } });
    return;
  }
  if (data === 'ADMIN:SET:WELCOME' && isAdmin(uid)) {
    await setSession(env, uid, { awaiting: 'set_welcome' });
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    await tgApi('sendMessage', { chat_id: chatId, text: 'متن پیام خوش‌آمد جدید را ارسال کنید:', reply_markup: { inline_keyboard: [[{ text: '❌ انصراف', callback_data: 'CANCEL' }]] } });
    return;
  }
  if (data === 'ADMIN:SET:DAILY' && isAdmin(uid)) {
    await setSession(env, uid, { awaiting: 'set_daily_limit' });
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    await tgApi('sendMessage', { chat_id: chatId, text: 'محدودیت روزانه (عدد) را ارسال کنید. 0 برای غیرفعال:', reply_markup: { inline_keyboard: [[{ text: '❌ انصراف', callback_data: 'CANCEL' }]] } });
    return;
  }
  if (data === 'ADMIN:SET:BUTTONS' && isAdmin(uid)) {
    await setSession(env, uid, { awaiting: 'set_buttons' });
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    await tgApi('sendMessage', { chat_id: chatId, text: 'JSON دکمه‌ها را ارسال کنید. مثال: {"profile":"پروفایل من"}', reply_markup: { inline_keyboard: [[{ text: '❌ انصراف', callback_data: 'CANCEL' }]] } });
    return;
  }
  if (data === 'ADMIN:MISSIONS' && isAdmin(uid)) {
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    const v = await listMissions(env);
    const listText = v.length ? v.map(m => `- ${m.id}: ${m.title} (${m.period||'once'} | ${m.type||'generic'}) ${m.enabled ? '🟢' : '🔴'} +${m.reward}`).join('\n') : '—';
    await tgApi('sendMessage', { chat_id: chatId, text: `📆 مأموریت‌ها:\n${listText}`, reply_markup: { inline_keyboard: [
      [{ text: '➕ ایجاد', callback_data: 'ADMIN:MIS:CREATE' }, { text: '✏️ ویرایش', callback_data: 'ADMIN:MIS:EDIT' }],
      [{ text: '🧩 کوییز هفتگی', callback_data: 'ADMIN:MIS:CREATE:QUIZ' }, { text: '❓ سوال هفتگی', callback_data: 'ADMIN:MIS:CREATE:QUESTION' }, { text: '👥 دعوت هفتگی', callback_data: 'ADMIN:MIS:CREATE:INVITE' }],
      ...v.map(m => ([
        { text: `${m.enabled ? '🔴 غیرفعال' : '🟢 فعال‌سازی'} ${m.id}` , callback_data: `ADMIN:MIS:TOGGLE:${m.id}` },
        { text: `🗑 حذف ${m.id}`, callback_data: `ADMIN:MIS:DEL:${m.id}` }
      ])),
      [{ text: '⬅️ بازگشت به پنل', callback_data: 'ADMIN:PANEL' }]
    ] } });
    return;
  }
  if (data === 'ADMIN:MIS:EDIT' && isAdmin(uid)) {
    await setSession(env, uid, { awaiting: 'mission_edit:id' });
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    await tgApi('sendMessage', { chat_id: chatId, text: 'شناسه ماموریت برای ویرایش را ارسال کنید:', reply_markup: { inline_keyboard: [[{ text: '❌ انصراف', callback_data: 'CANCEL' }]] } });
    return;
  }
  if (data === 'ADMIN:MIS:CREATE' && isAdmin(uid)) {
    await setSession(env, uid, { awaiting: 'mission_create:title' });
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    await tgApi('sendMessage', { chat_id: chatId, text: 'عنوان ماموریت را ارسال کنید:', reply_markup: { inline_keyboard: [[{ text: '❌ انصراف', callback_data: 'CANCEL' }]] } });
    return;
  }
  if (data.startsWith('ADMIN:MIS:TOGGLE:') && isAdmin(uid)) {
    const id = data.split(':')[3];
    const key = `mission:${id}`;
    const m = await kvGetJson(env, key);
    if (!m) { await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'یافت نشد' }); return; }
    m.enabled = !m.enabled;
    await kvPutJson(env, key, m);
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: m.enabled ? 'فعال شد' : 'غیرفعال شد' });
    await tgApi('sendMessage', { chat_id: chatId, text: `ماموریت ${id} اکنون ${m.enabled ? 'فعال' : 'غیرفعال'} است.` });
    return;
  }
  if (data === 'ADMIN:MIS:CREATE:QUIZ' && isAdmin(uid)) {
    const draft = { type: 'quiz' };
    await setSession(env, uid, { awaiting: `mission_quiz:q:${encodeURIComponent(JSON.stringify(draft))}` });
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    await tgApi('sendMessage', { chat_id: chatId, text: 'سوال کوتاه کوییز را ارسال کنید:' });
    return;
  }
  if (data === 'ADMIN:MIS:CREATE:QUESTION' && isAdmin(uid)) {
    const draft = { type: 'question' };
    await setSession(env, uid, { awaiting: `mission_q:question:${encodeURIComponent(JSON.stringify(draft))}` });
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    await tgApi('sendMessage', { chat_id: chatId, text: 'سوال مسابقه هفتگی را ارسال کنید:' });
    return;
  }
  if (data === 'ADMIN:MIS:CREATE:INVITE' && isAdmin(uid)) {
    const draft = { type: 'invite' };
    await setSession(env, uid, { awaiting: `mission_inv:count:${encodeURIComponent(JSON.stringify(draft))}` });
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    await tgApi('sendMessage', { chat_id: chatId, text: 'تعداد دعوت مورد نیاز این هفته را وارد کنید (مثلاً 3):' });
    return;
  }
  if (data.startsWith('ADMIN:MIS:DEL:') && isAdmin(uid)) {
    const id = data.split(':')[3];
    await deleteMission(env, id);
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'حذف شد' });
    await tgApi('sendMessage', { chat_id: chatId, text: 'ماموریت حذف شد.' });
    return;
  }
  if ((data === 'ADMIN:BULK_UPLOAD' || data === 'ADMIN:BULK_META' || data === 'ADMIN:BULK_FINISH') && isAdmin(uid)) {
    await setSession(env, uid, {});
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    await tgApi('sendMessage', { chat_id: chatId, text: 'آپلود گروهی غیرفعال شده است.' });
    return;
  }
  // Admin Lottery removed
  if (data === 'ADMIN:ADD_ADMIN' && isAdmin(uid)) {
    await setSession(env, uid, { awaiting: 'add_admin' });
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    await tgApi('sendMessage', { chat_id: chatId, text: 'آی‌دی عددی کاربر را ارسال کنید تا به عنوان ادمین اضافه شود:' });
    return;
  }
  if (data.startsWith('ADMIN:DEL_ADMIN:') && isAdmin(uid)) {
    const removeId = Number(data.split(':')[2]);
    const admins = await getAdminIds(env);
    const next = admins.filter(id => id !== removeId);
    await setAdminIds(env, next);
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'حذف شد' });
    await tgApi('sendMessage', { chat_id: chatId, text: 'ادمین حذف شد.', reply_markup: await buildDynamicMainMenu(env, uid) });
    DYNAMIC_ADMIN_IDS = next.slice();
    return;
  }
}
async function onDocumentUpload(msg, env) {
  const doc = msg.document; const from = msg.from; const chatId = msg.chat.id;
  const fileId = doc.file_id; const fname = doc.file_name || 'config';

  const token = makeToken(10);
  const meta = {
    token,
    file_id: fileId,
    owner: from.id,
    name: fname,
    size: doc.file_size || 0,
    created_at: now(),
    downloads: 0,
    cost_points: 0,
    disabled: false
  };
  await kvPutJson(env, `file:${token}`, meta);

  // add to uploader index
  const upKey = `uploader:${from.id}`;
  const upList = (await kvGetJson(env, upKey)) || [];
  upList.push(token);
  await kvPutJson(env, upKey, upList);

  const botUsername = await getBotUsername(env);
  const link = botUsername 
    ? `https://t.me/${botUsername}?start=d_${token}`
    : `${domainFromWebhook()}/f/${token}`;
  await tgApi('sendMessage', { 
    chat_id: chatId, 
    text: `✅ فایل با موفقیت آپلود شد!\n\n📁 نام: ${fname}\n📏 حجم: ${formatFileSize(doc.file_size || 0)}\n\n🔐 توکن:\n\`${token}\`\n\n🔗 لینک اشتراک‌گذاری (باز می‌شود در ربات):\n\`${link}\`` ,
    parse_mode: 'Markdown'
  });
}

/* -------------------- Unified upload/store + delivery helpers -------------------- */
async function handleAnyUpload(msg, env, { ownerId, replaceToken, original } = {}) {
  // Supports: text, document, photo, video, audio, voice
  let meta = null;
  const base = {
    owner: ownerId,
    downloads: original?.downloads || 0,
    cost_points: original?.cost_points || 0,
    disabled: original?.disabled || false,
    created_at: original?.created_at || now()
  };

  if (msg.text) {
    const token = replaceToken || makeToken(10);
    meta = {
      token,
      type: 'text',
      text: msg.text,
      name: 'متن',
      size: (msg.text || '').length,
      ...base
    };
  } else if (msg.document) {
    const token = replaceToken || makeToken(10);
    meta = {
      token,
      type: 'document',
      file_id: msg.document.file_id,
      name: msg.document.file_name || 'document',
      size: msg.document.file_size || 0,
      ...base
    };
  } else if (msg.photo && msg.photo.length) {
    const token = replaceToken || makeToken(10);
    const p = msg.photo[msg.photo.length - 1];
    meta = {
      token,
      type: 'photo',
      file_id: p.file_id,
      name: 'photo',
      size: p.file_size || 0,
      ...base
    };
  } else if (msg.video) {
    const token = replaceToken || makeToken(10);
    meta = {
      token,
      type: 'video',
      file_id: msg.video.file_id,
      name: msg.video.file_name || 'video',
      size: msg.video.file_size || 0,
      ...base
    };
  } else if (msg.audio) {
    const token = replaceToken || makeToken(10);
    meta = {
      token,
      type: 'audio',
      file_id: msg.audio.file_id,
      name: msg.audio.title || 'audio',
      size: msg.audio.file_size || 0,
      ...base
    };
  } else if (msg.voice) {
    const token = replaceToken || makeToken(10);
    meta = {
      token,
      type: 'voice',
      file_id: msg.voice.file_id,
      name: 'voice',
      size: msg.voice.file_size || 0,
      ...base
    };
  }

  if (!meta) return null;

  // persist
  await kvPutJson(env, `file:${meta.token}`, meta);

  // If new item (not replace), add to uploader index
  if (!replaceToken) {
    const upKey = `uploader:${ownerId}`;
    const upList = (await kvGetJson(env, upKey)) || [];
    upList.push(meta.token);
    await kvPutJson(env, upKey, upList);
  }
  return meta;
}

async function deliverStoredContent(chatId, fileMeta) {
  const caption = `${fileMeta.name || fileMeta.type || 'item'}${fileMeta.size ? ' | ' + formatFileSize(fileMeta.size) : ''}`;
  switch (fileMeta.type) {
    case 'text':
      await tgApi('sendMessage', { chat_id: chatId, text: fileMeta.text || '' });
      break;
    case 'photo':
      await tgApi('sendPhoto', { chat_id: chatId, photo: fileMeta.file_id, caption });
      break;
    case 'video':
      await tgApi('sendVideo', { chat_id: chatId, video: fileMeta.file_id, caption });
      break;
    case 'audio':
      await tgApi('sendAudio', { chat_id: chatId, audio: fileMeta.file_id, caption });
      break;
    case 'voice':
      await tgApi('sendVoice', { chat_id: chatId, voice: fileMeta.file_id, caption });
      break;
    case 'document':
    default:
      await tgApi('sendDocument', { chat_id: chatId, document: fileMeta.file_id, caption });
      break;
  }
}

/* -------------------- File download handler -------------------- */
async function handleFileDownload(req, env, url) {
  const token = url.pathname.split('/f/')[1];
  if (!token) return new Response('Not Found', { status: 404 });
  const file = await kvGetJson(env, `file:${token}`);
  if (!file) return new Response('File Not Found', { status: 404 });

  // check service enabled
  const enabled = (await kvGetJson(env, 'bot:enabled')) ?? true;
  const updateMode = (await kvGetJson(env, 'bot:update_mode')) || false;
  if (!enabled) return new Response('Service temporarily disabled', { status: 503 });
  if (updateMode) return new Response('Bot is currently in update mode. Please try again later.', { status: 503 });

  if (file.disabled) return new Response('File disabled by owner/admin', { status: 403 });

  // For web link, instead of redirect, provide inline bot deep-link to receive inside bot
  const botUsername = await getBotUsername(env);
  const deepLink = botUsername ? `https://t.me/${botUsername}?start=d_${token}` : '';
  const html = `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:2rem;">
  <h2>دریافت فایل داخل ربات</h2>
  <p>برای دریافت مستقیم فایل داخل تلگرام روی لینک زیر بزنید:</p>
  ${deepLink ? `<p><a href="${deepLink}">باز کردن در تلگرام</a></p>` : '<p>نام کاربری ربات در دسترس نیست.</p>'}
  </body>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

/* -------------------- Main Page with Admin Panel -------------------- */
async function handleMainPage(req, env, url, ctx) {
  const key = url.searchParams.get('key');
  const adminKey = (RUNTIME.adminKey || ADMIN_KEY || '').trim();
  const isAuthenticated = key === adminKey;
  const action = url.searchParams.get('action');
  const op = url.searchParams.get('op');
  const targetId = url.searchParams.get('uid');

  // Handle toggle action via GET for convenience from admin panel button
  if (isAuthenticated && action === 'toggle') {
    const current = (await kvGetJson(env, 'bot:enabled')) ?? true;
    await kvPutJson(env, 'bot:enabled', !current);
    return Response.redirect(`/?key=${adminKey}`, 302);
  }

  // Admin action: setup webhook
  if (isAuthenticated && action === 'setup-webhook') {
    // Fallback to current request origin if no explicit webhook URL is configured
    const base = (RUNTIME.webhookUrl || WEBHOOK_URL || url.origin || '').replace(/\/$/, '');
    const targetUrl = base ? `${base}/webhook` : '';
    const setRes = targetUrl ? await tgSetWebhook(targetUrl) : null;
    if (setRes && setRes.ok) {
      await kvPutJson(env, 'bot:webhook_set_at', now());
    }
    return Response.redirect(`/?key=${adminKey}`, 302);
  }
  // Admin action: toggle update mode
  if (isAuthenticated && action === 'toggle-update') {
    const current = (await kvGetJson(env, 'bot:update_mode')) || false;
    await kvPutJson(env, 'bot:update_mode', !current);
    return Response.redirect(`/?key=${adminKey}`, 302);
  }
  // Admin action: broadcast via GET (simple)
  if (isAuthenticated && action === 'broadcast') {
    const msg = url.searchParams.get('message') || '';
    if (msg.trim()) {
      // run broadcast in background to keep page responsive
      if (ctx) ctx.waitUntil(broadcast(env, msg.trim())); else await broadcast(env, msg.trim());
    }
    return Response.redirect(`/?key=${adminKey}`, 302);
  }
  // Admin action: save basic settings (costs and join chat)
  if (isAuthenticated && action === 'save-settings') {
    const s = await getSettings(env);
    const cost_dns = Number(url.searchParams.get('cost_dns'));
    const cost_wg = Number(url.searchParams.get('cost_wg'));
    const cost_ovpn = Number(url.searchParams.get('cost_ovpn'));
    const join = (url.searchParams.get('join_chat') || '').trim();
    if (Number.isFinite(cost_dns)) s.cost_dns = cost_dns;
    if (Number.isFinite(cost_wg)) s.cost_wg = cost_wg;
    if (Number.isFinite(cost_ovpn)) s.cost_ovpn = cost_ovpn;
    if (typeof join === 'string') { RUNTIME.joinChat = join; }
    await setSettings(env, s);
    return Response.redirect(`/?key=${adminKey}`, 302);
  }
  // Admin action: delete webhook
  if (isAuthenticated && action === 'delete-webhook') {
    await tgDeleteWebhook();
    await kvPutJson(env, 'bot:webhook_set_at', 0);
    return Response.redirect(`/?key=${adminKey}`, 302);
  }

  // Admin actions: block/unblock via GET
  if (isAuthenticated && op && targetId) {
    const tid = Number(targetId);
    if (Number.isFinite(tid)) {
      if (op === 'block') { await blockUser(env, tid); }
      if (op === 'unblock') { await unblockUser(env, tid); }
    }
    return Response.redirect(`/?key=${adminKey}`, 302);
  }
  
  // Get basic stats for public view
  const users = (await kvGetJson(env, 'index:users')) || [];
  const userCount = users.length;
  
  let files = [];
  let totalDownloads = 0;
  
  // Collect files from all uploaders
  for (const uid of users.slice(0, 100)) { // Limit for performance
    const list = (await kvGetJson(env, `uploader:${uid}`)) || [];
    for (const t of list) {
      const f = await kvGetJson(env, `file:${t}`);
      if (f) {
        files.push(f);
        totalDownloads += f.downloads || 0;
      }
    }
  }
  
  const fileCount = files.length;
  const enabled = (await kvGetJson(env, 'bot:enabled')) ?? true;
  const lastWebhookAt = (await kvGetJson(env, 'bot:last_webhook')) || 0;
  const connected = typeof lastWebhookAt === 'number' && (now() - lastWebhookAt) < 5 * 60 * 1000;

  const updateMode = (await kvGetJson(env, 'bot:update_mode')) || false;
  const settings = isAuthenticated ? await getSettings(env) : null;
  const webhookInfo = isAuthenticated ? await tgGetWebhookInfo() : null;
  const desiredWebhook = (RUNTIME.webhookUrl || WEBHOOK_URL || url.origin || '');
  const webhookSetAt = (await kvGetJson(env, 'bot:webhook_set_at')) || 0;
  const webhookCheckedAt = (await kvGetJson(env, 'bot:webhook_check_at')) || 0;
  // Admin insights (computed only when authenticated)
  const topPurchasers = isAuthenticated ? await computeTopPurchasers(env, 5) : [];
  const topReferrers = isAuthenticated ? await computeTopReferrers(env, 5) : [];
  const overallStats = isAuthenticated ? await computeOverallStats(env) : null;
  const html = `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${isAuthenticated ? 'پنل مدیریت' : 'WireGuard Bot'}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }

        :root {
            --bg-start: #0f172a;
            --bg-mid: #1e293b;
            --bg-end: #334155;
            --glass-bg: rgba(255, 255, 255, 0.05);
            --glass-border: rgba(255, 255, 255, 0.1);
            --text-muted: #cbd5e1;
            --accent: #60a5fa;
            --accent2: #34d399;
            --accent3: #fbbf24;
        }

        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, var(--bg-start) 0%, var(--bg-mid) 50%, var(--bg-end) 100%);
            background-size: 200% 200%;
            animation: gradientShift 12s ease infinite;
            min-height: 100vh;
            color: #f1f5f9;
            overflow-x: hidden;
        }

        @keyframes gradientShift {
            0% { background-position: 0% 50%; }
            50% { background-position: 100% 50%; }
            100% { background-position: 0% 50%; }
        }

        .container {
            max-width: 1400px;
            margin: 0 auto;
            padding: 20px;
        }

        .header {
            text-align: center;
            margin-bottom: 40px;
            padding: 40px 20px;
            background: var(--glass-bg);
            backdrop-filter: blur(10px);
            border-radius: 20px;
            border: 1px solid var(--glass-border);
            position: relative;
            overflow: hidden;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
        }

        .header::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: linear-gradient(45deg, transparent 49%, rgba(255, 255, 255, 0.03) 50%, transparent 51%);
            pointer-events: none;
        }

        .header h1 {
            font-size: 3rem;
            font-weight: 700;
            background: linear-gradient(135deg, var(--accent), var(--accent2), var(--accent3));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            margin-bottom: 10px;
            text-shadow: 0 2px 20px rgba(96, 165, 250, 0.15);
        }

        .header p {
            font-size: 1.2rem;
            opacity: 0.8;
            max-width: 600px;
            margin: 0 auto;
        }

        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
            gap: 20px;
            margin-bottom: 40px;
        }

        .stat-card {
            background: rgba(255, 255, 255, 0.03);
            backdrop-filter: blur(12px);
            padding: 30px;
            border-radius: 15px;
            border: 1px solid rgba(255, 255, 255, 0.1);
            text-align: center;
            transition: all 0.3s ease;
            position: relative;
            overflow: hidden;
            box-shadow: 0 10px 25px rgba(0, 0, 0, 0.2);
        }

        .stat-card::before {
            content: '';
            position: absolute;
            top: 0;
            left: -100%;
            width: 100%;
            height: 100%;
            background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.1), transparent);
            transition: left 0.5s;
        }

        .stat-card:hover::before {
            left: 100%;
        }

        .stat-card:hover {
            transform: translateY(-5px);
            border-color: rgba(96, 165, 250, 0.35);
            box-shadow: 0 25px 50px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(96,165,250,0.2) inset;
        }

        .stat-icon {
            font-size: 3rem;
            margin-bottom: 15px;
            display: block;
        }

        .stat-value {
            font-size: 2.5rem;
            font-weight: 700;
            margin-bottom: 10px;
            color: #60a5fa;
        }

        .stat-label {
            font-size: 1.1rem;
            opacity: 0.8;
        }

        ${isAuthenticated ? `
        .admin-panel {
            background: var(--glass-bg);
            backdrop-filter: blur(15px);
            border-radius: 20px;
            border: 1px solid var(--glass-border);
            padding: 30px;
            margin-bottom: 30px;
            box-shadow: 0 12px 30px rgba(0,0,0,0.28);
        }

        .admin-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 30px;
            flex-wrap: wrap;
            gap: 20px;
        }

        .admin-title {
            font-size: 1.8rem;
            font-weight: 600;
            color: #fbbf24;
        }

        .service-status {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 10px 20px;
            border-radius: 10px;
            background: rgba(255, 255, 255, 0.1);
            font-weight: 500;
        }

        .status-dot {
            width: 12px;
            height: 12px;
            border-radius: 50%;
            background: ${enabled ? '#22c55e' : '#ef4444'};
            animation: pulse 2s infinite;
        }

        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }

        .btn {
            display: inline-block;
            padding: 12px 24px;
            border-radius: 10px;
            background: linear-gradient(135deg, #3b82f6, #1d4ed8);
            color: white;
            text-decoration: none;
            font-weight: 500;
            transition: all 0.3s ease;
            border: none;
            cursor: pointer;
            box-shadow: 0 8px 18px rgba(29, 78, 216, 0.35);
            letter-spacing: 0.2px;
        }

        .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 12px 24px rgba(59, 130, 246, 0.5);
        }

        .btn-danger {
            background: linear-gradient(135deg, #ef4444, #dc2626);
        }

        .btn-success {
            background: linear-gradient(135deg, #22c55e, #16a34a);
        }

        .data-table {
            background: rgba(255, 255, 255, 0.03);
            backdrop-filter: blur(10px);
            border-radius: 15px;
            border: 1px solid rgba(255, 255, 255, 0.1);
            overflow: hidden;
            margin-bottom: 30px;
            box-shadow: 0 10px 28px rgba(0,0,0,0.25);
        }

        .table-header {
            background: rgba(255, 255, 255, 0.1);
            padding: 20px;
            font-size: 1.3rem;
            font-weight: 700;
            color: var(--accent);
            position: relative;
        }

        .table-header::after {
            content: '';
            position: absolute;
            left: 20px;
            right: 20px;
            bottom: 8px;
            height: 2px;
            background: linear-gradient(90deg, rgba(96,165,250,.6), rgba(52,211,153,.6), rgba(251,191,36,.6));
            border-radius: 2px;
        }

        .table-content {
            max-height: 400px;
            overflow-y: auto;
        }

        .table-content::-webkit-scrollbar {
            width: 8px;
        }

        .table-content::-webkit-scrollbar-track {
            background: rgba(255, 255, 255, 0.1);
        }

        .table-content::-webkit-scrollbar-thumb {
            background: rgba(96, 165, 250, 0.5);
            border-radius: 4px;
        }

        table {
            width: 100%;
            border-collapse: collapse;
        }

        th, td {
            text-align: right;
            padding: 15px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
        }

        th {
            background: rgba(255, 255, 255, 0.05);
            font-weight: 600;
            color: #cbd5e1;
            position: sticky;
            top: 0;
        }

        td {
            transition: all 0.3s ease;
        }

        tbody tr:nth-child(even) td { background: rgba(255, 255, 255, 0.03); }
        tbody tr:hover td { background: rgba(255, 255, 255, 0.07); }

        .file-name {
            max-width: 200px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .status-badge {
            padding: 4px 12px;
            border-radius: 20px;
            font-size: 0.9rem;
            font-weight: 500;
        }

        .status-active {
            background: rgba(34, 197, 94, 0.2);
            color: #22c55e;
            border: 1px solid rgba(34, 197, 94, 0.3);
        }

        .status-disabled {
            background: rgba(239, 68, 68, 0.2);
            color: #ef4444;
            border: 1px solid rgba(239, 68, 68, 0.3);
        }
        ` : ''}

        .auth-form {
            max-width: 400px;
            margin: 40px auto;
            background: rgba(255, 255, 255, 0.05);
            backdrop-filter: blur(15px);
            padding: 40px;
            border-radius: 20px;
            border: 1px solid rgba(255, 255, 255, 0.1);
        }

        .auth-form h2 {
            text-align: center;
            margin-bottom: 30px;
            color: #fbbf24;
        }

        .form-group {
            margin-bottom: 20px;
        }

        .form-group label {
            display: block;
            margin-bottom: 8px;
            color: #cbd5e1;
        }

        .form-group input {
            width: 100%;
            padding: 15px;
            border-radius: 10px;
            border: 1px solid rgba(255, 255, 255, 0.2);
            background: rgba(255, 255, 255, 0.1);
            color: white;
            font-size: 1rem;
        }

        .form-group input:focus {
            outline: none;
            border-color: #60a5fa;
            box-shadow: 0 0 0 3px rgba(96, 165, 250, 0.2);
        }

        @media (max-width: 768px) {
            .header h1 { font-size: 2rem; }
            .container { padding: 15px; }
            .stats-grid { grid-template-columns: 1fr; }
            .admin-header { flex-direction: column; text-align: center; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🤖 WireGuard Bot</h1>
            <p>سیستم مدیریت و اشتراک‌گذاری فایل‌های WireGuard با امکانات پیشرفته</p>
        </div>

        <div class="stats-grid">
            <div class="stat-card">
                <span class="stat-icon">👥</span>
                <div class="stat-value">${userCount.toLocaleString('fa-IR')}</div>
                <div class="stat-label">کاربران ثبت شده</div>
            </div>
            <div class="stat-card">
                <span class="stat-icon">📁</span>
                <div class="stat-value">${fileCount.toLocaleString('fa-IR')}</div>
                <div class="stat-label">فایل‌های آپلود شده</div>
            </div>
            <div class="stat-card">
                <span class="stat-icon">📥</span>
                <div class="stat-value">${totalDownloads.toLocaleString('fa-IR')}</div>
                <div class="stat-label">کل دانلودها</div>
            </div>
            <div class="stat-card">
                <span class="stat-icon">${enabled ? '🟢' : '🔴'}</span>
                <div class="stat-value">${enabled ? 'فعال' : 'غیرفعال'}</div>
                <div class="stat-label">وضعیت سرویس</div>
            </div>
            <div class="stat-card">
                <span class="stat-icon">${connected ? '🔌' : '⚠️'}</span>
                <div class="stat-value">${connected ? 'آنلاین' : 'آفلاین'}</div>
                <div class="stat-label">اتصال وبهوک ${lastWebhookAt ? '(' + formatDate(lastWebhookAt) + ')' : ''}</div>
            </div>
        </div>

        ${!isAuthenticated ? `
        <div class="auth-form">
            <h2>🔐 ورود به پنل مدیریت</h2>
            <form method="GET">
                <div class="form-group">
                    <label for="key">کلید دسترسی:</label>
                    <input type="password" id="key" name="key" placeholder="کلید مدیریت را وارد کنید" required>
                </div>
                <button type="submit" class="btn" style="width: 100%;">ورود به پنل</button>
            </form>
        </div>
        ` : `
        <div class="admin-panel">
            <div class="admin-header">
                <div class="admin-title">🛠 پنل مدیریت</div>
                <div class="service-status">
                    <div class="status-dot"></div>
                    <span>سرویس ${enabled ? 'فعال' : 'غیرفعال'}</span>
                    <a href="/?key=${adminKey}&action=toggle" class="btn ${enabled ? 'btn-danger' : 'btn-success'}" style="margin-right: 15px;">
                        ${enabled ? 'غیرفعال کردن' : 'فعال کردن'}
                    </a>
                    <a href="/?key=${adminKey}&action=setup-webhook" class="btn" style="margin-right: 10px;">
                        راه‌اندازی وبهوک
                    </a>
                    <a href="/?key=${adminKey}&action=delete-webhook" class="btn btn-danger" style="margin-right: 10px;">
                        حذف وبهوک
                    </a>
                    <a href="/?key=${adminKey}" class="btn" style="margin-right: 10px;">
                        بروزرسانی اطلاعات
                    </a>
                    <a href="/?key=${adminKey}&action=toggle-update" class="btn" style="margin-right: 10px;">
                        ${updateMode ? 'خاموش کردن حالت آپدیت' : 'روشن کردن حالت آپدیت'}
                    </a>
                </div>
            </div>
            <div class="data-table" style="margin-top:10px;">
              <div class="table-header">🔌 عیب‌یابی وبهوک</div>
              <div class="table-content">
                <table>
                  <tbody>
                    <tr><td>توکن تلگرام</td><td>${(RUNTIME.tgToken || TELEGRAM_TOKEN) ? '✅ تنظیم شده' : '❌ تنظیم نشده'}</td></tr>
                    <tr><td>آدرس وبهوک مطلوب</td><td><code>${desiredWebhook || '-'}</code></td></tr>
                    <tr><td>آدرس وبهوک فعلی (تلگرام)</td><td><code>${(webhookInfo && webhookInfo.result && webhookInfo.result.url) || '-'}</code></td></tr>
                    <tr><td>آخرین خطای وبهوک</td><td>${(webhookInfo && webhookInfo.result && (webhookInfo.result.last_error_message || '-')) || '-'}</td></tr>
                    <tr><td>زمان آخرین خطا</td><td>${(webhookInfo && webhookInfo.result && webhookInfo.result.last_error_date) ? new Date(webhookInfo.result.last_error_date*1000).toLocaleString('fa-IR') : '-'}</td></tr>
                    <tr><td>آخرین Update دریافتی</td><td>${lastWebhookAt ? new Date(lastWebhookAt).toLocaleString('fa-IR') : '-'}</td></tr>
                    <tr><td>زمان ثبت وبهوک</td><td>${webhookSetAt ? new Date(webhookSetAt).toLocaleString('fa-IR') : '-'}</td></tr>
                    <tr><td>آخرین بررسی وبهوک</td><td>${webhookCheckedAt ? new Date(webhookCheckedAt).toLocaleString('fa-IR') : '-'}</td></tr>
                  </tbody>
                </table>
              </div>
            </div>
            <div style="display:flex; gap:12px; flex-wrap:wrap; margin-bottom:16px;">
              <a class="btn" href="/?key=${adminKey}&action=users">👥 فهرست کامل کاربران</a>
            </div>
            <div class="data-table" style="margin-top:10px;">
              <div class="table-header">⚙️ تنظیمات پایه</div>
              <div style="padding:16px;">
                <form method="GET" action="/">
                  <input type="hidden" name="key" value="${adminKey}" />
                  <input type="hidden" name="action" value="save-settings" />
                  <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap:12px;">
                    <label>هزینه DNS (الماس)
                      <input type="number" name="cost_dns" value="${settings ? settings.cost_dns : 1}" style="width:100%; padding:10px; border-radius:8px; border:1px solid rgba(255,255,255,.2); background:rgba(255,255,255,.08); color:white;" />
                    </label>
                    <label>هزینه WireGuard (الماس)
                      <input type="number" name="cost_wg" value="${settings ? settings.cost_wg : 2}" style="width:100%; padding:10px; border-radius:8px; border:1px solid rgba(255,255,255,.2); background:rgba(255,255,255,.08); color:white;" />
                    </label>
                    <label>هزینه OpenVPN (الماس)
                      <input type="number" name="cost_ovpn" value="${settings ? settings.cost_ovpn : 6}" style="width:100%; padding:10px; border-radius:8px; border:1px solid rgba(255,255,255,.2); background:rgba(255,255,255,.08); color:white;" />
                    </label>
                    <label>کانال اجباری (JOIN_CHAT)
                      <input type="text" name="join_chat" value="${RUNTIME.joinChat || ''}" placeholder="مثلا @mychannel" style="width:100%; padding:10px; border-radius:8px; border:1px solid rgba(255,255,255,.2); background:rgba(255,255,255,.08); color:white;" />
                    </label>
                  </div>
                  <div style="margin-top:12px;">
                    <button class="btn" type="submit">ذخیره تنظیمات</button>
                  </div>
                </form>
              </div>
            </div>
            <div style="display:flex; gap:12px; flex-wrap:wrap; margin-bottom:16px;">
              <a class="btn" href="https://t.me/${await getBotUsername(env) || ''}" target="_blank">باز کردن ربات در تلگرام</a>
              <a class="btn" href="/?key=${adminKey}&action=toggle">${enabled ? '⛔️ توقف سرویس' : '▶️ شروع سرویس'}</a>
            </div>
            <div class="data-table" style="margin-top:10px;">
              <div class="table-header">🔧 مدیریت کاربران (Block/آنبلاک)</div>
              <div class="table-content">
                <table>
                  <thead>
                    <tr>
                      <th>آی‌دی</th>
                      <th>یوزرنیم</th>
                     <th>الماس</th>
                      <th>وضعیت</th>
                      <th>اقدام</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${(await Promise.all(users.slice(0, 30).map(async uid => {
                      const u = await kvGetJson(env, `user:${uid}`) || {}; const blocked = await isUserBlocked(env, uid);
                      return `
                        <tr>
                          <td>${uid}</td>
                          <td>${escapeHtml(u.username || '-')}</td>
                          <td>${(u.diamonds||0).toLocaleString('fa-IR')}</td>
                          <td>${blocked ? '⛔️ مسدود' : '🟢 فعال'}</td>
                          <td>
                            ${blocked 
                              ? `<a class="btn btn-success" href="/?key=${adminKey}&op=unblock&uid=${uid}">آنبلاک</a>`
                              : `<a class="btn btn-danger" href="/?key=${adminKey}&op=block&uid=${uid}">Block</a>`}
                          </td>
                        </tr>
                      `;
                    }))).join('')}
                  </tbody>
                </table>
              </div>
            </div>
            <div class="data-table" style="margin-top:10px;">
              <div class="table-header">📢 ارسال اعلان به همه کاربران</div>
              <div style="padding:16px;">
                <form method="GET" action="/?">
                  <input type="hidden" name="key" value="${adminKey}" />
                  <input type="hidden" name="action" value="broadcast" />
                  <div style="display:flex; gap:8px;">
                    <input type="text" name="message" placeholder="متن پیام" style="flex:1; padding:12px; border-radius:10px; border:1px solid rgba(255,255,255,.2); background:rgba(255,255,255,.08); color:white;" />
                    <button class="btn" type="submit">ارسال</button>
                  </div>
                </form>
              </div>
            </div>

            <div class="data-table">
              <div class="table-header">💰 خریداران برتر (Top Purchasers)</div>
              <div class="table-content">
                <table>
                  <thead>
                    <tr>
                      <th>رتبه</th>
                      <th>آی‌دی کاربر</th>
                      <th>یوزرنیم</th>
                      <th>تعداد خرید تایید شده</th>
                      <th>کل الماس خریداری‌شده</th>
                      <th>مبلغ کل (تومان)</th>
                      <th>آخرین خرید</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${topPurchasers.map((it, i) => `
                      <tr>
                        <td>${i+1}</td>
                        <td><code>${it.user_id}</code></td>
                        <td>${escapeHtml(it.username || '-')}</td>
                        <td>${(it.count||0).toLocaleString('fa-IR')}</td>
                        <td>${(it.diamonds||0).toLocaleString('fa-IR')}</td>
                        <td>${(it.amount||0).toLocaleString('fa-IR')}</td>
                        <td>${it.last_at ? new Date(it.last_at).toLocaleString('fa-IR') : '-'}</td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            </div>

            <div class="data-table">
              <div class="table-header">🏷 معرفین برتر (Top Referrers)</div>
              <div class="table-content">
                <table>
                  <thead>
                    <tr>
                      <th>رتبه</th>
                      <th>آی‌دی کاربر</th>
                      <th>یوزرنیم</th>
                      <th>تعداد معرفی</th>
                      <th>الماس فعلی</th>
                      <th>تاریخ عضویت</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${topReferrers.map((it, i) => `
                      <tr>
                        <td>${i+1}</td>
                        <td><code>${it.id}</code></td>
                        <td>${escapeHtml(it.username || '-')}</td>
                        <td>${(it.referrals||0).toLocaleString('fa-IR')}</td>
                        <td>${(it.diamonds||0).toLocaleString('fa-IR')}</td>
                        <td>${it.created_at ? new Date(it.created_at).toLocaleDateString('fa-IR') : '-'}</td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            </div>

            <div class="data-table">
              <div class="table-header">📊 آمار کلی کاربران (Overall Statistics)</div>
              <div class="table-content">
                ${overallStats ? `
                <table>
                  <thead>
                    <tr>
                      <th>شاخص</th>
                      <th>مقدار</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr><td>کل کاربران</td><td>${overallStats.total_users.toLocaleString('fa-IR')}</td></tr>
                    <tr><td>کاربران مسدود</td><td>${overallStats.blocked_users.toLocaleString('fa-IR')}</td></tr>
                    <tr><td>فعال در ۷ روز اخیر</td><td>${overallStats.active_7d.toLocaleString('fa-IR')}</td></tr>
                    <tr><td>عضو شده در ۷ روز اخیر</td><td>${overallStats.joined_7d.toLocaleString('fa-IR')}</td></tr>
                    <tr><td>کل الماس کاربران</td><td>${overallStats.total_diamonds.toLocaleString('fa-IR')}</td></tr>
                    <tr><td>میانگین الماس به ازای هر کاربر</td><td>${overallStats.avg_diamonds.toLocaleString('fa-IR')}</td></tr>
                    <tr><td>کل معرفی‌ها</td><td>${overallStats.total_referrals.toLocaleString('fa-IR')}</td></tr>
                    <tr><td>تعداد خرید تایید شده</td><td>${overallStats.approved_purchases_count.toLocaleString('fa-IR')}</td></tr>
                    <tr><td>مبلغ خریدهای تایید شده (تومان)</td><td>${overallStats.approved_purchases_amount.toLocaleString('fa-IR')}</td></tr>
                  </tbody>
                </table>
                ` : ''}
              </div>
            </div>
        </div>

        <div class="data-table">
            <div class="table-header">📂 فایل‌های اخیر (${Math.min(files.length, 50)} از ${fileCount})</div>
            <div class="table-content">
                <table>
                    <thead>
                        <tr>
                            <th>نام فایل</th>
                            <th>مالک</th>
                            <th>حجم</th>
                            <th>دانلود</th>
                            <th>هزینه</th>
                            <th>تاریخ ایجاد</th>
                            <th>وضعیت</th>
                            <th>توکن</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${files.slice(0, 50).sort((a, b) => (b.created_at || 0) - (a.created_at || 0)).map(f => `
                        <tr>
                            <td class="file-name" title="${escapeHtml(f.name || 'file')}">${escapeHtml(f.name || 'file')}</td>
                            <td>${f.owner}</td>
                            <td>${formatFileSize(f.size || 0)}</td>
                            <td>${(f.downloads || 0).toLocaleString('fa-IR')}</td>
                            <td>${(f.cost_points || 0).toLocaleString('fa-IR')}</td>
                            <td>${formatDate(f.created_at || 0)}</td>
                            <td>
                                <span class="status-badge ${f.disabled ? 'status-disabled' : 'status-active'}">
                                    ${f.disabled ? '🔴 غیرفعال' : '🟢 فعال'}
                                </span>
                            </td>
                            <td><code style="font-size: 0.8rem; opacity: 0.7;">${f.token}</code></td>
                        </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        </div>

        <div class="data-table">
            <div class="table-header">👥 کاربران اخیر (${Math.min(users.length, 30)} از ${userCount})</div>
            <div class="table-content">
                <table>
                    <thead>
                        <tr>
                            <th>آی‌دی</th>
                            <th>نام</th>
                            <th>یوزرنیم</th>
                           <th>الماس</th>
                            <th>معرفی‌ها</th>
                            <th>آخرین فعالیت</th>
                            <th>تاریخ عضویت</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${(await Promise.all(users.slice(0, 30).map(async uid => {
                            const user = await kvGetJson(env, `user:${uid}`) || {};
                            return `
                            <tr>
                                <td>${uid}</td>
                                <td>${escapeHtml(user.first_name || '-')}</td>
                                <td>${escapeHtml(user.username || '-')}</td>
                                <td>${(user.diamonds || 0).toLocaleString('fa-IR')}</td>
                                <td>${(user.referrals || 0).toLocaleString('fa-IR')}</td>
                                <td>${user.last_seen ? formatDate(user.last_seen) : '-'}</td>
                                <td>${formatDate(user.created_at || 0)}</td>
                            </tr>
                            `;
                        }))).join('')}
                    </tbody>
                </table>
            </div>
        </div>
        `}

        <div style="text-align: center; margin-top: 40px; opacity: 0.7;">
            <p>🤖 Telegram WireGuard Bot - نسخه پیشرفته</p>
            <p>ساخته شده با ❤️ برای مدیریت بهتر فایل‌ها</p>
        </div>
    </div>

    <script>
        // Auto refresh every 30 seconds for admin panel
        ${isAuthenticated ? `
        let refreshInterval;
        function startAutoRefresh() {
            refreshInterval = setInterval(() => {
                window.location.reload();
            }, 30000);
        }
        
        // Stop refresh when page is not visible
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                clearInterval(refreshInterval);
            } else {
                startAutoRefresh();
            }
        });
        
        startAutoRefresh();
        ` : ''}

        // Add loading animation to buttons
        document.querySelectorAll('.btn').forEach(btn => {
            btn.addEventListener('click', function() {
                if (this.type !== 'submit') return;
                this.style.opacity = '0.7';
                this.innerHTML = 'در حال پردازش...';
            });
        });

        // Add smooth scroll animation
        document.documentElement.style.scrollBehavior = 'smooth';
    </script>
</body>
</html>`;

  return new Response(html, { 
    headers: { 
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    } 
  });
}

/* -------------------- Public Mini App: Top Referrers -------------------- */
async function handleMiniApp(env) {
  // Gather top 5 referrers by referrals; show names/usernames only (no numeric ids)
  const users = (await kvGetJson(env, 'index:users')) || [];
  const list = [];
  for (const uid of users) {
    const u = (await kvGetJson(env, `user:${uid}`)) || {};
    list.push({
      id: uid,
      first_name: u.first_name || '',
      username: u.username || '',
      referrals: Number(u.referrals || 0)
    });
  }
  const top = list
    .sort((a, b) => (b.referrals || 0) - (a.referrals || 0))
    .slice(0, 5)
    .map(u => ({
      name: (u.first_name || u.username || '').trim() || 'کاربر',
      referrals: u.referrals || 0
    }));

  const html = `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Top Referrers</title>
  <style>
    :root {
      --bg: #000000;
      --bg-soft: #111111;
      --fg: #ffffff;
      --muted: #cccccc;
      --card: #1a1a1a;
      --border: #333333;
      --accent: #007AFF;
      --accent2: #0051D5;

      color-scheme: dark;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Arial, "Apple Color Emoji", "Segoe UI Emoji";
      background: linear-gradient(135deg, var(--bg), var(--bg-soft));
      color: var(--fg);
      min-height: 100vh;
      display: grid; place-items: center;
    }
    .wrap {
      width: 100%; max-width: 720px; padding: 24px;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
      backdrop-filter: blur(8px);
      box-shadow: 0 10px 30px rgba(0,0,0,.25);
      overflow: hidden;
    }
    .head {
      padding: 20px 24px; border-bottom: 1px solid var(--border);
      display: flex; align-items: center; justify-content: space-between;
    }
    .title { font-weight: 700; letter-spacing: .3px; }
    .badge { font-size: .85rem; color: var(--muted); }
    .list { padding: 8px 0; }
    .row { display:flex; align-items:center; gap:12px; padding: 14px 20px; border-bottom: 1px solid var(--border); }
    .row:last-child { border-bottom: none; }
    .index { width: 36px; height: 36px; border-radius: 10px; display:grid; place-items:center; color:#fff; font-weight:700; background: linear-gradient(135deg, var(--accent), var(--accent2)); }
    .name { font-weight:600; }
    .subs { margin-inline-start: auto; color: var(--muted); font-size: .95rem; }
    .foot { padding: 16px 20px; color: var(--muted); font-size: .9rem; }
  </style>
  <meta name="color-scheme" content=" dark" />
  <meta name="theme-color" content="#0f172a" media="(prefers-color-scheme: dark)" />
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="head">
        <div class="title">🏷 نفرات برتر زیرمجموعه گیری تا این لحظه </div>
        <div class="badge">Top Referrers</div>
      </div>
      <div class="list">
        ${top.map((u, i) => `
          <div class="row">
            <div class="index">${i+1}</div>
            <div class="name">${escapeHtml(u.name)}</div>
            <div class="subs">${(u.referrals||0).toLocaleString('fa-IR')} معرفی</div>
          </div>
        `).join('') || '<div class="row"><div class="name">— داده‌ای یافت نشد —</div></div>'}
      </div>
    </div>
  </div>
</body>
</html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' } });
}

/* -------------------- API handlers for admin operations -------------------- */
async function handleApiRequest(req, env, url, ctx) {
  const key = url.searchParams.get('key');
  const adminKey = RUNTIME.adminKey || ADMIN_KEY;
  if (!key || key !== adminKey) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { 
      status: 401, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }

  const path = url.pathname.replace('/api/', '');
  
  if (path === 'toggle-service' && req.method === 'POST') {
    const current = (await kvGetJson(env, 'bot:enabled')) ?? true;
    await kvPutJson(env, 'bot:enabled', !current);
    return new Response(JSON.stringify({ enabled: !current }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (path === 'stats') {
    const users = (await kvGetJson(env, 'index:users')) || [];
    const userCount = users.length;
    
    let files = [];
    let totalDownloads = 0;
    
    for (const uid of users.slice(0, 100)) {
      const list = (await kvGetJson(env, `uploader:${uid}`)) || [];
      for (const t of list) {
        const f = await kvGetJson(env, `file:${t}`);
        if (f) {
          files.push(f);
          totalDownloads += f.downloads || 0;
        }
      }
    }
    
    return new Response(JSON.stringify({
      users: userCount,
      files: files.length,
      downloads: totalDownloads,
      enabled: (await kvGetJson(env, 'bot:enabled')) ?? true
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (path === 'backup' && req.method === 'GET') {
    const backup = await createKvBackup(env);
    return new Response(JSON.stringify(backup), { headers: { 'Content-Type': 'application/json' } });
  }

  // Block/unblock via API
  if (path === 'block' && req.method === 'POST') {
    const { uid } = await req.json().catch(() => ({ uid: null }));
    if (!Number.isFinite(Number(uid))) return new Response(JSON.stringify({ ok: false, error: 'bad uid' }), { headers: { 'Content-Type': 'application/json' }, status: 400 });
    await blockUser(env, Number(uid));
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  }
  if (path === 'unblock' && req.method === 'POST') {
    const { uid } = await req.json().catch(() => ({ uid: null }));
    if (!Number.isFinite(Number(uid))) return new Response(JSON.stringify({ ok: false, error: 'bad uid' }), { headers: { 'Content-Type': 'application/json' }, status: 400 });
    await unblockUser(env, Number(uid));
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({ error: 'Not Found' }), { 
    status: 404, 
    headers: { 'Content-Type': 'application/json' } 
  });
}

/* -------------------- Admin utilities -------------------- */
async function createKvBackup(env) {
  const users = (await kvGetJson(env, 'index:users')) || [];
  const admins = await getAdminIds(env);
  const botSettings = await getSettings(env);
  const missionsIndex = (await kvGetJson(env, 'missions:index')) || [];
  const giftsIndex = (await kvGetJson(env, 'gift:index')) || [];
  const lotteryCfg = await getLotteryConfig(env);
  const ticketsIdx = (await kvGetJson(env, await ticketsIndexKey())) || [];
  const data = {
    meta: { created_at: now() },
    admins,
    settings: botSettings,
    users: [],
    files: [],
    missions: [],
    gifts: [],
    lottery: lotteryCfg,
    tickets: []
  };
  for (const uid of users) {
    const user = (await kvGetJson(env, `user:${uid}`)) || { id: uid };
    data.users.push(user);
    const list = (await kvGetJson(env, `uploader:${uid}`)) || [];
    for (const t of list) {
      const f = await kvGetJson(env, `file:${t}`);
      if (f) data.files.push(f);
    }
  }
  for (const mid of missionsIndex) {
    const m = await kvGetJson(env, `mission:${mid}`);
    if (m) data.missions.push(m);
  }
  for (const code of giftsIndex) {
    const g = await kvGetJson(env, `gift:${code}`);
    if (g) data.gifts.push(g);
  }
  for (const tid of ticketsIdx) {
    const t = await getTicket(env, tid);
    const msgs = await getTicketMessages(env, tid, 200);
    if (t) data.tickets.push({ ...t, messages: msgs });
  }
  return data;
}
function isAdmin(uid) { 
  const id = Number(uid);
  if (DYNAMIC_ADMIN_IDS && DYNAMIC_ADMIN_IDS.length) return DYNAMIC_ADMIN_IDS.includes(id);
  if (RUNTIME.adminIds && RUNTIME.adminIds.length) return RUNTIME.adminIds.includes(id);
  return (Array.isArray(ADMIN_IDS) ? ADMIN_IDS : []).includes(id);
}

async function isUserBlocked(env, uid) {
  const v = await kvGetJson(env, `block:${uid}`);
  return !!(v && v.blocked);
}
async function blockUser(env, uid) {
  return kvPutJson(env, `block:${uid}`, { blocked: true, at: now() });
}
async function unblockUser(env, uid) {
  return kvPutJson(env, `block:${uid}`, { blocked: false, at: now() });
}

async function broadcast(env, message) {
  const users = (await kvGetJson(env, 'index:users')) || [];
  let successful = 0;
  let failed = 0;
  
  for (const u of users) {
    try { 
      await tgApi('sendMessage', { chat_id: u, text: message }); 
      successful++;
      // Add small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 50));
    } catch (e) { 
      failed++;
    }
  }
  
  return { successful, failed };
}

function escapeHtml(s) { 
  if (!s) return ''; 
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* -------------------- Tickets storage & helpers -------------------- */
async function ticketsIndexKey() { return 'tickets:index'; }
function newTicketId() {
  // Simple, readable ticket id: one letter + digits, e.g., p123456789
  const prefix = 'p';
  const digits = String(Math.floor(100000000 + Math.random() * 900000000)); // 9 digits
  return `${prefix}${digits}`;
}
async function listTickets(env, { limit = 20 } = {}) {
  const idx = (await kvGetJson(env, await ticketsIndexKey())) || [];
  const res = [];
  for (const id of idx.slice(0, limit)) {
    const t = await kvGetJson(env, `ticket:${id}`);
    if (t) res.push(t);
  }
  return res;
}
async function listUserTickets(env, uid, { limit = 20 } = {}) {
  const idx = (await kvGetJson(env, `tickets:user:${uid}`)) || [];
  const res = [];
  for (const id of idx.slice(0, limit)) {
    const t = await kvGetJson(env, `ticket:${id}`);
    if (t) res.push(t);
  }
  return res;
}
async function getTicket(env, id) { return await kvGetJson(env, `ticket:${id}`); }
async function putTicket(env, meta) {
  const next = { ...meta, updated_at: now() };
  return await kvPutJson(env, `ticket:${meta.id}`, next);
}
async function deleteTicket(env, id) {
  const t = await getTicket(env, id);
  await kvDelete(env, `ticket:${id}`);
  await kvDelete(env, `ticket:${id}:messages`);
  // remove from indexes
  const idx = (await kvGetJson(env, await ticketsIndexKey())) || [];
  await kvPutJson(env, await ticketsIndexKey(), idx.filter(x => x !== id));
  if (t) {
    const uidx = (await kvGetJson(env, `tickets:user:${t.user_id}`)) || [];
    await kvPutJson(env, `tickets:user:${t.user_id}`, uidx.filter(x => x !== id));
  }
}
async function getTicketMessages(env, id, limit = 50) {
  const list = (await kvGetJson(env, `ticket:${id}:messages`)) || [];
  return list.slice(-limit);
}
async function appendTicketMessage(env, id, message) {
  const list = (await kvGetJson(env, `ticket:${id}:messages`)) || [];
  list.push({ ...message });
  await kvPutJson(env, `ticket:${id}:messages`, list.slice(-200)); // keep last 200 messages
  // also update ticket meta timestamps and last message info
  const meta = await getTicket(env, id);
  if (meta) {
    meta.updated_at = now();
    meta.last_message_from = message.from;
    await kvPutJson(env, `ticket:${id}`, meta);
  }
}
async function createTicket(env, { user_id, username, category, subject, desc }) {
  const id = newTicketId();
  const meta = { id, user_id, username: username || null, category: category || '-', subject: subject || '-', desc: desc || '', status: 'open', created_at: now(), updated_at: now() };
  // indexes
  const idx = (await kvGetJson(env, await ticketsIndexKey())) || [];
  idx.unshift(id);
  await kvPutJson(env, await ticketsIndexKey(), idx);
  const uidx = (await kvGetJson(env, `tickets:user:${user_id}`)) || [];
  uidx.unshift(id);
  await kvPutJson(env, `tickets:user:${user_id}`, uidx);
  await kvPutJson(env, `ticket:${id}`, meta);
  await appendTicketMessage(env, id, { from: 'user', by: user_id, at: now(), text: desc });
  return meta;
}

/* -------------------- In-bot download helper -------------------- */
async function handleBotDownload(env, uid, chatId, token, ref) {
  if (!isValidTokenFormat(token)) { await tgApi('sendMessage', { chat_id: chatId, text: 'توکن نامعتبر' }); return; }
  const file = await kvGetJson(env, `file:${token}`);
  if (!file) { await tgApi('sendMessage', { chat_id: chatId, text: 'فایل یافت نشد' }); return; }

  // service and disabled checks
  const enabled = (await kvGetJson(env, 'bot:enabled')) ?? true;
  const updateMode = (await kvGetJson(env, 'bot:update_mode')) || false;
  if (!enabled) { await tgApi('sendMessage', { chat_id: chatId, text: 'سرویس موقتا غیرفعال است' }); return; }
  if (updateMode && !isAdmin(uid)) { await tgApi('sendMessage', { chat_id: chatId, text: '🔧 ربات در حال بروزرسانی است. لطفاً دقایقی دیگر مجدداً تلاش کنید.' }); return; }
  if (file.disabled) { await tgApi('sendMessage', { chat_id: chatId, text: 'فایل توسط مالک/ادمین غیرفعال شده است' }); return; }

  // per-file download limit enforcement
  if ((file.max_downloads || 0) > 0 && (file.downloads || 0) >= file.max_downloads) {
    await tgApi('sendMessage', { chat_id: chatId, text: '⛔️ ظرفیت دانلود این فایل به پایان رسیده است.' });
    // delete if flagged
    if (file.delete_on_limit) {
      try {
        const upKey = `uploader:${file.owner}`;
        const upList = (await kvGetJson(env, upKey)) || [];
        await kvPutJson(env, upKey, upList.filter(t => t !== token));
        await kvDelete(env, `file:${token}`);
      } catch (_) {}
    }
    return;
  }

  // enforce required channel membership for non-admins
  const req = await getRequiredChannels(env);
  if (req.length && !(await isUserJoinedAllRequiredChannels(env, uid))) {
    // Persist pending download (token/ref) so we can continue after user joins
    try {
      const s = await getSession(env, uid);
      const next = { ...(s || {}) };
      next.pending_download = { token, ref: ref || '' };
      if (ref) next.pending_ref = ref;
      await setSession(env, uid, next);
    } catch (_) {}
    await presentJoinPrompt(env, chatId);
    return;
  }

  // cost handling
  if ((file.cost_points || 0) > 0) {
    // daily limit enforcement (if set)
    const settings = await getSettings(env);
    const limit = settings.daily_limit || 0;
    if (limit > 0 && !isAdmin(uid)) {
      const dk = `usage:${uid}:${dayKey()}`;
      const used = (await kvGetJson(env, dk)) || { count: 0 };
      if ((used.count || 0) >= limit) {
        await tgApi('sendMessage', { chat_id: chatId, text: `به سقف روزانه استفاده (${limit}) رسیده‌اید.` });
        return;
      }
    }
  const user = (await kvGetJson(env, `user:${uid}`)) || { diamonds: 0 };
  const needed = file.cost_points || 0;
  if ((user.diamonds || 0) < needed) {
  const botUsername = await getBotUsername(env);
  const refLink = botUsername ? `https://t.me/${botUsername}?start=${uid}` : '';
    await tgApi('sendMessage', { chat_id: chatId, text: `⚠️ الماس کافی ندارید. نیاز: ${needed} | الماس شما: ${user.diamonds||0}${refLink ? `\nبرای کسب الماس لینک معرفی شما:\n${refLink}` : ''}` });
      return;
    }
    const ok = await checkRateLimit(env, uid, 'confirm_spend', 3, 60_000);
    if (!ok) { await tgApi('sendMessage', { chat_id: chatId, text: 'تعداد درخواست بیش از حد. لطفاً بعداً تلاش کنید.' }); return; }
    await setSession(env, uid, { awaiting: `confirm_spend:${token}:${needed}:${ref||''}` });
  await tgApi('sendMessage', { chat_id: chatId, text: `این فایل ${needed} الماس هزینه دارد. مایل به پرداخت هستید؟`, reply_markup: { inline_keyboard: [
      [{ text: '✅ بله، پرداخت و دریافت', callback_data: `CONFIRM_SPEND:${token}:${needed}:${ref||''}` }],
      [{ text: '❌ خیر، بازگشت به منو', callback_data: 'MENU' }]
    ] } });
    return;
  }

  // referral credit
  if (ref && String(ref) !== String(file.owner)) {
    const currentUser = (await kvGetJson(env, `user:${uid}`)) || { id: uid };
    if (!currentUser.ref_credited) {
      const refUser = (await kvGetJson(env, `user:${ref}`)) || null;
      if (refUser) {
        refUser.diamonds = (refUser.diamonds || 0) + 1;
        refUser.referrals = (refUser.referrals || 0) + 1;
        await kvPutJson(env, `user:${ref}`, refUser);
        currentUser.ref_credited = true;
        currentUser.referred_by = currentUser.referred_by || Number(ref);
        await kvPutJson(env, `user:${uid}`, currentUser);
         await tgApi('sendMessage', { chat_id: Number(ref), text: '🎉 یک الماس بابت معرفی دریافت کردید.' });
      }
    }
  }

  // deliver based on type
  await deliverStoredContent(chatId, file);

  // stats + usage increment
  file.downloads = (file.downloads || 0) + 1; file.last_download = now();
  try { await addFileTaker(env, token, uid); } catch (_) {}
  await kvPutJson(env, `file:${token}`, file);

  // if reached limit after increment, optionally delete
  if ((file.max_downloads || 0) > 0 && (file.downloads || 0) >= file.max_downloads && file.delete_on_limit) {
    try {
      const upKey = `uploader:${file.owner}`;
      const upList = (await kvGetJson(env, upKey)) || [];
      await kvPutJson(env, upKey, upList.filter(t => t !== token));
      await kvDelete(env, `file:${token}`);
    } catch (_) {}
  }
  // increase usage counter if daily limit is set
  const settings = await getSettings(env);
  if ((settings.daily_limit || 0) > 0 && !isAdmin(uid)) {
    const dk = `usage:${uid}:${dayKey()}`;
    const used = (await kvGetJson(env, dk)) || { count: 0 };
    used.count = (used.count || 0) + 1;
    await kvPutJson(env, dk, used);
  }
}

/* -------------------- Missions: storage, view, progress -------------------- */
async function listMissions(env) {
  const idx = (await kvGetJson(env, 'missions:index')) || [];
  const res = [];
  for (const id of idx) {
    const m = await kvGetJson(env, `mission:${id}`);
    if (m) res.push(m);
  }
  return res;
}
async function createMission(env, { title, reward, period, type = 'generic', config = {} }) {
  const id = `m_${makeToken(8)}`;
  const m = { id, title, reward: Number(reward)||0, period: period||'once', created_at: now(), enabled: true, type, config };
  const idx = (await kvGetJson(env, 'missions:index')) || [];
  idx.unshift(id);
  await kvPutJson(env, 'missions:index', idx);
  await kvPutJson(env, `mission:${id}`, m);
  return { ok: true, id };
}
async function deleteMission(env, id) {
  const idx = (await kvGetJson(env, 'missions:index')) || [];
  const next = idx.filter(x => x !== id);
  await kvPutJson(env, 'missions:index', next);
  await kvDelete(env, `mission:${id}`);
}
async function getUserMissionProgress(env, uid) {
  const key = `missionprog:${uid}`;
  return (await kvGetJson(env, key)) || { completed: 0, map: {} };
}
async function setUserMissionProgress(env, uid, prog) {
  await kvPutJson(env, `missionprog:${uid}`, prog || { completed: 0, map: {} });
}
async function completeMissionIfEligible(env, uid, mission) {
  const prog = await getUserMissionProgress(env, uid);
  const map = prog.map || {};
  const markKey = mission.period === 'once' ? 'once' : mission.period === 'daily' ? dayKey() : weekKey();
  const doneKey = `${mission.id}:${markKey}`;
  if (map[doneKey]) return false;
  // mark completed
  map[doneKey] = now();
  prog.map = map;
  prog.completed = (prog.completed || 0) + 1;
  await setUserMissionProgress(env, uid, prog);
  // reward diamonds
  const uKey = `user:${uid}`;
  const user = (await kvGetJson(env, uKey)) || { id: uid, diamonds: 0 };
  user.diamonds = (user.diamonds || 0) + (mission.reward || 0);
  await kvPutJson(env, uKey, user);
  // track weekly earned points for stats
  const wk = weekKey();
  const psKey = `points_week:${uid}:${wk}`;
  const ps = (await kvGetJson(env, psKey)) || { points: 0 };
  ps.points = (ps.points || 0) + (mission.reward || 0);
  await kvPutJson(env, psKey, ps);
  return true;
}
async function buildMissionsView(env, uid) {
  const missions = await listMissions(env);
  const prog = await getUserMissionProgress(env, uid);
  const nowWeek = weekKey();
  const list = missions.map(m => {
    const markKey = m.period === 'weekly' ? `${m.id}:${nowWeek}` : m.period === 'daily' ? `${m.id}:${dayKey()}` : `${m.id}:once`;
    const done = Boolean((prog.map||{})[markKey]);
    const periodLabel = m.period === 'weekly' ? 'هفتگی' : (m.period === 'daily' ? 'روزانه' : 'یکبار');
    const typeLabel = m.type === 'quiz' ? 'کوییز' : (m.type === 'question' ? 'مسابقه' : (m.type === 'invite' ? 'دعوت' : 'عمومی'));
    return `${done ? '✅' : '⬜️'} ${m.title} (${periodLabel} | ${typeLabel}) +${m.reward} الماس`;
  }).join('\n');
  const actions = [];
  actions.push([{ text: '✅ دریافت پاداش هفتگی (هر ۷ روز)', callback_data: 'WEEKLY_CHECKIN' }]);
  // dynamic actions for special weekly missions
  const quiz = missions.find(m => m.enabled && m.period === 'weekly' && m.type === 'quiz');
  const question = missions.find(m => m.enabled && m.period === 'weekly' && m.type === 'question');
  if (quiz) actions.push([{ text: '🎮 شرکت در کوییز هفتگی', callback_data: `MIS:QUIZ:${quiz.id}` }]);
  if (question) actions.push([{ text: '❓ پاسخ سوال هفتگی', callback_data: `MIS:Q:${question.id}` }]);
  actions.push([{ text: '🏠 منو', callback_data: 'MENU' }]);
  return { text: `📆 مأموریت‌ها:\n${list}\n\nبا انجام فعالیت‌ها و چک‌این هفتگی الماس بگیرید.`, reply_markup: { inline_keyboard: actions } };
}

/* -------------------- Lottery helpers -------------------- */
async function getLotteryConfig(env) {
  return (await kvGetJson(env, 'lottery:cfg')) || { enabled: false, winners: 0, reward_diamonds: 0, run_every_hours: 0, next_run_at: 0 };
}
async function setLotteryConfig(env, cfg) { await kvPutJson(env, 'lottery:cfg', cfg || {}); }
async function lotteryAutoEnroll(env, uid) {
  const cfg = await getLotteryConfig(env);
  if (!cfg.enabled) return;
  const key = `lottery:pool:${dayKey()}`; // daily pool
  const pool = (await kvGetJson(env, key)) || [];
  if (!pool.includes(uid)) { pool.push(uid); await kvPutJson(env, key, pool); }
  // auto draw if threshold? We draw end-of-day; here we do nothing further
}
async function isUserEnrolledToday(env, uid) {
  const key = `lottery:pool:${dayKey()}`;
  const pool = (await kvGetJson(env, key)) || [];
  return pool.includes(uid);
}
async function userEnrollToday(env, uid) {
  const key = `lottery:pool:${dayKey()}`;
  const pool = (await kvGetJson(env, key)) || [];
  if (pool.includes(uid)) return false;
  pool.push(uid);
  await kvPutJson(env, key, pool);
  return true;
}
async function runLotteryPickAndReward(env, dateKey) {
  const cfg = await getLotteryConfig(env);
  if (!cfg.enabled || !(cfg.winners > 0) || !(cfg.reward_diamonds > 0)) return { ok: false };
  const key = `lottery:pool:${dateKey}`;
  const pool = (await kvGetJson(env, key)) || [];
  if (!pool.length) return { ok: false };
  const shuffled = pool.slice().sort(() => Math.random() - 0.5);
  const winners = shuffled.slice(0, Math.min(cfg.winners, shuffled.length));
  for (const w of winners) {
    const uKey = `user:${w}`;
    const u = (await kvGetJson(env, uKey)) || { id: w, diamonds: 0 };
    u.diamonds = (u.diamonds || 0) + cfg.reward_diamonds;
    await kvPutJson(env, uKey, u);
  }
  const hist = (await kvGetJson(env, 'lottery:hist')) || [];
  hist.unshift({ at: now(), dateKey, winners, reward_diamonds: cfg.reward_diamonds });
  await kvPutJson(env, 'lottery:hist', hist.slice(0, 100));
  return { ok: true, winners };
}
async function getLotteryHistory(env, limit = 20) {
  const hist = (await kvGetJson(env, 'lottery:hist')) || [];
  return hist.slice(0, limit);
}

/* -------------------- Aggregates for Admin Insights -------------------- */
async function computeTopPurchasers(env, limit = 5) {
  try {
    const idx = (await kvGetJson(env, 'index:purchases')) || [];
    const map = new Map();
    for (const id of idx) {
      const p = await kvGetJson(env, `purchase:${id}`);
      if (!p || p.status !== 'approved') continue;
      const key = String(p.user_id);
      const acc = map.get(key) || { user_id: p.user_id, count: 0, diamonds: 0, amount: 0, last_at: 0 };
      acc.count += 1;
      acc.diamonds += Number(p.diamonds || 0);
      acc.amount += Number(p.price_toman || 0);
      acc.last_at = Math.max(acc.last_at || 0, Number(p.processed_at || p.updated_at || p.created_at || 0));
      map.set(key, acc);
    }
    const all = Array.from(map.values());
    // Enrich with username
    for (const it of all) {
      const u = (await kvGetJson(env, `user:${it.user_id}`)) || {};
      it.username = u.username || '';
    }
    return all.sort((a, b) => (b.amount || 0) - (a.amount || 0)).slice(0, limit);
  } catch (_) {
    return [];
  }
}

async function computeTopReferrers(env, limit = 5) {
  try {
    const users = (await kvGetJson(env, 'index:users')) || [];
    const list = [];
    for (const uid of users) {
      const u = (await kvGetJson(env, `user:${uid}`)) || { id: uid };
      list.push({ id: uid, username: u.username || '', referrals: Number(u.referrals || 0), diamonds: Number(u.diamonds || 0), created_at: Number(u.created_at || 0) });
    }
    return list.sort((a, b) => (b.referrals || 0) - (a.referrals || 0)).slice(0, limit);
  } catch (_) {
    return [];
  }
}

async function computeOverallStats(env) {
  try {
    const users = (await kvGetJson(env, 'index:users')) || [];
    const nowTs = now();
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    let blocked = 0, active7 = 0, joined7 = 0, totalDiamonds = 0, totalReferrals = 0;
    for (const uid of users) {
      const u = (await kvGetJson(env, `user:${uid}`)) || {};
      const isBlocked = await isUserBlocked(env, uid);
      if (isBlocked) blocked++;
      if (u.last_seen && (nowTs - Number(u.last_seen)) <= weekMs) active7++;
      if (u.created_at && (nowTs - Number(u.created_at)) <= weekMs) joined7++;
      totalDiamonds += Number(u.diamonds || 0);
      totalReferrals += Number(u.referrals || 0);
    }
    // purchases aggregates
    const idx = (await kvGetJson(env, 'index:purchases')) || [];
    let apprCount = 0, apprAmount = 0;
    for (const id of idx) {
      const p = await kvGetJson(env, `purchase:${id}`);
      if (p && p.status === 'approved') {
        apprCount++;
        apprAmount += Number(p.price_toman || 0);
      }
    }
    const totalUsers = users.length;
    const avgDiamonds = totalUsers ? (totalDiamonds / totalUsers) : 0;
    return {
      total_users: totalUsers,
      blocked_users: blocked,
      active_7d: active7,
      joined_7d: joined7,
      total_diamonds: Math.round(totalDiamonds),
      avg_diamonds: Math.round(avgDiamonds),
      total_referrals: Math.round(totalReferrals),
      approved_purchases_count: apprCount,
      approved_purchases_amount: Math.round(apprAmount)
    };
  } catch (_) {
    return null;
  }
}
/* -------------------- Daily tasks (cron) -------------------- */
async function runDailyTasks(env) {
  try {
    // 1) Automatic KV backup to main admin
    const adminIds = await getAdminIds(env);
    const mainAdmin = adminIds && adminIds.length ? adminIds[0] : null;
    if (mainAdmin) {
      const backup = await createKvBackup(env);
      const content = JSON.stringify(backup, null, 2);
      const filename = `backup_${new Date().toISOString().slice(0,10)}.json`;
      const form = new FormData();
      form.append('chat_id', String(mainAdmin));
      form.append('caption', filename);
      form.append('document', new Blob([content], { type: 'application/json' }), filename);
      await tgUpload('sendDocument', form);
    }
  } catch (_) {}

  try {
    // 2) Lottery: pick and reward winners for yesterday's pool (end-of-day draw)
    const nowTs = now();
    const yesterday = new Date(nowTs - 24*60*60*1000);
    const yKey = dayKey(yesterday.getTime());
    await runLotteryPickAndReward(env, yKey);
  } catch (_) {}
}

/* -------------------- Gift codes -------------------- */
async function giftCodeKey(code) { return `gift:${String(code).trim().toUpperCase()}`; }
async function createGiftCode(env, { code, amount, max_uses }) {
  if (!code || !Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'پارامتر نامعتبر' };
  const key = await giftCodeKey(code);
  const exists = await kvGetJson(env, key);
  if (exists) return { ok: false, error: 'کد تکراری است' };
  const meta = { code: String(code).trim().toUpperCase(), amount: Number(amount), max_uses: Number(max_uses)||0, used: 0, disabled: false, created_at: now() };
  await kvPutJson(env, key, meta);
  return { ok: true };
}
async function listGiftCodes(env, limit = 50) {
  // KV list not available; we keep an index
  const idx = (await kvGetJson(env, 'gift:index')) || [];
  const codes = [];
  for (const c of idx.slice(0, limit)) {
    const g = await kvGetJson(env, `gift:${c}`);
    if (g) codes.push(g);
  }
  return codes;
}
async function addGiftToIndex(env, code) {
  const idx = (await kvGetJson(env, 'gift:index')) || [];
  const c = String(code).trim().toUpperCase();
  if (!idx.includes(c)) { idx.unshift(c); await kvPutJson(env, 'gift:index', idx); }
}
async function redeemGiftCode(env, uid, code) {
  const key = await giftCodeKey(code);
  const meta = await kvGetJson(env, key);
  if (!meta) return { ok: false, message: 'کد نامعتبر است.' };
  if (meta.disabled) return { ok: false, message: 'این کد غیرفعال است.' };
  if (meta.max_uses && (meta.used || 0) >= meta.max_uses) return { ok: false, message: 'ظرفیت این کد تکمیل شده است.' };
  const usedKey = `giftused:${meta.code}:${uid}`;
  const already = await kvGetJson(env, usedKey);
  if (already) return { ok: false, message: 'شما قبلا از این کد استفاده کرده‌اید.' };
  // credit diamonds
  const user = (await kvGetJson(env, `user:${uid}`)) || { id: uid, diamonds: 0 };
  user.diamonds = (user.diamonds || 0) + (meta.amount || 0);
  await kvPutJson(env, `user:${uid}`, user);
  // mark used
  await kvPutJson(env, usedKey, { used_at: now() });
  meta.used = (meta.used || 0) + 1;
  await kvPutJson(env, key, meta);
  return { ok: true, message: `🎁 ${meta.amount} الماس به حساب شما اضافه شد.` };
}

/* -------------------- Panel items (Buy Panel) -------------------- */
async function panelItemsIndexKey() { return 'panel:items:index'; }
async function listPanelItems(env, limit = 50) {
  const idx = (await kvGetJson(env, await panelItemsIndexKey())) || [];
  const res = [];
  for (const id of idx.slice(0, limit)) {
    const it = await kvGetJson(env, `pitem:${id}`);
    if (it) res.push(it);
  }
  return res;
}
async function getPanelItem(env, id) { return await kvGetJson(env, `pitem:${id}`); }
async function createPanelItem(env, { title, desc, photo_file_id, price_toman }) {
  try {
    if (!title || !photo_file_id) return { ok: false, error: 'bad_params' };
    const id = `pi_${makeToken(6)}`;
    const meta = {
      id,
      title: String(title).slice(0, 80),
      desc: String(desc || '').slice(0, 2048),
      photo_file_id: String(photo_file_id),
      price_toman: Number(price_toman || 0),
      created_at: now()
    };
    const idx = (await kvGetJson(env, await panelItemsIndexKey())) || [];
    idx.unshift(id);
    await kvPutJson(env, await panelItemsIndexKey(), idx);
    await kvPutJson(env, `pitem:${id}`, meta);
    return { ok: true, id };
  } catch (_) {
    return { ok: false, error: 'exception' };
  }
}
async function deletePanelItem(env, id) {
  try {
    const idx = (await kvGetJson(env, await panelItemsIndexKey())) || [];
    const next = idx.filter(x => x !== id);
    await kvPutJson(env, await panelItemsIndexKey(), next);
    await kvDelete(env, `pitem:${id}`);
    return { ok: true };
  } catch (_) { return { ok: false }; }
}

/* -------------------- Join/Admins management (KV backed) -------------------- */
async function getAdminIds(env) {
  const list = (await kvGetJson(env, 'bot:admins')) || null;
  if (Array.isArray(list) && list.length) return list.map(Number);
  return ADMIN_IDS.map(Number);
}
async function setAdminIds(env, list) {
  await kvPutJson(env, 'bot:admins', list.map(Number));
}
async function getRequiredChannels(env) {
  const list = (await kvGetJson(env, 'bot:join_channels')) || [];
  const defaultJoin = (RUNTIME.joinChat || JOIN_CHAT || '').trim();
  if (!list.length && defaultJoin) {
    const initial = [normalizeChannelIdentifier(defaultJoin)];
    await kvPutJson(env, 'bot:join_channels', initial);
    return initial;
  }
  return list;
}
async function setRequiredChannels(env, list) {
  await kvPutJson(env, 'bot:join_channels', list);
}
function normalizeChannelIdentifier(ch) {
  const s = String(ch).trim();
  if (/^-?\d+$/.test(s)) return s; // numeric id
  if (s.startsWith('@')) return s;
  return `@${s}`;
}
async function isUserJoinedAllRequiredChannels(env, userId) {
  const channels = await getRequiredChannels(env);
  if (!channels.length) return true;
  for (const ch of channels) {
    try {
      const ans = await tgGet(`getChatMember?chat_id=${encodeURIComponent(ch)}&user_id=${userId}`);
      if (!ans || !ans.ok) return false;
      const status = ans.result.status;
      if (!['member', 'creator', 'administrator'].includes(status)) return false;
    } catch (_) { return false; }
  }
  return true;
}
async function presentJoinPrompt(env, chatId) {
  const channels = await getRequiredChannels(env);
  const buttons = channels.map(ch => {
    const username = ch.startsWith('@') ? ch.slice(1) : '';
    const url = username ? `https://t.me/${username}` : undefined;
    return url ? [{ text: `عضویت در ${ch}`, url }] : [{ text: `${ch}`, callback_data: 'NOOP' }];
  });
  buttons.push([{ text: '✅ بررسی عضویت', callback_data: 'CHECK_JOIN' }]);
  await tgApi('sendMessage', { chat_id: chatId, text: 'برای استفاده از ربات، ابتدا در کانال‌های زیر عضو شوید، سپس روی «بررسی عضویت» بزنید.', reply_markup: { inline_keyboard: buttons } });
}

/* -------------------- Webhook ensure helper -------------------- */
async function ensureWebhookForRequest(env, req) {
  try {
    // If bot token is not configured, skip webhook checks
    if (!(RUNTIME.tgToken || TELEGRAM_TOKEN)) return;
    // Throttle to at most once per 10 minutes
    const last = await kvGetJson(env, 'bot:webhook_check_at');
    const nowTs = now();
    if (last && (nowTs - last) < 10 * 60 * 1000) return;
    const info = await tgGet('getWebhookInfo');
    let want = RUNTIME.webhookUrl || WEBHOOK_URL || '';
    // If not configured, infer from the incoming request origin (Worker accepts POST to any non-/api path)
    if (!want && req && req.url) {
      try { want = new URL(req.url).origin; } catch (_) {}
    }
    const current = info && info.result && info.result.url || '';
    if (!current || current !== want) {
      if (want) {
        await tgSetWebhook(want);
        await kvPutJson(env, 'bot:webhook_set_at', now());
      }
    }
    await kvPutJson(env, 'bot:webhook_check_at', nowTs);
  } catch (_) { /* ignore */ }
}

/* End of enhanced worker */
}

