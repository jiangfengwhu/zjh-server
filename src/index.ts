/** 清单类的键：整套清单和 vendor 的模块编号表。格式变了就换前缀（v3/…），旧版本的手机继续读旧前缀。 */
const JSON_KEY = /^v1\/(?:release|runtime|maps\/vendor\.json)$/;
const DYNAMIC_JSON_KEY = /^v1\/(?:release|maps\/vendor\.json)$/;
const DYNAMIC_SOURCE = "sources/github/jiangfengwhu/zjh-dynamic";

/** 包体的键：vendor、app、插件 DEX，全部按内容哈希命名，写入后不再改。 */
const BLOB_KEY = /^v1\/(?:vendor|app|sdk)\/[a-f0-9]{64}$|^v1\/plugins\/[a-z0-9-]+\/[a-f0-9]{64}$/;

const ACTIVITY_MASK =
  "activities.name,activities.id,activities.createTime,activities.description,activities.progressUpdated,activities.planGenerated,activities.planApproved,activities.sessionCompleted,activities.sessionFailed,activities.agentMessaged,activities.userMessaged,nextPageToken";

type CatalogObject = { key?: unknown; body?: unknown };

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "PUT" && url.pathname === "/v1/catalog") return putCatalog(request, env);
      if (request.method === "POST" && url.pathname === "/v1/jules") return proxyJules(request, env);
      if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "not found" }, 404);
      const key = url.pathname.replace(/^\/+/, "");
      if (JSON_KEY.test(key)) return readCatalog(request, env, key);
      if (BLOB_KEY.test(key)) return readBlob(request, env, key);
      return json({ error: "not found" }, 404);
    } catch (error) {
      console.log(JSON.stringify({ event: "edge error", message: error instanceof Error ? error.message : "unknown" }));
      return json({ error: "edge failed" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function readCatalog(request: Request, env: Env, key: string): Promise<Response> {
  const body = await env.CATALOG.get(key);
  if (body === null) {
    console.log(JSON.stringify({ event: "catalog miss", key }));
    return json({ error: key === "v1/release" ? "还没有配套清单" : "not found" }, 404);
  }
  console.log(JSON.stringify({ event: "catalog", key, bytes: body.length }));
  return new Response(request.method === "HEAD" ? null : body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
}

async function readBlob(request: Request, env: Env, key: string): Promise<Response> {
  const object = await env.BLOBS.get(key);
  if (!object) {
    console.log(JSON.stringify({ event: "blob miss", key }));
    return json({ error: "包版本不存在" }, 404);
  }
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-type", "application/octet-stream");
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("etag", object.httpEtag);
  console.log(JSON.stringify({ event: "blob", key, bytes: object.size }));
  return new Response(request.method === "HEAD" ? null : object.body, { status: 200, headers });
}

async function putCatalog(request: Request, env: Env): Promise<Response> {
  if (!(await authorized(request, env.PUBLISH_TOKEN))) return json({ error: "unauthorized" }, 401);
  const text = await request.text();
  if (text.length > 8_000_000) return json({ error: "catalog too large" }, 413);
  let objects: CatalogObject[];
  try {
    const parsed = JSON.parse(text) as { objects?: CatalogObject[] };
    objects = Array.isArray(parsed.objects) ? parsed.objects : [];
  } catch {
    return json({ error: "catalog json" }, 400);
  }
  const entries: { key: string; body: string }[] = [];
  for (const item of objects) {
    if (typeof item.key !== "string" || !DYNAMIC_JSON_KEY.test(item.key) || typeof item.body !== "string") {
      return json({ error: "catalog key" }, 400);
    }
    if (item.body.length > 8_000_000) return json({ error: "catalog object too large" }, 413);
    entries.push({ key: item.key, body: item.body });
  }
  const release = entries.filter((item) => item.key === "v1/release");
  const rest = entries.filter((item) => item.key !== "v1/release");
  for (const item of [...rest, ...release]) {
    await env.CATALOG.put(item.key, item.body);
    console.log(JSON.stringify({ event: "catalog put", key: item.key, bytes: item.body.length }));
  }
  return json({ ok: true, written: entries.length }, 200);
}

async function proxyJules(request: Request, env: Env): Promise<Response> {
  if (!env.JULES_API_KEY) return json({ error: "jules key missing" }, 500);
  const text = await request.text();
  if (text.length > 200_000) return json({ error: "jules body" }, 413);
  let method = "";
  let path = "";
  let body = "";
  try {
    const parsed = JSON.parse(text) as { method?: unknown; path?: unknown; body?: unknown };
    method = typeof parsed.method === "string" ? parsed.method.toUpperCase() : "";
    path = typeof parsed.path === "string" ? parsed.path : "";
    body = typeof parsed.body === "string" ? parsed.body : "";
  } catch {
    return json({ error: "jules json" }, 400);
  }
  if (!julesPathAllowed(method, path)) return json({ error: "jules path" }, 400);
  if (body.length > 200_000) return json({ error: "jules body" }, 413);
  if (method === "POST" && path === "/v1alpha/sessions") {
    let session: { sourceContext?: { source?: string } };
    try { session = JSON.parse(body); } catch { return json({ error: "session json" }, 400); }
    if (session.sourceContext?.source !== DYNAMIC_SOURCE) return json({ error: "仅允许 zjh-dynamic 仓库" }, 403);
  }
  const sessionMatch = /^\/v1alpha\/sessions\/([A-Za-z0-9_-]+)(?::(?:approvePlan|sendMessage)|\/activities)?(?:\?.*)?$/.exec(path);
  if (sessionMatch) {
    const existing = await fetch(`https://jules.googleapis.com/v1alpha/sessions/${sessionMatch[1]}`, { headers: { "X-Goog-Api-Key": env.JULES_API_KEY } });
    if (!existing.ok) return json({ error: "session access failed" }, existing.status);
    const session = await existing.json() as { sourceContext?: { source?: string } };
    if (session.sourceContext?.source !== DYNAMIC_SOURCE) return json({ error: "仅允许 zjh-dynamic 会话" }, 403);
  }
  const headers = new Headers();
  headers.set("X-Goog-Api-Key", env.JULES_API_KEY);
  headers.set("Accept", "application/json");
  if (pathBeforeQuery(path).endsWith("/activities")) headers.set("X-Goog-FieldMask", ACTIVITY_MASK);
  if (method !== "GET" && method !== "DELETE" && body.length > 0) headers.set("Content-Type", "application/json");
  const upstreamPath = method === "GET" && pathBeforeQuery(path) === "/v1alpha/sources" ? "/v1alpha/sources?pageSize=100" : path;
  const upstream = await fetch(`https://jules.googleapis.com${upstreamPath}`, {
    method,
    headers,
    body: method === "GET" || method === "DELETE" || body.length === 0 ? undefined : body,
  });
  if (method === "GET" && pathBeforeQuery(path) === "/v1alpha/sources" && upstream.ok) {
    const result = await upstream.json() as { sources?: Array<{ name?: string }>; nextPageToken?: string };
    return json({ sources: (result.sources ?? []).filter(source => source.name === DYNAMIC_SOURCE), ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}) }, 200);
  }
  console.log(JSON.stringify({ event: "jules", method, path: pathBeforeQuery(path), status: upstream.status }));
  const responseHeaders = new Headers();
  responseHeaders.set("content-type", upstream.headers.get("content-type") ?? "application/json");
  responseHeaders.set("cache-control", "no-store");
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

function julesPathAllowed(method: string, path: string): boolean {
  if (!path.startsWith("/v1alpha/") || path.includes("..") || path.includes("\\") || path.includes("@")) return false;
  const bare = pathBeforeQuery(path);
  const query = path.includes("?") ? path.slice(path.indexOf("?") + 1) : "";
  if (method === "GET" && /^\/v1alpha\/sessions\/[A-Za-z0-9_-]{1,128}\/activities$/.test(bare)) {
    return /^pageSize=[1-9][0-9]{0,2}(?:&pageToken=[A-Za-z0-9._~%-]{1,800})?$/.test(query);
  }
  if (query.length > 0 && !/^pageSize=[1-9][0-9]{0,2}$/.test(query)) return false;
  if (method === "GET" && bare === "/v1alpha/sources") return true;
  if (method === "POST" && bare === "/v1alpha/sessions" && query.length === 0) return true;
  if (/^\/v1alpha\/sessions\/[A-Za-z0-9_-]{1,128}$/.test(bare) && query.length === 0 && (method === "GET" || method === "DELETE")) {
    return true;
  }
  return /^\/v1alpha\/sessions\/[A-Za-z0-9_-]{1,128}:(approvePlan|sendMessage)$/.test(bare) && query.length === 0 && method === "POST";
}

async function authorized(request: Request, secret: string): Promise<boolean> {
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const actual = new TextEncoder().encode(header);
  const expected = new TextEncoder().encode(`Bearer ${secret}`);
  return timingSafeEqual(actual, expected);
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let diff = 0;
  for (let index = 0; index < left.byteLength; index += 1) diff |= left[index] ^ right[index];
  return diff === 0;
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function pathBeforeQuery(path: string): string {
  const index = path.indexOf("?");
  return index < 0 ? path : path.slice(0, index);
}
