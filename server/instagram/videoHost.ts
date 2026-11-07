import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

export interface VideoShare {
  url: string;
  release: () => Promise<void>;
}

/** Makes a local reel (or its cover still) reachable by Instagram's servers for the few minutes it takes to fetch it. */
export interface VideoHost {
  share(path: string): Promise<VideoShare>;
}

export interface Tunnel {
  url: string;
  stop: () => void;
}

export type StartTunnel = (port: number) => Promise<Tunnel>;

const TOKEN_RE = /^[a-f0-9]{48}$/;
/** The only kinds of file ever shared: the reel and its cover. */
const SHAREABLE = /\.(mp4|png)$/;
const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const TUNNEL_START_TIMEOUT_MS = 45_000;

/**
 * Cloudflare quick tunnel (no account needed) to a tiny server on 127.0.0.1
 * that serves nothing except videos registered under a random 48-hex token.
 * The dashboard itself is never exposed. The tunnel closes when the last share is released.
 */
export function cloudflaredTunnel(bin = 'cloudflared'): StartTunnel {
  return (port) =>
    new Promise((resolve, reject) => {
      const child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('cloudflared did not print a tunnel URL in time'));
      }, TUNNEL_START_TIMEOUT_MS);
      const onData = (chunk: Buffer) => {
        const match = TUNNEL_URL_RE.exec(chunk.toString());
        if (!match) return;
        clearTimeout(timer);
        resolve({ url: match[0], stop: () => child.kill() });
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(new Error(`Could not start cloudflared (${error.message}) — install it with: brew install cloudflared`));
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`cloudflared exited (code ${code}) before the tunnel was ready`));
      });
    });
}

export interface TunnelVideoHostOptions {
  startTunnel?: StartTunnel;
  /** How long to wait for the public URL to answer (new quick-tunnel hostnames take a few seconds to resolve). */
  readyTimeoutMs?: number;
  fetch?: typeof fetch;
}

export class TunnelVideoHost implements VideoHost {
  private readonly files = new Map<string, string>();
  private server: Server | null = null;
  private tunnel: Promise<Tunnel> | null = null;
  private readonly startTunnel: StartTunnel;
  private readonly readyTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TunnelVideoHostOptions = {}) {
    this.startTunnel = options.startTunnel ?? cloudflaredTunnel();
    this.readyTimeoutMs = options.readyTimeoutMs ?? 90_000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async share(path: string): Promise<VideoShare> {
    const ext = SHAREABLE.exec(path)?.[0];
    if (!ext) throw new Error('Only .mp4 and .png files can be shared');
    const token = randomBytes(24).toString('hex');
    this.files.set(token, path);
    try {
      const port = await this.listen();
      this.tunnel ??= this.startTunnel(port);
      const { url: base } = await this.tunnel;
      const url = `${base}/v/${token}${ext}`;
      await this.waitUntilReachable(url);
      return { url, release: () => this.release(token) };
    } catch (error: unknown) {
      await this.release(token);
      throw error;
    }
  }

  async close(): Promise<void> {
    this.files.clear();
    await this.stopTunnel();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = null;
  }

  private async release(token: string): Promise<void> {
    this.files.delete(token);
    if (this.files.size === 0) await this.stopTunnel();
  }

  private async stopTunnel(): Promise<void> {
    const pending = this.tunnel;
    this.tunnel = null;
    if (pending) (await pending.catch(() => null))?.stop();
  }

  private async listen(): Promise<number> {
    if (!this.server) {
      const app = express();
      app.disable('x-powered-by');
      app.get('/v/:file', (req, res) => {
        const ext = SHAREABLE.exec(req.params.file)?.[0] ?? '';
        const token = req.params.file.slice(0, req.params.file.length - ext.length);
        const path = ext && TOKEN_RE.test(token) ? this.files.get(token) : undefined;
        // The extension asked for must be the file's own: a token is not a way
        // to fetch a file under a type it is not.
        if (!path || !path.endsWith(ext)) {
          res.sendStatus(404);
          return;
        }
        res.type(ext === '.png' ? 'image/png' : 'video/mp4').sendFile(path, (error) => {
          if (error && !res.headersSent) res.sendStatus(404);
        });
      });
      app.use((_req, res) => {
        res.sendStatus(404);
      });
      const server = app.listen(0, '127.0.0.1');
      await new Promise<void>((resolve, reject) => server.once('listening', resolve).once('error', reject));
      this.server = server;
    }
    return (this.server.address() as AddressInfo).port;
  }

  private async waitUntilReachable(url: string): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs;
    for (;;) {
      try {
        const res = await this.fetchImpl(url, { method: 'HEAD' });
        if (res.ok) return;
      } catch {
        /* DNS for a new tunnel can take a moment */
      }
      if (Date.now() > deadline) throw new Error('The temporary video link never became reachable');
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}
