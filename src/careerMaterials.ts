const MAX_BYTES = 1024 * 1024;
const MAX_ITEMS = 300;
const roles = ['通用', '产品', '运营', '前端', '后端', '数据分析', '设计'];
type Source = { label: string; url: string };
type Material = {
  id: string; kind: string; title: string; summary: string; roles: string[]; tags: string[];
  level: string; minutes: number; updatedAt: string; contentVersion: string; company?: string; interviewDate?: string;
  sources: Source[]; sections: { title: string; body: string }[];
  question?: string; answerPoints: string[]; followUps: string[]; pitfalls: string[];
};
type Catalog = { revision: number; updatedAt: string; items: Material[] };
const response = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers: { 'Cache-Control': 'no-cache', ...headers } });
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('内容必须是 JSON 对象');
  return v as Record<string, unknown>;
};
function text(v: unknown, name: string, max: number, optional = false): string {
  if (optional && v === undefined) return '';
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new Error(`${name}不能为空，最多 ${max} 字`);
  return v.trim();
}
function date(v: unknown, name: string): string {
  const value = text(v, name, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error(`${name}需为有效的 YYYY-MM-DD 日期`);
  return value;
}
function strings(v: unknown, name: string, max = 10, length = 400): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > max) throw new Error(`${name}最多 ${max} 项`);
  return [...new Set(v.map(s => text(s, name, length)))];
}
function material(value: unknown): Material {
  const v = object(value), id = text(v.id, 'id', 64), kind = text(v.kind, 'kind', 10);
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error('id需以小写字母开头，仅含小写字母、数字和短横线');
  if (!['考点', '面经', '指南'].includes(kind)) throw new Error('kind需为考点、面经或指南');
  const roleList = strings(v.roles, 'roles', 7, 20);
  if (!roleList.length || roleList.some(r => !roles.includes(r))) throw new Error('roles需包含至少一个有效岗位');
  if (!Array.isArray(v.sources) || !v.sources.length || v.sources.length > 5) throw new Error('每份资料需提供 1–5 个真实来源');
  const sources = v.sources.map(s => {
    const row = object(s), label = text(row.label, '来源名称', 100), url = text(row.url, '来源地址', 1000);
    let parsed: URL; try { parsed = new URL(url); } catch { throw new Error('来源地址无效'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('来源地址必须是无凭据的 HTTPS 链接');
    return { label, url };
  });
  if (!Array.isArray(v.sections) || !v.sections.length || v.sections.length > 12) throw new Error('sections需包含 1–12 个正文段落');
  const sections = v.sections.map(s => { const row = object(s); return { title: text(row.title, '段落标题', 80), body: text(row.body, '段落正文', 6000) }; });
  const company = text(v.company, '公司', 100, true), interviewDate = v.interviewDate === undefined ? '' : date(v.interviewDate, '面试日期');
  if (kind === '面经' && (!company || !interviewDate)) throw new Error('面经必须填写公司和实际面试日期');
  const level = text(v.level, 'level', 10);
  if (!['入门', '进阶'].includes(level) || !Number.isInteger(v.minutes) || Number(v.minutes) < 1 || Number(v.minutes) > 60) throw new Error('level需为入门/进阶，minutes需为 1–60 的整数');
  const question = text(v.question, '练习题', 160, true);
  if (kind === '考点' && !question) throw new Error('考点必须有可练习的问题');
  const result: Material = { id, kind, title: text(v.title, '标题', 100), summary: text(v.summary, '摘要', 300), roles: roleList, tags: strings(v.tags, 'tags', 8, 30), level, minutes: Number(v.minutes), updatedAt: date(v.updatedAt, '更新日期'), contentVersion: crypto.randomUUID(), sources, sections, answerPoints: strings(v.answerPoints, '回答要点'), followUps: strings(v.followUps, '追问'), pitfalls: strings(v.pitfalls, '易错点'), ...(company ? { company } : {}), ...(interviewDate ? { interviewDate } : {}), ...(question ? { question } : {}) };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 32 * 1024) throw new Error(`${id}单份资料不能超过 32 KiB`);
  return result;
}
async function readBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get('Content-Length')) > MAX_BYTES) throw new RangeError('资料请求最多 1 MiB');
  const reader = request.body?.getReader(); if (!reader) throw new Error('请求没有正文');
  const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > MAX_BYTES) { await reader.cancel(); throw new RangeError('资料请求最多 1 MiB'); } chunks.push(next.value); } }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error('正文不是有效 JSON'); }
}

/** One SQLite row is an atomic catalog snapshot; no new storage binding or app credentials. */
export async function careerMaterials(request: Request, storage: DurableObjectStorage, canWrite: boolean): Promise<Response> {
  if (!['GET', 'HEAD', 'PUT', 'PATCH'].includes(request.method)) return response({ message: '不支持此方法' }, 405, { Allow: 'GET, HEAD, PUT, PATCH' });
  const writing = request.method === 'PUT' || request.method === 'PATCH';
  if (writing && !canWrite) return response({ message: '资料维护需要维护者授权' }, 403);
  storage.sql.exec('CREATE TABLE IF NOT EXISTS career_materials (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL)');
  const read = (): Catalog => {
    const row = storage.sql.exec<{ body: string }>('SELECT body FROM career_materials WHERE id=1').toArray()[0];
    return row ? JSON.parse(row.body) : { revision: 0, updatedAt: '', items: [] };
  };
  if (!writing) {
    const catalog = read(), etag = `"${catalog.revision}"`, headers = { ETag: etag, 'Cache-Control': 'no-cache' };
    if (request.headers.get('If-None-Match')?.split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag)) return new Response(null, { status: 304, headers });
    return request.method === 'HEAD' ? new Response(null, { headers }) : response(catalog, 200, headers);
  }
  const match = request.headers.get('If-Match');
  if (!match || !/^"\d+"$/.test(match)) return response({ message: '先 GET 读取 revision，再传 If-Match: "版本整数"' }, 428);
  try {
    const input = object(await readBody(request));
    if (!Array.isArray(input.items) || input.items.length > MAX_ITEMS) throw new Error(`items需为数组，最多 ${MAX_ITEMS} 份资料`);
    const items = input.items.map(material), removeIds = strings(input.removeIds, 'removeIds', MAX_ITEMS, 64);
    if (new Set(items.map(i => i.id)).size !== items.length || removeIds.some(id => !/^[a-z][a-z0-9-]{0,63}$/.test(id) || items.some(i => i.id === id))) throw new Error('id重复，或同一份资料同时新增和删除');
    if (request.method === 'PUT' && removeIds.length) throw new Error('PUT是完整替换，不接受removeIds');
    return storage.transactionSync(() => {
      const current = read();
      if (match !== `"${current.revision}"`) return response({ message: '资料已被更新，请重新读取后提交', revision: current.revision }, 409);
      const merged = request.method === 'PUT' ? new Map<string, Material>() : new Map(current.items.map(i => [i.id, i]));
      for (const id of removeIds) merged.delete(id);
      for (const item of items) merged.set(item.id, item);
      if (merged.size > MAX_ITEMS) throw new Error(`资料库最多 ${MAX_ITEMS} 份`);
      const next: Catalog = { revision: current.revision + 1, updatedAt: new Date().toISOString(), items: [...merged.values()] };
      const body = JSON.stringify(next);
      if (new TextEncoder().encode(body).byteLength > MAX_BYTES) throw new RangeError('完整资料库最多 1 MiB');
      storage.sql.exec('INSERT INTO career_materials(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body', body);
      return response({ published: true, revision: next.revision, count: next.items.length, updatedAt: next.updatedAt }, 200, { ETag: `"${next.revision}"` });
    });
  } catch (error) { return response({ message: error instanceof Error ? error.message : '资料格式无效' }, error instanceof RangeError ? 413 : 400); }
}
