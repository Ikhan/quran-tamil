import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenStore } from '../../server/instagram/tokenStore.js';

const DAY = 86_400_000;
const file = () => join(mkdtempSync(join(tmpdir(), 'tok-')), 'instagram-token.json');

describe('TokenStore', () => {
  it('starts from the .env token', async () => {
    const s = new TokenStore(file(), 'IGAAenv', vi.fn());
    expect(await s.get()).toBe('IGAAenv');
  });

  it('refreshes when the token is a week old and saves it privately', async () => {
    const path = file();
    const refresh = vi.fn(async () => ({ token: 'IGAAnew', expiresInSec: 60 * 86400 }));
    const t0 = new Date('2026-11-01T00:00:00Z');
    const s = new TokenStore(path, 'IGAAenv', refresh);
    await s.refreshIfDue(t0); // first sighting: records it, no refresh
    expect(refresh).not.toHaveBeenCalled();
    await s.refreshIfDue(new Date(t0.getTime() + 8 * DAY));
    expect(refresh).toHaveBeenCalledWith('IGAAenv');
    expect(await s.get()).toBe('IGAAnew');
    expect(JSON.parse(readFileSync(path, 'utf8')).access_token).toBe('IGAAnew');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // a fresh store reading the same file keeps the refreshed token
    expect(await new TokenStore(path, 'IGAAenv', refresh).get()).toBe('IGAAnew');
  });

  it('switches to a new token pasted into .env', async () => {
    const path = file();
    const refresh = vi.fn(async () => ({ token: 'IGAArefreshed', expiresInSec: 1 }));
    const s = new TokenStore(path, 'IGAAold', refresh);
    await s.refreshIfDue(new Date('2026-11-01T00:00:00Z'));
    await s.refreshIfDue(new Date('2026-11-10T00:00:00Z'));
    expect(await new TokenStore(path, 'IGAApasted', refresh).get()).toBe('IGAApasted');
  });

  it('keeps the old token if refreshing fails', async () => {
    const s = new TokenStore(file(), 'IGAAenv', vi.fn(async () => Promise.reject(new Error('nope'))));
    await s.refreshIfDue(new Date('2026-11-01T00:00:00Z'));
    await expect(s.refreshIfDue(new Date('2026-11-20T00:00:00Z'))).rejects.toThrow('nope');
    expect(await s.get()).toBe('IGAAenv');
  });
});
