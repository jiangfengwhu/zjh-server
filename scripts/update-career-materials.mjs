import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const file = process.argv[2];
if (!file) throw new Error('用法：node scripts/update-career-materials.mjs <JSON文件> [--replace]');
const url = 'https://zijinhua.297782.xyz/v1/career-rescue/materials';
const input = JSON.parse(await readFile(path.resolve(file), 'utf8'));
const read = await fetch(url, { signal: AbortSignal.timeout(15000) });
if (!read.ok || !read.headers.get('etag')) throw new Error(`读取资料版本失败：${read.status}`);
const token = (process.env.OFFICIAL_PUBLISH_TOKEN || await readFile(path.join(os.homedir(), '.codex', 'zjh-official-publish-token'), 'utf8')).trim();
const result = await fetch(url, {
  method: process.argv.includes('--replace') ? 'PUT' : 'PATCH',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'If-Match': read.headers.get('etag') },
  body: JSON.stringify({ items: input.items, ...(input.removeIds ? { removeIds: input.removeIds } : {}) }), signal: AbortSignal.timeout(20000),
});
const body = await result.json();
if (!result.ok) throw new Error(body.message || `更新失败：${result.status}`);
console.log(JSON.stringify(body));
