/** One authenticated, hibernatable channel for account events; never send private bodies. */
export function sendLive(ctx: DurableObjectState, event: Record<string, unknown>, owner?: string, target?: WebSocket) {
  const payload = JSON.stringify(event);
  for (const socket of target ? [target] : ctx.getWebSockets(owner)) {
    try {
      const metadata = socket.deserializeAttachment() as { expiresAt?: number } | null;
      if (!metadata?.expiresAt || metadata.expiresAt <= Date.now()) socket.close(1000, "Reconnect");
      else socket.send(payload);
    } catch { try { socket.close(); } catch {} }
  }
}
export async function sendAccountLive(ctx: DurableObjectState, owner: string, type: string, extra: Record<string, unknown> = {}, target?: WebSocket) {
  if (!target && !ctx.getWebSockets(owner).length) return;
  // Snapshot counters and sequence together, so delayed HTTP/socket responses cannot roll them back.
  const snapshot = await ctx.storage.transaction(async storage => {
    const version = ((await storage.get<number>(`live-version:${owner}`)) ?? 0) + 1;
    await storage.put(`live-version:${owner}`, version);
    return { version, unreadCount: (await storage.get<number>(`dm-unread:${owner}`)) ?? 0,
      notificationCount: (await storage.get<number>(`notice-unread:${owner}`)) ?? 0,
      unreadByCategory: await storage.get(`notice-unread-categories:${owner}`) };
  });
  sendLive(ctx, { type, ...extra, ...snapshot }, owner, target);
}
