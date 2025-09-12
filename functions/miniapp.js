// Cloudflare Pages Function to serve the public MiniApp page at /miniapp
// Self-contained: reads KV directly and renders Top Referrers without importing main.js

async function kvGetJson(env, key) {
  try {
    const v = await env.BOT_KV.get(key);
    return v ? JSON.parse(v) : null;
  } catch (_) { return null; }
}

export async function onRequestGet({ env }) {
  try {
    const users = (await kvGetJson(env, 'index:users')) || [];
    const list = [];
    for (const uid of users) {
      const u = (await kvGetJson(env, `user:${uid}`)) || {};
      list.push({
        name: (u.first_name || u.username || '').trim() || 'کاربر',
        referrals: Number(u.referrals || 0)
      });
    }
    const top = list.sort((a,b)=> (b.referrals||0)-(a.referrals||0)).slice(0,5);

    const html = `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Top Referrers</title>
  <style>
    body{margin:0;font-family:Segoe UI,Tahoma,Arial;background:#0b1220;color:#e5e7eb;display:grid;place-items:center;min-height:100vh}
    .card{width:min(720px,92vw);background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.15);border-radius:16px;overflow:hidden;box-shadow:0 10px 30px rgba(0,0,0,.25)}
    .head{display:flex;justify-content:space-between;align-items:center;padding:16px 18px;border-bottom:1px solid rgba(255,255,255,.12)}
    .list{padding:8px 0}
    .row{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.06)}
    .row:last-child{border-bottom:none}
    .idx{width:32px;height:32px;border-radius:10px;display:grid;place-items:center;background:linear-gradient(135deg,#3b82f6,#1d4ed8);font-weight:700}
    .name{font-weight:600}
    .subs{margin-inline-start:auto;opacity:.8}
  </style>
  <meta name="color-scheme" content="dark" />
  <meta name="theme-color" content="#0b1220" />
  </head>
  <body>
    <div class="card">
      <div class="head"><div>🏷 معرفین برتر</div><div>Top Referrers</div></div>
      <div class="list">
        ${top.map((u,i)=>`
          <div class="row"><div class="idx">${i+1}</div><div class="name">${u.name}</div><div class="subs">${(u.referrals||0).toLocaleString('fa-IR')} معرفی</div></div>
        `).join('') || '<div class="row"><div class="name">— داده‌ای یافت نشد —</div></div>'}
      </div>
    </div>
  </body>
  </html>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' } });
  } catch (err) {
    return new Response('MiniApp error', { status: 500 });
  }
}
