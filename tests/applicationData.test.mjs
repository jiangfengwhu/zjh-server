import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

// Run the production routing and SQL against real SQLite without production data.
const compiled = await build({
  entryPoints: [new URL("../src/applicationData.ts", import.meta.url).pathname.replace(/^\/(.:\/)/, "$1")],
  bundle: true, platform: "node", format: "esm", write: false,
  plugins: [{ name: "durable-object-context", setup(builder) {
    builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "cloudflare:workers", namespace: "test" }));
    builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: "export class DurableObject { constructor(ctx,env){ this.ctx=ctx; this.env=env; } }" }));
  } }],
});
const { ApplicationDatabase, applicationData } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
const users = { alice: "11111111-1111-4111-8111-111111111111", bob: "22222222-2222-4222-8222-222222222222" };
function fixture() {
  const stores = new Map();
  const env = {
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
        const ctx = { storage: { sql, transactionSync(work) {
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
    if (["create", "update", "remove"].includes(input.operation) && !input.requestId) input.requestId = `request-${++sequence}`;
    const response = await applicationData(new Request(`https://test/v1/app-data/${appId}/${scope}/${collection}`, { method: "POST", headers: { Authorization: `Bearer ${user}` }, body: JSON.stringify(input) }), env);
    return { status: response.status, ...await response.json() };
  };
  return { call, stores, close: () => { for (const store of stores.values()) store.db.close(); } };
}

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
