 
/*
  main.js — Cloudflare Pages Functions Worker for a Telegram bot

  Sections:
  1) Config & Runtime (env & constants)
  2) KV Helpers (get/set/delete)
  3) Telegram Helpers (sendMessage, sendDocument, ...)
  4) Utility Helpers (time, formatting)
  5) Inline UI Helpers (menus)
  6) HTTP Entrypoints (/webhook, /f/<token>, /)
  7) Features & Flows (main menu, profile, tickets, transfer, files, admin)
  8) Storage Helpers (users, files, settings, stats)
  9) Public Status Page (HTML)
*/

// =========================================================
// 1) Config & Runtime
// =========================================================
const CONFIG = {
  // Bot token and admin IDs are read from env: env.BOT_TOKEN (required), env.ADMIN_ID or env.ADMIN_IDS
  BOT_NAME: 'ربات آپلود',
  BOT_VERSION: '4.5-optimized + Ai',
  // Performance settings
  MAX_CACHE_SIZE: 1000,
  CACHE_TTL: 300000, // 5 minutes
  REQUEST_TIMEOUT: 30000, // 30 seconds
  DEFAULT_CURRENCY: 'سکه',
  SERVICE_TOGGLE_KEY: 'settings:service_enabled',
  BASE_STATS_KEY: 'stats:base',
  USER_PREFIX: 'user:',
  FILE_PREFIX: 'file:',
  TICKET_PREFIX: 'ticket:',
  DOWNLOAD_LOG_PREFIX: 'dl:',
  GIFT_PREFIX: 'gift:',
  CLAIM_PREFIX: 'claim:',
  REDEEM_PREFIX: 'redeem:',
  REF_DONE_PREFIX: 'ref:done:',
  REF_PENDING_PREFIX: 'ref:pending:',
  PURCHASE_PREFIX: 'purchase:',
  BLOCK_PREFIX: 'blocked:',
  // Tester users (always allowed to test referral multiple times)
  TESTER_IDS: ['6519017272'],
  // Custom purchasable buttons
  CUSTOMBTN_PREFIX: 'cbtn:',
  // پرداخت و پلن‌ها (می‌توانید از طریق تنظیمات نیز override کنید)
  PLANS: [
    { id: 'p1', coins: 5, price_label: '۱۵٬۰۰۰ تومان' },
    { id: 'p2', coins: 10, price_label: '۲۵٬۰۰۰ تومان' },
    { id: 'p3', coins: 15, price_label: '۳۵٬۰۰۰ تومان' },
  ],
  CARD_INFO: {
    card_number: '6219 8619 4308 4037',
    holder_name: 'امیرحسین سیاهبالائی',
    pay_note: 'لطفاً پس از پرداخت، رسید را ارسال کنید.'
  },
  // OpenVPN settings
  OVPN_PRICE_COINS: 5,
  OVPN_PREFIX: 'ovpn:',
  OVPN_LOCATIONS: [
    'هلند',
    'لاتویا',
    'لهستان',
    'سوئیس',
    'رومانی',
    'آلمان',
    'ایتالیا',
    'آمریکا',
  ],
  OVPN_FLAGS: {
    'هلند': '🇳🇱',
    'لاتویا': '🇱🇻',
    'لهستان': '🇵🇱',
    'سوئیس': '🇨🇭',
    'رومانی': '🇷🇴',
    'آلمان': '🇩🇪',
    'ایتالیا': '🇮🇹',
    'آمریکا': '🇺🇸',
  },
  // DNS settings
  DNS_PRICE_COINS: 2,
  DNS_PREFIX_V4: 'dns:v4:',
  DNS_PREFIX_V6: 'dns:v6:',
};

// صفحات فانکشنز env: { BOT_KV }

// Helper function to format WireGuard default values for display
function formatWgDefaultValue(field, value) {
  if (!value && value !== 0) return '-';
  switch(field) {
    case 'mtu': return String(value);
    case 'listen_port': return value ? String(value) : '(خودکار)';
    case 'persistent_keepalive': return value ? `${value} ثانیه` : 'خاموش';
    case 'peer_public_key': return value ? '✅ تنظیم شده' : '-';
    default: return String(value);
  }
}

// Generate a client keypair for WireGuard (X25519). Returns { priv, pub } as base64.
// Fallback: if WebCrypto X25519 is unavailable, returns { priv: generateWgPrivateKey(), pub: '' }.
async function generateWgKeypair() {
  try {
    if (crypto && crypto.subtle && crypto.subtle.generateKey) {
      const kp = await crypto.subtle.generateKey(
        { name: 'X25519' },
        true,
        ['deriveBits']
      );
      // Export private key (raw) and public key (raw), then base64
      const [rawPriv, rawPub] = await Promise.all([
        crypto.subtle.exportKey('raw', kp.privateKey),
        crypto.subtle.exportKey('raw', kp.publicKey)
      ]);
      const priv = bytesToBase64(new Uint8Array(rawPriv));
      const pub = bytesToBase64(new Uint8Array(rawPub));
      return { priv, pub };
    }
  } catch (e) {
    console.warn('generateWgKeypair fallback:', e?.message || e);
  }
  return { priv: generateWgPrivateKey(), pub: '' };
}

// Memory management for caches
const CACHE_REGISTRY = new WeakMap();

function initializeCache(env) {
  if (!CACHE_REGISTRY.has(env)) {
    CACHE_REGISTRY.set(env, {
      settings: null,
      botUsername: null,
      customButtons: [],
      lastCleanup: Date.now(),
      size: 0
    });
  }
  return CACHE_REGISTRY.get(env);
}

function cleanupCache(env) {
  const cache = CACHE_REGISTRY.get(env);
  if (!cache) return;
  
  const now = Date.now();
  if (now - cache.lastCleanup > CONFIG.CACHE_TTL) {
    cache.settings = null;
    cache.botUsername = null;
    cache.customButtons = [];
    cache.lastCleanup = now;
    cache.size = 0;
  }
}

// WireGuard: group availability by country with capacity (max_users)
function groupWgAvailabilityByCountry(list) {
  const map = {};
  for (const e of Array.isArray(list) ? list : []) {
    const country = String(e.country || '').trim() || 'نامشخص';
    const flag = e.flag || '🌐';
    const max = Number(e.max_users || 0);
    const used = Number(e.used_count || 0);
    const hasCap = (max === 0) || (used < max);
    if (!map[country]) map[country] = { count: 0, flag };
    if (hasCap) map[country].count += 1;
    if (!map[country].flag && flag) map[country].flag = flag;
  }
  return map;
}

// WireGuard: pick a random endpoint for a given country that has capacity
function pickWgEndpointWithCapacity(list, country) {
  const arr = (Array.isArray(list) ? list : []).map((e, i) => ({ ...e, __idx: i }))
    .filter(e => String(e.country || '') === String(country || ''))
    .filter(e => Number(e.max_users || 0) === 0 || Number(e.used_count || 0) < Number(e.max_users || 0));
  if (!arr.length) return null;
  const r = Math.floor(Math.random() * arr.length);
  return arr[r];
}

// WireGuard: random IPv4 generator from CIDR (e.g., 192.168.1.0/24)
function ipToInt(ip) {
  const p = String(ip || '').trim().split('.').map(x => Number(x));
  if (p.length !== 4 || p.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
function intToIp(int) {
  int = int >>> 0;
  return [ (int >>> 24) & 255, (int >>> 16) & 255, (int >>> 8) & 255, int & 255 ].join('.');
}
function randomIPv4FromCIDR(cidr) {
  try {
    const [ip, maskStr] = String(cidr || '').trim().split('/');
    const mask = Number(maskStr);
    if (!ip || !(mask >= 0 && mask <= 32)) return null;
    const base = ipToInt(ip);
    if (base === null) return null;
    const hostBits = 32 - mask;
    if (hostBits <= 0) return ip; // single IP
    const size = (1 << hostBits) >>> 0;
    const start = (base >>> 0) & (~((1 << hostBits) - 1)) >>> 0;
    const end = (start + size - 1) >>> 0;
    let minHost = start, maxHost = end;
    if (hostBits >= 2) { minHost = start + 1; maxHost = end - 1; }
    if (maxHost < minHost) return intToIp(start);
    const span = (maxHost - minHost + 1) >>> 0;
    const rnd = Math.floor(Math.random() * span);
    return intToIp((minHost + rnd) >>> 0);
  } catch { return null; }
}

// Simple Web Admin page for WireGuard Endpoints management
function renderWgAdminPage(settings, notice = '') {
  try {
    const eps = Array.isArray(settings?.wg_endpoints) ? settings.wg_endpoints : [];
    const d = settings?.wg_defaults || {};
    const rows = eps.map((e, i) => (
      `<tr>
         <td>${i + 1}</td>
         <td><code>${e.hostport || ''}</code></td>
         <td>${e.country || ''}</td>
         <td>${e.flag || ''}</td>
         <td>${Number(e.used_count||0)} / ${Number(e.max_users||0) === 0 ? '∞' : Number(e.max_users||0)}</td>
         <td>
           <form method="post" style="margin:0;">
             <input type="hidden" name="action" value="del" />
             <input type="hidden" name="idx" value="${i}" />
             <button type="submit">حذف</button>
           </form>
         </td>
       </tr>`
    )).join('');
    const html = `<!doctype html>
<html lang="fa" dir="rtl"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>مدیریت Endpoint های WireGuard</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Vazirmatn:wght@300;400;600&display=swap');
  :root { --bg: #0f172a; --card: rgba(255,255,255,0.08); --text: #e5e7eb; --sub:#94a3b8; --ok:#34d399; --warn:#fbbf24; --bad:#f87171; }
  *{ box-sizing:border-box; }
  body{ margin:0; font-family:'Vazirmatn',sans-serif; background:#000; color:var(--text); min-height:100vh; display:flex; align-items:center; justify-content:center; padding:16px; }
  .container{ width:100%; max-width:1100px; }
  header{ text-align:center; margin-bottom:24px; }
  h1{ font-weight:600; margin:0 0 6px; }
  p{ margin:0; color:var(--sub); }
  .grid{ display:grid; grid-template-columns:1fr; gap:16px; }
  .card{ background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.12); border-radius:16px; padding:16px; backdrop-filter: blur(10px); box-shadow:0 10px 30px rgba(0,0,0,0.6); }
  .notice{ color:#34d399; margin:0 0 10px; }
  .table-wrap{ width:100%; overflow:auto; }
  table{ width:100%; border-collapse:collapse; min-width:640px; }
  th,td{ border:1px solid rgba(255,255,255,0.12); padding:8px; text-align:left; }
  code{ background:rgba(255,255,255,0.08); padding:2px 4px; border-radius:4px; }
  form .row{ display:flex; gap:8px; flex-wrap:wrap; }
  textarea,input,select,button{ width:100%; border-radius:10px; border:1px solid rgba(255,255,255,0.2); background:rgba(255,255,255,0.06); color:#fff; padding:8px 10px; }
  /* Force dark dropdown for select (Peer Public Mode) */
  select{ background:#0b0b0b; color:#fff; }
  select option{ background:#000; color:#fff; }
  button{ background:#3b82f6; border:0; cursor:pointer; width:auto; }
  .tabs{ display:flex; gap:8px; margin-bottom:8px; flex-wrap:wrap; }
  .tab{ padding:8px 12px; border-radius:10px; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.12); display:inline-block; cursor:pointer; user-select:none; }
  .tab.active{ background:#3b82f6; border-color:#60a5fa; }
  .hidden{ display:none; }
  @media (max-width: 640px){
    .row > label{ flex:1 1 100% !important; }
    table{ min-width:520px; }
  }
</style></head>
<body>
 <main class="container">
  <header>
    <h1>مدیریت Endpoint های WireGuard</h1>
    <p>افزودن/حذف Endpoint ها — تغییرات بلافاصله در ربات اعمال می‌شود</p>
  </header>
  <section class="card">
    ${notice ? `<div class="notice">${notice}</div>` : ''}
    <div class="tabs">
      <div class="tab active" id="tab-btn-endpoints">Endpoints</div>
      <div class="tab" id="tab-btn-defaults">WireGuard Defaults</div>
    </div>
    <div id="tab-endpoints">
    <h2 style="margin-top:0;">افزودن Endpoint ها</h2>
    <form method="post">
      <input type="hidden" name="action" value="add" />
      <p><label>لیست IP:PORT (هر خط یک مورد)<br/>
        <textarea name="hostports" rows="6" placeholder="1.2.3.4:51820"></textarea>
      </label></p>
      <div class="row">
        <label style="flex:1 1 50%">کشور<br/><input name="country" placeholder="آمریکا" /></label>
        <label style="flex:1 1 50%">پرچم<br/><input name="flag" placeholder="🇺🇸" /></label>
      </div>
      <div class="row">
        <label style="flex:1 1 50%">حداکثر کاربران هر Endpoint (0=نامحدود)<br/><input name="max_users" placeholder="0" /></label>
      </div>
      <p><button type="submit">ثبت</button></p>
    </form>
    <div class="table-wrap">
    <h2 style="margin-top:0;">فهرست Endpoint ها</h2>
    <table>
      <thead><tr><th>#</th><th>Host:Port</th><th>کشور</th><th>پرچم</th><th>استفاده/حداکثر</th><th>اقدام</th></tr></thead>
      <tbody>${rows || ''}</tbody>
    </table>
    </div>
    </div>
    <div id="tab-defaults" class="hidden">
  </section>
  <section class="card" style="margin-top:16px;">
    <h2 style="margin-top:0;">ویرایش پیش‌فرض‌های WireGuard</h2>
    <form method="post">
      <input type="hidden" name="action" value="save_defaults" />
      <div class="row">
        <label style="flex:1 1 50%">Address<br/><input name="address" placeholder="10.66.66.2/32" value="${d.address || ''}" /></label>
        <label style="flex:1 1 50%">DNS<br/><input name="dns" placeholder="10.202.10.10, 10.202.10.11" value="${d.dns || ''}" /></label>
      </div>
      <div class="row">
        <label style="flex:1 1 33%">MTU<br/><input name="mtu" type="number" placeholder="1360" value="${typeof d.mtu==='number'? d.mtu : ''}" /></label>
        <label style="flex:1 1 33%">ListenPort<br/><input name="listen_port" type="number" placeholder="0 (auto)" value="${typeof d.listen_port==='number'? d.listen_port : ''}" /></label>
        <label style="flex:1 1 33%">PersistentKeepalive<br/><input name="persistent_keepalive" type="number" placeholder="ثانیه یا خالی" value="${typeof d.persistent_keepalive==='number'? d.persistent_keepalive : ''}" /></label>
      </div>
      <div class="row">
        <label style="flex:1 1 100%">AllowedIPs<br/><input name="allowed_ips" placeholder="0.0.0.0/0, ::/0" value="${d.allowed_ips || ''}" /></label>
      </div>
      <div class="row">
        <label style="flex:1 1 60%">CIDR Pool برای IP تصادفی<br/>
          <input name="cidr_pool" placeholder="10.66.0.0/16" value="${d.cidr_pool || ''}" />
        </label>
        <label style="flex:1 1 40%">اعمال به:
          <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; padding-top:6px;">
            <label style="display:flex; align-items:center; gap:6px;"><input type="checkbox" name="cidr_apply_dns" ${d.cidr_apply_dns ? 'checked' : ''}/> DNS</label>
            <label style="display:flex; align-items:center; gap:6px;"><input type="checkbox" name="cidr_apply_address" ${d.cidr_apply_address ? 'checked' : ''}/> Address</label>
            <label style="display:flex; align-items:center; gap:6px;"><input type="checkbox" name="cidr_apply_endpoint" ${d.cidr_apply_endpoint ? 'checked' : ''}/> Endpoint</label>
          </div>
        </label>
      </div>
      <div class="row">
        <label style="flex:1 1 50%">Peer Public Mode<br/>
          <select name="peer_public_mode">
            <option value="cloudflare" ${String(d.peer_public_mode||'cloudflare')==='cloudflare'?'selected':''}>Cloudflare</option>
            <option value="endpoint" ${String(d.peer_public_mode||'cloudflare')==='endpoint'?'selected':''}>Auto Key (Endpoint)</option>
            <option value="custom" ${String(d.peer_public_mode||'cloudflare')==='custom'?'selected':''}>Custom</option>
          </select>
        </label>
        <label style="flex:1 1 50%">Custom PublicKey (Base64)<br/>
          <input name="peer_public_key" placeholder="Base64" value="${d.peer_public_key || ''}" />
        </label>
      </div>
      <p><button type="submit">💾 ذخیره</button></p>
      <p style="color:#94a3b8; font-size:12px;">تنظیمات با زدن دکمه ذخیره اعمال می‌شوند. بدون ذخیره هیچ تغییری اعمال نخواهد شد.</p>
    </form>
    </div>
  <script>
    (function(){
      const btnE = document.getElementById('tab-btn-endpoints');
      const btnD = document.getElementById('tab-btn-defaults');
      const tabE = document.getElementById('tab-endpoints');
      const tabD = document.getElementById('tab-defaults');
      function act(which){
        if (which==='e'){
          btnE.classList.add('active'); btnD.classList.remove('active');
          tabE.classList.remove('hidden'); tabD.classList.add('hidden');
        } else {
          btnD.classList.add('active'); btnE.classList.remove('active');
          tabD.classList.remove('hidden'); tabE.classList.add('hidden');
        }
      }
      btnE && btnE.addEventListener('click', () => act('e'));
      btnD && btnD.addEventListener('click', () => act('d'));
    })();
  </script>
  </main>
</body></html>`;
    return html;
  } catch (e) {
    return '<!doctype html><html><body>خطا در ساخت صفحه</body></html>';
  }
}

// Build a paginated keyboard for deleting unassigned DNS IPs in a country
async function buildDnsDeleteListKb(env, version, country, page = 1) {
  const prefix = dnsPrefix(version);
  const ips = [];
  let cursor = undefined;
  
  // Get all keys with pagination
  do {
    const list = await env.BOT_KV.list({ prefix, limit: 1000, cursor });
    for (const k of list.keys) {
      const v = await kvGet(env, k.name);
      if (v && !v.assigned_to && String(v.country || '') === String(country || '')) ips.push(v.ip);
    }
    cursor = list.cursor;
  } while (cursor);
  
  ips.sort();
  const per = 8;
  const totalPages = Math.max(1, Math.ceil(ips.length / per));
  const p = Math.min(Math.max(1, Number(page || 1)), totalPages);
  const start = (p - 1) * per;
  const chunk = ips.slice(start, start + per);
  const rows = chunk.map(ip => ([{ text: ip, callback_data: `adm_dns_del_ip:${version}:${ip}:${country}` }]));
  if (rows.length === 0) {
    rows.push([{ text: '— هیچ آی‌پی آزاد در این کشور نیست —', callback_data: 'noop' }]);
  }
  // Nav
  if (totalPages > 1) {
    const prev = p > 1 ? p - 1 : totalPages;
    const next = p < totalPages ? p + 1 : 1;
    rows.push([
      { text: '◀️', callback_data: `adm_dns_list:${version}:${prev}:${country}` },
      { text: `📄 ${p}/${totalPages}`, callback_data: 'noop' },
      { text: '▶️', callback_data: `adm_dns_list:${version}:${next}:${country}` }
    ]);
  }
  rows.push([{ text: '🔙 بازگشت', callback_data: 'adm_dns_remove' }]);
  rows.push([{ text: '🏠 منوی اصلی ربات', callback_data: 'back_main' }]);
  return kb(rows);
}

// Build a keyboard to list all OVPN configs for deletion (admin)
async function buildOvpnDeleteListKb(env) {
  const rows = [];
  try {
    const list = await env.BOT_KV.list({ prefix: CONFIG.OVPN_PREFIX, limit: 1000 });
    const items = [];
    for (const k of list.keys) {
      const name = k.name || '';
      if (!name.startsWith(CONFIG.OVPN_PREFIX)) continue;
      const nm = name.slice(CONFIG.OVPN_PREFIX.length); // e.g., TCP:هلند
      const parts = nm.split(':');
      const proto = (parts[0] || '').toUpperCase();
      const loc = parts.slice(1).join(':');
      if (!proto || !loc) continue;
      items.push({ proto, loc });
    }
    if (!items.length) {
      rows.push([{ text: 'هیچ کانفیگ OVPN آپلود نشده است', callback_data: 'noop' }]);
    } else {
      for (const it of items) {
        const label = `${it.proto} — ${it.loc}`;
        rows.push([{ text: label, callback_data: `adm_ovpn_del_item:${it.proto}:${it.loc}` }]);
      }
    }
  } catch (e) {
    console.error('buildOvpnDeleteListKb error', e);
    rows.push([{ text: 'خطا در دریافت لیست', callback_data: 'noop' }]);
  }
  rows.push([{ text: '🔙 بازگشت', callback_data: 'adm_service' }]);
  rows.push([{ text: '🏠 منوی اصلی ربات', callback_data: 'back_main' }]);
  return kb(rows);
}

// Deliver custom button content to user with payment check
async function deliverCustomButtonToUser(env, uid, chat_id, id) {
  try {
    const result = await withLock('cbtn:' + id, async () => {
      const meta = await kvGet(env, CONFIG.CUSTOMBTN_PREFIX + id);
      if (!meta || meta.disabled) { await tgSendMessage(env, chat_id, 'این مورد یافت نشد یا غیرفعال است.', mainMenuInlineKb()); return { ok: false }; }
      const price = Number(meta.price || 0);
      const paidUsers = Array.isArray(meta.paid_users) ? meta.paid_users : [];
      const alreadyPaid = paidUsers.includes(String(uid));
      const users = Array.isArray(meta.users) ? meta.users : [];
      const alreadyReceived = users.includes(String(uid));
      const maxUsers = Number(meta.max_users || 0);
      if (!alreadyReceived && maxUsers > 0 && users.length >= maxUsers) {
        await tgSendMessage(env, chat_id, 'ظرفیت دریافت این مورد تکمیل شده است.', mainMenuInlineKb());
        return { ok: false };
      }
      if (price > 0 && !alreadyPaid) {
        const u = await getUser(env, String(uid));
        if (!u || Number(u.balance || 0) < price) {
          await tgSendMessage(env, chat_id, `برای دریافت این مورد به ${fmtNum(price)} ${CONFIG.DEFAULT_CURRENCY} نیاز دارید.`, mainMenuInlineKb());
          return { ok: false };
        }
        // charge and mark paid
        u.balance = Number(u.balance || 0) - price;
        await setUser(env, String(uid), u);
        paidUsers.push(String(uid));
        meta.paid_users = paidUsers;
      }
      if (!alreadyReceived) {
        users.push(String(uid));
        meta.users = users;
      }
      await kvSet(env, CONFIG.CUSTOMBTN_PREFIX + id, meta);
      return { ok: true, meta };
    });
    if (!result.ok) return false;
    const meta = result.meta;
    // deliver
    const kind = meta.kind || 'document';
    if (kind === 'photo') {
      await tgSendPhoto(env, chat_id, meta.file_id, { caption: `🖼 ${meta.file_name || ''}` });
    } else if (kind === 'text') {
      const content = meta.text || meta.file_name || '—';
      await tgSendMessage(env, chat_id, `📄 محتوا:\n${content}`);
    } else {
      await tgSendDocument(env, chat_id, meta.file_id, { caption: `${kindIcon(kind)} ${meta.file_name || ''}` });
    }
    return true;
  } catch (e) { console.error('deliverCustomButtonToUser error', e); await tgSendMessage(env, chat_id, 'خطا در ارسال محتوا.'); return false; }
}

// پنل مدیریت یک فایل
function buildFileAdminKb(meta) {
  const t = meta.token;
  return kb([
    [ { text: meta.disabled ? '✅ فعال‌سازی' : '⛔️ غیرفعال‌سازی', callback_data: `file_toggle_disable:${t}` } ],
    [ { text: '💰 تنظیم قیمت', callback_data: `file_set_price:${t}` }, { text: '👥 محدودیت یکتا', callback_data: `file_set_limit:${t}` } ],
    [ { text: '♻️ جایگزینی فایل', callback_data: `file_replace:${t}` } ],
    [ { text: '🗑 حذف فایل', callback_data: `file_delete:${t}` } ],
    [ { text: '🔙 بازگشت', callback_data: 'back_main' } ],
  ]);
}

// ارسال فایل به کاربر با رعایت قوانین قیمت/محدودیت
async function deliverFileToUser(env, uid, chat_id, token) {
  try {
    // Serialize capacity and payment updates to prevent race conditions
    const updated = await withLock('file:' + token, async () => {
      let meta = await kvGet(env, CONFIG.FILE_PREFIX + token);
      if (!meta || meta.disabled) {
        await tgSendMessage(env, chat_id, 'فایل یافت نشد یا غیرفعال است.');
        return { ok: false };
      }
      const users = Array.isArray(meta.users) ? [...meta.users] : [];
      const paidUsers = Array.isArray(meta.paid_users) ? [...meta.paid_users] : [];
      const maxUsers = Number(meta.max_users || 0);
      const price = Number(meta.price || 0);
      const isOwner = String(meta.owner_id) === String(uid);
      const uidStr = String(uid);
      const already = users.includes(uidStr);
      const alreadyPaid = paidUsers.includes(uidStr);
      // Simple capacity check - if already at limit, reject immediately
      if (!already && maxUsers > 0 && users.length >= maxUsers) {
        await tgSendMessage(env, chat_id, 'ظرفیت دریافت این فایل تکمیل شده است.', mainMenuInlineKb());
        return { ok: false };
      }
      // Now handle payment if needed, ensuring idempotency
      if (price > 0 && !isOwner && !alreadyPaid) {
        const u = await getUser(env, uidStr);
        if (!u || Number(u.balance || 0) < price) {
          // Not enough balance: fail
          await tgSendMessage(env, chat_id, 'موجودی شما برای دریافت فایل کافی نیست.', mainMenuInlineKb());
          return { ok: false };
        }
        // Charge and mark paid
        u.balance = Number(u.balance || 0) - price;
        await setUser(env, uidStr, u);
        const paid = Array.isArray(meta.paid_users) ? meta.paid_users : [];
        if (!paid.includes(uidStr)) paid.push(uidStr);
        meta.paid_users = paid;
        await kvSet(env, CONFIG.FILE_PREFIX + token, meta);
      }
      // Finally, add user to recipients if not already
      if (!already) {
        const cur = Array.isArray(meta.users) ? meta.users : [];
        if (!cur.includes(uidStr)) {
          cur.push(uidStr);
          meta.users = cur;
          await kvSet(env, CONFIG.FILE_PREFIX + token, meta);
          
          // Double-check: if we exceeded capacity after adding, remove this user and fail
          if (maxUsers > 0 && cur.length > maxUsers) {
            meta.users = cur.filter(u => u !== uidStr);
            await kvSet(env, CONFIG.FILE_PREFIX + token, meta);
            // Refund if payment was made
            if (price > 0 && !isOwner) {
              const u = await getUser(env, uidStr);
              if (u) {
                u.balance = Number(u.balance || 0) + price;
                await setUser(env, uidStr, u);
                // Remove from paid users
                meta.paid_users = (meta.paid_users || []).filter(p => p !== uidStr);
                await kvSet(env, CONFIG.FILE_PREFIX + token, meta);
              }
            }
            await tgSendMessage(env, chat_id, 'ظرفیت دریافت این فایل تکمیل شده است.', mainMenuInlineKb());
            return { ok: false };
          }
        }
      }
      // If capacity is now full, hard-disable the file to avoid any further deliveries via other instances
      const afterUsers = Array.isArray(meta.users) ? meta.users : [];
      if (maxUsers > 0 && afterUsers.length >= maxUsers) {
        if (!meta.disabled) {
          meta.disabled = true;
          await kvSet(env, CONFIG.FILE_PREFIX + token, meta);
        }
      }
      return { ok: true, meta };
    });
    if (!updated.ok) return false;
    const meta = updated.meta;
    // ارسال محتوا بر اساس نوع
    const kind = meta.kind || 'document';
    if (kind === 'photo') {
      await tgSendPhoto(env, chat_id, meta.file_id, { caption: `🖼 ${meta.file_name || ''}` });
    } else if (kind === 'text') {
      const content = meta.text || meta.file_name || '—';
      await tgSendMessage(env, chat_id, `📄 محتوا:
${content}`);
    } else {
      await tgSendDocument(env, chat_id, meta.file_id, { caption: `📄 ${meta.file_name || ''}` });
    }
    return true;
  } catch (e) {
    console.error('deliverFileToUser error', e);
    await tgSendMessage(env, chat_id, 'خطا در ارسال فایل.');
    return false;
  }
}

// Verify that the bot itself is admin in a given channel token
// Returns { verifiable: boolean, isAdmin: boolean }
async function checkBotAdminForToken(env, token) {
  try {
    let chat = '';
    const t = String(token || '').trim();
    if (!t) return { verifiable: false, isAdmin: false };
    if (t.startsWith('http')) {
      try {
        const u = new URL(t);
        const host = u.hostname.replace(/^www\./, '').toLowerCase();
        const seg = (u.pathname || '').split('/').filter(Boolean)[0] || '';
        if ((host === 't.me' || host === 'telegram.me') && seg && seg.toLowerCase() !== 'joinchat' && seg.toLowerCase() !== 'c') {
          chat = '@' + seg;
        } else {
          // private/invite links are not verifiable via getChatMember
          return { verifiable: false, isAdmin: false };
        }
      } catch {
        return { verifiable: false, isAdmin: false };
      }
    } else if (t.startsWith('@') || /^-100/.test(t)) {
      chat = t;
    } else {
      chat = '@' + t;
    }
    if (!chat) return { verifiable: false, isAdmin: false };
    const me = await tgGetMe(env);
    const botId = me?.result?.id;
    if (!botId) return { verifiable: false, isAdmin: false };
    const res = await tgGetChatMember(env, chat, botId);
    const status = res?.result?.status || '';
    const isAdmin = status === 'administrator' || status === 'creator';
    return { verifiable: true, isAdmin };
  } catch (e) {
    console.error('checkBotAdminForToken error', e);
    return { verifiable: false, isAdmin: false };
  }
}

async function tgSendPhoto(env, chat_id, file_id_or_url, opts = {}) {
  try {
    const form = new FormData();
    form.set('chat_id', String(chat_id));
    form.set('photo', file_id_or_url);
    Object.entries(opts || {}).forEach(([k, v]) => {
      if (v != null) form.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    });
    const res = await fetch(tgApiUrl('sendPhoto', env), { method: 'POST', body: form });
    return await res.json();
  } catch (e) { console.error('tgSendPhoto error', e); return null; }
}

function buildPurchaseCaption(p) {
  const lines = [];
  lines.push('💸 <b>درخواست خرید سکه</b>');
  lines.push(`👤 کاربر: <code>${p.user_id}</code>`);
  if (p.coins != null) lines.push(`🪙 پلن: <b>${fmtNum(p.coins)} ${CONFIG.DEFAULT_CURRENCY}</b>`);
  if (p.amount_label) lines.push(`💰 مبلغ: <b>${p.amount_label}</b>`);
  lines.push(`🆔 شناسه: <code>${p.id}</code>`);
  // وضعیت سفارش — همیشه نمایش داده شود
  const status = String(p.status || 'pending');
  if (status === 'approved') {
    lines.push('✅ تایید شد');
  } else if (status === 'rejected') {
    lines.push('❌ رد شد');
    if (p.reason) lines.push(`دلیل: ${p.reason}`);
  } else {
    lines.push('⏳ در انتظار بررسی');
  }
  return lines.join('\n');
}

async function tgEditMessageCaption(env, chat_id, message_id, caption, opts = {}) {
  try {
    const body = { chat_id, message_id, caption, parse_mode: 'HTML', ...opts };
    const res = await fetch(tgApiUrl('editMessageCaption', env), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    return await res.json();
  } catch (e) { console.error('tgEditMessageCaption error', e); return null; }
}

async function tgEditReplyMarkup(env, chat_id, message_id, reply_markup) {
  try {
    const body = { chat_id, message_id, reply_markup };
    const res = await fetch(tgApiUrl('editMessageReplyMarkup', env), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    return await res.json();
  } catch (e) { console.error('tgEditReplyMarkup error', e); return null; }
}

async function handleTokenRedeem(env, uid, chat_id, token) {
  try {
    // Enhanced input validation
    const t = sanitizeInput(String(token || '').trim());
    if (!validateInput(t, 'token')) {
      await tgSendMessage(env, chat_id, 'توکن نامعتبر است. یک توکن ۶-۳۲ کاراکتری ارسال کنید.');
      return;
    }
    
    // Validate user inputs
    if (!validateInput(String(uid), 'string', 50) || !validateInput(String(chat_id), 'string', 50)) {
      console.error('handleTokenRedeem: Invalid uid or chat_id');
      return;
    }
    
    const meta = await kvGet(env, CONFIG.FILE_PREFIX + t);
    if (!meta || meta.disabled) { 
      await tgSendMessage(env, chat_id, 'فایل یافت نشد یا غیرفعال است.', mainMenuInlineKb()); 
      return; 
    }
    
    const users = Array.isArray(meta.users) ? meta.users : [];
    const paidUsers = Array.isArray(meta.paid_users) ? meta.paid_users : [];
    const isOwner = String(meta.owner_id) === String(uid);
    const price = Math.max(0, Number(meta.price || 0));
    const already = users.includes(String(uid));
    const alreadyPaid = paidUsers.includes(String(uid));
    
    // Check if file has expired (if expiry is set)
    if (meta.expires_at && Date.now() > meta.expires_at) {
      await tgSendMessage(env, chat_id, 'این فایل منقضی شده است.', mainMenuInlineKb());
      return;
    }
    
    // For paid files, show confirmation dialog
    if (price > 0 && !isOwner && !alreadyPaid) {
      await setUserState(env, uid, { step: 'confirm_token', token: t, price, timestamp: Date.now() });
      const kbBuy = kb([[
        { text: `✅ تایید (کسر ${fmtNum(price)} ${CONFIG.DEFAULT_CURRENCY})`, callback_data: 'confirm_buy:' + t }
      ], [
        { text: '❌ انصراف', callback_data: 'cancel_buy' }
      ]]);
      await tgSendMessage(env, chat_id, `این فایل برای دریافت به <b>${fmtNum(price)}</b> ${CONFIG.DEFAULT_CURRENCY} نیاز دارد.\n\nآیا مایل به ادامه هستید؟`, kbBuy);
      return;
    }
    
    const ok = await deliverFileToUser(env, uid, chat_id, t);
    if (ok) { 
      await clearUserState(env, uid); 
      // Log successful redemption
      await bumpStat(env, 'tokens_redeemed');
    }
  } catch (e) {
    console.error('handleTokenRedeem error', e.message);
    await tgSendMessage(env, chat_id, 'خطا در پردازش توکن. لطفاً دوباره تلاش کنید.', mainMenuInlineKb());
  }
}

// ------------------ Get bot version (for display in main menu) ------------------ //
async function getBotVersion(env) {
  try {
    const s = await getSettings(env);
    return s?.bot_version || CONFIG.BOT_VERSION;
  } catch { return CONFIG.BOT_VERSION; }
}

// ------------------ Build main menu header text ------------------ //
async function mainMenuHeader(env) {
  const v = await getBotVersion(env);
  // Use explicit join to ensure reliable newline rendering across parse modes
  return [
    'منو اصلی 🏠',
    'نسخه ربات 👇',
    `${v}`
  ].join('\n');
}

// Get bot info (for auto-detecting username if BOT_USERNAME is not set)
async function tgGetMe(env) {
  try {
    const res = await fetch(tgApiUrl('getMe', env), { method: 'GET' });
    return await res.json();
  } catch (e) { console.error('tgGetMe error', e); return null; }
}

async function getBotUsername(env) {
  const cache = initializeCache(env);
  cleanupCache(env);
  
  // Check cache first
  if (cache.botUsername && Date.now() - cache.lastCleanup < CONFIG.CACHE_TTL) {
    return cache.botUsername;
  }
  
  try {
    const s = await getSettings(env);
    if (s?.bot_username && validateInput(s.bot_username, 'string', 32)) {
      cache.botUsername = s.bot_username;
      return s.bot_username;
    }
    
    const me = await tgGetMe(env);
    const u = me?.result?.username;
    if (u && validateInput(u, 'string', 32)) {
      s.bot_username = u;
      await setSettings(env, s);
      cache.botUsername = u;
      return u;
    }
    
    return '';
  } catch (e) { 
    console.error('getBotUsername error', e.message); 
    return ''; 
  }
}

// Referral helpers (auto credit once)
async function autoCreditReferralIfNeeded(env, referrerId, referredId) {
  try {
    if (!referrerId || !referredId || String(referrerId) === String(referredId)) return false;
    const isTesterReferrer = Array.isArray(CONFIG.TESTER_IDS) && CONFIG.TESTER_IDS.includes(String(referrerId));
    const isTesterReferred = Array.isArray(CONFIG.TESTER_IDS) && CONFIG.TESTER_IDS.includes(String(referredId));
    const doneKey = CONFIG.REF_DONE_PREFIX + String(referredId);
    // Only enforce the once-only rule if neither side is a tester
    if (!isTesterReferrer && !isTesterReferred) {
      const done = await kvGet(env, doneKey);
      if (done) return false; // already credited once
    }
    // Ensure referrer user exists so crediting won't fail
    try { await ensureUser(env, String(referrerId), {}); } catch {}
    const amount = 1; // grant 1 coin to referrer
    const credited = await creditBalance(env, String(referrerId), amount);
    if (!credited) return false;
    // bump referrer counter
    const ru = await getUser(env, String(referrerId));
    if (ru) { ru.ref_count = Number(ru.ref_count || 0) + 1; await setUser(env, String(referrerId), ru); }
    // Only set done marker if not in tester mode, so tester can repeat
    if (!isTesterReferrer && !isTesterReferred) {
      await kvSet(env, doneKey, { ts: nowTs(), amount, referrer_id: String(referrerId) });
    }
    return true;
  } catch (e) { console.error('autoCreditReferralIfNeeded error', e); return false; }
}

// Ticket storage
async function createTicket(env, uid, content, type = 'general') {
  try {
    const id = newToken(10);
    const t = { id, user_id: uid, content: String(content || ''), type, created_at: nowTs(), closed: false, replies: [], status: 'open' };
    await kvSet(env, CONFIG.TICKET_PREFIX + id, t);
    return t;
  } catch (e) { console.error('createTicket error', e); return null; }
}

async function listTickets(env, limit = 10) {
  try {
    const list = await env.BOT_KV.list({ prefix: CONFIG.TICKET_PREFIX, limit: 1000 });
    const items = [];
    for (const k of list.keys) {
      const v = await kvGet(env, k.name);
      if (v) items.push(v);
    }
    items.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    return items.slice(0, limit);
  } catch (e) { console.error('listTickets error', e); return []; }
}

async function listTicketsByType(env, type, limit = 20) {
  try {
    const list = await env.BOT_KV.list({ prefix: CONFIG.TICKET_PREFIX, limit: 1000 });
    const items = [];
    for (const k of list.keys) {
      const v = await kvGet(env, k.name);
      if (v && (v.type || 'general') === type) items.push(v);
    }
    items.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    return items.slice(0, limit);
  } catch (e) { console.error('listTicketsByType error', e); return []; }
}

async function getTicket(env, id) { return (await kvGet(env, CONFIG.TICKET_PREFIX + id)) || null; }
async function saveTicket(env, t) { return kvSet(env, CONFIG.TICKET_PREFIX + t.id, t); }

// Gift codes
async function createGiftCode(env, amount, max_uses = 0) {
  try {
    const code = newToken(10);
    const obj = { code, amount: Number(amount || 0), max_uses: Number(max_uses || 0), created_at: nowTs(), used_by: [] };
    await kvSet(env, CONFIG.GIFT_PREFIX + code, obj);
    return obj;
  } catch (e) { console.error('createGiftCode error', e); return null; }
}

async function listGiftCodes(env, limit = 10) {
  try {
    const list = await env.BOT_KV.list({ prefix: CONFIG.GIFT_PREFIX, limit: 1000 });
    const items = [];
    for (const k of list.keys) {
      const v = await kvGet(env, k.name);
      if (v) items.push(v);
    }
    items.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    return items.slice(0, limit);
  } catch (e) { console.error('listGiftCodes error', e); return []; }
}

async function creditBalance(env, uid, amount) {
  try {
    const u = await getUser(env, uid);
    if (!u) return false;
    u.balance = Number(u.balance || 0) + Number(amount || 0);
    await setUser(env, uid, u);
    return true;
  } catch (e) { console.error('creditBalance error', e); return false; }
}

async function subtractBalance(env, uid, amount) {
  try {
    const u = await getUser(env, uid);
    if (!u) return false;
    const amt = Number(amount || 0);
    if (!amt || amt <= 0) return false;
    if ((u.balance || 0) < amt) return false;
    u.balance = Number(u.balance || 0) - amt;
    await setUser(env, uid, u);
    return true;
  } catch (e) { console.error('subtractBalance error', e); return false; }
}

// =========================================================
// 2) KV Helpers (Optimized)
// =========================================================

// Input validation helper
function validateInput(input, type, maxLength = null) {
  if (input == null) return false;
  
  switch (type) {
    case 'string':
      if (typeof input !== 'string') return false;
      if (maxLength && input.length > maxLength) return false;
      return true;
    case 'number':
      return !isNaN(Number(input)) && isFinite(Number(input));
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(input));
    case 'token':
      return /^[A-Za-z0-9]{6,32}$/.test(String(input));
    default:
      return true;
  }
}

// Sanitize input to prevent injection attacks
function sanitizeInput(input) {
  if (typeof input !== 'string') return input;
  // Do not strip HTML/Markdown characters; our bot constructs trusted templates.
  // Only remove unsafe control characters while preserving newlines and tabs.
  return input.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

// Normalize Persian/Arabic digits to ASCII digits
function normalizeDigits(str) {
  if (typeof str !== 'string') return str;
  const map = {
    '۰':'0','۱':'1','۲':'2','۳':'3','۴':'4','۵':'5','۶':'6','۷':'7','۸':'8','۹':'9',
    '٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9'
  };
  return str.replace(/[۰-۹٠-٩]/g, d => map[d] || d);
}

// Parse non-negative integer from user text with support for Persian digits and keywords
function parseNonNegativeInt(text) {
  const raw = String(text || '').trim();
  const norm = normalizeDigits(raw);
  // Support common keywords for unlimited
  const t = norm.toLowerCase();
  if (t === 'نامحدود' || t === 'infinite' || t === 'infinity' || t === 'unlimited' || t === '∞') return 0;
  const n = Number(norm.replace(/[^0-9]/g, ''));
  if (!Number.isFinite(n) || n < 0) return NaN;
  return n;
}

// Parse positive integer (>0). Returns NaN if invalid
function parsePositiveInt(text) {
  const n = parseNonNegativeInt(text);
  if (!Number.isFinite(n) || n <= 0) return NaN;
  return n;
}

async function kvGet(env, key, type = 'json') {
  if (!validateInput(key, 'string', 256)) {
    console.error('kvGet: Invalid key format', key);
    return null;
  }
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT);
    
    const v = await env.BOT_KV.get(key);
    clearTimeout(timeoutId);
    
    if (v == null) return null;
    if (type === 'json') {
      try { 
        return JSON.parse(v); 
      } catch (parseError) { 
        console.warn('kvGet: JSON parse failed for key', key, parseError.message);
        return null; 
      }
    }
    return v;
  } catch (e) {
    if (e.name === 'AbortError') {
      console.error('kvGet: Request timeout for key', key);
    } else {
      console.error('kvGet error', key, e.message);
    }
    return null;
  }
}

async function kvSet(env, key, value, type = 'json', ttlSeconds) {
  if (!validateInput(key, 'string', 256)) {
    console.error('kvSet: Invalid key format', key);
    return false;
  }
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT);
    
    let payload;
    if (type === 'json') {
      try {
        payload = JSON.stringify(value);
        // Check payload size (KV limit is 25MB, but we'll be conservative)
        if (payload.length > 10 * 1024 * 1024) { // 10MB limit
          console.error('kvSet: Payload too large for key', key);
          return false;
        }
      } catch (stringifyError) {
        console.error('kvSet: JSON stringify failed for key', key, stringifyError.message);
        return false;
      }
    } else {
      payload = String(value);
    }
    
    const options = ttlSeconds ? { expirationTtl: Math.max(60, Math.min(ttlSeconds, 2147483647)) } : {};
    await env.BOT_KV.put(key, payload, options);
    
    clearTimeout(timeoutId);
    return true;
  } catch (e) {
    if (e.name === 'AbortError') {
      console.error('kvSet: Request timeout for key', key);
    } else {
      console.error('kvSet error', key, e.message);
    }
    return false;
  }
}

async function kvDel(env, key) {
  if (!validateInput(key, 'string', 256)) {
    console.error('kvDel: Invalid key format', key);
    return false;
  }
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT);
    
    await env.BOT_KV.delete(key);
    clearTimeout(timeoutId);
    return true;
  } catch (e) {
    if (e.name === 'AbortError') {
      console.error('kvDel: Request timeout for key', key);
    } else {
      console.error('kvDel error', key, e.message);
    }
    return false;
  }
}

// =========================================================
// 3) Telegram Helpers (Optimized)
// =========================================================

// Rate limiting for Telegram API
const RATE_LIMITER = new Map();

// Simple in-memory lock to serialize critical sections per key (best-effort within a single worker instance)
const FILE_LOCKS = new Map();
async function withLock(key, fn, timeoutMs = 10000) {
  const start = Date.now();
  while (true) {
    if (!FILE_LOCKS.get(key)) {
      FILE_LOCKS.set(key, true);
      try {
        return await fn();
      } finally {
        FILE_LOCKS.delete(key);
      }
    }
    if (Date.now() - start > timeoutMs) throw new Error('lock_timeout_' + key);
    await new Promise(r => setTimeout(r, 10));
  }
}

function checkRateLimit(chatId, action = 'message') {
  const key = `${chatId}:${action}`;
  const now = Date.now();
  const limit = RATE_LIMITER.get(key);
  
  if (!limit) {
    RATE_LIMITER.set(key, { count: 1, resetTime: now + 60000 }); // 1 minute window
    return true;
  }
  
  if (now > limit.resetTime) {
    RATE_LIMITER.set(key, { count: 1, resetTime: now + 60000 });
    return true;
  }
  
  const maxRequests = action === 'message' ? 30 : 20; // Telegram limits
  if (limit.count >= maxRequests) {
    return false;
  }
  
  limit.count++;
  return true;
}

function tgApiUrl(method, env) {
  const token = env?.BOT_TOKEN;
  if (!token) {
    throw new Error('BOT_TOKEN is not configured');
  }
  return `https://api.telegram.org/bot${token}/${method}`;
}

async function tgSendMessage(env, chat_id, text, opts = {}) {
  // Input validation
  if (!validateInput(String(chat_id), 'string', 50)) {
    console.error('tgSendMessage: Invalid chat_id', chat_id);
    return null;
  }
  
  if (!validateInput(text, 'string', 4096)) {
    console.error('tgSendMessage: Invalid or too long text');
    return null;
  }
  
  // Rate limiting
  if (!checkRateLimit(chat_id, 'message')) {
    console.warn('tgSendMessage: Rate limit exceeded for chat', chat_id);
    return null;
  }
  
  try {
    // Sanitize text to prevent HTML injection
    const sanitizedText = sanitizeInput(text);
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT);
    
    const body = { 
      chat_id, 
      text: sanitizedText, 
      parse_mode: 'HTML', 
      ...opts 
    };
    
    const res = await fetch(tgApiUrl('sendMessage', env), {
      method: 'POST',
      headers: { 
        'content-type': 'application/json',
        'user-agent': `${CONFIG.BOT_NAME}/${CONFIG.BOT_VERSION}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!res.ok) {
      const errorText = await res.text();
      console.error('tgSendMessage: API error', res.status, errorText);
      return null;
    }
    
    return await res.json();
  } catch (e) {
    if (e.name === 'AbortError') {
      console.error('tgSendMessage: Request timeout');
    } else {
      console.error('tgSendMessage error', e.message);
    }
    return null;
  }
}

async function tgSendDocument(env, chat_id, file_id_or_url, opts = {}) {
  try {
    // ارسال سند با file_id یا URL
    const form = new FormData();
    form.set('chat_id', String(chat_id));
    // پشتیبانی از آپلود فایل Blob یا ارسال با file_id/URL
    if (file_id_or_url && typeof file_id_or_url === 'object' && (file_id_or_url.blob || (typeof Blob !== 'undefined' && file_id_or_url instanceof Blob))) {
      const blob = file_id_or_url.blob ? file_id_or_url.blob : file_id_or_url;
      const filename = file_id_or_url.filename || 'file.bin';
      form.set('document', blob, filename);
    } else if (typeof file_id_or_url === 'string' && file_id_or_url.startsWith('http')) {
      form.set('document', file_id_or_url);
    } else {
      form.set('document', String(file_id_or_url));
    }
    Object.entries(opts || {}).forEach(([k, v]) => {
      if (v != null) form.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    });
    const res = await fetch(tgApiUrl('sendDocument', env), { method: 'POST', body: form });
    return await res.json();
  } catch (e) {
    console.error('tgSendDocument error', e);
    return null;
  }
}

async function tgEditMessage(env, chat_id, message_id, text, opts = {}) {
  try {
    const body = { chat_id, message_id, text, parse_mode: 'HTML', ...opts };
    const res = await fetch(tgApiUrl('editMessageText', env), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    return await res.json();
  } catch (e) { console.error('tgEditMessage error', e); return null; }
}

async function tgAnswerCallbackQuery(env, callback_query_id, text = '', opts = {}) {
  try {
    const body = { callback_query_id, text, show_alert: false, ...opts };
    const res = await fetch(tgApiUrl('answerCallbackQuery', env), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    return await res.json();
  } catch (e) { console.error('tgAnswerCallbackQuery error', e); return null; }
}

async function tgGetFile(env, file_id) {
  try {
    const res = await fetch(tgApiUrl('getFile', env), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file_id })
    });
    return await res.json();
  } catch (e) { console.error('tgGetFile error', e); return null; }
}

function tgFileDirectUrl(env, file_path) {
  const token = env?.TELEGRAM_TOKEN || env?.BOT_TOKEN;
  return `https://api.telegram.org/file/bot${token}/${file_path}`;
}

// Get chat member (for mandatory join)
async function tgGetChatMember(env, chat_id, user_id) {
  try {
    const res = await fetch(tgApiUrl('getChatMember', env), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id, user_id })
    });
    return await res.json();
  } catch (e) { console.error('tgGetChatMember error', e); return null; }
}

// Mandatory join check utilities
function normalizeChannelToken(token) {
  const t = String(token || '').trim();
  if (!t) return '';
  // Accept @username, -100123..., full t.me/telegram.me links (including invite links)
  // Normalize as much as possible to a verifiable handle when public; otherwise keep URL
  if (t.startsWith('@') || t.startsWith('-100')) return t;
  // Bare username without @
  if (/^[A-Za-z0-9_]{5,}$/i.test(t)) return '@' + t;
  // Full links
  if (/^https?:\/\//i.test(t)) {
    try {
      const u = new URL(t);
      const host = u.hostname.replace(/^www\./, '').toLowerCase();
      const segs = (u.pathname || '').split('/').filter(Boolean);
      // t.me/<username> or telegram.me/<username>
      if ((host === 't.me' || host === 'telegram.me') && segs.length >= 1) {
        const seg0 = segs[0];
        // if joinchat or c/<id> or private invite, cannot verify — keep full URL for button only
        if (seg0.toLowerCase() === 'joinchat' || seg0.toLowerCase() === 'addstickers' || seg0.toLowerCase() === 'c') {
          return t;
        }
        // Otherwise treat as public username
        return '@' + seg0;
      }
      return t; // unknown host — keep as-is
    } catch {
      return t;
    }
  }
  return '@' + t;
}

async function buildJoinKb(env) {
  try {
    const s = await getSettings(env);
    const channels = (s?.join_channels && Array.isArray(s.join_channels) ? s.join_channels : [])
      .filter(Boolean);
    const rows = [];
    for (const chRaw of channels) {
      const ch = chRaw.trim();
      if (!ch) continue;
      // Build URL only when we can
      let url = '';
      if (ch.startsWith('http')) {
        url = ch;
      } else if (/^@/.test(ch)) {
        url = `https://t.me/${ch.replace(/^@/, '')}`;
      } else if (/^-100/.test(ch)) {
        // numeric id has no public URL; skip creating a button for it
        url = '';
      } else {
        url = `https://t.me/${ch}`;
      }
      if (!url) continue; // skip non-linkable entries
      // Hide channel usernames in label; link goes to channel URL
      rows.push([{ text: 'عضویت در کانال', url }]);
    }
    rows.push([{ text: '✅ بررسی عضویت', callback_data: 'join_check' }]);
    return { reply_markup: { inline_keyboard: rows } };
  } catch {
    return { reply_markup: { inline_keyboard: [[{ text: '✅ بررسی عضویت', callback_data: 'join_check' }]] } };
  }
}

// -------- Admin: Join management UI helpers -------- //
function admJoinManageKb(settings) {
  const arr = Array.isArray(settings?.join_channels) ? settings.join_channels : [];
  const rows = [];
  // List channels with edit/delete controls (two per row when possible)
  for (let i = 0; i < arr.length; i++) {
    const idx = i;
    const raw = String(arr[i] || '').trim();
    let label = raw;
    if (raw.startsWith('http')) {
      try {
        const u = new URL(raw);
        const host = u.hostname.replace(/^www\./, '').toLowerCase();
        const seg = (u.pathname || '').split('/').filter(Boolean)[0] || '';
        if ((host === 't.me' || host === 'telegram.me') && seg && seg.toLowerCase() !== 'joinchat' && seg.toLowerCase() !== 'c') {
          label = '@' + seg;
        } else {
          label = 'لینک دعوت/خصوصی (غیرقابل بررسی)';
        }
      } catch {
        label = 'لینک دعوت/خصوصی (غیرقابل بررسی)';
      }
    } else if (/^-100/.test(raw)) {
      label = `آیدی عددی: ${raw}`;
    } else if (!raw.startsWith('@')) {
      label = '@' + raw;
    }
    rows.push([
      { text: `${i + 1}) ${label}`, callback_data: `adm_join_edit:${idx}` },
      { text: '🗑 حذف', callback_data: `adm_join_del:${idx}` }
    ]);
  }
  rows.push([{ text: '➕ افزودن کانال', callback_data: 'adm_join_add' }]);
  if (arr.length) rows.push([{ text: '🧹 پاکسازی همه', callback_data: 'adm_join_clear' }]);
  rows.push([{ text: '🔙 بازگشت', callback_data: 'back_main' }]);
  return kb(rows);
}

function admJoinManageText(settings) {
  const arr = Array.isArray(settings?.join_channels) ? settings.join_channels : [];
  const list = arr.map((c, i) => `${i + 1}) ${c}`).join('\n');
  return `تنظیم جویین اجباری\nکانال‌های فعلی:${arr.length ? '\n' + list : ' —'}\n\n- برای افزودن: دکمه «افزودن کانال» را بزنید.\n- برای ویرایش/حذف: روی هر ردیف بزنید.`;
}

async function ensureJoinedChannels(env, uid, chat_id, silent = false) {
  try {
    const s = await getSettings(env);
    // Accept both array and comma-separated string configs
    let channels = [];
    if (Array.isArray(s?.join_channels)) {
      channels = s.join_channels.map(x => String(x || '').trim()).filter(Boolean);
    } else if (s?.join_channels) {
      channels = String(s.join_channels).split(',').map(x => x.trim()).filter(Boolean);
    }
    if (!channels.length) return true; // No mandatory channels configured

    // Prepare join keyboard once (avoid rebuilding it repeatedly)
    const joinKb = await buildJoinKb(env);
    // Try to check membership; if API fails, optionally show prompt
    for (const chRaw of channels) {
      try {
        // Support @username, -100id, or t.me links
        let chat = '';
        const ch = String(chRaw).trim();
        if (!ch) continue;
        if (ch.startsWith('http')) {
          // Attempt to extract username from t.me/<username>
          try {
            const u = new URL(ch);
            const host = u.hostname.replace(/^www\./, '');
            const seg = (u.pathname || '').split('/').filter(Boolean)[0] || '';
            if ((host === 't.me' || host === 'telegram.me') && seg && seg.toLowerCase() !== 'joinchat') {
              chat = '@' + seg;
            } else {
              // Private/Invite links cannot be verified by getChatMember
              chat = '';
            }
          } catch { chat = ''; }
        } else if (ch.startsWith('@') || /^-100/.test(ch)) {
          chat = ch;
        } else {
          chat = '@' + ch;
        }

        // If not verifiable, skip this entry
        if (!chat) continue;

        const res = await tgGetChatMember(env, chat, uid);
        const status = res?.result?.status;
        const isMember = status && !['left', 'kicked'].includes(status);
        if (!isMember) {
          if (!silent) {
            await tgSendMessage(env, chat_id, '📣 برای استفاده از ربات ابتدا عضو کانال‌های زیر شوید سپس دکمه «بررسی عضویت» را بزنید:', joinKb);
          }
          return false;
        }
      } catch (e) {
        // On temporary Telegram errors, avoid blocking; optionally show guide
        if (!silent) {
          await tgSendMessage(env, chat_id, '📣 برای استفاده از ربات ابتدا عضو کانال‌های زیر شوید سپس دکمه «بررسی عضویت» را بزنید:', joinKb);
        }
        return false;
      }
    }

    return true;
  } catch (e) {
    console.error('ensureJoinedChannels error', e);
    return true; // Fail-open to avoid blocking on unexpected errors
  }
}

// =========================================================
// 4) Utility Helpers (Optimized)
// =========================================================

// Cached formatters for better performance
const FORMATTERS = {
  persian: new Intl.NumberFormat('fa-IR'),
  english: new Intl.NumberFormat('en-US')
};

function nowTs() { return Math.floor(Date.now() / 1000); }

function fmtNum(n, locale = 'fa-IR') { 
  try { 
    const num = Number(n || 0);
    if (!isFinite(num)) return '0';
    return locale === 'fa-IR' ? FORMATTERS.persian.format(num) : FORMATTERS.english.format(num);
  } catch { 
    return String(n || 0); 
  } 
}

function safeJson(obj, fallback = '{}') { 
  try { 
    if (obj === null || obj === undefined) return fallback;
    return JSON.stringify(obj, null, 0); // No pretty printing for performance
  } catch { 
    return fallback; 
  } 
}

// Enhanced token generator with better entropy
function newToken(size = 26, charset = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789') {
  if (size <= 0 || size > 128) size = 26; // Reasonable limits
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => charset[byte % charset.length]).join('');
}

// Debounced function helper
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}
// Enhanced HTML escaping with more characters
const HTML_ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
  '/': '&#x2F;'
};

function htmlEscape(s) { 
  if (typeof s !== 'string') return String(s);
  return s.replace(/[&<>"'\/]/g, (c) => HTML_ESCAPE_MAP[c] || c); 
}

// Minimal MarkdownV2 escaper for Telegram
function mdv2Escape(s) {
  const str = String(s == null ? '' : s);
  return str.replace(/([_\*\[\]\(\)~`>#+\-=|{}\.!])/g, '\\$1');
}

// WireGuard helpers: generate a valid-looking base64 private key (32 bytes)
function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  // btoa is available in CF Workers/JS runtime
  return btoa(bin);
}
function generateWgPrivateKey() {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return bytesToBase64(buf);
}

// Generate a valid random filename (<=12 chars, [A-Za-z0-9_])
function genWgFilename() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_';
  let s = 'wg_';
  const remain = 10 - s.length; // ensure total <= 12
  for (let i = 0; i < remain; i++) {
    s += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return s;
}

// IP validators
function isIPv4(ip) {
  const m = String(ip || '').trim().match(/^(25[0-5]|2[0-4]\d|[01]?\d?\d)(\.(25[0-5]|2[0-4]\d|[01]?\d?\d)){3}$/);
  return !!m;
}
function isIPv6(ip) {
  // Simple IPv6 validation (covers compressed forms)
  const s = String(ip || '').trim();
  // Reject IPv4-like strings
  if (s.includes('.') && !s.includes(':')) return false;
  // Basic check: contains ':' and at least two hextets
  if (!s.includes(':')) return false;
  // Accept if it matches typical IPv6 patterns
  const re = /^([0-9A-Fa-f]{1,4}(:|::)){1,7}[0-9A-Fa-f]{0,4}$/;
  return re.test(s) || s === '::';
}

// =========================================================
// 5) Inline UI Helpers
// =========================================================
function kb(rows) { return { reply_markup: { inline_keyboard: rows } }; }

// Common inline keyboard: single button to go back to the main menu
function mainMenuInlineKb() {
  return kb([[{ text: '🏠 منوی اصلی', callback_data: 'back_main' }]]);
}

// Get current support URL from settings
async function getSupportUrl(env) {
  try {
    const s = await getSettings(env);
    return s?.support_url || 'https://t.me/NeoDebug';
  } catch { return 'https://t.me/NeoDebug'; }
}

// Build a keyboard with Support and Main Menu buttons using current settings
async function supportInlineKb(env) {
  const url = await getSupportUrl(env);
  return kb([
    [{ text: 'ارتباط با پشتیبانی', url }],
    [{ text: '🏠 منوی اصلی', callback_data: 'back_main' }]
  ]);
}

// Send a standard WIP (in development) message
async function sendWip(env, chat_id, feature = 'این بخش') {
  try { await tgSendMessage(env, chat_id, `🔧 ${feature} درحال توسعه است.`, await supportInlineKb(env)); } catch {}
}

// Send a standard not-available message
async function sendNotAvailable(env, chat_id, note = '❌ در حال حاضر موجود نیست.') {
  try { await tgSendMessage(env, chat_id, note, await supportInlineKb(env)); } catch {}
}

// ------------------ Custom purchasable buttons helpers ------------------ //
function buildCustomButtonsRowsCached(env) {
  try { return Array.isArray(env?.__cbtnRowsCache) ? env.__cbtnRowsCache : []; } catch { return []; }
}

async function rebuildCustomButtonsCache(env) {
  try {
    const s = await getSettings(env);
    let ids = Array.isArray(s?.custom_buttons) ? s.custom_buttons : [];
    // if market_sort is set to 'oldest' or 'newest', we ignore manual order and sort by created_at
    let items = [];
    if (s?.market_sort === 'oldest' || s?.market_sort === 'newest') {
      // load all, then sort
      const tmp = [];
      for (const id of ids) {
        const m = await kvGet(env, CONFIG.CUSTOMBTN_PREFIX + id);
        if (m && !m.disabled) tmp.push(m);
      }
      tmp.sort((a, b) => (Number(a.created_at||0) - Number(b.created_at||0)));
      if (s.market_sort === 'newest') tmp.reverse();
      items = tmp;
    } else {
      // manual order by ids
      for (const id of ids) {
        const m = await kvGet(env, CONFIG.CUSTOMBTN_PREFIX + id);
        if (m && !m.disabled) items.push(m);
      }
    }
    // Layout: single or paired
    const rows = [];
    const shortBuf = [];
    const isSingle = (it) => {
      if (it && typeof it.wide === 'boolean') return it.wide === true;
      const title = it?.title || '';
      return String(title).length > 12; // fallback heuristic
    };
    for (const it of items) {
      const btn = { text: String(it.title || '—'), callback_data: 'cbtn:' + it.id };
      if (isSingle(it)) {
        // flush short buffer first
        if (shortBuf.length === 1) rows.push([ shortBuf.pop() ]);
        if (shortBuf.length === 2) rows.push([ shortBuf.shift(), shortBuf.shift() ]);
        rows.push([ btn ]);
      } else {
        shortBuf.push(btn);
        if (shortBuf.length === 2) {
          rows.push([ shortBuf.shift(), shortBuf.shift() ]);
        }
      }
    }
    // flush remaining shorts
    if (shortBuf.length === 1) rows.push([ shortBuf.pop() ]);
    if (shortBuf.length === 2) rows.push([ shortBuf.shift(), shortBuf.shift() ]);
    env.__cbtnRowsCache = rows;
    return rows;
  } catch (e) { console.error('rebuildCustomButtonsCache error', e); env.__cbtnRowsCache = []; return []; }
}

function marketplaceKb(env) {
  const rows = buildCustomButtonsRowsCached(env).slice();
  rows.push([{ text: '🔙 بازگشت', callback_data: 'back_main' }]);
  return kb(rows);
}

function buildMarketplacePage(env, page = 1) {
  const allRows = buildCustomButtonsRowsCached(env).slice();
  // paginate by total buttons (not rows) with 12 buttons per page
  const pages = [];
  let curr = [];
  let count = 0;
  for (const row of allRows) {
    const rowCount = Array.isArray(row) ? row.length : 0;
    if (count + rowCount > 12 && curr.length) {
      pages.push(curr); curr = []; count = 0;
    }
    curr.push(row); count += rowCount;
  }
  if (curr.length) pages.push(curr);
  const total = Math.max(1, pages.length);
  const p = Math.min(Math.max(1, Number(page||1)), total);
  const rows = total ? pages[p-1] : [];
  // footer nav
  const nav = [];
  if (total > 1) {
    const prev = p > 1 ? p - 1 : total;
    const next = p < total ? p + 1 : 1;
    nav.push({ text: '◀️', callback_data: 'market:p:'+prev });
    nav.push({ text: `📄 ${p}/${total}`, callback_data: 'noop' });
    nav.push({ text: '▶️', callback_data: 'market:p:'+next });
  }
  const finalRows = rows.slice();
  if (nav.length) finalRows.push(nav);
  finalRows.push([{ text: '🔙 بازگشت', callback_data: 'back_main' }]);
  return { reply_markup: { inline_keyboard: finalRows } };
}

// Get OVPN price from settings with fallback
async function getOvpnPrice(env) {
  try {
    const s = await getSettings(env);
    if (s && s.ovpn_price_coins != null) return Number(s.ovpn_price_coins);
  } catch {}
  return Number(CONFIG.OVPN_PRICE_COINS || 5);
}

// Get DNS price from settings with fallback
async function getDnsPrice(env) {
  try {
    const s = await getSettings(env);
    if (s && s.dns_price_coins != null) return Number(s.dns_price_coins);
  } catch {}
  return Number(CONFIG.DNS_PRICE_COINS || 2);
}

// آیکون نوع فایل
function kindIcon(kind) {
  const k = String(kind || 'document');
  if (k === 'photo') return '🖼';
  if (k === 'video') return '🎬';
  if (k === 'audio') return '🎵';
  if (k === 'text') return '📝';
  return '📄';
}

// فهرست دکمه‌های کاربری (نه ادمین) با برچسب انسان‌خوان و callback_data
function getKnownUserButtons() {
  return [
    { label: '👤 حساب کاربری', data: 'account' },
    { label: '👥 زیرمجموعه‌گیری', data: 'referrals' },
    { label: '🎁 کد هدیه', data: 'giftcode' },
    { label: '💰 بازارچه', data: 'market' },
    { label: '🪙 خرید سکه', data: 'buy_coins' },
    { label: '🎟 ثبت تیکت', data: 'ticket_new' },
    { label: '🔙 بازگشت', data: 'back_main' },
  ];
}

// تشخیص ادمین از روی متغیرهای محیطی
function isAdminUser(env, uid) {
  try {
    const single = (env?.ADMIN_ID || '').trim();
    if (single && String(uid) === String(single)) return true;
    const list = (env?.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (list.length && list.includes(String(uid))) return true;
  } catch {}
  return false;
}

function getAdminChatIds(env) {
  const ids = [];
  try {
    const single = (env?.ADMIN_ID || '').trim();
    if (single) ids.push(String(single));
    const list = (env?.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
    for (const id of list) if (!ids.includes(String(id))) ids.push(String(id));
  } catch {}
  return ids;
}

function mainMenuKb(env, uid) {
  const rows = [
    [ { text: '👥 معرفی دوستان', callback_data: 'referrals' }, { text: '👤 حساب کاربری', callback_data: 'account' } ],
    [ { text: '🛡 دریافت سرور اختصاصی', callback_data: 'private_server' } ],
    [ { text: '🎁 کد هدیه', callback_data: 'giftcode' }, { text: '💰 بازارچه', callback_data: 'market' } ],
    [ { text: '🪙 خرید سکه', callback_data: 'buy_coins' } ],
  ];
  if (isAdminUser(env, uid)) {
    rows.push([ { text: '🛠 پنل ادمین', callback_data: 'admin' } ]);
  }
  return kb(rows);
}

function fmMenuKb() {
  return kb([
    [ { text: '📄 فایل‌های من', callback_data: 'myfiles' } ],
    [ { text: '🔙 بازگشت', callback_data: 'back_main' } ],
  ]);
}

function privateServerMenuKb() {
  return kb([
    [ { text: 'اوپن وی‌پی‌ان', callback_data: 'ps_openvpn' } ],
    [ { text: 'وایرگارد', callback_data: 'ps_wireguard' } ],
    [ { text: 'دی‌ان‌اس', callback_data: 'ps_dns' } ],
    [ { text: '🔙 بازگشت', callback_data: 'back_main' } ],
  ]);
}

function dnsMenuKb() {
  return kb([
    [ { text: 'نسل 4 (IPv4)', callback_data: 'ps_dns_v4' }, { text: 'نسل 6 (IPv6)', callback_data: 'ps_dns_v6' } ],
    [ { text: '🔙 بازگشت', callback_data: 'private_server' } ],
  ]);
}

function ovpnProtocolKb(prefix = '') {
  // prefix: '' for user flow, 'adm_' for admin flow
  const pre = prefix ? prefix : '';
  const rows = [
    [ { text: 'TCP', callback_data: `${pre}ovpn_proto:TCP` }, { text: 'UDP', callback_data: `${pre}ovpn_proto:UDP` } ],
    [ { text: '🔙 بازگشت', callback_data: prefix ? 'adm_service' : 'private_server' } ],
  ];
  if (prefix) rows.push([{ text: '🏠 منوی اصلی ربات', callback_data: 'back_main' }]);
  return kb(rows);
}

function ovpnLocationsKb(proto, prefix = '', opts = {}) {
  const pre = prefix ? prefix : '';
  const rows = [];
  const list = (opts && Array.isArray(opts.locations)) ? opts.locations : (CONFIG.OVPN_LOCATIONS || []);
  const flags = (opts && opts.flags) ? opts.flags : (CONFIG.OVPN_FLAGS || {});
  // Render locations two per row
  for (let i = 0; i < list.length; i += 2) {
    const loc1 = list[i];
    const loc2 = list[i + 1];
    const flag1 = (flags && flags[loc1]) ? flags[loc1] : '🌐';
    const row = [
      { text: `${flag1} ${loc1}`, callback_data: `${pre}ovpn_loc:${proto}:${loc1}` },
    ];
    if (loc2) {
      const flag2 = (flags && flags[loc2]) ? flags[loc2] : '🌐';
      row.push({ text: `${flag2} ${loc2}`, callback_data: `${pre}ovpn_loc:${proto}:${loc2}` });
    }
    rows.push(row);
  }
  rows.push([{ text: '🔙 بازگشت', callback_data: prefix ? 'adm_service' : 'ps_openvpn' }]);
  return kb(rows);
}

function adminMenuKb(settings) {
  const enabled = settings?.service_enabled !== false;
  const updating = settings?.update_mode === true;
  return kb([
    // Row 1: Update mode only
    [ { text: updating ? '🔧 حالت بروزرسانی: روشن' : '🔧 حالت بروزرسانی: خاموش', callback_data: 'adm_update_toggle' } ],
    // Row 2: Manage Files | Upload (upload on the right)
    [ { text: '🗂 مدیریت فایل‌ها', callback_data: 'fm' }, { text: '📤 بارگذاری فایل', callback_data: 'adm_upload' } ],
    // Row 3: Tickets | Gift Codes
    [ { text: '🎟 مدیریت تیکت‌ها', callback_data: 'adm_tickets' }, { text: '🎁 کدهای هدیه', callback_data: 'adm_gifts' } ],
    // Row 4: Service Settings (feature toggles)
    [ { text: '⚙️ تنظیمات سرویس', callback_data: 'adm_service' } ],
    // Row 5: Join Mandatory | Bot Stats
    [ { text: '📣 جویین اجباری', callback_data: 'adm_join' }, { text: '📊 آمار ربات', callback_data: 'adm_stats' } ],
    // Row 6: Subtract | Add Coins
    [ { text: '➖ کسر سکه', callback_data: 'adm_sub' }, { text: '➕ افزودن سکه', callback_data: 'adm_add' } ],
    // Row 7: Backup
    [ { text: '🧰 بکاپ دیتابیس', callback_data: 'adm_backup' } ],
    // Row 7: Help + Broadcast in same row
    [ { text: '📘 راهنما', callback_data: 'help' }, { text: '📢 پیام همگانی', callback_data: 'adm_broadcast' } ],
    // Row: Block/Unblock User with emojis (Unblock on left, Block on right)
    [ { text: 'انبلاک 📛', callback_data: 'adm_unblock' }, { text: 'بلاک ⛔️', callback_data: 'adm_block' } ],
    // Marketplace management
    [ { text: '🛒 مدیریت بازارچه', callback_data: 'adm_cbtn' } ],
    // Always show a button to go back to the bot main menu
    [ { text: '🏠 منوی اصلی ربات', callback_data: 'back_main' } ],
  ]);
}

// =========================================================
// 6) HTTP Entrypoints
// =========================================================
async function handleRoot(request, env) {
  // فقط وضعیت ربات را به صورت عمومی نمایش می‌دهیم
  try {
    const settings = await getSettings(env);
    const stats = await getStats(env);
    // Build env summary without leaking secrets
    const envSummary = {
      botTokenSet: Boolean(env?.BOT_TOKEN && env.BOT_TOKEN.length > 10),
      adminIdSet: Boolean((env?.ADMIN_ID || '').trim()),
      adminIdsSet: Boolean((env?.ADMIN_IDS || '').trim()),
      kvBound: Boolean(env?.BOT_KV),
    };
    return new Response(renderStatusPage(settings, stats, envSummary), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  } catch (e) {
    console.error('handleRoot error', e);
    return new Response('خطا', { status: 500 });
  }
}

// Handle incoming webhook requests from Telegram (Optimized)
async function handleWebhook(request, env, ctx) {
  // Only accept POST requests from Telegram
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  
  // Validate environment
  if (!env?.BOT_TOKEN) {
    console.error('handleWebhook: BOT_TOKEN is not set');
    return new Response('Configuration Error', { status: 500 });
  }
  
  // Validate content type
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    console.warn('handleWebhook: Invalid content type:', contentType);
    return new Response('Bad Request', { status: 400 });
  }
  
  // Parse and validate request body
  let update = null;
  try {
    const text = await request.text();
    if (!text || text.length > 1024 * 1024) { // 1MB limit
      console.warn('handleWebhook: Invalid body size');
      return new Response('Payload Too Large', { status: 413 });
    }
    update = JSON.parse(text);
  } catch (e) {
    console.error('handleWebhook: JSON parse error', e.message);
    return new Response('OK', { status: 200 }); // Return OK to avoid Telegram retries
  }
  
  // Validate update structure
  if (!update || typeof update !== 'object' || typeof update.update_id !== 'number') {
    console.warn('handleWebhook: Invalid update structure');
    return new Response('OK', { status: 200 });
  }
  try {
    const summary = {
      update_id: update.update_id,
      type: update.message ? 'message' : 
            update.callback_query ? 'callback' : 
            update.inline_query ? 'inline' : 'other',
      from: update.message?.from?.id || update.callback_query?.from?.id || 'unknown',
      chat: update.message?.chat?.id || update.callback_query?.message?.chat?.id || 'unknown',
      timestamp: Date.now()
    };
    
    console.log('Webhook received:', JSON.stringify(summary));
    
    // Rate limiting check
    if (summary.from !== 'unknown' && !checkRateLimit(summary.from, 'webhook')) {
      console.warn('handleWebhook: Rate limit exceeded for user', summary.from);
      return new Response('OK', { status: 200 });
    }
    
    // Process the update asynchronously to avoid blocking the webhook response
    if (ctx?.waitUntil) {
      ctx.waitUntil(processUpdateSafely(update, env, summary));
    } else {
      // Fallback for environments without waitUntil
      processUpdateSafely(update, env, summary).catch(error => {
        console.error('Background update processing failed:', error.message);
      });
    }
    
    return new Response('OK', { status: 200 });
  } catch (e) {
    console.error('handleWebhook: processing error', e.message);
    return new Response('OK', { status: 200 }); // Always return OK to Telegram
  }
}

// Safe wrapper for update processing
async function processUpdateSafely(update, env, summary) {
  try {
    await processUpdate(update, env);
    await bumpStat(env, 'updates_processed');
  } catch (error) {
    console.error('processUpdateSafely error:', error.message, 'Summary:', summary);
    await bumpStat(env, 'update_errors');
  }
}

async function handleFileDownload(request, env) {
  try {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean); // [ 'f', '<token>' ]
    const token = parts[1];
    const uid = url.searchParams.get('uid');
    const ref = url.searchParams.get('ref') || '';
    if (!token || !uid) return new Response('پارامتر ناقص', { status: 400 });

    const meta = await kvGet(env, CONFIG.FILE_PREFIX + token);
    if (!meta) return new Response('فایل یافت نشد', { status: 404 });
    if (meta.disabled) return new Response('این فایل غیرفعال است', { status: 403 });

    // اعتبارسنجی ساده referrer: اگر referrer_id تعیین شده باشد باید برابر باشد
    if (meta.referrer_id && meta.referrer_id !== ref) {
      return new Response('ارجاع نامعتبر', { status: 403 });
    }

    // ثبت آمار دانلود
    const dlKey = CONFIG.DOWNLOAD_LOG_PREFIX + token + ':' + nowTs();
    ctxlessWait(kvSet(env, dlKey, { uid, ref, ts: nowTs() }));

    // سیاست قیمت و محدودیت کاربران منحصربه‌فرد
    try {
      // اگر محدودیت تعریف شده
      const users = Array.isArray(meta.users) ? meta.users : [];
      const paidUsers = Array.isArray(meta.paid_users) ? meta.paid_users : [];
      const maxUsers = Number(meta.max_users || 0);
      const price = Number(meta.price || 0);
      const isOwner = String(meta.owner_id) === String(uid);
      const already = users.includes(String(uid));
      const alreadyPaid = paidUsers.includes(String(uid));
      // اگر فایل محدودیت دارد، همه (غیر از مالک) باید از ربات عبور کنند
      if (!isOwner && maxUsers > 0) {
        // برای فایل‌های محدود، همیشه به ربات هدایت کن
        const botUser = await getBotUsername(env);
        if (botUser) {
          const deep = `https://t.me/${botUser}?start=${token}`;
          return Response.redirect(deep, 302);
        }
        return new Response('برای دریافت این فایل ابتدا به ربات مراجعه کنید.', { status: 402 });
      }
      // اگر قیمت‌دار است و پرداخت نشده، به ربات هدایت کن
      if (!isOwner && price > 0 && !alreadyPaid) {
        const botUser = await getBotUsername(env);
        if (botUser) {
          const deep = `https://t.me/${botUser}?start=${token}`;
          return Response.redirect(deep, 302);
        }
        return new Response('برای دریافت این فایل ابتدا به ربات مراجعه کنید.', { status: 402 });
      }
    } catch (e) {
      console.error('pricing/limit enforcement error', e);
    }

    // دریافت لینکی به فایل تلگرام
    const gf = await tgGetFile(env, meta.file_id);
    const file_path = gf?.result?.file_path;
    if (!file_path) return new Response('امکان دریافت فایل نیست', { status: 500 });
    const directUrl = tgFileDirectUrl(env, file_path);
    return Response.redirect(directUrl, 302);
  } catch (e) {
    console.error('handleFileDownload error', e);
    return new Response('خطا', { status: 500 });
  }
}

// =========================================================
// 7) Features & Flows
// =========================================================
async function processUpdate(update, env) {
  try {
    // آمار پایه
    await bumpStat(env, 'updates');
    try { console.log('processUpdate dispatch: keys=', Object.keys(update || {})); } catch {}

    if (update.message) {
      return await onMessage(update.message, env);
    }
    if (update.callback_query) {
      return await onCallback(update.callback_query, env);
    }
    try { console.log('processUpdate: no handler path'); } catch {}
  } catch (e) {
    console.error('processUpdate error', e, safeJson(update));
  }
}

async function onMessage(msg, env) {
  try {
    const chat_id = msg.chat?.id;
    const from = msg.from || {};
    const uid = String(from.id);
    await ensureUser(env, uid, from);

    // Blocked user check
    try {
      const blocked = await isUserBlocked(env, uid);
      if (blocked) {
        const s = await getSettings(env);
        const url = s?.support_url || 'https://t.me/NeoDebug';
        const kbSupport = kb([[{ text: 'ارتباط با پشتیبانی', url }]]);
        await tgSendMessage(env, chat_id, '⛔️ دسترسی شما به ربات مسدود شده است. برای رفع مشکل با پشتیبانی تماس بگیرید.', kbSupport);
        return;
      }
      // (moved WG filename handler below)
    } catch {}

    // If update mode is on, block non-admin users globally
    try {
      const s = await getSettings(env);
      if (s?.update_mode === true && !isAdminUser(env, uid)) {
        await tgSendMessage(env, chat_id, '🛠️ ربات در حال بروزرسانی است. لطفاً بعداً تلاش کنید.', kb([[{ text: '🏠 منوی اصلی', callback_data: 'back_main' }]]));
        return;
      }
    } catch {}

    // دستورات متنی
    const text = msg.text || msg.caption || '';
    // Fetch state early (used to bypass join check for admin WG edit)
    const st = await getUserState(env, uid);

    // Mandatory join check (bypass for admins and during WG admin edit step)
    const isAdmMsg = isAdminUser(env, uid) || (st?.step === 'adm_wg_edit');
    const joined = isAdmMsg ? true : await ensureJoinedChannels(env, uid, chat_id);
    if (!joined) return; // A join prompt has been shown
    // User: WireGuard — ask for filename and send .conf (by country, random endpoint)
    if (st?.step === 'ps_wg_name' && (typeof st?.ep_idx === 'number' || st?.country)) {
      const name = String(text || '').trim();
      const valid = /^[A-Za-z0-9_]{1,12}$/.test(name);
      if (!valid) {
        await tgSendMessage(env, chat_id, '❌ نام نامعتبر است\n✔️ فقط حروف/اعداد/زیرخط و حداکثر ۱۲ کاراکتر\n⛔️ کاراکترهای غیرمجاز مانند - @ # $ مجاز نیستند\nلطفاً دوباره ارسال کنید:');
        return;
      }
      const s2 = await getSettings(env);
      const list = Array.isArray(s2?.wg_endpoints) ? s2.wg_endpoints : [];
      let ep = null;
      let idx = -1;
      if (st.country) {
        const pick = pickWgEndpointWithCapacity(list, st.country);
        if (!pick) { await clearUserState(env, uid); await tgSendMessage(env, chat_id, '❌ در این لوکیشن ظرفیت آزاد موجود نیست.'); return; }
        ep = pick; idx = Number(pick.__idx);
      } else {
        idx = Number(st.ep_idx);
        if (!(idx >= 0 && idx < list.length)) { await clearUserState(env, uid); await tgSendMessage(env, chat_id, '❌ Endpoint نامعتبر.'); return; }
        ep = list[idx];
      }
      const d = s2.wg_defaults || {};
      const { priv } = await generateWgKeypair();
      const lines = [];
      lines.push('[Interface]');
      lines.push(`PrivateKey = ${priv}`);
      // CIDR logic: random IP per config based on toggles
      let endpointHostport = ep.hostport;
      let addressLine = d.address || '';
      let dnsLine = d.dns || '';
      let cidrIp = null; let cidrMask = null;
      if (d.cidr_pool && typeof d.cidr_pool === 'string') {
        const parts = d.cidr_pool.split('/');
        if (parts.length === 2) {
          cidrMask = parts[1];
          const rnd = randomIPv4FromCIDR(d.cidr_pool);
          if (rnd) cidrIp = rnd;
        }
      }
      if (cidrIp) {
        if (d.cidr_apply_address && cidrMask) addressLine = `${cidrIp}/${cidrMask}`;
        if (d.cidr_apply_dns) dnsLine = cidrIp;
        if (d.cidr_apply_endpoint) {
          const lastColon = String(ep.hostport || '').lastIndexOf(':');
          if (lastColon > 0) {
            const port = ep.hostport.slice(lastColon + 1);
            endpointHostport = `${cidrIp}:${port}`;
          } else {
            endpointHostport = cidrIp;
          }
        }
      }
      if (addressLine) lines.push(`Address = ${addressLine}`);
      if (dnsLine) lines.push(`DNS = ${dnsLine}`);
      if (d.mtu) lines.push(`MTU = ${d.mtu}`);
      if (d.listen_port) lines.push(`ListenPort = ${d.listen_port}`);
      lines.push('');
      lines.push('[Peer]');
      {
        const serverPub = await getWgServerPublicKey(env, ep);
        if (serverPub) lines.push(`PublicKey = ${serverPub}`);
      }
      if (d.allowed_ips) lines.push(`AllowedIPs = ${d.allowed_ips}`);
      if (typeof d.persistent_keepalive === 'number' && d.persistent_keepalive >= 1 && d.persistent_keepalive <= 99) {
        lines.push(`PersistentKeepalive = ${d.persistent_keepalive}`);
      }
      lines.push(`Endpoint = ${endpointHostport}`);
      const cfg = lines.join('\n');
      const filename = `${name}.conf`;
      try {
        const blob = new Blob([cfg], { type: 'text/plain' });
        await tgSendDocument(env, chat_id, { blob, filename }, { caption: `📄 فایل کانفیگ WireGuard (${ep.country || ''})` });
      } catch (e) {
        console.error('tgSendDocument wg conf error', e);
        await tgSendMessage(env, chat_id, `⚠️ ارسال فایل ناموفق بود. می‌توانید متن زیر را ذخیره کنید با نام <code>${filename}</code>:\n<pre>${htmlEscape(cfg)}</pre>`);
      }
      // Save WG config for later resend (outside of send try/catch)
      try { await saveUserConfigItem(env, uid, 'wg', { filename, country: ep.country || '', content: cfg, dns: d.dns }); } catch {}
      // Inform about deduction (best-effort)
      try { await tgSendMessage(env, chat_id, `✅ ${fmtNum(price)} ${CONFIG.DEFAULT_CURRENCY} کسر شد. در حال ارسال کانفیگ...`); } catch {}
      if (idx >= 0) {
        s2.wg_endpoints[idx] = s2.wg_endpoints[idx] || {};
        const used = Number(s2.wg_endpoints[idx].used_count || 0) + 1;
        s2.wg_endpoints[idx].used_count = used;
        await setSettings(env, s2);
      }
      await clearUserState(env, uid);
      return;
    }
    // Admin: /who <user_id>
    if (text.startsWith('/who')) {
      if (!isAdminUser(env, uid)) { await tgSendMessage(env, chat_id, 'این دستور فقط برای مدیران است.'); return; }
      const parts = text.trim().split(/\s+/);
      const target = parts[1];
      if (!target || !/^\d+$/.test(target)) { await tgSendMessage(env, chat_id, 'کاربرد: /who <user_id>'); return; }
      const report = await buildUserReport(env, String(target));
      await tgSendMessage(env, chat_id, report);
      return;
    }
    if (text.startsWith('/start')) {
      await sendWelcome(chat_id, uid, env, msg);
      return;
    }
    if (text.startsWith('/update')) {
      await clearUserState(env, uid);
      await tgSendMessage(env, chat_id, await mainMenuHeader(env), mainMenuKb(env, uid));
      return;
    }

    // خرید: دریافت رسید پرداخت
    const stBuy = await getUserState(env, uid);
    if (stBuy?.step === 'buy_wait_receipt') {
      let mediaHandled = false;
      let caption = 'رسید پرداخت';
      const kbAdminInfo = kb([[ { text: '🔙 بازگشت', callback_data: 'back_main' } ]]);
      if (msg.photo && Array.isArray(msg.photo) && msg.photo.length) {
        const largest = msg.photo[msg.photo.length - 1];
        mediaHandled = true;
        // فوروارد برای ادمین‌ها با دکمه تایید/رد
        const purchaseId = stBuy.purchase_id || newToken(8);
        const p = {
          id: purchaseId,
          user_id: uid,
          coins: stBuy.coins,
          plan_id: stBuy.plan_id,
          amount_label: stBuy.amount_label,
          status: 'pending',
          ts: nowTs(),
        };
        p.admin_msgs = [];
        await kvSet(env, CONFIG.PURCHASE_PREFIX + purchaseId, p);
        const admins = getAdminChatIds(env);
        const adminKb = kb([[{ text: '✅ تایید و واریز', callback_data: 'buy_approve:' + purchaseId }, { text: '❌ رد', callback_data: 'buy_reject:' + purchaseId }]]);
        for (const aid of admins) {
          const res = await tgSendPhoto(env, aid, largest.file_id, { caption: buildPurchaseCaption(p), reply_markup: adminKb.reply_markup });
          const mid = res?.result?.message_id; if (mid) {
            p.admin_msgs.push({ chat_id: String(aid), message_id: mid });
            // Force caption to include explicit pending status (defensive update)
            try { await tgEditMessageCaption(env, String(aid), mid, buildPurchaseCaption(p), {}); } catch {}
          }
        }
        await kvSet(env, CONFIG.PURCHASE_PREFIX + purchaseId, p);
        await clearUserState(env, uid);
        await tgSendMessage(env, chat_id, 'رسید شما دریافت شد. در حال بررسی توسط پشتیبانی ✅', kbAdminInfo);
        return;
      }
      
      if (msg.document && msg.document.file_id) {
        mediaHandled = true;
        const purchaseId = stBuy.purchase_id || newToken(8);
        const p = {
          id: purchaseId,
          user_id: uid,
          coins: stBuy.coins,
          plan_id: stBuy.plan_id,
          amount_label: stBuy.amount_label,
          status: 'pending',
          ts: nowTs(),
        };
        p.admin_msgs = [];
        await kvSet(env, CONFIG.PURCHASE_PREFIX + purchaseId, p);
        const admins = getAdminChatIds(env);
        const adminKb = kb([[{ text: '✅ تایید و واریز', callback_data: 'buy_approve:' + purchaseId }, { text: '❌ رد', callback_data: 'buy_reject:' + purchaseId }]]);
        for (const aid of admins) {
          const res = await tgSendDocument(env, aid, msg.document.file_id, { caption: buildPurchaseCaption(p), reply_markup: adminKb.reply_markup });
          const mid = res?.result?.message_id; if (mid) {
            p.admin_msgs.push({ chat_id: String(aid), message_id: mid });
            // Force caption to include explicit pending status (defensive update)
            try { await tgEditMessageCaption(env, String(aid), mid, buildPurchaseCaption(p), {}); } catch {}
          }
        }
        await kvSet(env, CONFIG.PURCHASE_PREFIX + purchaseId, p);
        await clearUserState(env, uid);
        await tgSendMessage(env, chat_id, 'رسید شما دریافت شد. در حال بررسی توسط پشتیبانی ✅', kbAdminInfo);
        return;
      }
      await tgSendMessage(env, chat_id, 'لطفاً رسید را به صورت عکس یا فایل ارسال کنید.');
      return;
    }

    // دریافت فایل (Document/Photo/Video/Audio) در حالت آپلود ادمین
    if (msg.document || msg.photo || msg.video || msg.audio) {
      // بررسی فعال بودن سرویس
      const settings = await getSettings(env);
      const enabled = settings?.service_enabled !== false;
      if (!enabled) {
        await tgSendMessage(env, chat_id, 'سرویس موقتاً غیرفعال است. لطفاً بعداً تلاش کنید.', kb([[{ text: '🏠 منوی اصلی', callback_data: 'back_main' }]]));
        return;
      }
      
      // اگر ادمین در فلو آپلود است (پشتیبانی از فایل‌های مختلف)
      const st = await getUserState(env, uid);
      // Admin: OpenVPN upload flow (expects .ovpn as Document)
      if (isAdminUser(env, uid) && st?.step === 'adm_ovpn_wait_file') {
        if (msg.document && msg.document.file_id) {
          const proto = String((st.proto || '')).toUpperCase();
          const loc = String(st.loc || '');
          if (!['TCP','UDP'].includes(proto) || !loc) {
            await clearUserState(env, uid);
            await tgSendMessage(env, chat_id, 'خطا در اطلاعات پروتکل/لوکیشن. از ابتدا تلاش کنید.');
            return;
          }
          const key = CONFIG.OVPN_PREFIX + `${proto}:${loc}`;
          const meta = {
            proto,
            loc,
            file_id: msg.document.file_id,
            file_name: msg.document.file_name || 'config.ovpn',
            file_size: msg.document.file_size || 0,
            mime_type: msg.document.mime_type || 'application/octet-stream',
            uploader_id: uid,
            ts: nowTs(),
          };
          await kvSet(env, key, meta);
          await clearUserState(env, uid);
          await tgSendMessage(env, chat_id, `✅ کانفیگ اوپن وی‌پی‌ان ذخیره شد.\n${loc} (${proto})`);
          return;
        }
        // Admin: WireGuard defaults editing (generic)
        if (st?.step === 'adm_wg_edit' && st?.field) {
          const field = String(st.field);
          const valRaw = String(text || '').trim();
          const valNumRaw = normalizeDigits(valRaw);
          const s = await getSettings(env);
          s.wg_defaults = s.wg_defaults || {};
          if (field === 'mtu') {
            const v = Number(valNumRaw.replace(/[^0-9]/g, ''));
            if (!Number.isFinite(v) || v <= 0) { await tgSendMessage(env, chat_id, '❌ مقدار نامعتبر است. یک عدد صحیح ارسال کنید:'); return; }
            s.wg_defaults.mtu = v;
          } else if (field === 'listen_port') {
            const v = Number(valNumRaw.replace(/[^0-9]/g, ''));
            s.wg_defaults.listen_port = v || undefined;
          } else if (field === 'address') {
            s.wg_defaults.address = valRaw;
          } else if (field === 'dns') {
            s.wg_defaults.dns = valRaw;
          } else if (field === 'allowed_ips') {
            s.wg_defaults.allowed_ips = valRaw;
          } else if (field === 'persistent_keepalive') {
            const v = Number(valNumRaw.replace(/[^0-9]/g, ''));
            s.wg_defaults.persistent_keepalive = (v && v > 0) ? v : undefined;
          } else if (field === 'peer_public_mode') {
            const mode = valRaw.toLowerCase();
            if (!['cloudflare','endpoint','custom'].includes(mode)) { await tgSendMessage(env, chat_id, '❌ حالت نامعتبر است. یکی از این‌ها: cloudflare | endpoint | custom'); return; }
            s.wg_defaults.peer_public_mode = mode;
          } else if (field === 'peer_public_key') {
            // basic validation for base64 length
            if (valRaw && valRaw.length < 30) { await tgSendMessage(env, chat_id, '❌ کلید نامعتبر است. مقدار Base64 صحیح ارسال کنید.'); return; }
            s.wg_defaults.peer_public_key = valRaw;
          } else {
            await tgSendMessage(env, chat_id, 'فیلد ناشناخته.');
            return;
          }
          await setSettings(env, s);
          // Re-fetch to confirm persisted values and show back to admin
          const fresh = await getSettings(env);
          const cur = fresh?.wg_defaults || {};
          await clearUserState(env, uid);
          
          // Show updated value with proper formatting
          const displayValue = formatWgDefaultValue(field, cur[field]);
          
          // Debug log to ensure settings are saved
          console.log(`WireGuard ${field} updated:`, cur[field]);
          
          await tgSendMessage(env, chat_id, `✅ تنظیمات WireGuard به‌روزرسانی شد!\n\n📝 فیلد: ${field}\n💾 مقدار جدید: ${displayValue}\n\n🔄 تغییرات در منوی تنظیمات قابل مشاهده است.`, kb([[{ text: '🔙 بازگشت به تنظیمات', callback_data: 'adm_wg_defaults' }]]));
          return;
        }
        await tgSendMessage(env, chat_id, 'لطفاً فایل .ovpn را به صورت سند (Document) ارسال کنید.');
        return;
      }
      if (isAdminUser(env, uid) && st?.step === 'adm_upload_wait_file') {
        let tmp = null;
        if (msg.document) {
          tmp = {
            kind: 'document',
            file_id: msg.document.file_id,
            file_name: msg.document.file_name || 'file',
            file_size: msg.document.file_size || 0,
            mime_type: msg.document.mime_type || 'application/octet-stream',
          };
        } else if (msg.photo && msg.photo.length) {
          const largest = msg.photo[msg.photo.length - 1];
          tmp = { kind: 'photo', file_id: largest.file_id, file_name: 'photo', file_size: largest.file_size || 0, mime_type: 'image/jpeg' };
        } else if (msg.video) {
          tmp = { kind: 'video', file_id: msg.video.file_id, file_name: msg.video.file_name || 'video', file_size: msg.video.file_size || 0, mime_type: msg.video.mime_type || 'video/mp4' };
        } else if (msg.audio) {
          tmp = { kind: 'audio', file_id: msg.audio.file_id, file_name: msg.audio.file_name || 'audio', file_size: msg.audio.file_size || 0, mime_type: msg.audio.mime_type || 'audio/mpeg' };
        }
        if (!tmp) { await tgSendMessage(env, chat_id, 'نوع فایل پشتیبانی نمی‌شود.'); return; }
        await setUserState(env, uid, { step: 'adm_upload_price', tmp });
        await tgSendMessage(env, chat_id, '💰 قیمت فایل به سکه را ارسال کنید (مثلاً 10):');
        return;
      }
      // Admin: Replace content — handle media replacement
      if (isAdminUser(env, uid) && st?.step === 'adm_cbtn_replace_wait' && st?.id) {
        let tmp = null;
        if (msg.document) {
          tmp = { kind: 'document', file_id: msg.document.file_id, file_name: msg.document.file_name || 'file', file_size: msg.document.file_size || 0, mime_type: msg.document.mime_type || 'application/octet-stream' };
        } else if (msg.photo && msg.photo.length) {
          const largest = msg.photo[msg.photo.length - 1];
          tmp = { kind: 'photo', file_id: largest.file_id, file_name: 'photo', file_size: largest.file_size || 0, mime_type: 'image/jpeg' };
        } else if (msg.video) {
          tmp = { kind: 'video', file_id: msg.video.file_id, file_name: msg.video.file_name || 'video', file_size: msg.video.file_size || 0, mime_type: msg.video.mime_type || 'video/mp4' };
        } else if (msg.audio) {
          tmp = { kind: 'audio', file_id: msg.audio.file_id, file_name: msg.audio.file_name || 'audio', file_size: msg.audio.file_size || 0, mime_type: msg.audio.mime_type || 'audio/mpeg' };
        }
        if (!tmp) { await tgSendMessage(env, chat_id, '❌ نوع فایل پشتیبانی نمی‌شود. برای متن، خود متن را ارسال کنید.'); return; }
        const id = st.id;
        const m = await kvGet(env, CONFIG.CUSTOMBTN_PREFIX + id);
        if (!m) { await clearUserState(env, uid); await tgSendMessage(env, chat_id, '❌ دکمه یافت نشد.'); return; }
        m.kind = tmp.kind;
        m.file_id = tmp.file_id; m.file_name = tmp.file_name; m.file_size = tmp.file_size; m.mime_type = tmp.mime_type; m.text = undefined;
        await kvSet(env, CONFIG.CUSTOMBTN_PREFIX + id, m);
        await clearUserState(env, uid);
        await rebuildCustomButtonsCache(env);
        await tgSendMessage(env, chat_id, '✅ محتوا جایگزین شد.', mainMenuInlineKb());
        return;
      }
      if (isAdminUser(env, uid) && st?.step === 'adm_cbtn_wait_file') {
        let tmp = null;
        if (msg.document) {
          tmp = {
            kind: 'document',
            file_id: msg.document.file_id,
            file_name: msg.document.file_name || 'file',
            file_size: msg.document.file_size || 0,
            mime_type: msg.document.mime_type || 'application/octet-stream',
          };
        } else if (msg.photo && msg.photo.length) {
          const largest = msg.photo[msg.photo.length - 1];
          tmp = { kind: 'photo', file_id: largest.file_id, file_name: 'photo', file_size: largest.file_size || 0, mime_type: 'image/jpeg' };
        } else if (msg.video) {
          tmp = { kind: 'video', file_id: msg.video.file_id, file_name: msg.video.file_name || 'video', file_size: msg.video.file_size || 0, mime_type: msg.video.mime_type || 'video/mp4' };
        } else if (msg.audio) {
          tmp = { kind: 'audio', file_id: msg.audio.file_id, file_name: msg.audio.file_name || 'audio', file_size: msg.audio.file_size || 0, mime_type: msg.audio.mime_type || 'audio/mpeg' };
        }
        if (!tmp) { await tgSendMessage(env, chat_id, 'نوع فایل پشتیبانی نمی‌شود. برای متن، خود متن را ارسال کنید.'); return; }
        await setUserState(env, uid, { step: 'adm_cbtn_title', tmp });
        await tgSendMessage(env, chat_id, '📝 عنوان دکمه را ارسال کنید:');
        return;
      }

      // در حالت عادی (آپلود کاربر عادی با Document و ...)
      if (msg.document && !isAdminUser(env, uid)) {
        const token = newToken(6);
        const meta = {
          token,
          owner_id: uid,
          file_id: msg.document.file_id,
          file_name: msg.document.file_name || 'file',
          file_size: msg.document.file_size || 0,
          mime_type: msg.document.mime_type || 'application/octet-stream',
          created_at: nowTs(),
          referrer_id: extractReferrerFromStartParam(msg) || '',
          disabled: false,
          price: 0,
          max_users: 0,
          users: [],
        };
        await kvSet(env, CONFIG.FILE_PREFIX + token, meta);
        await bumpStat(env, 'files');
        const botUser = await getBotUsername(env);
        const deepLink = botUser ? `https://t.me/${botUser}?start=${token}` : '';
        await tgSendMessage(env, chat_id, `فایل شما ذخیره شد ✅\nنام: <b>${htmlEscape(meta.file_name)}</b>\nحجم: <b>${fmtNum(meta.file_size)} بایت</b>\n\nتوکن دریافت: <code>${token}</code>${deepLink ? `\nلینک دعوت دریافت در ربات: <code>${deepLink}</code>` : ''}`);
        return;
      }
    }

    // سایر متن‌ها → نمایش منو و مدیریت stateها
    if (text) {
      // Handle stateful flows for giftcode/redeem
      const state = await getUserState(env, uid);
      if (isAdminUser(env, uid) && state?.step === 'adm_cbtn_wait_file') {
        // Admin provided text content for custom button
        const tmp = { kind: 'text', text: String(text || '') };
        await setUserState(env, uid, { step: 'adm_cbtn_title', tmp });
        await tgSendMessage(env, chat_id, '📝 عنوان دکمه را ارسال کنید:');
        return;
      }
      // Admin upload flow (generic): allow plain text/link as a content type
      if (isAdminUser(env, uid) && state?.step === 'adm_upload_wait_file') {
        const tmp = { kind: 'text', text: String(text || '') };
        await setUserState(env, uid, { step: 'adm_upload_price', tmp });
        await tgSendMessage(env, chat_id, '💰 قیمت فایل به سکه را ارسال کنید (مثلاً 10):');
        return;
      }
      if (state?.step === 'giftcode_wait') {
        // Backward-compatible: treat like gift_redeem_wait
        const code = String((text||'').trim());
        const g = await kvGet(env, CONFIG.GIFT_PREFIX + code);
        if (!g) { await tgSendMessage(env, chat_id, '❌ کد هدیه نامعتبر است.'); return; }
        const usedBy = Array.isArray(g.used_by) ? g.used_by : [];
        if (usedBy.includes(uid)) { await tgSendMessage(env, chat_id, 'شما قبلاً از این کد استفاده کرده‌اید.'); return; }
        const max = Number(g.max_uses || 0);
        if (max > 0 && usedBy.length >= max) { await tgSendMessage(env, chat_id, 'سقف استفاده از این کد تکمیل شده است.'); return; }
        const ok = await creditBalance(env, uid, Number(g.amount || 0));
        if (!ok) { await tgSendMessage(env, chat_id, 'خطا در اعمال کد.'); return; }
        usedBy.push(uid); g.used_by = usedBy;
        await kvSet(env, CONFIG.GIFT_PREFIX + code, g);
        await tgSendMessage(env, chat_id, `✅ کد هدیه اعمال شد. ${fmtNum(g.amount)} ${CONFIG.DEFAULT_CURRENCY} به حساب شما افزوده شد.`);
        await clearUserState(env, uid);
        return;
      }
      if (state?.step === 'redeem_token_wait') {
        const token = text.trim();
        await handleTokenRedeem(env, uid, chat_id, token);
        return;
      }
      if (state?.step === 'ticket_wait') {
        const content = text.trim();
        const ttype = state?.type || 'general';
        await createTicket(env, uid, content, ttype);
        await tgSendMessage(env, chat_id, '✅ تیکت شما ثبت شد.');
        await clearUserState(env, uid);
        return;
      }
      if (isAdminUser(env, uid) && state?.step === 'adm_upload_price') {
        const amount = Number(text.replace(/[^0-9]/g, ''));
        const tmp = state.tmp || {};
        // Accept media (with file_id) or plain text (kind === 'text')
        if (!tmp.file_id && tmp.kind !== 'text') { await clearUserState(env, uid); await tgSendMessage(env, chat_id, 'خطا. دوباره تلاش کنید.'); return; }
        await setUserState(env, uid, { step: 'adm_upload_limit', tmp, price: amount >= 0 ? amount : 0 });
        await tgSendMessage(env, chat_id, '🔢 محدودیت تعداد دریافت‌کنندگان یکتا را ارسال کنید (مثلاً 2). برای بدون محدودیت 0 بفرستید:');
        return;
      }
      // Admin: Custom Button — after receiving media/text, ask for title
      if (isAdminUser(env, uid) && state?.step === 'adm_cbtn_title') {
        const title = String(text || '').trim();
        if (!title) { await tgSendMessage(env, chat_id, '❌ عنوان نامعتبر است. دوباره ارسال کنید:'); return; }
        await setUserState(env, uid, { step: 'adm_cbtn_price', tmp: state.tmp, title });
        await tgSendMessage(env, chat_id, '💰 قیمت به سکه برای این دکمه را ارسال کنید (مثلاً 5):');
        return;
      }
      if (isAdminUser(env, uid) && state?.step === 'adm_cbtn_price') {
        const price = Number(text.replace(/[^0-9]/g, ''));
        const tmp = state.tmp || {};
        const title = String(state.title || '').trim();
        if (!title || (!tmp.file_id && tmp.kind !== 'text')) { await clearUserState(env, uid); await tgSendMessage(env, chat_id, '❌ خطا. از ابتدا تلاش کنید.'); return; }
        await setUserState(env, uid, { step: 'adm_cbtn_limit', tmp, title, price: price >= 0 ? price : 0 });
        await tgSendMessage(env, chat_id, '👥 محدودیت تعداد دریافت‌کنندگان یکتا را ارسال کنید (برای بدون محدودیت 0 بفرستید):');
        return;
      }
      if (isAdminUser(env, uid) && state?.step === 'adm_cbtn_limit') {
        const maxUsersVal = parseNonNegativeInt(text);
        if (!Number.isFinite(maxUsersVal)) { await tgSendMessage(env, chat_id, '❌ عدد نامعتبر است. یک عدد صحیح یا "نامحدود" ارسال کنید:'); return; }
        const tmp = state.tmp || {};
        const title = String(state.title || '').trim();
        const price = Number(state.price || 0);
        if (!title || (!tmp.file_id && tmp.kind !== 'text')) { await clearUserState(env, uid); await tgSendMessage(env, chat_id, '❌ خطا. از ابتدا تلاش کنید.'); return; }
        const id = newToken(8);
        const meta = {
          id,
          title,
          price: price >= 0 ? price : 0,
          kind: tmp.kind || 'document',
          file_id: tmp.file_id,
          file_name: tmp.file_name || (tmp.kind === 'text' ? 'text' : (tmp.kind || 'file')),
          file_size: tmp.file_size,
          mime_type: tmp.mime_type,
          text: tmp.kind === 'text' ? (tmp.text || '') : undefined,
          created_at: nowTs(),
          disabled: false,
          paid_users: [],
          users: [],
          max_users: maxUsersVal >= 0 ? maxUsersVal : 0,
        };
        await kvSet(env, CONFIG.CUSTOMBTN_PREFIX + id, meta);
        const s = await getSettings(env);
        const list = Array.isArray(s.custom_buttons) ? s.custom_buttons : [];
        if (!list.includes(id)) list.push(id);
        s.custom_buttons = list;
        await setSettings(env, s);
        await clearUserState(env, uid);
        await rebuildCustomButtonsCache(env);
        await tgSendMessage(env, chat_id, `✅ دکمه افزوده شد: <b>${htmlEscape(title)}</b> — قیمت: <b>${fmtNum(meta.price)}</b> ${CONFIG.DEFAULT_CURRENCY}\nمحدودیت یکتا: <b>${fmtNum(meta.max_users)}</b>`, mainMenuInlineKb());
        return;
      }
      if (isAdminUser(env, uid) && state?.step === 'adm_cbtn_price_change' && state?.id) {
        const id = state.id;
        const m = await kvGet(env, CONFIG.CUSTOMBTN_PREFIX + id);
        const price = Number(text.replace(/[^0-9]/g, ''));
        if (m) { m.price = price >= 0 ? price : 0; await kvSet(env, CONFIG.CUSTOMBTN_PREFIX + id, m); }
        await clearUserState(env, uid);
        await rebuildCustomButtonsCache(env);
        await tgSendMessage(env, chat_id, '✅ قیمت بروزرسانی شد.', mainMenuInlineKb());
        return;
      }
      if (isAdminUser(env, uid) && state?.step === 'adm_cbtn_limit_change' && state?.id) {
        const id = state.id;
        const m = await kvGet(env, CONFIG.CUSTOMBTN_PREFIX + id);
        const maxUsersVal = parseNonNegativeInt(text);
        if (!Number.isFinite(maxUsersVal)) { await tgSendMessage(env, chat_id, '❌ عدد نامعتبر است. یک عدد صحیح یا "نامحدود" ارسال کنید:'); return; }
        if (m) { m.max_users = maxUsersVal >= 0 ? maxUsersVal : 0; await kvSet(env, CONFIG.CUSTOMBTN_PREFIX + id, m); }
        await clearUserState(env, uid);
        await tgSendMessage(env, chat_id, '✅ محدودیت بروزرسانی شد.', mainMenuInlineKb());
        return;
      }
      if (isAdminUser(env, uid) && state?.step === 'adm_cbtn_replace_wait' && state?.id) {
        const id = state.id;
        let tmp = null;
        if (msg && msg.document) {
          tmp = { kind: 'document', file_id: msg.document.file_id, file_name: msg.document.file_name || 'file', file_size: msg.document.file_size || 0, mime_type: msg.document.mime_type || 'application/octet-stream' };
        } else if (msg && msg.photo && msg.photo.length) {
          const largest = msg.photo[msg.photo.length - 1];
          tmp = { kind: 'photo', file_id: largest.file_id, file_name: 'photo', file_size: largest.file_size || 0, mime_type: 'image/jpeg' };
        } else if (msg && msg.video) {
          tmp = { kind: 'video', file_id: msg.video.file_id, file_name: msg.video.file_name || 'video', file_size: msg.video.file_size || 0, mime_type: msg.video.mime_type || 'video/mp4' };
        } else if (msg && msg.audio) {
          tmp = { kind: 'audio', file_id: msg.audio.file_id, file_name: msg.audio.file_name || 'audio', file_size: msg.audio.file_size || 0, mime_type: msg.audio.mime_type || 'audio/mpeg' };
        } else if (text) {
          tmp = { kind: 'text', text: String(text || '') };
        }
        if (!tmp) { await tgSendMessage(env, chat_id, '❌ نوع محتوا پشتیبانی نمی‌شود. دوباره تلاش کنید:'); return; }
        const m = await kvGet(env, CONFIG.CUSTOMBTN_PREFIX + id);
        if (!m) { await clearUserState(env, uid); await tgSendMessage(env, chat_id, '❌ دکمه یافت نشد.'); return; }
        // Replace only content-related fields
        m.kind = tmp.kind;
        if (tmp.kind === 'text') {
          m.text = tmp.text || '';
          m.file_id = undefined; m.file_name = undefined; m.file_size = undefined; m.mime_type = undefined;
        } else {
          m.file_id = tmp.file_id; m.file_name = tmp.file_name; m.file_size = tmp.file_size; m.mime_type = tmp.mime_type;
          m.text = undefined;
        }
        await kvSet(env, CONFIG.CUSTOMBTN_PREFIX + id, m);
        await clearUserState(env, uid);
        await rebuildCustomButtonsCache(env);
        await tgSendMessage(env, chat_id, '✅ محتوا جایگزین شد.', mainMenuInlineKb());
        return;
      }
      if (isAdminUser(env, uid) && state?.step === 'adm_upload_limit') {
        const maxUsers = parseNonNegativeInt(text);
        if (!Number.isFinite(maxUsers)) { await tgSendMessage(env, chat_id, '❌ عدد نامعتبر است. یک عدد صحیح یا "نامحدود" ارسال کنید:'); return; }
        const tmp = state.tmp || {};
        const price = Number(state.price || 0);
        const token = newToken(6);
        const meta = {
          token,
          owner_id: uid,
          kind: tmp.kind || 'document',
          file_id: tmp.file_id,
          file_name: tmp.file_name || (tmp.kind === 'text' ? 'text' : (tmp.kind || 'file')),
          file_size: tmp.file_size,
          mime_type: tmp.mime_type,
          text: tmp.kind === 'text' ? (tmp.text || '') : undefined,
          created_at: nowTs(),
          referrer_id: extractReferrerFromStartParam(msg) || '',
          disabled: false,
          price: price >= 0 ? price : 0,
          max_users: maxUsers >= 0 ? maxUsers : 0,
          users: [],
        };
        await kvSet(env, CONFIG.FILE_PREFIX + token, meta);
        await clearUserState(env, uid);
        const botUser = await getBotUsername(env);
        const deepLink = botUser ? `https://t.me/${botUser}?start=${token}` : '';
        await tgSendMessage(env, chat_id, `✅ فایل با موفقیت ثبت شد.\nنام: <b>${htmlEscape(meta.file_name)}</b>\nقیمت: <b>${fmtNum(meta.price)}</b> ${CONFIG.DEFAULT_CURRENCY}\nمحدودیت یکتا: <b>${meta.max_users||0}</b>\nتوکن دریافت: <code>${token}</code>${deepLink ? `\nلینک دعوت دریافت در ربات: <code>${deepLink}</code>` : ''}` , buildFileAdminKb(meta));
        return;
      }
      // Admin flows
      if (isAdminUser(env, uid)) {
        // Admin: change support URL/ID
        if (state?.step === 'adm_support_url') {
          let val = String(text || '').trim();
          if (!val) { await tgSendMessage(env, chat_id, '❌ مقدار نامعتبر است. دوباره ارسال کنید یا /update برای لغو.'); return; }
          let url = '';
          if (/^https?:\/\//i.test(val)) url = val;
          else if (val.startsWith('@')) url = `https://t.me/${val.replace(/^@/, '')}`;
          else url = `https://t.me/${val}`;
          const s = await getSettings(env);
          s.support_url = url;
          await setSettings(env, s);
          await clearUserState(env, uid);
          await tgSendMessage(env, chat_id, `✅ آدرس پشتیبانی ثبت شد: ${url}`, mainMenuInlineKb());
          return;
        }
        // Admin: set default prices (OpenVPN/DNS)
        if (state?.step === 'adm_set_price' && state?.key) {
          const amountParsed = parseNonNegativeInt(text);
          if (!Number.isFinite(amountParsed)) { await tgSendMessage(env, chat_id, 'عدد نامعتبر است. یک مقدار عددی ارسال کنید:'); return; }
          const s = await getSettings(env);
          if (state.key === 'ovpn') s.ovpn_price_coins = amountParsed;
          if (state.key === 'dns') s.dns_price_coins = amountParsed;
          await setSettings(env, s);
          await clearUserState(env, uid);
          await tgSendMessage(env, chat_id, '✅ قیمت ذخیره شد.', mainMenuInlineKb());
          return;
        }
        // Admin: Basic settings — card number
        if (state?.step === 'adm_card_number') {
          const raw = String(text || '').trim();
          const normalized = raw.replace(/[^0-9\s]/g, '');
          if (!/^[0-9\s]{8,30}$/.test(normalized)) { await tgSendMessage(env, chat_id, '❌ شماره کارت نامعتبر است. فقط ارقام و فاصله مجاز است. دوباره ارسال کنید:'); return; }
          const s = await getSettings(env);
          s.card_info = s.card_info || {};
          s.card_info.card_number = normalized;
          await setSettings(env, s);
          await clearUserState(env, uid);
          await tgSendMessage(env, chat_id, '✅ شماره کارت ذخیره شد.', mainMenuInlineKb());
          return;
        }
        // Admin: Basic settings — card holder name
        if (state?.step === 'adm_card_name') {
          const name = String(text || '').trim();
          if (!name || name.length < 2) { await tgSendMessage(env, chat_id, '❌ نام نامعتبر است. دوباره ارسال کنید:'); return; }
          const s = await getSettings(env);
          s.card_info = s.card_info || {};
          s.card_info.holder_name = name;
          await setSettings(env, s);
          await clearUserState(env, uid);
          await tgSendMessage(env, chat_id, '✅ نام دارنده کارت ذخیره شد.', mainMenuInlineKb());
          return;
        }
        // Admin: Plans — add
        if (state?.step === 'adm_plan_add_coins') {
          const coins = parsePositiveInt(text);
          if (!Number.isFinite(coins)) { await tgSendMessage(env, chat_id, '❌ مقدار نامعتبر است. یک عدد مثبت ارسال کنید:'); return; }
          await setUserState(env, uid, { step: 'adm_plan_add_price', coins });
          await tgSendMessage(env, chat_id, 'برچسب قیمت پلن جدید را ارسال کنید (مثلاً ۱۵٬۰۰۰ تومان):');
          return;
        }
        if (state?.step === 'adm_plan_add_price' && state?.coins) {
          const price_label = String(text || '').trim();
          if (!price_label) { await tgSendMessage(env, chat_id, '❌ برچسب نامعتبر است. دوباره ارسال کنید:'); return; }
          const s = await getSettings(env);
          const plans = Array.isArray(s?.plans) ? s.plans : [];
          const id = 'p' + Date.now();
          plans.push({ id, coins: Number(state.coins), price_label });
          s.plans = plans;
          await setSettings(env, s);
          await clearUserState(env, uid);
          // Send refreshed plans list to confirm change
          const rows = [];
          for (let i = 0; i < plans.length; i++) {
            const p = plans[i];
            rows.push([
              { text: `${i + 1}) ${fmtNum(p.coins)} ${CONFIG.DEFAULT_CURRENCY} — ${p.price_label}`, callback_data: `adm_plan_edit:${i}` },
              { text: '🗑 حذف', callback_data: `adm_plan_del:${i}` }
            ]);
          }
          rows.push([{ text: '➕ افزودن پلن', callback_data: 'adm_plan_add' }]);
          rows.push([{ text: '🔙 بازگشت', callback_data: 'adm_basic' }]);
          rows.push([{ text: '🏠 منوی اصلی ربات', callback_data: 'back_main' }]);
          await tgSendMessage(env, chat_id, '✅ پلن افزوده شد.\nمدیریت پلن‌های سکه:', kb(rows));
          return;
        }
        // Admin: Plans — edit coins
        if (state?.step === 'adm_plan_edit_coins' && typeof state?.idx === 'number') {
          const coins = parsePositiveInt(text);
          if (!Number.isFinite(coins)) { await tgSendMessage(env, chat_id, '❌ مقدار نامعتبر است. یک عدد مثبت ارسال کنید:'); return; }
          const s = await getSettings(env);
          let plans = Array.isArray(s?.plans) ? s.plans : [];
          // If plans are empty, initialize from CONFIG and persist to avoid invalid index
          if (!plans.length && Array.isArray(CONFIG.PLANS) && CONFIG.PLANS.length) {
            plans = JSON.parse(JSON.stringify(CONFIG.PLANS));
            s.plans = plans;
            await setSettings(env, s);
          }
          const idx = Number(state.idx);
          if (!(idx >= 0 && idx < plans.length)) { await clearUserState(env, uid); await tgSendMessage(env, chat_id, '❌ پلن نامعتبر.'); return; }
          plans[idx].coins = coins;
          s.plans = plans;
          await setSettings(env, s);
          await clearUserState(env, uid);
          // Send refreshed plans list
          const rows = [];
          for (let i = 0; i < plans.length; i++) {
            const p = plans[i];
            rows.push([
              { text: `${i + 1}) ${fmtNum(p.coins)} ${CONFIG.DEFAULT_CURRENCY} — ${p.price_label}`, callback_data: `adm_plan_edit:${i}` },
              { text: '🗑 حذف', callback_data: `adm_plan_del:${i}` }
            ]);
          }
          rows.push([{ text: '➕ افزودن پلن', callback_data: 'adm_plan_add' }]);
          rows.push([{ text: '🔙 بازگشت', callback_data: 'adm_basic' }]);
          rows.push([{ text: '🏠 منوی اصلی ربات', callback_data: 'back_main' }]);
          await tgSendMessage(env, chat_id, '✅ تعداد سکه پلن بروزرسانی شد.\nمدیریت پلن‌های سکه:', kb(rows));
          return;
        }
        // Admin: Plans — edit price label
        if (state?.step === 'adm_plan_edit_price' && typeof state?.idx === 'number') {
          const price_label = String(text || '').trim();
          if (!price_label) { await tgSendMessage(env, chat_id, '❌ برچسب نامعتبر است. دوباره ارسال کنید:'); return; }
          const s = await getSettings(env);
          let plans = Array.isArray(s?.plans) ? s.plans : [];
          if (!plans.length && Array.isArray(CONFIG.PLANS) && CONFIG.PLANS.length) {
            plans = JSON.parse(JSON.stringify(CONFIG.PLANS));
            s.plans = plans;
            await setSettings(env, s);
          }
          const idx = Number(state.idx);
          if (!(idx >= 0 && idx < plans.length)) { await clearUserState(env, uid); await tgSendMessage(env, chat_id, '❌ پلن نامعتبر.'); return; }
          plans[idx].price_label = price_label;
          s.plans = plans;
          await setSettings(env, s);
          await clearUserState(env, uid);
          const rows = [];
          for (let i = 0; i < plans.length; i++) {
            const p = plans[i];
            rows.push([
              { text: `${i + 1}) ${fmtNum(p.coins)} ${CONFIG.DEFAULT_CURRENCY} — ${p.price_label}`, callback_data: `adm_plan_edit:${i}` },
              { text: '🗑 حذف', callback_data: `adm_plan_del:${i}` }
            ]);
          }
          rows.push([{ text: '➕ افزودن پلن', callback_data: 'adm_plan_add' }]);
          rows.push([{ text: '🔙 بازگشت', callback_data: 'adm_basic' }]);
          rows.push([{ text: '🏠 منوی اصلی ربات', callback_data: 'back_main' }]);
          await tgSendMessage(env, chat_id, '✅ برچسب قیمت پلن بروزرسانی شد.\nمدیریت پلن‌های سکه:', kb(rows));
          return;
        }
        // Admin: DNS add flow — addresses list
        if (state?.step === 'adm_dns_add_addresses' && state?.version) {
          const version = state.version === 'v6' ? 'v6' : 'v4';
          // Split lines, trim, and keep valid format; validation happens later in putDnsAddresses
          const ips = String(text || '')
            .split(/\r?\n/)
            .map(s => s.trim())
            .filter(Boolean);
          if (!ips.length) { await tgSendMessage(env, chat_id, '❌ هیچ آدرسی یافت نشد. دوباره ارسال کنید یا /update برای لغو.'); return; }
          await setUserState(env, uid, { step: 'adm_dns_add_country', version, ips });
          await tgSendMessage(env, chat_id, '🌍 کشور مربوط به این آدرس‌ها را ارسال کنید (مثال: آمریکا):');
          return;
        }
        // Admin: DNS add flow — country
        if (state?.step === 'adm_dns_add_country' && Array.isArray(state?.ips) && state?.version) {
          const version = state.version === 'v6' ? 'v6' : 'v4';
          const country = String(text || '').trim();
          if (!country) { await tgSendMessage(env, chat_id, '❌ کشور نامعتبر است. لطفاً مجدداً ارسال کنید:'); return; }
          await setUserState(env, uid, { step: 'adm_dns_add_max_users', version, ips: state.ips, country });
          await tgSendMessage(env, chat_id, '👥 هر آدرس برای چند کاربر ارسال شود؟\n\n• عدد 0 = نامحدود\n• عدد 1 = فقط برای 1 کاربر (بعد حذف می‌شود)\n• عدد بیشتر = برای آن تعداد کاربر\n\nعدد را ارسال کنید:');
          return;
        }
        // Admin: DNS add flow — max users
        if (state?.step === 'adm_dns_add_max_users' && Array.isArray(state?.ips) && state?.version && state?.country) {
          const version = state.version === 'v6' ? 'v6' : 'v4';
          const country = String(state.country || '').trim();
          const maxUsers = parseNonNegativeInt(text);
          if (!Number.isFinite(maxUsers)) { await tgSendMessage(env, chat_id, 'عدد نامعتبر است. یک عدد صحیح یا "نامحدود" ارسال کنید:'); return; }
          await setUserState(env, uid, { step: 'adm_dns_add_flag', version, ips: state.ips, country, maxUsers });
          await tgSendMessage(env, chat_id, 'پرچم/ایموجی لوکیشن را ارسال کنید (مثال: 🇺🇸). برای پیشفرض "🌐"، همان را ارسال کنید.');
          return;
        }
        // Admin: DNS add flow — flag and save
        if (state?.step === 'adm_dns_add_flag' && Array.isArray(state?.ips) && state?.version && state?.country) {
          const version = state.version === 'v6' ? 'v6' : 'v4';
          const country = String(state.country || '').trim();
          const flag = String((text || '🌐').trim() || '🌐');
          const maxUsers = Number(state.maxUsers || 0);
          const countBefore = await countAvailableDns(env, version);
          const added = await putDnsAddresses(env, version, state.ips, country, flag, uid, maxUsers);
          // Avoid immediate recount due to KV eventual consistency
          const countAfter = countBefore + added;
          await clearUserState(env, uid);
          await tgSendMessage(env, chat_id, `✅ افزودن انجام شد.
نسخه: ${version.toUpperCase()}
لوکیشن: ${flag} ${country}
تعداد افزوده‌شده: ${fmtNum(added)}
حداکثر کاربر هر آدرس: ${maxUsers === 0 ? 'نامحدود' : fmtNum(maxUsers)}
موجودی قبل: ${fmtNum(countBefore)} | موجودی فعلی: ${fmtNum(countAfter)}`);
          return;
        }
        // Admin: Block user by numeric ID
        if (state?.step === 'adm_block_uid') {
          const target = (text || '').trim();
          if (!/^\d+$/.test(target)) { await tgSendMessage(env, chat_id, 'آیدی نامعتبر است. فقط عدد وارد کنید.'); return; }
          await blockUser(env, target);
          await clearUserState(env, uid);
          await tgSendMessage(env, chat_id, `کاربر <code>${target}</code> بلاک شد.`);
          return;
        }
        // Admin: Unblock user by numeric ID
        if (state?.step === 'adm_unblock_uid') {
          const target = (text || '').trim();
          if (!/^\d+$/.test(target)) { await tgSendMessage(env, chat_id, 'آیدی نامعتبر است. فقط عدد وارد کنید.'); return; }
          await unblockUser(env, target);
          await clearUserState(env, uid);
          await tgSendMessage(env, chat_id, `کاربر <code>${target}</code> از بلاک خارج شد.`);
          return;
        }
        if (state?.step === 'adm_join_wait') {
          const token = normalizeChannelToken(text);
          if (!token) {
            await tgSendMessage(env, chat_id, '❌ کانال نامعتبر است. نمونه: @channel یا لینک کامل');
            return;
          }
          // Verify bot admin status for this channel
          const chk = await checkBotAdminForToken(env, token);
          if (!chk.verifiable) {
            await tgSendMessage(env, chat_id, '⚠️ امکان بررسی این لینک وجود ندارد (احتمالاً لینک دعوت/خصوصی). لطفاً ربات را به کانال اضافه و ادمین کنید و سپس نام کاربری عمومی (@username) را ارسال کنید.');
            return;
          }
          if (!chk.isAdmin) {
            await tgSendMessage(env, chat_id, '❌ ربات در این کانال ادمین نیست. عملیات ناموفق بود. ابتدا ربات را ادمین کانال کنید سپس دوباره تلاش کنید.');
            return;
          }
          const s = await getSettings(env);
          const arr = Array.isArray(s.join_channels) ? s.join_channels : [];
          if (!arr.includes(token)) arr.push(token);
          s.join_channels = arr;
          await setSettings(env, s);
          await tgSendMessage(env, chat_id, `✅ افزوده شد: ${token}\nکانال‌های فعلی: ${arr.join(', ') || '—'}\nمی‌توانید کانال بعدی را ارسال کنید یا با /update خارج شوید.`);
          return;
        }
        if (state?.step === 'adm_join_edit_wait' && typeof state?.index === 'number') {
          const token = normalizeChannelToken(text);
          if (!token) { await tgSendMessage(env, chat_id, '❌ کانال نامعتبر است. نمونه: @channel یا لینک کامل'); return; }
          // Verify bot admin status for this channel
          const chk = await checkBotAdminForToken(env, token);
          if (!chk.verifiable) { await tgSendMessage(env, chat_id, '⚠️ امکان بررسی این لینک وجود ندارد (احتمالاً لینک دعوت/خصوصی). لطفاً ربات را به کانال اضافه و ادمین کنید و سپس نام کاربری عمومی (@username) را ارسال کنید.'); return; }
          if (!chk.isAdmin) { await tgSendMessage(env, chat_id, '❌ ربات در این کانال ادمین نیست. عملیات ناموفق بود. ابتدا ربات را ادمین کانال کنید سپس دوباره تلاش کنید.'); return; }
          const s = await getSettings(env);
          const arr = Array.isArray(s.join_channels) ? s.join_channels : [];
          const idx = state.index;
          if (idx < 0 || idx >= arr.length) { await clearUserState(env, uid); await tgSendMessage(env, chat_id, 'ردیف نامعتبر است.'); return; }
          arr[idx] = token;
          s.join_channels = arr;
          await setSettings(env, s);
          await clearUserState(env, uid);
          await tgSendMessage(env, chat_id, `✏️ ویرایش شد: ردیف ${idx+1}\nکانال جدید: ${token}\nفهرست فعلی: ${arr.join(', ') || '—'}`);
          return;
        }
        
        if (state?.step === 'adm_add_uid') {
          const target = text.trim();
          if (!/^\d+$/.test(target)) { await tgSendMessage(env, chat_id, 'آیدی نامعتبر است.'); return; }
          await setUserState(env, uid, { step: 'adm_add_amount', target });
          await tgSendMessage(env, chat_id, 'مبلغ سکه برای افزودن را ارسال کنید:');
          return;
        }
        if (state?.step === 'adm_add_amount') {
          const amount = Number(text.replace(/[^0-9]/g, ''));
          if (!amount || amount <= 0) { await tgSendMessage(env, chat_id, 'مبلغ نامعتبر است.'); return; }
          const before = await getUser(env, state.target);
          const prevBal = Number(before?.balance || 0);
          const ok = await creditBalance(env, state.target, amount);
          const after = await getUser(env, state.target);
          const newBal = Number(after?.balance || prevBal);
          if (ok) {
            // Notify target user
            try { await tgSendMessage(env, state.target, `➕ ${fmtNum(amount)} ${CONFIG.DEFAULT_CURRENCY} به حساب شما افزوده شد.\nموجودی فعلی: <b>${fmtNum(newBal)} ${CONFIG.DEFAULT_CURRENCY}</b>`); } catch {}
            // Notify admin
            await tgSendMessage(env, chat_id, `✅ ${fmtNum(amount)} ${CONFIG.DEFAULT_CURRENCY} به کاربر <code>${state.target}</code> افزوده شد.\nموجودی فعلی کاربر: <b>${fmtNum(newBal)} ${CONFIG.DEFAULT_CURRENCY}</b>`);
          } else {
            await tgSendMessage(env, chat_id, '❌ انجام نشد.');
          }
          await clearUserState(env, uid);
          return;
        }
        if (state?.step === 'adm_sub_uid') {
          const target = text.trim();
          if (!/^\d+$/.test(target)) { await tgSendMessage(env, chat_id, 'آیدی نامعتبر است.'); return; }
          await setUserState(env, uid, { step: 'adm_sub_amount', target });
          await tgSendMessage(env, chat_id, 'مبلغ سکه برای کسر را ارسال کنید:');
          return;
        }
        if (state?.step === 'adm_sub_amount') {
          const amount = Number(text.replace(/[^0-9]/g, ''));
          if (!amount || amount <= 0) { await tgSendMessage(env, chat_id, 'مبلغ نامعتبر است.'); return; }
          const before = await getUser(env, state.target);
          const prevBal = Number(before?.balance || 0);
          const ok = await subtractBalance(env, state.target, amount);
          const after = await getUser(env, state.target);
          const newBal = Number(after?.balance ?? prevBal);
          if (ok) {
            // Notify target user
            try { await tgSendMessage(env, state.target, `➖ ${fmtNum(amount)} ${CONFIG.DEFAULT_CURRENCY} از حساب شما کسر شد.\nموجودی فعلی: <b>${fmtNum(newBal)} ${CONFIG.DEFAULT_CURRENCY}</b>`); } catch {}
            // Notify admin
            await tgSendMessage(env, chat_id, `✅ ${fmtNum(amount)} ${CONFIG.DEFAULT_CURRENCY} از کاربر <code>${state.target}</code> کسر شد.\nموجودی فعلی کاربر: <b>${fmtNum(newBal)} ${CONFIG.DEFAULT_CURRENCY}</b>`);
          } else {
            await tgSendMessage(env, chat_id, '❌ انجام نشد (شاید موجودی کافی نیست).');
          }
          await clearUserState(env, uid);
          return;
        }
        // Admin: پاسخ به تیکت
        if (state?.step === 'adm_ticket_reply' && state?.ticket_id && state?.target_uid) {
          const replyText = (text || '').trim();
          const t = await getTicket(env, state.ticket_id);
          if (t) {
            t.replies = Array.isArray(t.replies) ? t.replies : [];
            t.replies.push({ from_admin: true, text: replyText, ts: nowTs() });
            t.status = 'answered';
            await saveTicket(env, t);
            try { await tgSendMessage(env, state.target_uid, `📩 پاسخ به تیکت شماره ${t.id}:\n${replyText}`); } catch {}
          }
          await clearUserState(env, uid);
          await tgSendMessage(env, chat_id, 'پاسخ ارسال شد.');
          return;
        }
        // User: ثبت تیکت
        if (state?.step === 'ticket_wait') {
          const content = (text || '').trim();
          if (!content) { await tgSendMessage(env, chat_id, 'متن تیکت نامعتبر است.'); return; }
          const t = await createTicket(env, uid, content, 'general');
          if (t) {
            await tgSendMessage(env, chat_id, `🎟 تیکت شما با شناسه ${t.id} ثبت شد. پشتیبانی به‌زودی پاسخ خواهد داد.`);
            // notify admins
            try {
              const admins = getAdminChatIds(env);
              for (const aid of admins) {
                await tgSendMessage(env, aid, `🎟 تیکت جدید #${t.id}\nاز: <code>${uid}</code>\nمتن: ${htmlEscape(content)}`);
              }
            } catch {}
          } else {
            await tgSendMessage(env, chat_id, 'خطا در ثبت تیکت.');
          }
          await clearUserState(env, uid);
          return;
        }
        // Admin: ایجاد کد هدیه — مرحله 1: مبلغ
        if (state?.step === 'adm_gift_create_amount') {
          if (!isAdminUser(env, uid)) { await clearUserState(env, uid); return; }
          const amount = Number((text||'').replace(/[^0-9]/g,''));
          if (!amount || amount <= 0) { await tgSendMessage(env, chat_id, 'مبلغ نامعتبر است. یک عدد مثبت بفرستید.'); return; }
          await setUserState(env, uid, { step: 'adm_gift_create_uses', amount });
          await tgSendMessage(env, chat_id, 'حداکثر تعداد دفعات استفاده از کد را ارسال کنید (عدد > 0):');
          return;
        }
        // Admin: ایجاد کد هدیه — مرحله 2: سقف استفاده و ساخت کد
        if (state?.step === 'adm_gift_create_uses' && typeof state.amount === 'number') {
          if (!isAdminUser(env, uid)) { await clearUserState(env, uid); return; }
          const uses = Number((text||'').replace(/[^0-9]/g,''));
          if (!uses || uses <= 0) { await tgSendMessage(env, chat_id, 'تعداد نامعتبر است.'); return; }
          // generate unique code
          let code = '';
          for (let i=0;i<5;i++) {
            code = newToken(8);
            const exists = await kvGet(env, CONFIG.GIFT_PREFIX + code);
            if (!exists) break;
          }
          const gift = { code, amount: state.amount, max_uses: uses, used_by: [], created_at: nowTs() };
          await kvSet(env, CONFIG.GIFT_PREFIX + code, gift);
          await clearUserState(env, uid);
          await tgSendMessage(env, chat_id, `🎁 کد هدیه ساخته شد:\nکد: <code>${code}</code>\nمبلغ: ${fmtNum(gift.amount)} ${CONFIG.DEFAULT_CURRENCY}\nسقف استفاده: ${uses} بار`);
          return;
        }
        // User: وارد کردن کد هدیه
        if (state?.step === 'gift_redeem_wait') {
          const code = String((text||'').trim());
          const g = await kvGet(env, CONFIG.GIFT_PREFIX + code);
          if (!g) { await tgSendMessage(env, chat_id, 'کد هدیه نامعتبر است.'); return; }
          const usedBy = Array.isArray(g.used_by) ? g.used_by : [];
          if (usedBy.includes(uid)) { await tgSendMessage(env, chat_id, 'شما قبلاً از این کد استفاده کرده‌اید.'); return; }
          const max = Number(g.max_uses || 0);
          if (max > 0 && usedBy.length >= max) { await tgSendMessage(env, chat_id, 'سقف استفاده از این کد تکمیل شده است.'); return; }
          const ok = await creditBalance(env, uid, Number(g.amount || 0));
          if (!ok) { await tgSendMessage(env, chat_id, 'خطا در اعمال کد.'); return; }
          usedBy.push(uid); g.used_by = usedBy;
          await kvSet(env, CONFIG.GIFT_PREFIX + code, g);
          await tgSendMessage(env, chat_id, `✅ کد هدیه اعمال شد. ${fmtNum(g.amount)} ${CONFIG.DEFAULT_CURRENCY} به حساب شما افزوده شد.`);
          await clearUserState(env, uid);
          return;
        }
        if (state?.step === 'adm_broadcast_wait') {
          const msgText = (text || '').trim();
          if (!msgText) { await tgSendMessage(env, chat_id, '❌ متن نامعتبر است.'); return; }
          await tgSendMessage(env, chat_id, 'در حال ارسال پیام همگانی...');
          const { total, sent, failed } = await broadcastToAllUsers(env, msgText);
          await clearUserState(env, uid);
          await tgSendMessage(env, chat_id, `📢 نتیجه ارسال:\nمخاطبان: ${fmtNum(total)}\nارسال موفق: ${fmtNum(sent)}\nناموفق: ${fmtNum(failed)}`);
          return;
        }
        if (state?.step === 'buy_reject_reason' && state?.purchase_id && state?.target_uid) {
          const reason = (msg.text || '').trim() || 'بدون دلیل';
          const key = CONFIG.PURCHASE_PREFIX + state.purchase_id;
          const p = await kvGet(env, key);
          if (p && p.status === 'pending') {
            p.status = 'rejected'; p.reason = reason; p.decided_at = nowTs();
            await kvSet(env, key, p);
            // به‌روزرسانی پیام‌های ادمین: کپشن و حذف دکمه‌ها
            const msgs = Array.isArray(p.admin_msgs) ? p.admin_msgs : [];
            for (const m of msgs) {
              try {
                await tgEditMessageCaption(env, m.chat_id, m.message_id, buildPurchaseCaption(p), {});
                await tgEditReplyMarkup(env, m.chat_id, m.message_id, kb([[{ text: '❌ رد شد', callback_data: 'noop' }]]).reply_markup);
              } catch {}
            }
            try { await tgSendMessage(env, state.target_uid, `❌ خرید شما رد شد.\nدلیل: ${reason}`); } catch {}
          }
          await clearUserState(env, uid);
          await tgSendMessage(env, chat_id, 'دلیل رد برای کاربر ارسال شد.');
          return;
        }
        if (state?.step === 'file_set_price_wait' && state?.token) {
          const amount = Number((text || '').replace(/[^0-9]/g, ''));
          const key = CONFIG.FILE_PREFIX + state.token;
          const meta = await kvGet(env, key);
          if (!meta) { await clearUserState(env, uid); await tgSendMessage(env, chat_id, 'فایل یافت نشد.'); return; }
          meta.price = amount >= 0 ? amount : 0;
          await kvSet(env, key, meta);
          await clearUserState(env, uid);
          await tgSendMessage(env, chat_id, `قیمت به ${fmtNum(meta.price)} ${CONFIG.DEFAULT_CURRENCY} تنظیم شد.`, buildFileAdminKb(meta));
          return;
        }
        if (state?.step === 'file_set_limit_wait' && state?.token) {
          const maxUsers = parseNonNegativeInt(text);
          if (!Number.isFinite(maxUsers)) { await tgSendMessage(env, chat_id, '❌ عدد نامعتبر است. یک عدد صحیح یا "نامحدود" ارسال کنید:'); return; }
          const key = CONFIG.FILE_PREFIX + state.token;
          const meta = await kvGet(env, key);
          if (!meta) { await clearUserState(env, uid); await tgSendMessage(env, chat_id, 'فایل یافت نشد.'); return; }
          meta.max_users = maxUsers >= 0 ? maxUsers : 0;
          await kvSet(env, key, meta);
          await clearUserState(env, uid);
          await tgSendMessage(env, chat_id, `محدودیت یکتا به ${meta.max_users} تنظیم شد.`, buildFileAdminKb(meta));
          return;
        }
        if (state?.step === 'file_replace_wait' && state?.token) {
          // انتظار برای رسانه یا سند جدید
          if (msg.document || msg.photo || msg.video || msg.audio) {
            let upd = null;
            if (msg.document) {
              upd = { kind: 'document', file_id: msg.document.file_id, file_name: msg.document.file_name || 'file', file_size: msg.document.file_size || 0, mime_type: msg.document.mime_type || 'application/octet-stream' };
            } else if (msg.photo && msg.photo.length) {
              const largest = msg.photo[msg.photo.length - 1];
              upd = { kind: 'photo', file_id: largest.file_id, file_name: 'photo', file_size: largest.file_size || 0, mime_type: 'image/jpeg' };
            } else if (msg.video) {
              upd = { kind: 'video', file_id: msg.video.file_id, file_name: msg.video.file_name || 'video', file_size: msg.video.file_size || 0, mime_type: msg.video.mime_type || 'video/mp4' };
            } else if (msg.audio) {
              upd = { kind: 'audio', file_id: msg.audio.file_id, file_name: msg.audio.file_name || 'audio', file_size: msg.audio.file_size || 0, mime_type: msg.audio.mime_type || 'audio/mpeg' };
            }
            if (upd) {
              const key = CONFIG.FILE_PREFIX + state.token;
              const meta = await kvGet(env, key);
              if (!meta) { await clearUserState(env, uid); await tgSendMessage(env, chat_id, 'فایل یافت نشد.'); return; }
              meta.kind = upd.kind; meta.file_id = upd.file_id; meta.file_name = upd.file_name; meta.file_size = upd.file_size; meta.mime_type = upd.mime_type;
              await kvSet(env, key, meta);
              await clearUserState(env, uid);
              await tgSendMessage(env, chat_id, 'فایل با موفقیت جایگزین شد.', buildFileAdminKb(meta));
              return;
            }
          }
          await tgSendMessage(env, chat_id, 'لطفاً فایل جدید را به صورت سند/رسانه ارسال کنید.');
          return;
        }
      }
      await tgSendMessage(env, chat_id, 'لطفاً از منو استفاده کنید:', mainMenuKb(env, uid));
    }
  } catch (e) {
    console.error('onMessage error', e);
  }
}

async function onCallback(cb, env) {
  try {
    const data = cb.data || '';
    const from = cb.from || {};
    const uid = String(from.id);
    const chat_id = cb.message?.chat?.id;
    const mid = cb.message?.message_id;

    // Ensure user profile exists for balance operations
    try { await ensureUser(env, uid, from); } catch {}

    // Blocked user check
    try {
      const blocked = await isUserBlocked(env, uid);
      if (blocked) {
        const s = await getSettings(env);
        const url = s?.support_url || 'https://t.me/NeoDebug';
        const kbSupport = kb([[{ text: 'ارتباط با پشتیبانی', url }]]);
        await tgAnswerCallbackQuery(env, cb.id, 'مسدود هستید');
        await tgSendMessage(env, chat_id, '⛔️ دسترسی شما به ربات مسدود شده است. برای رفع مشکل با پشتیبانی تماس بگیرید.', kbSupport);
        return;
      }
    } catch {}

    // Update mode: block non-admin users from using buttons
    try {
      const s = await getSettings(env);
      if (s?.update_mode === true && !isAdminUser(env, uid)) {
        await tgAnswerCallbackQuery(env, cb.id, '🛠️ در حال بروزرسانی');
        await tgSendMessage(env, chat_id, '🛠️ ربات در حال بروزرسانی است. لطفاً بعداً تلاش کنید.');
        return;
      }
    } catch {}

    // اگر برخی دکمه‌ها به صورت مجزا غیرفعال شده‌اند و کاربر ادمین نیست
    try {
      const s = await getSettings(env);
      const disabled = Array.isArray(s?.disabled_buttons) ? s.disabled_buttons : [];
      const wh = ['join_check', 'back_main', 'adm_service', 'adm_buttons', 'adm_buttons_add', 'adm_buttons_clear'];
      if (!isAdminUser(env, uid) && disabled.includes(data) && !wh.includes(data)) {
        await tgAnswerCallbackQuery(env, cb.id, 'غیرفعال است');
        await tgSendMessage(env, chat_id, s.disabled_message || '🔧 این دکمه موقتاً غیرفعال است.');
        return;
      }
    } catch {}

    // Mandatory join check (ادمین‌ها مستثنی هستند؛ همچنین تایید/لغو خرید)
    const isAdm = isAdminUser(env, uid);
    const joined = isAdm ? true : await ensureJoinedChannels(env, uid, chat_id);
    if (!joined && data !== 'join_check' && !data.startsWith('confirm_buy') && data !== 'cancel_buy') {
      await tgAnswerCallbackQuery(env, cb.id, 'ابتدا عضو کانال‌ها شوید');
      return;
    }

    if (data === 'join_check') {
      const ok = await ensureJoinedChannels(env, uid, chat_id, true);
      if (ok) {
        // پس از تایید عضویت، اگر معرف ذخیره شده است، یکبار سکه به معرف بده
        try {
          const u = await getUser(env, uid);
          let ref = u?.referrer_id;
          console.log(`[DEBUG] join_check for uid=${uid}, profile_ref=${ref}`);
          
          // اگر referrer در پروفایل نبود، از pending KV بازیابی کن
          if (!ref) {
            try {
              const pend = await kvGet(env, CONFIG.REF_PENDING_PREFIX + String(uid));
              console.log(`[DEBUG] pending KV for uid=${uid}:`, pend);
              if (pend?.referrer_id) {
                ref = String(pend.referrer_id);
                console.log(`[DEBUG] found pending ref=${ref} for uid=${uid}`);
                // در صورت نبود، همانجا در پروفایل هم ذخیره کن تا بعداً در دسترس باشد
                if (u && !u.referrer_id) { u.referrer_id = ref; await setUser(env, uid, u); }
              }
            } catch (e) { console.log(`[DEBUG] pending KV error:`, e); }
          }
          
          if (ref && String(ref) !== String(uid)) {
            console.log(`[DEBUG] attempting credit: ref=${ref}, uid=${uid}`);
            const credited = await autoCreditReferralIfNeeded(env, String(ref), String(uid));
            console.log(`[DEBUG] credit result: ${credited}`);
            if (credited) {
              try { await tgSendMessage(env, String(ref), `🎉 یک زیرمجموعه جدید تایید شد. 1 🪙 به حساب شما افزوده شد.`); } catch {}
              try { const uu = await getUser(env, uid); if (uu) { uu.referral_pending = false; await setUser(env, uid, uu); } } catch {}
              // پاک کردن pending KV تا دوباره اعتباردهی نشود
              try { await kvDel(env, CONFIG.REF_PENDING_PREFIX + String(uid)); } catch {}
            }
          } else {
            console.log(`[DEBUG] no valid ref found for uid=${uid}, ref=${ref}`);
          }
        } catch (e) { console.log(`[DEBUG] join_check error:`, e); }
        const hdr = await mainMenuHeader(env);
        await tgEditMessage(env, chat_id, mid, `✅ عضویت شما تایید شد.\n${hdr}`, mainMenuKb(env, uid));
      } else {
        // در صورت عدم تایید، مجدداً راهنمای عضویت را نمایش بده
        await tgSendMessage(env, chat_id, 'برای استفاده از ربات ابتدا عضو کانال‌های زیر شوید سپس دکمه بررسی را بزنید:', await buildJoinKb(env));
      }
      await tgAnswerCallbackQuery(env, cb.id);
      return;
    }

    if (data === 'back_main') {
      if (!Array.isArray(env.__cbtnRowsCache)) { try { await rebuildCustomButtonsCache(env); } catch {} }
      const hdr = await mainMenuHeader(env);
      await tgEditMessage(env, chat_id, mid, hdr, mainMenuKb(env, uid));
      await tgAnswerCallbackQuery(env, cb.id);
      return;
    }

    // Send main menu as a NEW message (do not edit the current one) — preserves previous message content
    if (data === 'back_main_new') {
      if (!Array.isArray(env.__cbtnRowsCache)) { try { await rebuildCustomButtonsCache(env); } catch {} }
      const hdr = await mainMenuHeader(env);
      await tgSendMessage(env, chat_id, hdr, mainMenuKb(env, uid));
      await tgAnswerCallbackQuery(env, cb.id);
      return;
    }

    // My Configs: list DNS/WG/OVPN configs for the user
    if (data === 'my_configs') {
      const rows = [];
      // DNS assigned to this user
      try {
        const dnsRows = await listUserDnsConfigs(env, uid, 10);
        if (dnsRows.length) {
          rows.push([{ text: '🌐 DNS', callback_data: 'noop' }]);
          rows.push(...dnsRows);
        }
      } catch {}
      // WireGuard saved configs
      try {
        const wgItems = await getUserConfigList(env, uid, 'wg');
        if (wgItems.length) {
          rows.push([{ text: '🛡 WireGuard', callback_data: 'noop' }]);
          for (const it of wgItems) {
            rows.push([{ text: `${it.country || ''} — ${it.filename || 'wg.conf'}`, callback_data: 'resend_wg:' + it.id }]);
          }
        }
      } catch {}
      // OpenVPN saved configs
      try {
        const ovpnItems = await getUserConfigList(env, uid, 'ovpn');
        if (ovpnItems.length) {
          rows.push([{ text: '🔐 OpenVPN', callback_data: 'noop' }]);
          for (const it of ovpnItems) {
            rows.push([{ text: `${it.loc || ''} (${it.proto || ''})`, callback_data: 'resend_ovpn:' + it.id }]);
          }
        }
      } catch {}
      if (!rows.length) {
        rows.push([{ text: 'چیزی یافت نشد', callback_data: 'noop' }]);
      }
      rows.push([{ text: '🔙 بازگشت', callback_data: 'account' }]);
      await tgSendMessage(env, chat_id, '📦 کانفیگ‌های شما:', kb(rows));
      await tgAnswerCallbackQuery(env, cb.id);
      return;
    }

    if (data.startsWith('resend_dns:')) {
      const m = data.split(':');
      const version = m[1] === 'v6' ? 'v6' : 'v4';
      const ip = m[2];
      const key = dnsPrefix(version) + ip;
      let v = await kvGet(env, key);
      if (!v || String(v.assigned_to || '') !== String(uid)) {
        // Fallback to saved profile item
        const it = await getUserConfigList(env, uid, 'dns').then(arr => (arr||[]).find(x => x.ip === ip && (x.version||version) === version)).catch(() => null);
        if (!it) { await tgAnswerCallbackQuery(env, cb.id, 'یافت نشد'); return; }
        v = { ip: it.ip, country: it.country, flag: it.flag };
      }
      const caption = `🌐 <b>DNS اختصاصی شما</b>\n\n${v.flag || '🌐'} <b>${v.country || ''}</b>\n<code>${ip}</code>`;
      await tgSendMessage(env, chat_id, caption, kb([[{ text: '🏠 منوی اصلی', callback_data: 'back_main_new' }]]));
      await tgAnswerCallbackQuery(env, cb.id, 'ارسال شد');
      return;
    }

    if (data.startsWith('resend_ovpn:')) {
      const id = data.split(':')[1];
      const it = await getUserConfigItem(env, uid, 'ovpn', id);
      if (!it) { await tgAnswerCallbackQuery(env, cb.id, 'یافت نشد'); return; }
      await tgSendDocument(env, chat_id, it.file_id, { caption: `اوپن وی‌پی‌ان — ${it.loc} (${it.proto})` });
      await tgAnswerCallbackQuery(env, cb.id, 'ارسال شد');
      return;
    }

    if (data.startsWith('resend_wg:')) {
      const id = data.split(':')[1];
      const it = await getUserConfigItem(env, uid, 'wg', id);
      if (!it) { await tgAnswerCallbackQuery(env, cb.id, 'یافت نشد'); return; }
      const blob = new Blob([it.content || ''], { type: 'text/plain' });
      await tgSendDocument(env, chat_id, { blob, filename: it.filename || 'wg.conf' }, { caption: `📄 فایل کانفیگ WireGuard (${it.country || ''})` });
      await tgAnswerCallbackQuery(env, cb.id, 'ارسال شد');
      return;
    }

    // Custom purchasable buttons — user flow
    if (data.startsWith('cbtn:')) {
      const id = data.split(':')[1];
      const meta = await kvGet(env, CONFIG.CUSTOMBTN_PREFIX + id);
      if (!meta || meta.disabled) { await tgAnswerCallbackQuery(env, cb.id, 'ناموجود'); await sendNotAvailable(env, chat_id); return; }
      const price = Number(meta.price || 0);
      const paidUsers = Array.isArray(meta.paid_users) ? meta.paid_users : [];
      const already = paidUsers.includes(String(uid));
      if (price > 0 && !already) {
        const kbBuy = kb([[{ text: `✅ تایید (کسر ${fmtNum(price)} ${CONFIG.DEFAULT_CURRENCY})`, callback_data: 'cbtn_confirm:'+id }],[{ text: '❌ انصراف', callback_data: 'cbtn_cancel' }]]);
        await tgSendMessage(env, chat_id, `این مورد برای دریافت به <b>${fmtNum(price)}</b> ${CONFIG.DEFAULT_CURRENCY} نیاز دارد. آیا مایل به ادامه هستید؟`, kbBuy);
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }
      const ok = await deliverCustomButtonToUser(env, uid, chat_id, id);
      if (ok) await tgAnswerCallbackQuery(env, cb.id, 'ارسال شد');
      return;
    }
    if (data.startsWith('cbtn_confirm:')) {
      const id = data.split(':')[1];
      const ok = await deliverCustomButtonToUser(env, uid, chat_id, id);
      await tgAnswerCallbackQuery(env, cb.id, ok ? '✅' : '❌');
      try { await tgEditReplyMarkup(env, chat_id, mid, { inline_keyboard: [] }); } catch {}
      return;
    }
    if (data === 'cbtn_cancel') {
      await tgAnswerCallbackQuery(env, cb.id, 'لغو شد');
      try { await tgEditReplyMarkup(env, chat_id, mid, { inline_keyboard: [] }); } catch {}
      return;
    }

    // Removed: redeem_token menu button

    if (data === 'market') {
      if (!Array.isArray(env.__cbtnRowsCache)) { try { await rebuildCustomButtonsCache(env); } catch {} }
      const hasItems = (buildCustomButtonsRowsCached(env) || []).length > 0;
      if (!hasItems) {
        await tgSendMessage(env, chat_id, '🛒 بازارچه خالی است.', kb([[{ text: '🔙 بازگشت', callback_data: 'back_main' }]]));
      } else {
        const pageKb = buildMarketplacePage(env, 1);
        await tgSendMessage(env, chat_id, '💰 بازارچه — یکی از گزینه‌ها را انتخاب کنید:', pageKb);
      }
      await tgAnswerCallbackQuery(env, cb.id);
      return;
    }
    if (data.startsWith('market:p:')) {
      const pg = Number((data.split(':')[2]||'1')) || 1;
      const hasItems = (buildCustomButtonsRowsCached(env) || []).length > 0;
      if (!hasItems) {
        await tgSendMessage(env, chat_id, '🛒 بازارچه خالی است.', kb([[{ text: '🔙 بازگشت', callback_data: 'back_main' }]]));
      } else {
        const pageKb = buildMarketplacePage(env, pg);
        try { await tgEditReplyMarkup(env, chat_id, mid, pageKb.reply_markup); } catch {
          await tgSendMessage(env, chat_id, '💰 بازارچه — صفحه جدید:', pageKb);
        }
      }
      await tgAnswerCallbackQuery(env, cb.id);
      return;
    }

    if (data === 'private_server') {
      const hdr = '🛡 دریافت سرور اختصاصی\nیکی از گزینه‌های زیر را انتخاب کنید:';
      await tgSendMessage(env, chat_id, hdr, privateServerMenuKb());
      await tgAnswerCallbackQuery(env, cb.id);
      return;
    }

    if (data === 'account') {
      const u = await getUser(env, uid);
      const bal = fmtNum(u?.balance || 0);
      const ver = await getBotVersion(env);
      const kbAcc = kb([
        [ { text: '🆘 پشتیبانی', url: 'https://t.me/NeoDebug' }, { text: '🎫 ارسال تیکت', callback_data: 'ticket_new' } ],
        [ { text: '📦 کانفیگ‌های من', callback_data: 'my_configs' } ],
        [ { text: '🔙 بازگشت', callback_data: 'back_main' } ]
      ]);
      const parts = [];
      parts.push('👤 حساب کاربری');
      parts.push(`آیدی: \`${mdv2Escape(uid)}\``);
      parts.push(`نام: *${mdv2Escape(u?.name || '-') }*`);
      parts.push(`موجودی: *${mdv2Escape(bal + ' ' + CONFIG.DEFAULT_CURRENCY)}*`);
      const txt = parts.join('\n');
      const kbAccMd = { ...kbAcc, parse_mode: 'MarkdownV2' };
      await tgSendMessage(env, chat_id, txt, kbAccMd);
      await tgAnswerCallbackQuery(env, cb.id);
      return;
    }

    if (data === 'referrals') {
      const u = await getUser(env, uid);
      const count = Number(u?.ref_count || 0);
      const botUser = await getBotUsername(env);
      const suffix = uid;
      const parts = [
        '👥 معرفی دوستان',
        `تعداد افراد معرفی‌شده: <b>${fmtNum(count)}</b>`,
      ];
      if (botUser) {
        parts.push(`لینک دعوت: https://t.me/${botUser}?start=${suffix}`);
      }
      await tgSendMessage(env, chat_id, parts.join('\n'));
      await tgAnswerCallbackQuery(env, cb.id);
      return;
    }

    if (data === 'giftcode') {
      await setUserState(env, uid, { step: 'giftcode_wait' });
      await tgSendMessage(env, chat_id, '🎁 لطفاً کد هدیه را ارسال کنید. /update برای لغو');
      await tgAnswerCallbackQuery(env, cb.id);
      return;
    }

    if (data === 'ps_openvpn') {
      const txt = 'اوپن وی‌پی‌ان\nابتدا پروتکل را انتخاب کنید:';
      await tgSendMessage(env, chat_id, txt, ovpnProtocolKb());
      await tgAnswerCallbackQuery(env, cb.id);
      return;
    }
    if (data.startsWith('ovpn_proto:')) {
      const proto = (data.split(':')[1] || '').toUpperCase();
      if (!['TCP','UDP'].includes(proto)) { await tgAnswerCallbackQuery(env, cb.id, 'پروتکل نامعتبر'); return; }
      await setUserState(env, uid, { step: 'ovpn_pick_loc', proto });
      // Load locations/flags from settings (KV) with fallbacks
      let s = {};
      try { s = await getSettings(env); } catch {}
      const locations = Array.isArray(s?.ovpn_locations) && s.ovpn_locations.length ? s.ovpn_locations : (CONFIG.OVPN_LOCATIONS || []);
      const flags = s?.ovpn_flags && typeof s.ovpn_flags === 'object' ? s.ovpn_flags : (CONFIG.OVPN_FLAGS || {});
      await tgSendMessage(env, chat_id, `پروتکل انتخاب‌شده: ${proto}\nیکی از لوکیشن‌ها را انتخاب کنید:`, ovpnLocationsKb(proto, '', { locations, flags }));
      await tgAnswerCallbackQuery(env, cb.id);
      return;
    }
    if (data.startsWith('ovpn_loc:')) {
      const parts = data.split(':');
      const proto = (parts[1] || '').toUpperCase();
      const loc = parts.slice(2).join(':');
      if (!['TCP','UDP'].includes(proto) || !loc) { await tgAnswerCallbackQuery(env, cb.id, 'نامعتبر'); return; }
      const key = CONFIG.OVPN_PREFIX + `${proto}:${loc}`;
      const meta = await kvGet(env, key);
      if (!meta || !meta.file_id) {
        await tgSendMessage(env, chat_id, `کانفیگ ${loc} (${proto}) موجود نیست. لطفاً بعداً دوباره تلاش کنید.`, mainMenuInlineKb());
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }
      // load price from settings with fallback and ask for confirmation
      const price = await getOvpnPrice(env);
      await setUserState(env, uid, { step: 'ovpn_confirm', proto, loc, price });
      const kbBuy = kb([
        [{ text: `✅ تایید (کسر ${fmtNum(price)} ${CONFIG.DEFAULT_CURRENCY})`, callback_data: 'ovpn_confirm' }],
        [{ text: '❌ انصراف', callback_data: 'ovpn_cancel' }]
      ]);
      await tgSendMessage(env, chat_id, `دریافت کانفیگ ${loc} (${proto})\nهزینه: <b>${fmtNum(price)} ${CONFIG.DEFAULT_CURRENCY}</b>\nتایید می‌کنید؟`, kbBuy);
      await tgAnswerCallbackQuery(env, cb.id);
      return;
    }
    if (data === 'ovpn_cancel') {
      await clearUserState(env, uid);
      await tgAnswerCallbackQuery(env, cb.id, 'لغو شد');
      await tgSendMessage(env, chat_id, 'عملیات لغو شد.');
      return;
    }
    if (data === 'ovpn_confirm') {
      const st = await getUserState(env, uid);
      const proto = (st && st.proto) ? String(st.proto).toUpperCase() : '';
      const loc = st && st.loc ? String(st.loc) : '';
      const price = Number(st && st.price != null ? st.price : (CONFIG.OVPN_PRICE_COINS || 5));
      if (!['TCP','UDP'].includes(proto) || !loc) { await clearUserState(env, uid); await tgAnswerCallbackQuery(env, cb.id, 'نامعتبر'); return; }
      const key = CONFIG.OVPN_PREFIX + `${proto}:${loc}`;
      const meta = await kvGet(env, key);
      if (!meta || !meta.file_id) { await clearUserState(env, uid); await tgAnswerCallbackQuery(env, cb.id, 'یافت نشد'); return; }
      const u = await getUser(env, uid);
      if (!u || Number(u.balance || 0) < price) {
        await tgAnswerCallbackQuery(env, cb.id, 'موجودی ناکافی');
        await tgSendMessage(env, chat_id, `برای دریافت کانفیگ نیاز به ${fmtNum(price)} ${CONFIG.DEFAULT_CURRENCY} دارید. موجودی شما کافی نیست.`, kb([[{ text: '🏠 منوی اصلی', callback_data: 'back_main' }]]));
        return;
      }
      const ok = await subtractBalance(env, uid, price);
      if (!ok) { await tgAnswerCallbackQuery(env, cb.id, 'خطا در کسر'); return; }
      try { await tgSendMessage(env, chat_id, `✅ ${fmtNum(price)} ${CONFIG.DEFAULT_CURRENCY} کسر شد. در حال ارسال کانفیگ...`); } catch {}
      await tgSendDocument(env, chat_id, meta.file_id, { caption: `اوپن وی‌پی‌ان — ${loc} (${proto})` });
      // Save OVPN config for later resend
      try { await saveUserConfigItem(env, uid, 'ovpn', { file_id: meta.file_id, loc, proto }); } catch {}
      // Stats: purchases and revenue
      await bumpStat(env, 'ovpn_purchases');
      await incStat(env, 'ovpn_revenue_coins', price);
      await bumpStat(env, `ovpn_${proto}`);
      await bumpStat(env, `ovpn_loc_${loc}`);
      await clearUserState(env, uid);
      await tgAnswerCallbackQuery(env, cb.id, 'انجام شد');
      return;
    }
    if (data === 'ps_wireguard') {
      const s = await getSettings(env);
      const list = Array.isArray(s?.wg_endpoints) ? s.wg_endpoints : [];
      if (!list.length) { await tgAnswerCallbackQuery(env, cb.id, 'ناموجود'); await sendNotAvailable(env, chat_id, 'هیچ Endpoint وایرگاردی ثبت نشده است.'); return; }
      const map = groupWgAvailabilityByCountry(list);
      const countries = Object.keys(map);
      if (!countries.length) { await tgAnswerCallbackQuery(env, cb.id, 'ناموجود'); await sendNotAvailable(env, chat_id, 'هیچ لوکیشنی در دسترس نیست.'); return; }
      const rows = [];
      for (let i = 0; i < countries.length; i += 2) {
        const c1 = countries[i];
        const c2 = countries[i+1];
        const f1 = map[c1].flag || '🌐';
        const n1 = map[c1].count || 0;
        const row = [{ text: `${f1} ${c1} — ${fmtNum(n1)}`, callback_data: `ps_wg_loc:${c1}` }];
        if (c2) {
          const f2 = map[c2].flag || '🌐';
          const n2 = map[c2].count || 0;
          row.push({ text: `${f2} ${c2} — ${fmtNum(n2)}`, callback_data: `ps_wg_loc:${c2}` });
        }
        rows.push(row);
      }
      rows.push([{ text: '🔙 بازگشت', callback_data: 'private_server' }]);
      await tgEditMessage(env, chat_id, mid, 'WireGuard — یک لوکیشن را انتخاب کنید:', kb(rows));
      await tgAnswerCallbackQuery(env, cb.id);
      return;
    }
    if (data.startsWith('ps_wg_loc:')) {
      const country = data.split(':').slice(1).join(':');
      await setUserState(env, uid, { step: 'ps_wg_name', country });
      await tgAnswerCallbackQuery(env, cb.id);
      const kbRand = kb([
        [{ text: '🎲 نام تصادفی و ارسال', callback_data: 'ps_wg_rand' }],
        [{ text: '🔙 بازگشت', callback_data: 'private_server' }]
      ]);
      await tgSendMessage(env, chat_id, '📝 لطفاً نام فایل کانفیگ را وارد کنید\n(حداکثر ۱۲ کاراکتر)\n✔️ فقط حروف/اعداد/زیرخط مجاز هستند\n⛔️ کاراکترهای غیرمجاز: - @ # $ و ...', kbRand);
      return;
    }
    if (data === 'ps_wg_rand') {
      const st = await getUserState(env, uid);
      const name = genWgFilename();
      const s2 = await getSettings(env);
      const list = Array.isArray(s2?.wg_endpoints) ? s2.wg_endpoints : [];
      let ep = null;
      let idx = -1;
      if (st?.country) {
        const pick = pickWgEndpointWithCapacity(list, st.country);
        if (!pick) { await clearUserState(env, uid); await tgAnswerCallbackQuery(env, cb.id, 'ظرفیت ندارد'); await tgSendMessage(env, chat_id, '❌ در این لوکیشن ظرفیت آزاد موجود نیست.'); return; }
        ep = pick; idx = Number(pick.__idx);
      } else if (typeof st?.ep_idx === 'number') {
        idx = Number(st.ep_idx);
        if (!(idx >= 0 && idx < list.length)) { await clearUserState(env, uid); await tgAnswerCallbackQuery(env, cb.id, 'نامعتبر'); return; }
        ep = list[idx];
      } else {
        await tgAnswerCallbackQuery(env, cb.id, 'نامعتبر');
        return;
      }
      const d = s2.wg_defaults || {};
      const { priv } = await generateWgKeypair();
      const lines = [];
      lines.push('[Interface]');
      lines.push(`PrivateKey = ${priv}`);
      if (d.address) lines.push(`Address = ${d.address}`);
      if (d.dns) lines.push(`DNS = ${d.dns}`);
      if (d.mtu) lines.push(`MTU = ${d.mtu}`);
      if (d.listen_port) lines.push(`ListenPort = ${d.listen_port}`);
      lines.push('');
      lines.push('[Peer]');
      {
        const serverPub = await getWgServerPublicKey(env, ep);
        if (serverPub) lines.push(`PublicKey = ${serverPub}`);
      }
      if (d.allowed_ips) lines.push(`AllowedIPs = ${d.allowed_ips}`);
      if (typeof d.persistent_keepalive === 'number' && d.persistent_keepalive >= 1 && d.persistent_keepalive <= 99) {
        lines.push(`PersistentKeepalive = ${d.persistent_keepalive}`);
      }
      lines.push(`Endpoint = ${ep.hostport}`);
      const cfg = lines.join('\n');
      const filename = `${name}.conf`;
      const blob = new Blob([cfg], { type: 'text/plain' });
      await tgSendDocument(env, chat_id, { blob, filename }, { caption: `📄 فایل کانفیگ WireGuard (${ep.country || ''})` });
      // Save WG config for later resend
      try { await saveUserConfigItem(env, uid, 'wg', { filename, country: ep.country || '', content: cfg }); } catch {}
      if (idx >= 0) {
        s2.wg_endpoints[idx] = s2.wg_endpoints[idx] || {};
        const used = Number(s2.wg_endpoints[idx].used_count || 0) + 1;
        s2.wg_endpoints[idx].used_count = used;
        await setSettings(env, s2);
      }
      await clearUserState(env, uid);
      await tgAnswerCallbackQuery(env, cb.id, 'ارسال شد');
      return;
    }
    
    if (data === 'ps_dns') {
      const v4 = await countAvailableDns(env, 'v4');
      const v6 = await countAvailableDns(env, 'v6');
      const price = await getDnsPrice(env);
      const txt = [
        '🎛 سرویس دی‌ان‌اس خصوصی',
        `قیمت هر دی‌ان‌اس: ${fmtNum(price)} ${CONFIG.DEFAULT_CURRENCY}`,
        `موجودی: IPv4 = ${fmtNum(v4)} | IPv6 = ${fmtNum(v6)}`,
        '',
        'نوع را انتخاب کنید:',
      ].join('\n');
      await tgEditMessage(env, chat_id, mid, txt, dnsMenuKb());
      await tgAnswerCallbackQuery(env, cb.id);
      return;
    }
    if (data === 'ps_dns_v4' || data === 'ps_dns_v6') {
      const version = data.endsWith('_v4') ? 'v4' : 'v6';
      // Build a location keyboard grouped by country with availability counts
      const map = await groupDnsAvailabilityByCountry(env, version);
      const countries = Object.keys(map);
      if (!countries.length) {
        await tgAnswerCallbackQuery(env, cb.id, 'ناموجود');
        await sendNotAvailable(env, chat_id);
        return;
      }
      const rows = [];
      for (let i = 0; i < countries.length; i += 2) {
        const c1 = countries[i];
        const c2 = countries[i + 1];
        const f1 = (map[c1]?.flag) || '🌐';
        const n1 = map[c1]?.count || 0;
        const row = [ { text: `${f1} ${c1} — ${fmtNum(n1)}`, callback_data: `ps_dns_loc:${version}:${c1}` } ];
        if (c2) {
          const f2 = (map[c2]?.flag) || '🌐';
          const n2 = map[c2]?.count || 0;
          row.push({ text: `${f2} ${c2} — ${fmtNum(n2)}`, callback_data: `ps_dns_loc:${version}:${c2}` });
        }
        rows.push(row);
      }
      rows.push([{ text: '🔙 بازگشت', callback_data: 'ps_dns' }]);
      await tgEditMessage(env, chat_id, mid, `🌍 نسخه ${version.toUpperCase()} — یک لوکیشن را انتخاب کنید:`, kb(rows));
      await tgAnswerCallbackQuery(env, cb.id);
      return;
    }
    if (data.startsWith('ps_dns_loc:')) {
      const parts = data.split(':');
      const version = parts[1] === 'v6' ? 'v6' : 'v4';
      const country = parts.slice(2).join(':');
      const price = await getDnsPrice(env);
      const count = await countAvailableDnsByCountry(env, version, country);
      if (count <= 0) { await tgAnswerCallbackQuery(env, cb.id, 'ناموجود'); await sendNotAvailable(env, chat_id); return; }
      await setUserState(env, uid, { step: 'ps_dns_confirm', version, country, price });
      await tgEditMessage(env, chat_id, mid, `دریافت DNS ${version.toUpperCase()} — ${country}\nهزینه: ${fmtNum(price)} ${CONFIG.DEFAULT_CURRENCY}\nموجودی ${country}: ${fmtNum(count)}\nتایید می‌کنید؟`, kb([
        [{ text: `✅ تایید`, callback_data: 'ps_dns_confirm' }],
        [{ text: '❌ انصراف', callback_data: 'ps_dns_cancel' }]
      ]));
      await tgAnswerCallbackQuery(env, cb.id);
      return;
    }
    if (data === 'ps_dns_cancel') {
      await clearUserState(env, uid);
      await tgAnswerCallbackQuery(env, cb.id, 'لغو شد');
      await tgSendMessage(env, chat_id, 'عملیات لغو شد.', dnsMenuKb());
      return;
    }
    if (data === 'ps_dns_confirm') {
      const st = await getUserState(env, uid);
      const version = st?.version === 'v6' ? 'v6' : 'v4';
      const country = st?.country || '';
      const price = Number(st?.price || 0) || await getDnsPrice(env);
      if (!country) { await clearUserState(env, uid); await tgAnswerCallbackQuery(env, cb.id, 'نامعتبر'); return; }
      const avail = await countAvailableDnsByCountry(env, version, country);
      if (avail <= 0) { await clearUserState(env, uid); await tgAnswerCallbackQuery(env, cb.id, 'ناموجود'); await sendNotAvailable(env, chat_id); return; }
      const u = await getUser(env, uid);
      const bal = Number(u?.balance || 0);
      if (bal < price) { await tgAnswerCallbackQuery(env, cb.id, 'موجودی ناکافی'); await tgSendMessage(env, chat_id, `برای دریافت دی‌ان‌اس به ${fmtNum(price)} ${CONFIG.DEFAULT_CURRENCY} نیاز دارید.`, kb([[{ text: '🏠 منوی اصلی', callback_data: 'back_main' }]])); return; }
      const alloc = await allocateDnsForUserByCountry(env, uid, version, country);
      if (!alloc) { await tgAnswerCallbackQuery(env, cb.id, 'خطا/ناموجود'); await tgSendMessage(env, chat_id, '❌ خطا در اختصاص دی‌ان‌اس.', mainMenuInlineKb()); return; }
      const ok = await subtractBalance(env, uid, price);
      if (!ok) {
        try { await unassignDns(env, alloc.version, alloc.ip); } catch {}
        await tgAnswerCallbackQuery(env, cb.id, 'موجودی ناکافی');
        await tgSendMessage(env, chat_id, `برای دریافت دی‌ان‌اس به ${fmtNum(price)} ${CONFIG.DEFAULT_CURRENCY} نیاز دارید.`);
        return;
      }
      const flag = alloc.flag || '🌐';
      const ip = alloc.ip;
      const caption = `🌐 <b>DNS اختصاصی شما</b>
      
${flag} <b>${country}</b>
<code>${ip}</code>

🔧 <b>با این DNS می‌توانید سرور خودتان را تونل کنید</b>

✅ <b>DNS Tunnel List</b>👇
➖➖➖➖➖➖➖➖
<b>گوگل</b>
<code>8.8.8.8</code>
<code>8.8.4.4</code>
➖➖➖➖➖➖➖➖
<b>کلودفلر</b>
<code>1.1.1.1</code>
<code>1.0.0.1</code>
➖➖➖➖➖➖➖➖
<b>رادار گیم</b>
<code>10.202.10.10</code>
<code>10.202.10.11</code>
➖➖➖➖➖➖➖➖
<b>الکترو</b>
<code>78.157.42.100</code>
<code>78.157.42.101</code>
➖➖➖➖➖➖➖➖
<b>اوپن دی ان اس</b>
<code>208.67.222.222</code>
<code>208.67.220.220</code>
➖➖➖➖➖➖➖➖
<b>شکن رایگان</b>
<code>178.22.122.100</code>
<code>185.51.200.2</code>
➖➖➖➖➖➖➖➖
<b>شکن پرو</b>
<code>178.22.122.101</code>
<code>185.51.200.1</code>
➖➖➖➖➖➖➖➖`;
      await tgAnswerCallbackQuery(env, cb.id, 'اختصاص یافت');
      // Use a back-to-main button that does NOT edit this message (preserve receipt)
      await tgSendMessage(env, chat_id, caption, kb([[{ text: '🏠 منوی اصلی', callback_data: 'back_main_new' }]]));
      await clearUserState(env, uid);
      return;
    }

    // تایید یا لغو دریافت فایل با کسر سکه
    if (data.startsWith('confirm_buy:')) {
      const token = (data.split(':')[1] || '').trim();
      if (!/^[A-Za-z0-9]{6}$/.test(token)) { await tgAnswerCallbackQuery(env, cb.id, 'توکن نامعتبر'); return; }
      // بارگذاری متای فایل و اجرای کسر/ارسال به صورت صریح
      const key = CONFIG.FILE_PREFIX + token;
      const meta = await kvGet(env, key);
      if (!meta || meta.disabled) { await tgAnswerCallbackQuery(env, cb.id, 'فایل غیرفعال'); return; }
      const price = Number(meta.price || 0);
      const isOwner = String(meta.owner_id) === String(uid);
      const users = Array.isArray(meta.users) ? meta.users : [];
      const paidUsers = Array.isArray(meta.paid_users) ? meta.paid_users : [];
      const already = users.includes(String(uid));
      const alreadyPaid = paidUsers.includes(String(uid));
      if (price > 0 && !isOwner && !alreadyPaid) {
        const u = await getUser(env, String(uid));
        if (!u || Number(u.balance || 0) < price) {
          await tgAnswerCallbackQuery(env, cb.id, 'موجودی کافی نیست');
          await tgSendMessage(env, chat_id, `موجودی شما کافی نیست. برای دریافت این مورد به ${fmtNum(price)} ${CONFIG.DEFAULT_CURRENCY} نیاز دارید.`, kb([[{ text: '🏠 منوی اصلی', callback_data: 'back_main' }]]));
          return;
        }
        const before = Number(u.balance || 0);
        const okSub = await subtractBalance(env, String(uid), price);
        if (!okSub) { await tgAnswerCallbackQuery(env, cb.id, 'خطا در کسر'); return; }
        const after = await getUser(env, String(uid));
        const newBal = Number(after?.balance || (before - price));
        paidUsers.push(String(uid));
        meta.paid_users = paidUsers;
        try {
          await tgAnswerCallbackQuery(env, cb.id, `✅ ${fmtNum(price)} ${CONFIG.DEFAULT_CURRENCY} کسر شد\nموجودی جدید: ${fmtNum(newBal)} ${CONFIG.DEFAULT_CURRENCY}`, { show_alert: true });
          await tgSendMessage(env, chat_id, `💳 کسر انجام شد. موجودی فعلی: <b>${fmtNum(newBal)} ${CONFIG.DEFAULT_CURRENCY}</b>`);
        } catch {}
      }
      if (!already) {
        users.push(String(uid));
        meta.users = users;
      }
      await kvSet(env, key, meta);
      // ارسال محتوا
      const kind = meta.kind || 'document';
      if (kind === 'photo') {
        await tgSendPhoto(env, chat_id, meta.file_id, { caption: `🖼 ${meta.file_name || ''}` });
      } else if (kind === 'text') {
        const content = meta.text || meta.file_name || '—';
        await tgSendMessage(env, chat_id, `📄 محتوا:\n${content}`);
      } else {
        await tgSendDocument(env, chat_id, meta.file_id, { caption: `📄 ${meta.file_name || ''}` });
      }
      try { await tgEditReplyMarkup(env, chat_id, mid, { inline_keyboard: [] }); } catch {}
      await tgAnswerCallbackQuery(env, cb.id, 'انجام شد');
      await clearUserState(env, uid);
      return;
    }
    if (data === 'cancel_buy') {
      try { await tgEditReplyMarkup(env, chat_id, mid, { inline_keyboard: [] }); } catch {}
      await tgSendMessage(env, chat_id, 'عملیات لغو شد.');
      await tgAnswerCallbackQuery(env, cb.id, 'لغو شد');
      return;
    }

    // Removed: redeem_token menu button

    if (data === 'buy_coins') {
      // لیست پلن‌ها
      let plans = CONFIG.PLANS;
      try { const s = await getSettings(env); if (Array.isArray(s.plans) && s.plans.length) plans = s.plans; } catch {}
      const rows = plans.map(p => ([{ text: `${p.coins} ${CONFIG.DEFAULT_CURRENCY} — ${p.price_label}`, callback_data: 'buy_plan:' + p.id }]));
      rows.push([{ text: '🔙 بازگشت', callback_data: 'back_main' }]);
      await tgSendMessage(env, chat_id, '🪙 یکی از پلن‌های زیر را انتخاب کنید:', kb(rows));
      await tgAnswerCallbackQuery(env, cb.id);
      return;
    }

    if (data.startsWith('buy_plan:')) {
      let plans = CONFIG.PLANS;
      try { const s = await getSettings(env); if (Array.isArray(s.plans) && s.plans.length) plans = s.plans; } catch {}
      const planId = data.split(':')[1];
      const plan = plans.find(p => p.id === planId);
      if (!plan) { await tgAnswerCallbackQuery(env, cb.id, 'پلن یافت نشد'); return; }
      // Card info from settings (KV) with fallback to CONFIG
      let s = {};
      try { s = await getSettings(env); } catch {}
      const card = (s && s.card_info && typeof s.card_info === 'object') ? s.card_info : CONFIG.CARD_INFO;
      const txt = [
        'اطلاعات پرداخت',
        `پلن انتخابی: ${plan.coins} ${CONFIG.DEFAULT_CURRENCY}`,
        `مبلغ: ${plan.price_label}`,
        'شماره کارت:',
        `<code>${card.card_number}</code>`,
        `به نام: ${card.holder_name}`,
        '',
        card.pay_note,
      ].join('\n');
      await setUserState(env, uid, { step: 'buy_wait_receipt', plan_id: plan.id, coins: plan.coins, amount_label: plan.price_label });
      const kbPaid = kb([[{ text: '✅ پرداخت کردم، ارسال رسید', callback_data: 'buy_paid:' + plan.id }], [{ text: '🔙 بازگشت', callback_data: 'back_main' }]]);
      await tgEditMessage(env, chat_id, mid, txt, kbPaid);
      await tgAnswerCallbackQuery(env, cb.id);
      return;
    }

    if (data.startsWith('buy_paid:')) {
      // راهنمای ارسال رسید + حفظ اطلاعات پلن انتخاب‌شده
      const planId = (data.split(':')[1] || '');
      let plans = CONFIG.PLANS;
      try { const s = await getSettings(env); if (Array.isArray(s.plans) && s.plans.length) plans = s.plans; } catch {}
      const plan = plans.find(p => p.id === planId);
      const coins = plan ? plan.coins : undefined;
      const amount_label = plan ? plan.price_label : undefined;
      await setUserState(env, uid, { step: 'buy_wait_receipt', plan_id: planId, coins, amount_label });
      // Remove inline keyboard so the button cannot be pressed twice
      try { await tgEditReplyMarkup(env, chat_id, mid, { inline_keyboard: [] }); } catch {}
      await tgSendMessage(env, chat_id, 'لطفاً رسید پرداخت را به صورت عکس یا فایل ارسال کنید.');
      await tgAnswerCallbackQuery(env, cb.id);
      return;
    }

    if (data === 'ticket_new') {
      // انتخاب نوع تیکت
      const kbTypes = kb([[{ text: '📄 عمومی', callback_data: 'ticket_type:general' }, { text: '💳 پرداختی', callback_data: 'ticket_type:payment' }], [{ text: '🔙 بازگشت', callback_data: 'back_main' }]]);
      await tgSendMessage(env, chat_id, 'نوع تیکت را انتخاب کنید:', kbTypes);
      await tgAnswerCallbackQuery(env, cb.id);
      return;
    }
    if (data.startsWith('ticket_type:')) {
      const ttype = data.split(':')[1];
      await setUserState(env, uid, { step: 'ticket_wait', type: (ttype === 'payment' ? 'payment' : 'general') });
      await tgEditMessage(env, chat_id, mid, '🎫 لطفاً متن تیکت خود را ارسال کنید. /update برای لغو', {});
      await tgAnswerCallbackQuery(env, cb.id);
      return;
    }

    if (data === 'fm') {
      if (!isAdminUser(env, uid)) { await tgAnswerCallbackQuery(env, cb.id, 'این بخش مخصوص مدیر است'); return; }
      await tgEditMessage(env, chat_id, mid, '📁 مدیریت فایل‌ها', fmMenuKb());
      await tgAnswerCallbackQuery(env, cb.id);
      return;
    }
    if (data === 'ticket_new') {
      await setUserState(env, uid, { step: 'ticket_wait' });
      await tgEditMessage(env, chat_id, mid, '📝 لطفاً متن تیکت خود را ارسال کنید. /update برای لغو', {});
      await tgAnswerCallbackQuery(env, cb.id);
      return;
    }
    if (data === 'giftcode') {
      await setUserState(env, uid, { step: 'gift_redeem_wait' });
      await tgEditMessage(env, chat_id, mid, '🎁 لطفاً کد هدیه را ارسال کنید. /update برای لغو', {});
      await tgAnswerCallbackQuery(env, cb.id);
      return;
    }

    if (data === 'myfiles' || data.startsWith('myfiles_p:')) {
        if (!isAdminUser(env, uid)) { await tgAnswerCallbackQuery(env, cb.id, 'این بخش مخصوص مدیر است'); return; }
        let page = 1;
        if (data.startsWith('myfiles_p:')) { const p = parseInt(data.split(':')[1]||'1',10); if (!isNaN(p) && p>0) page = p; }
        const pageSize = 10;
        const all = await listUserFiles(env, uid, 1000);
        if (all.length === 0) {
          await tgEditMessage(env, chat_id, mid, '🗂 فایلی وجود ندارد.', fmMenuKb());
        } else {
          const totalPages = Math.max(1, Math.ceil(all.length / pageSize));
          if (page > totalPages) page = totalPages;
          const start = (page-1)*pageSize;
          const slice = all.slice(start, start+pageSize);
          const rows = slice.map(f => ([{ text: `${kindIcon(f.kind)} مدیریت: ${f.token}`, callback_data: 'file_manage:' + f.token }]))
          const nav = [];
          if (page>1) nav.push({ text: '⬅️ قبلی', callback_data: 'myfiles_p:'+(page-1) });
          if (page<totalPages) nav.push({ text: 'بعدی ➡️', callback_data: 'myfiles_p:'+(page+1) });
          if (nav.length) rows.push(nav);
          rows.push([{ text: '🔙 بازگشت', callback_data: 'back_main' }]);
          await tgEditMessage(env, chat_id, mid, `🗂 فایل‌های شما — صفحه ${page}/${totalPages} — یک مورد را برای مدیریت انتخاب کنید:`, kb(rows));
        }
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }
      if (data.startsWith('file_manage:')) {
        const token = data.split(':')[1];
        const meta = await kvGet(env, CONFIG.FILE_PREFIX + token);
        if (!meta || String(meta.owner_id) !== String(uid)) { await tgAnswerCallbackQuery(env, cb.id, 'در دسترس نیست'); return; }
        const botUser = await getBotUsername(env);
        const base = await getBaseUrlFromBot(env);
        const deepLink = botUser ? `https://t.me/${botUser}?start=${meta.token}` : '';
        const publicLink = base ? `${base}/f/${meta.token}?uid=${uid}` : '';
        const info = [
          `توکن: <code>${meta.token}</code>`,
          `نام: <b>${htmlEscape(meta.file_name)}</b>`,
          `قیمت: <b>${fmtNum(meta.price||0)}</b> ${CONFIG.DEFAULT_CURRENCY}`,
          `محدودیت یکتا: <b>${meta.max_users||0}</b>`,
          deepLink ? `لینک ربات: <code>${deepLink}</code>` : '',
          publicLink ? `لینک مستقیم (با uid): <code>${publicLink}</code>` : '',
        ].filter(Boolean).join('\n');
        await tgEditMessage(env, chat_id, mid, info, buildFileAdminKb(meta));
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }
      if (data.startsWith('file_toggle_disable:')) {
        const t = data.split(':')[1];
        const key = CONFIG.FILE_PREFIX + t;
        const meta = await kvGet(env, key);
        if (!meta || String(meta.owner_id) !== String(uid)) { await tgAnswerCallbackQuery(env, cb.id, 'نامعتبر'); return; }
        meta.disabled = !meta.disabled;
        await kvSet(env, key, meta);
        const botUser = await getBotUsername(env);
        const base = await getBaseUrlFromBot(env);
        const deepLink = botUser ? `https://t.me/${botUser}?start=${meta.token}` : '';
        const publicLink = base ? `${base}/f/${meta.token}?uid=${uid}` : '';
        const info = [
          `توکن: <code>${meta.token}</code>`,
          `نام: <b>${htmlEscape(meta.file_name)}</b>`,
          `قیمت: <b>${fmtNum(meta.price||0)}</b> ${CONFIG.DEFAULT_CURRENCY}`,
          `محدودیت یکتا: <b>${meta.max_users||0}</b>`,
          `وضعیت: ${meta.disabled ? '⛔️ غیرفعال' : '✅ فعال'}`,
          deepLink ? `لینک ربات: <code>${deepLink}</code>` : '',
          publicLink ? `لینک مستقیم (با uid): <code>${publicLink}</code>` : '',
        ].filter(Boolean).join('\n');
        await tgEditMessage(env, chat_id, mid, info, buildFileAdminKb(meta));
        await tgAnswerCallbackQuery(env, cb.id, meta.disabled ? 'غیرفعال شد' : 'فعال شد');
        return;
      }
      if (data.startsWith('file_set_price:')) {
        const t = data.split(':')[1];
        const key = CONFIG.FILE_PREFIX + t;
        const meta = await kvGet(env, key);
        if (!meta || String(meta.owner_id) !== String(uid)) { await tgAnswerCallbackQuery(env, cb.id, 'نامعتبر'); return; }
        await setUserState(env, uid, { step: 'file_set_price_wait', token: t });
        await tgSendMessage(env, chat_id, '💰 قیمت جدید را ارسال کنید (عدد):');
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }
      if (data.startsWith('file_set_limit:')) {
        const t = data.split(':')[1];
        const key = CONFIG.FILE_PREFIX + t;
        const meta = await kvGet(env, key);
        if (!meta || String(meta.owner_id) !== String(uid)) { await tgAnswerCallbackQuery(env, cb.id, 'نامعتبر'); return; }
        await setUserState(env, uid, { step: 'file_set_limit_wait', token: t });
        await tgSendMessage(env, chat_id, '🔢 محدودیت یکتا را ارسال کنید (عدد، 0 یعنی بدون محدودیت):');
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }
      if (data.startsWith('file_replace:')) {
        const t = data.split(':')[1];
        const key = CONFIG.FILE_PREFIX + t;
        const meta = await kvGet(env, key);
        if (!meta || String(meta.owner_id) !== String(uid)) { await tgAnswerCallbackQuery(env, cb.id, 'نامعتبر'); return; }
        await setUserState(env, uid, { step: 'file_replace_wait', token: t });
        await tgSendMessage(env, chat_id, '📤 لطفاً فایل/رسانه جدید را ارسال کنید.');
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }

      if (data.startsWith('file_delete:')) {
        const t = data.split(':')[1];
        const key = CONFIG.FILE_PREFIX + t;
        const meta = await kvGet(env, key);
        if (!meta || String(meta.owner_id) !== String(uid)) { await tgAnswerCallbackQuery(env, cb.id, 'نامعتبر'); return; }
        const kbDel = kb([[{ text: '✅ تایید حذف', callback_data: 'file_delete_confirm:' + t }],[{ text: '🔙 انصراف', callback_data: 'file_manage:' + t }]]);
        await tgEditMessage(env, chat_id, mid, `❗️ آیا از حذف فایل با توکن <code>${t}</code> مطمئن هستید؟ این عملیات غیرقابل بازگشت است.`, kbDel);
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }

      if (data.startsWith('file_delete_confirm:')) {
        const t = data.split(':')[1];
        const key = CONFIG.FILE_PREFIX + t;
        const meta = await kvGet(env, key);
        if (!meta || String(meta.owner_id) !== String(uid)) { await tgAnswerCallbackQuery(env, cb.id, 'نامعتبر'); return; }
        await kvDel(env, key);
        await tgEditMessage(env, chat_id, mid, `🗑 فایل با توکن <code>${t}</code> حذف شد.`, fmMenuKb());
        await tgAnswerCallbackQuery(env, cb.id, 'حذف شد');
        return;
      }

    if (data === 'update') {
      await clearUserState(env, uid);
      const hdr = await mainMenuHeader(env);
      await tgEditMessage(env, chat_id, mid, hdr, mainMenuKb(env, uid));
      await tgAnswerCallbackQuery(env, cb.id);
      return;
    }

    // پنل ادمین (اگر ادمین باشد)
    if (isAdminUser(env, uid)) {
      if (data === 'admin') {
        const settings = await getSettings(env);
        await tgEditMessage(env, chat_id, mid, 'پنل مدیریت:', adminMenuKb(settings));
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }
      // Admin: Custom buttons management
      if (data === 'adm_cbtn') {
        const s = await getSettings(env);
        const ids = Array.isArray(s.custom_buttons) ? s.custom_buttons : [];
        const rows = [];
        for (const id of ids) {
          const m = await kvGet(env, CONFIG.CUSTOMBTN_PREFIX + id);
          if (!m) continue;
          rows.push([{ text: m.title, callback_data: 'adm_cbtn_item:'+id }]);
        }
        const sortLabel = s?.market_sort === 'oldest' ? 'قدیم به جدید' : (s?.market_sort === 'newest' ? 'جدید به قدیم' : 'دستی');
        const mode = s?.market_sort ? s.market_sort : 'manual';
        rows.push([{ text: '➕ افزودن دکمه', callback_data: 'adm_cbtn_add' }]);
        rows.push([
          { text: `ترتیب: ${sortLabel}`, callback_data: 'noop' }
        ]);
        rows.push([
          { text: `${mode==='oldest'?'✅ ':''}قدیم به جدید`, callback_data: 'adm_cbtn_sort:oldest' },
          { text: `${mode==='newest'?'✅ ':''}جدید به قدیم`, callback_data: 'adm_cbtn_sort:newest' },
          { text: `${mode==='manual'?'✅ ':''}دستی`, callback_data: 'adm_cbtn_sort:manual' },
        ]);
        rows.push([{ text: '🔙 بازگشت', callback_data: 'admin' }]);
        await tgEditMessage(env, chat_id, mid, '🧩 مدیریت بازارچه — یک آیتم را انتخاب کنید:', kb(rows));
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }
      if (data.startsWith('adm_cbtn_sort:')) {
        const mode = data.split(':')[1];
        const s = await getSettings(env);
        if (mode === 'oldest') s.market_sort = 'oldest';
        else if (mode === 'newest') s.market_sort = 'newest';
        else delete s.market_sort;
        await setSettings(env, s);
        await rebuildCustomButtonsCache(env);
        // refresh list
        const ids = Array.isArray(s.custom_buttons) ? s.custom_buttons : [];
        const rows = [];
        for (const id of ids) {
          const m = await kvGet(env, CONFIG.CUSTOMBTN_PREFIX + id);
          if (!m) continue;
          rows.push([{ text: m.title, callback_data: 'adm_cbtn_item:'+id }]);
        }
        const sortLabel = s?.market_sort === 'oldest' ? 'قدیمی→جدید' : (s?.market_sort === 'newest' ? 'جدید→قدیمی' : 'دستی');
        const mode2 = s?.market_sort ? s.market_sort : 'manual';
        rows.push([{ text: '➕ افزودن دکمه', callback_data: 'adm_cbtn_add' }]);
        rows.push([{ text: `ترتیب: ${sortLabel}`, callback_data: 'noop' }]);
        rows.push([
          { text: `${mode2==='oldest'?'✅ ':''}قدیمی→جدید`, callback_data: 'adm_cbtn_sort:oldest' },
          { text: `${mode2==='newest'?'✅ ':''}جدید→قدیمی`, callback_data: 'adm_cbtn_sort:newest' },
          { text: `${mode2==='manual'?'✅ ':''}دستی`, callback_data: 'adm_cbtn_sort:manual' },
        ]);
        rows.push([{ text: '🔙 بازگشت', callback_data: 'admin' }]);
        await tgEditMessage(env, chat_id, mid, '🧩 مدیریت بازارچه — یک آیتم را انتخاب کنید:', kb(rows));
        await tgAnswerCallbackQuery(env, cb.id, 'بروزرسانی شد');
        return;
      }
      if (data.startsWith('adm_cbtn_item:')) {
        const id = data.split(':')[1];
        const m = await kvGet(env, CONFIG.CUSTOMBTN_PREFIX + id);
        if (!m) { await tgAnswerCallbackQuery(env, cb.id, 'یافت نشد'); return; }
        const status = m.disabled ? '⛔️ غیرفعال' : '🟢 فعال';
        const info = `عنوان: ${htmlEscape(m.title)}\nوضعیت: ${status}\nقیمت: ${fmtNum(m.price)} ${CONFIG.DEFAULT_CURRENCY}\nمحدودیت یکتا: ${fmtNum(m.max_users||0)}`;
        const rows = [
          [{ text: m.disabled ? '✅ فعال‌سازی' : '⛔️ غیرفعال‌سازی', callback_data: 'adm_cbtn_toggle:'+id }],
          [{ text: '♻️ جایگزینی محتوا', callback_data: 'adm_cbtn_replace:'+id }],
          [{ text: '💰 تغییر قیمت', callback_data: 'adm_cbtn_set_price:'+id }],
          [{ text: '👥 تغییر محدودیت', callback_data: 'adm_cbtn_set_limit:'+id }],
          [{ text: m.wide ? '📏 حالت معمولی' : '📏 حالت عریض', callback_data: 'adm_cbtn_wide_toggle:'+id }],
          [{ text: '⬆️ انتقال به بالا', callback_data: 'adm_cbtn_move:'+id+':up' }, { text: '⬇️ انتقال به پایین', callback_data: 'adm_cbtn_move:'+id+':down' }],
          [{ text: '⏫ انتقال به ابتدا', callback_data: 'adm_cbtn_move:'+id+':top' }, { text: '⏬ انتقال به انتها', callback_data: 'adm_cbtn_move:'+id+':bottom' }],
          [{ text: '🗑 حذف', callback_data: 'adm_cbtn_del:'+id }],
          [{ text: '🔙 بازگشت به فهرست', callback_data: 'adm_cbtn' }]
        ];
        await tgEditMessage(env, chat_id, mid, `مدیریت آیتم بازارچه\n\n${info}`, kb(rows));
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }
      if (data === 'adm_cbtn_add') {
        await setUserState(env, uid, { step: 'adm_cbtn_wait_file' });
        await tgEditMessage(env, chat_id, mid, '📥 محتوا را ارسال کنید (سند/عکس/ویدیو/صوت) یا متنی که باید فروخته شود را بنویسید:', {});
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }
      if (data.startsWith('adm_cbtn_toggle:')) {
        const id = data.split(':')[1];
        const m = await kvGet(env, CONFIG.CUSTOMBTN_PREFIX + id);
        if (m) { m.disabled = !m.disabled; await kvSet(env, CONFIG.CUSTOMBTN_PREFIX + id, m); }
        await rebuildCustomButtonsCache(env);
        // refresh item submenu
        const mm = await kvGet(env, CONFIG.CUSTOMBTN_PREFIX + id);
        if (!mm) { await tgEditMessage(env, chat_id, mid, 'آیتم یافت نشد', kb([[{ text: '🔙 بازگشت', callback_data: 'adm_cbtn' }]])); return; }
        const status = mm.disabled ? '⛔️ غیرفعال' : '🟢 فعال';
        const info = `عنوان: ${htmlEscape(mm.title)}\nوضعیت: ${status}\nقیمت: ${fmtNum(mm.price)} ${CONFIG.DEFAULT_CURRENCY}\nمحدودیت یکتا: ${fmtNum(mm.max_users||0)}`;
        const rows = [
          [{ text: mm.disabled ? '✅ فعال‌سازی' : '⛔️ غیرفعال‌سازی', callback_data: 'adm_cbtn_toggle:'+id }],
          [{ text: '♻️ جایگزینی محتوا', callback_data: 'adm_cbtn_replace:'+id }],
          [{ text: '💰 تغییر قیمت', callback_data: 'adm_cbtn_set_price:'+id }],
          [{ text: '👥 تغییر محدودیت', callback_data: 'adm_cbtn_set_limit:'+id }],
          [{ text: mm.wide ? '📏 حالت معمولی' : '📏 حالت عریض', callback_data: 'adm_cbtn_wide_toggle:'+id }],
          [{ text: '⬆️ انتقال به بالا', callback_data: 'adm_cbtn_move:'+id+':up' }, { text: '⬇️ انتقال به پایین', callback_data: 'adm_cbtn_move:'+id+':down' }],
          [{ text: '⏫ انتقال به ابتدا', callback_data: 'adm_cbtn_move:'+id+':top' }, { text: '⏬ انتقال به انتها', callback_data: 'adm_cbtn_move:'+id+':bottom' }],
          [{ text: '🗑 حذف', callback_data: 'adm_cbtn_del:'+id }],
          [{ text: '🔙 بازگشت به فهرست', callback_data: 'adm_cbtn' }]
        ];
        await tgEditMessage(env, chat_id, mid, `مدیریت آیتم بازارچه\n\n${info}`, kb(rows));
        await tgAnswerCallbackQuery(env, cb.id, 'بروزرسانی شد');
        return;
      }
      if (data.startsWith('adm_cbtn_wide_toggle:')) {
        const id = data.split(':')[1];
        const m = await kvGet(env, CONFIG.CUSTOMBTN_PREFIX + id);
        if (!m) { await tgAnswerCallbackQuery(env, cb.id, 'یافت نشد'); return; }
        m.wide = !m.wide;
        await kvSet(env, CONFIG.CUSTOMBTN_PREFIX + id, m);
        await rebuildCustomButtonsCache(env);
        // refresh submenu
        const mm = await kvGet(env, CONFIG.CUSTOMBTN_PREFIX + id);
        const status = mm.disabled ? '⛔️ غیرفعال' : '🟢 فعال';
        const info = `عنوان: ${htmlEscape(mm.title)}\nوضعیت: ${status}\nقیمت: ${fmtNum(mm.price)} ${CONFIG.DEFAULT_CURRENCY}\nمحدودیت یکتا: ${fmtNum(mm.max_users||0)}`;
        const rows = [
          [{ text: mm.disabled ? '✅ فعال‌سازی' : '⛔️ غیرفعال‌سازی', callback_data: 'adm_cbtn_toggle:'+id }],
          [{ text: '♻️ جایگزینی محتوا', callback_data: 'adm_cbtn_replace:'+id }],
          [{ text: '💰 تغییر قیمت', callback_data: 'adm_cbtn_set_price:'+id }],
          [{ text: '👥 تغییر محدودیت', callback_data: 'adm_cbtn_set_limit:'+id }],
          [{ text: mm.wide ? '📏 حالت معمولی' : '📏 حالت عریض', callback_data: 'adm_cbtn_wide_toggle:'+id }],
          [{ text: '⬆️ انتقال به بالا', callback_data: 'adm_cbtn_move:'+id+':up' }, { text: '⬇️ انتقال به پایین', callback_data: 'adm_cbtn_move:'+id+':down' }],
          [{ text: '⏫ انتقال به ابتدا', callback_data: 'adm_cbtn_move:'+id+':top' }, { text: '⏬ انتقال به انتها', callback_data: 'adm_cbtn_move:'+id+':bottom' }],
          [{ text: '🗑 حذف', callback_data: 'adm_cbtn_del:'+id }],
          [{ text: '🔙 بازگشت به فهرست', callback_data: 'adm_cbtn' }]
        ];
        await tgEditMessage(env, chat_id, mid, `مدیریت آیتم بازارچه\n\n${info}`, kb(rows));
        await tgAnswerCallbackQuery(env, cb.id, 'بروزرسانی شد');
        return;
      }
      if (data.startsWith('adm_cbtn_move:')) {
        const parts = data.split(':');
        const id = parts[1];
        const dir = parts[2];
        const s = await getSettings(env);
        const list = Array.isArray(s.custom_buttons) ? s.custom_buttons.slice() : [];
        const idx = list.indexOf(id);
        if (idx === -1) { await tgAnswerCallbackQuery(env, cb.id, 'یافت نشد'); return; }
        // compute new index
        let ni = idx;
        if (dir === 'up' && idx > 0) ni = idx - 1;
        if (dir === 'down' && idx < list.length - 1) ni = idx + 1;
        if (dir === 'top') ni = 0;
        if (dir === 'bottom') ni = list.length - 1;
        if (ni !== idx) {
          list.splice(idx, 1);
          list.splice(ni, 0, id);
          s.custom_buttons = list;
          await setSettings(env, s);
          await rebuildCustomButtonsCache(env);
        }
        // refresh submenu
        const mm = await kvGet(env, CONFIG.CUSTOMBTN_PREFIX + id);
        const status = mm?.disabled ? '⛔️ غیرفعال' : '🟢 فعال';
        const info = mm ? `عنوان: ${htmlEscape(mm.title)}\nوضعیت: ${status}\nقیمت: ${fmtNum(mm.price)} ${CONFIG.DEFAULT_CURRENCY}\nمحدودیت یکتا: ${fmtNum(mm.max_users||0)}` : 'آیتم یافت نشد';
        const rows = mm ? [
          [{ text: mm.disabled ? '✅ فعال‌سازی' : '⛔️ غیرفعال‌سازی', callback_data: 'adm_cbtn_toggle:'+id }],
          [{ text: '♻️ جایگزینی محتوا', callback_data: 'adm_cbtn_replace:'+id }],
          [{ text: '💰 تغییر قیمت', callback_data: 'adm_cbtn_set_price:'+id }],
          [{ text: '👥 تغییر محدودیت', callback_data: 'adm_cbtn_set_limit:'+id }],
          [{ text: mm.wide ? '📏 حالت معمولی' : '📏 حالت عریض', callback_data: 'adm_cbtn_wide_toggle:'+id }],
          [{ text: '⬆️ انتقال به بالا', callback_data: 'adm_cbtn_move:'+id+':up' }, { text: '⬇️ انتقال به پایین', callback_data: 'adm_cbtn_move:'+id+':down' }],
          [{ text: '⏫ انتقال به ابتدا', callback_data: 'adm_cbtn_move:'+id+':top' }, { text: '⏬ انتقال به انتها', callback_data: 'adm_cbtn_move:'+id+':bottom' }],
          [{ text: '🗑 حذف', callback_data: 'adm_cbtn_del:'+id }],
          [{ text: '🔙 بازگشت به فهرست', callback_data: 'adm_cbtn' }]
        ] : [[{ text: '🔙 بازگشت', callback_data: 'adm_cbtn' }]];
        await tgEditMessage(env, chat_id, mid, `مدیریت آیتم بازارچه\n\n${info}`, kb(rows));
        await tgAnswerCallbackQuery(env, cb.id, 'جابجا شد');
        return;
      }
      if (data.startsWith('adm_cbtn_del:')) {
        const id = data.split(':')[1];
        await kvDel(env, CONFIG.CUSTOMBTN_PREFIX + id);
        const s = await getSettings(env);
        s.custom_buttons = (Array.isArray(s.custom_buttons) ? s.custom_buttons : []).filter(x => x !== id);
        await setSettings(env, s);
        await rebuildCustomButtonsCache(env);
        // back to list
        const ids = Array.isArray(s.custom_buttons) ? s.custom_buttons : [];
        const rows = [];
        for (const bid of ids) {
          const mm = await kvGet(env, CONFIG.CUSTOMBTN_PREFIX + bid);
          if (!mm) continue;
          rows.push([{ text: mm.title, callback_data: 'adm_cbtn_item:'+bid }]);
        }
        rows.push([{ text: '➕ افزودن دکمه', callback_data: 'adm_cbtn_add' }]);
        rows.push([{ text: '🔙 بازگشت', callback_data: 'admin' }]);
        await tgEditMessage(env, chat_id, mid, '🧩 مدیریت بازارچه — یک آیتم را انتخاب کنید:', kb(rows));
        await tgAnswerCallbackQuery(env, cb.id, 'حذف شد');
        return;
      }
      if (data.startsWith('adm_cbtn_set_price:')) {
        const id = data.split(':')[1];
        await setUserState(env, uid, { step: 'adm_cbtn_price_change', id });
        await tgAnswerCallbackQuery(env, cb.id);
        await tgSendMessage(env, chat_id, '💰 قیمت جدید را ارسال کنید:');
        return;
      }
      if (data.startsWith('adm_cbtn_set_limit:')) {
        const id = data.split(':')[1];
        await setUserState(env, uid, { step: 'adm_cbtn_limit_change', id });
        await tgAnswerCallbackQuery(env, cb.id);
        await tgSendMessage(env, chat_id, '👥 محدودیت تعداد دریافت‌کنندگان یکتا را ارسال کنید (برای بدون محدودیت 0 بفرستید):');
        return;
      }
      if (data.startsWith('adm_cbtn_replace:')) {
        const id = data.split(':')[1];
        await setUserState(env, uid, { step: 'adm_cbtn_replace_wait', id });
        await tgAnswerCallbackQuery(env, cb.id);
        await tgSendMessage(env, chat_id, '♻️ محتوای جدید را ارسال کنید (می‌تواند متن یا یکی از انواع فایل باشد):');
        return;
      }
      if (data === 'adm_block') {
        await setUserState(env, uid, { step: 'adm_block_uid' });
        await tgAnswerCallbackQuery(env, cb.id);
        await tgSendMessage(env, chat_id, 'آیدی عددی کاربر برای بلاک را ارسال کنید:');
        return;
      }
      if (data === 'adm_unblock') {
        await setUserState(env, uid, { step: 'adm_unblock_uid' });
        await tgAnswerCallbackQuery(env, cb.id);
        await tgSendMessage(env, chat_id, 'آیدی عددی کاربر برای آنبلاک را ارسال کنید:');
        return;
      }
      if (data === 'adm_service') {
        const s = await getSettings(env);
        const enabled = s?.service_enabled !== false;
        const disabledCount = Array.isArray(s.disabled_buttons) ? s.disabled_buttons.length : 0;
        const v4 = await countAvailableDns(env, 'v4');
        const v6 = await countAvailableDns(env, 'v6');
        const btns = [
          // Row: Basic vs Advanced
          [{ text: '⚙️ تنظیمات پایه ربات', callback_data: 'adm_basic' }, { text: '🧩 پیشرفته‌سازی', callback_data: 'adm_advanced' }],
          // Row: Support + Disabled buttons
          [{ text: '🆔 آیدی پشتیبانی', callback_data: 'adm_support' }, { text: `🚫 دکمه‌های غیرفعال (${disabledCount})`, callback_data: 'adm_buttons' }],
          // Row: DNS management
          [{ text: '➕ افزودن DNS', callback_data: 'adm_dns_add' }, { text: '🗑 حذف DNS', callback_data: 'adm_dns_remove' }],
          // Row: OVPN management (upload + delete)
          [{ text: '📥 آپلود OVPN', callback_data: 'adm_ovpn_upload' }, { text: '🗑 حذف OVPN', callback_data: 'adm_ovpn_delete' }],
          // Row: Back actions
          [{ text: '🔙 بازگشت', callback_data: 'admin' }, { text: '🏠 منوی اصلی ربات', callback_data: 'back_main' }],
        ];
        const txt = ` تنظیمات سرویس\nوضعیت سرویس: ${enabled ? 'فعال' : 'غیرفعال'}\nموجودی DNS — IPv4: ${fmtNum(v4)} | IPv6: ${fmtNum(v6)}`;
        const kbSrv = kb(btns);
        await tgEditMessage(env, chat_id, mid, txt, kbSrv);
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }
      if (data === 'adm_advanced') {
        const rows = [
          [{ text: 'تنظیمات قیمت‌های پیش‌فرض', callback_data: 'adm_prices' }],
          [{ text: 'تنظیمات WireGuard', callback_data: 'adm_wg_vars' }],
          [{ text: '🔙 بازگشت', callback_data: 'adm_service' }],
          [{ text: '🏠 منوی اصلی ربات', callback_data: 'back_main' }],
        ];
        await tgEditMessage(env, chat_id, mid, 'پیشرفته سازی سرویس — یکی را انتخاب کنید:', kb(rows));
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }
      // --- Basic settings submenu ---
      if (data === 'adm_basic') {
        const s = await getSettings(env);
        const cn = s?.card_info?.card_number ? `**** ${String(s.card_info.card_number).slice(-4)}` : '—';
        const hn = s?.card_info?.holder_name || '—';
        const plans = Array.isArray(s?.plans) && s.plans.length ? s.plans : CONFIG.PLANS;
        const rows = [
          [{ text: '🆔 آیدی پشتیبانی', callback_data: 'adm_support' }],
          [{ text: `شماره کارت: ${cn}`, callback_data: 'adm_card_number' }],
          [{ text: `نام دارنده: ${hn}`, callback_data: 'adm_card_name' }],
          [{ text: `پلن‌های خرید سکه (${plans.length})`, callback_data: 'adm_plans' }],
          [{ text: '🔙 بازگشت', callback_data: 'adm_service' }],
          [{ text: '🏠 منوی اصلی ربات', callback_data: 'back_main' }],
        ];
        await tgEditMessage(env, chat_id, mid, 'تنظیمات پایه ربات — یک مورد را انتخاب کنید:', kb(rows));
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }
      if (data === 'adm_support') {
        const s = await getSettings(env);
        const cur = s?.support_url || '';
        await setUserState(env, uid, { step: 'adm_support_url' });
        await tgAnswerCallbackQuery(env, cb.id);
        await tgSendMessage(env, chat_id, `آیدی یا لینک پشتیبانی فعلی: ${cur || '—'}\nنمونه مجاز: @YourSupport یا https://t.me/YourSupport\nمقدار جدید را ارسال کنید:`);
        return;
      }
      // --- Card info and plans management ---
      if (data === 'adm_card_number') {
        await setUserState(env, uid, { step: 'adm_card_number' });
        await tgAnswerCallbackQuery(env, cb.id);
        await tgSendMessage(env, chat_id, 'شماره کارت را ارسال کنید. فقط ارقام و فاصله مجاز است (مثال: 6219 8619 4308 4037)');
        return;
      }
      if (data === 'adm_card_name') {
        await setUserState(env, uid, { step: 'adm_card_name' });
        await tgAnswerCallbackQuery(env, cb.id);
        await tgSendMessage(env, chat_id, 'نام دارنده کارت را ارسال کنید (مثال: علی رضایی)');
        return;
      }
      if (data === 'adm_plans') {
        const s = await getSettings(env);
        const plans = Array.isArray(s?.plans) && s.plans.length ? s.plans : CONFIG.PLANS;
        const rows = [];
        for (let i = 0; i < plans.length; i++) {
          const p = plans[i];
          rows.push([
            { text: `${i + 1}) ${fmtNum(p.coins)} ${CONFIG.DEFAULT_CURRENCY} — ${p.price_label}`, callback_data: `adm_plan_edit:${i}` },
            { text: '🗑 حذف', callback_data: `adm_plan_del:${i}` }
          ]);
        }
        rows.push([{ text: '➕ افزودن پلن', callback_data: 'adm_plan_add' }]);
        rows.push([{ text: '🔙 بازگشت', callback_data: 'adm_basic' }]);
        rows.push([{ text: '🏠 منوی اصلی ربات', callback_data: 'back_main' }]);
        await tgEditMessage(env, chat_id, mid, 'مدیریت پلن‌های سکه:', kb(rows));
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }
      if (data === 'adm_plan_add') {
        await setUserState(env, uid, { step: 'adm_plan_add_coins' });
        await tgAnswerCallbackQuery(env, cb.id);
        await tgSendMessage(env, chat_id, 'تعداد سکه پلن جدید را ارسال کنید (فقط عدد):');
        return;
      }
      if (data.startsWith('adm_plan_edit:')) {
        const idx = Number((data.split(':')[1] || '').trim());
        await tgAnswerCallbackQuery(env, cb.id);
        const rows = [
          [{ text: '✏️ ویرایش تعداد سکه', callback_data: `adm_plan_edit_coins:${idx}` }],
          [{ text: '✏️ ویرایش برچسب قیمت', callback_data: `adm_plan_edit_price:${idx}` }],
          [{ text: '🔙 بازگشت', callback_data: 'adm_plans' }],
        ];
        await tgEditMessage(env, chat_id, mid, `ویرایش پلن #${idx + 1}`, kb(rows));
        return;
      }
      if (data.startsWith('adm_plan_edit_coins:')) {
        const idx = Number((data.split(':')[1] || '').trim());
        await setUserState(env, uid, { step: 'adm_plan_edit_coins', idx });
        await tgAnswerCallbackQuery(env, cb.id);
        await tgSendMessage(env, chat_id, 'تعداد سکه جدید را ارسال کنید (فقط عدد):');
        return;
      }
      if (data.startsWith('adm_plan_edit_price:')) {
        const idx = Number((data.split(':')[1] || '').trim());
        await setUserState(env, uid, { step: 'adm_plan_edit_price', idx });
        await tgAnswerCallbackQuery(env, cb.id);
        await tgSendMessage(env, chat_id, 'برچسب قیمت جدید را ارسال کنید (مثلاً ۱۵٬۰۰۰ تومان):');
        return;
      }
      if (data.startsWith('adm_plan_del:')) {
        const idx = Number((data.split(':')[1] || '').trim());
        const s = await getSettings(env);
        const plans = Array.isArray(s?.plans) ? s.plans : (CONFIG.PLANS || []);
        if (idx >= 0 && idx < plans.length) {
          plans.splice(idx, 1);
          s.plans = plans;
          await setSettings(env, s);
        }
        // Refresh list
        const rows = [];
        for (let i = 0; i < plans.length; i++) {
          const p = plans[i];
          rows.push([
            { text: `${i + 1}) ${fmtNum(p.coins)} ${CONFIG.DEFAULT_CURRENCY} — ${p.price_label}`, callback_data: `adm_plan_edit:${i}` },
            { text: '🗑 حذف', callback_data: `adm_plan_del:${i}` }
          ]);
        }
        rows.push([{ text: '➕ افزودن پلن', callback_data: 'adm_plan_add' }]);
        rows.push([{ text: '🔙 بازگشت', callback_data: 'adm_basic' }]);
        rows.push([{ text: '🏠 منوی اصلی ربات', callback_data: 'back_main' }]);
        await tgEditMessage(env, chat_id, mid, 'مدیریت پلن‌های سکه:', kb(rows));
        await tgAnswerCallbackQuery(env, cb.id, 'حذف شد');
        return;
      }
      if (data === 'adm_prices') {
        const op = await getOvpnPrice(env);
        const dp = await getDnsPrice(env);
        const rows = [
          [{ text: '✏️ تغییر قیمت OpenVPN', callback_data: 'adm_price_set_ovpn' }],
          [{ text: '✏️ تغییر قیمت DNS', callback_data: 'adm_price_set_dns' }],
          [{ text: '🔙 بازگشت', callback_data: 'adm_advanced' }],
          [{ text: '🏠 منوی اصلی ربات', callback_data: 'back_main' }],
        ];
        const txt = `تنظیم قیمت‌های پیش‌فرض\nOpenVPN: ${fmtNum(op)} ${CONFIG.DEFAULT_CURRENCY}\nDNS: ${fmtNum(dp)} ${CONFIG.DEFAULT_CURRENCY}`;
        await tgEditMessage(env, chat_id, mid, txt, kb(rows));
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }
      if (data === 'adm_price_set_ovpn') {
        await setUserState(env, uid, { step: 'adm_set_price', key: 'ovpn' });
        await tgAnswerCallbackQuery(env, cb.id);
        await tgSendMessage(env, chat_id, 'مبلغ به سکه برای OpenVPN را وارد کنید (مثلاً 5):');
        return;
      }
      if (data === 'adm_price_set_dns') {
        await setUserState(env, uid, { step: 'adm_set_price', key: 'dns' });
        await tgAnswerCallbackQuery(env, cb.id);
        await tgSendMessage(env, chat_id, 'مبلغ به سکه برای DNS را وارد کنید (مثلاً 2):');
        return;
      }
      if (data === 'adm_wg_vars') {
        const s = await getSettings(env);
        const d = s.wg_defaults || {};
        const txt = [
          '⚙️ پیش‌فرض‌های WireGuard (فقط نمایش):',
          `📍 Address: ${formatWgDefaultValue('address', d.address)}`,
          `🌐 DNS: ${formatWgDefaultValue('dns', d.dns)}`,
          `📏 MTU: ${formatWgDefaultValue('mtu', d.mtu)}`,
          `🔌 ListenPort: ${formatWgDefaultValue('listen_port', d.listen_port)}`,
          `🛡 AllowedIPs: ${formatWgDefaultValue('allowed_ips', d.allowed_ips)}`,
          `⏰ PersistentKeepalive: ${formatWgDefaultValue('persistent_keepalive', d.persistent_keepalive)}`,
          `🔑 Custom PublicKey: ${formatWgDefaultValue('peer_public_key', d.peer_public_key)}`,
          '',
          '✏️ برای ویرایش به پنل وب مراجعه کنید: /admin/wg',
        ].join('\n');
        const rows = [
          [{ text: '🔄 بروزرسانی', callback_data: 'adm_wg_refresh' }],
          [{ text: '🔙 بازگشت', callback_data: 'adm_advanced' }],
          [{ text: '🏠 منوی اصلی ربات', callback_data: 'back_main' }],
        ];
        await tgEditMessage(env, chat_id, mid, txt, kb(rows));
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }
      if (data === 'adm_wg_refresh') {
        const s = await getSettings(env);
        const d = s.wg_defaults || {};
        const txt = [
          '⚙️ پیش‌فرض‌های WireGuard (فقط نمایش):',
          `📍 Address: ${formatWgDefaultValue('address', d.address)}`,
          `🌐 DNS: ${formatWgDefaultValue('dns', d.dns)}`,
          `📏 MTU: ${formatWgDefaultValue('mtu', d.mtu)}`,
          `🔌 ListenPort: ${formatWgDefaultValue('listen_port', d.listen_port)}`,
          `🛡 AllowedIPs: ${formatWgDefaultValue('allowed_ips', d.allowed_ips)}`,
          `⏰ PersistentKeepalive: ${formatWgDefaultValue('persistent_keepalive', d.persistent_keepalive)}`,
          `🔑 Custom PublicKey: ${formatWgDefaultValue('peer_public_key', d.peer_public_key)}`,
          '',
          '✏️ برای ویرایش به پنل وب مراجعه کنید: /admin/wg',
        ].join('\n');
        const rows = [
          [{ text: '🔄 بروزرسانی', callback_data: 'adm_wg_refresh' }],
          [{ text: '🔙 بازگشت', callback_data: 'adm_advanced' }],
          [{ text: '🏠 منوی اصلی ربات', callback_data: 'back_main' }],
        ];
        await tgEditMessage(env, chat_id, mid, txt, kb(rows));
        await tgAnswerCallbackQuery(env, cb.id, 'به‌روز شد');
        return;
      }
      if (data === 'adm_wg_defaults' || data.startsWith('adm_wg_mode:') || data === 'adm_wg_reset' || data.startsWith('adm_wg_edit:')) {
        await tgAnswerCallbackQuery(env, cb.id, 'ویرایش فقط از طریق پنل وب امکان‌پذیر است.');
        const s = await getSettings(env);
        const d = s.wg_defaults || {};
        const txt = [
          '⚙️ پیش‌فرض‌های WireGuard (فقط نمایش):',
          `📍 Address: ${formatWgDefaultValue('address', d.address)}`,
          `🌐 DNS: ${formatWgDefaultValue('dns', d.dns)}`,
          `📏 MTU: ${formatWgDefaultValue('mtu', d.mtu)}`,
          `🔌 ListenPort: ${formatWgDefaultValue('listen_port', d.listen_port)}`,
          `🛡 AllowedIPs: ${formatWgDefaultValue('allowed_ips', d.allowed_ips)}`,
          `⏰ PersistentKeepalive: ${formatWgDefaultValue('persistent_keepalive', d.persistent_keepalive)}`,
          `🔑 Custom PublicKey: ${formatWgDefaultValue('peer_public_key', d.peer_public_key)}`,
          '',
          '✏️ برای ویرایش به پنل وب مراجعه کنید: /admin/wg',
        ].join('\n');
        const rows = [
          [{ text: '🔙 بازگشت', callback_data: 'adm_advanced' }],
          [{ text: '🏠 منوی اصلی ربات', callback_data: 'back_main' }],
        ];
        await tgEditMessage(env, chat_id, mid, txt, kb(rows));
        return;
      }
      if (data.startsWith('adm_wg_mode:')) {
        const sel = String((data.split(':')[1] || '').toLowerCase());
        if (!['cloudflare','endpoint','custom'].includes(sel)) { await tgAnswerCallbackQuery(env, cb.id, 'نامعتبر'); return; }
        const s = await getSettings(env);
        s.wg_defaults = s.wg_defaults || {};
        s.wg_defaults.peer_public_mode = sel;
        await setSettings(env, s);
        
        // Re-fetch fresh data to ensure consistency
        const fresh = await getSettings(env);
        const d = fresh.wg_defaults || {};
        const mode = String((d.peer_public_mode || 'cloudflare')).toLowerCase();
        
        const rows = [
          [{ text: `📍 Address: ${formatWgDefaultValue('address', d.address)}`, callback_data: 'adm_wg_edit:address' }],
          [{ text: `🌐 DNS: ${formatWgDefaultValue('dns', d.dns)}`, callback_data: 'adm_wg_edit:dns' }],
          [{ text: `📏 MTU: ${formatWgDefaultValue('mtu', d.mtu)}`, callback_data: 'adm_wg_edit:mtu' }],
          [{ text: `🔌 ListenPort: ${formatWgDefaultValue('listen_port', d.listen_port)}`, callback_data: 'adm_wg_edit:listen_port' }],
          [{ text: `🛡 AllowedIPs: ${formatWgDefaultValue('allowed_ips', d.allowed_ips)}`, callback_data: 'adm_wg_edit:allowed_ips' }],
          [{ text: `⏰ PersistentKeepalive: ${formatWgDefaultValue('persistent_keepalive', d.persistent_keepalive)}`, callback_data: 'adm_wg_edit:persistent_keepalive' }],
          [
            { text: `${mode==='cloudflare' ? '✅ ' : ''}Cloudflare`, callback_data: 'adm_wg_mode:cloudflare' },
            { text: `${mode==='endpoint' ? '✅ ' : ''}Auto Key`, callback_data: 'adm_wg_mode:endpoint' },
            { text: `${mode==='custom' ? '✅ ' : ''}Custom`, callback_data: 'adm_wg_mode:custom' },
          ],
          [{ text: `🔑 Custom PublicKey: ${formatWgDefaultValue('peer_public_key', d.peer_public_key)}`, callback_data: 'adm_wg_edit:peer_public_key' }],
          [{ text: '↩️ بازنشانی به پیش‌فرض‌ها', callback_data: 'adm_wg_reset' }],
          [{ text: '🔙 بازگشت', callback_data: 'adm_wg_vars' }],
          [{ text: '🏠 منوی اصلی ربات', callback_data: 'back_main' }],
        ];
        await tgEditMessage(env, chat_id, mid, '⚙️ پیشفرض‌های WireGuard — برای ویرایش یکی را انتخاب کنید:', kb(rows));
        await tgAnswerCallbackQuery(env, cb.id, '✅ حالت PublicKey ذخیره شد');
        return;
      }
      if (data === 'adm_wg_reset') {
        const s = await getSettings(env);
        s.wg_defaults = {
          address: '10.66.66.2/32',
          dns: '10.202.10.10, 10.202.10.11',
          mtu: 1360,
          peer_public_mode: 'cloudflare',
          peer_public_key: '',
          listen_port: '',
          allowed_ips: '0.0.0.0/0',
          persistent_keepalive: undefined,
        };
        await setSettings(env, s);
        
        // Re-fetch to ensure consistency
        const fresh = await getSettings(env);
        const d = fresh.wg_defaults || {};
        const mode = String((d.peer_public_mode || 'cloudflare')).toLowerCase();
        
        const rows = [
          [{ text: `📍 Address: ${formatWgDefaultValue('address', d.address)}`, callback_data: 'adm_wg_edit:address' }],
          [{ text: `🌐 DNS: ${formatWgDefaultValue('dns', d.dns)}`, callback_data: 'adm_wg_edit:dns' }],
          [{ text: `📏 MTU: ${formatWgDefaultValue('mtu', d.mtu)}`, callback_data: 'adm_wg_edit:mtu' }],
          [{ text: `🔌 ListenPort: ${formatWgDefaultValue('listen_port', d.listen_port)}`, callback_data: 'adm_wg_edit:listen_port' }],
          [{ text: `🛡 AllowedIPs: ${formatWgDefaultValue('allowed_ips', d.allowed_ips)}`, callback_data: 'adm_wg_edit:allowed_ips' }],
          [{ text: `⏰ PersistentKeepalive: ${formatWgDefaultValue('persistent_keepalive', d.persistent_keepalive)}`, callback_data: 'adm_wg_edit:persistent_keepalive' }],
          [
            { text: `${mode==='cloudflare' ? '✅ ' : ''}Cloudflare`, callback_data: 'adm_wg_mode:cloudflare' },
            { text: `${mode==='endpoint' ? '✅ ' : ''}Auto Key`, callback_data: 'adm_wg_mode:endpoint' },
            { text: `${mode==='custom' ? '✅ ' : ''}Custom`, callback_data: 'adm_wg_mode:custom' },
          ],
          [{ text: `🔑 Custom PublicKey: ${formatWgDefaultValue('peer_public_key', d.peer_public_key)}`, callback_data: 'adm_wg_edit:peer_public_key' }],
          [{ text: '↩️ بازنشانی به پیش‌فرض‌ها', callback_data: 'adm_wg_reset' }],
          [{ text: '🔙 بازگشت', callback_data: 'adm_wg_vars' }],
          [{ text: '🏠 منوی اصلی ربات', callback_data: 'back_main' }],
        ];
        
        await tgEditMessage(env, chat_id, mid, '✅ تنظیمات WireGuard به پیش‌فرض‌ها بازنشانی شد!\n\n⚙️ پیشفرض‌های WireGuard — برای ویرایش یکی را انتخاب کنید:', kb(rows));
        await tgAnswerCallbackQuery(env, cb.id, '✅ بازنشانی کامل شد');
        return;
      }
      if (data.startsWith('adm_wg_edit:')) {
        const field = data.split(':')[1];
        await setUserState(env, uid, { step: 'adm_wg_edit', field });
        let prompt = 'مقدار جدید را ارسال کنید:';
        if (field === 'address') prompt = 'آدرس اینترفیس را با CIDR ارسال کنید — مثال: 10.66.66.2/32';
        if (field === 'dns') prompt = 'DNSها را با کاما جدا کنید — مثال: 10.202.10.10, 10.202.10.11';
        if (field === 'mtu') prompt = 'مقدار MTU را ارسال کنید (عدد) — مثال: 1360';
        if (field === 'listen_port') prompt = 'ListenPort را ارسال کنید. برای حالت خودکار، پیام خالی یا 0 بفرستید.';
        if (field === 'allowed_ips') prompt = 'AllowedIPs را ارسال کنید — مثال: 0.0.0.0/0, ::/0';
        if (field === 'persistent_keepalive') prompt = 'PersistentKeepalive را بر حسب ثانیه ارسال کنید. برای خاموش کردن 0 یا پیام خالی بفرستید.';
        if (field === 'peer_public_mode') prompt = 'حالت PublicKey را مشخص کنید: cloudflare | endpoint | custom';
        if (field === 'peer_public_key') prompt = 'کلید عمومی سرور را (Base64) ارسال کنید. فقط در حالت custom استفاده می‌شود.';
        await tgAnswerCallbackQuery(env, cb.id);
        await tgSendMessage(env, chat_id, prompt);
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }
      if (data === 'adm_wg_eps') {
        const s = await getSettings(env);
        const list = Array.isArray(s?.wg_endpoints) ? s.wg_endpoints : [];
        const rows = [];
        for (let i = 0; i < list.length; i++) {
          const e = list[i];
          rows.push([{ text: `${i + 1}) ${e.flag || '🌐'} ${e.country || ''} — ${e.hostport}`, callback_data: `adm_wg_ep_del:${i}` }]);
        }
        rows.push([{ text: '➕ افزودن Endpoint', callback_data: 'adm_wg_ep_add' }]);
        if (list.length) rows.push([{ text: '🧹 پاکسازی همه', callback_data: 'adm_wg_ep_clear' }]);
        rows.push([{ text: '🔙 بازگشت', callback_data: 'adm_wg_vars' }]);
        rows.push([{ text: '🏠 منوی اصلی ربات', callback_data: 'back_main' }]);
        await tgEditMessage(env, chat_id, mid, 'مدیریت Endpoint های WireGuard:', kb(rows));
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }
      if (data === 'adm_wg_ep_add') {
        await setUserState(env, uid, { step: 'adm_wg_ep_lines' });
        await tgSendMessage(env, chat_id, 'لیست Endpoint ها را ارسال کنید (هر خط به صورت IP:PORT). سپس کشور و پرچم پرسیده می‌شود.');
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }
      if (data === 'adm_wg_ep_clear') {
        const s = await getSettings(env);
        s.wg_endpoints = [];
        await setSettings(env, s);
        await tgAnswerCallbackQuery(env, cb.id, 'پاک شد');
        // refresh
        const list = [];
        const rows = [
          [{ text: '➕ افزودن Endpoint', callback_data: 'adm_wg_ep_add' }]
        ];
        if (list.length) rows.push([{ text: '🧹 پاکسازی همه', callback_data: 'adm_wg_ep_clear' }]);
        rows.push([{ text: '🔙 بازگشت', callback_data: 'adm_wg_vars' }]);
        rows.push([{ text: '🏠 منوی اصلی ربات', callback_data: 'back_main' }]);
        await tgEditMessage(env, chat_id, mid, 'مدیریت Endpoint های WireGuard:', kb(rows));
        return;
      }
      if (data === 'adm_dns_add') {
        const rows = [
          [ { text: 'IPv4', callback_data: 'adm_dns_add_v4' }, { text: 'IPv6', callback_data: 'adm_dns_add_v6' } ],
          [ { text: '🔙 بازگشت', callback_data: 'adm_service' } ],
          [ { text: '🏠 منوی اصلی ربات', callback_data: 'back_main' } ],
        ];
        await tgEditMessage(env, chat_id, mid, '➕ افزودن آدرس DNS\nنوع را انتخاب کنید:', kb(rows));
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }
      if (data === 'adm_dns_remove') {
        const rows = [
          [ { text: 'IPv4', callback_data: 'adm_dns_remove_v4' }, { text: 'IPv6', callback_data: 'adm_dns_remove_v6' } ],
          [ { text: '🧹 حذف تمام DNS‌ها', callback_data: 'adm_dns_remove_all' } ],
          [ { text: '🔙 بازگشت', callback_data: 'adm_service' } ],
          [ { text: '🏠 منوی اصلی ربات', callback_data: 'back_main' } ],
        ];
        await tgEditMessage(env, chat_id, mid, '🗑 حذف آدرس‌های DNS\nنوع را انتخاب کنید:', kb(rows));
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }
      if (data === 'adm_dns_remove_all') {
        const rows = [
          [ { text: '✅ بله، ادامه', callback_data: 'adm_dns_remove_all_c1' } ],
          [ { text: '❌ انصراف', callback_data: 'adm_dns_remove' } ],
        ];
        await tgEditMessage(env, chat_id, mid, '⚠️ آیا از حذف همه DNS ها مطمئن هستید؟', kb(rows));
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }
      if (data === 'adm_dns_remove_all_c1') {
        const rows = [
          [ { text: '🛑 بله، می‌دانم غیرقابل بازگشت است', callback_data: 'adm_dns_remove_all_c2' } ],
          [ { text: '❌ انصراف', callback_data: 'adm_dns_remove' } ],
        ];
        await tgEditMessage(env, chat_id, mid, '❗️ این عملیات غیرقابل بازگشت است و همه آدرس‌های DNS (IPv4 و IPv6) حذف خواهند شد.', kb(rows));
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }
      if (data === 'adm_dns_remove_all_c2') {
        // Acknowledge first to avoid spinner during mass deletion
        await tgAnswerCallbackQuery(env, cb.id, 'در حال حذف...');
        const removed = await deleteAllDns(env);
        const rows = [
          [ { text: '🔙 بازگشت', callback_data: 'adm_dns_remove' } ],
          [ { text: '🏠 منوی اصلی ربات', callback_data: 'back_main' } ],
        ];
        await tgEditMessage(env, chat_id, mid, `✅ عملیات انجام شد.\nتعداد حذف شده: <b>${fmtNum(removed)}</b>`, kb(rows));
        return;
      }
      if (data === 'adm_dns_remove_v4' || data === 'adm_dns_remove_v6') {
        const version = data.endsWith('_v4') ? 'v4' : 'v6';
        const map = await groupDnsAvailabilityByCountry(env, version);
        const countries = Object.keys(map);
        if (!countries.length) {
          await tgAnswerCallbackQuery(env, cb.id, 'لیستی وجود ندارد');
          await tgEditMessage(env, chat_id, mid, 'هیچ آدرس DNS برای حذف وجود ندارد.', kb([[{ text: '🔙 بازگشت', callback_data: 'adm_dns_remove' }]]));
          return;
        }
        const rows = [];
        for (let i = 0; i < countries.length; i += 2) {
          const c1 = countries[i];
          const c2 = countries[i + 1];
          const f1 = (map[c1]?.flag) || '🌐';
          const n1 = map[c1]?.count || 0;
          const row = [ { text: `${f1} ${c1} — ${fmtNum(n1)}`, callback_data: `adm_dns_remove_country:${version}:${c1}` } ];
          if (c2) {
            const f2 = (map[c2]?.flag) || '🌐';
            const n2 = map[c2]?.count || 0;
            row.push({ text: `${f2} ${c2} — ${fmtNum(n2)}`, callback_data: `adm_dns_remove_country:${version}:${c2}` });
          }
          rows.push(row);
        }
        rows.push([{ text: '🔙 بازگشت', callback_data: 'adm_dns_remove' }]);
        await tgEditMessage(env, chat_id, mid, `نسخه ${version.toUpperCase()} — کشور را برای حذف انتخاب کنید:`, kb(rows));
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }
      if (data.startsWith('adm_dns_remove_country:')) {
        const parts = data.split(':');
        const version = parts[1] === 'v6' ? 'v6' : 'v4';
        const country = parts.slice(2).join(':');
        const page = 1;
        // Acknowledge first to avoid Telegram timeout spinner during KV scan
        await tgAnswerCallbackQuery(env, cb.id, 'در حال بارگذاری...');
        await tgEditMessage(env, chat_id, mid, `حذف تکی آدرس‌های DNS (${version.toUpperCase()}) — ${country}\nروی هر آی‌پی برای حذف بزنید:`, await buildDnsDeleteListKb(env, version, country, page));
        return;
      }
      if (data.startsWith('adm_dns_list:')) {
        const m = data.split(':');
        const version = m[1] === 'v6' ? 'v6' : 'v4';
        const page = Number(m[2] || '1') || 1;
        const country = m.slice(3).join(':');
        // Acknowledge first to avoid Telegram timeout spinner during KV scan
        await tgAnswerCallbackQuery(env, cb.id, 'در حال بارگذاری...');
        await tgEditMessage(env, chat_id, mid, `حذف تکی آدرس‌های DNS (${version.toUpperCase()}) — ${country}\nروی هر آی‌پی برای حذف بزنید:`, await buildDnsDeleteListKb(env, version, country, page));
        return;
      }
      if (data.startsWith('adm_dns_del_ip:')) {
        const m = data.split(':');
        const version = m[1] === 'v6' ? 'v6' : 'v4';
        const ip = m[2];
        const country = m.slice(3).join(':');
        const key = dnsPrefix(version) + ip;
        const v = await kvGet(env, key);
        if (v && !v.assigned_to) { await kvDel(env, key); await tgAnswerCallbackQuery(env, cb.id, 'حذف شد'); }
        else { await tgAnswerCallbackQuery(env, cb.id, 'ناممکن'); }
        await tgEditMessage(env, chat_id, mid, `حذف تکی آدرس‌های DNS (${version.toUpperCase()}) — ${country}\nروی هر آی‌پی برای حذف بزنید:`, await buildDnsDeleteListKb(env, version, country, 1));
        return;
      }
      if (data === 'adm_dns_add_v4' || data === 'adm_dns_add_v6') {
        const version = data.endsWith('_v4') ? 'v4' : 'v6';
        await setUserState(env, uid, { step: 'adm_dns_add_addresses', version });
        await tgSendMessage(env, chat_id, 'لطفاً آدرس‌ها را به صورت خط‌به‌خط ارسال کنید (مثال: 1.1.1.1 در هر خط). پس از ارسال، کشور پرسیده می‌شود.');
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }
      if (data === 'adm_backup') {
        await tgAnswerCallbackQuery(env, cb.id, '✨ در حال تهیه بکاپ زیبا...');
        const pretty = await buildPrettyBackup(env);
        const json = JSON.stringify(pretty, null, 2);
        
        // Calculate backup size
        const backupSizeKB = Math.round((new Blob([json]).size) / 1024);
        if (pretty["🔧 Metadata"] && pretty["🔧 Metadata"]["📊 Summary"]) {
          pretty["🔧 Metadata"]["📊 Summary"]["💾 Backup Size"] = `${backupSizeKB} KB`;
        }
        
        // Re-stringify with updated size
        const finalJson = JSON.stringify(pretty, null, 2);
        
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `🗄️ Database-Backup-${ts}.json`;
        const blob = new Blob([finalJson], { type: 'application/json' });
        
        const caption = `✨ بکاپ زیبای دیتابیس آماده شد!\n\n` +
          `📁 نام فایل: <code>${filename}</code>\n` +
          `📊 حجم: ${backupSizeKB} کیلوبایت\n` +
          `🕐 زمان تولید: ${new Date().toLocaleString('fa-IR')}\n` +
          `🎨 فرمت: JSON زیبا و خوانا`;
        
        await tgSendDocument(env, chat_id, { blob, filename }, { caption });
        return;
      }
      if (data === 'adm_ovpn_upload') {
        await tgEditMessage(env, chat_id, mid, 'آپلود اوپن وی پی ان\nابتدا پروتکل را انتخاب کنید:', ovpnProtocolKb('adm_'));
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }

      // Admin: OpenVPN delete flow — list all entries
      if (data === 'adm_ovpn_delete') {
        await tgAnswerCallbackQuery(env, cb.id, 'در حال بارگذاری...');
        await tgEditMessage(env, chat_id, mid, 'حذف کانفیگ‌های OpenVPN — یکی را انتخاب کنید:', await buildOvpnDeleteListKb(env));
        return;
      }
      // Admin: OpenVPN delete flow — ask confirm for a specific item
      if (data.startsWith('adm_ovpn_del_item:')) {
        const parts = data.split(':');
        const proto = (parts[1] || '').toUpperCase();
        const loc = parts.slice(2).join(':');
        if (!['TCP','UDP'].includes(proto) || !loc) { await tgAnswerCallbackQuery(env, cb.id, 'نامعتبر'); return; }
        const key = CONFIG.OVPN_PREFIX + `${proto}:${loc}`;
        const meta = await kvGet(env, key);
        if (!meta || !meta.file_id) { await tgAnswerCallbackQuery(env, cb.id, 'یافت نشد'); return; }
        const rows = [
          [ { text: '✅ تایید حذف', callback_data: `adm_ovpn_del_confirm:${proto}:${loc}` } ],
          [ { text: '🔙 بازگشت', callback_data: 'adm_ovpn_delete' } ],
        ];
        await tgEditMessage(env, chat_id, mid, `❗️ حذف کانفیگ ${loc} (${proto}) — آیا مطمئن هستید؟`, kb(rows));
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }
      // Admin: OpenVPN delete flow — perform deletion
      if (data.startsWith('adm_ovpn_del_confirm:')) {
        const parts = data.split(':');
        const proto = (parts[1] || '').toUpperCase();
        const loc = parts.slice(2).join(':');
        if (!['TCP','UDP'].includes(proto) || !loc) { await tgAnswerCallbackQuery(env, cb.id, 'نامعتبر'); return; }
        const key = CONFIG.OVPN_PREFIX + `${proto}:${loc}`;
        await kvDel(env, key);
        await tgAnswerCallbackQuery(env, cb.id, 'حذف شد');
        await tgEditMessage(env, chat_id, mid, `🗑 کانفیگ ${loc} (${proto}) حذف شد.`, await buildOvpnDeleteListKb(env));
        return;
      }
      if (data.startsWith('adm_ovpn_proto:')) {
        const proto = (data.split(':')[1] || '').toUpperCase();
        if (!['TCP','UDP'].includes(proto)) { await tgAnswerCallbackQuery(env, cb.id, 'پروتکل نامعتبر'); return; }
        await tgEditMessage(env, chat_id, mid, `پروتکل: ${proto}\nلطفاً لوکیشن را انتخاب کنید:`, ovpnLocationsKb(proto, 'adm_'));
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }
      if (data.startsWith('adm_ovpn_loc:')) {
        const parts = data.split(':');
        const proto = (parts[1] || '').toUpperCase();
        const loc = parts.slice(2).join(':');
        if (!['TCP','UDP'].includes(proto) || !loc) { await tgAnswerCallbackQuery(env, cb.id, 'نامعتبر'); return; }
        await setUserState(env, uid, { step: 'adm_ovpn_wait_file', proto, loc });
        await tgEditMessage(env, chat_id, mid, `ارسال فایل .ovpn برای ${loc} (${proto})\nلطفاً فایل را به صورت سند (Document) ارسال کنید.`, kb([[{ text: '🔙 بازگشت', callback_data: 'adm_service' }]]));
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }
      if (data === 'adm_buttons') {
        const s = await getSettings(env);
        const disabled = Array.isArray(s.disabled_buttons) ? s.disabled_buttons : [];
        const known = getKnownUserButtons();
        const rows = known.map(b => {
          const isDis = disabled.includes(b.data);
          const label = (isDis ? '🚫 ' : '🟢 ') + b.label;
          return [{ text: label, callback_data: 'adm_btn_toggle:'+b.data }];
        });
        rows.push([{ text: '🧹 پاکسازی', callback_data: 'adm_buttons_clear' }]);
        rows.push([{ text: '🔙 بازگشت', callback_data: 'adm_service' }]);
        const txt = 'مدیریت دکمه‌های غیرفعال\nیکی را برای تغییر وضعیت انتخاب کنید:';
        await tgEditMessage(env, chat_id, mid, txt, kb(rows));
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }
      if (data.startsWith('adm_btn_toggle:')) {
        const key = data.substring('adm_btn_toggle:'.length);
        const s = await getSettings(env);
        s.disabled_buttons = Array.isArray(s.disabled_buttons) ? s.disabled_buttons : [];
        const idx = s.disabled_buttons.indexOf(key);
        if (idx === -1) s.disabled_buttons.push(key); else s.disabled_buttons.splice(idx, 1);
        await setSettings(env, s);
        // Refresh view
        const disabled = s.disabled_buttons;
        const known = getKnownUserButtons();
        const rows = known.map(b => {
          const isDis = disabled.includes(b.data);
          const label = (isDis ? '🚫 ' : '🟢 ') + b.label;
          return [{ text: label, callback_data: 'adm_btn_toggle:'+b.data }];
        });
        rows.push([{ text: '🧹 پاکسازی', callback_data: 'adm_buttons_clear' }]);
        rows.push([{ text: '🔙 بازگشت', callback_data: 'adm_service' }]);
        await tgEditMessage(env, chat_id, mid, 'مدیریت دکمه‌های غیرفعال\nیکی را برای تغییر وضعیت انتخاب کنید:', kb(rows));
        await tgAnswerCallbackQuery(env, cb.id, 'بروزرسانی شد');
        return;
      }
      if (data === 'adm_buttons_clear') {
        const s = await getSettings(env);
        s.disabled_buttons = [];
        await setSettings(env, s);
        // Refresh inline list
        const known = getKnownUserButtons();
        const rows = known.map(b => ([{ text: '🟢 ' + b.label, callback_data: 'adm_btn_toggle:'+b.data }]));
        rows.push([{ text: '🧹 پاکسازی', callback_data: 'adm_buttons_clear' }]);
        rows.push([{ text: '🔙 بازگشت', callback_data: 'adm_service' }]);
        await tgEditMessage(env, chat_id, mid, 'مدیریت دکمه‌های غیرفعال\nیکی را برای تغییر وضعیت انتخاب کنید:', kb(rows));
        await tgAnswerCallbackQuery(env, cb.id, 'خالی شد');
        return;
      }
      if (data === 'adm_add') {
        await setUserState(env, uid, { step: 'adm_add_uid' });
        await tgAnswerCallbackQuery(env, cb.id);
        await tgSendMessage(env, chat_id, 'آیدی عددی کاربر را ارسال کنید:');
        return;
      }
      if (data === 'adm_sub') {
        await setUserState(env, uid, { step: 'adm_sub_uid' });
        await tgAnswerCallbackQuery(env, cb.id);
        await tgSendMessage(env, chat_id, 'آیدی عددی کاربر را ارسال کنید:');
        return;
      }
      if (data.startsWith('buy_approve:')) {
        const pid = data.split(':')[1];
        const key = CONFIG.PURCHASE_PREFIX + pid;
        const p = await kvGet(env, key);
        if (!p || p.status !== 'pending') { await tgAnswerCallbackQuery(env, cb.id, 'نامعتبر'); return; }
        const ok = await creditBalance(env, String(p.user_id), Number(p.coins || 0));
        if (ok) {
          p.status = 'approved'; p.decided_at = nowTs(); await kvSet(env, key, p);
          // Update admin messages: caption and keyboard
          const msgs = Array.isArray(p.admin_msgs) ? p.admin_msgs : [];
          for (const m of msgs) {
            try {
              await tgEditMessageCaption(env, m.chat_id, m.message_id, buildPurchaseCaption(p), {});
              await tgEditReplyMarkup(env, m.chat_id, m.message_id, kb([[{ text: ' تایید شد', callback_data: 'noop' }]]).reply_markup);
            } catch {}
          }
          try { await tgSendMessage(env, String(p.user_id), `${fmtNum(p.coins)} ${CONFIG.DEFAULT_CURRENCY} به حساب شما افزوده شد. سپاس از پرداخت شما ❤️`); } catch {}
          await tgAnswerCallbackQuery(env, cb.id, 'واریز شد');
        } else {
          await tgAnswerCallbackQuery(env, cb.id, 'خطا در واریز');
        }
        return;
      }
      if (data === 'adm_broadcast') {
        await setUserState(env, uid, { step: 'adm_broadcast_wait' });
        await tgEditMessage(env, chat_id, mid, '✍️ متن پیام همگانی را ارسال کنید. /update برای لغو', {});
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }
      if (data.startsWith('buy_reject:')) {
        const pid = data.split(':')[1];
        const key = CONFIG.PURCHASE_PREFIX + pid;
        const p = await kvGet(env, key);
        if (!p || p.status !== 'pending') { await tgAnswerCallbackQuery(env, cb.id, 'نامعتبر'); return; }
        await setUserState(env, uid, { step: 'buy_reject_reason', purchase_id: pid, target_uid: String(p.user_id) });
        await tgAnswerCallbackQuery(env, cb.id);
        await tgSendMessage(env, chat_id, 'لطفاً دلیل رد خرید را ارسال کنید:');
        return;
      }
      if (data === 'adm_upload') {
        await setUserState(env, uid, { step: 'adm_upload_wait_file' });
        await tgEditMessage(env, chat_id, mid, ' هر نوع محتوا را ارسال کنید: سند/عکس/ویدیو/صوت یا حتی متن/لینک. سپس قیمت و محدودیت را تنظیم می‌کنیم.', {});
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }
      if (data === 'adm_update_toggle') {
        const settings = await getSettings(env);
        settings.update_mode = settings.update_mode ? false : true;
        await setSettings(env, settings);
        await tgAnswerCallbackQuery(env, cb.id, settings.update_mode ? 'حالت بروزرسانی فعال شد' : 'حالت بروزرسانی غیرفعال شد');
        await tgEditMessage(env, chat_id, mid, 'پنل مدیریت:', adminMenuKb(settings));
        return;
      }
      if (data === 'adm_stats') {
        const stats = await getStats(env);
        const users = fmtNum(stats.users || 0);
        const files = fmtNum(stats.files || 0);
        const updates = fmtNum(stats.updates || 0);
        const ovpnPurch = fmtNum(stats.ovpn_purchases || 0);
        const ovpnRev = fmtNum(stats.ovpn_revenue_coins || 0);
        const ovpnTCP = fmtNum(stats.ovpn_TCP || 0);
        const ovpnUDP = fmtNum(stats.ovpn_UDP || 0);
        const txt = [
          ' آمار ربات',
          `کاربران: ${users}`,
          `فایل‌ها: ${files}`,
          `به‌روزرسانی‌ها: ${updates}`,
          '',
          '— اوپن وی‌پی‌ان —',
          `تعداد دریافت کانفیگ: ${ovpnPurch}`,
          `درآمد (سکه): ${ovpnRev}`,
          `TCP: ${ovpnTCP} | UDP: ${ovpnUDP}`,
        ].join('\n');
        await tgAnswerCallbackQuery(env, cb.id);
        await tgEditMessage(env, chat_id, mid, txt, adminMenuKb(await getSettings(env)));
        return;
      }
      if (data === 'adm_tickets') {
        const items = await listTickets(env, 10);
        const rows = items.map(t => ([{ text: `${t.closed?'🔒':'📨'} ${t.type||'general'} — ${t.id}`, callback_data: 'ticket_view:'+t.id }]));
        rows.push([{ text: '🔙 بازگشت', callback_data: 'admin' }]);
        await tgEditMessage(env, chat_id, mid, `🎟 تیکت‌های اخیر (${items.length})`, kb(rows));
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }
      if (data.startsWith('ticket_view:')) {
        const id = data.split(':')[1];
        const t = await getTicket(env, id);
        if (!t) { await tgAnswerCallbackQuery(env, cb.id, 'یافت نشد'); return; }
        const txt = [
          `🎟 تیکت #${t.id}`,
          `کاربر: <code>${t.user_id}</code>`,
          `نوع: ${t.type||'general'}`,
          `وضعیت: ${t.closed ? 'بسته' : (t.status||'open')}`,
          '',
          `متن: ${htmlEscape(t.content||'-')}`,
        ].join('\n');
        const rows = [
          [{ text: '✍️ پاسخ', callback_data: 'ticket_reply:'+t.id }, { text: t.closed ? '🔓 بازگشایی' : '🔒 بستن', callback_data: (t.closed?'ticket_reopen:':'ticket_close:')+t.id }],
          [{ text: '🗑 حذف', callback_data: 'ticket_del:'+t.id }],
          [{ text: '🔙 بازگشت', callback_data: 'adm_tickets' }]
        ];
        await tgEditMessage(env, chat_id, mid, txt, kb(rows));
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }
      if (data.startsWith('ticket_reply:')) {
        const id = data.split(':')[1];
        const t = await getTicket(env, id);
        if (!t) { await tgAnswerCallbackQuery(env, cb.id, 'یافت نشد'); return; }
        await setUserState(env, uid, { step: 'adm_ticket_reply', ticket_id: id, target_uid: String(t.user_id) });
        await tgSendMessage(env, chat_id, 'لطفاً پاسخ خود را ارسال کنید.');
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }
      if (data.startsWith('ticket_close:')) {
        const id = data.split(':')[1];
        const t = await getTicket(env, id);
        if (!t) { await tgAnswerCallbackQuery(env, cb.id, 'یافت نشد'); return; }
        t.closed = true; t.status = 'closed';
        await saveTicket(env, t);
        await tgAnswerCallbackQuery(env, cb.id, 'بسته شد');
        // Refresh view
        const txt = [
          `🎟 تیکت #${t.id}`,
          `کاربر: <code>${t.user_id}</code>`,
          `نوع: ${t.type||'general'}`,
          `وضعیت: ${t.closed ? 'بسته' : (t.status||'open')}`,
          '',
          `متن: ${htmlEscape(t.content||'-')}`,
        ].join('\n');
        const rows = [
          [{ text: '✍️ پاسخ', callback_data: 'ticket_reply:'+t.id }, { text: t.closed ? '🔓 بازگشایی' : '🔒 بستن', callback_data: (t.closed?'ticket_reopen:':'ticket_close:')+t.id }],
          [{ text: '🗑 حذف', callback_data: 'ticket_del:'+t.id }],
          [{ text: '🔙 بازگشت', callback_data: 'adm_tickets' }]
        ];
        await tgEditMessage(env, chat_id, mid, txt, kb(rows));
        return;
      }
      if (data.startsWith('ticket_reopen:')) {
        const id = data.split(':')[1];
        const t = await getTicket(env, id);
        if (!t) { await tgAnswerCallbackQuery(env, cb.id, 'یافت نشد'); return; }
        t.closed = false; t.status = 'open';
        await saveTicket(env, t);
        await tgAnswerCallbackQuery(env, cb.id, 'باز شد');
        const txt = [
          `🎟 تیکت #${t.id}`,
          `کاربر: <code>${t.user_id}</code>`,
          `نوع: ${t.type||'general'}`,
          `وضعیت: ${t.closed ? 'بسته' : (t.status||'open')}`,
          '',
          `متن: ${htmlEscape(t.content||'-')}`,
        ].join('\n');
        const rows = [
          [{ text: '✍️ پاسخ', callback_data: 'ticket_reply:'+t.id }, { text: t.closed ? '🔓 بازگشایی' : '🔒 بستن', callback_data: (t.closed?'ticket_reopen:':'ticket_close:')+t.id }],
          [{ text: '🔙 بازگشت', callback_data: 'adm_tickets' }]
        ];
        await tgEditMessage(env, chat_id, mid, txt, kb(rows));
        return;
      }
      if (data === 'adm_gifts') {
        const items = await listGiftCodes(env, 10);
        const rows = items.map(g => {
          const used = Array.isArray(g.used_by) ? g.used_by.length : 0;
          const max = g.max_uses || 0;
          return [{ text: `${g.used_by?'✅':''} 🎁 ${g.code} — ${fmtNum(g.amount)} — ${used}/${max||'∞'}`, callback_data: 'gift_view:'+g.code }];
        });
        rows.push([{ text: '➕ ایجاد کد جدید', callback_data: 'gift_new' }]);
        rows.push([{ text: '🔙 بازگشت', callback_data: 'admin' }]);
        await tgEditMessage(env, chat_id, mid, `🎁 کدهای هدیه اخیر (${items.length})`, kb(rows));
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }
      if (data === 'gift_new') {
        await setUserState(env, uid, { step: 'adm_gift_create_amount' });
        await tgEditMessage(env, chat_id, mid, 'مبلغ سکه برای هر بار استفاده را ارسال کنید (فقط رقم). سپس از شما تعداد دفعات استفاده پرسیده می‌شود.', {});
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }
      if (data.startsWith('gift_view:')) {
        const code = data.split(':')[1];
        const g = await kvGet(env, CONFIG.GIFT_PREFIX + code);
        if (!g) { await tgAnswerCallbackQuery(env, cb.id, 'یافت نشد'); return; }
        const txt = [
          `کد: <code>${g.code}</code>`,
          `مبلغ: ${fmtNum(g.amount)} ${CONFIG.DEFAULT_CURRENCY}`,
          `مصرف: ${(Array.isArray(g.used_by)?g.used_by.length:0)}/${g.max_uses || '∞'}`,
        ].filter(Boolean).join('\n');
        const rows = [
          [{ text: '🗑 حذف', callback_data: 'gift_del:'+g.code }],
          [{ text: '🔙 بازگشت', callback_data: 'adm_gifts' }]
        ];
        await tgEditMessage(env, chat_id, mid, txt, kb(rows));
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }
      if (data.startsWith('gift_del:')) {
        const code = data.split(':')[1];
        const g = await kvGet(env, CONFIG.GIFT_PREFIX + code);
        if (!g) { await tgAnswerCallbackQuery(env, cb.id, 'یافت نشد'); return; }
        const kbDel = kb([[{ text: '✅ تایید حذف', callback_data: 'gift_del_confirm:'+code }],[{ text: '🔙 انصراف', callback_data: 'gift_view:'+code }]]);
        await tgEditMessage(env, chat_id, mid, `❗️ حذف کد هدیه <code>${code}</code>?`, kbDel);
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }
      if (data.startsWith('gift_del_confirm:')) {
        const code = data.split(':')[1];
        await kvDel(env, CONFIG.GIFT_PREFIX + code);
        await tgEditMessage(env, chat_id, mid, `🗑 کد هدیه <code>${code}</code> حذف شد.`, kb([[{ text: '🔙 بازگشت', callback_data: 'adm_gifts' }]]));
        await tgAnswerCallbackQuery(env, cb.id, 'حذف شد');
        return;
      }
      if (data === 'adm_join') {
        const s = await getSettings(env);
        await clearUserState(env, uid);
        await tgEditMessage(env, chat_id, mid, admJoinManageText(s), admJoinManageKb(s));
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }
      if (data === 'adm_join_add') {
        await setUserState(env, uid, { step: 'adm_join_wait' });
        await tgAnswerCallbackQuery(env, cb.id, 'یک کانال ارسال کنید');
        await tgSendMessage(env, chat_id, '➕ لطفاً کانال را ارسال کنید (نمونه: @channel یا -100... یا لینک کامل). /update برای لغو');
        return;
      }
      if (data.startsWith('adm_join_del:')) {
        const idx = parseInt(data.split(':')[1]||'-1', 10);
        const s = await getSettings(env);
        const arr = Array.isArray(s.join_channels) ? s.join_channels : [];
        if (idx >= 0 && idx < arr.length) {
          const removed = arr.splice(idx, 1);
          s.join_channels = arr;
          await setSettings(env, s);
          await tgAnswerCallbackQuery(env, cb.id, 'حذف شد');
        } else {
          await tgAnswerCallbackQuery(env, cb.id, 'ردیف نامعتبر');
        }
        await tgEditMessage(env, chat_id, mid, admJoinManageText(s), admJoinManageKb(s));
        return;
      }
      if (data.startsWith('adm_join_edit:')) {
        const idx = parseInt(data.split(':')[1]||'-1', 10);
        const s = await getSettings(env);
        const arr = Array.isArray(s.join_channels) ? s.join_channels : [];
        if (!(idx >= 0 && idx < arr.length)) { await tgAnswerCallbackQuery(env, cb.id, 'ردیف نامعتبر'); return; }
        await setUserState(env, uid, { step: 'adm_join_edit_wait', index: idx });
        await tgAnswerCallbackQuery(env, cb.id, 'ویرایش');
        await tgSendMessage(env, chat_id, `✏️ مقدار جدید برای ردیف ${idx+1} را ارسال کنید (نمونه: @channel یا لینک کامل). /update برای لغو`);
        return;
      }
      if (data === 'adm_join_clear') {
        const s = await getSettings(env);
        s.join_channels = [];
        await setSettings(env, s);
        await tgAnswerCallbackQuery(env, cb.id, 'پاک شد');
        await tgEditMessage(env, chat_id, mid, admJoinManageText(s), admJoinManageKb(s));
        return;
      }
      if (data === 'adm_files') {
        const files = await listFiles(env, 10);
        let txt = ' ۱۰ فایل اخیر:\n\n';
        for (const f of files) {
          txt += `• ${htmlEscape(f.file_name)} (${fmtNum(f.file_size)} بایت) — ${f.disabled ? 'غیرفعال' : 'فعال'}\n`;
        }
        await tgAnswerCallbackQuery(env, cb.id);
        await tgEditMessage(env, chat_id, mid, txt, adminMenuKb(await getSettings(env)));
        return;
      }
      if (data === 'help') {
        const lines = [
          '📚 راهنمای کامل مدیریت ربات',
          '═══════════════════════════════',
          '',
          '🔧 دستورات اصلی:',
          '• /start — شروع و نمایش منوی اصلی',
          '• /update — بروزرسانی منو و لغو عملیات جاری',
          '• /who <user_id> — مشاهده جزئیات کاربر (ادمین)',
          '',
          '👥 مدیریت کاربران:',
          '• 📊 آمار ربات — نمایش آمار کلی کاربران و فعالیت‌ها',
          '• ➕ افزودن سکه — اعطای سکه به کاربر خاص',
          '• ➖ کسر سکه — کسر سکه از کاربر مشخص',
          '• ⛔️ بلاک کاربر — مسدود کردن کاربر از استفاده',
          '• 📛 انبلاک کاربر — رفع مسدودیت کاربر',
          '',
          '🗄️ مدیریت داده‌ها:',
          '• 🧰 بکاپ دیتابیس — تهیه بکاپ زیبا و کامل از تمام داده‌ها',
          '• 📁 مدیریت فایل‌ها — کنترل فایل‌های آپلود شده',
          '• 🎫 مدیریت تیکت‌ها — پاسخ و بررسی درخواست‌های پشتیبانی',
          '',
          '⚙️ تنظیمات سیستم:',
          '• 🔧 تنظیمات سرویس — فعال/غیرفعال کردن بخش‌های مختلف',
          '• 📣 جویین اجباری — مدیریت کانال‌های الزامی عضویت',
          '• 💰 مدیریت مارکت — تنظیم محصولات قابل خرید',
          '• 🎁 مدیریت کدهای هدیه — ایجاد و کنترل کدهای تخفیف',
          '',
          '🌐 مدیریت شبکه:',
          '• 🔐 آپلود OpenVPN — مدیریت کانفیگ‌های VPN',
          '• 🌍 مدیریت DNS — افزودن/حذف سرورهای DNS',
          '• ⚡ WireGuard — تنظیمات پیشرفته WireGuard',
          '',
          '📢 ارتباطات:',
          '• 📢 پیام همگانی — ارسال پیام به همه کاربران',
          '• 💬 پشتیبانی — مدیریت پیام‌های پشتیبانی',
          '• 📊 گزارش‌گیری — آمار تفصیلی عملکرد',
          '',
          '🎨 ویژگی‌های پیشرفته:',
          '• 🧩 قیمت‌گذاری هوشمند — تنظیم قیمت خودکار',
          '• 🔄 سیستم ارجاع — مدیریت برنامه معرفی دوستان',
          '• 📈 آنالیتیکس — تحلیل رفتار کاربران',
          '• 🛡️ امنیت — کنترل دسترسی و مجوزها',
          '',
          '💡 نکات مهم:',
          '• همیشه قبل از تغییرات مهم، بکاپ تهیه کنید',
          '• از بخش آمار برای نظارت بر عملکرد استفاده کنید',
          '• پیام‌های همگانی را با احتیاط ارسال کنید',
          '• تنظیمات DNS و VPN را با دقت انجام دهید',
          '',
          '🆘 در صورت بروز مشکل:',
          '• ابتدا از بخش آمار وضعیت سیستم را بررسی کنید',
          '• از بکاپ‌های تهیه شده برای بازیابی استفاده کنید',
          '• لاگ‌های خطا را در کنسول بررسی کنید',
        ];
        const helpText = lines.join('\n');
        const helpKb = kb([
          [{ text: '📊 آمار سیستم', callback_data: 'adm_stats' }],
          [{ text: '🧰 بکاپ سریع', callback_data: 'adm_backup' }],
          [{ text: '🔙 بازگشت به منو', callback_data: 'back_main' }]
        ]);
        const edited = await tgEditMessage(env, chat_id, mid, helpText, helpKb);
        // If edit failed (e.g., message not editable), send as a new message
        if (!edited || edited.ok === false) {
          await tgSendMessage(env, chat_id, helpText, helpKb);
        }
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }
      if (data === 'adm_backup') {
        try {
          await tgAnswerCallbackQuery(env, cb.id, '✨ در حال تهیه بکاپ ...');
          
          // Use the beautiful backup function instead of raw backup
          const pretty = await buildPrettyBackup(env);
          const json = JSON.stringify(pretty, null, 2);
          
          // Calculate backup size
          const backupSizeKB = Math.round((new Blob([json]).size) / 1024);
          if (pretty["🔧 Metadata"] && pretty["🔧 Metadata"]["📊 Summary"]) {
            pretty["🔧 Metadata"]["📊 Summary"]["💾 Backup Size"] = `${backupSizeKB} KB`;
          }
          
          // Re-stringify with updated size
          const finalJson = JSON.stringify(pretty, null, 2);
          
          const ts = new Date();
          const pad = (n) => String(n).padStart(2, '0');
          const fname = `🗄️ Database-Backup-${ts.getFullYear()}${pad(ts.getMonth()+1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.json`;
          const blob = new Blob([finalJson], { type: 'application/json' });
          
          const caption = `✨ بکاپ زیبای دیتابیس آماده شد!\n\n` +
            `📁 نام فایل: <code>${fname}</code>\n` +
            `📊 حجم: ${backupSizeKB} کیلوبایت\n` +
            `🕐 زمان تولید: ${new Date().toLocaleString('fa-IR')}\n` +
            `🎨 فرمت: JSON زیبا و خوانا با ایموجی و دسته‌بندی کامل`;
          
          await tgSendDocument(env, chat_id, { blob, filename: fname }, { caption });
          await tgAnswerCallbackQuery(env, cb.id, '✅ بکاپ زیبا ارسال شد');
        } catch (e) {
          console.error('adm_backup error', e);
          await tgAnswerCallbackQuery(env, cb.id, '❌ خطا در بکاپ');
          await tgSendMessage(env, chat_id, '❌ خطا در تهیه بکاپ زیبا.');
        }
        return;
      }
    }

    // اگر کاربر ادمین نیست ولی تلاش برای ورود به پنل داشت
    if (data === 'admin') {
      await tgAnswerCallbackQuery(env, cb.id, 'شما دسترسی مدیریت ندارید');
      return;
    }
  } catch (e) {
    console.error('onCallback error', e);
  }
}

async function sendWelcome(chat_id, uid, env, msg) {
  try {
    // Referral handling (auto credit after checks)
    const ref = extractReferrerFromStartParam(msg);
    const hasRef = ref && ref !== uid;
    const startToken = extractFileTokenFromStartParam(msg);
    // ذخیره معرف در پروفایل کاربر تا پس از تایید عضویت هم قابل اعتباردهی باشد
    if (hasRef) {
      try {
        const u = await getUser(env, uid);
        if (u) {
          if (!u.referrer_id) u.referrer_id = String(ref);
          // mark referral pending until first successful join_check credit
          u.referral_pending = true;
          await setUser(env, uid, u);
        }
      } catch {}
      // همچنین برای اطمینان، referrer را به صورت pending در KV ذخیره کن تا در join_check نیز قابل بازیابی باشد
      try { await kvSet(env, CONFIG.REF_PENDING_PREFIX + String(uid), { referrer_id: String(ref), ts: nowTs() }); } catch {}
    }
    // Force join if needed
    const joined = await ensureJoinedChannels(env, uid, chat_id);
    if (!joined) return;
    // Update mode check (non-admins)
    const settings = await getSettings(env);
    if (settings.update_mode === true && !isAdminUser(env, uid)) {
      await tgSendMessage(env, chat_id, 'ربات در حال بروزرسانی است. لطفاً بعداً مراجعه کنید.');
      return;
    }
    if (hasRef) {
      const ok = await autoCreditReferralIfNeeded(env, String(ref), String(uid));
      if (ok) {
        try { await tgSendMessage(env, String(ref), `🎉 یک زیرمجموعه جدید ثبت شد. 1 🪙 به حساب شما افزوده شد.`); } catch {}
        try { const u = await getUser(env, uid); if (u) { u.referral_pending = false; await setUser(env, uid, u); } } catch {}
      }
    }
    // Fallback: اگر کاربر از قبل referrer_id ذخیره شده داشت ولی اکنون بدون پارامتر start وارد شد، بعد از تایید عضویت اعتباردهی را انجام بده
    else {
      try {
        const u = await getUser(env, uid);
        const savedRef = u?.referrer_id;
        const pending = u?.referral_pending;
        if (savedRef && String(savedRef) !== String(uid) && pending !== false) {
          const ok2 = await autoCreditReferralIfNeeded(env, String(savedRef), String(uid));
          if (ok2) {
            try { await tgSendMessage(env, String(savedRef), `🎉 یک زیرمجموعه جدید ثبت شد. 1 🪙 به حساب شما افزوده شد.`); } catch {}
            try { if (u) { u.referral_pending = false; await setUser(env, uid, u); } } catch {}
          }
        }
      } catch {}
    }
    // اگر /start <token> بود، ابتدا جریان دریافت با تایید کسر سکه را اجرا کن
    if (startToken) {
      await handleTokenRedeem(env, uid, chat_id, startToken);
      return;
    }
    const hdr = await mainMenuHeader(env);
    await tgSendMessage(env, chat_id, hdr, mainMenuKb(env, uid));
  } catch (e) { console.error('sendWelcome error', e); }
}
function extractReferrerFromStartParam(msg) {
  try {
    const text = msg.text || msg.caption || '';
    // /start <param>
    const parts = text.trim().split(/\s+/);
    if (parts[0] === '/start' && parts[1]) {
      const p = String(parts[1]).trim();
      // اگر پارامتر یک توکن فایل ۶ کاراکتری باشد، معرف نیست
      if (/^[A-Za-z0-9]{6}$/.test(p)) return '';

      // حالت 1: کاملاً عددی (آیدی کاربر)
      if (/^\d+$/.test(p)) return p;

      // حالت 2: فرمت‌های رایج معرفی: ref:123456، ref_123456، ref123456، r123456، u123456
      // در صورتی که ارقام انتهایی ۵ رقم یا بیشتر باشند (مطابق آیدی‌های تلگرام)
      let m = p.match(/^(?:ref[:_]?|r|u)?-?(\d{5,})$/i);
      if (m && m[1]) return m[1];

      // حالت 3: هر رشته‌ای که شامل یک دنباله عددی ۵ رقم به بالا باشد
      m = p.match(/(\d{5,})/);
      if (m && m[1]) return m[1];
    }
    return '';
  } catch { return ''; }
}

// تشخیص توکن فایل از پارامتر start (۶ کاراکتر آلفانامریک)
function extractFileTokenFromStartParam(msg) {
  try {
    const text = msg.text || msg.caption || '';
    const parts = text.trim().split(/\s+/);
    if (parts[0] === '/start' && parts[1] && /^[A-Za-z0-9]{6}$/.test(parts[1])) return parts[1];
    return '';
  } catch { return ''; }
}

// انتقال موجودی (State machine ساده)
async function handleTransferFlow(msg, env) {
  const chat_id = msg.chat?.id;
  const uid = String(msg.from?.id || '');
  const state = await getUserState(env, uid);
  if (!state) return false;

  if (state.step === 'transfer_ask_target') {
    const target = (msg.text || '').trim();
    if (!/^\d+$/.test(target)) {
      await tgSendMessage(env, chat_id, 'آیدی گیرنده نامعتبر است. دوباره ارسال کنید یا /update برای لغو');
      return true;
    }
    await setUserState(env, uid, { step: 'transfer_ask_amount', target });
    await tgSendMessage(env, chat_id, 'مبلغ مورد نظر به سکه را وارد کنید:');
    return true;
  }

  if (state.step === 'transfer_ask_amount') {
    const amount = Number((msg.text || '').replace(/[^0-9]/g, ''));
    if (!amount || amount <= 0) {
      await tgSendMessage(env, chat_id, 'مبلغ نامعتبر است. دوباره ارسال کنید یا /update برای لغو');
      return true;
    }
    const ok = await transferBalance(env, uid, state.target, amount);
    if (!ok) {
      await tgSendMessage(env, chat_id, 'انتقال انجام نشد. موجودی کافی نیست یا گیرنده نامعتبر است.');
    } else {
      await tgSendMessage(env, chat_id, `انتقال با موفقیت انجام شد ✅\n${fmtNum(amount)} ${CONFIG.DEFAULT_CURRENCY} منتقل شد.`);
    }
    await clearUserState(env, uid);
    return true;
  }

  return false;
}

// =========================================================
// 8) Storage Helpers
// =========================================================
async function ensureUser(env, uid, from) {
  const key = CONFIG.USER_PREFIX + uid;
  const u = await kvGet(env, key);
  if (u) return u;
  const user = {
    id: uid,
    name: [from?.first_name, from?.last_name].filter(Boolean).join(' ') || from?.username || 'کاربر',
    balance: 0,
    created_at: nowTs(),
  };
  await kvSet(env, key, user);
  await bumpStat(env, 'users');
  return user;
}

async function getUser(env, uid) { return (await kvGet(env, CONFIG.USER_PREFIX + uid)) || null; }
async function setUser(env, uid, u) { return kvSet(env, CONFIG.USER_PREFIX + uid, u); }

async function getUserState(env, uid) { return (await kvGet(env, CONFIG.USER_PREFIX + uid + ':state')) || null; }
async function setUserState(env, uid, state) { return kvSet(env, CONFIG.USER_PREFIX + uid + ':state', state); }
async function clearUserState(env, uid) { return kvDel(env, CONFIG.USER_PREFIX + uid + ':state'); }

// Blocklist helpers
async function blockUser(env, targetUid) { return kvSet(env, CONFIG.BLOCK_PREFIX + String(targetUid), { blocked: true, ts: nowTs() }); }
async function unblockUser(env, targetUid) { return kvDel(env, CONFIG.BLOCK_PREFIX + String(targetUid)); }
async function isUserBlocked(env, targetUid) { return !!(await kvGet(env, CONFIG.BLOCK_PREFIX + String(targetUid))); }

async function transferBalance(env, fromUid, toUid, amount) {
  try {
    const a = await getUser(env, fromUid);
    const b = await getUser(env, toUid);
    if (!a || !b) return false;
    if ((a.balance || 0) < amount) return false;
    a.balance = (a.balance || 0) - amount;
    b.balance = (b.balance || 0) + amount;
    await setUser(env, fromUid, a);
    await setUser(env, toUid, b);
    return true;
  } catch { return false; }
}

async function listUserFiles(env, uid, limit = 10) {
  try {
    const list = await env.BOT_KV.list({ prefix: CONFIG.FILE_PREFIX });
    const items = [];
    for (const k of list.keys) {
      const f = await kvGet(env, k.name);
      if (f?.owner_id === uid) items.push(f);
    }
    items.sort((a, b) => (b?.created_at || 0) - (a?.created_at || 0));
    return items.slice(0, limit);
  } catch (e) { console.error('listUserFiles error', e); return []; }
}

async function listFiles(env, limit = 10) {
  try {
    const list = await env.BOT_KV.list({ prefix: CONFIG.FILE_PREFIX, limit: 1000 });
    const items = [];
    for (const k of list.keys) {
      const f = await kvGet(env, k.name);
      if (f) items.push(f);
    }
    items.sort((a, b) => (b?.created_at || 0) - (a?.created_at || 0));
    return items.slice(0, limit);
  } catch (e) { console.error('listFiles error', e); return []; }
}

async function listFilesReceivedByUser(env, uid, limit = 10) {
  try {
    const list = await env.BOT_KV.list({ prefix: CONFIG.FILE_PREFIX, limit: 1000 });
    const items = [];
    for (const k of list.keys) {
      const f = await kvGet(env, k.name);
      if (f && Array.isArray(f.users) && f.users.includes(String(uid))) items.push(f);
    }
    items.sort((a, b) => (b?.created_at || 0) - (a?.created_at || 0));
    return items.slice(0, limit);
  } catch (e) { console.error('listFilesReceivedByUser error', e); return []; }
}

async function listPurchasesByUser(env, uid, limit = 10) {
  try {
    const list = await env.BOT_KV.list({ prefix: CONFIG.PURCHASE_PREFIX, limit: 1000 });
    const items = [];
    for (const k of list.keys) {
      const p = await kvGet(env, k.name);
      if (p && String(p.user_id) === String(uid)) items.push(p);
    }
    items.sort((a, b) => (b?.ts || 0) - (a?.ts || 0));
    return items.slice(0, limit);
  } catch (e) { console.error('listPurchasesByUser error', e); return []; }
}

async function listDownloadsByUser(env, uid, limit = 10) {
  try {
    const list = await env.BOT_KV.list({ prefix: CONFIG.DOWNLOAD_LOG_PREFIX, limit: 1000 });
    const items = [];
    for (const k of list.keys) {
      const v = await kvGet(env, k.name);
      if (v && String(v.uid) === String(uid)) items.push(v);
    }
    items.sort((a, b) => (b?.ts || 0) - (a?.ts || 0));
    return items.slice(0, limit);
  } catch (e) { console.error('listDownloadsByUser error', e); return []; }
}

// Broadcast helpers
async function listAllUserIds(env) {
  const ids = new Set();
  try {
    let cursor = undefined;
    do {
      const resp = await env.BOT_KV.list({ prefix: CONFIG.USER_PREFIX, limit: 1000, cursor });
      for (const k of resp.keys) {
        // keys like user:<uid> and user:<uid>:state — only pick pure profile keys
        const name = k.name;
        const m = name.match(/^user:(\d+)$/);
        if (m) ids.add(m[1]);
      }
      cursor = resp.cursor;
      if (!resp.list_complete && !cursor) break; // safety
    } while (cursor);
  } catch (e) { console.error('listAllUserIds error', e); }
  return Array.from(ids);
}

async function broadcastToAllUsers(env, text) {
  const ids = await listAllUserIds(env);
  let sent = 0, failed = 0;
  for (const uid of ids) {
    try {
      const res = await tgSendMessage(env, uid, text);
      if (res && res.ok) sent++; else failed++;
      // small gap isn't necessary on CF, but avoid hitting limits too hard
    } catch { failed++; }
  }
  return { total: ids.length, sent, failed };
}

async function buildUserReport(env, targetUid) {
  try {
    const u = await getUser(env, targetUid);
    if (!u) return 'کاربر یافت نشد';
    const owned = await listUserFiles(env, targetUid, 100);
    const received = await listFilesReceivedByUser(env, targetUid, 100);
    const purchases = await listPurchasesByUser(env, targetUid, 20);
    const downloads = await listDownloadsByUser(env, targetUid, 50);
    const parts = [];
    parts.push('👤 گزارش کاربر');
    parts.push(`آیدی: <code>${targetUid}</code>`);
    parts.push(`نام: <b>${htmlEscape(u.name || '-')}</b>`);
    parts.push(`موجودی: <b>${fmtNum(u.balance || 0)} ${CONFIG.DEFAULT_CURRENCY}</b>`);
    if (u.referrer_id) parts.push(`معرف: <code>${u.referrer_id}</code>`);
    if (u.ref_count) parts.push(`تعداد معرفی: <b>${fmtNum(u.ref_count)}</b>`);
    parts.push('');
    parts.push(`فایل‌های مالکیت‌دار: ${owned.length}`);
    if (owned.length) parts.push('• ' + owned.slice(0, 5).map(f => `${htmlEscape(f.file_name)} (${f.token||''})`).join('\n• '));
    parts.push('');
    parts.push(`فایل‌های دریافتی: ${received.length}`);
    if (received.length) parts.push('• ' + received.slice(0, 5).map(f => `${htmlEscape(f.file_name)} (${f.token||''})`).join('\n• '));
    parts.push('');
    const ap = purchases.filter(p => p.status === 'approved').length;
    const rp = purchases.filter(p => p.status === 'rejected').length;
    const pp = purchases.filter(p => p.status === 'pending').length;
    parts.push(`خریدها: ${purchases.length} (تایید: ${ap}، رد: ${rp}، در انتظار: ${pp})`);
    if (purchases.length) parts.push('• آخرین خرید: ' + `${purchases[0].coins||'-'} ${CONFIG.DEFAULT_CURRENCY} — ${purchases[0].amount_label||'-'} — ${purchases[0].status}`);
    parts.push('');
    parts.push(`دانلودها (لاگ): ${downloads.length}`);
    return parts.join('\n');
  } catch (e) {
    console.error('buildUserReport error', e);
    return 'خطا در تولید گزارش کاربر';
  }
}

// ===== DNS Storage Helpers =====
function dnsPrefix(version) {
  return version === 'v6' ? CONFIG.DNS_PREFIX_V6 : CONFIG.DNS_PREFIX_V4;
}

// ===== WireGuard Helpers =====
// Determine server public key to place in [Peer] section
async function getWgServerPublicKey(env, ep) {
  try {
    const s = await getSettings(env);
    const d = s?.wg_defaults || {};
    // Default to cloudflare if not set to ensure a PublicKey is always provided
    const mode = (d.peer_public_mode || 'cloudflare').toLowerCase();
    if (mode === 'cloudflare') {
      // Cloudflare public key requested by user
      return 'bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=';
    }
    // custom: use explicit key from defaults if provided
    if (d.peer_public_key && typeof d.peer_public_key === 'string' && d.peer_public_key.length > 20) {
      return d.peer_public_key.trim();
    }
    // fallback: if endpoint has a public_key field
    if (ep && ep.public_key) return String(ep.public_key);
  } catch {}
  return '';
}

async function putDnsAddresses(env, version, ips, country, flag, added_by, maxUsers = 0) {
  let added = 0;
  const ver = (version === 'v6') ? 'v6' : 'v4';
  for (const ip of ips) {
    if (ver === 'v4' && !isIPv4(ip)) continue;
    if (ver === 'v6' && !isIPv6(ip)) continue;
    const key = dnsPrefix(ver) + ip;
    const exists = await kvGet(env, key);
    if (exists) continue; // skip duplicates
    const obj = {
      ip,
      version: ver,
      country: country || '',
      flag: flag || '🌐',
      added_by: String(added_by || ''),
      assigned_to: '',
      assigned_at: 0,
      ts: nowTs(),
      max_users: Number(maxUsers || 0),
      used_count: 0
    };
    const ok = await kvSet(env, key, obj);
    if (ok) added++;
  }
  return added;
}

async function countAvailableDns(env, version) {
  try {
    const prefix = dnsPrefix(version);
    let cnt = 0;
    let cursor = undefined;
    
    // Get all keys with pagination
    do {
      const list = await env.BOT_KV.list({ prefix, limit: 1000, cursor });
      for (const k of list.keys) {
        const v = await kvGet(env, k.name);
        if (v) {
          const maxUsers = Number(v.max_users || 0);
          const usedCount = Number(v.used_count || 0);
          // Available if unlimited (0) or capacity not reached
          if (maxUsers === 0 || usedCount < maxUsers) cnt++;
        }
      }
      cursor = list.cursor;
    } while (cursor);
    
    return cnt;
  } catch (e) { console.error('countAvailableDns error', e); return 0; }
}

async function allocateDnsForUser(env, uid, version) {
  try {
    const prefix = dnsPrefix(version);
    let cursor = undefined;
    
    // Get all keys with pagination
    do {
      const list = await env.BOT_KV.list({ prefix, limit: 1000, cursor });
      for (const k of list.keys) {
        const key = k.name;
        const v = await kvGet(env, key);
        if (!v) continue;
        
        // Check if this IP has reached max users limit
        const maxUsers = Number(v.max_users || 0);
        const usedCount = Number(v.used_count || 0);
        
        if (maxUsers > 0 && usedCount >= maxUsers) {
          // Delete this IP as it has reached its limit
          await kvDel(env, key);
          continue;
        }
        
        // Assign based on capacity mode
        if (maxUsers === 1) {
          // Single-use: lock to user and optionally delete after
          v.assigned_to = String(uid);
          v.assigned_at = nowTs();
          v.used_count = usedCount + 1;
        } else {
          // Multi-use or unlimited: do NOT lock to a single user
          // Just increase usage counter
          v.used_count = usedCount + 1;
        }
        
        const ok = await kvSet(env, key, v);
        if (ok) {
          // If max_users is 1, delete the IP after assignment
          if (maxUsers === 1) {
            await kvDel(env, key);
          }
          // Save DNS meta for user for later resend
          try { await saveUserConfigItem(env, uid, 'dns', { ip: v.ip, version: v.version, country: v.country, flag: v.flag }); } catch {}
          return { ip: v.ip, version: v.version, country: v.country, flag: v.flag };
        }
      }
      cursor = list.cursor;
    } while (cursor);
    
    return null;
  } catch (e) { console.error('allocateDnsForUser error', e); return null; }
}

async function unassignDns(env, version, ip) {
  try {
    const key = dnsPrefix(version) + ip;
    const v = await kvGet(env, key);
    if (!v) return false;
    v.assigned_to = '';
    v.assigned_at = 0;
    return await kvSet(env, key, v);
  } catch (e) { console.error('unassignDns error', e); return false; }
}

// Delete unassigned DNS IPs by version and country, return number removed
async function deleteDnsByCountry(env, version, country) {
  try {
    const prefix = dnsPrefix(version);
    const list = await env.BOT_KV.list({ prefix, limit: 1000 });
    let removed = 0;
    for (const k of list.keys) {
      const key = k.name;
      const v = await kvGet(env, key);
      if (!v) continue;
      if (v.assigned_to) continue;
      if (String(v.country || '') !== String(country || '')) continue;
      const ok = await kvDel(env, key);
      if (ok) removed++;
    }
    return removed;
  } catch (e) { console.error('deleteDnsByCountry error', e); return 0; }
}

// Delete ALL DNS entries (both IPv4 and IPv6). Returns total removed
async function deleteAllDns(env) {
  try {
    let removed = 0;
    for (const ver of ['v4', 'v6']) {
      const prefix = dnsPrefix(ver);
      let cursor = undefined;
      do {
        const list = await env.BOT_KV.list({ prefix, limit: 1000, cursor });
        for (const k of list.keys) {
          const ok = await kvDel(env, k.name);
          if (ok) removed++;
        }
        cursor = list.cursor;
      } while (cursor);
    }
    return removed;
  } catch (e) { console.error('deleteAllDns error', e); return 0; }
}

// Group availability by country, preserving a representative flag
async function groupDnsAvailabilityByCountry(env, version) {
  try {
    const prefix = dnsPrefix(version);
    const map = {};
    let cursor = undefined;
    
    // Get all keys with pagination
    do {
      const list = await env.BOT_KV.list({ prefix, limit: 1000, cursor });
      for (const k of list.keys) {
        const v = await kvGet(env, k.name);
        if (!v) continue;
        // Skip entries that are fully used (respect capacity)
        const maxUsers = Number(v.max_users || 0);
        const usedCount = Number(v.used_count || 0);
        if (maxUsers > 0 && usedCount >= maxUsers) continue;
        // Skip entries that are hard-assigned to a single user (single-use)
        if (v.assigned_to) continue;
        const c = v.country || 'نامشخص';
        if (!map[c]) map[c] = { count: 0, flag: v.flag || '🌐' };
        map[c].count += 1;
        if (!map[c].flag && v.flag) map[c].flag = v.flag;
      }
      cursor = list.cursor;
    } while (cursor);
    
    return map;
  } catch (e) { console.error('groupDnsAvailabilityByCountry error', e); return {}; }
}

async function countAvailableDnsByCountry(env, version, country) {
  try {
    const prefix = dnsPrefix(version);
    let cnt = 0;
    let cursor = undefined;
    
    // Get all keys with pagination
    do {
      const list = await env.BOT_KV.list({ prefix, limit: 1000, cursor });
      for (const k of list.keys) {
        const v = await kvGet(env, k.name);
        if (v && String(v.country || '') === String(country || '')) {
          const maxUsers = Number(v.max_users || 0);
          const usedCount = Number(v.used_count || 0);
          if (maxUsers === 0 || usedCount < maxUsers) cnt++;
        }
      }
      cursor = list.cursor;
    } while (cursor);
    
    return cnt;
  } catch (e) { console.error('countAvailableDnsByCountry error', e); return 0; }
}

// ===== User Configs Helpers (DNS list + WG/OVPN saved) =====
// Build inline rows for user's assigned DNS entries (both v4 and v6)
async function listUserDnsConfigs(env, uid, limit = 20) {
  const makeRows = async (version) => {
    const rows = [];
    const prefix = dnsPrefix(version);
    let cursor = undefined;
    do {
      const list = await env.BOT_KV.list({ prefix, limit: 1000, cursor });
      for (const k of list.keys) {
        const v = await kvGet(env, k.name);
        if (v && String(v.assigned_to || '') === String(uid)) {
          const label = `${v.flag || '🌐'} ${v.country || ''} — ${v.ip}`;
          rows.push([{ text: label, callback_data: `resend_dns:${version}:${v.ip}` }]);
          if (rows.length >= limit) return rows;
        }
      }
      cursor = list.cursor;
    } while (cursor);
    return rows;
  };
  const v4Rows = await makeRows('v4');
  const v6Rows = await makeRows('v6');
  // Also include saved items in user profile (if any)
  const saved = await getUserConfigList(env, uid, 'dns').catch(() => []);
  const seen = new Set([...v4Rows, ...v6Rows].map(r => (r[0]?.callback_data || '')));
  const extra = [];
  for (const it of (saved || [])) {
    const cb = `resend_dns:${it.version || 'v4'}:${it.ip}`;
    if (seen.has(cb)) continue;
    const label = `${it.flag || '🌐'} ${it.country || ''} — ${it.ip}`;
    extra.push([{ text: label, callback_data: cb }]);
    if (v4Rows.length + v6Rows.length + extra.length >= limit) break;
  }
  return [...v4Rows, ...v6Rows, ...extra];
}

// Save and retrieve user config items (wg/ovpn) inside user profile
async function getUserConfigList(env, uid, type) {
  const u = await getUser(env, uid);
  const list = (u && u.configs && Array.isArray(u.configs[type])) ? u.configs[type] : [];
  return list;
}

async function getUserConfigItem(env, uid, type, id) {
  const list = await getUserConfigList(env, uid, type);
  return list.find(x => String(x.id) === String(id));
}

async function saveUserConfigItem(env, uid, type, item) {
  const u = await getUser(env, uid) || { id: uid };
  u.configs = u.configs || {};
  const arr = Array.isArray(u.configs[type]) ? u.configs[type] : [];
  // avoid duplicates: if comparable key exists
  const key = (type === 'ovpn') ? `${item.loc}|${item.proto}` : (type === 'wg') ? `${item.filename}|${item.country}` : '';
  const exists = arr.find(x => ((x.loc||'') + '|' + (x.proto||'')) === key || ((x.filename||'') + '|' + (x.country||'')) === key);
  if (!exists) {
    item.id = item.id || newToken(8);
    arr.push(item);
    u.configs[type] = arr;
    await setUser(env, uid, u);
  }
  return true;
}

async function allocateDnsForUserByCountry(env, uid, version, country) {
  try {
    const prefix = dnsPrefix(version);
    let cursor = undefined;
    
    // Get all keys with pagination
    do {
      const list = await env.BOT_KV.list({ prefix, limit: 1000, cursor });
      for (const k of list.keys) {
        const key = k.name;
        const v = await kvGet(env, key);
        if (!v || v.assigned_to) continue;
        if (String(v.country || '') !== String(country || '')) continue;
        
        // Check if this IP has reached max users limit
        const maxUsers = Number(v.max_users || 0);
        const usedCount = Number(v.used_count || 0);
        
        if (maxUsers > 0 && usedCount >= maxUsers) {
          // Delete this IP as it has reached its limit
          await kvDel(env, key);
          continue;
        }
        
        // Assign to user and increment used count
        v.assigned_to = String(uid);
        v.assigned_at = nowTs();
        v.used_count = usedCount + 1;
        
        const ok = await kvSet(env, key, v);
        if (ok) {
          // If max_users is 1, delete the IP after assignment
          if (maxUsers === 1) {
            await kvDel(env, key);
          }
          return { ip: v.ip, version: v.version, country: v.country, flag: v.flag };
        }
      }
      cursor = list.cursor;
    } while (cursor);
    
    return null;
  } catch (e) { console.error('allocateDnsForUserByCountry error', e); return null; }
}

// Return an existing flag for a country if any DNS entry exists for that country
async function getExistingFlagForCountry(env, version, country) {
  try {
    const prefix = dnsPrefix(version);
    let cursor = undefined;
    
    // Get all keys with pagination
    do {
      const list = await env.BOT_KV.list({ prefix, limit: 1000, cursor });
      for (const k of list.keys) {
        const v = await kvGet(env, k.name);
        if (!v) continue;
        if (String(v.country || '') === String(country || '')) {
          return v.flag || '🌐';
        }
      }
      cursor = list.cursor;
    } while (cursor);
    
    return '';
  } catch (e) { console.error('getExistingFlagForCountry error', e); return ''; }
}

async function getSettings(env) {
  const cache = initializeCache(env);
  cleanupCache(env);
  
  // Check cache first
  if (cache.settings && Date.now() - cache.lastCleanup < CONFIG.CACHE_TTL) {
    return cache.settings;
  }
  
  try {
    const s = (await kvGet(env, CONFIG.SERVICE_TOGGLE_KEY)) || {};
    
    // Apply safe defaults
    const defaults = {
      service_enabled: true,
      disabled_buttons: [],
      disabled_message: '🔧 این دکمه موقتاً غیرفعال است.',
      ovpn_price_coins: CONFIG.OVPN_PRICE_COINS,
      dns_price_coins: CONFIG.DNS_PRICE_COINS,
      ovpn_locations: CONFIG.OVPN_LOCATIONS,
      ovpn_flags: CONFIG.OVPN_FLAGS,
      card_info: CONFIG.CARD_INFO,
      support_url: 'https://t.me/NeoDebug',
      bot_version: CONFIG.BOT_VERSION,
      wg_defaults: {
        address: '10.66.66.2/32',
        dns: '10.202.10.10, 10.202.10.11',
        mtu: 1360,
        peer_public_mode: 'endpoint',
        peer_public_key: '',
        listen_port: '',
        allowed_ips: '0.0.0.0/11'
      },
      wg_endpoints: []
    };
    
    // Merge with defaults (shallow for most, deep for wg_defaults)
    let changed = false;
    for (const [key, defaultValue] of Object.entries(defaults)) {
      if (key === 'wg_defaults') continue; // handle below with deep merge
      if (s[key] === undefined || (Array.isArray(defaultValue) && !Array.isArray(s[key]))) {
        s[key] = defaultValue;
        changed = true;
      }
    }
    // Deep-merge wg_defaults to ensure edited fields persist while filling missing ones
    if (!s.wg_defaults || typeof s.wg_defaults !== 'object') {
      s.wg_defaults = { ...defaults.wg_defaults };
      changed = true;
    } else {
      for (const [k, v] of Object.entries(defaults.wg_defaults)) {
        if (s.wg_defaults[k] === undefined) { s.wg_defaults[k] = v; changed = true; }
      }
    }
    // Keep bot_version in KV synchronized with code version so UI reflects latest after deploy
    if (s.bot_version !== CONFIG.BOT_VERSION) {
      s.bot_version = CONFIG.BOT_VERSION;
      changed = true;
    }
    
    // Validate and fix wg_endpoints
    if (Array.isArray(s.wg_endpoints)) {
      let mutated = false;
      for (let i = 0; i < s.wg_endpoints.length; i++) {
        const e = s.wg_endpoints[i] || {};
        if (typeof e.used_count !== 'number') { e.used_count = 0; mutated = true; }
        if (typeof e.max_users !== 'number') { e.max_users = 0; mutated = true; }
        if (!validateInput(e.hostport, 'string', 100)) { 
          s.wg_endpoints.splice(i, 1); 
          i--; 
          mutated = true; 
        } else {
          s.wg_endpoints[i] = e;
        }
      }
      if (mutated) changed = true;
    }
    
    // Save changes if any
    if (changed) {
      try { 
        await setSettings(env, s); 
      } catch (saveError) {
        console.warn('getSettings: Failed to save updated settings', saveError.message);
      }
    }
    
    // Update cache
    cache.settings = s;
    cache.size++;
    
    return s;
  } catch (e) {
    console.error('getSettings error', e.message);
    // Return minimal safe defaults on error
    return {
      service_enabled: true,
      disabled_buttons: [],
      disabled_message: '🔧 سرویس موقتاً در دسترس نیست.'
    };
  }
}
async function setSettings(env, s) {
  if (!s || typeof s !== 'object') {
    console.error('setSettings: Invalid settings object');
    return false;
  }
  
  try {
    const ok = await kvSet(env, CONFIG.SERVICE_TOGGLE_KEY, s);
    if (ok) {
      // Update cache
      const cache = initializeCache(env);
      cache.settings = s;
    }
    return ok;
  } catch (e) {
    console.error('setSettings error', e.message);
    return false;
  }
}

async function bumpStat(env, key) {
  try {
    const stats = (await kvGet(env, CONFIG.BASE_STATS_KEY)) || {};
    stats[key] = (stats[key] || 0) + 1;
    await kvSet(env, CONFIG.BASE_STATS_KEY, stats);
  } catch (e) { console.error('bumpStat error', e); }
}
async function getStats(env) { return (await kvGet(env, CONFIG.BASE_STATS_KEY)) || {}; }

// Increase a numeric stat by an arbitrary delta (can be negative)
async function incStat(env, key, delta = 1) {
  try {
    const stats = (await kvGet(env, CONFIG.BASE_STATS_KEY)) || {};
    const cur = Number(stats[key] || 0);
    const d = Number(delta || 0);
    stats[key] = cur + d;
    await kvSet(env, CONFIG.BASE_STATS_KEY, stats);
  } catch (e) { console.error('incStat error', e); }
}

async function buildBackup(env) {
  try {
    const all = {};
    const list = await env.BOT_KV.list({ prefix: '' });
    for (const k of list.keys) {
      const v = await kvGet(env, k.name, 'text');
      all[k.name] = v;
    }
    return all;
  } catch (e) { console.error('buildBackup error', e); return {}; }
}

// Build a beautiful, structured backup JSON for export
async function buildPrettyBackup(env) {
  try {
    const startTime = Date.now();
    const list = await env.BOT_KV.list({ prefix: '' });
    const currentDate = new Date();
    
    // Initialize counters for statistics
    let userCount = 0;
    let fileCount = 0;
    let ticketCount = 0;
    let giftCount = 0;
    let purchaseCount = 0;
    let ovpnCount = 0;
    let blockedCount = 0;
    let otherCount = 0;
    
    const out = {
      "🔧 Metadata": {
        "🤖 Bot Information": {
          "name": CONFIG.BOT_NAME,
          "version": await getBotVersion(env),
          "backup_format_version": "2.0"
        },
        "📅 Backup Details": {
          "generated_at": currentDate.toISOString(),
          "generated_at_persian": currentDate.toLocaleDateString('fa-IR') + ' ' + currentDate.toLocaleTimeString('fa-IR'),
          "timezone": "UTC",
          "total_keys": list.keys.length
        },
        "📊 Summary": {
          // Will be filled after processing
        }
      },
      "⚙️ Settings": {},
      "📈 Statistics": {},
      "👥 Users": {},
      "📁 Files": {},
      "🎫 Tickets": {},
      "🎁 Gifts": {},
      "💰 Purchases": {},
      "🔐 OpenVPN": {},
      "🚫 Blocked Users": {},
      "📦 Other Data": {}
    };

    // Process all keys
    for (const k of list.keys) {
      const key = k.name;
      const raw = await kvGet(env, key, 'text');
      
      // Try to parse JSON content where applicable
      let val = raw;
      try { 
        val = JSON.parse(raw); 
      } catch {
        // Keep as string if not valid JSON
      }

      // Categorize data
      if (key === CONFIG.SERVICE_TOGGLE_KEY) { 
        out["⚙️ Settings"] = val; 
        continue; 
      }
      
      if (key === CONFIG.BASE_STATS_KEY) { 
        out["📈 Statistics"] = val; 
        continue; 
      }
      
      if (key.startsWith(CONFIG.USER_PREFIX) && !key.includes(':state')) {
        const userId = key.replace(CONFIG.USER_PREFIX, '');
        out["👥 Users"][userId] = val;
        userCount++;
        continue;
      }
      
      if (key.startsWith(CONFIG.USER_PREFIX) && key.endsWith(':state')) {
        const uid = key.substring(CONFIG.USER_PREFIX.length, key.length - ':state'.length);
        out["👥 Users"][uid] = out["👥 Users"][uid] || {};
        out["👥 Users"][uid].state = val;
        continue;
      }
      
      if (key.startsWith(CONFIG.FILE_PREFIX)) { 
        out["📁 Files"][key.replace(CONFIG.FILE_PREFIX, '')] = val; 
        fileCount++;
        continue; 
      }
      
      if (key.startsWith(CONFIG.TICKET_PREFIX)) { 
        out["🎫 Tickets"][key.replace(CONFIG.TICKET_PREFIX, '')] = val; 
        ticketCount++;
        continue; 
      }
      
      if (key.startsWith(CONFIG.GIFT_PREFIX)) { 
        out["🎁 Gifts"][key.replace(CONFIG.GIFT_PREFIX, '')] = val; 
        giftCount++;
        continue; 
      }
      
      if (key.startsWith(CONFIG.PURCHASE_PREFIX)) { 
        out["💰 Purchases"][key.replace(CONFIG.PURCHASE_PREFIX, '')] = val; 
        purchaseCount++;
        continue; 
      }
      
      if (key.startsWith(CONFIG.OVPN_PREFIX)) { 
        out["🔐 OpenVPN"][key.replace(CONFIG.OVPN_PREFIX, '')] = val; 
        ovpnCount++;
        continue; 
      }
      
      if (key.startsWith(CONFIG.BLOCK_PREFIX)) { 
        out["🚫 Blocked Users"][key.replace(CONFIG.BLOCK_PREFIX, '')] = val; 
        blockedCount++;
        continue; 
      }
      
      out["📦 Other Data"][key] = val;
      otherCount++;
    }

    // Fill in the summary statistics
    const processingTime = Date.now() - startTime;
    out["🔧 Metadata"]["📊 Summary"] = {
      "👥 Total Users": userCount,
      "📁 Total Files": fileCount,
      "🎫 Total Tickets": ticketCount,
      "🎁 Total Gifts": giftCount,
      "💰 Total Purchases": purchaseCount,
      "🔐 Total OpenVPN Configs": ovpnCount,
      "🚫 Total Blocked Users": blockedCount,
      "📦 Other Data Items": otherCount,
      "⏱️ Processing Time (ms)": processingTime,
      "💾 Backup Size": "Will be calculated after JSON stringify"
    };

    return out;
  } catch (e) {
    console.error('buildPrettyBackup error', e);
    return {
      "❌ Error": {
        "message": "Failed to create backup",
        "error": e.message,
        "timestamp": new Date().toISOString()
      }
    };
  }
}

async function getBaseUrlFromBot(env) {
  // روی Pages، URL را هنگام فراخوانی نمی‌دانیم؛ در لینک‌های تلگرام از دامنه پابلیک استفاده کنید
  // می‌توانید مقدار ثابت دامنه را در تنظیمات ذخیره کنید یا از ENV.PAGE_URL اگر داشتید.
  // برای سادگی فرض: از webhook URL مشتق نمی‌کنیم و از window.origin ممکن نیست. لذا لینک نسبی می‌سازیم.
  try {
    const s = await getSettings(env);
    const base = (s && s.base_url) ? String(s.base_url).trim() : '';
    if (base) return base.replace(/\/$/, '');
    const envBase = (env && env.PAGE_URL) ? String(env.PAGE_URL).trim() : '';
    if (envBase) return envBase.replace(/\/$/, '');
  } catch {}
  return '';
}

function ctxlessWait(promise) { 
  try { 
    if (promise && typeof promise.catch === 'function') {
      promise.catch(error => {
        console.warn('Background promise failed:', error.message);
      }); 
    }
  } catch (e) {
    console.warn('ctxlessWait error:', e.message);
  } 
}

// =========================================================
// Router & Export
// =========================================================
async function routerFetch(request, env, ctx) {
  try {
    const url = new URL(request.url);
    const path = url.pathname;

    // /webhook
    if (path === '/webhook') {
      return await handleWebhook(request, env, ctx);
    }

    // /f/<token>
    if (path.startsWith('/f/')) {
      return await handleFileDownload(request, env);
    }

    // Web Admin: WireGuard endpoints management
    if (path === '/admin/wg') {
      const key = url.searchParams.get('key') || '';
      const adminKey = (env?.ADMIN_WEB_KEY || '').trim();
      if (!adminKey || key !== adminKey) {
        return new Response('Unauthorized', { status: 401 });
      }
      if (request.method === 'POST') {
        try {
          const ct = request.headers.get('content-type') || '';
          if (/application\/x-www-form-urlencoded/i.test(ct)) {
            const formData = await request.formData();
            const action = String(formData.get('action') || '').trim();
            const s = await getSettings(env);
            s.wg_endpoints = Array.isArray(s.wg_endpoints) ? s.wg_endpoints : [];
            if (action === 'add') {
              const lines = String(formData.get('hostports') || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
              const country = String(formData.get('country') || '').trim();
              const flag = String(formData.get('flag') || '🌐').trim() || '🌐';
              const max_users = Number(String(formData.get('max_users') || '0').replace(/[^0-9]/g, '')) || 0;
              for (const hp of lines) {
                s.wg_endpoints.push({ hostport: hp, country, flag, used_count: 0, max_users });
              }
              await setSettings(env, s);
              return new Response(renderWgAdminPage(s, 'افزوده شد'), { headers: { 'content-type': 'text/html; charset=utf-8' } });
            } else if (action === 'del') {
              const idx = Number(String(formData.get('idx') || '').trim());
              if (idx >= 0 && idx < s.wg_endpoints.length) {
                s.wg_endpoints.splice(idx, 1);
                await setSettings(env, s);
                return new Response(renderWgAdminPage(s, 'حذف شد'), { headers: { 'content-type': 'text/html; charset=utf-8' } });
              }
              return new Response(renderWgAdminPage(s, 'ردیف نامعتبر'), { headers: { 'content-type': 'text/html; charset=utf-8' } });
            } else if (action === 'save_defaults') {
              // Persist WireGuard defaults only on explicit save
              s.wg_defaults = s.wg_defaults || {};
              const address = String(formData.get('address') || '').trim();
              const dns = String(formData.get('dns') || '').trim();
              const mtuStr = String(formData.get('mtu') || '').trim();
              const lpStr = String(formData.get('listen_port') || '').trim();
              const pkStr = String(formData.get('persistent_keepalive') || '').trim();
              const allowed = String(formData.get('allowed_ips') || '').trim();
              const cidrPool = String(formData.get('cidr_pool') || '').trim();
              const cidrApplyDns = !!formData.get('cidr_apply_dns');
              const cidrApplyAddr = !!formData.get('cidr_apply_address');
              const cidrApplyEp = !!formData.get('cidr_apply_endpoint');
              const mode = String(formData.get('peer_public_mode') || 'cloudflare').toLowerCase();
              const peerKey = String(formData.get('peer_public_key') || '').trim();

              // Assign string fields (allow empty -> delete)
              s.wg_defaults.address = address || undefined;
              s.wg_defaults.dns = dns || undefined;
              s.wg_defaults.allowed_ips = allowed || undefined;
              s.wg_defaults.cidr_pool = cidrPool || undefined;
              s.wg_defaults.cidr_apply_dns = cidrApplyDns || false;
              s.wg_defaults.cidr_apply_address = cidrApplyAddr || false;
              s.wg_defaults.cidr_apply_endpoint = cidrApplyEp || false;
              s.wg_defaults.peer_public_key = peerKey || '';

              // Numeric fields
              const mtu = Number(mtuStr.replace(/[^0-9]/g, ''));
              s.wg_defaults.mtu = Number.isFinite(mtu) && mtu > 0 ? mtu : undefined;
              const lp = Number(lpStr.replace(/[^0-9]/g, ''));
              s.wg_defaults.listen_port = Number.isFinite(lp) && lp > 0 ? lp : undefined;
              const pk = Number(pkStr.replace(/[^0-9]/g, ''));
              s.wg_defaults.persistent_keepalive = Number.isFinite(pk) && pk > 0 ? pk : undefined;

              // Mode validation
              s.wg_defaults.peer_public_mode = ['cloudflare','endpoint','custom'].includes(mode) ? mode : 'cloudflare';

              await setSettings(env, s);
              return new Response(renderWgAdminPage(s, 'ذخیره شد'), { headers: { 'content-type': 'text/html; charset=utf-8' } });
            }
          }
        } catch (e) { console.error('/admin/wg POST error', e); return new Response('خطا', { status: 500 }); }
      }
      // GET render
      const s = await getSettings(env);
      return new Response(renderWgAdminPage(s), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    // Root → status page
    if (path === '/' || path === '') {
      return await handleRoot(request, env);
    }

    return new Response('Not Found', { status: 404 });
  } catch (e) {
    console.error('routerFetch error', e);
    return new Response('Internal Error', { status: 500 });
  }
}
// 9) Public Status Page (Glassmorphism)
// =========================================================
function renderStatusPage(settings, stats, envSummary = {}) {
  const enabled = settings?.service_enabled !== false;
  const users = Number((stats || {}).users || 0);
  const files = Number((stats || {}).files || 0);
  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>وضعیت ربات</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Vazirmatn:wght@300;400;600&display=swap');
  :root { --bg: #0f172a; --card: rgba(255,255,255,0.08); --text: #e5e7eb; --sub:#94a3b8; --ok:#34d399; --warn:#fbbf24; --bad:#f87171; }
  *{ box-sizing:border-box; }
  body{ margin:0; font-family:'Vazirmatn',sans-serif; background:#000; color:var(--text); min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px; }
  .container{ width:100%; max-width:720px; }
  header{ text-align:center; margin-bottom:24px; }
  h1{ font-weight:600; margin:0 0 6px; }
  p{ margin:0; color:var(--sub); }
  .grid{ display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:16px; }
  .card{ background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.12); border-radius:16px; padding:16px; backdrop-filter: blur(10px); box-shadow:0 10px 30px rgba(0,0,0,0.6); }
  .stat{ font-size:14px; }
  .pill{ display:inline-block; padding:4px 10px; border-radius:999px; font-size:12px; }
  .ok{ background:rgba(52,211,153,0.15); color:#34d399; }
  .bad{ background:rgba(248,113,113,0.15); color:#f87171; }
  .warn{ background:rgba(251,191,36,0.15); color:#fbbf24; }
  .wg-admin-card form{ display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .wg-admin-card input[type="password"]{ flex:1; min-width:180px; padding:6px 10px; border-radius:8px; border:1px solid rgba(255,255,255,0.2); background:rgba(255,255,255,0.06); color:#fff; }
  .wg-admin-card button{ padding:6px 12px; border-radius:8px; border:0; background:#3b82f6; color:#fff; cursor:pointer; }
  @media (max-width: 480px){
    .wg-admin-card input[type="password"]{ width:100%; flex: 1 1 100%; }
    .wg-admin-card button{ width:100%; }
  }
</style>
</head>
<body>
  <main class="container">
    <header>
      <h1>وضعیت ربات</h1>
      <p>نمایش خلاصه وضعیت سرویس</p>
    </header>
    <div class="grid">
      <div class="card stat">
        <div style="margin-bottom:6px; font-weight:600;">توکن ربات</div>
        <span class="pill ${envSummary.botTokenSet ? 'ok' : 'bad'}">${envSummary.botTokenSet ? 'تنظیم شده' : 'تنظیم نشده'}</span>
      </div>
      <div class="card stat">
        <div style="margin-bottom:6px; font-weight:600;">ادمین</div>
        <span class="pill ${envSummary.adminIdSet || envSummary.adminIdsSet ? 'ok' : 'warn'}">${envSummary.adminIdSet || envSummary.adminIdsSet ? 'تعریف شده' : 'تعریف نشده'}</span>
      </div>
      <div class="card stat">
        <div style="margin-bottom:6px; font-weight:600;">اتصال KV</div>
        <span class="pill ${envSummary.kvBound ? 'ok' : 'bad'}">${envSummary.kvBound ? 'متصل' : 'نامتصل'}</span>
      </div>
      <div class="card stat">
        <div style="margin-bottom:6px; font-weight:600;">وضعیت سرویس</div>
        <span class="pill ${enabled ? 'ok' : 'warn'}">${enabled ? 'فعال' : 'غیرفعال'}</span>
      </div>
      <div class="card stat">
        <div style="margin-bottom:6px; font-weight:600;">تعداد کاربران</div>
        <div>${users.toLocaleString('fa-IR')}</div>
      </div>
      <div class="card stat">
        <div style="margin-bottom:6px; font-weight:600;">تعداد فایل‌ها</div>
        <div>${files.toLocaleString('fa-IR')}</div>
      </div>
      <div class="card stat wg-admin-card">
        <div style="margin-bottom:10px; font-weight:600;">مدیریت Endpoint های WireGuard</div>
        <form method="GET" action="/admin/wg">
          <input name="key" type="password" placeholder="ADMIN_WEB_KEY" />
          <button type="submit">بازکردن</button>
        </form>
        <div style="margin-top:6px; color:var(--sub); font-size:12px;">کلید وب ادمین را وارد کنید تا به صفحه مدیریت Endpoint منتقل شوید.</div>
      </div>
    </div>
  </main>
</body>
</html>`;
}
// 11) Expose app via global (for Wrangler/Pages)
globalThis.APP = { fetch: routerFetch };
