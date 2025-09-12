// Catch-all Pages Function to delegate to main.js default export (Worker-style)
// This keeps your existing routes (/, /api/*, /f/*, etc.) working on Pages

import app from '../main.js';

export async function onRequest(context) {
  const { request, env, waitUntil } = context;
  if (!app || typeof app.fetch !== 'function') {
    return new Response('Application not initialized', { status: 500 });
  }
  try {
    return await app.fetch(request, env, { waitUntil });
  } catch (err) {
    const body = `Runtime error in app.fetch\n${(err && err.message) || String(err)}\n\n${err && err.stack ? err.stack : ''}`;
    return new Response(body, { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}


