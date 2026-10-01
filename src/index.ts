import { DurableObject } from "cloudflare:workers";
import { authenticatedUser, OFFICIAL_ACCOUNT_ID, OFFICIAL_APPLICATIONS, publicProfiles, readAvatar } from "./accounts";
export { Accounts } from "./accounts";

/** 清单类的键：整套清单和 vendor 的模块编号表。格式变了就换前缀（v3/…），旧版本的手机继续读旧前缀。 */
const JSON_KEY = /^v1\/(?:release|runtime|maps\/vendor\.json|applications\/[a-z][a-z0-9-]{0,63}\/(?:latest|releases\/[a-f0-9]{64}))$/;
const DYNAMIC_JSON_KEY = /^v1\/(?:release|maps\/vendor\.json|applications\/[a-z][a-z0-9-]{0,63}\/(?:latest|releases\/[a-f0-9]{64}))$/;
const PLUGIN_SOURCE = "sources/github/jiangfengwhu/zjh-plugin";
const allowedSource = (source?: string) => source === PLUGIN_SOURCE;

/** 包体的键：vendor、app、插件 DEX，全部按内容哈希命名，写入后不再改。 */
const BLOB_KEY = /^v1\/(?:vendor|app|sdk)\/[a-f0-9]{64}$|^v1\/plugins\/[a-z0-9-]+\/[a-f0-9]{64}$/;

const ACTIVITY_MASK =
  "activities.name,activities.id,activities.createTime,activities.description,activities.progressUpdated,activities.planGenerated,activities.planApproved,activities.sessionCompleted,activities.sessionFailed,activities.agentMessaged,activities.userMessaged,nextPageToken";

type CatalogObject = { key?: unknown; body?: unknown };

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (/^\/v1\/(auth\/(?:code|verify|logout)|account(?:\/avatar)?)$/.test(url.pathname)) return env.ACCOUNTS.getByName("accounts").fetch(request);
      if ((request.method === "GET" || request.method === "HEAD") && /^\/v1\/avatars\/[a-f0-9-]{36}\/[a-f0-9]{64}$/.test(url.pathname)) return readAvatar(request, env);
      if (request.method === "PUT" && url.pathname === "/v1/catalog") return env.WORKSHOP.getByName("dynamic").fetch(request);
      if (url.pathname === "/v1/market" || /^\/v1\/application-allocation\/[a-z][a-z0-9-]{0,63}$/.test(url.pathname)) return env.WORKSHOP.getByName("dynamic").fetch(request);
      if (request.method === "GET" && url.pathname === "/v1/applications") {
        const manifests: unknown[] = [];
        let cursor: string | undefined;
        do {
          const page = await env.CATALOG.list({ prefix: "v1/applications/", ...(cursor ? { cursor } : {}) });
          for (const key of page.keys) if (key.name.endsWith("/latest")) {
            const item = await env.CATALOG.get(key.name, "json");
            if (item) manifests.push(item);
          }
          cursor = page.list_complete ? undefined : page.cursor;
        } while (cursor);
        return json({ applications: manifests }, 200);
      }
      if (request.method === "POST" && url.pathname === "/v1/workshop") return env.WORKSHOP.getByName("dynamic").fetch(request);
      if (request.method === "POST" && url.pathname === "/v1/jules") {
        const operation = await request.clone().json() as { method?: string; path?: string };
        if (operation.path !== "/v1alpha/sources") return env.WORKSHOP.getByName("dynamic").fetch(request);
        if (!await authenticatedUser(request, env)) return json({ message: "请先登录后再创作" }, 401);
      }
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
    if (session.sourceContext?.source !== PLUGIN_SOURCE) return json({ error: "仅允许 zjh-plugin 仓库" }, 403);
  }
  const sessionMatch = /^\/v1alpha\/sessions\/([A-Za-z0-9_-]+)(?::(?:approvePlan|sendMessage)|\/activities)?(?:\?.*)?$/.exec(path);
  if (sessionMatch) {
    const existing = await fetch(`https://jules.googleapis.com/v1alpha/sessions/${sessionMatch[1]}`, { headers: { "X-Goog-Api-Key": env.JULES_API_KEY } });
    if (!existing.ok) return json({ error: "session access failed" }, existing.status);
    const session = await existing.json() as { sourceContext?: { source?: string } };
    if (!allowedSource(session.sourceContext?.source)) return json({ error: "会话仓库未授权" }, 403);
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
    return json({ sources: (result.sources ?? []).filter(source => source.name === PLUGIN_SOURCE), ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}) }, 200);
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
  if (/^\/v1alpha\/sessions\/[A-Za-z0-9_-]{1,128}$/.test(bare) && query.length === 0 && method === "GET") {
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
type ApplicationRelease = { appId: string; releaseId: string; title: string; summary: string; modules: { base: number }; source: { repository: string; commit: string; dirty: boolean } };
type Accepted = { releaseId: string; commit: string; mergeCommit: string; pr: number };
type WorkshopTask = { ownerId: string; appId: string; session: string; token: string; phase: "working" | "review" | "accepted" | "paused"; previousCommit?: string; repair?: boolean; accepted?: Accepted };
type CloudSession = { name?: string; state?: string; sourceContext?: { source?: string }; outputs?: { pullRequest?: { url?: string } }[] };
type MarketEntry = { manifest: ApplicationRelease; title: string; summary: string; authorId: string | null; authorName: string; authorAvatarUrl?: string | null; authorOfficial?: boolean; originalAppId: string | null };

export class Workshop extends DurableObject<Env> {
  private queue: Promise<unknown> = Promise.resolve();
  fetch(request: Request): Promise<Response> {
    const next = this.queue.then(() => this.handle(request)); this.queue = next.catch(() => {}); return next;
  }
  private async session(name: string): Promise<CloudSession> {
    if (!/^sessions\/[A-Za-z0-9_-]{1,128}$/.test(name)) throw new Error("Session 记录不完整");
    const response = await fetch(`https://jules.googleapis.com/v1alpha/${name}`, { headers: { "X-Goog-Api-Key": this.env.JULES_API_KEY } });
    if (!response.ok) throw new Error("暂时无法连接这个应用的 session");
    const session = await response.json() as CloudSession;
    if (session.sourceContext?.source !== PLUGIN_SOURCE) throw new Error("Session 仓库不匹配");
    return session;
  }
  private async allocate(appId: string): Promise<number> {
    const existing = await this.ctx.storage.get<number>(`allocation:${appId}`); if (existing) return existing;
    const fixed: Record<string, number> = { jolly: 2000000, notepad: 2100000, pomodoro: 2200000 };
    const prior = await this.env.CATALOG.get<ApplicationRelease>(`v1/applications/${appId}/latest`, "json");
    let base = fixed[appId] ?? prior?.modules.base;
    if (!base) {
      base = await this.ctx.storage.get<number>("allocation:next") ?? 2300000;
      while (await this.ctx.storage.get<string>(`application-range:${base}`)) base += 100000;
      if (base + 100000 >= 2 ** 31) throw new Error("应用模块范围已用尽");
      await this.ctx.storage.put("allocation:next", base + 100000);
    }
    const owner = await this.ctx.storage.get<string>(`application-range:${base}`);
    if (owner && owner !== appId) throw new Error("应用模块范围冲突");
    await this.ctx.storage.put(`application-range:${base}`, appId);
    await this.ctx.storage.put(`allocation:${appId}`, base); return base;
  }
  private async applicationRelease(number: number, appId: string): Promise<ApplicationRelease> {
    let touched = false;
    for (let page = 1; page <= 30; page++) {
      const files = await this.github(`pulls/${number}/files?per_page=100&page=${page}`) as Array<{ filename: string }>;
      for (const file of files) {
        if (file.filename.startsWith(`apps/${appId}/`)) touched = true;
        else if (file.filename !== "package-lock.json") throw new Error("这份 PR 修改了目标应用之外的文件，请拆分交付");
      }
      if (files.length < 100) break;
    }
    if (!touched) throw new Error("这份 PR 没有交付目标应用");
    const app = await this.env.CATALOG.get<ApplicationRelease>(`v1/applications/${appId}/latest`, "json");
    if (!app || app.source.repository !== "jiangfengwhu/zjh-plugin") throw new Error("这个应用还没有发布本轮作品");
    return app;
  }
  private async delivery(task: WorkshopTask, session: CloudSession) {
    const urls = session.outputs?.map(output => output.pullRequest?.url).filter((url): url is string => /^https:\/\/github\.com\/jiangfengwhu\/zjh-plugin\/pull\/[0-9]+$/.test(url ?? "")) ?? [];
    for (const url of urls.reverse()) {
      const number = Number(url.split("/").pop());
      const pr = await this.github(`pulls/${number}`);
      if (pr.head?.sha === task.previousCommit || (task.accepted && number === task.accepted.pr && task.phase !== "accepted")) continue;
      const application = await this.applicationRelease(number, task.appId);
      if (pr.base?.ref !== "main" || pr.head?.repo?.full_name !== "jiangfengwhu/zjh-plugin" || pr.draft || (!pr.merged && pr.state !== "open")) throw new Error("这份 PR 尚未准备好交付");
      if (application.source.dirty || application.source.commit !== pr.head.sha) return { ready: false, message: "等待从当前 PR 提交重新发包", application, pr, number, url };
      // Unrelated applications can merge first. Only this app and shared lock conflicts block delivery.
      if (!pr.merged) {
        const comparison = await this.github(`compare/${pr.head.sha}...main`);
        if ((comparison.files ?? []).some((file: { filename: string }) => file.filename.startsWith(`apps/${task.appId}/`)) || pr.mergeable === false) {
          task.repair = true; await this.ctx.storage.put(`task:${task.appId}`, task);
          return { ready: false, message: "底稿有冲突，请在这个 session 继续：同步 main，处理冲突后重新发包", application, pr, number, url };
        }
      }
      return { ready: true, application, pr, number, url, message: "" };
    }
    return undefined;
  }
  private async handle(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/v1/application-allocation/")) {
        const appId = path.split("/").pop()!;
        if (request.method === "POST") {
          if (!await authorized(request, this.env.PUBLISH_TOKEN)) return json({ error: "unauthorized" }, 401);
          return json({ appId, moduleBase: await this.allocate(appId) }, 200);
        }
        if (request.method !== "GET") return json({ error: "method" }, 405);
        const base = await this.ctx.storage.get<number>(`allocation:${appId}`);
        return base ? json({ appId, moduleBase: base }, 200) : json({ error: "请先在 Jolly 创建这个应用的心愿" }, 404);
      }
      if (path === "/v1/market" && request.method === "GET") {
        const entries = [...(await this.ctx.storage.list<MarketEntry>({ prefix: "shared:" })).values()];
        for (const appId of OFFICIAL_APPLICATIONS) if (!entries.some(entry => entry.manifest.appId === appId) && !await this.ctx.storage.get(`withdrawn:${appId}`)) {
          const manifest = await this.env.CATALOG.get<ApplicationRelease>(`v1/applications/${appId}/latest`, "json");
          if (manifest) entries.push({ manifest, title: manifest.title, summary: manifest.summary, authorId: OFFICIAL_ACCOUNT_ID, authorName: "紫金花官方", originalAppId: null });
        }
        // Local maintainer tools may publish directly through Wrangler KV instead of /v1/catalog.
        // Resolve both paths from the same trusted catalog; user workshop builds never auto-share.
        let cursor: string | undefined;
        do {
          const page = await this.env.CATALOG.list({ prefix: "v1/applications/", ...(cursor ? { cursor } : {}) });
          for (const key of page.keys) {
            const match = key.name.match(/^v1\/applications\/([a-z][a-z0-9-]{0,63})\/latest$/);
            if (!match || await this.ctx.storage.get(`withdrawn:${match[1]}`)) continue;
            const builtin = (OFFICIAL_APPLICATIONS as readonly string[]).includes(match[1]);
            if (!builtin && await this.ctx.storage.get(`task:${match[1]}`)) continue;
            const manifest = await this.env.CATALOG.get<ApplicationRelease & { originalAppId?: string }>(key.name, "json");
            if (!manifest) continue;
            const entry: MarketEntry = { manifest, title: manifest.title, summary: manifest.summary, authorId: OFFICIAL_ACCOUNT_ID, authorName: "紫金花官方", authorAvatarUrl: null, authorOfficial: true, originalAppId: manifest.originalAppId ?? null };
            const prior = entries.findIndex(item => item.manifest.appId === manifest.appId);
            if (prior >= 0) entries[prior] = entry; else entries.push(entry);
            const stored = await this.ctx.storage.get<MarketEntry>(`shared:${manifest.appId}`);
            if (stored?.authorId !== OFFICIAL_ACCOUNT_ID || stored.manifest.releaseId !== manifest.releaseId) await this.ctx.storage.put(`shared:${manifest.appId}`, entry);
          }
          cursor = page.list_complete ? undefined : page.cursor;
        } while (cursor);
        for (const entry of entries) {
          if ((OFFICIAL_APPLICATIONS as readonly string[]).includes(entry.manifest.appId)) { entry.authorId = OFFICIAL_ACCOUNT_ID; entry.authorName = "紫金花官方"; entry.authorAvatarUrl = null; }
          entry.authorOfficial = entry.authorId === OFFICIAL_ACCOUNT_ID;
        }
        // Public browsing never authenticates the visitor. Profile lookup is optional enrichment.
        try {
          const profiles = await publicProfiles([...new Set(entries.map(entry => entry.authorId).filter((id): id is string => Boolean(id)))], this.env);
          for (const entry of entries) { const profile = entry.authorId ? profiles.get(entry.authorId) : undefined; if (profile) { entry.authorName = profile.name; entry.authorAvatarUrl = profile.avatarUrl; } }
        } catch { /* Keep published snapshots available if the account service is unavailable. */ }
        return json({ applications: entries }, 200);
      }
      if (new URL(request.url).pathname === "/v1/catalog") {
        if (!await authorized(request, this.env.PUBLISH_TOKEN)) return json({ error: "unauthorized" }, 401);
        const text = await request.clone().text();
        if (text.length > 8_000_000) return json({ error: "catalog too large" }, 413);
        const { objects } = JSON.parse(text) as { objects?: CatalogObject[] };
        for (const item of objects ?? []) {
          if (typeof item.key !== "string" || typeof item.body !== "string") continue;
          const match = item.key.match(/^v1\/applications\/([a-z][a-z0-9-]{0,63})\/(latest|releases\/[a-f0-9]{64})$/);
          if (!match) continue;
          const manifest = JSON.parse(item.body) as { appId: string; releaseId: string; source: { dirty: boolean }; modules: { base: number; size: number } };
          const base = manifest.modules?.base;
          if (manifest.appId !== match[1] || manifest.source?.dirty !== false || !/^[a-f0-9]{64}$/.test(manifest.releaseId) || !Number.isSafeInteger(base) || base < 2000000 || base % 100000 || manifest.modules.size !== 100000) return json({ error: "application manifest invalid" }, 400);
          const document = JSON.parse(item.body);
          const { releaseId, ...content } = document;
          const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(content)));
          const identity = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
          if (identity !== releaseId || document.format !== 1 || !/^[a-f0-9]{40}$/.test(document.source.commit) || !document.requires?.engineAbi || !document.requires?.sdk) return json({ error: "application integrity invalid" }, 400);
          const fixedOwners: Record<number, string> = { 2000000: "jolly", 2100000: "notepad", 2200000: "pomodoro" };
          if (fixedOwners[base] && fixedOwners[base] !== manifest.appId) return json({ error: "application module range reserved" }, 409);
          const priorLatest = await this.env.CATALOG.get<{ modules: { base: number } }>(`v1/applications/${manifest.appId}/latest`, "json");
          if (priorLatest && priorLatest.modules.base !== base) return json({ error: "application module range cannot change" }, 409);
          const owner = await this.ctx.storage.get<string>(`application-range:${base}`);
          if (owner && owner !== manifest.appId) return json({ error: "application module range occupied" }, 409);
          await this.ctx.storage.put(`application-range:${base}`, manifest.appId);
          if (match[2] !== "latest") {
            if (!match[2].endsWith(manifest.releaseId)) return json({ error: "application release identity mismatch" }, 400);
            const prior = await this.env.CATALOG.get(item.key);
            if (prior && prior !== item.body) return json({ error: "application release is immutable" }, 409);
          }
        }
        const response = await putCatalog(request, this.env);
        if (!response.ok) return response;
        // Tool-published applications without a user workshop task belong to the official publisher.
        // Workshop builds keep their owner and remain private until that owner explicitly shares.
        for (const item of objects ?? []) {
          if (typeof item.key !== "string" || typeof item.body !== "string") continue;
          const match = item.key.match(/^v1\/applications\/([a-z][a-z0-9-]{0,63})\/latest$/);
          if (!match || await this.ctx.storage.get(`task:${match[1]}`)) continue;
          const manifest = JSON.parse(item.body) as ApplicationRelease & { originalAppId?: string };
          const entry: MarketEntry = { manifest, title: manifest.title, summary: manifest.summary, authorId: OFFICIAL_ACCOUNT_ID, authorName: "紫金花官方", authorAvatarUrl: null, authorOfficial: true, originalAppId: manifest.originalAppId ?? null };
          await this.ctx.storage.put(`shared:${manifest.appId}`, entry);
          await this.ctx.storage.delete(`withdrawn:${manifest.appId}`);
        }
        return response;
      }

      const input = await request.json() as { appId?: string; originalAppId?: string; action?: string; session?: string; token?: string; approvalToken?: string; method?: string; path?: string; body?: string; releaseId?: string; title?: string; summary?: string; applicationReleases?: Record<string, string> };
      const appId = input.appId;
      if (!appId || !/^[a-z][a-z0-9-]{0,63}$/.test(appId)) return json({ message: "请指定目标应用" }, 400);
      const user = await authenticatedUser(request, this.env);
      if (!user) return json({ message: "请先登录后再操作作品" }, 401);
      let task = await this.ctx.storage.get<WorkshopTask>(`task:${appId}`);
      if (task && task.ownerId !== user.id) return json({ message: "这个作品属于其他账号" }, 403);
      if (path === "/v1/jules" && input.method === "POST" && input.path === "/v1alpha/sessions") {
        if ((OFFICIAL_APPLICATIONS as readonly string[]).includes(appId)) return json({ message: "请基于这个应用创作新作品" }, 403);
        if (task && input.approvalToken !== task.token) return json({ message: "这个应用的 session 凭据不匹配" }, 403);
        if (task?.session) return json({ message: "这个应用已有 session，请继续它；新应用才创建新 session" }, 409);
        if (await this.env.CATALOG.get(`v1/applications/${appId}/latest`)) return json({ message: "应用 ID 已存在，请基于它创作新作品" }, 409);
        const moduleBase = await this.allocate(appId);
        const payload = JSON.parse(input.body ?? "{}");
        const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
        if (!prompt) return json({ message: "请描述想做什么" }, 400);
        const origin = input.originalAppId && /^[a-z][a-z0-9-]{0,63}$/.test(input.originalAppId) ? `基于原作 ${input.originalAppId}：复制其 src 和 assets 到新应用目录，保持新 appId 和平台 moduleBase，application.json 记录 originalAppId=${input.originalAppId}，不修改原作。` : "";
        payload.prompt = `目标应用：${appId}；只交付 apps/${appId}/。新建时执行 npm run init:application -- ${appId}，平台分配 moduleBase=${moduleBase}。既有应用就在该目录修改。${origin} 用户需求：\n${prompt}`;
        const response = await proxyJules(new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify({ ...input, body: JSON.stringify(payload) }) }), this.env);
        if (!response.ok) return response;
        const session = await response.json() as CloudSession;
        if (!session.name) return json({ message: "Jules 未返回 session" }, 502);
        task = { ...task, ownerId: user.id, appId, session: session.name, token: task?.token ?? crypto.randomUUID(), phase: "working", previousCommit: task?.accepted?.commit };
        await this.ctx.storage.put(`task:${appId}`, task);
        return json({ ...session, ownerId: user.id, approvalToken: task.token }, 200);
      }
      if (!task || (input.token ?? input.approvalToken) !== task.token) return json({ message: "这个应用的 session 凭据不匹配" }, 403);
      if (path === "/v1/market") {
        const shared = await this.ctx.storage.get<MarketEntry>(`shared:${appId}`) ?? null;
        if (shared && shared.authorId !== user.id) return json({ message: "只有作者可以管理这份分享" }, 403);
        const accepted = task.accepted;
        const application = accepted ? await this.env.CATALOG.get<ApplicationRelease>(`v1/applications/${appId}/releases/${accepted.releaseId}`, "json") : null;
        if (input.action === "status") return json({ shared, accepted: accepted ?? null, application }, 200);
        if (input.action === "withdraw") {
          await this.ctx.storage.delete(`shared:${appId}`);
          await this.ctx.storage.put(`withdrawn:${appId}`, true);
          return json({ shared: null, accepted: accepted ?? null, application }, 200);
        }
        if (input.action && !["share", "edit"].includes(input.action)) return json({ message: "分享操作无效" }, 400);
        if (input.action === "edit" && !shared) return json({ message: "这份作品尚未分享" }, 409);
        if (input.action !== "edit" && (!accepted || input.releaseId !== accepted.releaseId)) return json({ message: "只能分享已收下的版本，请刷新作品状态后重试" }, 409);
        const manifest = input.action === "edit" ? shared!.manifest : application;
        if (!manifest || (input.action !== "edit" && manifest.source.commit !== accepted!.commit)) return json({ message: "收下的版本尚未送到，请稍后重试" }, 409);
        const title = input.title?.trim() ?? shared?.title ?? manifest.title;
        const summary = input.summary?.trim() ?? shared?.summary ?? manifest.summary;
        if (!title || title.length > 60 || summary.length > 300) return json({ message: "名称不能为空且最多 60 字，介绍最多 300 字" }, 400);
        const entry: MarketEntry = { manifest, title, summary, authorId: user.id, authorName: user.name, authorAvatarUrl: user.avatarUrl, authorOfficial: user.id === OFFICIAL_ACCOUNT_ID, originalAppId: (manifest as ApplicationRelease & { originalAppId?: string }).originalAppId ?? null };
        await this.ctx.storage.put(`shared:${appId}`, entry);
        await this.ctx.storage.delete(`withdrawn:${appId}`);
        return json({ shared: entry, accepted: accepted ?? null, application }, 200);
      }
      if (path === "/v1/jules") {
        const name = input.path?.match(/^\/v1alpha\/(sessions\/[A-Za-z0-9_-]+)/)?.[1];
        if (name !== task.session) return json({ message: "Session 不属于这个应用" }, 403);
        if (input.method === "POST" && input.path?.endsWith(":sendMessage")) {
          const current = await this.session(task.session);
          if (!["COMPLETED", "PAUSED", "AWAITING_USER_FEEDBACK", "FAILED"].includes(current.state ?? "")) return json({ message: "这个应用正在制作，请等本轮完成" }, 409);
          if (current.state === "COMPLETED" && task.phase !== "accepted" && !task.repair) return json({ message: "请先加载并收下这轮作品，再修改这个应用" }, 409);
          const payload = JSON.parse(input.body ?? "{}");
          payload.prompt = `继续修改应用 ${appId}，只改 apps/${appId}/ 与所需根锁文件。已收下的 PR 不再续写：从 origin/main 同步后创建新的任务分支和 PR。修复交付冲突时同步 main 后重新发布当前 PR。用户需求：\n${payload.prompt ?? ""}`;
          const response = await proxyJules(new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify({ ...input, body: JSON.stringify(payload) }) }), this.env);
          if (response.ok) { task.previousCommit = task.phase === "accepted" ? task.accepted?.commit : task.previousCommit; task.phase = "working"; task.repair = false; await this.ctx.storage.put(`task:${appId}`, task); }
          return response;
        }
        return proxyJules(new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(input) }), this.env);
      }
      if (input.session !== task.session) return json({ message: "Session 不属于这个应用" }, 403);
      const session = await this.session(task.session);
      if (input.action === "stop") {
        if (session.state === "COMPLETED" && task.phase !== "accepted" && !task.repair) return json({ message: "请先收下这轮作品" }, 409);
        if (!["COMPLETED", "PAUSED", "FAILED"].includes(session.state ?? "")) {
          const response = await proxyJules(new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify({ method: "POST", path: `/v1alpha/${task.session}:sendMessage`, body: JSON.stringify({ prompt: "停止当前制作，不再修改、发布或创建 PR，等待我的下一条需求。" }) }) }), this.env);
          if (!response.ok) return response;
        }
        task.phase = "paused"; task.repair = true;
        const latest = await this.env.CATALOG.get<ApplicationRelease>(`v1/applications/${appId}/latest`, "json");
        task.previousCommit = latest?.source.commit ?? task.previousCommit;
        await this.ctx.storage.put(`task:${appId}`, task);
        return json({ stopped: true }, 200);
      }
      if (task.phase === "paused") return json({ completed: false, merged: false, state: "PAUSED", accepted: task.accepted, message: "已发送停止请求，可以继续这个应用" }, 200);
      if (task.phase === "accepted") return json({ completed: true, merged: true, state: session.state, accepted: task.accepted, application: await this.env.CATALOG.get<ApplicationRelease>(`v1/applications/${appId}/releases/${task.accepted!.releaseId}`, "json"), message: "这轮作品已收下，可继续修改同一个应用" }, 200);
      if (session.state !== "COMPLETED") return json({ completed: false, merged: false, state: session.state, delivery: "unpublished", message: "这轮作品仍在制作" }, 200);
      let delivery: Awaited<ReturnType<Workshop["delivery"]>>;
      try { delivery = await this.delivery(task, session); }
      catch (error) {
        task.repair = true; await this.ctx.storage.put(`task:${appId}`, task);
        return json({ completed: true, merged: false, state: session.state, delivery: "blocked", message: error instanceof Error ? error.message : "请在当前 session 修复交付后重新发包" }, input.action === "status" ? 200 : 409);
      }
      const ready = delivery?.ready === true;
      if (!ready) { task.repair = true; await this.ctx.storage.put(`task:${appId}`, task); }
      const loaded = ready && input.applicationReleases?.[appId] === delivery!.application.releaseId;
      if (input.action === "status") {
        task.phase = "review"; await this.ctx.storage.put(`task:${appId}`, task);
        return json({ completed: true, merged: false, state: session.state, delivery: !delivery ? "unpublished" : !ready ? "blocked" : loaded ? "loaded" : "update", message: !delivery ? "等待本轮新 PR 和发包" : !ready ? delivery.message : loaded ? "正在运行本轮作品，可以确认收下" : "先加载本轮作品，体验后收下", ...(delivery ? { application: delivery.application, prUrl: delivery.url } : {}) }, 200);
      }
      if (input.action !== "confirm" || !ready || !loaded) return json({ message: "先加载并体验本轮作品，准备好后再收下" }, 409);
      const latest = await this.env.CATALOG.get<ApplicationRelease>(`v1/applications/${appId}/latest`, "json");
      if (latest?.releaseId !== delivery!.application.releaseId) return json({ message: "有新版本送到，请重新加载" }, 409);
      const pr = delivery!.pr;
      let merged;
      try { merged = pr.merged ? { merged: true, sha: pr.merge_commit_sha } : await this.github(`pulls/${delivery!.number}/merge`, "PUT", { sha: pr.head.sha, merge_method: "merge" }); }
      catch (error) {
        task.repair = true; await this.ctx.storage.put(`task:${appId}`, task);
        return json({ message: "合入未完成，请在当前 session 同步 main、修复交付并重新发包" }, 409);
      }
      if (!merged.merged) return json({ message: "合入尚未完成，请重试" }, 409);
      task.phase = "accepted"; task.accepted = { releaseId: latest.releaseId, commit: latest.source.commit, mergeCommit: merged.sha, pr: delivery!.number };
      await this.ctx.storage.put(`task:${appId}`, task);
      return json({ merged: true, accepted: task.accepted }, 200);
    } catch (error) { return json({ message: error instanceof Error ? error.message : "工坊暂时不可用" }, 502); }
  }
  private async github(path: string, method = "GET", body?: unknown, repository = "jiangfengwhu/zjh-plugin"): Promise<any> {
    if (!this.env.GITHUB_MERGE_TOKEN) throw new Error("工坊的收下功能还未配置好，请联系维护者");
    const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.env.GITHUB_MERGE_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "zijinhua-workshop", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(response.status === 409 || response.status === 405 ? "这份心愿的代码有了变化，暂时不能收下，请联系维护者处理" : "暂时没能收下这份心愿，请稍后再试");
    return response.json();
  }


}
