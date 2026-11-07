/**
 * The posting queue: what goes out to Instagram, and when.
 *
 * Checked once a minute; at most one post is in flight at a time. A post that
 * fails in a way Instagram cannot have acted on is retried a few times; one
 * that may already have gone out (the publish call itself failed ambiguously)
 * is marked failed for a person to check, because a retry could post the same
 * verse twice.
 *
 * Two ways to run it:
 * - Local: publishing runs on this Mac, so the queue only moves while the
 *   server is up. A post missed by more than a few hours (lid closed, server
 *   stopped) moves to the next free slot rather than firing in a burst later.
 * - AWS (`remote` given): the queue is in DynamoDB, each post's files go to S3
 *   when it is scheduled, and an EventBridge alarm runs the cloud publisher at
 *   its time — with this Mac off. This class then only edits the queue and
 *   sets alarms; `server/cloud/publishPost.ts` does the publishing.
 */
import { randomUUID } from "node:crypto";
import { PublishError, type ReelPublisher } from "../instagram/publisher.js";
import { coverPath, locateReel, type ReelFile } from "./reelFiles.js";
import { ACTIVE, nextFreeSlots, takenTimes } from "./slots.js";
import type { RemotePublishing } from "../cloud/remote.js";
import type { PostPatch, PostsStore } from "./store.js";
import type { PostEntry, ScheduleSettings } from "./types.js";

export class PostError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "PostError";
  }
}

export interface PostServiceDeps {
  store: PostsStore;
  /** null until Instagram is connected — posts then queue up and wait. Unused in AWS mode. */
  publisher: ReelPublisher | null;
  /** AWS mode: alarms and the cloud publisher instead of the minute tick. */
  remote?: RemotePublishing | null;
  /** AWS mode: a post "publishing" this long was cut off (the Lambda stops at 15 min). */
  staleAfterMs?: number;
  locate?: (relative: string) => Promise<ReelFile | null>;
  now?: () => Date;
  retryDelayMs?: number;
  maxAttempts?: number;
  missedAfterMs?: number;
  log?: Pick<Console, "info" | "error">;
}

export interface ScheduleRequest {
  reel: string;
  caption: string;
  scheduledAt?: string;
  now?: boolean;
}

export interface QueueableReel {
  file: string;
  reference: string;
  cover: string | null;
  caption: string | null;
  /** The live post holding this reel, if any. */
  post: Pick<PostEntry, "id" | "status" | "scheduled_at"> | null;
}

export interface ScheduleManyResult {
  scheduled: PostEntry[];
  skipped: Array<{ reel: string; reason: string }>;
}

const STALE_ERROR = "The publisher stopped mid-post — check Instagram before retrying";
const EDITABLE = new Set<PostEntry["status"]>(["scheduled", "failed"]);

const byTime = (a: PostEntry, b: PostEntry) => a.scheduled_at.localeCompare(b.scheduled_at);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class PostService {
  private seq = 0;
  private running: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => Date;
  private readonly locate: (relative: string) => Promise<ReelFile | null>;
  private readonly retryDelayMs: number;
  private readonly maxAttempts: number;
  private readonly missedAfterMs: number;
  private readonly log: Pick<Console, "info" | "error">;
  private readonly remote: RemotePublishing | null;

  constructor(private readonly deps: PostServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.locate = deps.locate ?? locateReel;
    this.retryDelayMs = deps.retryDelayMs ?? 15 * 60_000;
    this.maxAttempts = deps.maxAttempts ?? 3;
    this.missedAfterMs = deps.missedAfterMs ?? 6 * 3_600_000;
    this.log = deps.log ?? console;
    this.remote = deps.remote ?? null;
  }

  /** Where posts are published from, for the dashboard. */
  get backend(): "aws" | "local" {
    return this.remote ? "aws" : "local";
  }

  get connected(): boolean {
    return this.remote !== null || this.deps.publisher !== null;
  }

  async list(): Promise<PostEntry[]> {
    const posts = await this.deps.store.list();
    const settled = this.remote ? await this.settleStale(posts) : posts;
    return [...settled].sort(byTime);
  }

  /**
   * A cloud publish that never reported back (the Lambda timed out or was
   * killed) may or may not have reached Instagram — so it becomes failed, for
   * a person to check, exactly like a restart mid-publish on the Mac.
   */
  private async settleStale(posts: readonly PostEntry[]): Promise<PostEntry[]> {
    const cutoff = this.now().getTime() - (this.deps.staleAfterMs ?? 20 * 60_000);
    return Promise.all(
      posts.map(async (p) => {
        if (p.status !== "publishing" || Date.parse(p.updated_at) > cutoff) return p;
        const settled = await this.deps.store.claim(
          p.id,
          { status: ["publishing"], updatedAt: p.updated_at },
          { status: "failed", error: STALE_ERROR, claim_token: null }
        );
        return settled ?? (await this.deps.store.get(p.id)) ?? p;
      })
    );
  }

  settings(): Promise<ScheduleSettings> {
    return this.deps.store.settings();
  }

  saveSettings(settings: ScheduleSettings): Promise<ScheduleSettings> {
    return this.deps.store.saveSettings(settings);
  }

  /** One reel: at a chosen time, the next free slot, or right now. */
  async schedule(request: ScheduleRequest): Promise<PostEntry> {
    if (request.now && !this.connected) {
      throw new PostError(503, "Instagram is not connected yet");
    }
    if (request.now && !this.remote && this.running) {
      throw new PostError(409, "Another post is being published — try again in a minute");
    }
    const posts = await this.deps.store.list();
    const reel = await this.usableReel(request.reel, posts);

    let when: Date;
    if (request.now) {
      when = this.now();
    } else if (request.scheduledAt) {
      when = new Date(request.scheduledAt);
      if (when.getTime() <= this.now().getTime()) {
        throw new PostError(400, "Pick a time in the future");
      }
    } else {
      when = nextFreeSlots(await this.settings(), takenTimes(posts), this.now(), 1)[0];
    }

    const post = await this.create(reel, request.caption, when, !request.now);
    return request.now ? this.publishNow(post.id) : post;
  }

  /**
   * A batch's reels into consecutive free slots, in the order given — which
   * is mushaf order, the order the posts should go out. An item without a
   * caption takes the one its batch wrote beside the reel. A reel that is
   * missing, already queued or has no caption at all is skipped and reported
   * rather than failing the rest.
   */
  async scheduleMany(items: ReadonlyArray<{ reel: string; caption?: string }>): Promise<ScheduleManyResult> {
    const posts = await this.deps.store.list();
    const usable: Array<{ reel: ReelFile; caption: string }> = [];
    const skipped: ScheduleManyResult["skipped"] = [];
    const seen = new Set<string>();

    for (const item of items) {
      if (seen.has(item.reel)) {
        skipped.push({ reel: item.reel, reason: "Listed twice" });
        continue;
      }
      seen.add(item.reel);
      try {
        const reel = await this.usableReel(item.reel, posts);
        const caption = item.caption ?? reel.caption;
        if (!caption) {
          skipped.push({ reel: item.reel, reason: "No caption — write one first" });
          continue;
        }
        usable.push({ reel, caption });
      } catch (error: unknown) {
        if (!(error instanceof PostError)) throw error;
        skipped.push({ reel: item.reel, reason: error.message });
      }
    }

    const slots = nextFreeSlots(await this.settings(), takenTimes(posts), this.now(), usable.length);
    const scheduled: PostEntry[] = [];
    for (const [i, item] of usable.entries()) {
      scheduled.push(await this.create(item.reel, item.caption, slots[i]));
    }
    return { scheduled, skipped };
  }

  /**
   * Every rendered reel with what the queue knows about it, newest first —
   * what the Schedule tab offers to queue.
   */
  async reels(files: readonly string[]): Promise<QueueableReel[]> {
    const posts = await this.deps.store.list();
    const found = await Promise.all(files.map((f) => this.locate(f)));
    return found
      .filter((r): r is ReelFile => r !== null)
      .map((r) => {
        const post =
          posts.find((p) => p.reel_file === r.relative && ACTIVE.has(p.status)) ?? null;
        return {
          file: r.relative,
          reference: r.reference,
          cover: r.cover,
          caption: r.caption,
          post: post ? { id: post.id, status: post.status, scheduled_at: post.scheduled_at } : null,
        };
      });
  }

  async update(id: string, patch: { caption?: string; scheduledAt?: string }): Promise<PostEntry> {
    const post = await this.editable(id);
    if (patch.scheduledAt && new Date(patch.scheduledAt).getTime() <= this.now().getTime()) {
      throw new PostError(400, "Pick a time in the future");
    }
    // A new time on a failed post is how it is put back in the queue.
    const reschedule = patch.scheduledAt
      ? {
          scheduled_at: new Date(patch.scheduledAt).toISOString(),
          status: "scheduled" as const,
          error: null,
          attempts: 0,
        }
      : {};
    const updated = await this.stillEditable(post.id, {
      ...(patch.caption ? { caption: patch.caption } : {}),
      ...reschedule,
    });
    if (this.remote && patch.scheduledAt) {
      await this.remote.disarm(post.id);
      return this.armOrFail(updated);
    }
    return updated;
  }

  async cancel(id: string): Promise<PostEntry> {
    const post = await this.editable(id);
    if (this.remote) await this.remote.disarm(post.id);
    const canceled = await this.stillEditable(post.id, { status: "canceled" });
    if (this.remote) await this.discardFiles(canceled);
    return canceled;
  }

  /** Post right away — also how a failed post is retried. Runs in the background. */
  async publishNow(id: string): Promise<PostEntry> {
    const post = await this.editable(id);
    if (this.remote) return this.publishInCloud(post, this.remote);
    if (!this.deps.publisher) throw new PostError(503, "Instagram is not connected yet");
    if (this.running) {
      throw new PostError(409, "Another post is being published — try again in a minute");
    }
    const marked = (await this.deps.store.update(post.id, { status: "publishing", error: null }))!;
    this.running = this.run(marked).finally(() => (this.running = null));
    return marked;
  }

  /**
   * The dashboard claims the post (so the page shows it posting at once) and
   * hands the Lambda the claim token; only that invocation may publish it.
   */
  private async publishInCloud(post: PostEntry, remote: RemotePublishing): Promise<PostEntry> {
    const token = randomUUID();
    const claimed = await this.deps.store.claim(
      post.id,
      { status: ["scheduled", "failed"], updatedAt: post.updated_at },
      { status: "publishing", claim_token: token, error: null }
    );
    if (!claimed) throw new PostError(409, "This post changed meanwhile — refresh and try again");
    // Tidy only: an alarm left behind finds the post no longer scheduled at its time.
    await remote.disarm(post.id).catch((e: unknown) => this.log.error(`[schedule] disarm ${post.id}:`, e));
    try {
      await remote.invoke({ postId: post.id, claim: token });
    } catch (error: unknown) {
      // Nothing was sent to Instagram: put the post back as it was.
      await this.deps.store.update(post.id, {
        status: post.status,
        claim_token: null,
        error: `Could not start the publisher: ${message(error)}`,
      });
      if (post.status === "scheduled") await this.armOrFail({ ...post, status: "scheduled" });
      throw new PostError(502, `Could not start the publisher: ${message(error)}`);
    }
    return claimed;
  }

  /** Called every minute: re-slot missed posts, then publish at most one due post. */
  async tick(): Promise<void> {
    if (this.running || this.remote) return;
    const settings = await this.settings();
    if (settings.paused || !this.deps.publisher) return;
    await this.reslotMissed(settings);
    const now = this.now().getTime();
    const due = (await this.list()).find(
      (p) => p.status === "scheduled" && Date.parse(p.scheduled_at) <= now
    );
    if (!due) return;
    const marked = (await this.deps.store.update(due.id, { status: "publishing", error: null }))!;
    this.running = this.run(marked).finally(() => (this.running = null));
    await this.running;
  }

  /** Resolves when the current publish, if any, finishes. */
  async idle(): Promise<void> {
    await this.running;
  }

  start(intervalMs = 60_000): void {
    this.stop();
    if (this.remote) return; // the alarms do it
    this.timer = setInterval(() => {
      this.tick().catch((error: unknown) => this.log.error("[schedule] tick failed:", error));
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async run(post: PostEntry): Promise<void> {
    const attempts = post.attempts + 1;
    await this.deps.store.update(post.id, { attempts });
    try {
      const reel = await this.locate(post.reel_file);
      if (!reel) throw new PublishError("The reel file is missing — render it again", false);
      // The cover named in the queue is re-checked rather than trusted, and a
      // cover made after the post was queued is picked up.
      const cover = coverPath(reel.cover ?? post.cover_file);
      const result = await this.deps.publisher!.publish({
        videoPath: reel.absolute,
        coverPath: cover,
        caption: post.caption,
        onContainer: async (containerId) =>
          void (await this.deps.store.update(post.id, { container_id: containerId })),
      });
      await this.deps.store.update(post.id, {
        status: "posted",
        media_id: result.mediaId,
        permalink: result.permalink,
        posted_at: this.now().toISOString(),
        error: null,
      });
      this.log.info(`[schedule] posted ${post.reference} → ${result.permalink ?? result.mediaId}`);
    } catch (error: unknown) {
      const msg = message(error);
      const retry =
        (!(error instanceof PublishError) || error.safeToRetry) && attempts < this.maxAttempts;
      this.log.error(`[schedule] posting ${post.reference} failed (attempt ${attempts}): ${msg}`);
      await this.deps.store.update(
        post.id,
        retry
          ? {
              status: "scheduled",
              scheduled_at: new Date(this.now().getTime() + this.retryDelayMs).toISOString(),
              error: `Attempt ${attempts} failed: ${msg} — retrying`,
            }
          : { status: "failed", error: msg }
      );
    }
  }

  private async reslotMissed(settings: ScheduleSettings): Promise<void> {
    const now = this.now();
    const posts = await this.list();
    const missed = posts.filter(
      (p) => p.status === "scheduled" && now.getTime() - Date.parse(p.scheduled_at) > this.missedAfterMs
    );
    if (missed.length === 0) return;
    const others = posts.filter((p) => !missed.includes(p));
    const slots = nextFreeSlots(settings, takenTimes(others), now, missed.length);
    for (const [i, p] of missed.entries()) {
      await this.deps.store.update(p.id, {
        scheduled_at: slots[i].toISOString(),
        error: "Missed while the server was off — moved to the next free slot",
      });
    }
  }

  private async usableReel(relative: string, posts: readonly PostEntry[]): Promise<ReelFile> {
    const reel = await this.locate(relative);
    if (!reel) throw new PostError(404, "That reel is not on disk");
    const active = posts.find((p) => p.reel_file === reel.relative && ACTIVE.has(p.status));
    if (active) {
      throw new PostError(
        409,
        `${reel.reference} is already ${active.status === "posted" ? "posted" : "scheduled"}`
      );
    }
    return reel;
  }

  private async editable(id: string): Promise<PostEntry> {
    const post = await this.deps.store.get(id);
    if (!post) throw new PostError(404, "Post not found");
    if (!EDITABLE.has(post.status)) throw new PostError(409, `This post is ${post.status}`);
    return post;
  }

  private async create(reel: ReelFile, caption: string, when: Date, arm = true): Promise<PostEntry> {
    const slug = reel.reference.replace(/[^0-9]+/g, "-");
    const id = `${slug}-${Date.now().toString(36)}${(this.seq++).toString(36)}`;
    // Files go up before the post exists, so a failed upload leaves nothing half-queued.
    const keys = this.remote
      ? await this.remote.upload(id, reel).catch((error: unknown) => {
          throw new PostError(502, `Could not copy the reel to S3: ${message(error)}`);
        })
      : {};
    const post = await this.deps.store.create({
      id,
      reel_file: reel.relative,
      cover_file: reel.cover,
      reference: reel.reference,
      caption: caption.trim(),
      scheduled_at: when.toISOString(),
      ...keys,
    });
    return this.remote && arm ? this.armOrFail(post) : post;
  }

  /**
   * A post without an alarm would sit "scheduled" and never go out, so one
   * whose alarm cannot be set is shown failed — Retry, or a new time, re-arms it.
   */
  private async armOrFail(post: PostEntry): Promise<PostEntry> {
    try {
      await this.remote!.arm(post.id, post.scheduled_at);
      return post;
    } catch (error: unknown) {
      this.log.error(`[schedule] could not set the alarm for ${post.id}:`, error);
      const failed = await this.deps.store.update(post.id, {
        status: "failed",
        error: `Could not set the AWS alarm: ${message(error)}`,
      });
      return failed ?? post;
    }
  }

  /** In AWS mode the publisher may claim a post at any moment; an edit must not undo that. */
  private async stillEditable(id: string, patch: PostPatch): Promise<PostEntry> {
    const updated = await this.deps.store.claim(id, { status: [...EDITABLE] }, patch);
    if (!updated) throw new PostError(409, "This post is being published — refresh to see how it went");
    return updated;
  }

  private async discardFiles(post: PostEntry): Promise<void> {
    const keys = [post.reel_key, post.cover_key].filter((k): k is string => Boolean(k));
    // Logged, not fatal: a leftover file costs a fraction of a cent.
    await this.remote!.discard(keys).catch((e: unknown) => this.log.error(`[schedule] discard ${post.id}:`, e));
  }
}
