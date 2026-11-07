import { describe, expect, it, vi } from 'vitest';
import { InstagramApiError, InstagramClient } from '../../server/instagram/client.js';

const TOKEN = 'IGAAsecret123';

function fakeFetch(routes: Record<string, unknown>, status = 200) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? 'GET'} ${url.pathname}`;
    const body = routes[key];
    if (body === undefined) throw new Error(`unexpected ${key}`);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
}

const client = (fetchImpl: unknown) => new InstagramClient({ token: async () => TOKEN, version: 'v27.0', fetch: fetchImpl as typeof fetch });

describe('InstagramClient', () => {
  it('reads the account', async () => {
    const f = fakeFetch({ 'GET /v27.0/me': { user_id: '1789', username: 'islamic_baby_names_101' } });
    expect(await client(f).me()).toEqual({ userId: '1789', username: 'islamic_baby_names_101' });
    const url = new URL(String(f.mock.calls[0][0]));
    expect(url.searchParams.get('fields')).toBe('user_id,username');
    expect(url.searchParams.get('access_token')).toBe(TOKEN);
  });

  it('creates a reel container with the video url and caption', async () => {
    const f = fakeFetch({ 'POST /v27.0/1789/media': { id: 'c1' } });
    expect(await client(f).createReel('1789', { videoUrl: 'https://x.trycloudflare.com/v/abc.mp4', caption: 'Hi' })).toBe('c1');
    const body = new URLSearchParams(String(f.mock.calls[0][1]?.body));
    expect(body.get('media_type')).toBe('REELS');
    expect(body.get('video_url')).toBe('https://x.trycloudflare.com/v/abc.mp4');
    expect(body.get('caption')).toBe('Hi');
    expect(body.get('share_to_feed')).toBe('true');
    expect(body.get('cover_url')).toBeNull(); // not set → Instagram picks a frame
    expect(body.get('access_token')).toBe(TOKEN);
  });

  it('reads container status, publishes, and fetches the permalink', async () => {
    const f = fakeFetch({
      'GET /v27.0/c1': { status_code: 'FINISHED', status: 'Finished: Media has been uploaded' },
      'POST /v27.0/1789/media_publish': { id: 'm1' },
      'GET /v27.0/m1': { permalink: 'https://www.instagram.com/reel/abc/' },
    });
    const c = client(f);
    expect(await c.containerStatus('c1')).toEqual({ code: 'FINISHED', detail: 'Finished: Media has been uploaded' });
    expect(await c.publish('1789', 'c1')).toBe('m1');
    expect(await c.permalink('m1')).toBe('https://www.instagram.com/reel/abc/');
  });

  it('reads the publishing quota', async () => {
    const f = fakeFetch({ 'GET /v27.0/1789/content_publishing_limit': { data: [{ quota_usage: 3, config: { quota_total: 100 } }] } });
    expect(await client(f).publishingLimit('1789')).toEqual({ used: 3, total: 100 });
  });

  it('refreshes a long-lived token (unversioned endpoint)', async () => {
    const f = fakeFetch({ 'GET /refresh_access_token': { access_token: 'IGAAnew', expires_in: 5184000 } });
    expect(await client(f).refreshToken(TOKEN)).toEqual({ token: 'IGAAnew', expiresInSec: 5184000 });
    expect(new URL(String(f.mock.calls[0][0])).searchParams.get('grant_type')).toBe('ig_refresh_token');
  });

  it('turns API errors into InstagramApiError without leaking the token', async () => {
    const f = fakeFetch({ 'GET /v27.0/me': { error: { message: `Invalid OAuth access token ${TOKEN}`, code: 190 } } }, 400);
    const err = await client(f).me().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InstagramApiError);
    expect((err as InstagramApiError).code).toBe(190);
    expect((err as Error).message).not.toContain(TOKEN);
    expect((err as Error).message).toContain('Invalid OAuth access token');
  });

  it('wraps network failures', async () => {
    const f = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(client(f as unknown as typeof fetch).me()).rejects.toThrow(/Could not reach Instagram/);
  });
});

describe('InstagramClient with a Facebook (EAA…) token', () => {
  const FB = 'EAAsecret';
  const fb = (f: unknown, igUserId: string | null = null) =>
    new InstagramClient({ token: async () => FB, login: 'facebook', igUserId, version: 'v24.0', fetch: f as typeof fetch });

  it('detects the login kind from the token', async () => {
    const { loginKindOf } = await import('../../server/instagram/client.js');
    expect(loginKindOf('EAAd123')).toBe('facebook');
    expect(loginKindOf('IGAA123')).toBe('instagram');
  });

  it('finds the Instagram account through a linked Page', async () => {
    const f = fakeFetch({
      'GET /v24.0/me/accounts': { data: [{}, { instagram_business_account: { id: '1789' } }] },
      'GET /v24.0/1789': { id: '1789', username: 'islamic_baby_names_101' },
    });
    const c = fb(f);
    expect(c.uploadsDirectly).toBe(true);
    expect(await c.me()).toEqual({ userId: '1789', username: 'islamic_baby_names_101' });
    expect(String(f.mock.calls[0][0])).toContain('https://graph.facebook.com/');
  });

  it('uses INSTAGRAM_USER_ID when given, and explains when no account is visible', async () => {
    const f = fakeFetch({ 'GET /v24.0/42': { id: '42', username: 'u' } });
    expect(await fb(f, '42').me()).toEqual({ userId: '42', username: 'u' });
    const none = fakeFetch({ 'GET /v24.0/me/accounts': { data: [] } });
    await expect(fb(none).me()).rejects.toThrow(/can’t see any Instagram account/);
  });

  it('creates a resumable reel container and uploads the file with OAuth headers', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const path = join(mkdtempSync(join(tmpdir(), 'up-')), 'r.mp4');
    writeFileSync(path, 'twelve bytes');
    const f = fakeFetch({ 'POST /v24.0/1789/media': { id: 'c9' }, 'POST /ig-api-upload/v24.0/c9': { success: true, message: 'Upload successful.' } });
    const c = fb(f);
    expect(await c.createReelUpload('1789', { caption: 'Hi', coverUrl: 'https://x.trycloudflare.com/v/c.png' })).toBe('c9');
    const create = new URLSearchParams(String(f.mock.calls[0][1]?.body));
    expect(create.get('cover_url')).toBe('https://x.trycloudflare.com/v/c.png');
    expect(create.get('upload_type')).toBe('resumable');
    expect(create.get('video_url')).toBeNull();
    await c.uploadVideo('c9', path);
    const [url, init] = f.mock.calls[1];
    expect(String(url)).toBe('https://rupload.facebook.com/ig-api-upload/v24.0/c9');
    expect(init?.headers).toEqual({ Authorization: `OAuth ${FB}`, offset: '0', file_size: '12' });
  });

  it('reports upload failures without the token', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const path = join(mkdtempSync(join(tmpdir(), 'up-')), 'r.mp4');
    writeFileSync(path, 'x');
    const f = fakeFetch({ 'POST /ig-api-upload/v24.0/c9': { debug_info: { retriable: false, type: 'ProcessingFailedError', message: `bad file ${FB}` } } }, 400);
    const err = (await fb(f).uploadVideo('c9', path).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe('bad file [token]');
    const down = vi.fn(async () => Promise.reject(new TypeError('fetch failed')));
    await expect(fb(down).uploadVideo('c9', path)).rejects.toThrow(/Could not upload the video/);
  });
});

describe('detectLoginKind', () => {
  const answer = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('calls a token Instagram Login when graph.instagram.com accepts it, whatever its prefix', async () => {
    const { detectLoginKind } = await import('../../server/instagram/client.js');
    const f = answer(200, { user_id: '17841438500847598', username: 'ilmul_quran_tamil' });
    expect(await detectLoginKind('EAAUnified', 'v24.0', f)).toBe('instagram');
    const [url] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toMatch(/^https:\/\/graph\.instagram\.com\/v24\.0\/me\?/);
  });

  it('falls back to Facebook Login when Instagram refuses the token', async () => {
    const { detectLoginKind } = await import('../../server/instagram/client.js');
    expect(await detectLoginKind('EAABusiness', 'v24.0', answer(400, { error: { message: 'Invalid OAuth access token', code: 190 } }))).toBe('facebook');
  });

  it('falls back to the prefix when Instagram cannot be reached', async () => {
    const { detectLoginKind } = await import('../../server/instagram/client.js');
    const down = vi.fn(async () => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    expect(await detectLoginKind('EAAx', 'v24.0', down)).toBe('facebook');
    expect(await detectLoginKind('IGAAx', 'v24.0', down)).toBe('instagram');
  });
});
