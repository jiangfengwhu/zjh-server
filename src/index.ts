import { DurableObject } from "cloudflare:workers";

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
      if (request.method === "POST" && url.pathname === "/v1/workshop") return env.WORKSHOP.getByName("dynamic").fetch(request);
      if (request.method === "POST" && url.pathname === "/v1/jules") {
        const operation = await request.clone().json() as { method?: string };
        if (operation.method !== "GET") return env.WORKSHOP.getByName("dynamic").fetch(request);
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
type WorkshopTask = { session: string; token: string; legacy?: boolean };
type CloudSession = { name?: string; state?: string; sourceContext?: { source?: string }; outputs?: { pullRequest?: { url?: string } }[] };
type WorkshopRelease = { id: string; source: { commit: string; dirty: boolean; buildId?: string } };

// 串行保存工坊心愿；合入权限只由用户的确认请求触发。
export class Workshop extends DurableObject<Env> {
  private queue: Promise<unknown> = Promise.resolve();

  fetch(request: Request): Promise<Response> {
    const next = this.queue.then(() => this.handle(request));
    this.queue = next.catch(() => {});
    return next;
  }

  private async session(name: string): Promise<CloudSession> {
    if (!/^sessions\/[A-Za-z0-9_-]{1,128}$/.test(name)) throw new Error("这份心愿的记录不完整");
    const response = await fetch(`https://jules.googleapis.com/v1alpha/${name}`, { headers: { "X-Goog-Api-Key": this.env.JULES_API_KEY } });
    if (!response.ok) throw new Error("暂时接不上这份心愿，请稍后再试");
    const session = await response.json() as CloudSession;
    if (session.sourceContext?.source !== DYNAMIC_SOURCE) throw new Error("这份心愿不属于当前工坊");
    return session;
  }

  private async github(path: string, method = "GET", body?: unknown): Promise<any> {
    if (!this.env.GITHUB_MERGE_TOKEN) throw new Error("工坊的收下功能还未配置好，请联系维护者");
    const response = await fetch(`https://api.github.com/repos/jiangfengwhu/zjh-dynamic/${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.env.GITHUB_MERGE_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "zijinhua-workshop", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(response.status === 409 || response.status === 405 ? "这份心愿的代码有了变化，暂时不能收下，请联系维护者处理" : "暂时没能收下这份心愿，请稍后再试");
    return response.json();
  }

  private async release(): Promise<WorkshopRelease> {
    const release = await this.env.CATALOG.get<WorkshopRelease>("v1/release", "json");
    if (!release?.id) throw new Error("新作品还未送到，请稍后再试");
    return release;
  }

  private async handle(request: Request): Promise<Response> {
    try {
      let task = await this.ctx.storage.get<WorkshopTask>("active");
      const input = await request.clone().json() as { action?: string; session?: string; token?: string; buildId?: string; method?: string; path?: string; body?: string; approvalToken?: string };
      if (new URL(request.url).pathname === "/v1/jules") {
        if (input.method === "POST" && input.path === "/v1alpha/sessions") {
          if (task) return json({ message: "先收下工坊里这份心愿，再开始下一个吧" }, 409);
          const response = await proxyJules(request, this.env);
          if (!response.ok) return response;
          const session = await response.json() as CloudSession;
          if (!session.name) return json({ message: "这份心愿暂时没有接好，请稍后再试" }, 502);
          task = { session: session.name, token: crypto.randomUUID(), legacy: !input.buildId };
          await this.ctx.storage.put("active", task);
          return json({ ...session, approvalToken: task.token }, 200);
        }
        const name = input.path?.match(/^\/v1alpha\/(sessions\/[A-Za-z0-9_-]+)/)?.[1];
        if (name && (!task || task.session !== name || input.approvalToken !== task.token)) return json({ message: "请从当前工坊继续这份心愿" }, 403);
        if (name && input.method === "POST" && input.path?.endsWith(":sendMessage")) {
          const session = await this.session(name);
          if (session.state !== "AWAITING_USER_FEEDBACK" && session.state !== "PAUSED") return json({ message: "先体验并收下这份心愿，再开始下一个吧" }, 409);
        }
        if (name && input.method === "DELETE") {
          const session = await this.session(name);
          if (session.state === "COMPLETED") return json({ message: "这份心愿已做好，体验后收下才能开始下一个" }, 409);
        }
        const response = await proxyJules(request, this.env);
        if (response.ok && input.method === "DELETE") await this.ctx.storage.delete("active");
        return response;
      }
      if (!input.session) return json({ message: "这份心愿的记录不完整" }, 400);
      const confirmed = await this.ctx.storage.get<WorkshopTask & { mergeCommit: string }>("confirmed");
      if (confirmed?.session === input.session && confirmed.token === input.token) return json({ merged: true, mergeCommit: confirmed.mergeCommit }, 200);
      const session = await this.session(input.session);
      // 首次升级时接回已有会话；之后的会话由创建入口登记。
      if (!task) {
        if (input.action !== "status") return json({ message: "请先接回这份心愿" }, 409);
        task = { session: input.session, token: crypto.randomUUID() };
        await this.ctx.storage.put("active", task);
      } else if (task.session === input.session && task.legacy && !input.token && input.action === "status") {
        task.legacy = false;
        await this.ctx.storage.put("active", task);
      } else if (task.session !== input.session || task.token !== input.token) {
        return json({ message: "工坊里还有另一份心愿，请先完成它" }, 409);
      }
      const prUrl = session.outputs?.map(output => output.pullRequest?.url).find(url => /^https:\/\/github\.com\/jiangfengwhu\/zjh-dynamic\/pull\/[0-9]+$/.test(url ?? ""));
      if (input.action === "status") {
        if (session.state === "FAILED") await this.ctx.storage.delete("active");
        return json({ state: session.state, token: task.token, completed: session.state === "COMPLETED", prUrl: prUrl ?? "", merged: false }, 200);
      }
      if (input.action !== "confirm" || !input.token || input.token !== task.token) return json({ message: "请从工坊亲自收下这份心愿" }, 403);
      if (session.state !== "COMPLETED" || !prUrl) return json({ message: "这份心愿还在收尾，请稍后再来收下" }, 409);
      const release = await this.release();
      if (!input.buildId || release.source.buildId !== input.buildId) return json({ message: "新作品还没打开。先加载最新内容，体验后再收下吧", needsUpdate: true }, 409);
      const number = prUrl.split("/").pop();
      const pr = await this.github(`pulls/${number}`);
      if (pr.base?.ref !== "main" || pr.head?.repo?.full_name !== "jiangfengwhu/zjh-dynamic") return json({ message: "这份作品的交付记录不匹配，请联系维护者" }, 409);
      if (release.source.dirty || release.source.commit !== pr.head?.sha) return json({ message: "正在体验的作品与待收下的代码不一致，请联系维护者重新发布" }, 409);
      if (!pr.merged) {
        if (pr.state !== "open" || pr.draft) return json({ message: "这份心愿还未准备好收下" }, 409);
        const comparison = await this.github(`compare/main...${pr.head.sha}`);
        if (comparison.status !== "ahead" && comparison.status !== "identical") return json({ message: "工坊的底稿有了更新，请联系维护者同步后重新发布" }, 409);
      }
      if ((await this.release()).id !== release.id) return json({ message: "又有新内容送到了，加载后再收下吧", needsUpdate: true }, 409);
      const result = pr.merged ? { merged: true, sha: pr.merge_commit_sha } : await this.github(`pulls/${number}/merge`, "PUT", { sha: pr.head.sha, merge_method: "merge" });
      if (!result.merged) return json({ message: "暂时没能收下这份心愿，请稍后再试" }, 409);
      await this.ctx.storage.put("confirmed", { ...task, mergeCommit: result.sha });
      await this.ctx.storage.delete("active");
      return json({ merged: true, mergeCommit: result.sha }, 200);
    } catch (error) {
      return json({ message: error instanceof Error ? error.message : "工坊暂时没有接好，请稍后再试" }, 502);
    }
  }
}
