import { authenticatedUser } from "./accounts";

const uuid = /^[a-f0-9-]{36}$/;
const mimes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "audio/mpeg", "audio/wav", "audio/mp4", "video/mp4", "application/pdf", "application/octet-stream"]);
type FileRow = { app_id: string; owner_id: string; id: string; mime: string; bytes: number; created_at: number; visibility: "private" | "public"; status: string; secret: string; iv: string };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const keyFor = (row: FileRow) => `v1/app-files/${row.visibility}/${row.app_id}/${row.owner_id}/${row.id}`;
function visible(row: FileRow) { return { id: row.id, mime: row.mime, bytes: row.bytes, createdAt: row.created_at, visibility: row.visibility, ...(row.visibility === "public" ? { url: `https://zjh-cdn.297782.xyz/${keyFor(row)}` } : {}) }; }
const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
const unhex = (text: string) => Uint8Array.from(text.match(/../g)!, b => parseInt(b, 16));

export async function applicationFiles(request: Request, env: Env): Promise<Response> {
  const match = new URL(request.url).pathname.match(/^\/v1\/app-files\/([a-z][a-z0-9-]{0,63})\/([a-f0-9-]{36})(\/content)?$/);
  if (!match) return json({ code: "INVALID_ARGUMENT", message: "文件参数无效" }, 400);
  const user = await authenticatedUser(request, env);
  if (!user) return json({ code: "UNAUTHENTICATED", message: "请先登录" }, 401);
  const [, appId, id, content] = match;
  if (!await env.WORKSHOP.getByName("dynamic").canUseCloud(appId, user.id)) return json({ code: "FORBIDDEN", message: "应用未开放" }, 403);
  const store = env.APP_DATA.getByName(`user:${user.id}`);
  if (!await store.cloudGate(user.id)) return json({ code: "RATE_LIMITED", message: "请求过于频繁" }, 429);
  const fail = (message: string, status = 400, code = "INVALID_ARGUMENT") => json({ code, message }, status);
  try {
    const existing = await store.fileOperation("get", user.id, appId, { id }) as FileRow | null;
    if (request.method === "PUT" && !content) {
      const mime = request.headers.get("Content-Type")?.split(";")[0] ?? "";
      const visibility = request.headers.get("X-File-Visibility") ?? "private";
      if (!mimes.has(mime) || !["private", "public"].includes(visibility)) return fail("文件类型或可见性无效");
      if (existing?.status === "ready") {
        if (existing.mime !== mime || existing.visibility !== visibility) return fail("同一请求 ID 不能用于不同文件", 409, "CONFLICT");
        return json({ result: visible(existing) });
      }
      if (existing) return fail("文件正在上传，请稍后重试", 409, "CONFLICT");
      const reader = request.body?.getReader(); if (!reader) return fail("文件为空");
      const parts: Uint8Array[] = []; let bytes = 0;
      try { while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > 10 * 1024 * 1024) { await reader.cancel(); return fail("文件不能超过 10 MB", 413); } parts.push(part.value); } } finally { reader.releaseLock(); }
      if (!bytes) return fail("文件为空");
      const data = new Uint8Array(bytes); let offset = 0;
      for (const part of parts) { data.set(part, offset); offset += part.length; }
      const secret = visibility === "private" ? hex(crypto.getRandomValues(new Uint8Array(32))) : "";
      const iv = secret ? hex(crypto.getRandomValues(new Uint8Array(12))) : "";
      const row = await store.fileOperation("reserve", user.id, appId, { id, mime, bytes, visibility, secret, iv }) as FileRow;
      try {
        const key = secret ? await crypto.subtle.importKey("raw", unhex(secret), "AES-GCM", false, ["encrypt"]) : undefined;
        const body = key ? await crypto.subtle.encrypt({ name: "AES-GCM", iv: unhex(iv) }, key, data) : data;
        await env.BLOBS.put(keyFor(row), body, { httpMetadata: { contentType: secret ? "application/octet-stream" : mime, cacheControl: secret ? "no-store" : "public,max-age=31536000,immutable" } });
        await store.fileOperation("commit", user.id, appId, { id });
        return json({ result: visible(row) });
      } catch (error) { await env.BLOBS.delete(keyFor(row)); await store.fileOperation("remove", user.id, appId, { id }); throw error; }
    }
    if (!existing || existing.status !== "ready") return content ? fail("文件不存在", 404, "NOT_FOUND") : json({ result: null });
    if (request.method === "DELETE" && !content) { await env.BLOBS.delete(keyFor(existing)); await store.fileOperation("remove", user.id, appId, { id }); return json({ result: null }); }
    if (request.method !== "GET") return fail("请求方法无效");
    if (!content) return json({ result: visible(existing) });
    const blob = await env.BLOBS.get(keyFor(existing)); if (!blob) return fail("文件不存在", 404, "NOT_FOUND");
    let body: BodyInit = blob.body;
    if (existing.secret) {
      const key = await crypto.subtle.importKey("raw", unhex(existing.secret), "AES-GCM", false, ["decrypt"]);
      body = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unhex(existing.iv) }, key, await blob.arrayBuffer());
    }
    return new Response(body, { headers: { "Content-Type": existing.mime, "Content-Length": String(existing.bytes), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "云文件暂不可用";
    if (message === "FILE_QUOTA") return fail("云文件空间已满", 413, "QUOTA_EXCEEDED");
    if (message === "FILE_CONFLICT") return fail("文件正在上传", 409, "CONFLICT");
    return fail("云文件暂不可用", 503, "UNAVAILABLE");
  }
}

export class FileRecords {
  constructor(private ctx: DurableObjectState, private env: Env) {
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS cloud_files (app_id TEXT NOT NULL,owner_id TEXT NOT NULL,id TEXT NOT NULL,mime TEXT NOT NULL,bytes INTEGER NOT NULL,created_at INTEGER NOT NULL,visibility TEXT NOT NULL,status TEXT NOT NULL,secret TEXT NOT NULL,iv TEXT NOT NULL,PRIMARY KEY(app_id,id));");
  }
  operation(operation: string, userId: string, appId: string, input: Record<string, unknown>): FileRow | null {
    if (!uuid.test(userId) || !/^[a-z][a-z0-9-]{0,63}$/.test(appId) || typeof input.id !== "string" || !uuid.test(input.id)) throw new Error("FILE_INVALID");
    const tenant = `user:${userId}`;
    const identity = this.ctx.storage.sql.exec<{ tenant: string }>("SELECT tenant FROM identity WHERE id=1").toArray()[0];
    if (identity && identity.tenant !== tenant) throw new Error("FILE_INVALID");
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO identity VALUES(1,?)", tenant);
    return this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql.exec<FileRow>("SELECT * FROM cloud_files WHERE app_id=? AND id=?", appId, input.id as string).toArray()[0] ?? null;
      if (operation === "get") return row;
      if (operation === "remove") { this.ctx.storage.sql.exec("DELETE FROM cloud_files WHERE app_id=? AND id=?", appId, input.id as string); return null; }
      if (operation === "commit") { this.ctx.storage.sql.exec("UPDATE cloud_files SET status='ready' WHERE app_id=? AND id=?", appId, input.id as string); return row; }
      if (operation !== "reserve" || row) throw new Error("FILE_CONFLICT");
      const usage = this.ctx.storage.sql.exec<{ bytes: number; count: number }>("SELECT COALESCE(SUM(bytes),0) AS bytes,COUNT(*) AS count FROM cloud_files WHERE app_id=?", appId).one();
      if (usage.bytes + Number(input.bytes) > 100 * 1024 * 1024 || usage.count >= 1000) throw new Error("FILE_QUOTA");
      const result: FileRow = { app_id: appId, owner_id: userId, id: input.id as string, mime: String(input.mime), bytes: Number(input.bytes), visibility: input.visibility as FileRow["visibility"], created_at: Date.now(), status: "pending", secret: String(input.secret), iv: String(input.iv) };
      this.ctx.storage.sql.exec("INSERT INTO cloud_files VALUES(?,?,?,?,?,?,?,?,?,?)", appId, userId, result.id, result.mime, result.bytes, result.created_at, result.visibility, result.status, result.secret, result.iv);
      return result;
    });
  }
  async cleanup() {
    const stale = this.ctx.storage.sql.exec<FileRow>("SELECT * FROM cloud_files WHERE status='pending' AND created_at<?", Date.now() - 3600000).toArray();
    for (const row of stale) { await this.env.BLOBS.delete(keyFor(row)); this.ctx.storage.sql.exec("DELETE FROM cloud_files WHERE app_id=? AND id=? AND status='pending'", row.app_id, row.id); }
    return this.ctx.storage.sql.exec("SELECT 1 FROM cloud_files WHERE status='pending' LIMIT 1").toArray().length > 0;
  }
}
