import { sendAccountLive } from "./live";
import { publicProfiles, type User } from "./accounts";

type Author = Pick<User, "id" | "name" | "avatarUrl">;
type Message = { id: string; senderId: string; body: string; createdAt: number };
type Conversation = { peerId: string; lastMessage: Message; unreadCount: number; readThrough?: string };
export class SocialError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const digest = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map(v => v.toString(16).padStart(2, "0")).join("");
const pairKey = (a: string, b: string) => [a, b].sort().join(":");
const messageKey = (pair: string, message: Message) => `dm:${pair}:${String(message.createdAt).padStart(13, "0")}:${message.id}`;
const inboxKey = (owner: string, conversation: Conversation) => `inbox:${owner}:${String(9999999999999 - conversation.lastMessage.createdAt).padStart(13, "0")}:${conversation.peerId}`;
async function inputOf(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw new SocialError("请求内容为空");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 12288) { await reader.cancel(); throw new SocialError("内容过长", 413); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const input = JSON.parse(new TextDecoder().decode(bytes));
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error();
    return input;
  } catch { throw new SocialError("请求内容无效"); }
}

/** Uses the existing Posts storage; private messages never enter the public timeline. */
export class SocialInbox {
  constructor(private ctx: DurableObjectState, private env: Env) {}
  private notify(owner: string, type: "message" | "read", peerId?: string) {
    return sendAccountLive(this.ctx, owner, type, {peerId});
  }
  async relations(authorId: string, kind: "following" | "followers", url: URL, viewer: User | null) {
    if (!uuid.test(authorId)) throw new SocialError("作者标识无效");
    if (!(await publicProfiles([authorId], this.env)).has(authorId)) throw new SocialError("这位作者不存在", 404);
    // Old follow records are indexed once; future writes maintain both directions atomically.
    await this.ctx.storage.transaction(async storage => {
      if (await storage.get("social-follow-index:v1")) return;
      let cursor: string | undefined;
      while (true) {
        const records = await storage.list<boolean>({ prefix: "follow:", startAfter: cursor, limit: 256 });
        for (const [key, value] of records) {
          const [, from, to] = key.split(":");
          if (value && uuid.test(from) && uuid.test(to)) await storage.put(`follower:${to}:${from}`, true);
        }
        if (records.size < 256) break;
        cursor = [...records.keys()].at(-1);
      }
      await storage.put("social-follow-index:v1", true);
    });
    const prefix = `${kind === "following" ? "follow" : "follower"}:${authorId}:`;
    const cursor = url.searchParams.get("cursor") || undefined;
    if (cursor && (!cursor.startsWith(prefix) || !uuid.test(cursor.slice(prefix.length)))) throw new SocialError("关注分页标记无效");
    const records = await this.ctx.storage.list<boolean>({ prefix, startAfter: cursor, limit: 51 });
    const entries = [...records.entries()].slice(0, 50);
    const profiles = await publicProfiles(entries.map(([key]) => key.slice(prefix.length)), this.env);
    const ids = [...profiles.keys()];
    const relations = viewer ? await this.ctx.storage.get<boolean>(ids.flatMap(id => [`follow:${viewer.id}:${id}`, `follow:${id}:${viewer.id}`])) : new Map();
    return json({
      authors: entries.flatMap(([key]) => {
        const id = key.slice(prefix.length), author = profiles.get(id);
        return author ? [{ author, following: !!relations.get(`follow:${viewer?.id}:${id}`), followsYou: !!relations.get(`follow:${id}:${viewer?.id}`) }] : [];
      }),
      nextCursor: records.size > 50 ? entries.at(-1)![0] : null,
    });
  }
  async handle(request: Request, user: User) {
    const url = new URL(request.url);
    if (url.pathname === "/v1/messages/live" && request.method === "GET") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") throw new SocialError("需要建立实时连接", 426);
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], [user.id]);
      pair[1].serializeAttachment({ expiresAt: Date.now() + 3600000 });
      await sendAccountLive(this.ctx, user.id, "ready", {}, pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname === "/v1/messages/unread" && request.method === "GET") return json({ unreadCount: (await this.ctx.storage.get<number>(`dm-unread:${user.id}`)) ?? 0 });
    if (url.pathname === "/v1/messages" && request.method === "GET") return this.inbox(url, user);
    const match = url.pathname.match(/^\/v1\/messages\/([a-f0-9-]{36})(\/read)?$/);
    if (!match || !uuid.test(match[1]) || match[1] === user.id) throw new SocialError("私信对象无效");
    const peer = (await publicProfiles([match[1]], this.env)).get(match[1]);
    if (!peer) throw new SocialError("这位用户不存在", 404);
    if (request.method === "GET" && !match[2]) return this.thread(url, user, peer);
    if (request.method === "POST" && !match[2]) return this.send(request, user, peer);
    if (request.method === "POST" && match[2]) return this.markRead(request, user, peer.id);
    throw new SocialError("私信操作不存在", 404);
  }
  private async inbox(url: URL, user: User) {
    const prefix = `inbox:${user.id}:`;
    const cursor = url.searchParams.get("cursor") || undefined;
    if (cursor && (!cursor.startsWith(prefix) || !/^\d{13}:[a-f0-9-]{36}$/.test(cursor.slice(prefix.length)))) throw new SocialError("会话分页标记无效");
    const entries = [...(await this.ctx.storage.list<Conversation>({ prefix, startAfter: cursor, limit: 51 })).entries()];
    const page = entries.slice(0, 50);
    const profiles = await publicProfiles(page.map(([, item]) => item.peerId), this.env);
    return json({ conversations: page.map(([, item]) => ({ ...item, peer: profiles.get(item.peerId) ?? { id: item.peerId, name: "用户", avatarUrl: null } })), nextCursor: entries.length > 50 ? page.at(-1)![0] : null, unreadCount: (await this.ctx.storage.get<number>(`dm-unread:${user.id}`)) ?? 0 });
  }
  private async thread(url: URL, user: User, peer: Author) {
    const prefix = `dm:${pairKey(user.id, peer.id)}:`;
    const cursor = url.searchParams.get("cursor") || undefined;
    if (cursor && (!cursor.startsWith(prefix) || !/^\d{13}:[a-f0-9]{64}$/.test(cursor.slice(prefix.length)))) throw new SocialError("私信分页标记无效");
    const afterId = url.searchParams.get("after");
    let after: string | undefined;
    if (afterId) {
      if (cursor || !/^[a-f0-9]{64}$/.test(afterId)) throw new SocialError("私信增量位置无效");
      after = await this.ctx.storage.get<string>(`dm-id:${pairKey(user.id,peer.id)}:${afterId}`);
      if (!after) throw new SocialError("私信增量位置不存在",404);
    }
    const records = await this.ctx.storage.list<Message>({ prefix, ...(after ? {startAfter: after, reverse: false} : {end: cursor, reverse: true}), limit: 51 });
    const entries = [...records.entries()].slice(0, 50);
    return json({ peer, messages: after ? entries.map(([,message]) => message) : entries.map(([, message]) => message).reverse(), nextCursor: after ? null : records.size > 50 ? entries.at(-1)![0] : null, hasMoreNew: !!after && records.size > 50 });
  }
  private async storeConversation(storage: DurableObjectTransaction, owner: string, next: Conversation, previousKey?: string) {
    if (previousKey) await storage.delete(previousKey);
    const key = inboxKey(owner, next);
    await storage.put(key, next);
    await storage.put(`inbox-id:${owner}:${next.peerId}`, key);
  }
  private async send(request: Request, user: User, peer: Author) {
    const input = await inputOf(request);
    if (typeof input.body !== "string" || !input.body.trim() || Array.from(input.body.trim()).length > 2000) throw new SocialError("请输入 1 到 2000 字的私信");
    if (typeof input.requestId !== "string" || !/^[a-zA-Z0-9-]{12,100}$/.test(input.requestId)) throw new SocialError("发送标识无效");
    const body = input.body.trim(), pair = pairKey(user.id, peer.id);
    const id = await digest(`${user.id}:${peer.id}:${input.requestId}`);
    const result = await this.ctx.storage.transaction(async storage => {
      const requestKey = `dm-request:${user.id}:${peer.id}:${input.requestId}`;
      const prior = await storage.get<Message>(requestKey);
      if (prior) { if (prior.body !== body) throw new SocialError("发送内容已改变，请重新发送", 409); return { message: prior, created: false }; }
      const rateKey = `dm-rate:${user.id}`;
      const rate = (await storage.get<{ at: number; count: number }>(rateKey)) ?? { at: Date.now(), count: 0 };
      if (Date.now() - rate.at >= 60000) { rate.at = Date.now(); rate.count = 0; }
      if (rate.count >= 30) throw new SocialError("发送太频繁，请稍后再试", 429);
      const senderKey = await storage.get<string>(`inbox-id:${user.id}:${peer.id}`);
      const sender = senderKey ? await storage.get<Conversation>(senderKey) : undefined;
      const recipientKey = await storage.get<string>(`inbox-id:${peer.id}:${user.id}`);
      const recipient = recipientKey ? await storage.get<Conversation>(recipientKey) : undefined;
      const message: Message = { id, senderId: user.id, body, createdAt: Math.max(Date.now(), (sender?.lastMessage.createdAt ?? 0) + 1) };
      const key = messageKey(pair, message);
      await storage.put(key, message);
      await storage.put(`dm-id:${pair}:${id}`, key);
      await storage.put(requestKey, message);
      await storage.put(rateKey, { ...rate, count: rate.count + 1 });
      await this.storeConversation(storage, user.id, { ...sender, peerId: peer.id, lastMessage: message, unreadCount: sender?.unreadCount ?? 0 }, senderKey);
      await this.storeConversation(storage, peer.id, { ...recipient, peerId: user.id, lastMessage: message, unreadCount: (recipient?.unreadCount ?? 0) + 1 }, recipientKey);
      await storage.put(`dm-unread:${peer.id}`, ((await storage.get<number>(`dm-unread:${peer.id}`)) ?? 0) + 1);
      return { message, created: true };
    });
    if (result.created) { await this.notify(user.id, "message", peer.id); await this.notify(peer.id, "message", user.id); }
    return json({ message: result.message }, result.created ? 201 : 200);
  }
  private async markRead(request: Request, user: User, peerId: string) {
    const input = await inputOf(request), pair = pairKey(user.id, peerId);
    if (typeof input.through !== "string" || !/^[a-f0-9]{64}$/.test(input.through)) throw new SocialError("已读位置无效");
    const through = await this.ctx.storage.get<string>(`dm-id:${pair}:${input.through}`);
    if (!through) throw new SocialError("私信不存在", 404);
    const changed = await this.ctx.storage.transaction(async storage => {
      const key = await storage.get<string>(`inbox-id:${user.id}:${peerId}`);
      const conversation = key ? await storage.get<Conversation>(key) : undefined;
      if (!key || !conversation || (conversation.readThrough && conversation.readThrough >= through)) return false;
      let cursor = conversation.readThrough, read = 0;
      while (true) {
        const records = await storage.list<Message>({ prefix: `dm:${pair}:`, startAfter: cursor, end: through + "~", limit: 256 });
        for (const message of records.values()) if (message.senderId !== user.id) read++;
        if (records.size < 256) break;
        cursor = [...records.keys()].at(-1);
      }
      const removed = Math.min(read, conversation.unreadCount);
      await storage.put(key, { ...conversation, unreadCount: conversation.unreadCount - removed, readThrough: through });
      await storage.put(`dm-unread:${user.id}`, Math.max(0, ((await storage.get<number>(`dm-unread:${user.id}`)) ?? 0) - removed));
      return removed > 0;
    });
    if (changed) await this.notify(user.id, "read", peerId);
    return json({ unreadCount: (await this.ctx.storage.get<number>(`dm-unread:${user.id}`)) ?? 0 });
  }
}
