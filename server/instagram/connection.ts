import type { InstagramConnection } from '../posts/types.js';
import type { InstagramAccount } from './publisher.js';

const CACHE_MS = 5 * 60_000;

/** "Connected as @x · 3/100 posts today", cached so the Schedule page doesn't hit Instagram on every poll. */
export function connectionStatus(account: InstagramAccount | null, now: () => number = Date.now): () => Promise<InstagramConnection> {
  let cached: { at: number; value: InstagramConnection } | null = null;
  return async () => {
    if (!account) return { configured: false, username: null, error: null, quota: null };
    if (cached && now() - cached.at < CACHE_MS) return cached.value;
    let value: InstagramConnection;
    try {
      const me = await account.info();
      const quota = await account.client.publishingLimit(me.userId).catch(() => null);
      value = { configured: true, username: me.username, error: null, quota };
    } catch (error: unknown) {
      value = { configured: true, username: null, error: error instanceof Error ? error.message : String(error), quota: null };
    }
    cached = { at: now(), value };
    return value;
  };
}
