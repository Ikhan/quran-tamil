import { describe, expect, it, vi } from 'vitest';
import { connectionStatus } from '../../server/instagram/connection.js';
import { InstagramAccount } from '../../server/instagram/publisher.js';
import type { InstagramClient } from '../../server/instagram/client.js';

describe('connectionStatus', () => {
  it('reports not configured without an account', async () => {
    expect(await connectionStatus(null)()).toEqual({ configured: false, username: null, error: null, quota: null });
  });

  it('reports the username and quota, cached for 5 minutes', async () => {
    const me = vi.fn(async () => ({ userId: '1', username: 'islamic_baby_names_101' }));
    const client = { me, publishingLimit: vi.fn(async () => ({ used: 2, total: 100 })) } as unknown as InstagramClient;
    let t = 0;
    const status = connectionStatus(new InstagramAccount(client), () => t);
    expect(await status()).toEqual({ configured: true, username: 'islamic_baby_names_101', error: null, quota: { used: 2, total: 100 } });
    t = 60_000;
    await status();
    expect(client.publishingLimit).toHaveBeenCalledTimes(1);
  });

  it('surfaces token problems', async () => {
    const client = { me: vi.fn(async () => Promise.reject(new Error('Error validating access token'))) } as unknown as InstagramClient;
    expect(await connectionStatus(new InstagramAccount(client))()).toMatchObject({ configured: true, username: null, error: 'Error validating access token' });
  });
});
