import { getMany } from "./storageBatch";
import { validateApplicationIcon, validIconJpeg } from "./applicationIcon";
import { androidAssetLinks, downloadLatestApk, readSharedApplication } from "./sharedLinks";
import { DurableObject } from "cloudflare:workers";
import { authenticatedUser, OFFICIAL_ACCOUNT_ID, OFFICIAL_APPLICATIONS, publicProfiles, readAvatar } from "./accounts";
import { KeyedQueue } from "./concurrency";
import { MarketIndex } from "./readIndexes";
import { pageBff } from "./pageBff";
import { sdkPreparation } from "./sdk-distribution";
import { issuePublisherGrant, readPublisherGrant, redactPublisherGrants, publisherGrantActive } from "./publisher";
export { Accounts } from "./accounts";
export { Posts } from "./posts";
import { readPostImage, readSharedPost } from "./posts";
import { applicationData } from "./applicationData";
import { applicationFiles } from "./applicationFiles";
import { applicationRooms } from "./applicationRooms";
export { ApplicationDatabase } from "./applicationData";

/** 清单类的键：整套清单和 vendor 的模块编号表。格式变了就换前缀（v3/…），旧版本的手机继续读旧前缀。 */
const JSON_KEY = /^v1\/(?:release|runtime|apk|maps\/vendor\.json|applications\/[a-z][a-z0-9-]{0,63}\/(?:latest|releases\/[a-f0-9]{64}))$/;
const DYNAMIC_JSON_KEY = /^v1\/(?:release|apk|maps\/vendor\.json|applications\/[a-z][a-z0-9-]{0,63}\/(?:latest|releases\/[a-f0-9]{64}))$/;
const PLUGIN_SOURCE = "sources/github/jiangfengwhu/zjh-plugin";
const allowedSource = (source?: string) => source === PLUGIN_SOURCE;

/** 包体的键：vendor、app、插件 DEX，全部按内容哈希命名，写入后不再改。 */
const BLOB_KEY = /^v1\/apk\/[a-f0-9]{64}\.apk$|^v1\/(?:vendor|app|sdk)\/[a-f0-9]{64}$|^v1\/plugins\/[a-z0-9-]+\/[a-f0-9]{64}$/;

const ACTIVITY_MASK =
  "activities.name,activities.id,activities.createTime,activities.description,activities.progressUpdated,activities.planGenerated,activities.planApproved,activities.sessionCompleted,activities.sessionFailed,activities.agentMessaged,activities.userMessaged,nextPageToken";

type CatalogObject = { key?: unknown; body?: unknown };

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    try {
      const page = await pageBff(request, env);
      if (page) return page;
      if (url.pathname.startsWith("/v1/app-files/")) return applicationFiles(request, env);
      if (url.pathname.startsWith("/v1/app-rooms/")) return applicationRooms(request, env);
      if (url.pathname.startsWith("/v1/app-data/")) return applicationData(request, env);
      if (["GET", "HEAD"].includes(request.method) && url.pathname === "/.well-known/assetlinks.json") return androidAssetLinks();
      if (["GET", "HEAD"].includes(request.method) && url.pathname === "/download") return downloadLatestApk(env);
      if (["GET", "HEAD"].includes(request.method) && /^\/applications\/[a-z][a-z0-9-]{0,63}$/.test(url.pathname)) return readSharedApplication(request, env);
      if (/^\/v1\/(auth\/(?:code|verify|logout)|account(?:\/avatar)?)$/.test(url.pathname)) return env.ACCOUNTS.getByName("accounts").fetch(request);
      if (/^\/v1\/(posts(?:\/[a-f0-9]{64}(?:\/(?:like|bookmark|comments)(?:\/[a-f0-9]{64})?)?)?|post-media)$/.test(url.pathname)) return env.POSTS.getByName("timeline").fetch(request);
      if (url.pathname === "/v1/application-bookmarks" || /^\/v1\/application-discussions\/[a-z][a-z0-9-]{0,63}$/.test(url.pathname)) return env.POSTS.getByName("timeline").fetch(request);
      if (/^\/v1\/profiles\/[a-f0-9-]{36}(?:\/(?:follow|followers|following))?$/.test(url.pathname)) return env.POSTS.getByName("timeline").fetch(request);
      if (/^\/v1\/messages(?:\/(?:live|unread|[a-f0-9-]{36}(?:\/read)?))?$/.test(url.pathname)) return env.POSTS.getByName("timeline").fetch(request);
      if (/^\/v1\/notifications(?:\/(?:unread|read))?$/.test(url.pathname)) return env.POSTS.getByName("timeline").fetch(request);
      if ((request.method === "GET" || request.method === "HEAD") && /^\/posts\/[a-f0-9]{64}$/.test(url.pathname)) return readSharedPost(request, env);
      if ((request.method === "GET" || request.method === "HEAD") && /^\/v1\/post-images\/[a-f0-9-]{36}\/[a-f0-9-]{36}$/.test(url.pathname)) return readPostImage(request, env);
      if ((request.method === "GET" || request.method === "HEAD") && /^\/v1\/(?:market-images|market-icons)\/[a-z][a-z0-9-]{0,63}\/[a-f0-9-]{36}\/[a-f0-9]{64}$/.test(url.pathname)) return readPostImage(request, env);
      if ((request.method === "GET" || request.method === "HEAD") && /^\/v1\/feedback-images\/[a-z][a-z0-9-]{0,63}\/[a-f0-9-]{36}\/[a-f0-9]{64}$/.test(url.pathname)) return readPostImage(request, env);
      if ((request.method === "GET" || request.method === "HEAD") && /^\/v1\/creation-images\/[a-f0-9-]{36}\/[a-f0-9]{64}$/.test(url.pathname)) return readPostImage(request, env);
      if (request.method === "PUT" && url.pathname === "/v1/creation-media") return env.WORKSHOP.getByName("dynamic").fetch(request);
      if (request.method === "PUT" && /^\/v1\/feedback-media\/[a-z][a-z0-9-]{0,63}\/[a-f0-9]{64}$/.test(url.pathname)) return env.WORKSHOP.getByName("dynamic").fetch(request);
      if (request.method === "PUT" && /^\/v1\/market-icon\/[a-z][a-z0-9-]{0,63}$/.test(url.pathname)) return env.WORKSHOP.getByName("dynamic").fetch(request);
      if (request.method === "PUT" && /^\/v1\/market-media\/[a-z][a-z0-9-]{0,63}$/.test(url.pathname)) return env.WORKSHOP.getByName("dynamic").fetch(request);
      if ((request.method === "GET" || request.method === "HEAD") && /^\/v1\/avatars\/[a-f0-9-]{36}\/[a-f0-9]{64}$/.test(url.pathname)) return readAvatar(request, env);
      if (request.method === "PUT" && url.pathname === "/v1/catalog") return env.WORKSHOP.getByName("dynamic").fetch(request);
      if (request.method === "PUT" && /^\/v1\/application-blobs\/[a-z][a-z0-9-]{0,63}\/[a-f0-9]{64}$/.test(url.pathname)) return env.WORKSHOP.getByName("dynamic").fetch(request);
      if (request.method === "POST" && /^\/v1\/application-publisher\/[a-z][a-z0-9-]{0,63}$/.test(url.pathname)) return env.WORKSHOP.getByName("dynamic").fetch(request);
      if (request.method === "POST" && /^\/v1\/application-download\/[a-z][a-z0-9-]{0,63}$/.test(url.pathname)) return env.WORKSHOP.getByName("dynamic").fetch(request);
      if (/^\/v1\/applications\/[a-z][a-z0-9-]{0,63}\/(?:latest|candidate|public|releases\/[a-f0-9]{64})$/.test(url.pathname) || ["/v1/official-release", "/v1/application-source", "/v1/development-reset", "/v1/works", "/v1/market"].includes(url.pathname) || /^\/v1\/application-allocation\/[a-z][a-z0-9-]{0,63}$/.test(url.pathname)) return env.WORKSHOP.getByName("dynamic").fetch(request);
      if (request.method === "GET" && ["/v1/applications", "/v1/application-updates"].includes(url.pathname)) return env.WORKSHOP.getByName("dynamic").fetch(request);
      if (request.method === "POST" && url.pathname === "/v1/workshop") return env.WORKSHOP.getByName("dynamic").fetch(request);
      if (request.method === "POST" && url.pathname === "/v1/jules") {
        const operation = await request.clone().json() as { method?: string; path?: string };
        if (operation.path !== "/v1alpha/sources") return env.WORKSHOP.getByName("dynamic").fetch(request);
        if (!await authenticatedUser(request, env)) return json({ message: "请先登录后再创作" }, 401);
      }
      if (request.method === "POST" && url.pathname === "/v1/jules") return proxyJules(request, env);
      if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "not found" }, 404);
      if (url.pathname === "/v1/updates") return readUpdates(request, env);
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

type ApkRelease = { versionCode: number; versionName: string; sha256: string; bytes: number; runtimeVersion: string; source: { commit: string; dirty: boolean }; publishedAt: number };
async function readUpdates(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = Number(url.searchParams.get("apkVersionCode") || "0");
  if (!Number.isSafeInteger(code) || code < 0) return json({ message: "APK 版本无效" }, 400);
  const [release, apk] = await Promise.all([env.CATALOG.get("v1/release", "json"), env.CATALOG.get<ApkRelease>("v1/apk", "json")]);
  if (!release) return json({ message: "还没有线上版本" }, 404);
  const response = json({ release, apk: apk ? { ...apk, url: `https://zjh-cdn.297782.xyz/v1/apk/${apk.sha256}.apk` } : null, apkUpdate: !!apk && apk.versionCode > code }, 200);
  response.headers.set("Cache-Control", "no-store"); return response;
}

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
  headers.set("content-type", key.startsWith("v1/apk/") ? "application/vnd.android.package-archive" : "application/octet-stream");
  if (key.startsWith("v1/apk/")) headers.set("content-disposition", 'attachment; filename="zijinhua.apk"');
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
type ApplicationRelease = { icon?: { sha256: string; bytes: number; format: "svg" }; appId: string; releaseId: string; appName: string; description: string; accent: string; version: string; releaseNotes: string; modules: { base: number }; source: { repository: string; commit: string; tree?: string; applicationTree?: string; dirty: boolean } };
type WorkshopTask = { awaitingRoundStart?: boolean; deliveryWaitStartedAt?: number; branch?: string; branchCommit?: string; roundRelease?: string; dispatchVersion?: string; originalBranch?: string; ownerId: string; appId: string; session: string; token: string; phase: "working" | "ready" | "paused"; previousCommit?: string; repair?: boolean; publishEpoch?: string; requestId?: string; creationTitle?: string; creationRejected?: boolean; title?: string; wish?: string; originalAppId?: string; originalReleaseId?: string; originalCommit?: string; startedAt?: number };
type CloudSession = { name?: string; state?: string; url?: string; title?: string; createTime?: string; updateTime?: string; sourceContext?: { source?: string }; outputs?: { pullRequest?: { url?: string } }[] };
type WorkSummary = { completed: boolean; state: string; delivery: string; message: string; application?: ApplicationRelease; stale?: boolean };
function isRoundCandidate(task: WorkshopTask, application: ApplicationRelease | null): application is ApplicationRelease {
  return Boolean(application && (task.roundRelease ? task.roundRelease === application.releaseId : application.source.commit !== task.previousCommit));
}
function currentRoundSession(task: WorkshopTask, session: CloudSession, application: ApplicationRelease | null): CloudSession {
  if (task.phase === "ready" && isRoundCandidate(task, application)) return { ...session, state: "COMPLETED" };
  if (task.phase === "paused" || !task.dispatchVersion) return session;
  if (session.state === "COMPLETED" && isRoundCandidate(task, application)) return session;
  const version = `${session.state}:${session.updateTime ?? ""}`;
  const terminal = ["COMPLETED", "FAILED", "PAUSED", "AWAITING_USER_FEEDBACK"].includes(session.state || "");
  const previousState = task.dispatchVersion.split(":")[0];
  const oldTimestamp = Date.parse(session.updateTime || "") < (task.startedAt || 0);
  if (version === task.dispatchVersion || oldTimestamp || task.awaitingRoundStart && terminal && session.state === previousState && !isRoundCandidate(task, application))
    return { ...session, state: "QUEUED" };
  return session;
}
function observeRound(task: WorkshopTask, session: CloudSession, activities: unknown[] = []) {
  if (!task.awaitingRoundStart) return;
  const working = ["QUEUED", "PLANNING", "IN_PROGRESS", "AWAITING_PLAN_APPROVAL"].includes(session.state || "");
  const fresh = activities.some(value => {
    const activity = value as { createTime?: string; progressUpdated?: unknown; agentMessaged?: unknown; planGenerated?: unknown; sessionCompleted?: unknown; sessionFailed?: unknown };
    return Date.parse(activity.createTime || "") >= (task.startedAt || 0) && Boolean(activity.sessionCompleted || activity.sessionFailed || session.state === "AWAITING_USER_FEEDBACK" && activity.agentMessaged);
  });
  if (working || fresh) task.awaitingRoundStart = false;
}
function summarizeWork(task: WorkshopTask, session: CloudSession, application: ApplicationRelease | null): WorkSummary {
  session = currentRoundSession(task, session, application);
  if (task.phase === "paused") return { completed: false, state: session.state === "FAILED" ? "FAILED" : "PAUSED", delivery: "unpublished", message: session.state === "FAILED" ? "制作失败，可以在当前作品继续处理" : "制作已暂停，可以继续这个应用" };
  if (session.state !== "COMPLETED") return { completed: false, state: session.state ?? "QUEUED", delivery: "unpublished", message: ["FAILED", "PAUSED"].includes(session.state ?? "") ? "制作已暂停，可以继续处理" : "这轮作品仍在制作" };
  const ready = isRoundCandidate(task, application);
  if (!ready && task.deliveryWaitStartedAt && Date.now() - task.deliveryWaitStartedAt >= 120000) return { completed: true, state: "COMPLETED", delivery: "blocked", message: "Jolly 已结束制作，但本轮应用没有完成交付。可以在当前作品继续修复并重新发布。" };
  return { completed: true, state: "COMPLETED", delivery: ready ? "update" : "unpublished", message: ready ? "作品已发布，可直接体验、继续修改或上架" : "等待本轮候选包发布", ...(ready ? { application } : {}) };
}
const MARKET_CATEGORIES = ["tools", "productivity", "life", "creative", "other"];
type SourceProof = { commit: string; branch: string; tree?: string; applicationTree: string };
type MarketEntry = { downloadCount?: number; iconUrl?: string; manifest: ApplicationRelease; title: string; summary: string; category?: string; screenshots?: string[]; publishedAt?: number; authorId: string | null; authorName: string; authorAvatarUrl?: string | null; authorOfficial?: boolean; originalAppId: string | null; sourceCommit?: string; sourceBranch?: string };

export class Workshop extends DurableObject<Env> {
  private marketIndex = new MarketIndex(this.ctx);
  async canUseCloud(appId: string, userId: string): Promise<boolean> {
    if (this.resetting || !/^[a-z][a-z0-9-]{0,63}$/.test(appId)) return false;
    const [published, task] = await Promise.all([
      this.ctx.storage.get<MarketEntry>(`shared:${appId}`),
      this.ctx.storage.get<WorkshopTask>(`task:${appId}`),
    ]);
    return !!published || task?.ownerId === userId;
  }
  private monitoring: Promise<void> | undefined;
  private async armMonitor(delay = 60000) {
    const alarm = await this.ctx.storage.getAlarm();
    if (!alarm || alarm <= Date.now() || alarm > Date.now() + delay) await this.ctx.storage.setAlarm(Date.now() + delay);
  }
  private notices = new Set<Promise<void>>();
  private async notifyResult(task: WorkshopTask, success: boolean, message: string, kind?: "work-submitted") {
    if (this.resetting) return;
    const pending = this.sendResultNotice(task, success, message, kind);
    this.notices.add(pending);
    try { await pending; } finally { this.notices.delete(pending); }
  }
  private async sendResultNotice(task: WorkshopTask, success: boolean, message: string, kind?: "work-submitted") {
    const round = task.publishEpoch || task.requestId || task.session;
    if (!round) return;
    const event = kind || String(success);
    const key = `work-notice:${task.appId}:${round}:${event}`;
    const sentKey = `work-notice-sent:${task.appId}:${round}:${event}`;
    if (await this.ctx.storage.get(sentKey)) return;
    const payload = { ownerId: task.ownerId, appId: task.appId, round, success, kind, title: task.title || task.appId, message };
    await this.ctx.storage.put(key, payload);
    try {
      const response = await this.env.POSTS.getByName("timeline").fetch(new Request("https://posts.internal/internal/work-notice", { method: "POST", body: JSON.stringify(payload) }));
      if (!response.ok) throw new Error("通知暂未送达");
      await this.ctx.storage.put(sentKey, true);
      await this.ctx.storage.delete(key);
    } catch { await this.armMonitor(); }
  }
  async alarm() {
    if (this.monitoring) return this.monitoring;
    this.monitoring = this.retryNoticeOutbox().finally(() => { this.monitoring = undefined; });
    return this.monitoring;
  }
  private async retryNoticeOutbox() {
    if (this.resetting) return;
    const pending = await this.ctx.storage.list<{ ownerId: string; appId: string; round: string; success: boolean; kind?: "work-submitted"; title: string; message: string }>({ prefix: "work-notice:", limit: 100 });
    for (const [key, payload] of pending) {
      try {
        const response = await this.env.POSTS.getByName("timeline").fetch(new Request("https://posts.internal/internal/work-notice", { method: "POST", body: JSON.stringify(payload) }));
        if (response.ok) { await this.ctx.storage.put(key.replace("work-notice:", "work-notice-sent:"), true); await this.ctx.storage.delete(key); }
      } catch { /* The durable outbox is retried by the next alarm. */ }
    }
    // Only retry already-created notifications; never query Jules on a timer.
    await this.ctx.storage.delete("watch-cursor");
    const outbox = await this.ctx.storage.list({ prefix: "work-notice:", limit: 1 });
    if (outbox.size) await this.armMonitor();
  }
  private emitWork(ownerId: string, appId: string) {
    this.ctx.waitUntil(this.env.POSTS.getByName("timeline").fetch(new Request("https://posts.internal/internal/live-work", {
      method: "POST", body: JSON.stringify({ ownerId, appId }),
    })).catch(() => {}));
  }
  private activityPages = new Map<string, { version: string; at: number; page: { activities: unknown[]; nextPageToken?: string } }>();
  private summaries = new Map<string, Promise<void>>();
  private summarySlots = new KeyedQueue();
  private summarySlot = 0;
  private summaryKey(task: WorkshopTask, application: ApplicationRelease | null) { return JSON.stringify([task.appId, task.ownerId, task.session, task.publishEpoch, task.awaitingRoundStart, task.phase, task.previousCommit, task.roundRelease, application?.releaseId]); }
  private refreshSummary(task: WorkshopTask, application: ApplicationRelease | null): Promise<void> {
    const key = this.summaryKey(task, application);
    const previous = this.summaries.get(key); if (previous) return previous;
    const pending = this.summarySlots.run(`slot:${this.summarySlot++ % 4}`, async () => {
      try {
        if (!task.session) {
          if (task.creationTitle) await this.queue.run(`app:${task.appId}`, async () => {
            const current = await this.ctx.storage.get<WorkshopTask>(`task:${task.appId}`);
            if (current?.ownerId === task.ownerId && !current.session) await this.recoverSession(current);
          });
          return;
        }
        const cached = task.phase === "paused" ? await this.ctx.storage.get<{ key: string; status: WorkSummary }>(`work-summary:${task.appId}`) : undefined;
        const session: CloudSession = task.phase === "paused" ? { state: cached?.key === key && cached.status.state === "FAILED" ? "FAILED" : "PAUSED" } : await this.session(task.session);
        const activities = task.awaitingRoundStart && ["COMPLETED", "FAILED", "PAUSED", "AWAITING_USER_FEEDBACK"].includes(session.state || "") ? (await this.recentActivities({ ...session, name: task.session })).activities : [];
        await this.queue.run(`app:${task.appId}`, async () => {
          const current = await this.ctx.storage.get<WorkshopTask>(`task:${task.appId}`);
          const candidate = await this.candidate(task.appId);
          if (!current || this.resetting || this.summaryKey(current, candidate) !== key) return;
          const waiting = current.awaitingRoundStart;
          observeRound(current, session, activities);
          if (waiting !== current.awaitingRoundStart) await this.saveTask(current);
          const effectiveSession = currentRoundSession(current, session, candidate);
          if (effectiveSession.state === "COMPLETED" && !isRoundCandidate(current, candidate) && !current.deliveryWaitStartedAt) { current.deliveryWaitStartedAt = Date.now(); await this.saveTask(current); }
          const status = summarizeWork(current, effectiveSession, candidate);
          if (effectiveSession.state === "FAILED") await this.notifyResult(current, false, "制作失败了。点击查看制作记录，可以继续修复这个作品。");
          const phase = status.completed ? status.application ? "ready" : "working" : ["FAILED", "PAUSED"].includes(status.state) ? "paused" : current.phase;
          const title = status.application?.appName || current.title;
          if (current.phase !== phase || current.title !== title) {
            current.phase = phase; current.title = title;
            if (phase === "paused") current.repair = true;
            await this.saveTask(current);
          }
          await this.ctx.storage.put(`work-summary:${task.appId}`, { key: this.summaryKey(current, candidate), at: Date.now(), status });
          if (status.completed && status.application) await this.notifyResult(current, true, "制作完成，作品已准备好。点击查看、体验或继续修改。");
          if (status.delivery === "blocked") await this.notifyResult(current, false, status.message);
        });
      } catch { /* Preserve the last result; the list marks expired data stale. */ }
    }).finally(() => this.summaries.delete(key));
    this.summaries.set(key, pending); return pending;
  }
  private queue = new KeyedQueue();
  private resetting = false;
  private writes = new Set<Promise<Response>>();
  async fetch(request: Request): Promise<Response> {
    await this.marketIndex.ensure();
    if (new URL(request.url).pathname === "/v1/development-reset") return this.reset(request);
    if (this.resetting) return json({ message: "开发数据正在重置，请稍后重试" }, 503);
    const path = new URL(request.url).pathname;
    const pending = ["GET", "HEAD"].includes(request.method) && !path.startsWith("/v1/application-allocation/") ? this.handle(request) : this.write(request, path); this.writes.add(pending);
    try { return await pending; } finally { this.writes.delete(pending); }
  }
  private async reset(request: Request): Promise<Response> {
    if (request.method !== "POST" || !await authorized(request, this.env.OFFICIAL_PUBLISH_TOKEN)) return json({ error: "unauthorized" }, 403);
    const input = await request.json() as { confirm?: string; scope?: string; dryRun?: boolean };
    if (input.scope !== undefined && input.scope !== "applications") return json({ message: "清理范围无效" }, 400);
    if (input.confirm !== "RESET_WORKSHOP_DEVELOPMENT_DATA") return json({ message: "需要明确的开发清库指令" }, 400);
    if (this.resetting) return json({ message: "重置已在进行" }, 409);
    this.resetting = true;
    try {
      await Promise.allSettled([...this.writes, ...this.summaries.values(), ...(this.monitoring ? [this.monitoring] : [])]);
      await Promise.allSettled([...this.notices]);
      // Jolly lives in the host. No plugin application needs to be retained.
      const tasks = [...(await this.ctx.storage.list<WorkshopTask>({ prefix: "task:" })).values()];
      const candidates = [...(await this.ctx.storage.list<ApplicationRelease>({ prefix: "candidate:" })).values()];
      const applications = [...new Set([...tasks, ...candidates].map(item => item.appId))];
      if (input.dryRun) return json({ applications, branches: [...new Set(tasks.map(task => task.branch).filter(Boolean))], retainedApplications: [] }, 200);
      let accounts: unknown;
      if (input.scope !== "applications") {
        const accountReset = await this.env.ACCOUNTS.getByName("accounts").fetch(new Request("https://account.internal/internal/development-reset", { method: "POST" }));
        if (!accountReset.ok) return json({ message: "账户清理未完成，请重试" }, 503);
        accounts = await accountReset.json();
        const postsReset = await this.env.POSTS.getByName("timeline").fetch(new Request("https://posts.internal/internal/development-reset", { method: "POST" }));
        if (!postsReset.ok) return json({ message: "用户动态清理未完成，请重试" }, 503);
      }
      let cursor: string | undefined; let count = 0;
      do {
        const page = await this.env.CATALOG.list({ prefix: "v1/applications/", cursor });
        for (const key of page.keys) {
          await this.env.CATALOG.delete(key.name); count++;
        }
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      await this.ctx.storage.deleteAll();
      this.marketIndex = new MarketIndex(this.ctx);
      await this.ctx.storage.deleteAlarm();
      for (const task of tasks) this.emitWork(task.ownerId, task.appId);
      return json({ reset: true, scope: input.scope ?? "all", accounts, deletedApplications: applications, deletedApplicationCatalogs: count, retainedApplications: [] }, 200);
    } finally { this.resetting = false; }
  }
  private async write(request: Request, path: string): Promise<Response> {
    if (path === "/v1/creation-media" || path.startsWith("/v1/market-media/") || path.startsWith("/v1/market-icon/") || path.startsWith("/v1/feedback-media/")) return this.queue.runAll([`app:${path.split("/")[3] ?? "creation"}`, "media-buffer"], () => this.handle(request));
    if (path.startsWith("/v1/application-blobs/")) {
      const appId = path.split("/")[3];
      if (!await this.publisher(request, appId)) return json({ message: "本轮发布授权已失效" }, 403);
      // Hash verification buffers up to 40 MB; serialize buffers to fit the Worker memory limit.
      return this.queue.runAll([`app:${appId}`, "upload-buffer"], () => this.handle(request));
    }
    try {
      const raw = await request.clone().text();
      if (raw.length > (path === "/v1/catalog" ? 8_000_000 : 210_000)) return json({ message: "请求内容过大" }, 413);
      const input = (raw ? JSON.parse(raw) : {}) as { appId?: string; objects?: CatalogObject[]; remixAppIds?: string[] };
      if (path === "/v1/application-source" && input.remixAppIds && (!Array.isArray(input.remixAppIds) || input.remixAppIds.length > 50 || input.remixAppIds.some(id => !/^[a-z][a-z0-9-]{0,63}$/.test(id)))) return json({ message: "源码修复任务无效" }, 400);
      const ids = path === "/v1/catalog" ? (input.objects ?? []).map(item => String(item.key).match(/^v1\/applications\/([^/]+)\//)?.[1]).filter((id): id is string => Boolean(id)) : path === "/v1/application-source" ? [input.appId ?? "unknown", ...input.remixAppIds || []] : [input.appId ?? path.split("/").pop() ?? "unknown"];
      return this.queue.runAll(ids.length ? ids.map(id => `app:${id}`) : ["host"], () => this.handle(request));
    } catch { return json({ message: "请求格式不正确" }, 400); }
  }
  private async publisher(request: Request, appId: string): Promise<boolean> {
    if (await authorized(request, this.env.OFFICIAL_PUBLISH_TOKEN)) return true;
    const grant = await readPublisherGrant(request, this.env.OFFICIAL_PUBLISH_TOKEN);
    if (!grant || grant.appId !== appId) return false;
    const task = await this.ctx.storage.get<WorkshopTask>(`task:${appId}`);
    return publisherGrantActive(grant, task);
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
      await storage.delete(`watch:${task.appId}`);
      const quota = await storage.get<{ day: number; count: number; reservations?: Record<string, number> }>(`quota:${task.ownerId}`);
      if (quota?.reservations?.[task.appId]) { delete quota.reservations[task.appId]; await storage.put(`quota:${task.ownerId}`, quota); }
    });
  }
  private async publisherInstruction(task: WorkshopTask, initialize = false) {
    const grant = await issuePublisherGrant({ appId: task.appId, ownerId: task.ownerId, epoch: task.publishEpoch! }, this.env.OFFICIAL_PUBLISH_TOKEN);
    const preparation = initialize
      ? `初始化：npm run init:application -- ${task.appId} '${grant}'。不要发布初始化模板。`
      : `先更新本轮授权：npm exec -- zjh-app authorize ${task.appId} '${grant}'。无需重新初始化应用。`;
    return `${preparation} 完成开发并更新 application.json 后，必须执行 npm run publish:application -- ${task.appId}。只有返回 published: true 才能报告完成；发布失败须修复并重试，无法解决时明确说明尚未发布及阻塞原因。授权由工具保存在本地，不得在回复、日志或代码中复述授权。`;
  }
  private async recoverSession(task: WorkshopTask): Promise<WorkshopTask> {
    if (task.session || !task.creationTitle) return task;
    let pageToken = "";
    for (let page = 0; page < 10; page++) {
      const response = await fetch(`https://jules.googleapis.com/v1alpha/sessions?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`, { headers: { "X-Goog-Api-Key": this.env.JULES_API_KEY }, signal: AbortSignal.timeout(6000) });
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
    const response = await fetch(`https://jules.googleapis.com/v1alpha/${name}`, { headers: { "X-Goog-Api-Key": this.env.JULES_API_KEY }, signal: AbortSignal.timeout(6000) });
    if (!response.ok) throw new Error("暂时无法连接这个应用的 session");
    const session = await response.json() as CloudSession;
    if (session.sourceContext?.source !== PLUGIN_SOURCE) throw new Error("Session 仓库不匹配");
    return session;
  }
  private async activities(name: string, pageToken = "") {
    const query = new URLSearchParams({ pageSize: "100" });
    if (pageToken) query.set("pageToken", pageToken);
    const response = await fetch(`https://jules.googleapis.com/v1alpha/${name}/activities?${query}`, { headers: { "X-Goog-Api-Key": this.env.JULES_API_KEY, "X-Goog-FieldMask": ACTIVITY_MASK }, signal: AbortSignal.timeout(6000) });
    if (!response.ok) throw new Error("制作记录暂时无法同步，请重试");
    return JSON.parse(redactPublisherGrants(await response.text())) as { activities?: unknown[]; nextPageToken?: string };
  }
  private async recentActivities(session: CloudSession) {
    const name = session.name!; const version = `${session.state}:${session.updateTime || ""}`;
    const cached = this.activityPages.get(name);
    if (cached && (!session.state || cached.version === version) && Date.now() - cached.at < 30000) return { ...cached.page, stale: false };
    const activities: unknown[] = []; let nextPageToken: string | undefined;
    // Jules exposes pagination but no documented ordering/filter. Preserve the
    // existing four-page bound; remaining records are explicitly pageable.
    try {
      for (let index = 0; index < 4; index++) {
        const page = await this.activities(name, nextPageToken);
        activities.push(...page.activities || []); nextPageToken = page.nextPageToken;
        if (!nextPageToken) break;
      }
      const page = { activities, nextPageToken };
      if (this.activityPages.size >= 32) this.activityPages.delete(this.activityPages.keys().next().value!);
      this.activityPages.set(name, { version, at: Date.now(), page });
      return { ...page, stale: false };
    } catch { return { ...(cached?.page ?? { activities }), stale: true }; }
  }
  private async progressActivities(task: WorkshopTask, session: CloudSession) {
    type Activity = { createTime?: string; agentMessaged?: { agentMessage?: string } };
    const key = `progress-output:${task.appId}`;
    const round = `${task.session}:${task.requestId}:${task.startedAt}`;
    const version = `${session.state}:${session.updateTime}`;
    const cached = await this.ctx.storage.get<{round: string; version: string; at: number; reply?: Activity}>(key);
    if (cached?.round === round && cached.version === version && (session.updateTime || Date.now() - cached.at < 30000)) return {activities: cached.reply ? [cached.reply] : [], stale: false};
    let reply = cached?.round === round ? cached.reply : undefined;
    try {
      let cursor: string | undefined; const seen = new Set<string>();
      do {
        const page = await this.activities(task.session, cursor);
        for (const value of page.activities || []) {
          const activity = value as Activity;
          if (activity.agentMessaged?.agentMessage?.trim() && Date.parse(activity.createTime || "") >= (task.startedAt || 0) && (!reply || (activity.createTime || "") >= (reply.createTime || ""))) reply = activity;
        }
        cursor = page.nextPageToken;
        if (cursor && seen.has(cursor)) throw new Error("制作记录游标重复");
        if (cursor) seen.add(cursor);
      } while (cursor);
      await this.ctx.storage.put(key, {round, version, at: Date.now(), reply});
      return {activities: reply ? [reply] : [], stale: false};
    } catch { return {activities: reply ? [reply] : [], stale: true}; }
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
  private async sourceTree(commit: string, appId: string): Promise<{ tree: string; applicationTree: string } | undefined> {
    const root = await this.github(`git/trees/${commit}?recursive=1`);
    const entry = root.tree?.find((item: { path?: string; type?: string }) => item.path === `apps/${appId}` && item.type === "tree");
    return entry?.sha ? { tree: root.sha, applicationTree: entry.sha } : undefined;
  }
  private async rememberSource(application: ApplicationRelease, proof: SourceProof) {
    // Source discovery can finish after the author has already shared a release.
    await this.ctx.storage.transaction(async storage => {
      await storage.put(`source-proof:${application.appId}:${application.releaseId}`, proof);
      const shared = await storage.get<MarketEntry>(`shared:${application.appId}`);
      if (shared?.manifest.releaseId === application.releaseId) {
        await storage.put(`shared:${application.appId}`, { ...shared, sourceCommit: proof.commit, sourceBranch: proof.branch });
      }
    });
  }
  private async recordBranch(task: WorkshopTask, session: CloudSession, application: ApplicationRelease) {
    const proof = await this.ctx.storage.get<SourceProof>(`source-proof:${task.appId}:${application.releaseId}`);
    if (proof?.branch && proof.applicationTree && (application.source.applicationTree
      ? proof.applicationTree === application.source.applicationTree
      : proof.tree === application.source.tree)) {
      await this.rememberSource(application, proof);
      task.branch = proof.branch; task.branchCommit = proof.commit;
      await this.saveTask(task); return;
    }
    const urls = session.outputs?.map(output => output.pullRequest?.url).filter((url): url is string => /^https:\/\/github\.com\/jiangfengwhu\/zjh-plugin\/pull\/[0-9]+$/.test(url ?? "")) ?? [];
    for (const url of urls.reverse()) {
      const pr = await this.github(`pulls/${Number(url.split("/").pop())}`);
      if (pr.head?.repo?.full_name !== "jiangfengwhu/zjh-plugin" || !pr.head.ref || pr.head.ref === "main" || !pr.head.sha) continue;
      const commits: string[] = [pr.head.sha];
      if (application.source.applicationTree) {
        const history = await this.github(`commits?sha=${encodeURIComponent(pr.head.ref)}&path=${encodeURIComponent("apps/" + task.appId)}&per_page=20`);
        commits.push(...history.map((item: { sha: string }) => item.sha));
      }
      for (const commit of new Set(commits)) {
        const source = await this.sourceTree(commit, task.appId);
        if (!source) continue;
        const matches = application.source.applicationTree ? source.applicationTree === application.source.applicationTree
          : application.source.tree ? source.tree === application.source.tree : !application.source.dirty && application.source.commit === commit;
        if (!matches) continue;
        await this.rememberSource(application, { commit, branch: pr.head.ref, ...source });
        task.branch = pr.head.ref; task.branchCommit = commit;
        await this.saveTask(task); return;
      }
    }
  }
  private async remixSource(shared: MarketEntry): Promise<SourceProof> {
    let proof = await this.ctx.storage.get<SourceProof>(`source-proof:${shared.manifest.appId}:${shared.manifest.releaseId}`);
    if (!proof?.branch || !proof.applicationTree) {
      await this.queue.run(`app:${shared.manifest.appId}`, async () => {
        const original = await this.ctx.storage.get<WorkshopTask>(`task:${shared.manifest.appId}`);
        if (original?.session) await this.recordBranch(original, await this.session(original.session), shared.manifest);
      });
      proof = await this.ctx.storage.get<SourceProof>(`source-proof:${shared.manifest.appId}:${shared.manifest.releaseId}`);
    }
    if (!proof?.branch || !proof.applicationTree) throw new Error("原作公开版本的源码尚未定位，请稍后重试或联系作者；不会从 main 创建改编");
    const comparison = await this.github(`compare/${proof.commit}...${encodeURIComponent(proof.branch)}`);
    if (!["identical", "ahead"].includes(comparison.status)) throw new Error("原作分支已改变，无法定位公开版本，请联系作者");
    await this.rememberSource(shared.manifest, proof);
    return proof;
  }
  private async delivery(task: WorkshopTask, _session: CloudSession) {
    const application = await this.candidate(task.appId);
    if (!isRoundCandidate(task, application)) return undefined;
    try { await this.recordBranch(task, _session, application); } catch { /* A candidate is usable without PR metadata or GitHub availability. */ }
    return { ready: true, application, message: "" };
  }
  private async handle(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/internal/application-icons" && request.method === "GET") {
        const ids = [...new Set((new URL(request.url).searchParams.get("ids") || "").split(","))];
        if (!ids.length || ids.length > 30 || ids.some(id => !/^[a-z][a-z0-9-]{0,63}$/.test(id))) return json({ message: "应用标识无效" }, 400);
        const entries = await this.ctx.storage.get<MarketEntry | string>(ids.flatMap(id => [`shared:${id}`, `application-icon:${id}`]));
        return json({ icons: ids.flatMap(appId => {
          const item = entries.get(`shared:${appId}`) as MarketEntry | undefined;
          return item ? [{ appId, available: true, releaseId: item.manifest.releaseId, title: item.title || item.manifest.appName, summary: item.summary || item.manifest.description, accent: item.manifest.accent, icon: item.manifest.icon, iconUrl: entries.get(`application-icon:${appId}`) || item.iconUrl }] : [{appId, available: false}];
        }) }, 200);
      }

      if (path === "/v1/application-updates" && request.method === "GET") {
        const ids = [...new Set((new URL(request.url).searchParams.get("ids") || "").split(","))];
        if (!ids.length || ids.length > 100 || ids.some(id => !/^[a-z][a-z0-9-]{0,63}$/.test(id))) return json({ message: "应用列表无效" }, 400);
        const entries = await this.ctx.storage.get<MarketEntry>(ids.map(id => `shared:${id}`));
        const response = json({ applications: ids.map(appId => ({ appId, manifest: entries.get(`shared:${appId}`)?.manifest ?? null })) }, 200);
        response.headers.set("Cache-Control", "no-store"); return response;
      }
      if ((path === "/v1/creation-media" || path.startsWith("/v1/market-media/") || path.startsWith("/v1/market-icon/") || path.startsWith("/v1/feedback-media/")) && request.method === "PUT") {
        const icon = path.startsWith("/v1/market-icon/");
        const creation = path === "/v1/creation-media";
        const feedback = path.startsWith("/v1/feedback-media/");
        const appId = path.split("/")[3]; const releaseId = feedback ? path.split("/")[4] : undefined;
        const user = await authenticatedUser(request, this.env);
        if (!user) return json({ message: "请先登录" }, 401);
        const task = await this.ctx.storage.get<WorkshopTask>(`task:${appId}`);
        if (feedback) {
          const owned = task?.ownerId === user.id;
          const publicVersion = await this.ctx.storage.get<boolean>(`published:${appId}:${releaseId}`);
          if (!owned && !publicVersion) return json({ message: "只能为自己的作品或公开版本附带反馈截图" }, 403);
          const candidate = await this.candidate(appId);
          if (candidate?.releaseId !== releaseId && !await this.env.CATALOG.get(`v1/applications/${appId}/releases/${releaseId}`)) return json({ message: "体验版本不存在，请重新打开应用" }, 404);
        } else if (!creation && (!task || task.ownerId !== user.id || request.headers.get("X-Workshop-Token") !== task.token)) return json({ message: "只能上传自己作品的截图" }, 403);
        const day = Math.floor(Date.now() / 86400000); const rateKey = `market-media-rate:${user.id}`;
        const rate = await this.ctx.storage.get<{ day: number; count: number }>(rateKey);
        const count = rate?.day === day ? rate.count : 0;
        if (count >= 60) return json({ message: "今天上传的截图较多，请明天再试" }, 429);
        // Reserve the account-wide quota atomically across different application queues.
        const reserved = await this.ctx.storage.transaction(async storage => {
          const prior = await storage.get<{ day: number; count: number }>(rateKey);
          const value = prior?.day === day ? prior.count : 0;
          if (value >= 60) return false;
          await storage.put(rateKey, { day, count: value + 1 }); return true;
        });
        if (!reserved) return json({ message: "今天上传的截图较多，请明天再试" }, 429);
        const maximum = icon ? 256 * 1024 : 2 * 1024 * 1024;
        if (Number(request.headers.get("Content-Length")) > maximum) return json({ message: "截图需小于 2 MB" }, 413);
        const reader = request.body?.getReader(); if (!reader) return json({ message: "没有截图文件" }, 400);
        const chunks: Uint8Array[] = []; let size = 0;
        while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > maximum) { await reader.cancel(); return json({ message: "截图需小于 2 MB" }, 413); } chunks.push(next.value); }
        const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        if (size < 32 || bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255) return json({ message: "截图需为 JPEG 图片" }, 400);
        if (icon && !validIconJpeg(bytes)) return json({ message: "图标需要压缩为 512×512 的 JPEG，且不超过 256 KB" }, 400);
        const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
        const key = creation ? `v1/creation-images/${user.id}/${hash}` : `v1/${feedback ? "feedback-images" : icon ? "market-icons" : "market-images"}/${appId}/${user.id}/${hash}`;
        await this.env.BLOBS.put(key, bytes, { httpMetadata: { contentType: "image/jpeg", cacheControl: "public,max-age=31536000,immutable" } });
        const iconUrl = `${new URL(request.url).origin}/${key}`;
        if (icon) {
          await this.ctx.storage.put(`application-icon:${appId}`, iconUrl);
          const shared = await this.ctx.storage.get<MarketEntry>(`shared:${appId}`);
          if (shared?.authorId === user.id) await this.ctx.storage.put(`shared:${appId}`, { ...shared, iconUrl });
          this.emitWork(user.id, appId);
        }
        return json({ url: iconUrl }, 200);
      }
      const publisherRoute = path.match(/^\/v1\/application-publisher\/([a-z][a-z0-9-]{0,63})$/);
      if (publisherRoute && request.method === "POST") {
        const grant = await readPublisherGrant(request, this.env.OFFICIAL_PUBLISH_TOKEN);
        const task = await this.ctx.storage.get<WorkshopTask>(`task:${publisherRoute[1]}`);
        if (!grant || grant.appId !== publisherRoute[1] || !publisherGrantActive(grant, task)) return json({ message: "本轮发布授权已失效，请在生花继续制作后使用新任务提供的发布命令" }, 403);
        const token = await issuePublisherGrant({ appId: grant.appId, ownerId: grant.ownerId, epoch: grant.epoch }, this.env.OFFICIAL_PUBLISH_TOKEN, Math.min(30 * 60000, grant.expiresAt - Date.now()));
        const response = json({ token }, 200);
        response.headers.set("Cache-Control", "no-store");
        return response;
      }
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
      if (path === "/v1/application-source" && request.method === "POST") {
        if (!await authorized(request, this.env.OFFICIAL_PUBLISH_TOKEN)) return json({ message: "维护者权限不足" }, 403);
        const input = await request.json() as { appId?: string; releaseId?: string; commit?: string; branch?: string; rebuiltBundleSha256?: string; rebuiltAssets?: Array<{ name: string; sha256: string; bytes: number }>; remixAppIds?: string[] };
        const { appId, releaseId, commit, branch } = input;
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(appId || "") || !/^[a-f0-9]{64}$/.test(releaseId || "") || !/^[a-f0-9]{40}$/.test(commit || "") || !branch || branch.length > 200 || input.remixAppIds && (!Array.isArray(input.remixAppIds) || input.remixAppIds.length > 50 || input.remixAppIds.some(id => !/^[a-z][a-z0-9-]{0,63}$/.test(id)))) return json({ message: "源码修复参数无效" }, 400);
        const shared = await this.ctx.storage.get<MarketEntry>(`shared:${appId}`);
        if (!shared || shared.manifest.releaseId !== releaseId) return json({ message: "公开版本已改变，请重新核对" }, 409);
        const application = shared.manifest;
        const source = await this.sourceTree(commit!, appId!);
        if (!source) return json({ message: "提交中没有该应用源码" }, 409);
        const comparison = await this.github(`compare/${commit}...${encodeURIComponent(branch)}`);
        if (!["identical", "ahead"].includes(comparison.status)) return json({ message: "指定分支不包含源码提交" }, 409);
        const matches = application.source.applicationTree ? source.applicationTree === application.source.applicationTree
          : application.source.tree ? source.tree === application.source.tree : !application.source.dirty && application.source.commit === commit;
        if (!matches) {
          // Legacy releases captured an unpushed whole-repository tree. Only a
          // maintainer who reproduced the bundle AND every asset may repair it.
          const artifacts = application as ApplicationRelease & { bundle: { sha256: string }; assets: Array<{ name: string; sha256: string; bytes: number }> };
          const assets = (items: typeof artifacts.assets) => JSON.stringify(items.map(({ name, sha256, bytes }) => ({ name, sha256, bytes })).sort((a, b) => a.name.localeCompare(b.name)));
          if (application.source.applicationTree || input.rebuiltBundleSha256 !== artifacts.bundle.sha256 || !Array.isArray(input.rebuiltAssets) || assets(input.rebuiltAssets) !== assets(artifacts.assets)) return json({ message: "源码未匹配；旧版本需先重建并核对包体与全部资源" }, 409);
        }
        await this.rememberSource(application, { commit: commit!, branch, ...source, tree: application.source.tree });
        const repairedRemixes: string[] = [];
        for (const id of input.remixAppIds || []) {
          const task = await this.ctx.storage.get<WorkshopTask>(`task:${id}`);
          if (task?.originalAppId !== appId || task.originalReleaseId !== releaseId) continue;
          task.originalCommit = commit; task.originalBranch = branch;
          await this.saveTask(task); repairedRemixes.push(id);
        }
        return json({ repaired: true, appId, releaseId, commit, branch, applicationTree: source.applicationTree, repairedRemixes }, 200);
      }
      if (path.startsWith("/v1/application-allocation/")) {
        const appId = path.split("/").pop()!;
        const manager = await this.publisher(request, appId);
        if (request.method === "POST" && !manager) return json({ error: "unauthorized" }, 401);
        if (!["GET", "POST"].includes(request.method)) return json({ error: "method" }, 405);
        const base = request.method === "POST" ? await this.allocate(appId) : await this.ctx.storage.get<number>(`allocation:${appId}`);
        const task = await this.ctx.storage.get<WorkshopTask>(`task:${appId}`);
        if (manager && task?.originalAppId) {
          const proof = await this.ctx.storage.get<SourceProof>(`source-proof:${task.originalAppId}:${task.originalReleaseId}`);
          if (!proof?.branch || !proof.applicationTree) return json({ message: "原作公开版本的源码尚未定位，请联系作者或维护者" }, 409);
          if (task.originalCommit !== proof.commit || task.originalBranch !== proof.branch) {
            task.originalCommit = proof.commit; task.originalBranch = proof.branch;
            await this.saveTask(task);
          }
        }
        const origin = manager ? { title: task?.title, originalAppId: task?.originalAppId, originalReleaseId: task?.originalReleaseId, originalCommit: task?.originalCommit, originalBranch: task?.originalBranch, branch: task?.branch } : {};
        return base ? json({ appId, moduleBase: base, ...origin }, 200) : json({ error: "请先在 Jolly 创建这个应用的心愿" }, 404);
      }
      if ((path === "/v1/market" || path === "/v1/applications") && request.method === "GET") {
        const params = new URL(request.url).searchParams;
        const appId = params.get("appId"); const authorId = params.get("authorId");
        const category = params.get("category") || ""; const query = (params.get("q") || "").trim().toLowerCase();
        if (category && category !== "official" && !MARKET_CATEGORIES.includes(category) || query.length > 80) return json({ message: "市场筛选无效" }, 400);
        if (authorId && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(authorId)) return json({ error: "author id invalid" }, 400);
        if (appId && !/^[a-z][a-z0-9-]{0,63}$/.test(appId)) return json({ error: "application id invalid" }, 400);
        if (path === "/v1/market" && appId && params.get("detail") === "1") {
          const viewer = request.headers.has("Authorization") ? await authenticatedUser(request, this.env) : null;
          const [published, task, downloads, iconUrl] = await Promise.all([
            this.ctx.storage.get<MarketEntry>(`shared:${appId}`), this.ctx.storage.get<WorkshopTask>(`task:${appId}`),
            this.ctx.storage.get<number>(`downloads:${appId}`), this.ctx.storage.get<string>(`application-icon:${appId}`)
          ]);
          const owned = !!viewer && task?.ownerId === viewer.id;
          const candidate = owned ? await this.candidate(appId) : null;
          const manifest = published?.manifest ?? candidate;
          if (!manifest || appId === "jolly") return json({ message: "这个应用已撤回或暂未上架" }, 404);
          const authorId = published?.authorId ?? task?.ownerId;
          const profiles = authorId ? await publicProfiles([authorId], this.env).catch(() => new Map()) : new Map();
          const author = authorId ? profiles.get(authorId) : undefined;
          const item = { ...published, manifest, title: published?.title ?? manifest.appName, summary: published?.summary ?? manifest.description,
            authorId, authorName: author?.name ?? published?.authorName ?? "创作者", authorAvatarUrl: author?.avatarUrl ?? published?.authorAvatarUrl,
            originalAppId: published?.originalAppId ?? task?.originalAppId ?? null, downloadCount: downloads ?? 0, iconUrl: iconUrl ?? published?.iconUrl, owned,
            sharing: owned ? { shared: published?.authorId === viewer!.id ? published : null, application: candidate, iconUrl } : undefined };
          const response = json({ item }, 200); response.headers.set("Cache-Control", "private,no-store"); return response;
        }
        const paged = params.has("limit") || params.has("cursor");
        const limit = Number(params.get("limit") || "24");
        if (paged && (!Number.isInteger(limit) || limit < 1 || limit > 50)) return json({ message: "分页大小无效" }, 400);
        let after: { at: number; id: string } | undefined;
        if (params.has("cursor")) {
          try { const parsed = JSON.parse(atob(params.get("cursor")!)); if (parsed.filter !== JSON.stringify([category, encodeURIComponent(query), authorId, appId]) || !Number.isSafeInteger(parsed.at) || parsed.at < 0 || !/^[a-z][a-z0-9-]{0,63}$/.test(parsed.id)) throw new Error(); after = parsed; }
          catch { return json({ message: "分页游标无效，请刷新列表" }, 400); }
        }
        const selection = this.marketIndex.page({ appId, authorId, category, query, after, limit: paged ? limit + 1 : undefined });
        if (params.get("view") === "count") return json({ applications: [], totalCount: selection.total }, 200);
        const rows = paged ? selection.rows.slice(0, limit) : selection.rows;
        const records = rows.length ? await getMany<MarketEntry>(this.ctx.storage, rows.map(row => `shared:${row.app_id}`)) : new Map<string, MarketEntry>();
        const visible = rows.flatMap(row => { const entry = records.get(`shared:${row.app_id}`); return entry ? [{ ...entry, authorOfficial: entry.authorId === OFFICIAL_ACCOUNT_ID }] : []; });
        const last = rows.at(-1);
        const nextCursor = paged && last && selection.rows.length > limit ? btoa(JSON.stringify({ at: last.at, id: last.app_id, filter: JSON.stringify([category, encodeURIComponent(query), authorId, appId]) })) : undefined;
        // Independent public enrichments share one wait; profile failures keep snapshots usable.
        const [profiles, counts] = await Promise.all([
          publicProfiles([...new Set(visible.map(entry => entry.authorId).filter((id): id is string => Boolean(id)))], this.env).catch(() => new Map()),
          path === "/v1/market" && visible.length ? getMany<number>(this.ctx.storage, visible.map(entry => `downloads:${entry.manifest.appId}`)) : Promise.resolve(new Map<string, number>())
        ]);
        for (const entry of visible) {
          const profile = entry.authorId ? profiles.get(entry.authorId) : undefined;
          if (profile) { entry.authorName = profile.name; entry.authorAvatarUrl = profile.avatarUrl; }
          if (path === "/v1/market") entry.downloadCount = counts.get(`downloads:${entry.manifest.appId}`) ?? 0;
        }
        const compact = ["picker", "summary"].includes(params.get("view") || "");
        const applications = path === "/v1/applications" ? visible.map(entry => entry.manifest) : compact ? visible.map(entry => ({ ...entry, summaryOnly: true, screenshots: undefined, manifest: { version: entry.manifest.version, releaseNotes: entry.manifest.releaseNotes, appId: entry.manifest.appId, releaseId: entry.manifest.releaseId, appName: entry.manifest.appName, description: entry.manifest.description, accent: entry.manifest.accent, icon: entry.manifest.icon } })) : visible;
        const response = json({ applications, nextCursor, totalCount: selection.total }, 200);
        response.headers.set("Cache-Control", "no-store"); return response;
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
          if (manifest.appId !== match[1] || typeof manifest.source?.dirty !== "boolean" || !/^[a-f0-9]{64}$/.test(manifest.releaseId) || !Number.isSafeInteger(base) || base < 2000000 || base % 100000 || manifest.modules.size !== 100000) return json({ error: "application manifest invalid" }, 400);
          const document = JSON.parse(item.body);
          const { releaseId, ...content } = document;
          const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(content)));
          const identity = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
          if ((document.source.dirty || document.source.tree !== undefined) && !/^[a-f0-9]{40}$/.test(document.source.tree)) return json({ error: "application source tree invalid" }, 400);
          if (identity !== releaseId || document.format !== 1 || !/^[a-f0-9]{40}$/.test(document.source.commit) || !/^\d+\.\d+\.\d+$/.test(document.sdk ?? "") || document.requires !== undefined) return json({ error: "application integrity invalid" }, 400);
          if (document.source.repository !== "jiangfengwhu/zjh-plugin" || document.dataSchemaVersion !== 1) return json({ error: "application source or data schema invalid" }, 400);
          if (document.source.applicationTree !== undefined && !/^[a-f0-9]{40}$/.test(document.source.applicationTree)) return json({ error: "application source snapshot invalid" }, 400);
          for (const blob of [document.bundle, ...(document.assets ?? [])]) {
            if (!blob || !/^[a-f0-9]{64}$/.test(blob.sha256) || !Number.isSafeInteger(blob.bytes) || blob.bytes < 0 || (blob === document.bundle && !blob.bytes)) return json({ error: "application blob invalid" }, 400);
            const stored = await this.env.BLOBS.head(`v1/app/${blob.sha256}`);
            if (!stored || stored.size !== blob.bytes) return json({ error: "application blob not uploaded" }, 409);
          }
          if (document.icon) {
            const icon = document.icon;
            if (icon.format !== "svg" || !document.assets?.some((asset: { name: string; sha256: string; bytes: number }) => asset.name === "icon.svg" && asset.sha256 === icon.sha256 && asset.bytes === icon.bytes) || icon.bytes > 65536) return json({ error: "application icon invalid" }, 400);
            const stored = await this.env.BLOBS.get(`v1/app/${icon.sha256}`);
            if (!stored) return json({ error: "application icon not uploaded" }, 409);
            try { validateApplicationIcon(await stored.text()); } catch { return json({ error: "application icon must be static self-contained SVG" }, 400); }
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
            if (task) {
              task.roundRelease = manifest.releaseId;
              task.phase = "ready";
              task.awaitingRoundStart = false;
              task.title = manifest.appName || task.title;
              await this.saveTask(task);
              this.emitWork(task.ownerId, id);
              this.ctx.waitUntil(this.notifyResult(structuredClone(task), true, "制作完成，作品已发布候选版本。点击查看、体验或继续修改。"));
            }
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
        const prior = await this.ctx.storage.get<MarketEntry>(`shared:${appId}`);
        const entry: MarketEntry = { manifest, title: manifest.appName, summary: manifest.description, category: prior?.category || (appId === "jolly" ? "creative" : "other"), screenshots: prior?.screenshots || [], publishedAt: prior?.manifest.releaseId === releaseId ? prior.publishedAt || Date.now() : Date.now(), authorId: OFFICIAL_ACCOUNT_ID, authorName: "生花官方", authorOfficial: true, originalAppId: null };
        await this.ctx.storage.transaction(async storage => {
          await storage.put({ [`shared:${appId}`]: entry, [`published:${appId}:${releaseId}`]: true });
          this.marketIndex.put(entry);
        });
        await this.ctx.storage.delete(`withdrawn:${appId}`);
        return json({ appId, public: releaseId }, 200);
      }
      const downloadRoute = path.match(/^\/v1\/application-download\/([a-z][a-z0-9-]{0,63})$/);
      if (downloadRoute && request.method === "POST") {
        const user = await authenticatedUser(request, this.env);
        if (!user) return json({ message: "请先登录" }, 401);
        const appId = downloadRoute[1];
        const input = await request.json() as { releaseId?: string };
        if (!input.releaseId || !/^[a-f0-9]{64}$/.test(input.releaseId) || !await this.ctx.storage.get(`published:${appId}:${input.releaseId}`)) return json({ message: "应用版本尚未上架" }, 400);
        const count = await this.ctx.storage.transaction(async storage => {
          const key = `download-user:${appId}:${user.id}`;
          const total = await storage.get<number>(`downloads:${appId}`) ?? 0;
          if (await storage.get(key)) return total;
          await storage.put({ [key]: true, [`downloads:${appId}`]: total + 1 });
          return total + 1;
        });
        return json({ downloadCount: count }, 200);
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
        const proof = await this.ctx.storage.get<SourceProof>(`source-proof:${appId}:${manifest.releaseId}`);
        if (proof && (manifest.source.applicationTree ? proof.applicationTree === manifest.source.applicationTree : manifest.source.tree && proof.tree === manifest.source.tree)) response.headers.set("X-Application-Source-Commit", proof.commit);
        return response;
      }
      if (path === "/v1/works" && request.method === "GET") {
        const user = await authenticatedUser(request, this.env); if (!user) return json({ message: "请先登录" }, 401);
        const params = new URL(request.url).searchParams;
        const gallery = params.get("view") === "gallery";
        const term = (params.get("q") || "").trim().toLowerCase();
        const allTasks = [...(await this.ctx.storage.list<WorkshopTask>({ prefix: `owner:${user.id}:` })).values()].filter(task => task.ownerId === user.id && (!term || `${task.title || ""} ${task.wish || ""}`.toLowerCase().includes(term))).sort((a,b) => (b.startedAt || 0) - (a.startedAt || 0) || b.appId.localeCompare(a.appId));
        const cursor = params.get("cursor");
        let after: {at: number; id: string} | undefined;
        if (gallery && cursor) { try { after = JSON.parse(atob(cursor)); if (!after || !Number.isSafeInteger(after.at) || after.at < 0 || typeof after.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(after.id) || (after as {filter?: string}).filter !== JSON.stringify([user.id,term])) throw new Error(); } catch { return json({message: "作品分页标记无效"},400); } }
        const matching = after ? allTasks.filter(task => (task.startedAt || 0) < after!.at || (task.startedAt || 0) === after!.at && task.appId.localeCompare(after!.id) < 0) : allTasks;
        const tasks = gallery ? matching.slice(0,24) : matching;
        const last = tasks.at(-1);
        const nextCursor = gallery && matching.length > 24 && last ? btoa(JSON.stringify({at: last.startedAt || 0, id: last.appId, filter: JSON.stringify([user.id,term])})) : null;
        const force = new URL(request.url).searchParams.get("refresh") === "1";
        const metadata = await getMany<ApplicationRelease | MarketEntry | {key: string; at: number; status: WorkSummary} | string>(this.ctx.storage, tasks.flatMap(task => [`candidate:${task.appId}`, `shared:${task.appId}`, `work-summary:${task.appId}`, `application-icon:${task.appId}`]));
        const entries = tasks.map(task => {
          const application = metadata.get(`candidate:${task.appId}`) as ApplicationRelease | undefined;
          const shared = metadata.get(`shared:${task.appId}`) as MarketEntry | undefined;
          const cached = metadata.get(`work-summary:${task.appId}`) as {key: string; at: number; status: WorkSummary} | undefined;
          const valid = cached?.key === this.summaryKey(task, application ?? null);
          const settled = task.phase === "ready" && isRoundCandidate(task, application ?? null);
          return {task, application: application ?? null, shared: shared?.authorId === user.id ? shared : null, cached: valid ? cached : undefined, pending: !settled && force ? this.refreshSummary(task, application ?? null) : undefined};
        });
        const pending = Promise.all(entries.map(entry => entry.pending)); this.ctx.waitUntil(pending);
        // Bound the whole list wait, rather than spending a timeout on every work.
        if (force || entries.some(entry => !entry.cached)) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([pending, new Promise<void>(resolve => { timer = setTimeout(resolve, 6500); })]);
          if (timer) clearTimeout(timer);
        }
        const works = await Promise.all(entries.map(async ({ task: initial, cached: previous, application: initialApplication, shared: initialShared }) => {
          const task = force ? await this.ctx.storage.get<WorkshopTask>(`task:${initial.appId}`) : initial;
          if (!task || task.ownerId !== user.id) return undefined;
          const [application, shared] = force ? await Promise.all([this.candidate(task.appId), this.ctx.storage.get<MarketEntry>(`shared:${task.appId}`)]) : [initialApplication, initialShared];
          const cached = force ? await this.ctx.storage.get<{ key: string; at: number; status: WorkSummary }>(`work-summary:${task.appId}`) : previous;
          const valid = cached?.key === this.summaryKey(task, application);
          const settled = task.phase === "ready" && isRoundCandidate(task, application);
          const status = settled ? summarizeWork(task, { state: "COMPLETED" }, application) : valid ? cached.status : summarizeWork(task, { state: task.phase === "ready" ? "COMPLETED" : "QUEUED" }, application);
          const ttl = status.completed && status.application ? 300000 : 20000;
          return { submissionId: task.requestId, appId: task.appId, ownerId: task.ownerId, session: task.session, approvalToken: task.token, title: task.title ?? task.appId, wish: task.wish ?? "", startedAt: task.startedAt, originalAppId: task.originalAppId, originalReleaseId: task.originalReleaseId, originalCommit: task.originalCommit, branch: task.branch, phase: task.phase, status: { ...status, stale: !settled && (!valid || Date.now() - cached.at >= ttl || force && cached.at === previous?.at) }, sharing: { shared: shared?.authorId === user.id ? shared : null, application, iconUrl: metadata.get(`application-icon:${task.appId}`) as string | undefined }, updatedAt: valid ? cached.at : null };
        }));
        const selected = works.filter((work): work is NonNullable<typeof work> => !!work);
        const response = json(gallery ? {works: selected.map(work => ({appId: work.appId, title: work.status.application?.appName || work.title, wish: work.wish, createdAt: work.startedAt || 0, manifest: work.status.application || work.sharing.application, sharing: work.sharing, stale: work.status.stale, message: work.status.message, stage: work.status.state === "FAILED" ? "failed" : work.status.state === "PAUSED" ? "paused" : work.status.state === "AWAITING_USER_FEEDBACK" ? "reply" : work.status.completed ? work.status.application ? "load" : work.status.delivery === "blocked" ? "blocked" : "making" : "making"})), nextCursor, totalCount: allTasks.length} : {works: selected}, 200); response.headers.set("Cache-Control", "private,no-store"); return response;
      }
      const input = await request.json() as { appId?: string; originalAppId?: string; originalReleaseId?: string; requestId?: string; action?: string; session?: string; token?: string; approvalToken?: string; method?: string; path?: string; body?: string; releaseId?: string; title?: string; summary?: string; category?: string; screenshots?: string[]; applicationReleases?: Record<string, string>; pageToken?: string; compact?: boolean };
      const appId = input.appId;
      if (!appId || !/^[a-z][a-z0-9-]{0,63}$/.test(appId)) return json({ message: "请指定目标应用" }, 400);
      const user = await authenticatedUser(request, this.env);
      if (!user) return json({ message: "请先登录后再操作作品" }, 401);
      let task = await this.ctx.storage.get<WorkshopTask>(`task:${appId}`);
      if (task && task.ownerId !== user.id) return json({ message: "这个作品属于其他账号" }, 403);
      if (path === "/v1/jules" && input.method === "POST" && input.path === "/v1alpha/sessions") {
        if ((OFFICIAL_APPLICATIONS as readonly string[]).includes(appId)) return json({ message: "请基于这个应用创作新作品" }, 403);
        if (task?.session) {
          if (input.requestId && input.requestId === task.requestId) { this.ctx.waitUntil(this.notifyResult(structuredClone(task), true, "制作需求已提交，点击查看本轮进度。完成或失败都会在这里通知你。", "work-submitted")); return json({ name: task.session, ownerId: task.ownerId, approvalToken: task.token }, 200); }
          return json({ message: "这个应用已有 session，请从作品列表接回" }, 409);
        }
        if (!input.requestId || !/^[a-zA-Z0-9-]{1,160}$/.test(input.requestId)) return json({ message: "创建需要稳定的请求 ID，请更新宿主" }, 400);
        if (task && !task.creationRejected) {
          task = await this.recoverSession(task);
          if (input.requestId === task.requestId && task.session) { this.ctx.waitUntil(this.notifyResult(structuredClone(task), true, "制作需求已提交，点击查看本轮进度。完成或失败都会在这里通知你。", "work-submitted")); return json({ name: task.session, ownerId: task.ownerId, approvalToken: task.token }, 200); }
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
          original = shared.manifest;
          try { const source = await this.remixSource(shared); originalCommit = source.commit; originalBranch = source.branch; }
          catch (error) { return json({ message: error instanceof Error ? error.message : "原作源码暂时无法读取，请重试" }, 409); }
        }
        const preparation = await sdkPreparation((await this.env.CATALOG.get<{ applications?: { sdk: string } }>("v1/release", "json"))?.applications?.sdk);
        if (!await this.quota(user.id, appId)) return json({ message: "每天最多发起 10 轮制作，同时最多制作 3 个作品" }, 429);
        const moduleBase = await this.allocate(appId);
        task = { ownerId: user.id, appId, session: "", token: crypto.randomUUID(), phase: "working", publishEpoch: crypto.randomUUID(), requestId: input.requestId, title: String(payload.title ?? appId).slice(0, 80), wish: prompt, startedAt: Date.now(), originalAppId: original?.appId, originalReleaseId: original?.releaseId, originalCommit, originalBranch };
        task.creationTitle = `${task.title?.slice(0, 40)} [${crypto.randomUUID()}]`;
        payload.title = task.creationTitle;
        payload.sourceContext = { source: PLUGIN_SOURCE, githubRepoContext: { startingBranch: originalBranch ?? "main" }, environmentVariablesEnabled: false };
        await this.saveTask(task);
        const origin = original ? `改编 ${original.appId} 的公开版本 ${original.releaseId}；初始化命令自动复制对应源码，来源由平台维护。` : "";
        payload.prompt = `${preparation}\n新建 ${appId}。${await this.publisherInstruction(task, true)} ${origin} 需求：\n${prompt}`;
        const response = await proxyJules(new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify({ ...input, body: JSON.stringify(payload) }) }), this.env);
        if (!response.ok) {
          task.creationRejected = response.status >= 400 && response.status < 500;
          task.phase = task.creationRejected ? "paused" : "working";
          await this.saveTask(task);
          if (task.creationRejected) await this.notifyResult(task, false, "Jolly 未能开始这轮制作。点击查看作品，调整后可以重试。");
          return response;
        }
        const session = await response.json() as CloudSession;
        if (!session.name) { await this.saveTask(task); return json({ message: "Jules 未返回 session，正在后台接回制作记录" }, 502); }
        task.session = session.name;
        await this.saveTask(task);
        this.ctx.waitUntil(this.notifyResult(structuredClone(task), true, "制作需求已提交，点击查看本轮进度。完成或失败都会在这里通知你。", "work-submitted"));
        return json({ ...session, ownerId: user.id, approvalToken: task.token }, 200);
      }
      if (!task || (input.token ?? input.approvalToken) !== task.token) return json({ message: "这个应用的 session 凭据不匹配" }, 403);
      if (path === "/v1/market") {
        const [published, application] = await Promise.all([this.ctx.storage.get<MarketEntry>(`shared:${appId}`), this.candidate(appId)]);
        const shared = published ?? null;
        if (shared && shared.authorId !== user.id) return json({ message: "只有作者可以管理这份分享" }, 403);
        if (input.action === "status") return json({ shared, application, iconUrl: await this.ctx.storage.get<string>(`application-icon:${appId}`) }, 200);
        if (input.action === "withdraw") {
          await this.ctx.storage.transaction(async storage => {
            await storage.delete(`shared:${appId}`);
            await storage.put(`withdrawn:${appId}`, true);
            this.marketIndex.remove(appId);
          });
          this.emitWork(user.id, appId);
          return json({ shared: null, application }, 200);
        }
        if (input.action && !["share", "edit"].includes(input.action)) return json({ message: "分享操作无效" }, 400);
        if (input.action === "edit" && !shared) return json({ message: "这份作品尚未分享" }, 409);
        if (input.action !== "edit" && (!application || input.releaseId !== application.releaseId)) return json({ message: "候选版本已改变，请刷新作品状态后再上架" }, 409);
        const manifest = input.action === "edit" ? shared!.manifest : application;
        if (!manifest) return json({ message: "作品尚未发包，请先完成制作" }, 409);
        const proof = await this.ctx.storage.get<SourceProof>(`source-proof:${appId}:${manifest.releaseId}`);
        const title = input.title?.trim() ?? shared?.title ?? manifest.appName;
        const summary = input.summary?.trim() ?? shared?.summary ?? manifest.description;
        if (!title || title.length > 60 || summary.length > 300) return json({ message: "名称不能为空且最多 60 字，介绍最多 300 字" }, 400);
        const category = input.category ?? shared?.category ?? "other"; const screenshots = input.screenshots ?? shared?.screenshots ?? [];
        if (!MARKET_CATEGORIES.includes(category) || !Array.isArray(screenshots) || screenshots.length > 6 || new Set(screenshots).size !== screenshots.length) return json({ message: "请选择分类，截图最多六张且不能重复" }, 400);
        for (const screenshot of screenshots) {
          if (typeof screenshot !== "string") return json({ message: "截图格式无效" }, 400);
          const prefix = `${new URL(request.url).origin}/v1/market-images/${appId}/${user.id}/`;
          if (!screenshot.startsWith(prefix) || !/^[a-f0-9]{64}$/.test(screenshot.slice(prefix.length)) || !await this.env.BLOBS.head(screenshot.slice(new URL(request.url).origin.length + 1))) return json({ message: "截图未上传或不属于这个作品" }, 400);
        }
        const entry: MarketEntry = { iconUrl: await this.ctx.storage.get<string>(`application-icon:${appId}`), manifest, title, summary, category, screenshots, publishedAt: input.action === "edit" ? shared!.publishedAt || 0 : shared?.manifest.releaseId === manifest.releaseId ? shared.publishedAt || Date.now() : Date.now(), authorId: user.id, authorName: user.name, authorAvatarUrl: user.avatarUrl, authorOfficial: user.id === OFFICIAL_ACCOUNT_ID, originalAppId: task.originalAppId ?? shared?.originalAppId ?? null, sourceCommit: input.action === "edit" ? shared!.sourceCommit : proof?.commit ?? (!manifest.source.dirty ? manifest.source.commit : undefined), sourceBranch: input.action === "edit" ? shared!.sourceBranch : proof?.branch };
        await this.ctx.storage.transaction(async storage => {
          await storage.put({ [`shared:${appId}`]: entry, [`published:${appId}:${manifest.releaseId}`]: true });
          this.marketIndex.put(entry);
        });
        await this.ctx.storage.delete(`withdrawn:${appId}`);
        this.emitWork(user.id, appId);
        return json({ shared: entry, application }, 200);
      }
      if (path === "/v1/jules") {
        const name = input.path?.match(/^\/v1alpha\/(sessions\/[A-Za-z0-9_-]+)/)?.[1];
        if (name !== task.session) return json({ message: "Session 不属于这个应用" }, 403);
        if (input.method === "POST" && input.path?.endsWith(":sendMessage")) {
          const payload = JSON.parse(input.body ?? "{}");
          if (typeof payload.prompt !== "string" || !payload.prompt.trim() || payload.prompt.length > 8000) return json({ message: "请提交 1 到 8000 个字符的修改需求" }, 400);
          const requestKey = typeof input.requestId === "string" && /^[a-zA-Z0-9-]{1,180}$/.test(input.requestId) ? `message-request:${appId}:${user.id}:${input.requestId}` : undefined;
          const prior = requestKey ? await this.ctx.storage.get<{ session: string; prompt: string; response: string; status: number }>(requestKey) : undefined;
          if (prior) {
            if (prior.session !== task.session || prior.prompt !== payload.prompt) return json({ message: "提交标识已用于另一份修改需求" }, 409);
            if (input.requestId === task.requestId) this.ctx.waitUntil(this.notifyResult(structuredClone(task), true, "修改需求已提交，点击查看本轮进度。完成或失败都会在这里通知你。", "work-submitted"));
            return new Response(prior.response, { status: prior.status, headers: { "Content-Type": "application/json" } });
          }
          const submittedPrompt = payload.prompt;
          const current = await this.session(task.session);
          const candidate = await this.candidate(appId);
          const roundState = currentRoundSession(task, current, candidate).state;
          if (!["COMPLETED", "PAUSED", "AWAITING_USER_FEEDBACK", "FAILED"].includes(roundState ?? "")) return json({ message: "这个应用正在制作，请等本轮完成" }, 409);
          if (roundState === "COMPLETED" && task.phase === "working" && !isRoundCandidate(task, candidate) && (!task.deliveryWaitStartedAt || Date.now() - task.deliveryWaitStartedAt < 120000)) return json({ message: "本轮应用正在交付，请等交付完成后再修改" }, 409);
          const dispatchVersion = `${current.state}:${current.updateTime ?? ""}`;
          if (task.dispatchVersion === dispatchVersion) return json({ message: "本轮修改已提交，请等待制作状态更新" }, 409);
          const preparation = await sdkPreparation((await this.env.CATALOG.get<{ applications?: { sdk: string } }>("v1/release", "json"))?.applications?.sdk);
          if (!await this.quota(user.id, appId)) return json({ message: "制作额度已用完或同时制作作品过多，请稍后再试" }, 429);
          const previous = structuredClone(task);
          task.publishEpoch = crypto.randomUUID(); task.requestId = input.requestId; task.awaitingRoundStart = true; task.dispatchVersion = dispatchVersion; task.deliveryWaitStartedAt = undefined;
          task.previousCommit = (await this.candidate(appId))?.source.commit ?? task.previousCommit; task.roundRelease = undefined;
          task.phase = "working"; task.repair = false; task.wish = String(payload.prompt ?? ""); task.startedAt = Date.now();
          // Persist the new round before upstream work starts; ambiguous timeouts can still deliver.
          await this.saveTask(task);
          this.activityPages.delete(task.session);
          payload.prompt = `${preparation}\n修改 ${appId}。${await this.publisherInstruction(task)} 需求：\n${payload.prompt ?? ""}`;
          const response = await proxyJules(new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify({ ...input, body: JSON.stringify(payload) }) }), this.env);
          if (response.ok && requestKey) await this.ctx.storage.put(requestKey, { session: task.session, prompt: submittedPrompt, response: await response.clone().text(), status: response.status });
          if (response.ok) this.ctx.waitUntil(this.notifyResult(structuredClone(task), true, "修改需求已提交，点击查看本轮进度。完成或失败都会在这里通知你。", "work-submitted"));
          if (!response.ok && response.status < 500) await this.saveTask(previous);
          return response;
        }
        return proxyJules(new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(input) }), this.env);
      }
      if (input.session !== task.session) return json({ message: "Session 不属于这个应用" }, 403);
      if (input.action === "activities") {
        if (typeof input.pageToken !== "string" || !input.pageToken || input.pageToken.length > 4096) return json({ message: "制作记录游标无效" }, 400);
        const response = json(await this.activities(task.session, input.pageToken), 200);
        response.headers.set("Cache-Control", "private,no-store"); return response;
      }
      if (input.action === "detail" || input.action === "progress") {
        const started = Date.now();
        const [session, application, shared, initialActivities] = await Promise.all([
          this.session(task.session), this.candidate(appId), this.ctx.storage.get<MarketEntry>(`shared:${appId}`),
          (input.compact || input.action === "progress") ? Promise.resolve({ ...(this.activityPages.get(task.session)?.page ?? { activities: [] }), stale: true }) : this.recentActivities({ name: task.session }),
        ]);
        // Status is independent of the bulk history. Only round confirmation
        // needs activities before replying; history warming never polls the client.
        const confirmRound = task.awaitingRoundStart && ["COMPLETED", "FAILED", "PAUSED", "AWAITING_USER_FEEDBACK"].includes(session.state || "");
        const activityResult = input.action === "progress" ? await this.progressActivities(task, session) : input.compact && confirmRound ? await this.recentActivities({ ...session, name: task.session }) : initialActivities;
        if (input.compact && !confirmRound && input.action !== "progress") this.ctx.waitUntil(this.recentActivities({ ...session, name: task.session }).catch(() => {}));
        observeRound(task, session, activityResult.activities);
        Object.assign(session, currentRoundSession(task, session, application));
        if (task.startedAt) activityResult.activities = activityResult.activities.filter(value => Date.parse((value as { createTime?: string }).createTime || "") >= task.startedAt!);
        if (session.state === "COMPLETED" && !isRoundCandidate(task, application) && !task.deliveryWaitStartedAt) task.deliveryWaitStartedAt = Date.now();
        const status = summarizeWork(task, session, application);
        // A stopped round must not be resumed merely because Jules still reports work.
        if (task.phase === "paused" && session.state !== "FAILED") session.state = "PAUSED";
        if (task.phase !== "paused" && ["FAILED", "PAUSED"].includes(session.state || "")) { task.phase = "paused"; task.repair = true; }
        if (status.completed) { task.phase = status.application ? "ready" : "working"; task.repair = !status.application; }
        if (status.application?.appName) task.title = status.application.appName;
        await this.saveTask(task);
        await this.ctx.storage.put(`work-summary:${appId}`, { key: this.summaryKey(task, application), at: Date.now(), status });
        if (session.state === "FAILED") this.ctx.waitUntil(this.notifyResult(task, false, "制作失败了。点击查看制作记录，可以继续修复这个作品。"));
        if (status.completed && status.application) this.ctx.waitUntil(this.notifyResult(task, true, "制作完成，作品已准备好。点击查看、体验或继续修改。"));
        if (status.application) {
          // Delivery metadata may arrive after the session's completion event.
          status.delivery = input.applicationReleases?.[appId] === status.application.releaseId ? "loaded" : "update";
          this.ctx.waitUntil(this.queue.run(`app:${appId}`, async () => {
            const current = await this.ctx.storage.get<WorkshopTask>(`task:${appId}`);
            if (!this.resetting && current && current.publishEpoch === task.publishEpoch) await this.recordBranch(current, session, status.application!);
          }));
        }
        if (status.delivery === "blocked") this.ctx.waitUntil(this.notifyResult(task, false, status.message));
        const response = json({ roundStartedAt: task.startedAt, submissionId: task.requestId, session: { state: session.state, url: session.url, title: task.title, createTime: session.createTime, updateTime: session.updateTime }, status, sharing: { shared: shared?.authorId === user.id ? shared : null, application }, ...activityResult }, 200);
        response.headers.set("Cache-Control", "private,no-store");
        response.headers.set("Server-Timing", `workshop;dur=${Date.now() - started}`); return response;
      }
      const session = await this.session(task.session);
      observeRound(task, session);
      Object.assign(session, currentRoundSession(task, session, await this.candidate(appId)));
      if (session.state === "FAILED") await this.notifyResult(task, false, "制作失败了。点击查看制作记录，可以继续修复这个作品。");
      if (input.action === "stop") {
        if (!["COMPLETED", "PAUSED", "FAILED"].includes(session.state ?? "")) {
          const response = await proxyJules(new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify({ method: "POST", path: `/v1alpha/${task.session}:sendMessage`, body: JSON.stringify({ prompt: "停止当前制作，不再修改或发布，等待我的下一条需求。" }) }) }), this.env);
          if (!response.ok) return response;
        }
        task.phase = "paused"; task.repair = true; task.dispatchVersion = undefined; task.awaitingRoundStart = undefined;
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
        await this.notifyResult(task, false, "制作交付未完成。点击查看记录，在当前作品继续修复并重新发布。");
        return json({ completed: true, state: session.state, delivery: "blocked", message: error instanceof Error ? error.message : "请在当前 session 修复交付后重新发包" }, input.action === "status" ? 200 : 409);
      }
      const ready = delivery?.ready === true;
      if (!ready) { task.repair = true; await this.saveTask(task); }
      const loaded = ready && input.applicationReleases?.[appId] === delivery!.application.releaseId;
      if (input.action === "status" && !delivery) {
        const missing = summarizeWork(task, session, null);
        if (missing.delivery === "blocked") { await this.notifyResult(task, false, missing.message); return json(missing, 200); }
      }
      if (input.action === "status") {
        if (delivery?.application.appName && delivery.application.appName !== appId) task.title = delivery.application.appName;
        task.phase = ready ? "ready" : "working"; await this.saveTask(task);
        if (ready) await this.notifyResult(task, true, "制作完成，作品已准备好。点击查看、体验或继续修改。");
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
