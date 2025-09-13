// Cloudflare Pages Function to handle Telegram webhook (POST only)
// Ensure main.js runs once to set globalThis.APP (Worker-style app)
import '../main.js';

export async function onRequestPost(context) {
  const { request, env, waitUntil } = context;
  let app = globalThis.APP;
  if (!app || typeof app.fetch !== 'function') {
    await import('../main.js');
    app = globalThis.APP;
  }
  if (!app || typeof app.fetch !== 'function') {
    return new Response('Application not initialized', { status: 500 });
  }
  return app.fetch(request, env, { waitUntil });
}


