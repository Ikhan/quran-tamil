import { describe, expect, it, vi } from 'vitest';
import { InstagramApiError, type InstagramClient } from '../../server/instagram/client.js';
import { InstagramAccount, InstagramPublisher, PublishError } from '../../server/instagram/publisher.js';
import type { VideoHost } from '../../server/instagram/videoHost.js';

function setup(over: Partial<Record<keyof InstagramClient, unknown>> = {}, statuses = ['IN_PROGRESS', 'FINISHED']) {
  const release = vi.fn(async () => undefined);
  const host: VideoHost = { share: vi.fn(async () => ({ url: 'https://t.trycloudflare.com/v/x.mp4', release })) };
  const queue = [...statuses];
  const client = {
    me: vi.fn(async () => ({ userId: '1789', username: 'u' })),
    createReel: vi.fn(async () => 'c1'),
    containerStatus: vi.fn(async () => ({ code: queue.shift() ?? 'FINISHED', detail: 'Error: bad codec' })),
    publish: vi.fn(async () => 'm1'),
    permalink: vi.fn(async () => 'https://instagram.com/reel/x/'),
    ...over,
  } as unknown as InstagramClient;
  const publisher = new InstagramPublisher(new InstagramAccount(client), host, { pollMs: 1, sleep: async () => undefined });
  return { publisher, client, host, release };
}

describe('InstagramPublisher', () => {
  it('shares the video, waits for processing, publishes, and closes the link', async () => {
    const { publisher, client, release } = setup();
    const onContainer = vi.fn();
    expect(await publisher.publish({ videoPath: '/v.mp4', caption: 'Hi', onContainer })).toEqual({ mediaId: 'm1', permalink: 'https://instagram.com/reel/x/' });
    expect(client.createReel).toHaveBeenCalledWith('1789', { videoUrl: 'https://t.trycloudflare.com/v/x.mp4', caption: 'Hi' });
    expect(client.containerStatus).toHaveBeenCalledTimes(2);
    expect(onContainer).toHaveBeenCalledWith('c1');
    expect(release).toHaveBeenCalled();
  });

  it('reports processing errors as retryable and still closes the link', async () => {
    const { publisher, release } = setup({}, ['ERROR']);
    const err = await publisher.publish({ videoPath: '/v.mp4', caption: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect((err as PublishError).safeToRetry).toBe(true);
    expect((err as Error).message).toContain('bad codec');
    expect(release).toHaveBeenCalled();
  });

  it('marks an ambiguous publish failure as NOT safe to retry', async () => {
    const { publisher } = setup({ publish: vi.fn(async () => Promise.reject(new InstagramApiError('socket hang up', 0, null))) });
    const err = (await publisher.publish({ videoPath: '/v.mp4', caption: 'x' }).catch((e: unknown) => e)) as PublishError;
    expect(err.safeToRetry).toBe(false);
    expect(err.message).toContain('check Instagram');
  });

  it('treats a clear 4xx refusal on publish as retryable', async () => {
    const { publisher } = setup({ publish: vi.fn(async () => Promise.reject(new InstagramApiError('Rate limited', 400, 9))) });
    expect(((await publisher.publish({ videoPath: '/v.mp4', caption: 'x' }).catch((e: unknown) => e)) as PublishError).safeToRetry).toBe(true);
  });

  it('fails retryably when the video link cannot be created', async () => {
    const { publisher, host } = setup();
    vi.mocked(host.share).mockRejectedValueOnce(new Error('cloudflared not found'));
    await expect(publisher.publish({ videoPath: '/v.mp4', caption: 'x' })).rejects.toMatchObject({ safeToRetry: true, message: expect.stringContaining('cloudflared') });
  });

  it('fails retryably when the account cannot be read', async () => {
    const { publisher } = setup({ me: vi.fn(async () => Promise.reject(new Error('Invalid OAuth'))) });
    await expect(publisher.publish({ videoPath: '/v.mp4', caption: 'x' })).rejects.toMatchObject({ safeToRetry: true });
  });

  it('gives up when processing takes too long', async () => {
    const { client, host } = setup({}, Array(50).fill('IN_PROGRESS'));
    const p = new InstagramPublisher(new InstagramAccount(client), host, { pollMs: 1, maxWaitMs: -1, sleep: async () => undefined });
    await expect(p.publish({ videoPath: '/v.mp4', caption: 'x' })).rejects.toThrow(/too long/);
  });
});

describe('InstagramPublisher with direct upload (Facebook token)', () => {
  it('uploads the file instead of sharing a link', async () => {
    const client = {
      uploadsDirectly: true,
      me: vi.fn(async () => ({ userId: '1789', username: 'u' })),
      createReelUpload: vi.fn(async () => 'c1'),
      uploadVideo: vi.fn(async () => undefined),
      containerStatus: vi.fn(async () => ({ code: 'FINISHED', detail: null })),
      publish: vi.fn(async () => 'm1'),
      permalink: vi.fn(async () => null),
    } as unknown as InstagramClient;
    const p = new InstagramPublisher(new InstagramAccount(client), null, { sleep: async () => undefined });
    expect(await p.publish({ videoPath: '/v.mp4', caption: 'Hi' })).toEqual({ mediaId: 'm1', permalink: null });
    expect(client.createReelUpload).toHaveBeenCalledWith('1789', { caption: 'Hi' });
    expect(client.uploadVideo).toHaveBeenCalledWith('c1', '/v.mp4');
  });

  it('treats an upload failure as retryable', async () => {
    const client = {
      uploadsDirectly: true,
      me: vi.fn(async () => ({ userId: '1', username: 'u' })),
      createReelUpload: vi.fn(async () => 'c1'),
      uploadVideo: vi.fn(async () => Promise.reject(new Error('ProcessingFailedError'))),
    } as unknown as InstagramClient;
    const p = new InstagramPublisher(new InstagramAccount(client), null);
    await expect(p.publish({ videoPath: '/v.mp4', caption: 'x' })).rejects.toMatchObject({ safeToRetry: true, message: 'Upload: ProcessingFailedError' });
  });

  it('refuses Instagram-Login publishing without a video host', async () => {
    const client = { uploadsDirectly: false, me: vi.fn(async () => ({ userId: '1', username: 'u' })) } as unknown as InstagramClient;
    await expect(new InstagramPublisher(new InstagramAccount(client), null).publish({ videoPath: '/v.mp4', caption: 'x' })).rejects.toMatchObject({ safeToRetry: false });
  });
});

describe('InstagramPublisher covers', () => {
  it('sends the cover as a temporary link and releases both links', async () => {
    const { publisher, client, host, release } = setup();
    (host.share as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ url: 'https://t.trycloudflare.com/v/x.mp4', release })
      .mockResolvedValueOnce({ url: 'https://t.trycloudflare.com/v/c.png', release });
    await publisher.publish({ videoPath: '/v.mp4', coverPath: '/c.png', caption: 'Hi' });
    expect(host.share).toHaveBeenCalledWith('/c.png');
    expect(client.createReel).toHaveBeenCalledWith('1789', {
      videoUrl: 'https://t.trycloudflare.com/v/x.mp4',
      caption: 'Hi',
      coverUrl: 'https://t.trycloudflare.com/v/c.png',
    });
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('shares only the cover when the video is uploaded directly', async () => {
    const release = vi.fn(async () => undefined);
    const host: VideoHost = { share: vi.fn(async () => ({ url: 'https://t.trycloudflare.com/v/c.png', release })) };
    const client = {
      uploadsDirectly: true,
      me: vi.fn(async () => ({ userId: '1789', username: 'u' })),
      createReelUpload: vi.fn(async () => 'c1'),
      uploadVideo: vi.fn(async () => undefined),
      containerStatus: vi.fn(async () => ({ code: 'FINISHED', detail: null })),
      publish: vi.fn(async () => 'm1'),
      permalink: vi.fn(async () => null),
    } as unknown as InstagramClient;
    const p = new InstagramPublisher(new InstagramAccount(client), host, { sleep: async () => undefined });
    await p.publish({ videoPath: '/v.mp4', coverPath: '/c.png', caption: 'Hi' });
    expect(host.share).toHaveBeenCalledTimes(1);
    expect(client.createReelUpload).toHaveBeenCalledWith('1789', { caption: 'Hi', coverUrl: 'https://t.trycloudflare.com/v/c.png' });
    expect(release).toHaveBeenCalled();
  });

  it('stops before creating anything when the cover cannot be shared', async () => {
    const { publisher, client, host, release } = setup();
    (host.share as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ url: 'https://t.trycloudflare.com/v/x.mp4', release })
      .mockRejectedValueOnce(new Error('tunnel down'));
    await expect(publisher.publish({ videoPath: '/v.mp4', coverPath: '/c.png', caption: 'x' })).rejects.toMatchObject({
      safeToRetry: true,
      message: 'Cover link: tunnel down',
    });
    expect(client.createReel).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalled(); // the video link is still closed
  });
});
