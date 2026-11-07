import { InstagramApiError, type InstagramClient } from './client.js';
import type { VideoHost, VideoShare } from './videoHost.js';

/**
 * `safeToRetry` is false only when Instagram may already have published the
 * reel (the publish call itself failed ambiguously) — retrying could double-post.
 */
export class PublishError extends Error {
  constructor(
    message: string,
    readonly safeToRetry: boolean,
  ) {
    super(message);
    this.name = 'PublishError';
  }
}

export type PublishInput = (LocalReel | LinkedReel) & {
  caption: string;
  onContainer?: (containerId: string) => Promise<void> | void;
};

/** Files on this Mac: shared (or uploaded) for the moment Instagram needs them. */
interface LocalReel {
  videoPath: string;
  /** The cover still (png). Without one Instagram picks a frame itself. */
  coverPath?: string | null;
}

/** Already at links Instagram can fetch — the cloud publisher's signed S3 links. */
interface LinkedReel {
  videoUrl: string;
  coverUrl?: string | null;
}

export interface PublishResult {
  mediaId: string;
  permalink: string | null;
}

export interface ReelPublisher {
  publish(input: PublishInput): Promise<PublishResult>;
}

/** Caches the account id; also answers "who are we connected as". */
export class InstagramAccount {
  private me: Promise<{ userId: string; username: string }> | null = null;

  constructor(readonly client: InstagramClient) {}

  info(): Promise<{ userId: string; username: string }> {
    this.me ??= this.client.me().catch((error: unknown) => {
      this.me = null;
      throw error;
    });
    return this.me;
  }

  async igId(): Promise<string> {
    return (await this.info()).userId;
  }
}

export interface InstagramPublisherOptions {
  pollMs?: number;
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class InstagramPublisher implements ReelPublisher {
  private readonly pollMs: number;
  private readonly maxWaitMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    readonly account: InstagramAccount,
    private readonly host: VideoHost | null,
    options: InstagramPublisherOptions = {},
  ) {
    this.pollMs = options.pollMs ?? 10_000;
    this.maxWaitMs = options.maxWaitMs ?? 10 * 60_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const client = this.account.client;
    let igId: string;
    try {
      igId = await this.account.igId();
    } catch (error: unknown) {
      throw new PublishError(`Instagram account: ${message(error)}`, true);
    }

    if ('videoUrl' in input) return this.publishLinked(igId, input);
    return client.uploadsDirectly ? this.publishByUpload(igId, input) : this.publishByUrl(igId, input);
  }

  /** Either kind of token: Instagram fetches both files from links it was handed. */
  private async publishLinked(igId: string, { videoUrl, coverUrl, caption, onContainer }: LinkedReel & PublishInput): Promise<PublishResult> {
    const client = this.account.client;
    const containerId = await client.createReel(igId, { videoUrl, caption, coverUrl: coverUrl ?? undefined }).catch((error: unknown) => {
      throw new PublishError(message(error), true);
    });
    await onContainer?.(containerId);
    return this.finish(igId, containerId);
  }

  /**
   * Facebook Login: the video is uploaded from disk. Only a cover needs a
   * public link, and only for the moment it takes Instagram to fetch it.
   */
  private async publishByUpload(igId: string, { videoPath, caption, coverPath, onContainer }: LocalReel & PublishInput): Promise<PublishResult> {
    const client = this.account.client;
    const cover = await this.shareCover(coverPath);
    try {
      const containerId = await client.createReelUpload(igId, { caption, coverUrl: cover?.url }).catch((error: unknown) => {
        throw new PublishError(message(error), true);
      });
      await onContainer?.(containerId);
      await client.uploadVideo(containerId, videoPath).catch((error: unknown) => {
        throw new PublishError(`Upload: ${message(error)}`, true);
      });
      return await this.finish(igId, containerId);
    } finally {
      await cover?.release();
    }
  }

  /** Instagram Login: Instagram fetches the video (and cover) from temporary public links. */
  private async publishByUrl(igId: string, { videoPath, caption, coverPath, onContainer }: LocalReel & PublishInput): Promise<PublishResult> {
    if (!this.host) throw new PublishError('No video host configured for Instagram Login tokens', false);
    const client = this.account.client;
    const share = await this.host.share(videoPath).catch((error: unknown) => {
      throw new PublishError(`Video link: ${message(error)}`, true);
    });
    let cover: VideoShare | null = null;
    try {
      cover = await this.shareCover(coverPath);
      const containerId = await client.createReel(igId, { videoUrl: share.url, caption, coverUrl: cover?.url }).catch((error: unknown) => {
        throw new PublishError(message(error), true);
      });
      await onContainer?.(containerId);
      return await this.finish(igId, containerId);
    } finally {
      await cover?.release();
      await share.release();
    }
  }

  /**
   * A cover that was asked for and cannot be shared stops the post rather than
   * letting it go out with whatever frame Instagram picks — nothing has been
   * sent yet, so it is safe to try again.
   */
  private async shareCover(coverPath: string | null | undefined): Promise<VideoShare | null> {
    if (!coverPath) return null;
    if (!this.host) throw new PublishError('No link host configured to send the cover', true);
    return this.host.share(coverPath).catch((error: unknown) => {
      throw new PublishError(`Cover link: ${message(error)}`, true);
    });
  }

  private async finish(igId: string, containerId: string): Promise<PublishResult> {
    const client = this.account.client;
    await this.waitUntilReady(containerId);
    let mediaId: string;
    try {
      mediaId = await client.publish(igId, containerId);
    } catch (error: unknown) {
      // A clear 4xx means Instagram refused; anything else (network, 5xx) might have gone through.
      const refused = error instanceof InstagramApiError && error.status >= 400 && error.status < 500;
      throw new PublishError(refused ? message(error) : `${message(error)} — check Instagram before retrying`, refused);
    }
    const permalink = await client.permalink(mediaId).catch(() => null);
    return { mediaId, permalink };
  }

  private async waitUntilReady(containerId: string): Promise<void> {
    const client = this.account.client;
    const deadline = Date.now() + this.maxWaitMs;
    for (;;) {
      const status = await client.containerStatus(containerId).catch((error: unknown) => {
        throw new PublishError(message(error), true);
      });
      if (status.code === 'FINISHED') return;
      if (status.code === 'ERROR' || status.code === 'EXPIRED') {
        throw new PublishError(`Instagram could not process the video: ${status.detail ?? status.code}`, true);
      }
      if (status.code === 'PUBLISHED') throw new PublishError('Container was already published', false);
      if (Date.now() > deadline) throw new PublishError('Instagram took too long to process the video', true);
      await this.sleep(this.pollMs);
    }
  }
}
