import { authenticatedUser } from "./accounts";

const id = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
type Member = { id: string; name: string; avatarUrl: string | null };
type Connection = { member: Member; expiresAt: number; roomId: string; appId: string; window: number; count: number };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function applicationRooms(request: Request, env: Env): Promise<Response> {
  const match = new URL(request.url).pathname.match(/^\/v1\/app-rooms\/([a-z][a-z0-9-]{0,63})\/([A-Za-z][A-Za-z0-9_-]{0,63})\/(live|data\/([A-Za-z][A-Za-z0-9_-]{0,63}))$/);
  if (!match) return json({ code: "INVALID_ARGUMENT", message: "房间参数无效" }, 400);
  const user = await authenticatedUser(request, env);
  if (!user) return json({ code: "UNAUTHENTICATED", message: "请先登录" }, 401);
  const [, appId, roomId, operation, collection] = match;
  if (!await env.WORKSHOP.getByName("dynamic").canUseCloud(appId, user.id)) return json({ code: "FORBIDDEN", message: "应用未开放" }, 403);
  // One per-user gate also bounds creation of new room instances.
  if (!await env.APP_DATA.getByName(`user:${user.id}`).cloudGate(user.id)) return json({ code: "RATE_LIMITED", message: "请求过于频繁" }, 429);
  const room = env.APP_DATA.getByName(`room:${appId}:${roomId}`);
  if (operation === "live") {
    if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return json({ code: "INVALID_ARGUMENT", message: "需要 WebSocket 连接" }, 400);
    return room.fetch(new Request("https://room.internal/room", { headers: {
      Upgrade: "websocket", "X-Room-Identity": JSON.stringify({ appId, roomId, member: { id: user.id, name: user.name, avatarUrl: user.avatarUrl } }),
    } }));
  }
  if (request.method !== "POST") return json({ code: "INVALID_ARGUMENT", message: "请求方法无效" }, 400);
  const text = await boundedBody(request, 98304);
  if (text === null) return json({ code: "INVALID_ARGUMENT", message: "请求内容过大" }, 400);
  let input: unknown; try { input = JSON.parse(text); } catch { return json({ code: "INVALID_ARGUMENT", message: "请求内容无效" }, 400); }
  return room.fetch(new Request("https://room.internal/operation", { method: "POST", body: JSON.stringify({ appId, roomId, userId: user.id, scope: "room", collection, input }) }));
}

export async function boundedBody(request: Request, limit: number): Promise<string | null> {
  const reader = request.body?.getReader(); if (!reader) return null;
  let size = 0; const parts: Uint8Array[] = [];
  try {
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > limit) { await reader.cancel(); return null; } parts.push(part.value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return new TextDecoder().decode(bytes);
}

/** Uses the existing APP_DATA namespace; room traffic never enters a private store. */
export class RoomConnections {
  constructor(private ctx: DurableObjectState) {}
  private nextSequence() {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS room_sequence (id INTEGER PRIMARY KEY, value INTEGER NOT NULL); INSERT OR IGNORE INTO room_sequence VALUES(1,0);");
    return this.ctx.storage.sql.exec<{ value: number }>("UPDATE room_sequence SET value=value+1 WHERE id=1 RETURNING value").one().value;
  }
  private identity(appId: string, roomId: string) {
    const tenant = `room:${appId}:${roomId}`;
    const row = this.ctx.storage.sql.exec<{ tenant: string }>("SELECT tenant FROM identity WHERE id=1").toArray()[0];
    if (row && row.tenant !== tenant) throw new Error("Room identity mismatch");
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO identity VALUES(1,?)", tenant);
  }
  private live() {
    return this.ctx.getWebSockets().filter(socket => {
      if (socket.readyState !== WebSocket.OPEN) return false;
      const meta = socket.deserializeAttachment() as Connection | null;
      if (!meta || meta.expiresAt <= Date.now()) { try { socket.close(1000, "Reconnect"); } catch {} return false; }
      return true;
    });
  }
  private members() { return [...new Map(this.live().map(socket => { const meta = socket.deserializeAttachment() as Connection; return [meta.member.id, meta.member] as const; })).values()]; }
  private broadcast(value: unknown) { const text = JSON.stringify(value); for (const socket of this.live()) { try { socket.send(text); } catch { try { socket.close(); } catch {} } } }
  connect(request: Request): Response {
    const { appId, roomId, member } = JSON.parse(request.headers.get("X-Room-Identity") || "{}");
    if (typeof appId !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(appId) || !id.test(roomId) || !member?.id) return json({ code: "INVALID_ARGUMENT", message: "房间参数无效" }, 400);
    this.identity(appId, roomId);
    const existing = this.live();
    if (existing.length >= 64 || existing.filter(socket => (socket.deserializeAttachment() as Connection).member.id === member.id).length >= 4) return json({ code: "QUOTA_EXCEEDED", message: "房间连接数已满" }, 429);
    const pair = new WebSocketPair(); const [client, server] = Object.values(pair);
    server.serializeAttachment({ appId, roomId, member, expiresAt: Date.now() + 300000, window: 0, count: 0 } satisfies Connection);
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "ready", members: this.members(), sequence: this.nextSequence() }));
    this.broadcast({ type: "members", members: this.members() });
    return new Response(null, { status: 101, webSocket: client });
  }
  message(socket: WebSocket, message: string | ArrayBuffer) {
    const meta = socket.deserializeAttachment() as Connection | null;
    if (!meta || meta.expiresAt <= Date.now()) { socket.close(1000, "Reconnect"); return; }
    let requestId: string | undefined;
    try {
      if (typeof message !== "string" || new TextEncoder().encode(message).length > 16384) throw new Error("事件不能超过 16 KB");
      const input = JSON.parse(message); requestId = input.requestId;
      if (typeof input.event !== "string" || !id.test(input.event) || typeof requestId !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(requestId) || !input.data || typeof input.data !== "object" || Array.isArray(input.data)) throw new Error("事件参数无效");
      const window = Math.floor(Date.now() / 60000);
      if (meta.window !== window) { meta.window = window; meta.count = 0; }
      if (++meta.count > 120) { socket.send(JSON.stringify({ type: "error", requestId, code: "RATE_LIMITED", message: "事件发送过于频繁" })); return; }
      socket.serializeAttachment(meta);
      const sequence = this.nextSequence();
      this.broadcast({ type: "event", event: input.event, data: input.data, senderId: meta.member.id, sequence });
      socket.send(JSON.stringify({ type: "ack", requestId }));
    } catch (error) { socket.send(JSON.stringify({ type: "error", requestId, code: "INVALID_ARGUMENT", message: error instanceof Error ? error.message : "事件无效" })); }
  }
  changed(collection: string) { this.broadcast({ type: "changed", collection, sequence: this.nextSequence() }); }
  closed(socket: WebSocket) { try { socket.close(); } catch {} this.broadcast({ type: "members", members: this.members() }); }
}
