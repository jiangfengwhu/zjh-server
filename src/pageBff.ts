import { authenticatedUser } from "./accounts";

/** Only host page reads are composed here. Writes keep their existing contracts. */
export async function pageBff(request: Request, env: Env): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (request.method !== "GET" || !["/v1/discovery", "/v1/me/works", "/v1/account-counts"].includes(url.pathname)) return;
  if (url.pathname === "/v1/account-counts") return env.POSTS.getByName("timeline").fetch(new Request("https://posts.internal/internal/account-counts", { headers: request.headers }));
  if (url.pathname === "/v1/discovery") {
    const params = new URLSearchParams(url.searchParams);
    params.set("limit", params.get("limit") || "24");
    const response = await env.WORKSHOP.getByName("dynamic").fetch(new Request(`https://workshop.internal/v1/market?${params}`));
    if (!response.ok) return response;
    const page = await response.json() as { applications: Array<{ manifest: { appId: string }; authorId?: string }> };
    try {
      const interactions = await env.POSTS.getByName("timeline").fetch(new Request("https://posts.internal/internal/application-interactions", { method: "POST", headers: request.headers, body: JSON.stringify({ applications: page.applications }) }));
      if (!interactions.ok) throw new Error("interactions unavailable");
      const { items } = await interactions.json() as { items: Array<{ appId: string; post: unknown; following: boolean }> };
      const byId = new Map(items.map(item => [item.appId, item]));
      return Response.json({ ...page, applications: page.applications.map(item => ({ ...item, discussion: byId.get(item.manifest.appId)?.post, authorFollowing: byId.get(item.manifest.appId)?.following })) }, { headers: { "Cache-Control": "private,no-store" } });
    } catch {
      // A social outage must not prevent playing published applications.
      return Response.json(page, { headers: { "Cache-Control": "private,no-store" } });
    }
  }
  const user = await authenticatedUser(request, env);
  if (!user) return Response.json({ message: "请先登录" }, { status: 401 });
  const params = new URLSearchParams(url.searchParams);
  params.set("view", "gallery"); params.set("limit", "24");
  const [works, summary] = await Promise.all([
    env.WORKSHOP.getByName("dynamic").fetch(new Request(`https://workshop.internal/v1/works?${params}`, { headers: request.headers })),
    env.POSTS.getByName("timeline").fetch(new Request(`https://posts.internal/v1/profiles/${user.id}?view=summary`, { headers: request.headers })),
  ]);
  if (!works.ok) return works;
  return Response.json({ ...await works.json() as object, summary: summary.ok ? await summary.json() : undefined }, { headers: { "Cache-Control": "private,no-store" } });
}
