type Grant = { appId: string; ownerId: string; epoch: string; expiresAt: number };
const encoder = new TextEncoder();
const hex = (value: ArrayBuffer) => [...new Uint8Array(value)].map(byte => byte.toString(16).padStart(2, "0")).join("");
async function signingKey(secret: string) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
export async function issuePublisherGrant(grant: Omit<Grant, "expiresAt">, secret: string): Promise<string> {
  if (!secret) throw new Error("应用发布授权尚未配置");
  const payload = btoa(JSON.stringify({ ...grant, expiresAt: Date.now() + 7 * 86400000 }));
  const signature = hex(await crypto.subtle.sign("HMAC", await signingKey(secret), encoder.encode(payload)));
  return `zjh1.${payload}.${signature}`;
}
export async function readPublisherGrant(request: Request, secret: string): Promise<Grant | null> {
  const token = request.headers.get("Authorization")?.match(/^Bearer (zjh1\.[A-Za-z0-9+/=]+\.[a-f0-9]{64})$/)?.[1];
  if (!token || !secret) return null;
  try {
    const [, payload, signature] = token.split(".");
    const bytes = Uint8Array.from(signature.match(/../g)!, part => parseInt(part, 16));
    if (!await crypto.subtle.verify("HMAC", await signingKey(secret), bytes, encoder.encode(payload))) return null;
    const grant = JSON.parse(atob(payload)) as Grant;
    return /^[a-z][a-z0-9-]{0,63}$/.test(grant.appId) && typeof grant.ownerId === "string" && typeof grant.epoch === "string" && grant.expiresAt > Date.now() ? grant : null;
  } catch { return null; }
}
/** Session prompts/activities must never return a publisher capability to the phone. */
export function redactPublisherGrants(text: string): string {
  return text.replace(/zjh1\.[A-Za-z0-9+/=]+\.[a-f0-9]{64}/g, "[应用发布授权已隐藏]");
}
