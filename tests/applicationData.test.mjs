import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

// Run the production routing and SQL against real SQLite without production data.
const compiled = await build({
  stdin: { contents: 'export * from "./src/applicationData.ts"; export * from "./src/applicationFiles.ts"; export * from "./src/applicationRooms.ts";', resolveDir: new URL("..", import.meta.url).pathname.replace(/^\/(.:\/)/, "$1") },
  bundle: true, platform: "node", format: "esm", write: false,
  plugins: [{ name: "durable-object-context", setup(builder) {
    builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "cloudflare:workers", namespace: "test" }));
    builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: "export class DurableObject { constructor(ctx,env){ this.ctx=ctx; this.env=env; } }" }));
  } }],
});
const { ApplicationDatabase, applicationData, applicationFiles, applicationRooms, RoomConnections } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
const users = { alice: "11111111-1111-4111-8111-111111111111", bob: "22222222-2222-4222-8222-222222222222" };
function fixture() {
  const stores = new Map();
  const env = {
    BLOBS: { objects: new Map(), async put(key, body) { this.objects.set(key, new Uint8Array(body)); }, async get(key) { const data = this.objects.get(key); return data ? { body: data, arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) } : null; }, async delete(key) { this.objects.delete(key); } },
    ACCOUNTS: { getByName: () => ({ fetch: async request => {
      const user = users[request.headers.get("Authorization")?.replace("Bearer ", "")];
      return Response.json(user ? { user: { id: user } } : {}, { status: user ? 200 : 401 });
    } }) },
    WORKSHOP: { getByName: () => ({ canUseCloud: async appId => ["app-a", "app-b"].includes(appId) }) },
    APP_DATA: { getByName(name) {
      if (!stores.has(name)) {
        const db = new DatabaseSync(":memory:"); let alarm = null;
        const sql = { exec(query, ...values) {
          let rows = [];
          if (query.includes(";")) db.exec(query);
          else { const statement = db.prepare(query); if (statement.columns().length) rows = statement.all(...values); else statement.run(...values); }
          return { toArray: () => rows, one: () => { assert.equal(rows.length, 1); return rows[0]; } };
        } };
        const ctx = { getWebSockets: () => [], storage: { sql, transactionSync(work) {
          db.exec("SAVEPOINT operation");
          try { const result = work(); db.exec("RELEASE operation"); return result; }
          catch (error) { db.exec("ROLLBACK TO operation; RELEASE operation"); throw error; }
        }, getAlarm: async () => alarm, setAlarm: async value => { alarm = value; } }, waitUntil: task => task.catch(() => {}) };
        stores.set(name, { database: new ApplicationDatabase(ctx, env), db });
      }
      return stores.get(name).database;
    } },
  };
  let sequence = 0;
  const call = async (user, scope, body, appId = "app-a", collection = "items") => {
    const input = { ...body };
    if (["create", "update", "increment", "remove"].includes(input.operation) && !input.requestId) input.requestId = `request-${++sequence}`;
    const response = await applicationData(new Request(`https://test/v1/app-data/${appId}/${scope}/${collection}`, { method: "POST", headers: { Authorization: `Bearer ${user}` }, body: JSON.stringify(input) }), env);
    return { status: response.status, ...await response.json() };
  };
  const roomCall = async (user, room, body) => {
    const input = { ...body, requestId: body.requestId ?? `request-${++sequence}` };
    const response = await applicationRooms(new Request(`https://test/v1/app-rooms/app-a/${room}/data/items`, { method: "POST", headers: { Authorization: `Bearer ${user}` }, body: JSON.stringify(input) }), env);
    return { status: response.status, ...await response.json() };
  };
  const fileCall = async (user, file, method, body, visibility = "private") => applicationFiles(new Request(`https://test/v1/app-files/app-a/${file}`, { method, headers: { Authorization: `Bearer ${user}`, "Content-Type": "image/png", "X-File-Visibility": visibility }, ...(body ? {body} : {}) }), env);
  return { call, roomCall, fileCall, env, stores, close: () => { for (const store of stores.values()) store.db.close(); } };
}

test("atomic increments preserve numbers and are not repeated on retry", async () => {
  const f = fixture();
  try {
    const created = await f.call("alice", "private", { operation: "create", data: { score: 10, title: "keep" } });
    const operation = { operation: "increment", id: created.result.id, data: { score: 2, wins: 1 }, requestId: "increment-once" };
    const first = await f.call("alice", "private", operation);
    assert.deepEqual(first.result.data, { score: 12, wins: 1, title: "keep" });
    assert.deepEqual((await f.call("alice", "private", operation)).result, first.result);
    assert.equal((await f.call("alice", "private", { ...operation, requestId: "bad-increment", data: { title: 1 } })).status, 400);
    assert.equal((await f.call("alice", "private", { ...operation, requestId: "stale-increment", expectedVersion: 1 })).status, 409);
  } finally { f.close(); }
});

test("room collaborators update shared records without changing the creator; other rooms stay isolated", async () => {
  const f = fixture();
  try {
    const created = await f.roomCall("alice", "GameA", { operation: "create", data: { score: 0 } });
    assert.equal(created.status, 200);
    const updated = await f.roomCall("bob", "GameA", { operation: "increment", id: created.result.id, data: { score: 3 } });
    assert.equal(updated.status, 200); assert.equal(updated.result.createdBy, users.alice); assert.equal(updated.result.data.score, 3);
    assert.equal((await f.roomCall("bob", "GameB", { operation: "get", id: created.result.id })).result, null);
    assert.equal((await f.call("bob", "public", { operation: "get", id: created.result.id })).result, null);
    assert.equal((await f.roomCall("anonymous", "GameA", { operation: "list" })).status, 401);
  } finally { f.close(); }
});

test("private uploads are encrypted in the public bucket and authenticated downloads restore bytes", async () => {
  const f = fixture(), file = "33333333-3333-4333-8333-333333333333", bytes = new Uint8Array([1, 2, 3, 4]);
  try {
    const response = await f.fileCall("alice", file, "PUT", bytes); assert.equal(response.status, 200);
    const value = (await response.json()).result; assert.equal(value.url, undefined); assert.equal(value.bytes, 4);
    const stored = f.env.BLOBS.objects.get(`v1/app-files/private/app-a/${users.alice}/${file}`); assert.notDeepEqual(stored, bytes);
    const content = await applicationFiles(new Request(`https://test/v1/app-files/app-a/${file}/content`, { headers: { Authorization: "Bearer alice" } }), f.env);
    assert.deepEqual(new Uint8Array(await content.arrayBuffer()), bytes);
    assert.equal((await (await f.fileCall("bob", file, "GET")).json()).result, null);
    assert.equal((await f.fileCall("anonymous", file, "GET")).status, 401);
    assert.equal((await f.fileCall("alice", file, "PUT", bytes, "public")).status, 409);
    assert.equal((await f.fileCall("alice", file, "DELETE")).status, 200); assert.equal(f.env.BLOBS.objects.size, 0);
  } finally { f.close(); }
});

test("equal file IDs across accounts never overwrite each other's objects", async () => {
  const f = fixture(), file = "44444444-4444-4444-8444-444444444444";
  try {
    const a = await (await f.fileCall("alice", file, "PUT", new Uint8Array([1]), "public")).json();
    const b = await (await f.fileCall("bob", file, "PUT", new Uint8Array([2]), "public")).json();
    assert.notEqual(a.result.url, b.result.url); assert.equal(f.env.BLOBS.objects.size, 2);
    const content = await applicationFiles(new Request(`https://test/v1/app-files/app-a/${file}/content`, { headers: { Authorization: "Bearer alice" } }), f.env);
    assert.deepEqual(new Uint8Array(await content.arrayBuffer()), new Uint8Array([1]));
    await f.fileCall("bob", file, "DELETE"); assert.equal(f.env.BLOBS.objects.size, 1);
  } finally { f.close(); }
});

test("hibernated room handlers recover identities and sequence; expired and closed sockets stop receiving", () => {
  const f = fixture();
  try {
    const base = f.env.APP_DATA.getByName("room:app-a:GameA").ctx;
    const makeSocket = (member, expiresAt) => ({ readyState: 1, output: [], metadata: { appId: "app-a", roomId: "GameA", member: { id: member, name: member, avatarUrl: null }, expiresAt, window: 0, count: 0 }, deserializeAttachment() { return structuredClone(this.metadata); }, serializeAttachment(value) { this.metadata = structuredClone(value); }, send(value) { this.output.push(JSON.parse(value)); }, close() { this.readyState = 3; } });
    const alice = makeSocket(users.alice, Date.now() + 60000), bob = makeSocket(users.bob, Date.now() + 60000), stale = makeSocket("stale", Date.now() - 1);
    const ctx = { ...base, getWebSockets: () => [alice, bob, stale] };
    new RoomConnections(ctx).message(alice, JSON.stringify({ event: "guess", requestId: "event-first", data: { answer: "cat" } }));
    const first = bob.output.at(-1); assert.equal(first.senderId, users.alice); assert.equal(first.event, "guess"); assert.equal(stale.readyState, 3); assert.equal(stale.output.length, 0);
    new RoomConnections(ctx).message(bob, JSON.stringify({ event: "guess", requestId: "event-second", data: {} }));
    assert.ok(alice.output.at(-1).sequence > first.sequence);
    bob.readyState = 3; const count = bob.output.length;
    new RoomConnections(ctx).changed("items"); assert.equal(bob.output.length, count); assert.equal(alice.output.at(-1).type, "changed");
    new RoomConnections(ctx).message(alice, JSON.stringify({ requestId: "bad-event", data: {} })); assert.equal(alice.output.at(-1).code, "INVALID_ARGUMENT");
  } finally { f.close(); }
});

test("private data follows authenticated identity and app, not client-supplied identity", async () => {
  const f = fixture();
  try {
    const created = await f.call("alice", "private", { operation: "create", data: { value: 1 }, userId: users.bob });
    assert.equal(created.status, 200); assert.equal(created.result.createdBy, users.alice);
    for (const [user, scope, app] of [["bob", "private", "app-a"], ["alice", "private", "app-b"], ["alice", "public", "app-a"]]) {
      const result = await f.call(user, scope, { operation: "get", id: created.result.id }, app);
      assert.equal(result.status, 200); assert.equal(result.result, null);
    }
    assert.equal((await f.call("anonymous", "private", { operation: "list" })).status, 401);
    assert.equal((await f.call("alice", "private", { operation: "list" }, "app-unknown")).status, 403);
  } finally { f.close(); }
});

test("public records can be read by others but only their creator may mutate", async () => {
  const f = fixture();
  try {
    const { result } = await f.call("alice", "public", { operation: "create", data: { text: "hello" } });
    assert.equal((await f.call("bob", "public", { operation: "get", id: result.id })).result.data.text, "hello");
    assert.equal((await f.call("bob", "public", { operation: "update", id: result.id, data: { text: "stolen" } })).status, 403);
    assert.equal((await f.call("bob", "public", { operation: "remove", id: result.id })).status, 403);
    assert.equal((await f.call("alice", "public", { operation: "get", id: result.id })).result.version, 1);
  } finally { f.close(); }
});

test("writes are idempotent, version checked, and shallow merged", async () => {
  const f = fixture();
  try {
    const body = { operation: "create", data: { nested: { a: 1, b: 2 }, keep: true }, requestId: "create-once" };
    const { result } = await f.call("alice", "private", body);
    assert.deepEqual((await f.call("alice", "private", body)).result, result);
    assert.equal((await f.call("alice", "private", { ...body, data: { other: true } })).status, 409);
    const updated = await f.call("alice", "private", { operation: "update", id: result.id, data: { nested: { a: 3 } }, expectedVersion: 1 });
    assert.equal(updated.result.version, 2); assert.deepEqual(updated.result.data, { nested: { a: 3 }, keep: true });
    assert.equal((await f.call("alice", "private", { operation: "update", id: result.id, data: {}, expectedVersion: 1 })).status, 409);
    const removal = { operation: "remove", id: result.id, requestId: "remove-once" };
    assert.equal((await f.call("alice", "private", removal)).status, 200);
    assert.equal((await f.call("alice", "private", removal)).status, 200);
    assert.equal((await f.call("alice", "private", { operation: "get", id: result.id })).result, null);
  } finally { f.close(); }
});

test("pagination handles equal sort values, nulls, Unicode, and binds cursor to query", async () => {
  const f = fixture();
  try {
    for (const name of [null, "生花", "生花", "朋友", "A"]) await f.call("alice", "public", { operation: "create", data: { name, score: 1 } });
    for (const direction of ["asc", "desc"]) {
      const ids = []; let cursor;
      do {
        const page = await f.call("alice", "public", { operation: "list", query: { orderBy: { field: "name", direction }, limit: 2, ...(cursor ? { cursor } : {}) } });
        assert.equal(page.status, 200); ids.push(...page.result.items.map(item => item.id)); cursor = page.result.nextCursor;
      } while (cursor);
      assert.equal(ids.length, 5); assert.equal(new Set(ids).size, 5);
    }
    const page = await f.call("alice", "public", { operation: "list", query: { limit: 1 } });
    assert.equal((await f.call("bob", "public", { operation: "list", query: { cursor: page.result.nextCursor } })).status, 400);
    assert.equal((await f.call("alice", "public", { operation: "list", query: { where: [{ field: "score", op: "eq", value: true }] } })).result.items.length, 0);
    assert.equal((await f.call("alice", "public", { operation: "list", query: { orderBy: { field: "name'); DROP TABLE records;--", direction: "asc" } } })).status, 400);
  } finally { f.close(); }
});

test("document and storage quotas reject writes without partially updating records", async () => {
  const f = fixture();
  try {
    assert.equal((await f.call("alice", "private", { operation: "create", data: { text: "x".repeat(33000) } })).status, 400);
    const { result } = await f.call("alice", "private", { operation: "create", data: { text: "initial" } });
    f.stores.get(`user:${users.alice}`).db.exec(`UPDATE usage SET bytes=${50 * 1024 * 1024}`);
    assert.equal((await f.call("alice", "private", { operation: "update", id: result.id, data: { text: "longer than the original" } })).status, 413);
    assert.deepEqual((await f.call("alice", "private", { operation: "get", id: result.id })).result, result);
  } finally { f.close(); }
});

test("long scalar values still produce usable pagination cursors", async () => {
  const f = fixture();
  try {
    for (const suffix of ["1", "2"]) await f.call("alice", "private", { operation: "create", data: { text: "x".repeat(30000) + suffix } });
    const query = { limit: 1, orderBy: { field: "text", direction: "asc" } };
    const first = await f.call("alice", "private", { operation: "list", query });
    assert.equal(first.status, 200); assert.ok(first.result.nextCursor.length > 30000);
    const second = await f.call("alice", "private", { operation: "list", query: { ...query, cursor: first.result.nextCursor } });
    assert.equal(second.status, 200); assert.equal(second.result.items.length, 1);
    assert.notEqual(second.result.items[0].id, first.result.items[0].id);
    assert.equal(second.result.nextCursor, null);
  } finally { f.close(); }
});

test("failed mutations count toward durable rate limits without changing business data", async () => {
  const f = fixture();
  try {
    for (let index = 0; index < 120; index++) assert.equal((await f.call("alice", "private", { operation: "update", id: "33333333-3333-4333-8333-333333333333", data: {} })).status, 404);
    assert.equal((await f.call("alice", "private", { operation: "list" })).status, 429);
    assert.equal(f.stores.get(`user:${users.alice}`).db.prepare("SELECT COUNT(*) AS count FROM records").get().count, 0);
    assert.equal((await f.call("bob", "private", { operation: "list" })).status, 200);
  } finally { f.close(); }
});
