import { DurableObject } from "cloudflare:workers";
import { Buffer } from "node:buffer";
import { authenticatedUser } from "./accounts";
import { RoomConnections } from "./applicationRooms";
import { FileRecords } from "./applicationFiles";

type Scope = "private" | "public" | "room";
type Scalar = string | number | boolean | null;
type Document = { id: string; data: Record<string, unknown>; createdBy: string; createdAt: number; updatedAt: number; version: number };
type Row = { id: string; data: string; created_by: string; created_at: number; updated_at: number; version: number; bytes: number };
type Envelope = { appId: string; userId: string; scope: Scope; collection: string; input: Record<string, unknown>; roomId?: string };
const identifier = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const fieldIdentifier = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const recordId = /^[a-f0-9-]{36}$/;
const maxDocumentBytes = 32768;
const maxStorageBytes = 50 * 1024 * 1024;
class DataError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const invalid = (message = "云数据参数无效"): never => { throw new DataError("INVALID_ARGUMENT", message); };
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function document(value: unknown): string {
  if (!object(value)) invalid("数据必须为 JSON 对象");
  const walk = (value: unknown, depth: number) => {
    if (depth > 16) invalid("数据嵌套层级过深");
    if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return;
    if (Array.isArray(value)) { value.forEach(item => walk(item, depth + 1)); return; }
    if (object(value)) { Object.values(value).forEach(item => walk(item, depth + 1)); return; }
    invalid("数据包含非 JSON 值");
  };
  walk(value, 0);
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).length > maxDocumentBytes) invalid("单条数据不能超过 32 KB");
  return text;
}
function scalar(value: unknown): value is Scalar { return value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value); }
function record(row: Row): Document { return { id: row.id, data: JSON.parse(row.data), createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at, version: row.version }; }

/** Public ingress: never accepts an application-supplied user identity. */
export async function applicationData(request: Request, env: Env): Promise<Response> {
  try {
    const match = new URL(request.url).pathname.match(/^\/v1\/app-data\/([a-z][a-z0-9-]{0,63})\/(private|public)\/([A-Za-z][A-Za-z0-9_-]{0,63})$/);
    if (!match || request.method !== "POST") return json({ code: "INVALID_ARGUMENT", message: "云数据请求无效" }, 400);
    const user = await authenticatedUser(request, env);
    if (!user) return json({ code: "UNAUTHENTICATED", message: "请先登录" }, 401);
    const [, appId, scope, collection] = match;
    if (!await env.WORKSHOP.getByName("dynamic").canUseCloud(appId, user.id)) return json({ code: "FORBIDDEN", message: "应用不存在或尚未开放" }, 403);
    const reader = request.body?.getReader();
    if (!reader) invalid();
    let size = 0; const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.length;
        if (size > 98304) { await reader.cancel(); invalid("请求内容过大"); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let input: unknown; try { input = JSON.parse(new TextDecoder().decode(bytes)); } catch { invalid(); }
    if (!object(input)) invalid();
    const envelope: Envelope = { appId, userId: user.id, scope: scope as Scope, collection, input };
    const tenant = scope === "private" ? `user:${user.id}` : `app:${appId}`;
    return env.APP_DATA.getByName(tenant).fetch(new Request("https://data.internal/operation", { method: "POST", body: JSON.stringify(envelope) }));
  } catch (error) {
    if (error instanceof DataError) return json({ code: error.code, message: error.message }, error.status);
    console.log(JSON.stringify({ event: "app-data ingress failed" }));
    return json({ code: "UNAVAILABLE", message: "云服务暂不可用" }, 503);
  }
}

/** Private user stores and public application stores use the same isolated schema. */
export class ApplicationDatabase extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS records (app_id TEXT NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(app_id,collection,id));
      CREATE INDEX IF NOT EXISTS records_created ON records(app_id,collection,created_at,id);
      CREATE INDEX IF NOT EXISTS records_updated ON records(app_id,collection,updated_at,id);
      CREATE TABLE IF NOT EXISTS collections (app_id TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY(app_id,name));
      CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY CHECK(id=1), bytes INTEGER NOT NULL, records INTEGER NOT NULL);
      INSERT OR IGNORE INTO usage VALUES(1,0,0);
      CREATE TABLE IF NOT EXISTS requests (user_id TEXT NOT NULL, request_id TEXT NOT NULL, signature TEXT NOT NULL, result TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(user_id,request_id));
      CREATE INDEX IF NOT EXISTS requests_expiry ON requests(expires_at);
      CREATE TABLE IF NOT EXISTS rate (user_id TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK(id=1), tenant TEXT NOT NULL);
    `);
  }
  async fetch(request: Request): Promise<Response> {
    try {
      if (new URL(request.url).pathname === "/room") return new RoomConnections(this.ctx).connect(request);
      const envelope = await request.json() as Envelope;
      if (envelope?.scope === "room" && !identifier.test(envelope.roomId ?? "")) invalid("房间编号无效");
      if (!envelope || !/^[a-z][a-z0-9-]{0,63}$/.test(envelope.appId) || !recordId.test(envelope.userId) || !["private", "public", "room"].includes(envelope.scope) || !identifier.test(envelope.collection) || !object(envelope.input)) invalid();
      const now = Date.now();
      this.ctx.storage.transactionSync(() => {
        const tenant = envelope.scope === "private" ? `user:${envelope.userId}` : envelope.scope === "room" && identifier.test(envelope.roomId ?? "") ? `room:${envelope.appId}:${envelope.roomId}` : `app:${envelope.appId}`;
        const identity = this.ctx.storage.sql.exec<{ tenant: string }>("SELECT tenant FROM identity WHERE id=1").toArray()[0];
        if (identity && identity.tenant !== tenant) throw new DataError("FORBIDDEN", "数据空间不匹配", 403);
        this.ctx.storage.sql.exec("INSERT OR IGNORE INTO identity VALUES(1,?)", tenant);
        this.rate(envelope.userId, now);
      });
      // Cleanup is only for request bookkeeping, never business data or polling.
      this.ctx.waitUntil((async () => {
        if (!await this.ctx.storage.getAlarm()) await this.ctx.storage.setAlarm(now + 3600000);
      })());
      const result = this.ctx.storage.transactionSync(() => this.execute(envelope, now));
      if (envelope.scope === "room" && ["create", "update", "increment", "remove"].includes(String(envelope.input.operation))) new RoomConnections(this.ctx).changed(envelope.collection);
      return json({ result });
    } catch (error) {
      if (error instanceof DataError) return json({ code: error.code, message: error.message }, error.status);
      console.log(JSON.stringify({ event: "app-data operation failed" }));
      return json({ code: "UNAVAILABLE", message: "云数据操作暂不可用" }, 503);
    }
  }
  async cloudGate(userId: string): Promise<boolean> {
    try {
      this.ctx.storage.transactionSync(() => {
        const tenant = `user:${userId}`;
        const row = this.ctx.storage.sql.exec<{ tenant: string }>("SELECT tenant FROM identity WHERE id=1").toArray()[0];
        if (!recordId.test(userId) || row && row.tenant !== tenant) throw new Error("Tenant mismatch");
        this.ctx.storage.sql.exec("INSERT OR IGNORE INTO identity VALUES(1,?)", tenant);
        this.rate(userId, Date.now());
      });
      if (!await this.ctx.storage.getAlarm()) await this.ctx.storage.setAlarm(Date.now() + 3600000);
      return true;
    } catch { return false; }
  }
  async fileOperation(operation: string, userId: string, appId: string, input: Record<string, unknown>) { return new FileRecords(this.ctx, this.env).operation(operation, userId, appId, input); }
  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) { new RoomConnections(this.ctx).message(socket, message); }
  webSocketClose(socket: WebSocket) { new RoomConnections(this.ctx).closed(socket); }
  webSocketError(socket: WebSocket) { new RoomConnections(this.ctx).closed(socket); }
  async alarm() {
    this.ctx.storage.sql.exec("DELETE FROM requests WHERE expires_at<=?", Date.now());
    this.ctx.storage.sql.exec("DELETE FROM rate WHERE window<?", Math.floor(Date.now() / 60000) - 1);
    const pendingFiles = await new FileRecords(this.ctx, this.env).cleanup();
    if (pendingFiles || this.ctx.storage.sql.exec("SELECT 1 FROM requests LIMIT 1").toArray().length) await this.ctx.storage.setAlarm(Date.now() + 3600000);
  }
  private rate(userId: string, now: number) {
    const window = Math.floor(now / 60000);
    const prior = this.ctx.storage.sql.exec<{ window: number; count: number }>("SELECT window,count FROM rate WHERE user_id=?", userId).toArray()[0];
    if (prior?.window === window && prior.count >= 120) throw new DataError("RATE_LIMITED", "请求过于频繁，请稍后再试", 429);
    this.ctx.storage.sql.exec("INSERT INTO rate VALUES(?,?,1) ON CONFLICT(user_id) DO UPDATE SET window=excluded.window,count=CASE WHEN rate.window=excluded.window THEN rate.count+1 ELSE 1 END", userId, window);
  }
  private execute(e: Envelope, now: number): unknown {
    const { appId, userId, collection, input } = e;
    const op = input.operation;
    if (op === "list") return this.list(e);
    if (!["get", "create", "update", "increment", "remove"].includes(String(op))) invalid("操作类型无效");
    if (op !== "create" && (typeof input.id !== "string" || !recordId.test(input.id))) invalid("记录 ID 无效");
    const row = op === "create" ? undefined : this.ctx.storage.sql.exec<Row>("SELECT * FROM records WHERE app_id=? AND collection=? AND id=?", appId, collection, input.id as string).toArray()[0];
    if (op === "get") return row ? record(row) : null;
    if (typeof input.requestId !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(input.requestId)) invalid("写入请求 ID 无效");
    if (input.expectedVersion !== undefined && (!Number.isSafeInteger(input.expectedVersion) || Number(input.expectedVersion) < 1)) invalid("记录版本无效");
    const signature = JSON.stringify([appId, collection, op, input.id ?? null, input.data ?? null, input.expectedVersion ?? null]);
    const prior = this.ctx.storage.sql.exec<{ signature: string; result: string; expires_at: number }>("SELECT signature,result,expires_at FROM requests WHERE user_id=? AND request_id=?", userId, input.requestId).toArray()[0];
    if (prior && prior.expires_at > now) {
      if (prior.signature !== signature) throw new DataError("CONFLICT", "同一请求 ID 不能用于不同操作", 409);
      return JSON.parse(prior.result);
    }
    this.ctx.storage.sql.exec("DELETE FROM requests WHERE expires_at<=?", now);
    if (Number(this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM requests").one().count) >= 2000) throw new DataError("RATE_LIMITED", "写入过于频繁，请稍后再试", 429);
    if (row && e.scope !== "room" && row.created_by !== userId) throw new DataError("FORBIDDEN", "只能修改自己创建的记录", 403);
    if (!row && ["update", "increment"].includes(String(op))) throw new DataError("NOT_FOUND", "记录不存在", 404);
    if (input.expectedVersion !== undefined && row?.version !== input.expectedVersion) throw new DataError("CONFLICT", "记录已发生变化，请重新加载", 409);
    let result: Document | null = null;
    if (op === "remove") {
      if (row) {
        this.ctx.storage.sql.exec("DELETE FROM records WHERE app_id=? AND collection=? AND id=?", appId, collection, row.id);
        this.ctx.storage.sql.exec("UPDATE usage SET bytes=bytes-?,records=records-1 WHERE id=1", row.bytes);
      }
    } else {
      document(input.data);
      let patch = input.data as Record<string, unknown>;
      if (op === "increment") {
        patch = { ...JSON.parse(row!.data) };
        const amounts = input.data as Record<string, unknown>;
        if (!Object.keys(amounts).length || Object.keys(amounts).length > 32) invalid("计数字段数量无效");
        for (const [field, amount] of Object.entries(amounts)) {
          const current = Object.hasOwn(patch, field) ? patch[field] : 0;
          if (!fieldIdentifier.test(field) || typeof amount !== "number" || !Number.isFinite(amount) || typeof current !== "number" || !Number.isFinite(current + amount)) invalid("只能累加有限数值字段");
          Object.defineProperty(patch, field, { value: current + amount, enumerable: true, configurable: true, writable: true });
        }
      }
      const data = document(op === "create" ? input.data : { ...JSON.parse(row!.data), ...patch });
      const bytes = new TextEncoder().encode(data).length;
      const usage = this.ctx.storage.sql.exec<{ bytes: number; records: number }>("SELECT bytes,records FROM usage WHERE id=1").one();
      if (usage.bytes + bytes - (row?.bytes ?? 0) > maxStorageBytes || !row && usage.records >= 100000) throw new DataError("QUOTA_EXCEEDED", "云存储空间已满", 413);
      if (!this.ctx.storage.sql.exec("SELECT 1 FROM collections WHERE app_id=? AND name=?", appId, collection).toArray().length) {
        const count = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM collections WHERE app_id=?", appId).one().count;
        if (count >= 100) throw new DataError("QUOTA_EXCEEDED", "应用集合数量已达上限", 413);
        this.ctx.storage.sql.exec("INSERT INTO collections VALUES(?,?)", appId, collection);
      }
      result = { id: row?.id ?? crypto.randomUUID(), data: JSON.parse(data), createdBy: row?.created_by ?? userId, createdAt: row?.created_at ?? now, updatedAt: now, version: (row?.version ?? 0) + 1 };
      this.ctx.storage.sql.exec("INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(app_id,collection,id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at,version=excluded.version,bytes=excluded.bytes", appId, collection, result.id, data, result.createdBy, result.createdAt, now, result.version, bytes);
      this.ctx.storage.sql.exec("UPDATE usage SET bytes=bytes+?,records=records+? WHERE id=1", bytes - (row?.bytes ?? 0), row ? 0 : 1);
    }
    this.ctx.storage.sql.exec("INSERT INTO requests VALUES(?,?,?,?,?)", userId, input.requestId, signature, JSON.stringify(result), now + 3600000);
    return result;
  }
  private list(e: Envelope) {
    const query = e.input.query ?? {};
    if (!object(query)) invalid("查询参数无效");
    const limit = query.limit ?? 20;
    if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 100) invalid("分页数量必须在 1–100 之间");
    const where = query.where ?? [];
    if (!Array.isArray(where) || where.length > 8) invalid("筛选条件过多");
    const order = query.orderBy ?? { field: "createdAt", direction: "desc" };
    if (!object(order) || typeof order.field !== "string" || !fieldIdentifier.test(order.field) || !["asc", "desc"].includes(String(order.direction))) invalid("排序参数无效");
    if (new TextEncoder().encode(JSON.stringify([where, order])).length > 4096) invalid("查询条件过大");
    const direction = order.direction === "asc" ? "ASC" : "DESC";
    const expression = order.field === "createdAt" ? "created_at" : order.field === "updatedAt" ? "updated_at" : `json_extract(data,'$.${order.field}')`;
    const clauses = ["app_id=?", "collection=?"];
    const bindings: (string | number | null)[] = [e.appId, e.collection];
    const ops: Record<string, string> = { eq: "=", ne: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=" };
    for (const condition of where) {
      if (!object(condition) || typeof condition.field !== "string" || !fieldIdentifier.test(condition.field) || typeof condition.op !== "string" || !Object.hasOwn(ops, condition.op) || !scalar(condition.value)) invalid("筛选条件无效");
      const path = `$.${condition.field}`;
      const value = condition.value;
      if (value === null) {
        if (!["eq", "ne"].includes(condition.op)) invalid("null 只支持 eq/ne");
        clauses.push(`json_type(data,?) ${condition.op === "eq" ? "=" : "!="} 'null'`); bindings.push(path);
      } else {
        const type = typeof value === "boolean" ? "('true','false')" : typeof value === "number" ? "('integer','real')" : "('text')";
        clauses.push(`(json_type(data,?) IN ${type} AND json_extract(data,?) ${ops[condition.op]} ?)`);
        bindings.push(path, path, typeof value === "boolean" ? Number(value) : value);
      }
    }
    const signature = JSON.stringify([e.appId, e.scope, e.userId, e.collection, where, order]);
    if (query.cursor !== undefined) {
      if (typeof query.cursor !== "string" || query.cursor.length > 65536) invalid("分页游标无效");
      let cursor: unknown; try { cursor = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")); } catch { invalid("分页游标无效"); }
      if (!object(cursor) || cursor.signature !== signature || typeof cursor.id !== "string" || !recordId.test(cursor.id) || !scalar(cursor.value)) invalid("分页游标与查询不匹配");
      const compare = direction === "ASC" ? ">" : "<";
      if (cursor.value === null) {
        clauses.push(direction === "ASC" ? `(${expression} IS NOT NULL OR (${expression} IS NULL AND id>?))` : `(${expression} IS NULL AND id<?)`); bindings.push(cursor.id);
      } else {
        clauses.push(`(${expression} ${compare} ? OR (${expression} = ? AND id ${compare} ?)${direction === "DESC" ? ` OR ${expression} IS NULL` : ""})`);
        const value = typeof cursor.value === "boolean" ? Number(cursor.value) : cursor.value;
        bindings.push(value, value, cursor.id);
      }
    }
    const rows = this.ctx.storage.sql.exec<Row & { sort_value: Scalar }>(`SELECT *,${expression} AS sort_value FROM records WHERE ${clauses.join(" AND ")} ORDER BY ${expression} ${direction},id ${direction} LIMIT ?`, ...bindings, Number(limit) + 1).toArray();
    const more = rows.length > Number(limit); const page = rows.slice(0, Number(limit)); const last = page.at(-1);
    return { items: page.map(record), nextCursor: more && last ? Buffer.from(JSON.stringify({ signature, id: last.id, value: last.sort_value })).toString("base64url") : null };
  }
}
