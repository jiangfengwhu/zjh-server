import { ApplicationShareError, applicationSelection, resolveApplicationShare, applicationShareQuery, type ApplicationLink } from "./applicationSharing";
import { getMany } from "./storageBatch";
import { sendLive, sendAccountLive } from "./live";
import { sharedLinkActions, sharedLinkStyles } from "./sharedLinks";
import { normalizePostContent, type PostContent } from "./postHtml";
import { DurableObject } from "cloudflare:workers";
import {
  authenticatedUser,
  publicProfiles,
  OFFICIAL_ACCOUNT_ID,
  OFFICIAL_PROFILE,
  type User,
} from "./accounts";
import { SocialInbox, SocialError } from "./social";
import { KeyedQueue } from "./concurrency";
import { TimelineIndex } from "./readIndexes";

type Author = Pick<User, "id" | "name" | "avatarUrl">;
type Media = {
  id: string;
  ownerId: string;
  key: string;
  url: string;
  createdAt: number;
  postId?: string;
};
type Post = {
  applicationDiscussion?: boolean;
  id: string;
  author: Author;
  body: string;
  images: Array<{ id: string; url: string }>;
  createdAt: number;
  application?: ApplicationLink;
  content?: PostContent;
};
type ApplicationItem = { manifest: { appId: string; releaseId: string; appName: string; description: string; accent: string; icon?: ApplicationLink["icon"] }; title?: string; summary?: string; authorId: string | null; authorName: string; authorAvatarUrl?: string | null; iconUrl?: string };
type Comment = {
  id: string;
  postId: string;
  author: Author;
  body: string;
  createdAt: number;
  replyTo?: { id: string; name: string };
};
type Stats = { likes: number; comments: number; views?: number };
type Notice = {
  id: string;
  actor: Author;
  postId: string;
  commentId: string;
  body: string;
  postPreview: string;
  kind: "like" | "comment" | "reply" | "work-success" | "work-failure" | "work-submitted";
  appId?: string;
  createdAt: number;
  read: boolean;
};
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });
class InputError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}
async function bodyBytes(request: Request, limit: number) {
  if (Number(request.headers.get("Content-Length")) > limit)
    throw new InputError("内容过大", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new InputError("请求内容为空");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > limit) {
        await reader.cancel();
        throw new InputError("内容过大", 413);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
const digest = async (text: string) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
    ),
  ]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const postKey = (post: Post) =>
  `post:${String(9999999999999 - post.createdAt).padStart(13, "0")}:${post.id}`;

/** Public user timeline; account credentials and app-generated posts remain separate. */
export class Posts extends DurableObject<Env> {
  private readIndex = new TimelineIndex(this.ctx);
  private queue = new KeyedQueue();
  private noticeChanges = new Set<string>();
  private resetting = false;
  private pending = new Set<Promise<unknown>>();
  async fetch(request: Request): Promise<Response> {
    await this.readIndex.ensure();
    if (
      new URL(request.url).pathname === "/internal/development-reset" &&
      request.method === "POST"
    ) {
      if (this.resetting) return json({ message: "动态正在重置" }, 409);
      this.resetting = true;
      try {
        await Promise.allSettled([...this.pending]);
        return await this.handle(request);
      } finally {
        this.resetting = false;
      }
    }
    if (this.resetting)
      return json({ message: "动态正在重置，请稍后重试" }, 503);
    const operation = this.handle(request);
    this.pending.add(operation);
    try {
      const response = await operation;
      const owners = [...this.noticeChanges];
      this.noticeChanges.clear();
      if (owners.length) this.ctx.waitUntil(Promise.all(owners.map(owner => sendAccountLive(this.ctx, owner, "notification"))).catch(() => {}));
      if (response.ok && request.method === "POST" && new URL(request.url).pathname === "/v1/posts") sendLive(this.ctx, { type: "feed" });
      return response;
    } finally {
      this.pending.delete(operation);
    }
  }
  private async handle(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/internal/account-counts" && request.method === "GET") {
        const viewer = await authenticatedUser(request, this.env);
        if (!viewer) return json({ message: "请先登录" }, 401);
        const [notices, messages] = await Promise.all([this.noticeSummary(viewer.id), this.ctx.storage.get<number>(`dm-unread:${viewer.id}`)]);
        return json({ ...notices, messageUnreadCount: messages ?? 0 });
      }
      if (url.pathname === "/internal/application-interactions" && request.method === "POST") {
        const viewer = request.headers.has("Authorization") ? await authenticatedUser(request, this.env) : null;
        const { applications } = await request.json() as { applications: ApplicationItem[] };
        if (!Array.isArray(applications) || applications.length > 50) throw new InputError("作品分页无效");
        return json({ items: await this.discussions(applications, viewer) });
      }
      if (
        url.pathname === "/internal/development-reset" &&
        request.method === "POST"
      ) {
        await this.ctx.storage.deleteAll();
        this.readIndex = new TimelineIndex(this.ctx);
        await this.ctx.storage.deleteAlarm();
        let cursor: string | undefined;
        do {
          const page = await this.env.BLOBS.list({
            prefix: "v1/post-images/",
            cursor,
          });
          if (page.objects.length)
            await this.env.BLOBS.delete(page.objects.map((item) => item.key));
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
        return json({ reset: true });
      }
      if (url.pathname === "/internal/live-work" && request.method === "POST") {
        const input = await request.json() as { ownerId: string; appId: string };
        if (!uuid.test(input.ownerId) || !/^[a-z][a-z0-9-]{0,63}$/.test(input.appId)) throw new InputError("作品事件无效");
        await sendAccountLive(this.ctx, input.ownerId, "work", { appId: input.appId });
        return json({ sent: true });
      }
      if (
        url.pathname === "/internal/work-notice" &&
        request.method === "POST"
      ) {
        const input = (await request.json()) as {
          ownerId: string;
          appId: string;
          round: string;
          success: boolean;
          kind?: "work-submitted";
          title: string;
          message: string;
        };
        if (
          !uuid.test(input.ownerId) ||
          !/^[a-z][a-z0-9-]{0,63}$/.test(input.appId) ||
          !input.round ||
          input.round.length > 200 ||
          typeof input.success !== "boolean" || (input.kind !== undefined && input.kind !== "work-submitted")
        )
          throw new InputError("制作通知无效");
        const id = await digest(
          `work:${input.ownerId}:${input.appId}:${input.round}:${input.kind || String(input.success)}`
        );
        const notice: Notice = {
          id,
          actor: { id: OFFICIAL_ACCOUNT_ID, ...OFFICIAL_PROFILE },
          postId: "",
          commentId: "",
          appId: input.appId,
          kind: input.kind || (input.success ? "work-success" : "work-failure"),
          body: String(input.message || "").slice(0, 1000),
          postPreview: String(input.title || input.appId).slice(0, 200),
          createdAt: Date.now(),
          read: false,
        };
        await this.ctx.storage.transaction(async (storage) => {
          const index = `notice-id:${input.ownerId}:${id}`;
          if (await storage.get(index)) return;
          const key = `notice:${input.ownerId}:${String(
            9999999999999 - notice.createdAt
          ).padStart(13, "0")}:${id}`;
          await storage.put(key, notice);
          this.readIndex.notice(key, input.ownerId, notice.kind);
          await storage.put(index, key);
          await this.changeUnread(storage, input.ownerId, notice.kind, 1);
        });
        this.ctx.waitUntil(sendAccountLive(this.ctx, input.ownerId, "work", { appId: input.appId }).catch(() => {}));
        return json({ id });
      }
      if (url.pathname === "/v1/posts" && request.method === "GET") {
        const following = url.searchParams.get("feed") === "following";
        const viewer = request.headers.has("Authorization")
          ? await authenticatedUser(request, this.env)
          : null;
        if (following && !viewer) return json({ posts: [], nextCursor: null });
        const cursor = url.searchParams.get("cursor") || undefined;
        const authorId = url.searchParams.get("authorId") || undefined;
        if (authorId && !uuid.test(authorId)) throw new InputError("作者标识无效");
        if (cursor && !/^post:\d{13}:[a-f0-9]{64}$/.test(cursor)) throw new InputError("分页标记无效");
        const locations = this.readIndex.posts({ author: authorId, viewer: following ? viewer!.id : undefined, after: cursor, limit: 51 });
        const records = locations.length ? await this.ctx.storage.get<Post>(locations) : new Map<string, Post>();
        const matching = locations.flatMap(key => { const post = records.get(key); return post ? [[key, post] as [string, Post]] : []; });
        const page = matching.slice(0, 50);
        // Hydrate the list as one BFF operation: batch stats/reactions instead of
        // issuing up to two storage reads for every post in a 50-item page.
        const keys = page.flatMap(([, post]) => [
          `stats:${post.id}`,
          ...(viewer ? [`like:${post.id}:${viewer.id}`] : []),
        ]);
        if (viewer) keys.push(`notice-unread:${viewer.id}`);
        const [profiles, metadata, views] = await Promise.all([
          publicProfiles([...new Set(page.map(([, post]) => post.author.id))], this.env),
          keys.length ? this.ctx.storage.get<Stats | boolean | number>(keys) : Promise.resolve(new Map<string, Stats | boolean | number>()),
          this.recordViews(page.map(([, post]) => post.id), request, viewer).catch(() => new Map<string, number>()),
        ]);
        return json({
          posts: page.map(([, post]) => {
            const stats = metadata.get(`stats:${post.id}`) as Stats | undefined;
            return {
              ...post,
              author: profiles.get(post.author.id) ?? post.author,
              viewCount: views.get(post.id) ?? stats?.views ?? 0,
              likeCount: stats?.likes ?? 0,
              commentCount: stats?.comments ?? 0,
              liked: viewer ? !!metadata.get(`like:${post.id}:${viewer.id}`) : false,
            };
          }),
          nextCursor:
            matching.length > 50 ? page.at(-1)![0] : null,
          unreadCount: viewer ? metadata.get(`notice-unread:${viewer.id}`) ?? 0 : 0,
        });
      }
      const profileId = url.pathname.match(
        /^\/v1\/profiles\/([a-f0-9-]{36})$/
      )?.[1];
      if (profileId && request.method === "GET") {
        if (!uuid.test(profileId)) throw new InputError("作者标识无效");
        const view = url.searchParams.get("view") || "summary";
        if (!["relationship", "summary", "posts", "apps"].includes(view)) throw new InputError("主页视图无效");
        const viewer = request.headers.has("Authorization") ? await authenticatedUser(request, this.env) : null;
        const follow = await this.followStatus(profileId, viewer?.id);
        if (view === "relationship") return json(follow);
        const marketParams = new URLSearchParams({ authorId: profileId, limit: view === "apps" ? "24" : "1", view: view === "apps" ? "full" : "count" });
        if (view === "apps" && url.searchParams.get("cursor")) marketParams.set("cursor", url.searchParams.get("cursor")!);
        const [profiles, market, timeline] = await Promise.all([
          publicProfiles([profileId], this.env),
          this.env.WORKSHOP.getByName("dynamic").fetch(new Request(`https://workshop.internal/v1/market?${marketParams}`)),
          view === "posts" ? this.handle(new Request(`https://posts.internal/v1/posts?authorId=${profileId}${url.searchParams.get("cursor") ? `&cursor=${encodeURIComponent(url.searchParams.get("cursor")!)}` : ""}`, { headers: request.headers })) : Promise.resolve(undefined),
        ]);
        const author = profiles.get(profileId);
        if (!author) throw new InputError("这位作者不存在", 404);
        if (!market.ok || timeline && !timeline.ok) throw new InputError("主页暂时不可用，请重试", 503);
        const applications = await market.json() as { applications: unknown[]; nextCursor?: string; totalCount: number };
        const posts = timeline ? await timeline.json() as { posts: unknown[]; nextCursor: string | null } : { posts: [], nextCursor: null };
        return json({ ...follow, author: { ...author, official: profileId === OFFICIAL_ACCOUNT_ID }, applicationCount: applications.totalCount, applications: applications.applications, applicationsNextCursor: applications.nextCursor ?? null, ...posts });
      }
      if (url.pathname === "/v1/application-bookmarks" && request.method === "GET") {
        if (!/^Bearer [a-f0-9]{64}$/.test(request.headers.get("Authorization") || "")) return json({ message: "请先登录" }, 401);
        const viewer = await authenticatedUser(request, this.env);
        if (!viewer) return json({ message: "请先登录" }, 401);
        const prefix = `bookmark:${viewer.id}:`;
        const cursor = url.searchParams.get("cursor") || undefined;
        if (cursor && !/^[a-f0-9]{64}$/.test(cursor)) throw new InputError("分页标识无效");
        const saved = await this.ctx.storage.list<boolean>({ prefix, limit: 31, ...(cursor ? { startAfter: prefix + cursor } : {}) });
        const keys = [...saved.keys()].slice(0, 30);
        const pointers = keys.length ? await this.ctx.storage.get<string>(keys.map(key => `id:${key.slice(prefix.length)}`)) : new Map<string, string>();
        const locations = [...new Set(pointers.values())];
        const posts = locations.length ? await this.ctx.storage.get<Post>(locations) : new Map<string, Post>();
        const applications = keys.flatMap(key => {
          const post = posts.get(pointers.get(`id:${key.slice(prefix.length)}`) ?? "");
          return post?.applicationDiscussion && post.application ? [{ ...post.application, discussionId: post.id }] : [];
        });
        if (applications.length) {
          const response = await this.env.WORKSHOP.getByName("dynamic").fetch(new Request(`https://workshop.internal/internal/application-icons?ids=${applications.map(item => item.appId).join(",")}`));
          if (!response.ok) throw new InputError("常用应用图标暂时不可用，请重试", 503);
          const result = await response.json() as { icons: Array<Pick<ApplicationLink, "appId" | "icon" | "iconUrl">> };
          const icons = new Map(result.icons.map(item => [item.appId, item]));
          for (const item of applications) Object.assign(item, icons.get(item.appId));
        }
        return json({ applications, nextCursor: saved.size > 30 ? keys.at(-1)!.slice(prefix.length) : null });
      }
      const applicationId = url.pathname.match(/^\/v1\/application-discussions\/([a-z][a-z0-9-]{0,63})$/)?.[1];
      if (applicationId && request.method === "GET") {
        const viewer = request.headers.has("Authorization") ? await authenticatedUser(request, this.env) : null;
        return await this.applicationDiscussion(applicationId, viewer, url.searchParams.get("comments") === "1");
      }
      const target = url.pathname.match(
        /^\/v1\/posts\/([a-f0-9]{64})(?:\/(like|bookmark|comments)(?:\/([a-f0-9]{64}))?)?$/
      );
      if (
        target &&
        request.method === "GET" &&
        target[2] !== "like" &&
        target[2] !== "bookmark" &&
        !target[3]
      ) {
        const commentId = url.searchParams.get("commentId");
        if (commentId && !/^[a-f0-9]{64}$/.test(commentId)) throw new InputError("评论标识无效");
        const [post, page, viewer] = await Promise.all([
          this.findPost(target[1]),
          (async () => {
            const start = commentId ? await this.ctx.storage.get<string>(`comment-id:${target[1]}:${commentId}`) : undefined;
            if (commentId && !start) throw new InputError("这条评论已删除", 404);
            return this.comments(target[1], url.searchParams.get("cursor") || undefined, start);
          })(),
          request.headers.has("Authorization") ? authenticatedUser(request, this.env) : Promise.resolve(null),
        ]);
        const [profiles, decorated] = await Promise.all([
          publicProfiles([...new Set([post.author.id, ...page.comments.map(item => item.author.id)])], this.env),
          (async () => {
            if (!target[2] && !url.searchParams.has("cursor")) await this.recordViews([post.id], request, viewer).catch(() => {});
            return this.decorate(post, viewer);
          })(),
        ]);
        return json({post: {...decorated, author: profiles.get(post.author.id) ?? post.author}, comments: page.comments.map(item => ({...item, author: profiles.get(item.author.id) ?? item.author})), nextCursor: page.nextCursor});
      }
      const relationship = url.pathname.match(/^\/v1\/profiles\/([a-f0-9-]{36})\/(followers|following)$/);
      if (relationship && request.method === "GET") {
        const viewer = request.headers.has("Authorization") ? await authenticatedUser(request, this.env) : null;
        return await new SocialInbox(this.ctx, this.env).relations(relationship[1], relationship[2] as "followers" | "following", url, viewer);
      }
      const user = await authenticatedUser(request, this.env);
      if (!user) return json({ message: "请先登录后再发动态" }, 401);
      if (url.pathname.startsWith("/v1/messages")) {
        if (url.pathname === "/v1/messages/live") await this.noticeSummary(user.id);
        return await new SocialInbox(this.ctx, this.env).handle(request, user);
      }
      if (url.pathname === "/v1/notifications" && request.method === "GET")
        return this.notices(url, user);
      if (
        url.pathname === "/v1/notifications/unread" &&
        request.method === "GET"
      )
        return json(await this.noticeSummary(user.id));
      return await this.queue.run(user.id, async () => {
        const followId = url.pathname.match(
          /^\/v1\/profiles\/([a-f0-9-]{36})\/follow$/
        )?.[1];
        if (
          followId &&
          (request.method === "POST" || request.method === "DELETE")
        ) {
          if (!uuid.test(followId) || followId === user.id)
            throw new InputError("不能关注自己");
          if (!(await publicProfiles([followId], this.env)).has(followId))
            throw new InputError("这位作者不存在", 404);
          const desired = request.method === "POST";
          await this.ctx.storage.transaction(async (storage) => {
            const key = `follow:${user.id}:${followId}`;
            const previous = !!(await storage.get(key));
            this.readIndex.follow(user.id, followId, desired);
            const reverse = `follower:${followId}:${user.id}`;
            if (desired) await storage.put(reverse, true);
            else await storage.delete(reverse);
            if (previous === desired) return;
            if (desired) await storage.put(key, true);
            else await storage.delete(key);
            for (const countKey of [
              `following-count:${user.id}`,
              `follower-count:${followId}`,
            ]) {
              const count = (await storage.get<number>(countKey)) ?? 0;
              await storage.put(
                countKey,
                Math.max(0, count + (desired ? 1 : -1))
              );
            }
          });
          return json(await this.followStatus(followId, user.id));
        }
        if (
          url.pathname === "/v1/notifications/read" &&
          request.method === "POST"
        )
          return this.readNotices(request, user);
        if (url.pathname === "/v1/post-media" && request.method === "PUT")
          return this.upload(request, user);
        if (url.pathname === "/v1/posts" && request.method === "POST")
          return this.publish(request, user);
        const match = url.pathname.match(/^\/v1\/posts\/([a-f0-9]{64})$/);
        if (target && target[2] === "bookmark" && !target[3] && ["POST", "DELETE"].includes(request.method)) {
          return this.queue.run(`post:${target[1]}`, async () => {
            await this.findPost(target[1]);
            const key = `bookmark:${user.id}:${target[1]}`;
            if (request.method === "POST") await this.ctx.storage.put(key, true);
            else await this.ctx.storage.delete(key);
            return json({ saved: request.method === "POST" });
          });
        }
        if (match && request.method === "DELETE")
          return this.queue.run(`post:${match[1]}`, () =>
            this.remove(match[1], user)
          );
        if (
          target &&
          target[2] === "like" &&
          ["POST", "DELETE"].includes(request.method)
        )
          return this.queue.run(`post:${target[1]}`, () =>
            this.like(target[1], user, request.method === "POST")
          );
        if (
          target &&
          target[2] === "comments" &&
          !target[3] &&
          request.method === "POST"
        )
          return this.queue.run(`post:${target[1]}`, () =>
            this.comment(target[1], request, user)
          );
        if (
          target &&
          target[2] === "comments" &&
          target[3] &&
          request.method === "DELETE"
        )
          return this.queue.run(`post:${target[1]}`, () =>
            this.removeComment(target[1], target[3]!, user)
          );
        return json({ message: "操作不存在" }, 404);
      });
    } catch (error) {
      return json(
        {
          message:
            (error instanceof InputError || error instanceof SocialError)
              ? error.message
              : "动态操作未完成，请稍后重试",
        },
        (error instanceof InputError || error instanceof SocialError) ? error.status : 503
      );
    }
  }
  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    // Messages are sent through authenticated, idempotent HTTP only.
    if (message === "ping") socket.send("pong");
  }
  webSocketClose(socket: WebSocket, code: number, reason: string) { socket.close(code, reason); }
  webSocketError(socket: WebSocket) { socket.close(1011, "Connection closed"); }
  private async noticeSummary(userId: string) {
    return this.ctx.storage.transaction(async (storage) => {
      const key = `notice-unread-categories:${userId}`;
      let counts = await storage.get<{ creation: number; interaction: number }>(key);
      if (!counts) {
        counts = { creation: 0, interaction: 0 };
        let cursor: string | undefined;
        while (true) {
          const records = await storage.list<Notice>({
            prefix: `notice:${userId}:`, startAfter: cursor, limit: 256,
          });
          for (const notice of records.values()) {
            if (!notice.read) counts[notice.kind.startsWith("work-") ? "creation" : "interaction"]++;
          }
          if (records.size < 256) break;
          cursor = [...records.keys()].at(-1);
        }
        await storage.put(key, counts);
        await storage.put(`notice-unread:${userId}`, counts.creation + counts.interaction);
      }
      return { unreadCount: counts.creation + counts.interaction, unreadByCategory: counts };
    });
  }
  private async changeUnread(storage: DurableObjectTransaction, userId: string, kind: Notice["kind"], delta: number) {
    this.noticeChanges.add(userId);
    const totalKey = `notice-unread:${userId}`;
    await storage.put(totalKey, Math.max(0, ((await storage.get<number>(totalKey)) ?? 0) + delta));
    const key = `notice-unread-categories:${userId}`;
    const counts = await storage.get<{ creation: number; interaction: number }>(key);
    if (counts) {
      const category = kind.startsWith("work-") ? "creation" : "interaction";
      counts[category] = Math.max(0, counts[category] + delta);
      await storage.put(key, counts);
    }
  }
  private async notices(url: URL, user: User) {
    const prefix = `notice:${user.id}:`;
    const category = url.searchParams.get("category") || "";
    if (category && !["creation", "interaction"].includes(category)) throw new InputError("通知分类无效");
    const supplied = url.searchParams.get("cursor") || undefined;
    if (supplied && category && !supplied.startsWith(`${category}|`)) throw new InputError("通知分页分类不一致");
    const cursor = supplied && category ? supplied.slice(category.length + 1) : supplied;
    if (cursor && (!cursor.startsWith(prefix) || !/^notice:[a-f0-9-]{36}:\d{13}:[a-f0-9]{64}$/.test(cursor))) throw new InputError("通知分页标记无效");
    const records = category
      ? await (async () => { const keys = this.readIndex.notices(user.id, category, cursor, 51); const values = keys.length ? await this.ctx.storage.get<Notice>(keys) : new Map<string, Notice>(); return new Map(keys.flatMap(key => { const value = values.get(key); return value ? [[key, value] as [string, Notice]] : []; })); })()
      : await this.ctx.storage.list<Notice>({ prefix, startAfter: cursor, limit: 51 });
    const entries = [...records.entries()];
    const more = entries.length > 50;
    const page = entries.slice(0, 50);
    const next = page.at(-1)?.[0];
    const profiles = await publicProfiles(
      [...new Set(page.map(([, item]) => item.actor.id))],
      this.env
    );
    return json({
      notices: page.map(([, item]) => ({
        ...item,
        actor: profiles.get(item.actor.id) ?? item.actor,
      })),
      nextCursor: more && next ? (category ? `${category}|${next}` : next) : null,
      ...await this.noticeSummary(user.id),
    });
  }
  private async readNotices(request: Request, user: User) {
    let input: { ids?: unknown };
    try {
      input = JSON.parse(
        new TextDecoder().decode(await bodyBytes(request, 8192))
      );
    } catch {
      throw new InputError("通知请求无效");
    }
    if (
      !input ||
      typeof input !== "object" ||
      (input.ids !== undefined &&
        (!Array.isArray(input.ids) ||
          input.ids.length > 100 ||
          input.ids.some(
            (id) => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)
          )))
    )
      throw new InputError("通知标识无效");
    const before = Date.now();
    const ids = input.ids as string[] | undefined;
    const mark = async (keys: string[]) => {
      const changed = await this.ctx.storage.transaction(async (storage) => {
        const records = keys.length ? await storage.get<Notice>([...new Set(keys)]) : new Map<string, Notice>();
        const updates: Record<string, Notice> = {};
        const removed = { creation: 0, interaction: 0 };
        for (const [key, notice] of records) {
          if (!key.startsWith(`notice:${user.id}:`) || notice.read || notice.createdAt > before) continue;
          updates[key] = { ...notice, read: true };
          removed[notice.kind.startsWith("work-") ? "creation" : "interaction"]++;
        }
        const count = removed.creation + removed.interaction;
        if (!count) return false;
        const totalKey = `notice-unread:${user.id}`, categoryKey = `notice-unread-categories:${user.id}`;
        const counters = await storage.get<number | { creation: number; interaction: number }>([totalKey, categoryKey]);
        await storage.put(updates);
        const values: Record<string, unknown> = { [totalKey]: Math.max(0, ((counters.get(totalKey) as number | undefined) ?? 0) - count) };
        const categories = counters.get(categoryKey) as { creation: number; interaction: number } | undefined;
        if (categories) values[categoryKey] = { creation: Math.max(0, categories.creation - removed.creation), interaction: Math.max(0, categories.interaction - removed.interaction) };
        await storage.put(values);
        return true;
      });
      if (changed) this.noticeChanges.add(user.id);
    };
    if (ids) {
      const indexes = [...new Set(ids)].map(id => `notice-id:${user.id}:${id}`);
      const keys = indexes.length ? await this.ctx.storage.get<string>(indexes) : new Map<string, string>();
      await mark([...keys.values()]);
    } else {
      let cursor: string | undefined;
      while (true) {
        const records = await this.ctx.storage.list<Notice>({
          prefix: `notice:${user.id}:`,
          startAfter: cursor,
          limit: 128,
        });
        if (!records.size) break;
        await mark([...records.keys()]);
        cursor = [...records.keys()].at(-1);
      }
    }
    return json({
      ...await this.noticeSummary(user.id),
      before,
    });
  }
  private async clearCommentNotices(postId: string, commentId: string) {
    const targetsKey = `notice-targets:${postId}:${commentId}`;
    await this.ctx.storage.transaction(async (storage) => {
      const recipients = (await storage.get<string[]>(targetsKey)) ?? [];
      for (const recipient of recipients) {
        const index = `notice-id:${recipient}:${commentId}`;
        const key = await storage.get<string>(index);
        const notice = key ? await storage.get<Notice>(key) : undefined;
        if (notice && !notice.read)
          await this.changeUnread(storage, recipient, notice.kind, -1);
        if (key) { await storage.delete(key); this.readIndex.removeNotice(key); }
        await storage.delete(index);
      }
      await storage.delete(targetsKey);
    });
  }
  private async clearPostNotices(id: string) {
    while (true) {
      const records = await this.ctx.storage.list({
        prefix: `notice-targets:${id}:`,
        limit: 128,
      });
      if (!records.size) return;
      for (const key of records.keys())
        await this.clearCommentNotices(id, key.split(":").at(-1)!);
    }
  }
  private async findPost(id: string): Promise<Post> {
    const key = await this.ctx.storage.get<string>(`id:${id}`);
    const post = key ? await this.ctx.storage.get<Post>(key) : undefined;
    if (!post) throw new InputError("这条动态已删除或不存在", 404);
    return post;
  }
  /** Count API delivery once per account, or approximately per anonymous request source. */
  private async recordViews(ids: string[], request: Request, viewer: User | null) {
    const ip = request.headers.get("CF-Connecting-IP");
    if (!ids.length || (!viewer && !ip)) return new Map<string, number>();
    // Persist only a digest, never IP addresses or user-agent strings.
    const identity = await digest(viewer ? `account:${viewer.id}` : `guest:${ip}:${request.headers.get("User-Agent") ?? ""}`);
    const counts = new Map<string, number>();
    for (let offset = 0; offset < ids.length; offset += 32) {
      const batch = [...new Set(ids.slice(offset, offset + 32))];
      const result = await this.ctx.storage.transaction(async storage => {
        const keys = batch.flatMap(id => [`id:${id}`, `view:${id}:${identity}`, `stats:${id}`]);
        const metadata = await storage.get<string | boolean | Stats>(keys);
        const result = new Map<string, number>();
        const writes: Record<string, boolean | Stats> = {};
        for (const id of batch) {
          if (!metadata.has(`id:${id}`)) continue;
          const stats = (metadata.get(`stats:${id}`) as Stats | undefined) ?? { likes: 0, comments: 0 };
          if (!metadata.has(`view:${id}:${identity}`)) {
            stats.views = (stats.views ?? 0) + 1;
            writes[`view:${id}:${identity}`] = true;
            writes[`stats:${id}`] = stats;
          }
          result.set(id, stats.views ?? 0);
        }
        if (Object.keys(writes).length) await storage.put(writes);
        return result;
      });
      for (const [id, count] of result) counts.set(id, count);
    }
    return counts;
  }
  /** One discussion per application, across releases; kept out of the community timeline. */
  private async discussions(applications: ApplicationItem[], viewer: User | null) {
    const identities = await Promise.all(applications.map(async item => ({ item, id: await digest(`application-discussion:${item.manifest.appId}`) })));
    const posts = await this.ctx.storage.transaction(async storage => {
      const keys = identities.map(({ item }) => `application-discussion:${item.manifest.appId}`);
      const prior = keys.length ? await storage.get<Post>(keys) : new Map<string, Post>();
      const writes: Record<string, Post | string> = {};
      const posts = identities.map(({ item, id }) => {
        if (!item.authorId) throw new InputError("作品作者暂时不可用", 503);
        const key = `application-discussion:${item.manifest.appId}`;
        const post: Post = { id, applicationDiscussion: true,
          author: { id: item.authorId, name: item.authorName, avatarUrl: item.authorAvatarUrl ?? null },
          body: item.summary || item.manifest.description, images: [], createdAt: prior.get(key)?.createdAt ?? Date.now(),
          application: { appId: item.manifest.appId, releaseId: item.manifest.releaseId, title: item.title || item.manifest.appName, summary: item.summary || item.manifest.description, accent: item.manifest.accent, icon: item.manifest.icon, iconUrl: item.iconUrl } };
        if (JSON.stringify(prior.get(key)) !== JSON.stringify(post)) { writes[key] = post; writes[`id:${id}`] = key; }
        return post;
      });
      if (Object.keys(writes).length) await storage.put(writes);
      return posts;
    });
    const keys = [...new Set(posts.flatMap(post => [`stats:${post.id}`, ...(viewer ? [`like:${post.id}:${viewer.id}`, `bookmark:${viewer.id}:${post.id}`, `follow:${viewer.id}:${post.author.id}`] : [])]))];
    const metadata = keys.length ? await getMany<Stats | boolean>(this.ctx.storage, keys) : new Map<string, Stats | boolean>();
    return posts.map(post => { const stats = metadata.get(`stats:${post.id}`) as Stats | undefined; return { appId: post.application!.appId, following: viewer ? !!metadata.get(`follow:${viewer.id}:${post.author.id}`) : false,
      post: { ...post, viewCount: stats?.views ?? 0, likeCount: stats?.likes ?? 0, commentCount: stats?.comments ?? 0, liked: viewer ? !!metadata.get(`like:${post.id}:${viewer.id}`) : false, saved: viewer ? !!metadata.get(`bookmark:${viewer.id}:${post.id}`) : false } }; });
  }
  private async applicationDiscussion(appId: string, viewer: User | null, withComments = false) {
    const response = await this.env.WORKSHOP.getByName("dynamic").fetch(new Request(`https://workshop.internal/v1/market?appId=${appId}&detail=1`));
    if (!response.ok) throw new InputError("这个作品已撤回或暂未公开", response.status === 404 ? 404 : 503);
    const { item } = await response.json() as { item: ApplicationItem };
    if (!item?.authorId || item.manifest.appId !== appId) throw new InputError("作品信息暂时不可用", 503);
    const [{ post, following }] = await this.discussions([item], viewer);
    if (!withComments) return json({ post, following });
    const page = await this.comments(post.id);
    const profiles = await publicProfiles([...new Set(page.comments.map(comment => comment.author.id))], this.env);
    return json({ post, following, ...page, comments: page.comments.map(comment => ({ ...comment, author: profiles.get(comment.author.id) ?? comment.author })) });
  }
  private async decorate(post: Post, viewer: User | null) {
    const keys = [`stats:${post.id}`, ...(viewer ? [`like:${post.id}:${viewer.id}`, `bookmark:${viewer.id}:${post.id}`] : [])];
    const metadata = await this.ctx.storage.get<Stats | boolean>(keys);
    const stats = metadata.get(keys[0]) as Stats | undefined;
    return { ...post, viewCount: stats?.views ?? 0, likeCount: stats?.likes ?? 0, commentCount: stats?.comments ?? 0,
      liked: viewer ? !!metadata.get(keys[1]) : false, saved: viewer ? !!metadata.get(keys[2]) : false };
  }
  private async like(id: string, user: User, wanted: boolean) {
    const post = await this.findPost(id);
    const key = `like:${id}:${user.id}`;
    const noticeId = await digest(key);
    await this.ctx.storage.transaction(async (storage) => {
      const prior = !!(await storage.get(key));
      if (prior === wanted) return;
      const stats = (await storage.get<Stats>(`stats:${id}`)) ?? {
        likes: 0,
        comments: 0,
      };
      if (wanted) await storage.put(key, true);
      else await storage.delete(key);
      stats.likes = Math.max(0, stats.likes + (wanted ? 1 : -1));
      await storage.put(`stats:${id}`, stats);
      if (post.author.id === user.id) return;
      const recipient = post.author.id;
      const index = `notice-id:${recipient}:${noticeId}`;
      const targets = `notice-targets:${id}:${noticeId}`;
      const previousKey = await storage.get<string>(index);
      if (wanted && !previousKey) {
        const notice: Notice = {
          id: noticeId,
          actor: { id: user.id, name: user.name, avatarUrl: user.avatarUrl },
          postId: id,
          commentId: "",
          kind: "like",
          body: post.applicationDiscussion ? "赞了你的作品" : "赞了你的动态",
          postPreview: (post.body || post.application?.title || (post.content ? "HTML 动态" : "图片动态")).slice(0, 100),
          createdAt: Date.now(),
          read: false,
        };
        const noticeKey = `notice:${recipient}:${String(9999999999999 - notice.createdAt).padStart(13, "0")}:${noticeId}`;
        await storage.put(noticeKey, notice);
        this.readIndex.notice(noticeKey, recipient, notice.kind);
        await storage.put(index, noticeKey);
        await storage.put(targets, [recipient]);
        await this.changeUnread(storage, recipient, notice.kind, 1);
      } else if (!wanted && previousKey) {
        const notice = await storage.get<Notice>(previousKey);
        if (notice && !notice.read) await this.changeUnread(storage, recipient, notice.kind, -1);
        await storage.delete([previousKey, index, targets]);
        this.readIndex.removeNotice(previousKey);
      }

    });
    return json({ post: await this.decorate(post, user) });
  }
  private async followStatus(authorId: string, viewerId?: string) {
    const [following, followerCount, followingCount] = await Promise.all([
      viewerId
        ? this.ctx.storage.get<boolean>(`follow:${viewerId}:${authorId}`)
        : Promise.resolve(false),
      this.ctx.storage.get<number>(`follower-count:${authorId}`),
      this.ctx.storage.get<number>(`following-count:${authorId}`),
    ]);
    return {
      following: !!following,
      followerCount: followerCount ?? 0,
      followingCount: followingCount ?? 0,
    };
  }
  private async comments(id: string, cursor?: string, start?: string) {
    const prefix = `comment:${id}:`;
    if (
      cursor &&
      (!cursor.startsWith(prefix) ||
        !/^comment:[a-f0-9]{64}:\d{13}:[a-f0-9]{64}$/.test(cursor))
    )
      throw new InputError("评论分页标记无效");
    const records = await this.ctx.storage.list<Comment>({
      prefix,
      ...(cursor ? { startAfter: cursor } : start ? { start } : {}),
      limit: 51,
    });
    const entries = [...records].slice(0, 50);
    return {
      comments: entries.map(([, value]) => value),
      nextCursor: records.size > 50 ? entries.at(-1)![0] : null,
    };
  }
  private async comment(id: string, request: Request, user: User) {
    const post = await this.findPost(id);
    let input: { body?: unknown; requestId?: unknown; replyTo?: unknown };
    try {
      input = JSON.parse(
        new TextDecoder().decode(await bodyBytes(request, 8192))
      );
    } catch {
      throw new InputError("评论格式无效");
    }
    if (
      !input ||
      typeof input.body !== "string" ||
      typeof input.requestId !== "string" ||
      !/^[a-zA-Z0-9-]{8,100}$/.test(input.requestId)
    )
      throw new InputError("评论格式无效");
    const body = input.body.trim();
    if (!body || Array.from(body).length > 1000)
      throw new InputError("评论需为 1 到 1000 个字");
    if (
      input.replyTo != null &&
      (typeof input.replyTo !== "string" ||
        !/^[a-f0-9]{64}$/.test(input.replyTo))
    )
      throw new InputError("回复目标无效");
    const fingerprint = await digest(
      JSON.stringify([body, input.replyTo ?? null])
    );
    const requestKey = `comment-request:${id}:${user.id}:${input.requestId}`;
    const prior = await this.ctx.storage.get<{
      key: string;
      fingerprint: string;
    }>(requestKey);
    if (prior) {
      const comment = await this.ctx.storage.get<Comment>(prior.key);
      if (!comment || prior.fingerprint !== fingerprint)
        throw new InputError("这次评论已处理，请重新评论", 409);
      return json({ comment, post: await this.decorate(post, user) });
    }
    await this.rate(user.id, "comment", 20);
    let replyTo: Comment["replyTo"];
    let replyOwner: string | undefined;
    if (input.replyTo) {
      const key = await this.ctx.storage.get<string>(
        `comment-id:${id}:${input.replyTo}`
      );
      const target = key ? await this.ctx.storage.get<Comment>(key) : undefined;
      if (!target) throw new InputError("回复的评论已删除");
      replyTo = { id: target.id, name: target.author.name };
      replyOwner = target.author.id;
    }
    const comment: Comment = {
      id: await digest(`${id}:${user.id}:${input.requestId}`),
      postId: id,
      author: { id: user.id, name: user.name, avatarUrl: user.avatarUrl },
      body,
      createdAt: Date.now(),
      ...(replyTo ? { replyTo } : {}),
    };
    const key = `comment:${id}:${String(comment.createdAt).padStart(13, "0")}:${
      comment.id
    }`;
    const recipients = [
      ...new Set(
        [post.author.id, replyOwner].filter(
          (value): value is string => !!value && value !== user.id
        )
      ),
    ];
    await this.ctx.storage.transaction(async (storage) => {
      const stats = (await storage.get<Stats>(`stats:${id}`)) ?? {
        likes: 0,
        comments: 0,
      };
      stats.comments++;
      await storage.put(key, comment);
      await storage.put(`comment-id:${id}:${comment.id}`, key);
      await storage.put(requestKey, { key, fingerprint });
      await storage.put(`stats:${id}`, stats);
      for (const recipient of recipients) {
        const notice: Notice = {
          id: comment.id,
          actor: comment.author,
          postId: id,
          commentId: comment.id,
          body: body.slice(0, 240),
          postPreview: (
            post.body ||
            post.application?.title ||
            (post.content ? "HTML 动态" : "图片动态")
          ).slice(0, 100),
          kind: recipient === replyOwner ? "reply" : "comment",
          createdAt: comment.createdAt,
          read: false,
        };
        const noticeKey = `notice:${recipient}:${String(
          9999999999999 - notice.createdAt
        ).padStart(13, "0")}:${notice.id}`;
        await storage.put(noticeKey, notice);
        this.readIndex.notice(noticeKey, recipient, notice.kind);
        await storage.put(`notice-id:${recipient}:${notice.id}`, noticeKey);
        await this.changeUnread(storage, recipient, notice.kind, 1);
      }
      if (recipients.length)
        await storage.put(`notice-targets:${id}:${comment.id}`, recipients);
    });
    return json({ comment, post: await this.decorate(post, user) }, 201);
  }
  private async removeComment(id: string, commentId: string, user: User) {
    const post = await this.findPost(id);
    const key = await this.ctx.storage.get<string>(
      `comment-id:${id}:${commentId}`
    );
    const comment = key ? await this.ctx.storage.get<Comment>(key) : undefined;
    if (!comment) {
      await this.clearCommentNotices(id, commentId);
      return json({ deleted: true, post: await this.decorate(post, user) });
    }
    if (comment.author.id !== user.id)
      throw new InputError("只能删除自己的评论", 403);
    await this.ctx.storage.transaction(async (storage) => {
      const stats = (await storage.get<Stats>(`stats:${id}`)) ?? {
        likes: 0,
        comments: 0,
      };
      stats.comments = Math.max(0, stats.comments - 1);
      await storage.delete(key!);
      await storage.delete(`comment-id:${id}:${commentId}`);
      await storage.put(`stats:${id}`, stats);
    });
    await this.clearCommentNotices(id, commentId);
    return json({ deleted: true, post: await this.decorate(post, user) });
  }
  private async deletePrefix(prefix: string) {
    while (true) {
      const records = await this.ctx.storage.list({ prefix, limit: 128 });
      if (!records.size) return;
      await this.ctx.storage.delete([...records.keys()]);
    }
  }
  private async rate(userId: string, kind: string, maximum: number) {
    const key = `rate:${userId}:${kind}`;
    const now = Date.now();
    const prior = await this.ctx.storage.get<{ count: number; at: number }>(
      key
    );
    const value =
      prior && now - prior.at < 60000 ? prior : { count: 0, at: now };
    if (value.count >= maximum)
      throw new InputError("操作较频繁，请稍后重试", 429);
    value.count++;
    await this.ctx.storage.put(key, value);
  }
  private async upload(request: Request, user: User) {
    await this.rate(user.id, "upload", 20);
    const bytes = await bodyBytes(request, 3 * 1024 * 1024);
    const header = [...bytes.slice(0, 12)];
    const type =
      header[0] === 255 && header[1] === 216 && header[2] === 255
        ? "image/jpeg"
        : header.slice(0, 8).join(",") === "137,80,78,71,13,10,26,10"
        ? "image/png"
        : String.fromCharCode(...header.slice(0, 4)) === "RIFF" &&
          String.fromCharCode(...header.slice(8, 12)) === "WEBP"
        ? "image/webp"
        : undefined;
    if (!type) throw new InputError("请选择 JPEG、PNG 或 WebP 图片");
    const id = crypto.randomUUID();
    const key = `v1/post-images/${user.id}/${id}`;
    await this.env.BLOBS.put(key, bytes, {
      httpMetadata: { contentType: type, cacheControl: "public,max-age=3600" },
    });
    const media: Media = {
      id,
      key,
      ownerId: user.id,
      url: `https://zijinhua.297782.xyz/${key}`,
      createdAt: Date.now(),
    };
    await this.ctx.storage.put(`media:${id}`, media);
    if (!(await this.ctx.storage.getAlarm()))
      await this.ctx.storage.setAlarm(Date.now() + 3600000);
    return json({ image: { id, url: media.url } }, 201);
  }
  private async publish(request: Request, user: User) {
    let input: {
      body?: unknown;
      imageIds?: unknown;
      requestId?: unknown;
      content?: unknown;
      application?: unknown;
    };
    try {
      input = JSON.parse(
        new TextDecoder().decode(await bodyBytes(request, 65536))
      );
    } catch (error) {
      if (error instanceof InputError) throw error;
      throw new InputError("请求格式不正确");
    }
    if (
      !input ||
      typeof input !== "object" ||
      typeof input.body !== "string" ||
      typeof input.requestId !== "string" ||
      !/^[a-zA-Z0-9-]{8,100}$/.test(input.requestId)
    )
      throw new InputError("动态内容无效");
    const body = input.body.trim();
    const ids = input.imageIds;
    let content: PostContent | undefined;
    try {
      content = normalizePostContent(input.content);
    } catch (error) {
      throw new InputError(
        error instanceof Error ? error.message : "HTML 内容无效"
      );
    }
    let selection;
    try { selection = applicationSelection(input.application); } catch (error) { if (error instanceof ApplicationShareError) throw new InputError(error.message, error.status); throw error; }
    if (
      Array.from(body).length > 2000 ||
      !Array.isArray(ids) ||
      ids.length > 4 ||
      ids.some((id) => typeof id !== "string" || !uuid.test(id)) ||
      new Set(ids).size !== ids.length ||
      (!body && !ids.length && !selection && !content)
    )
      throw new InputError(
        "动态需有文字、HTML、图片或应用，正文最多 2000 字、4 张图"
      );
    const fingerprint = await digest(
      JSON.stringify({
        body,
        ids,
        ...(content ? { content } : {}),
        ...(selection
          ? {
              application: {
                appId: selection.appId,
                releaseId: selection.releaseId,
                ...(selection.params ? { params: selection.params } : {}),
              },
            }
          : {}),
      })
    );
    const requestKey = `request:${user.id}:${input.requestId}`;
    const prior = await this.ctx.storage.get<{
      key: string;
      fingerprint: string;
    }>(requestKey);
    if (prior) {
      const post = await this.ctx.storage.get<Post>(prior.key);
      if (prior.fingerprint !== fingerprint || !post)
        throw new InputError("这次发布已处理，请新建动态", 409);
      return json({ post: await this.decorate(post, user) });
    }
    await this.rate(user.id, "publish", 5);
    let application: ApplicationLink | undefined;
    if (selection) {
      try { application = await resolveApplicationShare(this.env, selection); } catch (error) { if (error instanceof ApplicationShareError) throw new InputError(error.message, error.status); throw error; }
    }
    const media = await Promise.all(
      ids.map((id) => this.ctx.storage.get<Media>(`media:${id}`))
    );
    if (
      media.some(
        (item) =>
          !item ||
          item.ownerId !== user.id ||
          item.postId ||
          Date.now() - item.createdAt > 86400000
      )
    )
      throw new InputError("图片已失效，请重新选择");
    const post: Post = {
      id: await digest(`${user.id}:${input.requestId}`),
      author: { id: user.id, name: user.name, avatarUrl: user.avatarUrl },
      body,
      images: media.map((item) => ({ id: item!.id, url: item!.url })),
      createdAt: Date.now(),
      ...(application ? { application } : {}),
      ...(content ? { content } : {}),
    };
    await this.ctx.storage.transaction(async (storage) => {
      await storage.put(postKey(post), post);
      this.readIndex.post(postKey(post), user.id);
      await storage.put(`id:${post.id}`, postKey(post));
      await storage.put(requestKey, { key: postKey(post), fingerprint });
      for (const item of media)
        await storage.put(`media:${item!.id}`, { ...item!, postId: post.id });
    });
    return json({ post: await this.decorate(post, user) }, 201);
  }
  private async remove(id: string, user: User) {
    const key = await this.ctx.storage.get<string>(`id:${id}`);
    const post = key ? await this.ctx.storage.get<Post>(key) : undefined;
    if (post?.applicationDiscussion) throw new InputError("作品讨论随作品保留，不能作为动态删除", 403);
    if (!post) {
      await this.clearPostNotices(id);
      return json({ deleted: true });
    }
    if (post.author.id !== user.id)
      throw new InputError("只能删除自己的动态", 403);
    await this.ctx.storage.transaction(async (storage) => {
      await storage.delete(key!);
      this.readIndex.removePost(key!);
      await storage.delete(`id:${id}`);
      for (const image of post.images) {
        const media = await storage.get<Media>(`media:${image.id}`);
        if (media)
          await storage.put(`media:${image.id}`, {
            ...media,
            postId: undefined,
            createdAt: 0,
          });
      }
    });
    await this.clearPostNotices(id);
    for (const prefix of [
      `view:${id}:`,
      `like:${id}:`,
      `comment:${id}:`,
      `comment-id:${id}:`,
      `comment-request:${id}:`,
    ])
      await this.deletePrefix(prefix);
    await this.ctx.storage.delete(`stats:${id}`);
    for (const image of post.images) {
      const media = await this.ctx.storage.get<Media>(`media:${image.id}`);
      if (media) {
        await this.env.BLOBS.delete(media.key);
        await this.ctx.storage.delete(`media:${image.id}`);
      }
    }
    return json({ deleted: true });
  }
  async alarm() {
    if (this.resetting) return;
    const operation = this.cleanup();
    this.pending.add(operation);
    try {
      await operation;
    } finally {
      this.pending.delete(operation);
    }
  }
  private async cleanup() {
    const records = await this.ctx.storage.list<Media>({ prefix: "media:" });
    for (const [key, media] of records)
      if (!media.postId && Date.now() - media.createdAt > 86400000) {
        await this.queue.run(media.ownerId, async () => {
          const current = await this.ctx.storage.get<Media>(key);
          if (
            !current ||
            current.postId ||
            Date.now() - current.createdAt <= 86400000
          )
            return;
          await this.env.BLOBS.delete(current.key);
          await this.ctx.storage.delete(key);
        });
      }
    await this.ctx.storage.setAlarm(Date.now() + 86400000);
  }
}

export async function readPostImage(request: Request, env: Env) {
  const object = await env.BLOBS.get(new URL(request.url).pathname.slice(1));
  if (!object) return json({ message: "图片不存在" }, 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("ETag", object.httpEtag);
  return new Response(request.method === "HEAD" ? null : object.body, {
    headers,
  });
}

export async function readSharedPost(request: Request, env: Env) {
  const id = new URL(request.url).pathname.split("/").at(-1)!;
  const response = await env.POSTS.getByName("timeline").fetch(
    new Request(`https://posts.internal/v1/posts/${id}`)
  );
  const escape = (value: string) =>
    value.replace(
      /[&<>"']/g,
      (character) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }[character]!)
    );
  const data = (await response.json()) as { post?: Post };
  const post = data.post;
  const rich = post?.content
    ? normalizePostContent(post.content)?.html ?? ""
    : "";
  const content = post
    ? `<h2>${escape(post.author.name)}</h2><p class="date">${escape(
        new Date(post.createdAt).toISOString().replace("T", " ").slice(0, 16)
      )} UTC</p><p class="body">${escape(
        post.body
      )}</p><section class="post-html">${rich}</section><div class="images">${post.images
        .map(
          (image) =>
            `<img src="${escape(image.url)}" alt="动态图片" loading="lazy">`
        )
        .join("")}</div>`
    : "<p>这条动态已删除或暂时无法查看。</p>";
  const app = post?.application
    ? `<section><h2>应用 · ${escape(post.application.title)}</h2><p>${escape(
        post.application.summary
      )}</p><p class="date"><a href="/applications/${escape(post.application.appId)}${escape(applicationShareQuery(post.application.params))}">打开应用</a></p></section>`
    : "";
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(
    post ? post.author.name + "的动态" : "动态不存在"
  )} · 生花</title><style>${sharedLinkStyles}body{margin:0;background:#faf8f5;color:#25221f;font:16px/1.7 system-ui,sans-serif}main{max-width:620px;margin:0 auto;padding:28px 20px}h1{font-size:18px;color:#9c7437}h2{margin-bottom:0;font-size:18px}.date{font-size:12px;color:#888}.body{white-space:pre-wrap;overflow-wrap:anywhere}.post-html{overflow:hidden;overflow-wrap:anywhere}.post-html img{max-width:100%;height:auto}.images{display:grid;gap:10px}img{width:100%;border-radius:14px}section{margin-top:20px;padding:16px;background:white;border-radius:14px}</style></head><body><main><h1>生花</h1>${content}${app}${sharedLinkActions("posts", id)}</main></body></html>`;
  return new Response(request.method === "HEAD" ? null : html, {
    status: response.status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; img-src https:; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
    },
  });
}
