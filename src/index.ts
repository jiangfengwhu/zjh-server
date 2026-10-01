import { DurableObject } from "cloudflare:workers";
import { authenticatedUser, OFFICIAL_ACCOUNT_ID, OFFICIAL_APPLICATIONS, publicProfiles, readAvatar } from "./accounts";
import { KeyedQueue } from "./concurrency";
import { issuePublisherGrant, readPublisherGrant, redactPublisherGrants } from "./publisher";
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
      if (request.method === "PUT" && /^\/v1\/application-blobs\/[a-z][a-z0-9-]{0,63}\/[a-f0-9]{64}$/.test(url.pathname)) return env.WORKSHOP.getByName("dynamic").fetch(request);
      if (/^\/v1\/applications\/[a-z][a-z0-9-]{0,63}\/(?:latest|candidate|public|releases\/[a-f0-9]{64})$/.test(url.pathname) || ["/v1/official-release", "/v1/development-reset", "/v1/works", "/v1/market"].includes(url.pathname) || /^\/v1\/application-allocation\/[a-z][a-z0-9-]{0,63}$/.test(url.pathname)) return env.WORKSHOP.getByName("dynamic").fetch(request);
      if (request.method === "GET" && url.pathname === "/v1/applications") return env.WORKSHOP.getByName("dynamic").fetch(request);
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
  if (!await readPublisherGrant(request, env.OFFICIAL_PUBLISH_TOKEN) && !await authorized(request, env.OFFICIAL_PUBLISH_TOKEN)) return json({ error: "unauthorized" }, 401);
  const maintainer = await authorized(request, env.OFFICIAL_PUBLISH_TOKEN);
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
    if (!maintainer && !/^v1\/applications\/[a-z][a-z0-9-]{0,63}\/(?:latest|releases\/[a-f0-9]{64})$/.test(item.key)) return json({ error: "application publisher cannot modify host catalog" }, 403);
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
  return new Response(redactPublisherGrants(await upstream.text()), { status: upstream.status, headers: responseHeaders });
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
type ApplicationRelease = { appId: string; releaseId: string; title: string; summary: string; modules: { base: number }; source: { repository: string; commit: string; tree?: string; dirty: boolean } };
type WorkshopTask = { branch?: string; branchCommit?: string; roundRelease?: string; dispatchVersion?: string; originalBranch?: string; ownerId: string; appId: string; session: string; token: string; phase: "working" | "ready" | "paused"; previousCommit?: string; repair?: boolean; publishEpoch?: string; requestId?: string; creationTitle?: string; creationRejected?: boolean; title?: string; wish?: string; originalAppId?: string; originalReleaseId?: string; originalCommit?: string; startedAt?: number };
type CloudSession = { name?: string; state?: string; updateTime?: string; sourceContext?: { source?: string }; outputs?: { pullRequest?: { url?: string } }[] };
type MarketEntry = { manifest: ApplicationRelease; title: string; summary: string; authorId: string | null; authorName: string; authorAvatarUrl?: string | null; authorOfficial?: boolean; originalAppId: string | null; sourceCommit?: string; sourceBranch?: string };

export class Workshop extends DurableObject<Env> {
  private queue = new KeyedQueue();
  private resetting = false;
  private writes = new Set<Promise<Response>>();
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/v1/development-reset") return this.reset(request);
    if (this.resetting) return json({ message: "开发数据正在重置，请稍后重试" }, 503);
    const path = new URL(request.url).pathname;
    const pending = ["GET", "HEAD"].includes(request.method) ? this.handle(request) : this.write(request, path); this.writes.add(pending);
    try { return await pending; } finally { this.writes.delete(pending); }
  }
  private async reset(request: Request): Promise<Response> {
    if (request.method !== "POST" || !await authorized(request, this.env.OFFICIAL_PUBLISH_TOKEN)) return json({ error: "unauthorized" }, 403);
    const input = await request.json() as { confirm?: string };
    if (input.confirm !== "RESET_WORKSHOP_DEVELOPMENT_DATA") return json({ message: "需要明确的开发清库指令" }, 400);
    if (this.resetting) return json({ message: "重置已在进行" }, 409);
    this.resetting = true;
    try {
      await Promise.allSettled([...this.writes]);
      // Keep only the current official Jolly release and infrastructure catalogs.
      const jolly = await this.ctx.storage.get<MarketEntry>("shared:jolly");
      if (!jolly) return json({ message: "请先发布官方 Jolly，再清理测试数据" }, 409);
      const accountReset = await this.env.ACCOUNTS.getByName("accounts").fetch(new Request("https://account.internal/internal/development-reset", { method: "POST" }));
      if (!accountReset.ok) return json({ message: "账户清理未完成，请重试" }, 503);
      let cursor: string | undefined; let count = 0;
      const releaseKey = `v1/applications/jolly/releases/${jolly.manifest.releaseId}`;
      do {
        const page = await this.env.CATALOG.list({ prefix: "v1/applications/", cursor });
        for (const key of page.keys) {
          if (key.name === releaseKey) continue;
          await this.env.CATALOG.delete(key.name); count++;
        }
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      await this.env.CATALOG.put(releaseKey, JSON.stringify(jolly.manifest));
      await this.env.CATALOG.put("v1/applications/jolly/latest", JSON.stringify(jolly.manifest));
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.put({
        "shared:jolly": jolly,
        "candidate:jolly": jolly.manifest,
        [`published:jolly:${jolly.manifest.releaseId}`]: true,
        "allocation:jolly": jolly.manifest.modules.base,
        [`application-range:${jolly.manifest.modules.base}`]: "jolly",
      });
      return json({ reset: true, accounts: await accountReset.json(), deletedApplicationCatalogs: count, retainedApplications: ["jolly"] }, 200);
    } finally { this.resetting = false; }
  }
  private async write(request: Request, path: string): Promise<Response> {
    if (path.startsWith("/v1/application-blobs/")) {
      const appId = path.split("/")[3];
      if (!await this.publisher(request, appId)) return json({ message: "本轮发布授权已失效" }, 403);
      // Hash verification buffers up to 40 MB; serialize buffers to fit the Worker memory limit.
      return this.queue.runAll([`app:${appId}`, "upload-buffer"], () => this.handle(request));
    }
    try {
      const raw = await request.clone().text();
      if (raw.length > (path === "/v1/catalog" ? 8_000_000 : 210_000)) return json({ message: "请求内容过大" }, 413);
      const input = (raw ? JSON.parse(raw) : {}) as { appId?: string; objects?: CatalogObject[] };
      const ids = path === "/v1/catalog" ? (input.objects ?? []).map(item => String(item.key).match(/^v1\/applications\/([^/]+)\//)?.[1]).filter((id): id is string => Boolean(id)) : [input.appId ?? path.split("/").pop() ?? "unknown"];
      return this.queue.runAll(ids.length ? ids.map(id => `app:${id}`) : ["host"], () => this.handle(request));
    } catch { return json({ message: "请求格式不正确" }, 400); }
  }
  private async publisher(request: Request, appId: string): Promise<boolean> {
    if (await authorized(request, this.env.OFFICIAL_PUBLISH_TOKEN)) return true;
    const grant = await readPublisherGrant(request, this.env.OFFICIAL_PUBLISH_TOKEN);
    if (!grant || grant.appId !== appId) return false;
    const task = await this.ctx.storage.get<WorkshopTask>(`task:${appId}`);
    return Boolean(task?.session && task.ownerId === grant.ownerId && task.publishEpoch === grant.epoch && task.phase === "working");
  }
  private async quota(ownerId: string, appId: string): Promise<boolean> {
    const day = Math.floor(Date.now() / 86400000);
    return this.ctx.storage.transaction(async storage => {
      const record = await storage.get<{ day: number; count: number; reservations?: Record<string, number> }>(`quota:${ownerId}`);
      const count = record?.day === day ? record.count : 0;
      const tasks = await storage.list<WorkshopTask>({ prefix: "task:" });
      const active = new Set([...tasks.values()].filter(task => task.ownerId === ownerId && task.phase === "working" && Date.now() - (task.startedAt ?? 0) < 90 * 60000).map(task => task.appId));
      const reservations = Object.fromEntries(Object.entries(record?.reservations ?? {}).filter(([, expires]) => expires > Date.now()));
      for (const id of Object.keys(reservations)) active.add(id);
      active.delete(appId);
      if (count >= 10 || active.size >= 3) return false;
      reservations[appId] = Date.now() + 90 * 60000;
      await storage.put(`quota:${ownerId}`, { day, count: count + 1, reservations });
      return true;
    });
  }
  private async saveTask(task: WorkshopTask) {
    await this.ctx.storage.transaction(async storage => {
      await storage.put({ [`task:${task.appId}`]: task, [`owner:${task.ownerId}:${task.appId}`]: task });
      const quota = await storage.get<{ day: number; count: number; reservations?: Record<string, number> }>(`quota:${task.ownerId}`);
      if (quota?.reservations?.[task.appId]) { delete quota.reservations[task.appId]; await storage.put(`quota:${task.ownerId}`, quota); }
    });
  }
  private async publisherInstruction(task: WorkshopTask) {
    const grant = await issuePublisherGrant({ appId: task.appId, ownerId: task.ownerId, epoch: task.publishEpoch! }, this.env.OFFICIAL_PUBLISH_TOKEN);
    return `使用 SDK 1.1.9 或更新版本；已有分支如工具过旧，执行 npm install --save-dev @zijinhua/app-sdk@https://zjh-cdn.297782.xyz/v1/sdk/bb53abd00decb5fad63cc972d134fe83e88652e942bea8d70c5b7a7530f2b143，只更新根 SDK 依赖与锁文件，不同步 main。发包前执行 npx zjh-app authorize ${task.appId} '${grant}'，只授权本应用本轮候选发布；不得输出授权、提交授权文件或使用环境里的旧全局发布凭据。`;
  }
  private async recoverSession(task: WorkshopTask): Promise<WorkshopTask> {
    if (task.session || !task.creationTitle) return task;
    let pageToken = "";
    for (let page = 0; page < 10; page++) {
      const response = await fetch(`https://jules.googleapis.com/v1alpha/sessions?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`, { headers: { "X-Goog-Api-Key": this.env.JULES_API_KEY } });
      if (!response.ok) return task;
      const result = await response.json() as { sessions?: CloudSession[]; nextPageToken?: string };
      const found = result.sessions?.find(session => (session as CloudSession & { title?: string }).title === task.creationTitle && session.sourceContext?.source === PLUGIN_SOURCE);
      if (found?.name) { task.session = found.name; task.phase = "working"; await this.saveTask(task); return task; }
      pageToken = result.nextPageToken ?? ""; if (!pageToken) break;
    }
    return task;
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
    const fixed: Record<string, number> = { jolly: 2000000 };
    const prior = await this.candidate(appId);
    return this.ctx.storage.transaction(async storage => {
      const allocated = await storage.get<number>(`allocation:${appId}`); if (allocated) return allocated;
      let base = fixed[appId] ?? prior?.modules.base;
      if (!base) {
        base = await storage.get<number>("allocation:next") ?? 2300000;
        while (await storage.get<string>(`application-range:${base}`)) base += 100000;
        if (base + 100000 >= 2 ** 31) throw new Error("应用模块范围已用尽");
        await storage.put("allocation:next", base + 100000);
      }
      const owner = await storage.get<string>(`application-range:${base}`);
      if (owner && owner !== appId) throw new Error("应用模块范围冲突");
      await storage.put({ [`application-range:${base}`]: appId, [`allocation:${appId}`]: base });
      return base;
    });
  }
  private async candidate(appId: string): Promise<ApplicationRelease | null> {
    // KV is a mirror, never the authority for a candidate that has not committed.
    return await this.ctx.storage.get<ApplicationRelease>(`candidate:${appId}`) ?? null;
  }
  private async recordBranch(task: WorkshopTask, session: CloudSession, application: ApplicationRelease) {
    const urls = session.outputs?.map(output => output.pullRequest?.url).filter((url): url is string => /^https:\/\/github\.com\/jiangfengwhu\/zjh-plugin\/pull\/[0-9]+$/.test(url ?? "")) ?? [];
    for (const url of urls.reverse()) {
      const pr = await this.github(`pulls/${Number(url.split("/").pop())}`);
      if (pr.head?.repo?.full_name !== "jiangfengwhu/zjh-plugin" || !pr.head.ref || pr.head.ref === "main" || !pr.head.sha) continue;
      const commit = await this.github(`git/commits/${pr.head.sha}`);
      if (application.source.commit !== pr.head.sha && (!application.source.tree || application.source.tree !== commit.tree?.sha)) continue;
      task.branch = pr.head.ref; task.branchCommit = pr.head.sha;
      await this.ctx.storage.put(`source-proof:${task.appId}:${application.releaseId}`, { commit: pr.head.sha, tree: application.source.tree });
      await this.saveTask(task); return;
    }
  }
  private async delivery(task: WorkshopTask, _session: CloudSession) {
    const application = await this.candidate(task.appId);
    if (!application || (task.roundRelease ? task.roundRelease !== application.releaseId : application.source.commit === task.previousCommit)) return undefined;
    try { await this.recordBranch(task, _session, application); } catch { /* A candidate is usable without PR metadata or GitHub availability. */ }
    return { ready: true, application, message: "" };
  }
  private async handle(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      const upload = path.match(/^\/v1\/application-blobs\/([a-z][a-z0-9-]{0,63})\/([a-f0-9]{64})$/);
      if (upload && request.method === "PUT") {
        if (!await this.publisher(request, upload[1])) return json({ message: "本轮发布授权已失效" }, 403);
        const maximum = 40 * 1024 * 1024;
        if (Number(request.headers.get("Content-Length")) > maximum) return json({ message: "包体过大" }, 413);
        const reader = request.body?.getReader(); if (!reader) return json({ message: "没有包体" }, 400);
        const chunks: Uint8Array[] = []; let size = 0;
        while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > maximum) { await reader.cancel(); return json({ message: "包体过大" }, 413); } chunks.push(chunk.value); }
        const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
        if (digest !== upload[2]) return json({ message: "包体哈希不匹配" }, 400);
        const task = await this.ctx.storage.get<WorkshopTask>(`task:${upload[1]}`);
        const quotaKey = `upload-quota:${upload[1]}:${task?.publishEpoch ?? "maintainer"}`;
        const quota = await this.ctx.storage.get<{ bytes: number; count: number }>(quotaKey) ?? { bytes: 0, count: 0 };
        if (quota.bytes + size > 512 * 1024 * 1024 || quota.count >= 256) return json({ message: "本轮上传额度已用完" }, 429);
        await this.ctx.storage.put(quotaKey, { bytes: quota.bytes + size, count: quota.count + 1 });
        await this.env.BLOBS.put(`v1/app/${digest}`, bytes, { httpMetadata: { contentType: "application/octet-stream", cacheControl: "public,max-age=31536000,immutable" } });
        return json({ uploaded: true, bytes: size }, 200);
      }
      if (path.startsWith("/v1/application-allocation/")) {
        const appId = path.split("/").pop()!;
        if (request.method === "POST") {
          if (!await this.publisher(request, appId)) return json({ error: "unauthorized" }, 401);
          return json({ appId, moduleBase: await this.allocate(appId) }, 200);
        }
        if (request.method !== "GET") return json({ error: "method" }, 405);
        const base = await this.ctx.storage.get<number>(`allocation:${appId}`);
        const task = await this.ctx.storage.get<WorkshopTask>(`task:${appId}`);
        const origin = await this.publisher(request, appId) ? { title: task?.title, originalAppId: task?.originalAppId, originalReleaseId: task?.originalReleaseId, originalCommit: task?.originalCommit, originalBranch: task?.originalBranch, branch: task?.branch } : {};
        return base ? json({ appId, moduleBase: base, ...origin }, 200) : json({ error: "请先在 Jolly 创建这个应用的心愿" }, 404);
      }
      if ((path === "/v1/market" || path === "/v1/applications") && request.method === "GET") {
        const entries = [...(await this.ctx.storage.list<MarketEntry>({ prefix: "shared:" })).values()];
        for (const entry of entries) {
          if ((OFFICIAL_APPLICATIONS as readonly string[]).includes(entry.manifest.appId)) { entry.authorId = OFFICIAL_ACCOUNT_ID; entry.authorName = "紫金花官方"; entry.authorAvatarUrl = null; }
          entry.authorOfficial = entry.authorId === OFFICIAL_ACCOUNT_ID;
        }
        // Public browsing never authenticates the visitor. Profile lookup is optional enrichment.
        try {
          const profiles = await publicProfiles([...new Set(entries.map(entry => entry.authorId).filter((id): id is string => Boolean(id)))], this.env);
          for (const entry of entries) { const profile = entry.authorId ? profiles.get(entry.authorId) : undefined; if (profile) { entry.authorName = profile.name; entry.authorAvatarUrl = profile.avatarUrl; } }
        } catch { /* Keep published snapshots available if the account service is unavailable. */ }
        return json({ applications: path === "/v1/applications" ? entries.map(entry => entry.manifest) : entries }, 200);
      }
      if (new URL(request.url).pathname === "/v1/catalog") {
        if (!await readPublisherGrant(request, this.env.OFFICIAL_PUBLISH_TOKEN) && !await authorized(request, this.env.OFFICIAL_PUBLISH_TOKEN)) return json({ error: "unauthorized" }, 401);
        const text = await request.clone().text();
        if (text.length > 8_000_000) return json({ error: "catalog too large" }, 413);
        const { objects, expectedReleases } = JSON.parse(text) as { objects?: CatalogObject[]; expectedReleases?: Record<string, string | null> };
        const candidates = new Map<string, ApplicationRelease>();
        const ranges = new Map<number, string>();
        for (const item of objects ?? []) {
          if (typeof item.key !== "string" || typeof item.body !== "string") continue;
          const match = item.key.match(/^v1\/applications\/([a-z][a-z0-9-]{0,63})\/(latest|releases\/[a-f0-9]{64})$/);
          if (!match) { if (!await authorized(request, this.env.OFFICIAL_PUBLISH_TOKEN)) return json({ error: "application publisher cannot modify host catalog" }, 403); continue; }
          if (!await this.publisher(request, match[1])) return json({ error: "publisher is not authorized for this application and round" }, 403);
          const manifest = JSON.parse(item.body) as { appId: string; releaseId: string; source: { dirty: boolean }; modules: { base: number; size: number } };
          const base = manifest.modules?.base;
          if (manifest.appId !== match[1] || manifest.source?.dirty !== false || !/^[a-f0-9]{64}$/.test(manifest.releaseId) || !Number.isSafeInteger(base) || base < 2000000 || base % 100000 || manifest.modules.size !== 100000) return json({ error: "application manifest invalid" }, 400);
          const document = JSON.parse(item.body);
          const { releaseId, ...content } = document;
          const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(content)));
          const identity = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
          if (document.source.tree !== undefined && !/^[a-f0-9]{40}$/.test(document.source.tree)) return json({ error: "application source tree invalid" }, 400);
          if (identity !== releaseId || document.format !== 1 || !/^[a-f0-9]{40}$/.test(document.source.commit) || !document.requires?.engineAbi || !document.requires?.sdk) return json({ error: "application integrity invalid" }, 400);
          if (document.source.repository !== "jiangfengwhu/zjh-plugin" || document.dataSchemaVersion !== 1) return json({ error: "application source or data schema invalid" }, 400);
          const task = await this.ctx.storage.get<WorkshopTask>(`task:${manifest.appId}`);
          if (task?.originalAppId && (document.originalAppId !== task.originalAppId || document.originalReleaseId !== task.originalReleaseId || document.originalCommit !== task.originalCommit)) return json({ error: "original application version cannot change" }, 409);
          for (const blob of [document.bundle, ...(document.assets ?? [])]) {
            if (!blob || !/^[a-f0-9]{64}$/.test(blob.sha256) || !Number.isSafeInteger(blob.bytes) || blob.bytes < 0 || (blob === document.bundle && !blob.bytes)) return json({ error: "application blob invalid" }, 400);
            const stored = await this.env.BLOBS.head(`v1/app/${blob.sha256}`);
            if (!stored || stored.size !== blob.bytes) return json({ error: "application blob not uploaded" }, 409);
          }
          const fixedOwners: Record<number, string> = { 2000000: "jolly" };
          if (fixedOwners[base] && fixedOwners[base] !== manifest.appId) return json({ error: "application module range reserved" }, 409);
          const priorLatest = await this.candidate(manifest.appId);
          if (match[2] === "latest") {
            if (candidates.has(manifest.appId)) return json({ error: "duplicate candidate pointer" }, 400);
            if (!expectedReleases || !Object.hasOwn(expectedReleases, manifest.appId)) return json({ error: "expected candidate release is required; upgrade SDK" }, 409);
            if ((priorLatest?.releaseId ?? null) !== expectedReleases[manifest.appId] && priorLatest?.releaseId !== manifest.releaseId) return json({ error: "candidate baseline changed; synchronize and republish" }, 409);
            candidates.set(manifest.appId, document);
          }
          if (priorLatest && priorLatest.modules.base !== base) return json({ error: "application module range cannot change" }, 409);
          const owner = await this.ctx.storage.get<string>(`application-range:${base}`);
          if (owner && owner !== manifest.appId) return json({ error: "application module range occupied" }, 409);
          if (ranges.has(base) && ranges.get(base) !== manifest.appId) return json({ error: "duplicate module range" }, 409);
          ranges.set(base, manifest.appId);
          if (match[2] !== "latest") {
            if (!match[2].endsWith(manifest.releaseId)) return json({ error: "application release identity mismatch" }, 400);
            const prior = await this.env.CATALOG.get(item.key);
            if (prior && prior !== item.body) return json({ error: "application release is immutable" }, 409);
          }
        }
        for (const [appId, manifest] of candidates) {
          const key = `v1/applications/${appId}/releases/${manifest.releaseId}`;
          const body = (objects ?? []).find(item => item.key === key)?.body ?? await this.env.CATALOG.get(key);
          if (typeof body !== "string" || JSON.stringify(JSON.parse(body)) !== JSON.stringify(manifest)) return json({ error: "candidate must reference the same immutable release" }, 409);
        }
        // Reserve shared module ranges atomically before writing any KV mirrors.
        await this.ctx.storage.transaction(async storage => {
          for (const [base, appId] of ranges) {
            const owner = await storage.get<string>(`application-range:${base}`);
            if (owner && owner !== appId) throw new Error("应用模块范围冲突，请重试");
            await storage.put(`application-range:${base}`, appId);
          }
        });
        const response = await putCatalog(request, this.env);
        if (!response.ok) return response;
        if (candidates.size) {
          await this.ctx.storage.put(Object.fromEntries([...candidates].map(([id, manifest]) => [`candidate:${id}`, manifest])));
          for (const [id, manifest] of candidates) {
            const task = await this.ctx.storage.get<WorkshopTask>(`task:${id}`);
            if (task) { task.roundRelease = manifest.releaseId; await this.saveTask(task); }
          }
        }
        return response;
      }

      if (path === "/v1/official-release" && request.method === "POST") {
        if (!await authorized(request, this.env.OFFICIAL_PUBLISH_TOKEN)) return json({ message: "官方公开发布需要维护者凭证" }, 403);
        const { appId, releaseId } = await request.json() as { appId: string; releaseId: string };
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(appId) || !/^[a-f0-9]{64}$/.test(releaseId)) return json({ message: "请指定应用和不可变版本" }, 400);
        if (await this.ctx.storage.get(`task:${appId}`)) return json({ message: "用户作品必须由作者决定上架" }, 409);
        const manifest = await this.env.CATALOG.get<ApplicationRelease>(`v1/applications/${appId}/releases/${releaseId}`, "json");
        if (!manifest || manifest.appId !== appId || manifest.releaseId !== releaseId || manifest.source.dirty) return json({ message: "指定版本尚未上传或无效" }, 409);
        const entry: MarketEntry = { manifest, title: manifest.title, summary: manifest.summary, authorId: OFFICIAL_ACCOUNT_ID, authorName: "紫金花官方", authorOfficial: true, originalAppId: null };
        await this.ctx.storage.put({ [`shared:${appId}`]: entry, [`published:${appId}:${releaseId}`]: true });
        await this.ctx.storage.delete(`withdrawn:${appId}`);
        return json({ appId, public: releaseId }, 200);
      }
      const versionRoute = path.match(/^\/v1\/applications\/([a-z][a-z0-9-]{0,63})\/(latest|candidate|public|releases\/[a-f0-9]{64})$/);
      if (versionRoute && ["GET", "HEAD"].includes(request.method)) {
        const [, appId, pointer] = versionRoute;
        const shared = await this.ctx.storage.get<MarketEntry>(`shared:${appId}`);
        if (pointer === "public") return shared ? json(shared.manifest, 200) : json({ message: "应用还没有公开版本" }, 404);
        // Released snapshots stay readable after an update or withdrawal; installed apps keep working.
        if (pointer.startsWith("releases/") && await this.ctx.storage.get(`published:${appId}:${pointer.slice(9)}`)) {
          const manifest = await this.env.CATALOG.get<ApplicationRelease>(`v1/applications/${appId}/${pointer}`, "json");
          return manifest ? json(manifest, 200) : json({ message: "没有对应版本" }, 404);
        }
        const manager = await this.publisher(request, appId);
        const task = await this.ctx.storage.get<WorkshopTask>(`task:${appId}`);
        if (!manager) {
          const user = await authenticatedUser(request, this.env);
          if (!user) return json({ message: "候选版本需要制作身份" }, 401);
          if (!task || task.ownerId !== user.id || request.headers.get("X-Workshop-Token") !== task.token) return json({ message: "没有这个作品的制作权限" }, 403);
        }
        const key = pointer === "candidate" ? "latest" : pointer;
        const manifest = key === "latest" ? await this.candidate(appId) : key ? await this.env.CATALOG.get<ApplicationRelease>(`v1/applications/${appId}/${key}`, "json") : null;
        if (!manifest) return json({ message: "没有对应版本" }, 404);
        const response = json(manifest, 200);
        const proof = await this.ctx.storage.get<{ commit: string; tree: string }>(`source-proof:${appId}:${manifest.releaseId}`);
        if (manifest.source.tree && proof?.tree === manifest.source.tree) response.headers.set("X-Application-Source-Commit", proof.commit);
        return response;
      }
      if (path === "/v1/works" && request.method === "GET") {
        const user = await authenticatedUser(request, this.env); if (!user) return json({ message: "请先登录" }, 401);
        const tasks = [...(await this.ctx.storage.list<WorkshopTask>({ prefix: `owner:${user.id}:` })).values()];
        for (let index = 0; index < tasks.length; index++) {
          if (!tasks[index].session && tasks[index].creationTitle) tasks[index] = await this.queue.run(`app:${tasks[index].appId}`, async () => this.recoverSession((await this.ctx.storage.get<WorkshopTask>(`task:${tasks[index].appId}`))!));
        }
        return json({ works: tasks.map(task => ({ appId: task.appId, ownerId: task.ownerId, session: task.session, approvalToken: task.token, title: task.title ?? task.appId, wish: task.wish ?? "", startedAt: task.startedAt, originalAppId: task.originalAppId, originalReleaseId: task.originalReleaseId, originalCommit: task.originalCommit, branch: task.branch, phase: task.phase })) }, 200);
      }
      const input = await request.json() as { appId?: string; originalAppId?: string; originalReleaseId?: string; requestId?: string; action?: string; session?: string; token?: string; approvalToken?: string; method?: string; path?: string; body?: string; releaseId?: string; title?: string; summary?: string; applicationReleases?: Record<string, string> };
      const appId = input.appId;
      if (!appId || !/^[a-z][a-z0-9-]{0,63}$/.test(appId)) return json({ message: "请指定目标应用" }, 400);
      const user = await authenticatedUser(request, this.env);
      if (!user) return json({ message: "请先登录后再操作作品" }, 401);
      let task = await this.ctx.storage.get<WorkshopTask>(`task:${appId}`);
      if (task && task.ownerId !== user.id) return json({ message: "这个作品属于其他账号" }, 403);
      if (path === "/v1/jules" && input.method === "POST" && input.path === "/v1alpha/sessions") {
        if ((OFFICIAL_APPLICATIONS as readonly string[]).includes(appId)) return json({ message: "请基于这个应用创作新作品" }, 403);
        if (task?.session) {
          if (input.requestId && input.requestId === task.requestId) return json({ name: task.session, ownerId: task.ownerId, approvalToken: task.token }, 200);
          return json({ message: "这个应用已有 session，请从作品列表接回" }, 409);
        }
        if (!input.requestId || !/^[a-zA-Z0-9-]{1,160}$/.test(input.requestId)) return json({ message: "创建需要稳定的请求 ID，请更新宿主" }, 400);
        if (task && !task.creationRejected) {
          task = await this.recoverSession(task);
          if (input.requestId === task.requestId && task.session) return json({ name: task.session, ownerId: task.ownerId, approvalToken: task.token }, 200);
          return json({ message: "已记录创建请求，正在接回会话。请稍后从作品列表重试，不要重复创建。" }, 409);
        }
        if (await this.candidate(appId)) return json({ message: "应用 ID 已存在，请基于它创作新作品" }, 409);
        const payload = JSON.parse(input.body ?? "{}");
        const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
        if (!prompt) return json({ message: "请描述想做什么" }, 400);
        if (prompt.length > 8000) return json({ message: "心愿最多 8000 个字符，请精简后再提交" }, 400);
        let original: ApplicationRelease | undefined;
        let originalCommit: string | undefined; let originalBranch: string | undefined;
        if (input.originalAppId) {
          const shared = await this.ctx.storage.get<MarketEntry>(`shared:${input.originalAppId}`);
          if (!shared || shared.manifest.releaseId !== input.originalReleaseId) return json({ message: "原作公开版本已改变，请刷新市场后重新创作" }, 409);
          original = shared.manifest; originalCommit = shared.sourceCommit ?? original.source.commit; originalBranch = shared.sourceBranch;
        }
        if (!await this.quota(user.id, appId)) return json({ message: "每天最多发起 10 轮制作，同时最多制作 3 个作品" }, 429);
        const moduleBase = await this.allocate(appId);
        task = { ownerId: user.id, appId, session: "", token: crypto.randomUUID(), phase: "working", publishEpoch: crypto.randomUUID(), requestId: input.requestId, title: String(payload.title ?? appId).slice(0, 80), wish: prompt, startedAt: Date.now(), originalAppId: original?.appId, originalReleaseId: original?.releaseId, originalCommit, originalBranch };
        task.creationTitle = `${task.title?.slice(0, 40)} [${crypto.randomUUID()}]`;
        payload.title = task.creationTitle;
        payload.sourceContext = { source: PLUGIN_SOURCE, githubRepoContext: { startingBranch: originalBranch ?? "main" }, environmentVariablesEnabled: false };
        await this.saveTask(task);
        const origin = original ? `从原作分支 ${originalBranch ?? "main"} 新建属于本作者的独立分支，禁止修改原作分支。原作 ${original.appId} 的版本 ${original.releaseId}、源码提交 ${originalCommit} 已锁定，init 工具会从这个提交复制 src/assets；不得改用 main 的新版。` : "";
        payload.prompt = `目标应用：${appId}；只交付 apps/${appId}/。${await this.publisherInstruction(task)} Jules 自动创建的工作分支就是本应用的长期分支；不合入或同步 main。新建时执行 npm run init:application -- ${appId}，平台分配 moduleBase=${moduleBase}。${origin} 用户需求：\n${prompt}`;
        const response = await proxyJules(new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify({ ...input, body: JSON.stringify(payload) }) }), this.env);
        if (!response.ok) { task.phase = "paused"; task.creationRejected = response.status >= 400 && response.status < 500; await this.saveTask(task); return response; }
        const session = await response.json() as CloudSession;
        if (!session.name) { task.phase = "paused"; await this.saveTask(task); return json({ message: "Jules 未返回 session，请接回制作记录" }, 502); }
        task.session = session.name;
        await this.saveTask(task);
        return json({ ...session, ownerId: user.id, approvalToken: task.token }, 200);
      }
      if (!task || (input.token ?? input.approvalToken) !== task.token) return json({ message: "这个应用的 session 凭据不匹配" }, 403);
      if (path === "/v1/market") {
        const shared = await this.ctx.storage.get<MarketEntry>(`shared:${appId}`) ?? null;
        if (shared && shared.authorId !== user.id) return json({ message: "只有作者可以管理这份分享" }, 403);
        const application = await this.candidate(appId);
        if (input.action === "status") return json({ shared, application }, 200);
        if (input.action === "withdraw") {
          await this.ctx.storage.delete(`shared:${appId}`);
          await this.ctx.storage.put(`withdrawn:${appId}`, true);
          return json({ shared: null, application }, 200);
        }
        if (input.action && !["share", "edit"].includes(input.action)) return json({ message: "分享操作无效" }, 400);
        if (input.action === "edit" && !shared) return json({ message: "这份作品尚未分享" }, 409);
        if (input.action !== "edit" && (!application || input.releaseId !== application.releaseId)) return json({ message: "候选版本已改变，请刷新作品状态后再上架" }, 409);
        const manifest = input.action === "edit" ? shared!.manifest : application;
        if (!manifest) return json({ message: "作品尚未发包，请先完成制作" }, 409);
        const proof = await this.ctx.storage.get<{ commit: string }>(`source-proof:${appId}:${manifest.releaseId}`);
        const title = input.title?.trim() ?? shared?.title ?? manifest.title;
        const summary = input.summary?.trim() ?? shared?.summary ?? manifest.summary;
        if (!title || title.length > 60 || summary.length > 300) return json({ message: "名称不能为空且最多 60 字，介绍最多 300 字" }, 400);
        const entry: MarketEntry = { manifest, title, summary, authorId: user.id, authorName: user.name, authorAvatarUrl: user.avatarUrl, authorOfficial: user.id === OFFICIAL_ACCOUNT_ID, originalAppId: (manifest as ApplicationRelease & { originalAppId?: string }).originalAppId ?? null, sourceCommit: input.action === "edit" ? shared!.sourceCommit : proof?.commit ?? manifest.source.commit, sourceBranch: input.action === "edit" ? shared!.sourceBranch : task.branch };
        await this.ctx.storage.put({ [`shared:${appId}`]: entry, [`published:${appId}:${manifest.releaseId}`]: true });
        await this.ctx.storage.delete(`withdrawn:${appId}`);
        return json({ shared: entry, application }, 200);
      }
      if (path === "/v1/jules") {
        const name = input.path?.match(/^\/v1alpha\/(sessions\/[A-Za-z0-9_-]+)/)?.[1];
        if (name !== task.session) return json({ message: "Session 不属于这个应用" }, 403);
        if (input.method === "POST" && input.path?.endsWith(":sendMessage")) {
          const current = await this.session(task.session);
          if (!["COMPLETED", "PAUSED", "AWAITING_USER_FEEDBACK", "FAILED"].includes(current.state ?? "")) return json({ message: "这个应用正在制作，请等本轮完成" }, 409);
          const dispatchVersion = `${current.state}:${current.updateTime ?? ""}`;
          if (task.dispatchVersion === dispatchVersion) return json({ message: "本轮修改已提交，请等待制作状态更新" }, 409);
          const payload = JSON.parse(input.body ?? "{}");
          if (typeof payload.prompt !== "string" || !payload.prompt.trim() || payload.prompt.length > 8000) return json({ message: "请提交 1 到 8000 个字符的修改需求" }, 400);
          if (!await this.quota(user.id, appId)) return json({ message: "制作额度已用完或同时制作作品过多，请稍后再试" }, 429);
          const previous = structuredClone(task);
          task.publishEpoch = crypto.randomUUID(); task.dispatchVersion = dispatchVersion;
          task.previousCommit = (await this.candidate(appId))?.source.commit ?? task.previousCommit; task.roundRelease = undefined;
          task.phase = "working"; task.repair = false; task.wish = String(payload.prompt ?? ""); task.startedAt = Date.now();
          // Persist the new round before upstream work starts; ambiguous timeouts can still deliver.
          await this.saveTask(task);
          payload.prompt = `继续修改应用 ${appId}，只改 apps/${appId}/ 与所需根锁文件。${await this.publisherInstruction(task)} ${task.branch ? `在应用专属分支 ${task.branch} 继续迭代，git fetch origin 后 checkout 该分支。` : "继续使用这个 session 自动创建的应用分支。"} 不同步或合入 main，不新建迭代 PR；提交并发包即可交付。 用户需求：\n${payload.prompt ?? ""}`;
          const response = await proxyJules(new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify({ ...input, body: JSON.stringify(payload) }) }), this.env);
          if (!response.ok && response.status < 500) await this.saveTask(previous);
          return response;
        }
        return proxyJules(new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(input) }), this.env);
      }
      if (input.session !== task.session) return json({ message: "Session 不属于这个应用" }, 403);
      const session = await this.session(task.session);
      if (task.dispatchVersion && task.dispatchVersion !== `${session.state}:${session.updateTime ?? ""}`) { task.dispatchVersion = undefined; await this.saveTask(task); }
      if (input.action === "stop") {
        if (!["COMPLETED", "PAUSED", "FAILED"].includes(session.state ?? "")) {
          const response = await proxyJules(new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify({ method: "POST", path: `/v1alpha/${task.session}:sendMessage`, body: JSON.stringify({ prompt: "停止当前制作，不再修改或发布，等待我的下一条需求。" }) }) }), this.env);
          if (!response.ok) return response;
        }
        task.phase = "paused"; task.repair = true; task.dispatchVersion = undefined;
        const latest = await this.candidate(appId);
        task.previousCommit = latest?.source.commit ?? task.previousCommit;
        await this.saveTask(task);
        return json({ stopped: true }, 200);
      }
      if (task.phase === "paused") return json({ completed: false, state: "PAUSED", message: "已发送停止请求，可以继续这个应用" }, 200);
      if (session.state !== "COMPLETED") {
        if (["FAILED", "PAUSED"].includes(session.state ?? "")) { task.phase = "paused"; task.repair = true; await this.saveTask(task); }
        return json({ completed: false, state: session.state, delivery: "unpublished", message: ["FAILED", "PAUSED"].includes(session.state ?? "") ? "制作已暂停，可以继续处理" : "这轮作品仍在制作" }, 200);
      }
      let delivery: Awaited<ReturnType<Workshop["delivery"]>>;
      try { delivery = await this.delivery(task, session); }
      catch (error) {
        task.repair = true; await this.saveTask(task);
        return json({ completed: true, state: session.state, delivery: "blocked", message: error instanceof Error ? error.message : "请在当前 session 修复交付后重新发包" }, input.action === "status" ? 200 : 409);
      }
      const ready = delivery?.ready === true;
      if (!ready) { task.repair = true; await this.saveTask(task); }
      const loaded = ready && input.applicationReleases?.[appId] === delivery!.application.releaseId;
      if (input.action === "status") {
        if (delivery?.application.title && delivery.application.title !== appId) task.title = delivery.application.title;
        task.phase = ready ? "ready" : "working"; await this.saveTask(task);
        return json({ completed: true, state: session.state, delivery: !delivery ? "unpublished" : !ready ? "blocked" : loaded ? "loaded" : "update", message: !delivery ? "等待本轮候选包发布" : !ready ? delivery.message : loaded ? "正在运行本轮作品，可继续修改或上架" : "作品已发布，可直接体验、继续修改或上架", ...(delivery ? { application: delivery.application, branch: task.branch } : {}) }, 200);
      }
      return json({ message: "工坊只支持查看状态与停止制作，请更新客户端" }, 400);
    } catch (error) { return json({ message: error instanceof Error ? error.message : "工坊暂时不可用" }, 502); }
  }
  private async github(path: string): Promise<any> {
    if (!this.env.GITHUB_MERGE_TOKEN) throw new Error("工坊的分支信息读取还未配置好，请联系维护者");
    const response = await fetch(`https://api.github.com/repos/jiangfengwhu/zjh-plugin/${path}`, {
      signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Bearer ${this.env.GITHUB_MERGE_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "zijinhua-workshop", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
    });
    if (!response.ok) throw new Error("暂时无法读取应用分支，请稍后再试");
    return response.json();
  }


}
