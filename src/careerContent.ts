const MAX_BYTES = 1024 * 1024;
const MAX_ITEMS = 500;
const kinds = ['resume', 'question', 'followup', 'risk', 'timeline'] as const;
type Kind = typeof kinds[number];
type Item = { id: string; kind: Kind; title: string; body: string; roles: string[]; tags: string[]; updatedAt: string; company?: string; source?: { label: string; url: string }; provenance: '官方资料' | '公开面经' | '示例'; before?: string; after?: string; question?: string; followups?: string[]; interviewDate?: string; severity?: '高' | '中' | '低'; reportCount?: number; startAt?: string; endAt?: string; eventType?: string; applicationUrl?: string };
type Catalog = { revision: number; updatedAt: string; items: Item[] };
const response = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers: { 'Cache-Control': 'no-cache', ...headers } });
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('资料必须是 JSON 对象');
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, max: number, optional = false): string {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name}不能为空且最多 ${max} 字`);
  return value.trim();
}
function list(value: unknown, name: string, max = 12, length = 100): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw new Error(`${name}最多 ${max} 项`);
  return [...new Set(value.map(v => text(v, name, length)))];
}
function id(value: unknown): string { const v = text(value, 'id', 64); if (!/^[a-z][a-z0-9-]{0,63}$/.test(v)) throw new Error('id须为小写字母开头的小写字母、数字、短横线'); return v; }
function date(value: unknown, name: string): string {
  const v = text(value, name, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0, 10) !== v) throw new Error(`${name}须为有效 YYYY-MM-DD`);
  return v;
}
function time(value: unknown, name: string): string {
  const v = text(value, name, 40);
  if (!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(v) || !Number.isFinite(Date.parse(v))) throw new Error(`${name}须为带时区的 ISO 时间`);
  date(v.slice(0, 10), name); return v;
}
function url(value: unknown, name: string): string {
  const v = text(value, name, 1000); let u: URL;
  try { u = new URL(v); } catch { throw new Error(`${name}无效`); }
  if (u.protocol !== 'https:' || u.username || u.password) throw new Error(`${name}须为无凭据 HTTPS 链接`);
  return v;
}
function item(value: unknown): Item {
  const v = object(value), kind = text(v.kind, 'kind', 20) as Kind;
  if (!kinds.includes(kind)) throw new Error(`kind须为 ${kinds.join(' / ')}`);
  const provenance = text(v.provenance, 'provenance', 10) as Item['provenance'];
  if (!['官方资料', '公开面经', '示例'].includes(provenance)) throw new Error('provenance须为官方资料、公开面经或示例');
  const company = text(v.company, 'company', 100, true);
  const source = v.source === undefined ? undefined : (() => { const s = object(v.source); return { label: text(s.label, 'source.label', 100), url: url(s.url, 'source.url') }; })();
  if (provenance !== '示例' && !source) throw new Error('非示例资料必须附 source');
  const result: Item = { id: id(v.id), kind, title: text(v.title, 'title', 160), body: text(v.body, 'body', 12000), roles: list(v.roles, 'roles', 12, 40), tags: list(v.tags, 'tags', 12, 30), updatedAt: date(v.updatedAt, 'updatedAt'), provenance, ...(company ? { company } : {}), ...(source ? { source } : {}) };
  if (kind === 'resume') { result.before = text(v.before, 'before', 6000); result.after = text(v.after, 'after', 6000); }
  if (kind === 'question') {
    result.question = text(v.question, 'question', 1000); result.followups = list(v.followups, 'followups', 12, 1000);
    if (provenance === '公开面经') { if (!company) throw new Error('公开面经须填写公司'); result.interviewDate = date(v.interviewDate, 'interviewDate'); }
  }
  if (kind === 'risk') {
    if (!company || !source || provenance === '示例') throw new Error('避雷反馈须填写公司和真实来源，不能发布示例指控');
    if (!['高', '中', '低'].includes(String(v.severity))) throw new Error('severity须为高、中或低');
    if (!Number.isInteger(v.reportCount) || Number(v.reportCount) < 1 || Number(v.reportCount) > 100000) throw new Error('reportCount须为1–100000');
    result.severity = v.severity as Item['severity']; result.reportCount = Number(v.reportCount);
  }
  if (kind === 'timeline') {
    if (!company || !source || provenance === '示例') throw new Error('招聘时间线须填写公司和真实来源');
    result.startAt = time(v.startAt, 'startAt');
    if (v.endAt !== undefined) { result.endAt = time(v.endAt, 'endAt'); if (Date.parse(result.endAt) < Date.parse(result.startAt)) throw new Error('endAt不能早于startAt'); }
    result.eventType = text(v.eventType, 'eventType', 20);
    if (!['网申', '笔试', '面试', '截止', '宣讲'].includes(result.eventType)) throw new Error('eventType须为网申、笔试、面试、截止或宣讲');
    if (v.applicationUrl !== undefined) result.applicationUrl = url(v.applicationUrl, 'applicationUrl');
  }
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 32 * 1024) throw new Error('单份资料最多32 KiB');
  return result;
}
async function readBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get('Content-Length')) > MAX_BYTES) throw new RangeError('请求最多1 MiB');
  const reader = request.body?.getReader(); if (!reader) throw new Error('没有请求正文');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try { while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes > MAX_BYTES) { await reader.cancel(); throw new RangeError('请求最多1 MiB'); } chunks.push(next.value); } }
  finally { reader.releaseLock(); }
  const all = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(all)); } catch { throw new Error('正文不是有效JSON'); }
}
/** Five content kinds share one revision and one atomic SQLite snapshot. */
export async function careerContent(request: Request, storage: DurableObjectStorage, canWrite: boolean): Promise<Response> {
  if (!['GET', 'HEAD', 'PUT', 'PATCH'].includes(request.method)) return response({ message: '不支持此方法' }, 405, { Allow: 'GET, HEAD, PUT, PATCH' });
  const writing = ['PUT', 'PATCH'].includes(request.method);
  if (writing && !canWrite) return response({ message: '资料维护需要维护者授权' }, 403);
  storage.sql.exec('CREATE TABLE IF NOT EXISTS career_content (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL)');
  const read = (): Catalog => { const row = storage.sql.exec<{ body: string }>('SELECT body FROM career_content WHERE id=1').toArray()[0]; return row ? JSON.parse(row.body) : { revision: 0, updatedAt: '', items: [] }; };
  if (!writing) {
    const current = read(), etag = `"${current.revision}"`, headers = { ETag: etag, 'Cache-Control': 'no-cache' };
    if (request.headers.get('If-None-Match')?.split(',').some(v => v.trim() === '*' || v.trim().replace(/^W\//, '') === etag)) return new Response(null, { status: 304, headers });
    return request.method === 'HEAD' ? new Response(null, { headers }) : response(current, 200, headers);
  }
  const match = request.headers.get('If-Match');
  if (!match || !/^"\d+"$/.test(match)) return response({ message: '先GET读取revision，再传If-Match: "版本整数"' }, 428);
  try {
    const input = object(await readBody(request));
    if (!Array.isArray(input.items) || input.items.length > MAX_ITEMS) throw new Error('items最多500项');
    const items = input.items.map(item), removed = list(input.removeIds, 'removeIds', MAX_ITEMS, 64).map(id);
    if (new Set(items.map(i => i.id)).size !== items.length || items.some(i => removed.includes(i.id))) throw new Error('批次id不能重复或同时更新与删除');
    if (request.method === 'PUT' && removed.length) throw new Error('全量替换不传removeIds');
    return storage.transactionSync(() => {
      const current = read(); if (match !== `"${current.revision}"`) return response({ message: '资料已更新，请重新读取后提交', revision: current.revision }, 409);
      const merged = request.method === 'PUT' ? new Map<string, Item>() : new Map(current.items.map(i => [i.id, i]));
      removed.forEach(id => merged.delete(id)); items.forEach(i => merged.set(i.id, i));
      if (merged.size > MAX_ITEMS) throw new Error('资料库最多500项');
      const next: Catalog = { revision: current.revision + 1, updatedAt: new Date().toISOString(), items: [...merged.values()] }, body = JSON.stringify(next);
      if (new TextEncoder().encode(body).byteLength > MAX_BYTES) throw new RangeError('资料库最多1 MiB');
      storage.sql.exec('INSERT INTO career_content(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body', body);
      return response({ published: true, revision: next.revision, count: merged.size, counts: Object.fromEntries(kinds.map(kind => [kind, next.items.filter(i => i.kind === kind).length])), updatedAt: next.updatedAt }, 200, { ETag: `"${next.revision}"` });
    });
  } catch (error) { return response({ message: error instanceof Error ? error.message : '资料格式无效' }, error instanceof RangeError ? 413 : 400); }
}
