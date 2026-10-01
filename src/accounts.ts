import { DurableObject } from "cloudflare:workers";
import { KeyedQueue } from "./concurrency";

type AccountEnv = Env & { RESEND_API_KEY?: string; MAIL_FROM?: string };
export const OFFICIAL_ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
export const OFFICIAL_APPLICATIONS = ["jolly", "notepad", "pomodoro"] as const;
export type User = { id: string; email: string | null; name: string; avatarUrl: string | null; createdAt: number };
type Session = { userId: string; expiresAt: number };
type Challenge = { salt: string; digest: string; expiresAt: number; attempts: number; sentAt: number };
type Counter = { count: number; expiresAt: number };
class InvalidInput extends Error {}
async function boundedBody(request: Request, maximum: number): Promise<Uint8Array> {
  if (Number(request.headers.get("Content-Length")) > maximum) throw new InvalidInput("请求内容过大");
  const reader = request.body?.getReader(); if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > maximum) { await reader.cancel(); throw new InvalidInput("请求内容过大"); } chunks.push(chunk.value); }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; } return result;
}
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const hash = async (value: string | ArrayBuffer) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", typeof value === "string" ? new TextEncoder().encode(value) : value)), byte => byte.toString(16).padStart(2, "0")).join("");
const random = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
const equal = (a: string, b: string) => { let mismatch = a.length ^ b.length; for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ (b.charCodeAt(i) || 0); return mismatch === 0; };
const normalizeEmail = (value: unknown) => typeof value === "string" ? value.trim().toLowerCase() : "";
const validEmail = (email: string) => email.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email);
const friendlyName = () => {
  const adjectives = ["听风", "拾光", "望月", "晨露", "星河", "山间", "向晚", "晴空", "浅夏", "微雨", "春日", "云间"];
  const nouns = ["小鹿", "旅人", "云朵", "萤火", "松鼠", "小鲸", "白鸽", "星星", "溪流", "暖阳", "铃兰", "海风"];
  const values = crypto.getRandomValues(new Uint32Array(2)); return `${adjectives[values[0] % adjectives.length]}的${nouns[values[1] % nouns.length]}`;
};

/** Account records are separate from workshop state and application business data. */
export class Accounts extends DurableObject<AccountEnv> {
  constructor(ctx: DurableObjectState, env: AccountEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const prior = await ctx.storage.get<User>(`user:${OFFICIAL_ACCOUNT_ID}`);
      const user: User = { ...(prior ?? { id: OFFICIAL_ACCOUNT_ID, name: "紫金花官方", avatarUrl: null, createdAt: Date.now() }), email: null };
      await ctx.storage.put(`user:${OFFICIAL_ACCOUNT_ID}`, user);
    });
  }
  private queue = new KeyedQueue();
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/internal/") || request.method === "GET") return this.handle(request);
    if (["/v1/auth/code", "/v1/auth/verify"].includes(path)) {
      try {
        const body = await this.smallBody(request.clone() as unknown as Request);
        return this.queue.run(`email:${normalizeEmail(body.email)}`, () => this.handle(request));
      } catch { return json({ message: "请求格式不正确" }, 400); }
    }
    const session = await this.session(request);
    return this.queue.run(`user:${session?.user.id ?? "anonymous"}`, () => this.handle(request));
  }
  private async session(request: Request): Promise<{ key: string; record: Session; user: User } | undefined> {
    const token = request.headers.get("Authorization")?.match(/^Bearer ([a-f0-9]{64})$/)?.[1]; if (!token) return;
    const key = `session:${await hash(token)}`; const record = await this.ctx.storage.get<Session>(key);
    if (!record || record.expiresAt <= Date.now()) { if (record) await this.ctx.storage.delete(key); return; }
    if (record.userId === OFFICIAL_ACCOUNT_ID) return;
    const user = await this.ctx.storage.get<User>(`user:${record.userId}`); if (user) return { key, record, user };
  }
  private async limited(key: string, limit: number, duration: number): Promise<boolean> {
    return this.ctx.storage.transaction(async storage => {
    const prior = await storage.get<Counter>(key); const counter = prior && prior.expiresAt > Date.now() ? prior : { count: 0, expiresAt: Date.now() + duration };
    if (counter.count >= limit) return true;
    counter.count++; await storage.put(key, counter); return false;
    });
  }
  private async smallBody(request: Request): Promise<Record<string, unknown>> {
    try { const value = JSON.parse(new TextDecoder().decode(await boundedBody(request, 4096))); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value; }
    catch (error) { if (error instanceof InvalidInput) throw error; throw new InvalidInput("请求格式不正确"); }
  }
  private async handle(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/internal/authenticate") { const session = await this.session(request); return session ? json({ user: session.user }) : json({ message: "请先登录" }, 401); }
      if (path === "/internal/profiles" && request.method === "POST") {
        const { ids } = await request.json() as { ids: string[] };
        const profiles = await Promise.all(ids.slice(0, 200).map(async id => { const user = await this.ctx.storage.get<User>(`user:${id}`); return user ? { id: user.id, name: user.name, avatarUrl: user.avatarUrl } : null; }));
        return json({ profiles: profiles.filter(Boolean) });
      }
      if (path === "/v1/auth/code" && request.method === "POST") {
        if (!this.env.RESEND_API_KEY || !this.env.MAIL_FROM) return json({ message: "登录邮件暂未开通，请稍后再试" }, 503);
        const body = await this.smallBody(request); const email = normalizeEmail(body.email);
        if (!validEmail(email)) return json({ message: "请输入有效的邮箱地址" }, 400);
        const emailHash = await hash(email); const key = `code:${emailHash}`; const prior = await this.ctx.storage.get<Challenge>(key);
        if (prior && Date.now() - prior.sentAt < 60000) return json({ message: "请稍后再发送验证码", retryAfter: Math.ceil((60000 - (Date.now() - prior.sentAt)) / 1000) }, 429);
        const ip = await hash(request.headers.get("CF-Connecting-IP") || "unknown");
        if (await this.limited(`rate:email-hour:${emailHash}`, 5, 3600000) || await this.limited(`rate:email-day:${emailHash}`, 10, 86400000) || await this.limited(`rate:ip-hour:${ip}`, 20, 3600000) || await this.limited("rate:all-hour", 200, 3600000)) return json({ message: "发送次数较多，请稍后再试" }, 429);
        const value = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000; const code = value.toString().padStart(6, "0"); const salt = random();
        const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 12000);
        let response: Response;
        try { response = await fetch("https://api.resend.com/emails", { method: "POST", signal: controller.signal, headers: { Authorization: `Bearer ${this.env.RESEND_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ from: this.env.MAIL_FROM, to: [email], subject: "你的紫金花登录验证码", text: `你的登录验证码是 ${code}，10 分钟内有效。请勿向他人提供验证码。如果不是你发起的登录，请忽略这封邮件。` }) }); }
        catch { return json({ message: "邮件暂时未能发送，请稍后重试" }, 502); }
        finally { clearTimeout(timer); }
        if (!response.ok) return json({ message: "邮件暂时未能发送，请稍后重试" }, 502);
        const sentAt = Date.now(); await this.ctx.storage.put<Challenge>(key, { salt, digest: await hash(`${salt}:${code}`), sentAt, expiresAt: sentAt + 600000, attempts: 0 });
        if (!await this.ctx.storage.getAlarm()) await this.ctx.storage.setAlarm(Date.now() + 3600000);
        return json({ sent: true, retryAfter: 60, expiresIn: 600 });
      }
      if (path === "/v1/auth/verify" && request.method === "POST") {
        const body = await this.smallBody(request); const email = normalizeEmail(body.email); const code = typeof body.code === "string" ? body.code.trim() : "";
        if (!validEmail(email) || !/^\d{6}$/.test(code)) return json({ message: "请输入邮箱和六位验证码" }, 400);
        const emailHash = await hash(email); const key = `code:${emailHash}`; const challenge = await this.ctx.storage.get<Challenge>(key);
        if (!challenge || challenge.expiresAt <= Date.now()) { if (challenge) await this.ctx.storage.delete(key); return json({ message: "验证码已失效，请重新发送" }, 400); }
        if (challenge.attempts >= 5) return json({ message: "尝试次数过多，请重新发送验证码" }, 429);
        challenge.attempts++; await this.ctx.storage.put(key, challenge);
        if (!equal(challenge.digest, await hash(`${challenge.salt}:${code}`))) return json({ message: "验证码不正确，请重新输入" }, 400);
        const userId = await this.ctx.storage.get<string>(`email:${emailHash}`);
        let user = userId && userId !== OFFICIAL_ACCOUNT_ID ? await this.ctx.storage.get<User>(`user:${userId}`) : undefined;
        if (!user) user = { id: crypto.randomUUID(), email, name: friendlyName(), avatarUrl: null, createdAt: Date.now() };
        const token = random(); const expiresAt = Date.now() + 90 * 86400000; const sessionKey = `session:${await hash(token)}`; const account = user;
        await this.ctx.storage.transaction(async storage => { await storage.delete(key); await storage.put(`user:${account.id}`, account); await storage.put(`email:${emailHash}`, account.id); await storage.put<Session>(sessionKey, { userId: account.id, expiresAt }); });
        return json({ user, token, expiresAt });
      }
      const session = await this.session(request); if (!session) return json({ message: "登录已过期，请重新登录" }, 401);
      if (path === "/v1/auth/logout" && request.method === "POST") { await this.ctx.storage.delete(session.key); return json({ loggedOut: true }); }
      if (path === "/v1/account" && request.method === "GET") return json({ user: session.user });
      if (path === "/v1/account" && request.method === "PATCH") {
        const body = await this.smallBody(request); const name = typeof body.name === "string" ? body.name.trim().normalize("NFC") : "";
        if (!name || Array.from(name).length > 24 || /[\p{Cc}\p{Cf}]/u.test(name)) return json({ message: "昵称需为 1 到 24 个字符，不能包含控制字符" }, 400);
        session.user.name = name; await this.ctx.storage.put(`user:${session.user.id}`, session.user); return json({ user: session.user });
      }
      if (path === "/v1/account/avatar" && request.method === "DELETE") { session.user.avatarUrl = null; await this.ctx.storage.put(`user:${session.user.id}`, session.user); return json({ user: session.user }); }
      if (path === "/v1/account/avatar" && request.method === "PUT") {
        if (Number(request.headers.get("Content-Length")) > 1048576) return json({ message: "头像需小于 1 MB" }, 413);
        const bytes = (await boundedBody(request, 1048576)).buffer as ArrayBuffer; if (bytes.byteLength < 32) return json({ message: "头像需为小于 1 MB 的图片" }, 400);
        const header = new Uint8Array(bytes); let contentType = "";
        if (header[0] === 255 && header[1] === 216 && header[2] === 255) contentType = "image/jpeg";
        else if ([137,80,78,71,13,10,26,10].every((value, index) => header[index] === value)) contentType = "image/png";
        else if (String.fromCharCode(...header.slice(0, 4)) === "RIFF" && String.fromCharCode(...header.slice(8, 12)) === "WEBP") contentType = "image/webp";
        if (!contentType) return json({ message: "头像仅支持 JPEG、PNG 或 WebP 图片" }, 400);
        const key = `v1/avatars/${session.user.id}/${await hash(bytes)}`;
        await this.env.BLOBS.put(key, bytes, { httpMetadata: { contentType, cacheControl: "public,max-age=31536000,immutable" } });
        session.user.avatarUrl = `${new URL(request.url).origin}/${key}`; await this.ctx.storage.put(`user:${session.user.id}`, session.user); return json({ user: session.user });
      }
      return json({ message: "没有找到这个操作" }, 404);
    } catch (error) { return error instanceof InvalidInput ? json({ message: error.message }, 400) : json({ message: "账户操作暂未完成，请稍后重试" }, 503); }
  }
  alarm(): Promise<void> { return this.cleanup(); }
  private async cleanup() {
    for (const prefix of ["code:", "session:", "rate:"]) {
      let startAfter: string | undefined;
      while (true) {
        const records = await this.ctx.storage.list<{ expiresAt: number }>({ prefix, startAfter, limit: 128 });
        if (!records.size) break;
        const expired = [...records].filter(([, record]) => record.expiresAt <= Date.now()).map(([key]) => key);
        startAfter = [...records.keys()].at(-1);
        if (expired.length) await this.ctx.storage.transaction(async storage => { for (const key of expired) { const current = await storage.get<{ expiresAt: number }>(key); if (current && current.expiresAt <= Date.now()) await storage.delete(key); } });
        if (records.size < 128) break;
      }
    }
    await this.ctx.storage.setAlarm(Date.now() + 86400000);
  }
}

export async function readAvatar(request: Request, env: Env): Promise<Response> {
  const object = await env.BLOBS.get(new URL(request.url).pathname.slice(1)); if (!object) return json({ message: "头像不存在" }, 404);
  const headers = new Headers(); object.writeHttpMetadata(headers); headers.set("X-Content-Type-Options", "nosniff"); headers.set("Cache-Control", "public,max-age=31536000,immutable"); headers.set("ETag", object.httpEtag);
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}
export async function authenticatedUser(request: Request, env: Env): Promise<User | null> {
  const response = await env.ACCOUNTS.getByName("accounts").fetch(new Request("https://account.internal/internal/authenticate", { headers: { Authorization: request.headers.get("Authorization") || "" } }));
  return response.ok ? ((await response.json()) as { user: User }).user : null;
}
export async function publicProfiles(ids: string[], env: Env): Promise<Map<string, Pick<User, "id" | "name" | "avatarUrl">>> {
  const result = new Map<string, Pick<User, "id" | "name" | "avatarUrl">>();
  for (let offset = 0; offset < ids.length; offset += 200) {
    const response = await env.ACCOUNTS.getByName("accounts").fetch(new Request("https://account.internal/internal/profiles", { method: "POST", body: JSON.stringify({ ids: ids.slice(offset, offset + 200) }) }));
    if (!response.ok) continue;
    const { profiles } = await response.json() as { profiles: Pick<User, "id" | "name" | "avatarUrl">[] };
    for (const profile of profiles) result.set(profile.id, profile);
  }
  return result;
}
