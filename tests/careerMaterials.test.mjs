import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
const compiled = await build({ entryPoints: ['src/careerMaterials.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { careerMaterials } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const seed = { items: [{ id: 'react-state', kind: '考点', title: '状态结构', summary: '派生状态练习', roles: ['前端'], tags: ['React'], level: '入门', minutes: 4, updatedAt: '2026-10-12', sources: [{ label: 'React', url: 'https://react.dev/learn/choosing-the-state-structure' }], sections: [{ title: '概念', body: '避免冗余状态' }], question: '筛选结果是否存state？', answerPoints: ['检查可推导性'], followUps: [], pitfalls: [] }] };
function fixture() {
  const db = new DatabaseSync(':memory:');
  const storage = {
    sql: { exec(q, ...args) { const statement = db.prepare(q); const rows = statement.columns().length ? statement.all(...args) : (statement.run(...args), []); return { toArray: () => rows }; } },
    transactionSync(work) { db.exec('BEGIN'); try { const result = work(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } },
  };
  const call = (method = 'GET', body, etag, auth = true) => careerMaterials(new Request('https://test/v1/career-rescue/materials', { method, headers: { ...(etag ? { 'If-Match': etag } : {}), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }), storage, auth);
  return { call, storage, close: () => db.close() };
}
test('catalog requires maintainer and revision, validates real sources and publishes atomically', async () => {
  const f = fixture(); try {
    assert.equal((await f.call('PATCH', seed, '"0"', false)).status, 403);
    assert.equal((await f.call('PATCH', seed)).status, 428);
    assert.equal((await f.call('PUT', { items: [{ ...seed.items[0], sources: [{ label: 'bad', url: 'javascript:alert(1)' }] }] }, '"0"')).status, 400);
    assert.equal((await f.call('PUT', { items: [{ ...seed.items[0], kind: '面经' }] }, '"0"')).status, 400);
    const first = await f.call('PUT', seed, '"0"'); assert.equal(first.status, 200);
    assert.equal((await first.json()).count, seed.items.length);
    assert.equal((await f.call('PUT', { items: [] }, '"0"')).status, 409);
    assert.equal((await (await f.call()).json()).items.length, seed.items.length);
    const [a, b] = await Promise.all([f.call('PATCH', { items: [{ ...seed.items[0], title: 'Update A' }] }, '"1"'), f.call('PATCH', { items: [{ ...seed.items[0], title: 'Update B' }] }, '"1"')]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    const next = await (await f.call()).json(); assert.equal(next.revision, 2); assert.equal(next.items[0].title, 'Update A');
    assert.notEqual(next.items[0].contentVersion, seed.items[0].contentVersion);
    const cached = await careerMaterials(new Request('https://test/v1/career-rescue/materials', { headers: { 'If-None-Match': '"2"' } }), f.storage, false);
    assert.equal(cached.status, 304);
    const compressed = await careerMaterials(new Request('https://test/v1/career-rescue/materials', { headers: { 'If-None-Match': 'W/"2"' } }), f.storage, false);
    assert.equal(compressed.status, 304);
    assert.equal((await f.call('PATCH', { items: [], removeIds: [seed.items[0].id] }, '"2"')).status, 200);
    assert.equal((await (await f.call()).json()).items.some(i => i.id === seed.items[0].id), false);
    assert.equal((await f.call('PUT', { items: [] }, '"3"')).status, 200);
    assert.deepEqual((await (await f.call()).json()).items, []);
  } finally { f.close(); }
});
test('oversized and malformed requests leave the existing catalog unchanged', async () => {
  const f = fixture(); try {
    assert.equal((await f.call('PATCH', seed, '"0"')).status, 200);
    assert.equal((await f.call('PATCH', { items: [], invalid: 'x'.repeat(1024 * 1024) }, '"1"')).status, 413);
    assert.equal((await f.call('PATCH', { items: [{ ...seed.items[0], updatedAt: '2026-02-30' }] }, '"1"')).status, 400);
    assert.equal((await (await f.call()).json()).revision, 1);
  } finally { f.close(); }
});
