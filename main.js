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
  DEFAULT_CURRENCY: 'سکه',
  SERVICE_TOGGLE_KEY: 'settings:service_enabled',
  BASE_STATS_KEY: 'stats:base',
  USER_PREFIX: 'user:',
  FILE_PREFIX: 'file:',
  TICKET_PREFIX: 'ticket:',
  DOWNLOAD_LOG_PREFIX: 'dl:',
  GIFT_PREFIX: 'gift:',
  REDEEM_PREFIX: 'redeem:',
  REF_DONE_PREFIX: 'ref:done:',
};

// صفحات فانکشنز env: { BOT_KV }

// ارسال فایل به کاربر با رعایت قوانین قیمت/محدودیت
async function deliverFileToUser(env, uid, chat_id, token) {
  try {
    const meta = await kvGet(env, CONFIG.FILE_PREFIX + token);
    if (!meta || meta.disabled) {
      await tgSendMessage(env, chat_id, 'فایل یافت نشد یا غیرفعال است.');
      return false;
    }
    const users = Array.isArray(meta.users) ? meta.users : [];
    const maxUsers = Number(meta.max_users || 0);
    const price = Number(meta.price || 0);
    const isOwner = String(meta.owner_id) === String(uid);
    const already = users.includes(String(uid));
    if (!already && maxUsers > 0 && users.length >= maxUsers) {
      await tgSendMessage(env, chat_id, 'ظرفیت دریافت این فایل تکمیل شده است.');
      return false;
    }
    if (!already && price > 0 && !isOwner) {
      const u = await getUser(env, String(uid));
      if (!u || Number(u.balance || 0) < price) {
        await tgSendMessage(env, chat_id, 'موجودی شما برای دریافت فایل کافی نیست.');
        return false;
      }
      u.balance = Number(u.balance || 0) - price;
      await setUser(env, String(uid), u);
    }
    if (!already) {
      users.push(String(uid));
      meta.users = users;
      await kvSet(env, CONFIG.FILE_PREFIX + token, meta);
    }
    // ارسال سند از طریق تلگرام
    await tgSendDocument(env, chat_id, meta.file_id, { caption: `📄 ${meta.file_name || ''}` });
    return true;
  } catch (e) {
    console.error('deliverFileToUser error', e);
    await tgSendMessage(env, chat_id, 'خطا در ارسال فایل.');
    return false;
  }
}

async function handleTokenRedeem(env, uid, chat_id, token) {
  try {
    const t = String(token || '').trim();
    if (!/^[A-Za-z0-9]{6}$/.test(t)) {
      await tgSendMessage(env, chat_id, 'توکن نامعتبر است. یک توکن ۶ کاراکتری ارسال کنید.');
      return;
    }
    const ok = await deliverFileToUser(env, uid, chat_id, t);
    if (ok) {
      await clearUserState(env, uid);
    }
  } catch (e) {
    console.error('handleTokenRedeem error', e);
  }
}

// ------------------ Get bot version (for display in main menu) ------------------ //
async function getBotVersion(env) {
  try {
    const s = await getSettings(env);
    return s?.bot_version || '1.5';
  } catch { return '1.5'; }
}

// ------------------ Get bot version (for display in main menu) ------------------ //
async function mainMenuHeader(env) {
  const v = await getBotVersion(env);
  return `منو اصلی:\nنسخه ربات: ${v}`;
}

// Get bot info (for auto-detecting username if BOT_USERNAME is not set)
async function tgGetMe(env) {
  try {
    const res = await fetch(tgApiUrl('getMe', env), { method: 'GET' });
    return await res.json();
  } catch (e) { console.error('tgGetMe error', e); return null; }
}

async function getBotUsername(env) {
  try {
    const s = await getSettings(env);
    if (s?.bot_username) return s.bot_username;
    const me = await tgGetMe(env);
    const u = me?.result?.username;
    if (u) {
      s.bot_username = u;
      await setSettings(env, s);
      return u;
    }
    return '';
  } catch (e) { console.error('getBotUsername error', e); return ''; }
}

// Referral helpers (auto credit once)
async function autoCreditReferralIfNeeded(env, referrerId, referredId) {
  try {
    if (!referrerId || !referredId || String(referrerId) === String(referredId)) return false;
    const doneKey = CONFIG.REF_DONE_PREFIX + String(referredId);
    const done = await kvGet(env, doneKey);
    if (done) return false; // already credited once
    const amount = 1; // grant 1 coin to referrer
    const credited = await creditBalance(env, String(referrerId), amount);
    if (!credited) return false;
    // bump referrer counter
    const ru = await getUser(env, String(referrerId));
    if (ru) { ru.ref_count = Number(ru.ref_count || 0) + 1; await setUser(env, String(referrerId), ru); }
    await kvSet(env, doneKey, { ts: nowTs(), amount, referrer_id: String(referrerId) });
    return true;
  } catch (e) { console.error('autoCreditReferralIfNeeded error', e); return false; }
}

// Ticket storage
async function createTicket(env, uid, content) {
  try {
    const id = newToken(10);
    const t = { id, user_id: uid, content: String(content || ''), created_at: nowTs(), closed: false };
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

// Gift codes
async function createGiftCode(env, amount) {
  try {
    const code = newToken(10);
    const obj = { code, amount: Number(amount || 0), created_at: nowTs(), used_by: null };
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
// 2) KV Helpers
// =========================================================
async function kvGet(env, key, type = 'json') {
  try {
    const v = await env.BOT_KV.get(key);
    if (v == null) return null;
    if (type === 'json') {
      try { return JSON.parse(v); } catch { return null; }
    }
    return v;
  } catch (e) {
    console.error('kvGet error', key, e);
    return null;
  }
}

async function kvSet(env, key, value, type = 'json', ttlSeconds) {
  try {
    const payload = type === 'json' ? JSON.stringify(value) : String(value);
    if (ttlSeconds) {
      await env.BOT_KV.put(key, payload, { expirationTtl: ttlSeconds });
    } else {
      await env.BOT_KV.put(key, payload);
    }
    return true;
  } catch (e) {
    console.error('kvSet error', key, e);
    return false;
  }
}

async function kvDel(env, key) {
  try {
    await env.BOT_KV.delete(key);
    return true;
  } catch (e) {
    console.error('kvDel error', key, e);
    return false;
  }
}

// =========================================================
// 3) Telegram Helpers
// =========================================================
function tgApiUrl(method, env) {
  const token = env?.BOT_TOKEN; // BOT_TOKEN is the canonical env name
  return `https://api.telegram.org/bot${token}/${method}`;
}

async function tgSendMessage(env, chat_id, text, opts = {}) {
  try {
    const body = { chat_id, text, parse_mode: 'HTML', ...opts };
    const res = await fetch(tgApiUrl('sendMessage', env), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch (e) {
    console.error('tgSendMessage error', e);
    return null;
  }
}

async function tgSendDocument(env, chat_id, file_id_or_url, opts = {}) {
  try {
    // ارسال سند با file_id یا URL
    const form = new FormData();
    form.set('chat_id', String(chat_id));
    if (file_id_or_url.startsWith('http')) {
      form.set('document', file_id_or_url);
    } else {
      form.set('document', file_id_or_url);
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
  if (t.startsWith('http')) return t;
  if (t.startsWith('@') || t.startsWith('-100')) return t;
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
      const url = ch.startsWith('http') ? ch : `https://t.me/${ch.replace(/^@/, '')}`;
      // به درخواست شما آیدی کانال نمایش داده نشود
      rows.push([{ text: 'عضویت در کانال', url }]);
    }
    rows.push([{ text: '✅ بررسی عضویت', callback_data: 'join_check' }]);
    return { reply_markup: { inline_keyboard: rows } };
  } catch {
    return { reply_markup: { inline_keyboard: [[{ text: '✅ بررسی عضویت', callback_data: 'join_check' }]] } };
  }
}

async function ensureJoinedChannels(env, uid, chat_id, silent = false) {
  try {
    const s = await getSettings(env);
    const src = (s?.join_channels && Array.isArray(s.join_channels) ? s.join_channels.join(',') : '');
    const channels = String(src || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    if (!channels.length) return true; // No mandatory channels configured
    // Try to check membership; if API fails, show prompt
    for (const ch of channels) {
      try {
        // پشتیبانی از ورودی‌های مختلف: @username ، -100id ، یا لینک t.me
        let chat = '';
        if (ch.startsWith('http')) {
          // تلاش برای استخراج یوزرنیم از لینک t.me
          try {
            const u = new URL(ch);
            const host = u.hostname.replace(/^www\./, '');
            const seg = (u.pathname || '').split('/').filter(Boolean)[0] || '';
            // اگر لینک از نوع t.me/<username> بود
            if ((host === 't.me' || host === 'telegram.me') && seg && seg.toLowerCase() !== 'joinchat') {
              chat = '@' + seg;
            } else {
              // لینک دعوت خصوصی یا ناشناس → امکان چک membership نیست؛ از این مورد صرف‌نظر می‌کنیم
              chat = '';
            }
          } catch {
            chat = '';
          }
        } else if (ch.startsWith('@') || /^-100/.test(ch)) {
          chat = ch;
        } else {
          chat = `@${ch}`;
        }

        // اگر قابل بررسی نبود، از این کانال عبور می‌کنیم
        if (!chat) continue;
        const res = await tgGetChatMember(env, chat, uid);
        const status = res?.result?.status;
        if (!status || ['left', 'kicked'].includes(status)) {
          if (!silent) await tgSendMessage(env, chat_id, 'برای استفاده از ربات ابتدا عضو کانال‌های زیر شوید سپس دکمه بررسی را بزنید:', await buildJoinKb(env));
          return false;
        }
      } catch (e) {
        // در خطاهای موقت تلگرام، کاربر را مزاحم نکنیم؛ فقط اگر silent=false باشد یک بار راهنما می‌فرستیم
        if (!silent) {
          await tgSendMessage(env, chat_id, 'برای استفاده از ربات ابتدا عضو کانال‌های زیر شوید سپس دکمه بررسی را بزنید:', await buildJoinKb(env));
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
// 4) Utility Helpers
// =========================================================
function nowTs() { return Math.floor(Date.now() / 1000); }
function fmtNum(n) { try { return Number(n || 0).toLocaleString('fa-IR'); } catch { return String(n || 0); } }
function safeJson(obj, fallback = '{}') { try { return JSON.stringify(obj); } catch { return fallback; } }
function newToken(size = 26) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let t = '';
  crypto.getRandomValues(new Uint8Array(size)).forEach((b) => { t += chars[b % chars.length]; });
  return t;
}
function htmlEscape(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

// =========================================================
// 5) Inline UI Helpers
// =========================================================
function kb(rows) { return { reply_markup: { inline_keyboard: rows } }; }

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

function mainMenuKb(env, uid) {
  const rows = [
    [ { text: '👥 معرفی دوستان', callback_data: 'referrals' }, { text: '👤 حساب کاربری', callback_data: 'account' } ],
    [ { text: '🎁 کد هدیه', callback_data: 'giftcode' }, { text: '🔑 دریافت با توکن', callback_data: 'redeem_token' } ],
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

function adminMenuKb(settings) {
  const enabled = settings?.service_enabled !== false;
  const updating = settings?.update_mode === true;
  return kb([
    // Row 1: Update mode only
    [ { text: updating ? '🔧 حالت بروزرسانی: روشن' : '🔧 حالت بروزرسانی: خاموش', callback_data: 'adm_update_toggle' } ],
    // Row 2: Upload | Manage Files
    [ { text: '📤 بارگذاری فایل', callback_data: 'adm_upload' }, { text: '🗂 مدیریت فایل‌ها', callback_data: 'adm_files' } ],
    // Row 3: Tickets | Gift Codes
    [ { text: '🎟 مدیریت تیکت‌ها', callback_data: 'adm_tickets' }, { text: '🎁 کدهای هدیه', callback_data: 'adm_gifts' } ],
    // Row 4: Service Settings (feature toggles)
    [ { text: '⚙️ تنظیمات سرویس', callback_data: 'adm_service' } ],
    // Row 5: Join Mandatory | Bot Stats
    [ { text: '📢 جویین اجباری', callback_data: 'adm_join' }, { text: '📊 آمار ربات', callback_data: 'adm_stats' } ],
    // Row 6: Subtract | Add Coins
    [ { text: '➖ کسر سکه', callback_data: 'adm_sub' }, { text: '➕ افزودن سکه', callback_data: 'adm_add' } ],
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

// پنل وب مدیریت حذف شد

// لاگین و سشن حذف شد

// احراز هویت وبی حذف شد

async function handleWebhook(request, env, ctx) {
  // فقط POST از تلگرام پذیرفته می‌شود
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  if (!env?.BOT_TOKEN) {
    console.error('handleWebhook: BOT_TOKEN is not set');
    return new Response('bot token missing', { status: 500 });
  }
  let update = null;
  try { update = await request.json(); } catch (e) { console.error('handleWebhook: bad json', e); return new Response('bad json', { status: 200 }); }
  try { console.log('webhook update:', JSON.stringify(update)); } catch {}

  ctx.waitUntil(processUpdate(update, env));
  // پاسخ سریع به تلگرام
  return new Response('ok', { status: 200 });
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
      const maxUsers = Number(meta.max_users || 0);
      const price = Number(meta.price || 0);
      const isOwner = String(meta.owner_id) === String(uid);
      const already = users.includes(String(uid));
      if (!already && maxUsers > 0 && users.length >= maxUsers) {
        return new Response('ظرفیت دریافت این فایل تکمیل شده است.', { status: 403 });
      }
      if (!already && price > 0 && !isOwner) {
        const u = await getUser(env, String(uid));
        if (!u || Number(u.balance || 0) < price) {
          return new Response('موجودی شما برای دریافت فایل کافی نیست.', { status: 402 });
        }
        // کسر سکه و ثبت کاربر
        u.balance = Number(u.balance || 0) - price;
        await setUser(env, String(uid), u);
      }
      if (!already) {
        users.push(String(uid));
        meta.users = users;
        await kvSet(env, CONFIG.FILE_PREFIX + token, meta);
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

    // Mandatory join check
    const joined = await ensureJoinedChannels(env, uid, chat_id);
    if (!joined) return; // A join prompt has been shown

    // دستورات متنی
    const text = msg.text || msg.caption || '';
    if (text.startsWith('/start')) {
      await sendWelcome(chat_id, uid, env, msg);
      return;
    }
    if (text.startsWith('/update')) {
      await clearUserState(env, uid);
      await tgSendMessage(env, chat_id, await mainMenuHeader(env), mainMenuKb(env, uid));
      return;
    }

    // دریافت فایل (Document)
    if (msg.document) {
      // بررسی فعال بودن سرویس
      const settings = await getSettings(env);
      const enabled = settings?.service_enabled !== false;
      if (!enabled) {
        await tgSendMessage(env, chat_id, 'سرویس موقتاً غیرفعال است. لطفاً بعداً تلاش کنید.');
        return;
      }
      // adm_cost removed per request

      // اگر ادمین در فلو آپلود است
      const st = await getUserState(env, uid);
      if (isAdminUser(env, uid) && st?.step === 'adm_upload_wait_file') {
        const tmp = {
          file_id: msg.document.file_id,
          file_name: msg.document.file_name || 'file',
          file_size: msg.document.file_size || 0,
          mime_type: msg.document.mime_type || 'application/octet-stream',
        };
        await setUserState(env, uid, { step: 'adm_upload_price', tmp });
        await tgSendMessage(env, chat_id, '💰 قیمت فایل به سکه را ارسال کنید (مثلاً 10):');
        return;
      }

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

      const base = await getBaseUrlFromBot(env);
      const link = `${base}/f/${token}?uid=${uid}${meta.referrer_id ? `&ref=${encodeURIComponent(meta.referrer_id)}` : ''}`;
      const botUser = await getBotUsername(env);
      const deepLink = botUser ? `https://t.me/${botUser}?start=${token}` : '';
      await tgSendMessage(env, chat_id, `فایل شما ذخیره شد ✅\nنام: <b>${htmlEscape(meta.file_name)}</b>\nحجم: <b>${fmtNum(meta.file_size)} بایت</b>\n\nلینک دریافت مستقیم: ${link}${deepLink ? `\nلینک دعوت دریافت در ربات: ${deepLink}` : ''}`);
      return;
    }

    // سایر متن‌ها → نمایش منو و مدیریت stateها
    if (text) {
      // Handle stateful flows for giftcode/redeem
      const state = await getUserState(env, uid);
      if (state?.step === 'giftcode_wait') {
        const code = text.trim();
        await handleGiftCodeRedeem(env, uid, chat_id, code);
        return;
      }
      if (state?.step === 'redeem_token_wait') {
        const token = text.trim();
        await handleTokenRedeem(env, uid, chat_id, token);
        return;
      }
      if (state?.step === 'ticket_wait') {
        const content = text.trim();
        await createTicket(env, uid, content);
        await tgSendMessage(env, chat_id, '✅ تیکت شما ثبت شد.');
        await clearUserState(env, uid);
        return;
      }
      if (isAdminUser(env, uid) && state?.step === 'adm_upload_price') {
        const amount = Number(text.replace(/[^0-9]/g, ''));
        const tmp = state.tmp || {};
        if (!tmp.file_id) { await clearUserState(env, uid); await tgSendMessage(env, chat_id, 'خطا. دوباره تلاش کنید.'); return; }
        await setUserState(env, uid, { step: 'adm_upload_limit', tmp, price: amount >= 0 ? amount : 0 });
        await tgSendMessage(env, chat_id, '🔢 محدودیت تعداد دریافت‌کنندگان یکتا را ارسال کنید (مثلاً 2). برای بدون محدودیت 0 بفرستید:');
        return;
      }
      if (isAdminUser(env, uid) && state?.step === 'adm_upload_limit') {
        const maxUsers = Number(text.replace(/[^0-9]/g, ''));
        const tmp = state.tmp || {};
        const price = Number(state.price || 0);
        const token = newToken(6);
        const meta = {
          token,
          owner_id: uid,
          file_id: tmp.file_id,
          file_name: tmp.file_name,
          file_size: tmp.file_size,
          mime_type: tmp.mime_type,
          created_at: nowTs(),
          referrer_id: extractReferrerFromStartParam(msg) || '',
          disabled: false,
          price: price >= 0 ? price : 0,
          max_users: maxUsers >= 0 ? maxUsers : 0,
          users: [],
        };
        await kvSet(env, CONFIG.FILE_PREFIX + token, meta);
        await clearUserState(env, uid);
        const base = await getBaseUrlFromBot(env);
        const link = `${base}/f/${token}?uid=${uid}`;
        const botUser = await getBotUsername(env);
        const deepLink = botUser ? `https://t.me/${botUser}?start=${token}` : '';
        await tgSendMessage(env, chat_id, `✅ فایل با موفقیت ثبت شد.\nنام: <b>${htmlEscape(meta.file_name)}</b>\nقیمت: <b>${fmtNum(meta.price)}</b> ${CONFIG.DEFAULT_CURRENCY}\nمحدودیت یکتا: <b>${meta.max_users||0}</b>\nلینک مستقیم: ${link}${deepLink ? `\nلینک دعوت دریافت در ربات: ${deepLink}` : ''}`);
        return;
      }
      // no adm_cost state anymore
      // Admin flows
      if (isAdminUser(env, uid)) {
        if (state?.step === 'adm_join_wait') {
          const token = normalizeChannelToken(text);
          if (!token) {
            await tgSendMessage(env, chat_id, '❌ کانال نامعتبر است. نمونه: @channel یا لینک کامل');
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
        if (state?.step === 'adm_gift_create_amount') {
          const amount = Number(text.replace(/[^0-9]/g, ''));
          if (!amount || amount <= 0) {
            await tgSendMessage(env, chat_id, 'مبلغ نامعتبر است. یک عدد معتبر ارسال کنید.');
            return;
          }
          const g = await createGiftCode(env, amount);
          if (g) {
            await tgSendMessage(env, chat_id, `✅ کد هدیه ایجاد شد.\nکد: <code>${g.code}</code>\nمبلغ: ${fmtNum(g.amount)} ${CONFIG.DEFAULT_CURRENCY}`);
          } else {
            await tgSendMessage(env, chat_id, '❌ ایجاد کد هدیه ناموفق بود.');
          }
          await clearUserState(env, uid);
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
          const ok = await creditBalance(env, state.target, amount);
          await tgSendMessage(env, chat_id, ok ? `✅ ${fmtNum(amount)} سکه به کاربر ${state.target} افزوده شد.` : '❌ انجام نشد.');
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
          const ok = await subtractBalance(env, state.target, amount);
          await tgSendMessage(env, chat_id, ok ? `✅ ${fmtNum(amount)} سکه از کاربر ${state.target} کسر شد.` : '❌ انجام نشد (شاید موجودی کافی نیست).');
          await clearUserState(env, uid);
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

    // Mandatory join check
    const joined = await ensureJoinedChannels(env, uid, chat_id);
    if (!joined && data !== 'join_check') {
      await tgAnswerCallbackQuery(env, cb.id, 'ابتدا عضو کانال‌ها شوید');
      return;
    }

    if (data === 'join_check') {
      const ok = await ensureJoinedChannels(env, uid, chat_id, true);
      if (ok) {
        // پس از تایید عضویت، اگر معرف ذخیره شده است، یکبار سکه به معرف بده
        try {
          const u = await getUser(env, uid);
          const ref = u?.referrer_id;
          if (ref && String(ref) !== String(uid)) {
            const credited = await autoCreditReferralIfNeeded(env, String(ref), String(uid));
            if (credited) {
              try { await tgSendMessage(env, String(ref), `🎉 یک زیرمجموعه جدید تایید شد. 1 🪙 به حساب شما افزوده شد.`); } catch {}
            }
          }
        } catch {}
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
      const hdr = await mainMenuHeader(env);
      await tgEditMessage(env, chat_id, mid, hdr, mainMenuKb(env, uid));
      await tgAnswerCallbackQuery(env, cb.id);
      return;
    }

    if (data === 'redeem_token') {
      await setUserState(env, uid, { step: 'redeem_token_wait' });
      await tgSendMessage(env, chat_id, '🔑 لطفاً توکن ۶ کاراکتری فایل را ارسال کنید:');
      await tgAnswerCallbackQuery(env, cb.id);
      return;
    }

    if (data === 'account') {
      const u = await getUser(env, uid);
      const bal = fmtNum(u?.balance || 0);
      const kbAcc = kb([
        [ { text: '🆘 پشتیبانی', url: 'https://t.me/NeoDebug' }, { text: '🎫 ارسال تیکت', callback_data: 'ticket_new' } ],
        [ { text: '🔙 بازگشت', callback_data: 'back_main' } ]
      ]);
      const txt = [
        '👤 حساب کاربری',
        `آیدی: <code>${uid}</code>`,
        `نام: <b>${htmlEscape(u?.name || '-')}</b>`,
        `موجودی: <b>${bal} ${CONFIG.DEFAULT_CURRENCY}</b>`,
      ].join('\n');
      await tgSendMessage(env, chat_id, txt, kbAcc);
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

    // انتقال سکه برای کاربران حذف شد

    if (data === 'giftcode') {
      await setUserState(env, uid, { step: 'giftcode_wait' });
      await tgSendMessage(env, chat_id, '🎁 لطفاً کد هدیه را ارسال کنید. /update برای لغو');
      await tgAnswerCallbackQuery(env, cb.id);
      return;
    }

    if (data === 'redeem_token') {
      await setUserState(env, uid, { step: 'redeem_token_wait' });
      await tgEditMessage(env, chat_id, mid, '🔑 لطفاً توکن دریافتی را ارسال کنید. /update برای لغو', {});
      await tgAnswerCallbackQuery(env, cb.id);
      return;
    }

    if (data === 'buy_coins') {
      await tgSendMessage(env, chat_id, `🪙 خرید سکه\nبرای خرید سکه با پشتیبانی تماس بگیرید: https://t.me/NeoDebug`);
      await tgAnswerCallbackQuery(env, cb.id);
      return;
    }

    if (data === 'ticket_new') {
      await setUserState(env, uid, { step: 'ticket_wait' });
      await tgSendMessage(env, chat_id, '🎫 لطفاً متن تیکت خود را ارسال کنید. /update برای لغو');
      await tgAnswerCallbackQuery(env, cb.id);
      return;
    }

    if (data === 'fm') {
      if (!isAdminUser(env, uid)) { await tgAnswerCallbackQuery(env, cb.id, 'این بخش مخصوص مدیر است'); return; }
      await tgEditMessage(env, chat_id, mid, '📁 مدیریت فایل‌ها', fmMenuKb());
      await tgAnswerCallbackQuery(env, cb.id);
      return;
    }

    if (data === 'myfiles') {
      if (!isAdminUser(env, uid)) { await tgAnswerCallbackQuery(env, cb.id, 'این بخش مخصوص مدیر است'); return; }
      const files = await listFiles(env, 10);
      if (files.length === 0) {
        await tgEditMessage(env, chat_id, mid, 'فایلی وجود ندارد.', fmMenuKb());
      } else {
        let txt = '🗂 فهرست فایل‌ها:\n\n';
        for (const f of files) {
          txt += `• ${htmlEscape(f.file_name)} (${fmtNum(f.file_size)} بایت) — ${f.disabled ? 'غیرفعال' : 'فعال'}\n`;
        }
        await tgEditMessage(env, chat_id, mid, txt, fmMenuKb());
      }
      await tgAnswerCallbackQuery(env, cb.id);
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
      if (data === 'adm_upload') {
        await setUserState(env, uid, { step: 'adm_upload_wait_file' });
        await tgEditMessage(env, chat_id, mid, '⬆️ فایل خود را به صورت Document ارسال کنید تا بارگذاری شود.', {});
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }
      // adm_toggle removed per request
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
        const txt = `📊 آمار:\nبه‌روزرسانی‌ها: ${fmtNum(stats.updates || 0)}\nفایل‌ها: ${fmtNum(stats.files || 0)}`;
        await tgAnswerCallbackQuery(env, cb.id);
        await tgEditMessage(env, chat_id, mid, txt, adminMenuKb(await getSettings(env)));
        return;
      }
      if (data === 'adm_join') {
        const s = await getSettings(env);
        const current = Array.isArray(s.join_channels) ? s.join_channels.join(', ') : '';
        await setUserState(env, uid, { step: 'adm_join_wait' });
        const txt = `📢 تنظیم جویین اجباری\nکانال‌های فعلی: ${current || '—'}\n\nلطفاً یک کانال یا لینک در هر پیام ارسال کنید.\nنمونه‌ها: @channel یا -100xxxxxxxxxx یا لینک کامل https://t.me/xxxx`;
        await tgEditMessage(env, chat_id, mid, txt, {});
        await tgAnswerCallbackQuery(env, cb.id);
        return;
      }
      if (data === 'adm_files') {
        const files = await listFiles(env, 10);
        let txt = '🗂 ۱۰ فایل اخیر:\n\n';
        for (const f of files) {
          txt += `• ${htmlEscape(f.file_name)} (${fmtNum(f.file_size)} بایت) — ${f.disabled ? 'غیرفعال' : 'فعال'}\n`;
        }
        await tgAnswerCallbackQuery(env, cb.id);
        await tgEditMessage(env, chat_id, mid, txt, adminMenuKb(await getSettings(env)));
        return;
      }
      if (data === 'adm_backup') {
        await tgAnswerCallbackQuery(env, cb.id, 'بکاپ صرفاً از داخل ربات نمایش داده می‌شود.');
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
        if (u && !u.referrer_id) {
          u.referrer_id = String(ref);
          await setUser(env, uid, u);
        }
      } catch {}
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
      }
    }
    // اگر /start <token> بود، فایل را پس از تایید عضویت ارسال کن
    if (startToken) {
      await deliverFileToUser(env, uid, chat_id, startToken);
      return;
    }
    const hdr = await mainMenuHeader(env);
    await tgSendMessage(env, chat_id, hdr, mainMenuKb(env, uid));
  } catch (e) { console.error('sendWelcome error', e); }
}

function extractReferrerFromStartParam(msg) {
  try {
    const text = msg.text || msg.caption || '';
    // /start REF
    const parts = text.trim().split(/\s+/);
    if (parts[0] === '/start' && parts[1] && /^\d+$/.test(parts[1])) return parts[1];
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

async function getSettings(env) {
  const s = (await kvGet(env, CONFIG.SERVICE_TOGGLE_KEY)) || {};
  if (typeof s.service_enabled === 'undefined') s.service_enabled = true;
  return s;
}
async function setSettings(env, s) { return kvSet(env, CONFIG.SERVICE_TOGGLE_KEY, s); }

async function bumpStat(env, key) {
  try {
    const stats = (await kvGet(env, CONFIG.BASE_STATS_KEY)) || {};
    stats[key] = (stats[key] || 0) + 1;
    await kvSet(env, CONFIG.BASE_STATS_KEY, stats);
  } catch (e) { console.error('bumpStat error', e); }
}
async function getStats(env) { return (await kvGet(env, CONFIG.BASE_STATS_KEY)) || {}; }

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

function ctxlessWait(promise) { try { promise && promise.catch(() => {}); } catch {} }

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

    // Root → redirect to /admin
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
    </div>
  </main>
</body>
</html>`;
}

// پیام‌ها را به تیکت تبدیل نمی‌کنیم؛ فقط راهنمایی ساده، ولی می‌توانید پیام‌های آزاد را ذخیره کنید.

// 11) Expose app via global (avoid ESM export for Wrangler)
globalThis.APP = { fetch: routerFetch };
