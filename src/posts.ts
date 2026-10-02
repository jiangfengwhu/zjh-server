import { DurableObject } from "cloudflare:workers";
import { authenticatedUser, publicProfiles, type User } from "./accounts";
import { KeyedQueue } from "./concurrency";

type Author = Pick<User, "id" | "name" | "avatarUrl">;
type Media = { id: string; ownerId: string; key: string; url: string; createdAt: number; postId?: string };
type Post = { id: string; author: Author; body: string; images: Array<{ id: string; url: string }>; createdAt: number };
type Comment = { id: string; postId: string; author: Author; body: string; createdAt: number; replyTo?: { id: string; name: string } };
type Stats = { likes: number; comments: number };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
class InputError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
async function bodyBytes(request: Request, limit: number) {
  if (Number(request.headers.get("Content-Length")) > limit) throw new InputError("内容过大", 413);
  const reader = request.body?.getReader(); if (!reader) throw new InputError("请求内容为空");
  const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > limit) { await reader.cancel(); throw new InputError("内容过大", 413); } chunks.push(chunk.value); } }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; } return bytes;
}
const digest = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map(v => v.toString(16).padStart(2, "0")).join("");
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const postKey = (post: Post) => `post:${String(9999999999999 - post.createdAt).padStart(13, "0")}:${post.id}`;

/** Public user timeline; account credentials and app-generated posts remain separate. */
export class Posts extends DurableObject<Env> {
  private queue = new KeyedQueue();
  private resetting = false;
  private pending = new Set<Promise<unknown>>();
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/internal/development-reset" && request.method === "POST") {
      if (this.resetting) return json({ message: "动态正在重置" }, 409);
      this.resetting = true;
      try { await Promise.allSettled([...this.pending]); return await this.handle(request); } finally { this.resetting = false; }
    }
    if (this.resetting) return json({ message: "动态正在重置，请稍后重试" }, 503);
    const operation = this.handle(request); this.pending.add(operation);
    try { return await operation; } finally { this.pending.delete(operation); }
  }
  private async handle(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/internal/development-reset" && request.method === "POST") {
        await this.ctx.storage.deleteAll(); await this.ctx.storage.deleteAlarm();
        let cursor: string | undefined;
        do { const page = await this.env.BLOBS.list({ prefix: "v1/post-images/", cursor }); if (page.objects.length) await this.env.BLOBS.delete(page.objects.map(item => item.key)); cursor = page.truncated ? page.cursor : undefined; } while (cursor);
        return json({ reset: true });
      }
      if (url.pathname === "/v1/posts" && request.method === "GET") {
        const cursor = url.searchParams.get("cursor") || undefined;
        if (cursor && !/^post:\d{13}:[a-f0-9]{64}$/.test(cursor)) throw new InputError("分页标记无效");
        const entries = await this.ctx.storage.list<Post>({ prefix: "post:", startAfter: cursor, limit: 51 });
        const page = [...entries].slice(0, 50); const profiles = await publicProfiles([...new Set(page.map(([, post]) => post.author.id))], this.env);
        const viewer = request.headers.has("Authorization") ? await authenticatedUser(request, this.env) : null;
        return json({ posts: await Promise.all(page.map(async ([, post]) => this.decorate({ ...post, author: profiles.get(post.author.id) ?? post.author }, viewer))), nextCursor: entries.size > 50 ? page.at(-1)![0] : null });
      }
      const target = url.pathname.match(/^\/v1\/posts\/([a-f0-9]{64})(?:\/(like|comments)(?:\/([a-f0-9]{64}))?)?$/);
      if (target && request.method === "GET" && target[2] !== "like" && !target[3]) {
        const post = await this.findPost(target[1]);
        const page = await this.comments(target[1], url.searchParams.get("cursor") || undefined);
        const viewer = request.headers.has("Authorization") ? await authenticatedUser(request, this.env) : null;
        const profiles = await publicProfiles([post.author.id, ...page.comments.map(item => item.author.id)], this.env);
        return json({ post: await this.decorate({ ...post, author: profiles.get(post.author.id) ?? post.author }, viewer), comments: page.comments.map(item => ({ ...item, author: profiles.get(item.author.id) ?? item.author })), nextCursor: page.nextCursor });
      }
      const user = await authenticatedUser(request, this.env); if (!user) return json({ message: "请先登录后再发动态" }, 401);
      return await this.queue.run(user.id, async () => {
        if (url.pathname === "/v1/post-media" && request.method === "PUT") return this.upload(request, user);
        if (url.pathname === "/v1/posts" && request.method === "POST") return this.publish(request, user);
        const match = url.pathname.match(/^\/v1\/posts\/([a-f0-9]{64})$/);
        if (match && request.method === "DELETE") return this.queue.run(`post:${match[1]}`, () => this.remove(match[1], user));
        if (target && target[2] === "like" && ["POST", "DELETE"].includes(request.method)) return this.queue.run(`post:${target[1]}`, () => this.like(target[1], user, request.method === "POST"));
        if (target && target[2] === "comments" && !target[3] && request.method === "POST") return this.queue.run(`post:${target[1]}`, () => this.comment(target[1], request, user));
        if (target && target[2] === "comments" && target[3] && request.method === "DELETE") return this.queue.run(`post:${target[1]}`, () => this.removeComment(target[1], target[3]!, user));
        return json({ message: "操作不存在" }, 404);
      });
    } catch (error) { return json({ message: error instanceof InputError ? error.message : "动态操作未完成，请稍后重试" }, error instanceof InputError ? error.status : 503); }
  }
  private async findPost(id: string): Promise<Post> {
    const key = await this.ctx.storage.get<string>(`id:${id}`); const post = key ? await this.ctx.storage.get<Post>(key) : undefined;
    if (!post) throw new InputError("这条动态已删除或不存在", 404); return post;
  }
  private async decorate(post: Post, viewer: User | null) {
    const stats = await this.ctx.storage.get<Stats>(`stats:${post.id}`) ?? { likes: 0, comments: 0 };
    const liked = viewer ? !!await this.ctx.storage.get(`like:${post.id}:${viewer.id}`) : false;
    return { ...post, likeCount: stats.likes, commentCount: stats.comments, liked };
  }
  private async like(id: string, user: User, wanted: boolean) {
    const post = await this.findPost(id); const key = `like:${id}:${user.id}`;
    await this.ctx.storage.transaction(async storage => {
      const prior = !!await storage.get(key); if (prior === wanted) return;
      const stats = await storage.get<Stats>(`stats:${id}`) ?? { likes: 0, comments: 0 };
      if (wanted) await storage.put(key, true); else await storage.delete(key);
      stats.likes = Math.max(0, stats.likes + (wanted ? 1 : -1)); await storage.put(`stats:${id}`, stats);
    });
    return json({ post: await this.decorate(post, user) });
  }
  private async comments(id: string, cursor?: string) {
    const prefix = `comment:${id}:`;
    if (cursor && (!cursor.startsWith(prefix) || !/^comment:[a-f0-9]{64}:\d{13}:[a-f0-9]{64}$/.test(cursor))) throw new InputError("评论分页标记无效");
    const records = await this.ctx.storage.list<Comment>({ prefix, startAfter: cursor, limit: 51 }); const entries = [...records].slice(0, 50);
    return { comments: entries.map(([, value]) => value), nextCursor: records.size > 50 ? entries.at(-1)![0] : null };
  }
  private async comment(id: string, request: Request, user: User) {
    const post = await this.findPost(id); let input: { body?: unknown; requestId?: unknown; replyTo?: unknown };
    try { input = JSON.parse(new TextDecoder().decode(await bodyBytes(request, 8192))); } catch { throw new InputError("评论格式无效"); }
    if (!input || typeof input.body !== "string" || typeof input.requestId !== "string" || !/^[a-zA-Z0-9-]{8,100}$/.test(input.requestId)) throw new InputError("评论格式无效");
    const body = input.body.trim(); if (!body || Array.from(body).length > 1000) throw new InputError("评论需为 1 到 1000 个字");
    if (input.replyTo != null && (typeof input.replyTo !== "string" || !/^[a-f0-9]{64}$/.test(input.replyTo))) throw new InputError("回复目标无效");
    const fingerprint = await digest(JSON.stringify([body, input.replyTo ?? null])); const requestKey = `comment-request:${id}:${user.id}:${input.requestId}`;
    const prior = await this.ctx.storage.get<{ key: string; fingerprint: string }>(requestKey);
    if (prior) { const comment = await this.ctx.storage.get<Comment>(prior.key); if (!comment || prior.fingerprint !== fingerprint) throw new InputError("这次评论已处理，请重新评论", 409); return json({ comment, post: await this.decorate(post, user) }); }
    await this.rate(user.id, "comment", 20);
    let replyTo: Comment["replyTo"];
    if (input.replyTo) { const key = await this.ctx.storage.get<string>(`comment-id:${id}:${input.replyTo}`); const target = key ? await this.ctx.storage.get<Comment>(key) : undefined; if (!target) throw new InputError("回复的评论已删除"); replyTo = { id: target.id, name: target.author.name }; }
    const comment: Comment = { id: await digest(`${id}:${user.id}:${input.requestId}`), postId: id, author: { id: user.id, name: user.name, avatarUrl: user.avatarUrl }, body, createdAt: Date.now(), ...(replyTo ? { replyTo } : {}) };
    const key = `comment:${id}:${String(comment.createdAt).padStart(13, "0")}:${comment.id}`;
    await this.ctx.storage.transaction(async storage => { const stats = await storage.get<Stats>(`stats:${id}`) ?? { likes: 0, comments: 0 }; stats.comments++; await storage.put(key, comment); await storage.put(`comment-id:${id}:${comment.id}`, key); await storage.put(requestKey, { key, fingerprint }); await storage.put(`stats:${id}`, stats); });
    return json({ comment, post: await this.decorate(post, user) }, 201);
  }
  private async removeComment(id: string, commentId: string, user: User) {
    const post = await this.findPost(id); const key = await this.ctx.storage.get<string>(`comment-id:${id}:${commentId}`); const comment = key ? await this.ctx.storage.get<Comment>(key) : undefined;
    if (!comment) return json({ deleted: true, post: await this.decorate(post, user) });
    if (comment.author.id !== user.id) throw new InputError("只能删除自己的评论", 403);
    await this.ctx.storage.transaction(async storage => { const stats = await storage.get<Stats>(`stats:${id}`) ?? { likes: 0, comments: 0 }; stats.comments = Math.max(0, stats.comments - 1); await storage.delete(key!); await storage.delete(`comment-id:${id}:${commentId}`); await storage.put(`stats:${id}`, stats); });
    return json({ deleted: true, post: await this.decorate(post, user) });
  }
  private async deletePrefix(prefix: string) {
    while (true) { const records = await this.ctx.storage.list({ prefix, limit: 128 }); if (!records.size) return; await this.ctx.storage.delete([...records.keys()]); }
  }
  private async rate(userId: string, kind: string, maximum: number) {
    const key = `rate:${userId}:${kind}`; const now = Date.now(); const prior = await this.ctx.storage.get<{ count: number; at: number }>(key);
    const value = prior && now - prior.at < 60000 ? prior : { count: 0, at: now };
    if (value.count >= maximum) throw new InputError("操作较频繁，请稍后重试", 429);
    value.count++; await this.ctx.storage.put(key, value);
  }
  private async upload(request: Request, user: User) {
    await this.rate(user.id, "upload", 20);
    const bytes = await bodyBytes(request, 3 * 1024 * 1024); const header = [...bytes.slice(0, 12)];
    const type = header[0] === 255 && header[1] === 216 && header[2] === 255 ? "image/jpeg" : header.slice(0, 8).join(",") === "137,80,78,71,13,10,26,10" ? "image/png" : String.fromCharCode(...header.slice(0, 4)) === "RIFF" && String.fromCharCode(...header.slice(8, 12)) === "WEBP" ? "image/webp" : undefined;
    if (!type) throw new InputError("请选择 JPEG、PNG 或 WebP 图片");
    const id = crypto.randomUUID(); const key = `v1/post-images/${user.id}/${id}`;
    await this.env.BLOBS.put(key, bytes, { httpMetadata: { contentType: type, cacheControl: "public,max-age=3600" } });
    const media: Media = { id, key, ownerId: user.id, url: `https://zijinhua.297782.xyz/${key}`, createdAt: Date.now() };
    await this.ctx.storage.put(`media:${id}`, media);
    if (!await this.ctx.storage.getAlarm()) await this.ctx.storage.setAlarm(Date.now() + 3600000);
    return json({ image: { id, url: media.url } }, 201);
  }
  private async publish(request: Request, user: User) {
    let input: { body?: unknown; imageIds?: unknown; requestId?: unknown };
    try { input = JSON.parse(new TextDecoder().decode(await bodyBytes(request, 16384))); } catch (error) { if (error instanceof InputError) throw error; throw new InputError("请求格式不正确"); }
    if (!input || typeof input !== "object" || typeof input.body !== "string" || typeof input.requestId !== "string" || !/^[a-zA-Z0-9-]{8,100}$/.test(input.requestId)) throw new InputError("动态内容无效");
    const body = input.body.trim(); const ids = input.imageIds;
    if (Array.from(body).length > 2000 || !Array.isArray(ids) || ids.length > 4 || ids.some(id => typeof id !== "string" || !uuid.test(id)) || new Set(ids).size !== ids.length || (!body && !ids.length)) throw new InputError("动态需有文字或图片，最多 2000 字、4 张图");
    const fingerprint = await digest(JSON.stringify({ body, ids })); const requestKey = `request:${user.id}:${input.requestId}`;
    const prior = await this.ctx.storage.get<{ key: string; fingerprint: string }>(requestKey);
    if (prior) { const post = await this.ctx.storage.get<Post>(prior.key); if (prior.fingerprint !== fingerprint || !post) throw new InputError("这次发布已处理，请新建动态", 409); return json({ post: await this.decorate(post, user) }); }
    await this.rate(user.id, "publish", 5);
    const media = await Promise.all(ids.map(id => this.ctx.storage.get<Media>(`media:${id}`)));
    if (media.some(item => !item || item.ownerId !== user.id || item.postId || Date.now() - item.createdAt > 86400000)) throw new InputError("图片已失效，请重新选择");
    const post: Post = { id: await digest(`${user.id}:${input.requestId}`), author: { id: user.id, name: user.name, avatarUrl: user.avatarUrl }, body, images: media.map(item => ({ id: item!.id, url: item!.url })), createdAt: Date.now() };
    await this.ctx.storage.transaction(async storage => {
      await storage.put(postKey(post), post); await storage.put(`id:${post.id}`, postKey(post)); await storage.put(requestKey, { key: postKey(post), fingerprint });
      for (const item of media) await storage.put(`media:${item!.id}`, { ...item!, postId: post.id });
    });
    return json({ post: await this.decorate(post, user) }, 201);
  }
  private async remove(id: string, user: User) {
    const key = await this.ctx.storage.get<string>(`id:${id}`); const post = key ? await this.ctx.storage.get<Post>(key) : undefined;
    if (!post) return json({ deleted: true });
    if (post.author.id !== user.id) throw new InputError("只能删除自己的动态", 403);
    await this.ctx.storage.transaction(async storage => { await storage.delete(key!); await storage.delete(`id:${id}`); for (const image of post.images) { const media = await storage.get<Media>(`media:${image.id}`); if (media) await storage.put(`media:${image.id}`, { ...media, postId: undefined, createdAt: 0 }); } });
    for (const prefix of [`like:${id}:`, `comment:${id}:`, `comment-id:${id}:`, `comment-request:${id}:`]) await this.deletePrefix(prefix);
    await this.ctx.storage.delete(`stats:${id}`);
    for (const image of post.images) { const media = await this.ctx.storage.get<Media>(`media:${image.id}`); if (media) { await this.env.BLOBS.delete(media.key); await this.ctx.storage.delete(`media:${image.id}`); } }
    return json({ deleted: true });
  }
  async alarm() {
    if (this.resetting) return;
    const operation = this.cleanup(); this.pending.add(operation);
    try { await operation; } finally { this.pending.delete(operation); }
  }
  private async cleanup() {
    const records = await this.ctx.storage.list<Media>({ prefix: "media:" });
    for (const [key, media] of records) if (!media.postId && Date.now() - media.createdAt > 86400000) {
      await this.queue.run(media.ownerId, async () => {
        const current = await this.ctx.storage.get<Media>(key);
        if (!current || current.postId || Date.now() - current.createdAt <= 86400000) return;
        await this.env.BLOBS.delete(current.key); await this.ctx.storage.delete(key);
      });
    }
    await this.ctx.storage.setAlarm(Date.now() + 86400000);
  }
}

export async function readPostImage(request: Request, env: Env) {
  const object = await env.BLOBS.get(new URL(request.url).pathname.slice(1)); if (!object) return json({ message: "图片不存在" }, 404);
  const headers = new Headers(); object.writeHttpMetadata(headers); headers.set("X-Content-Type-Options", "nosniff"); headers.set("ETag", object.httpEtag);
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

export async function readSharedPost(request: Request, env: Env) {
  const id = new URL(request.url).pathname.split("/").at(-1)!;
  const response = await env.POSTS.getByName("timeline").fetch(new Request(`https://posts.internal/v1/posts/${id}`));
  const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!));
  const data = await response.json() as { post?: Post };
  const post = data.post;
  const content = post ? `<h2>${escape(post.author.name)}</h2><p class="date">${escape(new Date(post.createdAt).toISOString().replace("T", " ").slice(0, 16))} UTC</p><p class="body">${escape(post.body)}</p><div class="images">${post.images.map(image => `<img src="${escape(image.url)}" alt="动态图片" loading="lazy">`).join("")}</div>` : "<p>这条动态已删除或暂时无法查看。</p>";
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(post ? post.author.name + "的动态" : "动态不存在")} · 紫金花</title><style>body{margin:0;background:#faf8f5;color:#25221f;font:16px/1.7 system-ui,sans-serif}main{max-width:620px;margin:0 auto;padding:28px 20px}h1{font-size:18px;color:#9c7437}h2{margin-bottom:0;font-size:18px}.date{font-size:12px;color:#888}.body{white-space:pre-wrap;overflow-wrap:anywhere}.images{display:grid;gap:10px}img{width:100%;border-radius:14px}</style></head><body><main><h1>紫金花</h1>${content}</main></body></html>`;
  return new Response(request.method === "HEAD" ? null : html, { status: response.status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; img-src https:; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'", "x-content-type-options": "nosniff" } });
}
