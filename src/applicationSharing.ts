export type ShareValue = null | boolean | number | string | ShareValue[] | { [key: string]: ShareValue };
export type ShareParams = { [key: string]: ShareValue };
export type ApplicationSelection = { appId: string; releaseId: string; params?: ShareParams };
export type ApplicationLink = ApplicationSelection & { title: string; summary: string; accent: string; iconUrl?: string; icon?: { sha256: string; bytes: number; format: "svg" }; author?: { id: string | null; name: string; avatarUrl: string | null } };
export class ApplicationShareError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
export function normalizeShareParams(value: unknown): ShareParams | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApplicationShareError("分享参数必须是 JSON 对象");
  function check(item: unknown, depth: number): void {
    if (depth > 8) throw new ApplicationShareError("分享参数嵌套过深");
    if (item === null || typeof item === "string" || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)) return;
    if (!item || typeof item !== "object" || !Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new ApplicationShareError("分享参数必须是 JSON 数据");
    Object.values(item).forEach(child => check(child, depth + 1));
  }
  check(value, 0);
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).byteLength > 4096) throw new ApplicationShareError("分享参数最多 4096 字节");
  return JSON.parse(json);
}
export function applicationSelection(value: unknown): ApplicationSelection | undefined {
  if (value == null) return;
  const input = value as ApplicationSelection;
  if (typeof value !== "object" || Array.isArray(value) || typeof input.appId !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(input.appId) || typeof input.releaseId !== "string" || !/^[a-f0-9]{64}$/.test(input.releaseId)) throw new ApplicationShareError("附带应用无效");
  const params = normalizeShareParams(input.params);
  return { appId: input.appId, releaseId: input.releaseId, ...(params ? { params } : {}) };
}
export async function resolveApplicationShare(env: Env, selection: ApplicationSelection): Promise<ApplicationLink> {
  const response = await env.WORKSHOP.getByName("dynamic").fetch(new Request(`https://workshop.internal/v1/market?appId=${selection.appId}`));
  if (!response.ok) throw new ApplicationShareError("作品暂时不可用，请重试", 503);
  const result = await response.json() as { applications?: Array<{ authorId: string | null; authorName?: string; authorAvatarUrl?: string | null; title?: string; summary?: string; iconUrl?: string; manifest: { appId: string; releaseId: string; appName: string; description: string; accent: string; icon?: ApplicationLink["icon"] } }> };
  const entry = result.applications?.[0];
  if (!entry || entry.manifest.appId !== selection.appId) throw new ApplicationShareError("只能分享已公开的作品", 404);
  if (entry.manifest.releaseId !== selection.releaseId) throw new ApplicationShareError("公开版本已变化，请重新选择应用", 409);
  return { ...selection, iconUrl: entry.iconUrl, icon: entry.manifest.icon, title: (entry.title || entry.manifest.appName).slice(0, 60), summary: (entry.summary ?? entry.manifest.description ?? "").slice(0, 300), accent: /^#[a-f0-9]{6}$/i.test(entry.manifest.accent) ? entry.manifest.accent : "#A77C45", author: { id: entry.authorId, name: entry.authorName || "作者", avatarUrl: entry.authorAvatarUrl ?? null } };
}
export function applicationShareQuery(params?: ShareParams) { const value = normalizeShareParams(params); return value ? `?p=${encodeURIComponent(JSON.stringify(value)).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}` : ""; }
