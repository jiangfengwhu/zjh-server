import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
const compiled = await build({ entryPoints: ['src/careerContent.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { careerContent } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const common = { title: '资料标题', body: '正文内容', roles: ['通用'], tags: [], updatedAt: '2026-10-12', provenance: '示例' };
const question = { ...common, id: 'question-one', kind: 'question', question: '项目里如何做取舍？', followups: ['为什么？'] };
const resume = { ...common, id: 'resume-one', kind: 'resume', before: '负责项目', after: '负责［具体动作］并交付［真实结果］' };
const source = { label: '公开来源', url: 'https://example.com/source' };
const timeline = { ...common, id: 'timeline-one', kind: 'timeline', provenance: '官方资料', company: '示例招聘方', source, startAt: '2026-10-20T10:00:00+08:00', eventType: '网申' };
function fixture() {
  const db = new DatabaseSync(':memory:');
  const storage = { sql: { exec(q, ...args) { const statement = db.prepare(q), rows = statement.columns().length ? statement.all(...args) : (statement.run(...args), []); return { toArray: () => rows }; } }, transactionSync(work) { db.exec('BEGIN'); try { const result = work(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } } };
  const call = (method = 'GET', body, match, authorized = true) => careerContent(new Request('https://test/v1/career-rescue/content', { method, headers: { 'Content-Type': 'application/json', ...(match ? { 'If-Match': match } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), storage, authorized);
  return { call, storage, close: () => db.close() };
}
test('one request atomically updates multiple kinds; one invalid item rejects all changes', async () => {
  const f = fixture(); try {
    assert.equal((await f.call('PATCH', { items: [question, resume, timeline] }, '"0"', false)).status, 403);
    assert.equal((await f.call('PATCH', { items: [question] })).status, 428);
    const result = await f.call('PATCH', { items: [question, resume, timeline] }, '"0"'); assert.equal(result.status, 200);
    const counts = (await result.json()).counts; assert.equal(counts.resume, 1); assert.equal(counts.question, 1); assert.equal(counts.timeline, 1);
    assert.equal((await f.call('PATCH', { items: [{ ...question, title: 'changed' }, { ...timeline, startAt: '2026-02-30T10:00:00+08:00' }] }, '"1"')).status, 400);
    const current = await (await f.call()).json(); assert.equal(current.revision, 1); assert.equal(current.items[0].title, common.title);
    assert.equal((await f.call('PATCH', { items: [question, question] }, '"1"')).status, 400);
    assert.equal((await f.call('PATCH', { items: [question], removeIds: [question.id] }, '"1"')).status, 400);
  } finally { f.close(); }
});
test('revision prevents lost updates; weak read ETags are accepted and batch deletion works', async () => {
  const f = fixture(); try {
    await f.call('PUT', { items: [question, resume] }, '"0"');
    const results = await Promise.all([f.call('PATCH', { items: [{ ...question, title: 'first' }] }, '"1"'), f.call('PATCH', { items: [{ ...resume, title: 'second' }] }, '"1"')]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    const cached = await careerContent(new Request('https://test/v1/career-rescue/content', { headers: { 'If-None-Match': 'W/"2"' } }), f.storage, false); assert.equal(cached.status, 304);
    assert.equal((await f.call('PATCH', { items: [], removeIds: [question.id, resume.id] }, '"2"')).status, 200);
    assert.deepEqual((await (await f.call()).json()).items, []);
  } finally { f.close(); }
});
test('real reports and timelines require sources; payload limits leave published data intact', async () => {
  const f = fixture(); try {
    const risk = { ...common, id: 'risk-one', kind: 'risk', company: '测试企业', severity: '高', reportCount: 1 };
    assert.equal((await f.call('PUT', { items: [risk] }, '"0"')).status, 400);
    assert.equal((await f.call('PUT', { items: [{ ...risk, source, provenance: '公开面经' }] }, '"0"')).status, 200);
    assert.equal((await f.call('PATCH', { items: [{ ...timeline, source: { ...source, url: 'javascript:bad' } }] }, '"1"')).status, 400);
    const tooLarge = await f.call('PATCH', { items: [], padding: 'a'.repeat(1024 * 1024) }, '"1"'); assert.equal(tooLarge.status, 413);
    assert.equal((await (await f.call()).json()).revision, 1);
  } finally { f.close(); }
});
