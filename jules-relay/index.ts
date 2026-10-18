interface RelayEnv { RELAY_TOKEN: string; JULES_API_KEY: string }
const json = (body: unknown, status: number) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const id = '[A-Za-z0-9_-]{1,128}';
function allowed(method: string, url: URL): boolean {
  const path = url.pathname;
  const query = [...url.searchParams.keys()];
  if (method === 'POST') return query.length === 0 && (path === '/v1alpha/sessions' || new RegExp(`^/v1alpha/sessions/${id}:(approvePlan|sendMessage)$`).test(path));
  if (method !== 'GET') return false;
  if (path === '/v1alpha/sources' || path === '/v1alpha/sessions' || new RegExp(`^/v1alpha/sessions/${id}/activities$`).test(path)) return query.every(k => ['pageSize', 'pageToken', 'filter'].includes(k));
  return query.length === 0 && (new RegExp(`^/v1alpha/sessions/${id}$`).test(path) || new RegExp(`^/v1alpha/sources/github/${id}/${id}$`).test(path));
}
async function authenticated(request: Request, secret: string): Promise<boolean> {
  if (!secret) return false;
  const token = request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';
  const hash = (v: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
  const [a, b] = await Promise.all([hash(token), hash(secret)]);
  let diff = 0; const aa = new Uint8Array(a), bb = new Uint8Array(b);
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}
export default {
  async fetch(request: Request, env: RelayEnv): Promise<Response> {
    if (!await authenticated(request, env.RELAY_TOKEN)) return json({ message: 'unauthorized' }, 401);
    const url = new URL(request.url);
    if (!allowed(request.method, url)) return json({ message: 'unsupported Jules operation' }, 400);
    if (!env.JULES_API_KEY) return json({ message: 'upstream unavailable' }, 503);
    let body: Uint8Array | undefined;
    if (request.method === 'POST') {
      if (Number(request.headers.get('Content-Length')) > 262144) return json({ message: 'request too large' }, 413);
      const reader = request.body?.getReader(); if (!reader) return json({ message: 'body required' }, 400);
      const parts: Uint8Array[] = []; let size = 0;
      try {
        while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 262144) { await reader.cancel(); return json({ message: 'request too large' }, 413); } parts.push(part.value); }
      } finally { reader.releaseLock(); }
      body = new Uint8Array(size); let offset = 0; for (const part of parts) { body.set(part, offset); offset += part.length; }
    }
    const headers = new Headers({ 'X-Goog-Api-Key': env.JULES_API_KEY, 'Content-Type': 'application/json' });
    const mask = request.headers.get('X-Goog-FieldMask'); if (mask && mask.length <= 4096) headers.set('X-Goog-FieldMask', mask);
    try {
      const upstream = await fetch('https://jules.googleapis.com' + url.pathname + url.search, { method: request.method, body, headers, redirect: 'manual', signal: AbortSignal.timeout(25000) });
      return new Response(upstream.body, { status: upstream.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    } catch (error) { return json({ message: 'Jules temporarily unavailable', category: error instanceof Error ? error.name : 'Error' }, 502); }
  }
};
