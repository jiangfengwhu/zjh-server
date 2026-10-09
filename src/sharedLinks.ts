import { applicationShareQuery, normalizeShareParams, type ShareParams } from "./applicationSharing";
const host = "https://zijinhua.297782.xyz";
export const escapeSharedText = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));

export function sharedLinkActions(kind: "posts" | "applications", id: string, params?: ShareParams) {
  const query = kind === "applications" ? applicationShareQuery(params) : "";
  const fallback = `${host}/${kind}/${id}${query}`;
  const intent = `intent://${kind}/${id}${query}#Intent;scheme=zijinhua;package=com.zijinhua.app;S.browser_fallback_url=${encodeURIComponent(fallback)};end`;
  return `<section class="share-actions"><a class="open-app" href="${escapeSharedText(intent)}">打开生花</a><a class="download-app" href="/download">下载 Android 版</a><p>已安装可打开对应内容；无法唤起或下载时，请使用系统浏览器打开此页面。</p></section>`;
}
export const sharedLinkStyles = `.share-actions{display:flex;flex-wrap:wrap;gap:12px;align-items:center}.share-actions a{display:inline-block;padding:10px 18px;border-radius:12px;text-decoration:none;font-weight:600}.open-app{background:#ffd337;color:#30233f}.download-app{background:#eee8fa;color:#493165}.share-actions p{width:100%;font-size:12px;color:#777;margin:0}`;
export const sharedPageHeaders = {
  "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; img-src https:; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
};

export async function readSharedApplication(request: Request, env: Env) {
  const url = new URL(request.url);
  const id = url.pathname.split("/").at(-1)!;
  let params: ShareParams | undefined;
  try { if (url.searchParams.getAll("p").length > 1) throw new Error(); params = url.searchParams.has("p") ? normalizeShareParams(JSON.parse(url.searchParams.get("p")!)) : undefined; } catch { return new Response("分享参数无效", { status: 400, headers: sharedPageHeaders }); }
  const response = await env.WORKSHOP.getByName("dynamic").fetch(new Request(`${host}/v1/market?appId=${id}`));
  if (!response.ok) return new Response("暂时无法查看作品，请稍后重试。", { status: 503, headers: sharedPageHeaders });
  const data = await response.json() as { applications?: Array<{ title: string; summary: string; authorName: string }> };
  const app = data.applications?.[0];
  const name = app?.title || "作品暂不可用";
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeSharedText(name)} · 生花</title><style>body{margin:0;background:#faf8f5;color:#25221f;font:16px/1.7 system-ui,sans-serif}main{max-width:620px;margin:auto;padding:28px 20px}h1{font-size:18px;color:#9c7437}article{background:white;border-radius:16px;padding:20px;margin:20px 0}h2{margin:0}p{white-space:pre-wrap;overflow-wrap:anywhere}${sharedLinkStyles}</style></head><body><main><h1>生花</h1><article><h2>${escapeSharedText(name)}</h2><p>${escapeSharedText(app?.summary || "作品尚未上架或已下架。")}</p>${app ? `<p>作者：${escapeSharedText(app.authorName)}</p>` : ""}</article>${sharedLinkActions("applications", id, params)}</main></body></html>`;
  return new Response(request.method === "HEAD" ? null : html, { status: app ? 200 : 404, headers: sharedPageHeaders });
}

export async function downloadLatestApk(env: Env) {
  const apk = await env.CATALOG.get<{ sha256: string }>("v1/apk", "json");
  if (!apk || !/^[a-f0-9]{64}$/.test(apk.sha256)) return new Response("安装包暂时不可用，请稍后重试。", { status: 503 });
  return new Response(null, { status: 302, headers: { Location: `https://zjh-cdn.297782.xyz/v1/apk/${apk.sha256}.apk`, "Cache-Control": "no-store" } });
}

/** Public signing certificate fingerprint, matching the currently distributed APK. */
export function androidAssetLinks() {
  return Response.json([{ relation: ["delegate_permission/common.handle_all_urls"], target: { namespace: "android_app", package_name: "com.zijinhua.app", sha256_cert_fingerprints: ["FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C"] } }], { headers: { "Cache-Control": "public,max-age=3600" } });
}
