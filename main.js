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
  PURCHASE_PREFIX: 'purchase:',
  // پرداخت و پلن‌ها (می‌توانید از طریق تنظیمات نیز override کنید)
  PLANS: [
    { id: 'p1', coins: 10, price_label: '۵۰٬۰۰۰ تومان' },
    { id: 'p2', coins: 25, price_label: '۱۲۰٬۰۰۰ تومان' },
    { id: 'p3', coins: 50, price_label: '۲۳۰٬۰۰۰ تومان' },
  ],
  CARD_INFO: {
    card_number: '6219 8619 4308 4037',
    holder_name: 'امیرحسین سیاهبالائی',
    pay_note: 'لطفاً پس از پرداخت، رسید را ارسال کنید.'
  },
};

// صفحات فانکشنز env: { BOT_KV }

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
    const meta = await kvGet(env, CONFIG.FILE_PREFIX + token);
    if (!meta || meta.disabled) {
      await tgSendMessage(env, chat_id, 'فایل یافت نشد یا غیرفعال است.');
      return false;
    }
    const users = Array.isArray(meta.users) ? meta.users : [];
    const paidUsers = Array.isArray(meta.paid_users) ? meta.paid_users : [];
    const maxUsers = Number(meta.max_users || 0);
    const price = Number(meta.price || 0);
    const isOwner = String(meta.owner_id) === String(uid);
    const already = users.includes(String(uid));
    const alreadyPaid = paidUsers.includes(String(uid));
    if (!already && maxUsers > 0 && users.length >= maxUsers) {
      await tgSendMessage(env, chat_id, 'ظرفیت دریافت این فایل تکمیل شده است.');
      return false;
    }
    // در صورت قیمت‌دار بودن، فقط اگر قبلاً پرداخت نشده کسر کن
    if (price > 0 && !isOwner && !alreadyPaid) {
      const u = await getUser(env, String(uid));
      if (!u || Number(u.balance || 0) < price) {
        await tgSendMessage(env, chat_id, 'موجودی شما برای دریافت فایل کافی نیست.');
        return false;
      }
      u.balance = Number(u.balance || 0) - price;
      await setUser(env, String(uid), u);
      paidUsers.push(String(uid));
      meta.paid_users = paidUsers;
      await kvSet(env, CONFIG.FILE_PREFIX + token, meta);
    }
    if (!already) {
      users.push(String(uid));
      meta.users = users;
      await kvSet(env, CONFIG.FILE_PREFIX + token, meta);
    }
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
  // وضعیت سفارش
  if (p.status && p.status !== 'pending') {
    const st = p.status === 'approved' ? '✅ تایید شد' : '❌ رد شد';
    lines.push(st);
    if (p.reason && p.status === 'rejected') lines.push(`دلیل: ${p.reason}`);
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
    const t = String(token || '').trim();
    if (!/^[A-Za-z0-9]{6}$/.test(t)) {
      await tgSendMessage(env, chat_id, 'توکن نامعتبر است. یک توکن ۶ کاراکتری ارسال کنید.');
      return;
    }
    const meta = await kvGet(env, CONFIG.FILE_PREFIX + t);
    if (!meta || meta.disabled) { await tgSendMessage(env, chat_id, 'فایل یافت نشد یا غیرفعال است.'); return; }
    const users = Array.isArray(meta.users) ? meta.users : [];
    const paidUsers = Array.isArray(meta.paid_users) ? meta.paid_users : [];
    const isOwner = String(meta.owner_id) === String(uid);
    const price = Number(meta.price || 0);
    const already = users.includes(String(uid));
    const alreadyPaid = paidUsers.includes(String(uid));
    // اگر قیمت‌دار است و هنوز پرداخت نشده (حتی اگر قبلاً در users ثبت شده)، تایید بگیر
    if (price > 0 && !isOwner && !alreadyPaid) {
      const kbBuy = kb([[{ text: `✅ تایید (کسر ${fmtNum(price)} ${CONFIG.DEFAULT_CURRENCY})`, callback_data: 'confirm_buy:' + t }], [{ text: '❌ انصراف', callback_data: 'cancel_buy' }]]);
      await tgSendMessage(env, chat_id, `این فایل برای دریافت به <b>${fmtNum(price)}</b> ${CONFIG.DEFAULT_CURRENCY} نیاز دارد. آیا مایل به ادامه هستید؟`, kbBuy);
      return;
    }
    const ok = await deliverFileToUser(env, uid, chat_id, t);
    if (ok) { await clearUserState(env, uid); }
  } catch (e) {
    console.error('handleTokenRedeem error', e);
  }
}

// ------------------ Get bot version (for display in main menu) ------------------ //
async function getBotVersion(env) {
  try {
    const s = await getSettings(env);
    return s?.bot_version || '2.0';
  } catch { return '2.0'; }
}

// ------------------ Build main menu header text ------------------ //
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
      // Hide channel usernames in label; link goes to channel URL
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
    // Accept both array and comma-separated string configs
    let channels = [];
    if (Array.isArray(s?.join_channels)) {
      channels = s.join_channels.map(x => String(x || '').trim()).filter(Boolean);
    } else if (s?.join_channels) {
      channels = String(s.join_channels).split(',').map(x => x.trim()).filter(Boolean);
    }
    if (!channels.length) return true; // No mandatory channels configured

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
            await tgSendMessage(env, chat_id, '📣 برای استفاده از ربات ابتدا عضو کانال‌های زیر شوید سپس دکمه «بررسی عضویت» را بزنید:', await buildJoinKb(env));
          }
          return false;
        }
      } catch (e) {
        // On temporary Telegram errors, avoid blocking; optionally show guide
        if (!silent) {
          await tgSendMessage(env, chat_id, '📣 برای استفاده از ربات ابتدا عضو کانال‌های زیر شوید سپس دکمه «بررسی عضویت» را بزنید:', await buildJoinKb(env));
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
    { label: '🔑 وارد کردن توکن فایل', data: 'redeem_token' },
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
    // Row 7: Help + Broadcast in same row
    [ { text: '📘 راهنما', callback_data: 'help' }, { text: '📢 پیام همگانی', callback_data: 'adm_broadcast' } ],
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

// Handle incoming webhook requests from Telegram
async function handleWebhook(request, env, ctx) {
  // Only accept POST requests from Telegram
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
      const paidUsers = Array.isArray(meta.paid_users) ? meta.paid_users : [];
      const maxUsers = Number(meta.max_users || 0);
      const price = Number(meta.price || 0);
      const isOwner = String(meta.owner_id) === String(uid);
      const already = users.includes(String(uid));
      const alreadyPaid = paidUsers.includes(String(uid));
      if (!already && maxUsers > 0 && users.length >= maxUsers) {
        return new Response('ظرفیت دریافت این فایل تکمیل شده است.', { status: 403 });
      }
      if (price > 0 && !isOwner && !alreadyPaid) {
        const u = await getUser(env, String(uid));
        if (!u || Number(u.balance || 0) < price) {
          return new Response('موجودی شما برای دریافت فایل کافی نیست.', { status: 402 });
        }
        // کسر سکه و ثبت کاربر
        u.balance = Number(u.balance || 0) - price;
        await setUser(env, String(uid), u);
        paidUsers.push(String(uid));
        meta.paid_users = paidUsers;
        await kvSet(env, CONFIG.FILE_PREFIX + token, meta);
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

    // If update mode is on, block non-admin users globally
    try {
      const s = await getSettings(env);
      if (s?.update_mode === true && !isAdminUser(env, uid)) {
        await tgSendMessage(env, chat_id, '🛠️ ربات در حال بروزرسانی است. لطفاً بعداً تلاش کنید.');
        return;
      }
    } catch {}

    // Mandatory join check
    const joined = await ensureJoinedChannels(env, uid, chat_id);
    if (!joined) return; // A join prompt has been shown

    // دستورات متنی
    const text = msg.text || msg.caption || '';
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
          const mid = res?.result?.message_id; if (mid) p.admin_msgs.push({ chat_id: String(aid), message_id: mid });
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
          const mid = res?.result?.message_id; if (mid) p.admin_msgs.push({ chat_id: String(aid), message_id: mid });
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
        await tgSendMessage(env, chat_id, 'سرویس موقتاً غیرفعال است. لطفاً بعداً تلاش کنید.');
        return;
      }
      
      // اگر ادمین در فلو آپلود است (پشتیبانی از فایل‌های مختلف)
      const st = await getUserState(env, uid);
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
        const ttype = state?.type || 'general';
        await createTicket(env, uid, content, ttype);
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
          kind: tmp.kind || 'document',
          file_id: tmp.file_id,
          file_name: tmp.file_name,
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
          const maxUsers = Number((text || '').replace(/[^0-9]/g, ''));
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

    // Mandatory join check (اجازه بده تایید/لغو خرید بدون بررسی مجدد انجام شود)
    const joined = await ensureJoinedChannels(env, uid, chat_id);
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

    if (data === 'giftcode') {
      await setUserState(env, uid, { step: 'giftcode_wait' });
      await tgSendMessage(env, chat_id, '🎁 لطفاً کد هدیه را ارسال کنید. /update برای لغو');
      await tgAnswerCallbackQuery(env, cb.id);
      return;
    }

    // تایید یا لغو دریافت فایل با کسر سکه
    if (data.startsWith('confirm_buy:')) {
      const token = (data.split(':')[1] || '').trim();
      if (!/^[A-Za-z0-9]{6}$/.test(token)) { await tgAnswerCallbackQuery(env, cb.id, 'توکن نامعتبر'); return; }
      // تحویل فایل (کسر سکه داخل deliverFileToUser انجام می‌شود)
      const ok = await deliverFileToUser(env, uid, chat_id, token);
      if (ok) {
        try { await tgEditReplyMarkup(env, chat_id, mid, { inline_keyboard: [] }); } catch {}
        await tgAnswerCallbackQuery(env, cb.id, 'ارسال فایل');
        await clearUserState(env, uid);
      } else {
        await tgAnswerCallbackQuery(env, cb.id, 'ناموفق');
      }
      return;
    }
    if (data === 'cancel_buy') {
      try { await tgEditReplyMarkup(env, chat_id, mid, { inline_keyboard: [] }); } catch {}
      await tgSendMessage(env, chat_id, 'عملیات لغو شد.');
      await tgAnswerCallbackQuery(env, cb.id, 'لغو شد');
      return;
    }

    if (data === 'redeem_token') {
      await setUserState(env, uid, { step: 'redeem_token_wait' });
      await tgEditMessage(env, chat_id, mid, '🔑 لطفاً توکن دریافتی را ارسال کنید. /update برای لغو', {});
      await tgAnswerCallbackQuery(env, cb.id);
      return;
    }

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
      const card = CONFIG.CARD_INFO;
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
      if (data === 'adm_service') {
        const s = await getSettings(env);
        const enabled = s?.service_enabled !== false;
        const disabledCount = Array.isArray(s.disabled_buttons) ? s.disabled_buttons.length : 0;
        const btns = [
          [{ text: ` مدیریت دکمه‌های غیرفعال (${disabledCount})`, callback_data: 'adm_buttons' }],
          [{ text: ' بازگشت', callback_data: 'admin' }],
        ];
        const txt = ` تنظیمات سرویس\nوضعیت سرویس: ${enabled ? 'فعال' : 'غیرفعال'}\nتعداد دکمه‌های غیرفعال: ${disabledCount}`;
        const kbSrv = kb(btns);
        await tgEditMessage(env, chat_id, mid, txt, kbSrv);
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
          try { await tgSendMessage(env, String(p.user_id), `❤️ ${fmtNum(p.coins)} ${CONFIG.DEFAULT_CURRENCY} به حساب شما افزوده شد. سپاس از پرداخت شما.`); } catch {}
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
        const txt = ` آمار ربات\nکاربران: ${users}\nفایل‌ها: ${files}\nبه‌روزرسانی‌ها: ${updates}`;
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
        const current = Array.isArray(s.join_channels) ? s.join_channels.join(', ') : '';
        await setUserState(env, uid, { step: 'adm_join_wait' });
        const txt = ` تنظیم جویین اجباری\nکانال‌های فعلی: ${current || '—'}\n\nلطفاً یک کانال یا لینک در هر پیام ارسال کنید.\nنمونه‌ها: @channel یا -100xxxxxxxxxx یا لینک کامل https://t.me/xxxx`;
        await tgEditMessage(env, chat_id, mid, txt, {});
        await tgAnswerCallbackQuery(env, cb.id);
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
          ' راهنمای دستورات',
          '',
          'دستورات عمومی:',
          '/start — شروع و نمایش منوی اصلی',
          '/update — بروزرسانی منو و لغو فرآیندهای در حال انجام',
          '',
          'از منوی ربات:',
          '👤 حساب کاربری — مشاهده آیدی، نام و موجودی',
          '👥 معرفی دوستان — دریافت لینک دعوت و مشاهده تعداد معرفی‌ها',
          '🎁 کد هدیه — ثبت کد هدیه و افزایش موجودی',
          '🔑 دریافت با توکن — واردکردن توکن ۶ کاراکتری برای دریافت فایل',
          '🪙 خرید سکه — انتخاب پلن، مشاهده اطلاعات پرداخت و ارسال رسید',
          '',
          'ارسال فایل (Document) — ذخیره فایل و دریافت لینک (برای مدیران در بخش آپلود پیشرفته قابل قیمت‌گذاری/محدودسازی است)',
        ];
        await tgEditMessage(env, chat_id, mid, lines.join('\n'), kb([[{ text: '🔙 بازگشت', callback_data: 'back_main' }]]));
        await tgAnswerCallbackQuery(env, cb.id);
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

async function getSettings(env) {
  const s = (await kvGet(env, CONFIG.SERVICE_TOGGLE_KEY)) || {};
  if (typeof s.service_enabled === 'undefined') s.service_enabled = true;
  // granular disabled buttons list
  if (!Array.isArray(s.disabled_buttons)) s.disabled_buttons = [];
  if (!s.disabled_message) s.disabled_message = '🔧 این دکمه موقتاً غیرفعال است.';
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
// 11) Expose app via global (avoid ESM export for Wrangler)
globalThis.APP = { fetch: routerFetch };
