import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TunnelVideoHost } from '../../server/instagram/videoHost.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'vh-'));
  const video = join(dir, 'reel.mp4');
  writeFileSync(video, 'fake-mp4-bytes');
  let localBase = '';
  const stop = vi.fn();
  // "Tunnel" that just points at the local server, so the test can fetch the public URL.
  const startTunnel = vi.fn(async (port: number) => {
    localBase = `http://127.0.0.1:${port}`;
    return { url: localBase, stop };
  });
  const host = new TunnelVideoHost({ startTunnel, readyTimeoutMs: 2000 });
  return { host, video, startTunnel, stop, base: () => localBase };
}

describe('TunnelVideoHost', () => {
  it('serves a shared video at an unguessable URL until released', async () => {
    const { host, video, stop, base } = setup();
    const share = await host.share(video);
    expect(share.url).toMatch(/\/v\/[a-f0-9]{48}\.mp4$/);
    const res = await fetch(share.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('video/mp4');
    expect(await res.text()).toBe('fake-mp4-bytes');

    expect((await fetch(`${base()}/v/${'0'.repeat(48)}.mp4`)).status).toBe(404);
    expect((await fetch(`${base()}/`)).status).toBe(404);

    await share.release();
    expect(stop).toHaveBeenCalled();
    await host.close();
  });

  it('serves a cover still as a png, and only under its own extension', async () => {
    const { host, video } = setup();
    const cover = join(mkdtempSync(join(tmpdir(), 'vh-')), 'cover.png');
    writeFileSync(cover, 'fake-png');
    const [c, v] = [await host.share(cover), await host.share(video)];
    expect(c.url).toMatch(/\/v\/[a-f0-9]{48}\.png$/);
    const res = await fetch(c.url);
    expect(res.headers.get('content-type')).toContain('image/png');
    expect(await res.text()).toBe('fake-png');
    expect((await fetch(c.url.replace(/\.png$/, '.mp4'))).status).toBe(404);
    expect((await fetch(v.url.replace(/\.mp4$/, '.png'))).status).toBe(404);
    await c.release();
    await v.release();
    await host.close();
  });

  it('refuses to share anything but a reel or a cover', async () => {
    const { host } = setup();
    await expect(host.share('/etc/passwd')).rejects.toThrow(/Only .mp4 and .png/);
    await host.close();
  });

  it('reuses one tunnel for overlapping shares', async () => {
    const { host, video, startTunnel, stop } = setup();
    const a = await host.share(video);
    const b = await host.share(video);
    expect(startTunnel).toHaveBeenCalledTimes(1);
    await a.release();
    expect(stop).not.toHaveBeenCalled();
    await b.release();
    expect(stop).toHaveBeenCalledTimes(1);
    await host.close();
  });

  it('fails clearly when the tunnel cannot start', async () => {
    const host = new TunnelVideoHost({ startTunnel: async () => Promise.reject(new Error('cloudflared not found')) });
    const dir = mkdtempSync(join(tmpdir(), 'vh-'));
    writeFileSync(join(dir, 'a.mp4'), 'x');
    await expect(host.share(join(dir, 'a.mp4'))).rejects.toThrow(/cloudflared not found/);
    await host.close();
  });
});

describe('cloudflaredTunnel (fake binary, no network)', () => {
  const script = (body: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'cf-'));
    const bin = join(dir, 'cloudflared');
    writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return bin;
  };

  it('reads the quick-tunnel URL from cloudflared output', async () => {
    const { cloudflaredTunnel } = await import('../../server/instagram/videoHost.js');
    const tunnel = await cloudflaredTunnel(script('echo "INF |  https://brave-cat-12.trycloudflare.com  |" >&2; sleep 5'))(1234);
    expect(tunnel.url).toBe('https://brave-cat-12.trycloudflare.com');
    tunnel.stop();
  });

  it('fails when cloudflared exits early or is missing', async () => {
    const { cloudflaredTunnel } = await import('../../server/instagram/videoHost.js');
    await expect(cloudflaredTunnel(script('exit 3'))(1)).rejects.toThrow(/exited \(code 3\)/);
    await expect(cloudflaredTunnel('/nonexistent/cloudflared')(1)).rejects.toThrow(/brew install cloudflared/);
  });
});
