// Catch-all Pages Function to delegate to main.js (Worker-style)
// Ensure main.js runs once to set globalThis.APP
import '../main.js';

export async function onRequest(context) {
  const { request, env, waitUntil } = context;
  let app = globalThis.APP;
  if (!app || typeof app.fetch !== 'function') {
    // Fallback: dynamically import to ensure initialization in this worker
    await import('../main.js');
    app = globalThis.APP;
  }
  if (!app || typeof app.fetch !== 'function') {
    return new Response('Application not initialized', { status: 500 });
  }
  return app.fetch(request, env, { waitUntil });
}


