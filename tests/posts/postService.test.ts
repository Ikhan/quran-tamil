import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PublishError, type ReelPublisher } from "../../server/instagram/publisher.js";
import type { ReelFile } from "../../server/posts/reelFiles.js";
import { PostService } from "../../server/posts/service.js";
import { JsonPostsStore } from "../../server/posts/store.js";

const REELS: Record<string, ReelFile> = {
  "112-al-ikhlaas/reel-112-001.mp4": {
    relative: "112-al-ikhlaas/reel-112-001.mp4",
    absolute: "/out/112-al-ikhlaas/reel-112-001.mp4",
    reference: "112:1",
    cover: "112-al-ikhlaas/cover-112-001.png",
    caption: null,
  },
  "112-al-ikhlaas/reel-112-002.mp4": {
    relative: "112-al-ikhlaas/reel-112-002.mp4",
    absolute: "/out/112-al-ikhlaas/reel-112-002.mp4",
    reference: "112:2",
    cover: null,
    caption: "From the batch",
  },
  "112-al-ikhlaas/reel-112-003.mp4": {
    relative: "112-al-ikhlaas/reel-112-003.mp4",
    absolute: "/out/112-al-ikhlaas/reel-112-003.mp4",
    reference: "112:3",
    cover: null,
    caption: null,
  },
};
const R1 = "112-al-ikhlaas/reel-112-001.mp4";
const R2 = "112-al-ikhlaas/reel-112-002.mp4";
const R3 = "112-al-ikhlaas/reel-112-003.mp4";

/** 08:00 UTC = 13:30 in Asia/Kolkata, so today's 19:00 is still ahead. */
const START = new Date("2026-11-06T08:00:00Z");

function setup(opts: { publisher?: ReelPublisher | null; now?: Date } = {}) {
  const file = join(mkdtempSync(join(tmpdir(), "posts-")), "schedule.json");
  const store = new JsonPostsStore(file);
  let now = opts.now ?? START;
  const publish = vi.fn(async () => ({ mediaId: "m1", permalink: "https://instagram.com/reel/x/" }));
  const publisher: ReelPublisher | null =
    opts.publisher === undefined ? { publish } : opts.publisher;
  const service = new PostService({
    store,
    publisher,
    locate: async (r) => REELS[r] ?? null,
    now: () => now,
    retryDelayMs: 60_000,
    log: { info: () => undefined, error: () => undefined },
  });
  return { service, store, file, publish, setNow: (d: Date) => (now = d) };
}

describe("PostService.schedule", () => {
  it("puts a reel in the next free daily slot, with its cover", async () => {
    const { service } = setup();
    const post = await service.schedule({ reel: R1, caption: "  Say: He is Allah  " });
    expect(post).toMatchObject({
      reel_file: R1,
      cover_file: "112-al-ikhlaas/cover-112-001.png",
      reference: "112:1",
      caption: "Say: He is Allah",
      status: "scheduled",
      scheduled_at: "2026-11-06T13:30:00.000Z",
    });
  });

  it("gives the next reel the next day", async () => {
    const { service } = setup();
    await service.schedule({ reel: R1, caption: "a" });
    expect((await service.schedule({ reel: R2, caption: "b" })).scheduled_at).toBe("2026-11-07T13:30:00.000Z");
  });

  it("honours a chosen time, but not one in the past", async () => {
    const { service } = setup();
    const at = "2026-11-10T04:00:00.000Z";
    expect((await service.schedule({ reel: R1, caption: "a", scheduledAt: at })).scheduled_at).toBe(at);
    await expect(service.schedule({ reel: R2, caption: "a", scheduledAt: "2026-11-01T00:00:00Z" })).rejects.toMatchObject({ status: 400 });
  });

  it("refuses a reel that is not on disk, or already queued", async () => {
    const { service } = setup();
    await expect(service.schedule({ reel: "nope.mp4", caption: "a" })).rejects.toMatchObject({ status: 404 });
    await service.schedule({ reel: R1, caption: "a" });
    await expect(service.schedule({ reel: R1, caption: "a" })).rejects.toMatchObject({ status: 409, message: "112:1 is already scheduled" });
  });

  it("lets a canceled reel be queued again", async () => {
    const { service } = setup();
    const first = await service.schedule({ reel: R1, caption: "a" });
    await service.cancel(first.id);
    await expect(service.schedule({ reel: R1, caption: "a" })).resolves.toMatchObject({ status: "scheduled" });
  });

  it("posts right away when asked", async () => {
    const { service, publish } = setup();
    const post = await service.schedule({ reel: R1, caption: "a", now: true });
    expect(post.status).toBe("publishing");
    await service.idle();
    expect(publish).toHaveBeenCalledOnce();
    expect((await service.list())[0]).toMatchObject({ status: "posted", media_id: "m1" });
  });

  it("refuses to post now without Instagram, and creates nothing", async () => {
    const { service } = setup({ publisher: null });
    await expect(service.schedule({ reel: R1, caption: "a", now: true })).rejects.toMatchObject({ status: 503 });
    expect(await service.list()).toEqual([]);
  });
});

describe("PostService.scheduleMany", () => {
  it("fills consecutive slots in the order given and reports what it skipped", async () => {
    const { service } = setup();
    await service.schedule({ reel: R2, caption: "already" });
    const result = await service.scheduleMany([
      { reel: R1, caption: "one" },
      { reel: R2, caption: "two" },
      { reel: "missing.mp4", caption: "x" },
      { reel: R3, caption: "three" },
      { reel: R3, caption: "again" },
    ]);
    expect(result.scheduled.map((p) => [p.reference, p.scheduled_at])).toEqual([
      ["112:1", "2026-11-07T13:30:00.000Z"],
      ["112:3", "2026-11-08T13:30:00.000Z"],
    ]);
    expect(result.skipped).toEqual([
      { reel: R2, reason: "112:2 is already scheduled" },
      { reel: "missing.mp4", reason: "That reel is not on disk" },
      { reel: R3, reason: "Listed twice" },
    ]);
  });

  it("falls back to the caption written beside the reel, and skips a reel with none", async () => {
    const { service } = setup();
    const { scheduled, skipped } = await service.scheduleMany([{ reel: R2 }, { reel: R3 }]);
    expect(scheduled.map((p) => p.caption)).toEqual(["From the batch"]);
    expect(skipped).toEqual([{ reel: R3, reason: "No caption — write one first" }]);
  });

  it("lists rendered reels with the post holding each", async () => {
    const { service } = setup();
    const post = await service.schedule({ reel: R1, caption: "a" });
    const reels = await service.reels([R1, R2, "gone.mp4"]);
    expect(reels).toEqual([
      expect.objectContaining({ file: R1, post: { id: post.id, status: "scheduled", scheduled_at: post.scheduled_at } }),
      expect.objectContaining({ file: R2, caption: "From the batch", post: null }),
    ]);
  });

  it("uses every daily time", async () => {
    const { service } = setup({ now: new Date("2026-11-06T02:00:00Z") });
    await service.saveSettings({ times: ["09:00", "19:00"], timezone: "Asia/Kolkata", paused: false });
    const { scheduled } = await service.scheduleMany([R1, R2, R3].map((reel) => ({ reel, caption: "c" })));
    expect(scheduled.map((p) => p.scheduled_at)).toEqual([
      "2026-11-06T03:30:00.000Z",
      "2026-11-06T13:30:00.000Z",
      "2026-11-07T03:30:00.000Z",
    ]);
  });
});

describe("PostService.tick", () => {
  it("publishes a due post with its reel and cover, and records the result", async () => {
    const { service, publish, setNow } = setup();
    await service.schedule({ reel: R1, caption: "Say" });
    await service.tick();
    expect(publish).not.toHaveBeenCalled(); // not due yet

    setNow(new Date("2026-11-06T13:31:00Z"));
    await service.tick();
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        videoPath: "/out/112-al-ikhlaas/reel-112-001.mp4",
        coverPath: expect.stringMatching(/112-al-ikhlaas\/cover-112-001\.png$/),
        caption: "Say",
      })
    );
    expect((await service.list())[0]).toMatchObject({
      status: "posted",
      permalink: "https://instagram.com/reel/x/",
      posted_at: "2026-11-06T13:31:00.000Z",
    });
  });

  it("does nothing while paused, or without Instagram", async () => {
    const paused = setup();
    await paused.service.schedule({ reel: R1, caption: "a" });
    await paused.service.saveSettings({ times: ["19:00"], timezone: "Asia/Kolkata", paused: true });
    paused.setNow(new Date("2026-11-06T13:31:00Z"));
    await paused.service.tick();
    expect(paused.publish).not.toHaveBeenCalled();

    const offline = setup({ publisher: null });
    await offline.service.schedule({ reel: R1, caption: "a" });
    offline.setNow(new Date("2026-11-06T13:31:00Z"));
    await offline.service.tick();
    expect((await offline.service.list())[0].status).toBe("scheduled");
  });

  it("retries a failure Instagram cannot have acted on", async () => {
    const publish = vi.fn(async () => {
      throw new PublishError("Video link: tunnel down", true);
    });
    const { service, setNow } = setup({ publisher: { publish } });
    await service.schedule({ reel: R1, caption: "a" });
    setNow(new Date("2026-11-06T13:31:00Z"));
    await service.tick();
    expect((await service.list())[0]).toMatchObject({
      status: "scheduled",
      attempts: 1,
      scheduled_at: "2026-11-06T13:32:00.000Z",
      error: expect.stringContaining("retrying"),
    });
  });

  it("never retries a failure that may already have posted", async () => {
    const publish = vi.fn(async () => {
      throw new PublishError("timeout — check Instagram before retrying", false);
    });
    const { service, setNow } = setup({ publisher: { publish } });
    await service.schedule({ reel: R1, caption: "a" });
    setNow(new Date("2026-11-06T13:31:00Z"));
    await service.tick();
    await service.tick();
    expect(publish).toHaveBeenCalledOnce();
    expect((await service.list())[0].status).toBe("failed");
  });

  it("gives up after three attempts", async () => {
    const publish = vi.fn(async () => {
      throw new Error("boom");
    });
    const { service, setNow } = setup({ publisher: { publish } });
    await service.schedule({ reel: R1, caption: "a" });
    for (let minute = 31; minute < 40; minute++) {
      setNow(new Date(`2026-11-06T13:${minute}:30Z`));
      await service.tick();
    }
    expect(publish).toHaveBeenCalledTimes(3);
    expect((await service.list())[0]).toMatchObject({ status: "failed", attempts: 3, error: "boom" });
  });

  it("fails a post whose reel has gone from disk, without retrying", async () => {
    const { service, store, setNow, publish } = setup();
    await store.create({
      id: "x-1",
      reel_file: "112-al-ikhlaas/reel-112-009.mp4",
      cover_file: null,
      reference: "112:9",
      caption: "a",
      scheduled_at: "2026-11-06T13:30:00.000Z",
    });
    setNow(new Date("2026-11-06T13:31:00Z"));
    await service.tick();
    expect(publish).not.toHaveBeenCalled();
    expect((await service.list())[0]).toMatchObject({ status: "failed", error: expect.stringContaining("missing") });
  });

  it("moves a long-missed post to the next free slot instead of firing it late", async () => {
    const { service, publish, setNow } = setup();
    await service.schedule({ reel: R1, caption: "a" }); // 2026-11-06 19:00 IST
    setNow(new Date("2026-11-07T08:00:00Z")); // 18.5 h later
    await service.tick();
    expect(publish).not.toHaveBeenCalled();
    expect((await service.list())[0]).toMatchObject({
      status: "scheduled",
      scheduled_at: "2026-11-07T13:30:00.000Z",
      error: expect.stringContaining("Missed"),
    });
  });
});

describe("PostService edits", () => {
  it("edits a caption, and puts a failed post back in the queue with a new time", async () => {
    const publish = vi.fn(async () => {
      throw new PublishError("refused", false);
    });
    const { service, setNow } = setup({ publisher: { publish } });
    const post = await service.schedule({ reel: R1, caption: "a" });
    expect((await service.update(post.id, { caption: "b" })).caption).toBe("b");

    setNow(new Date("2026-11-06T13:31:00Z"));
    await service.tick();
    const back = await service.update(post.id, { scheduledAt: "2026-11-08T13:30:00Z" });
    expect(back).toMatchObject({ status: "scheduled", attempts: 0, error: null });
  });

  it("refuses to touch a post that has gone out", async () => {
    const { service } = setup();
    const post = await service.schedule({ reel: R1, caption: "a", now: true });
    await service.idle();
    await expect(service.cancel(post.id)).rejects.toMatchObject({ status: 409, message: "This post is posted" });
    await expect(service.update(post.id, { caption: "b" })).rejects.toMatchObject({ status: 409 });
  });

  it("refuses a second publish while one is in flight", async () => {
    let finish: () => void = () => undefined;
    const publish = vi.fn(
      () => new Promise<{ mediaId: string; permalink: null }>((r) => (finish = () => r({ mediaId: "m", permalink: null })))
    );
    const { service } = setup({ publisher: { publish } });
    const a = await service.schedule({ reel: R1, caption: "a" });
    const b = await service.schedule({ reel: R2, caption: "b" });
    await service.publishNow(a.id);
    await expect(service.publishNow(b.id)).rejects.toMatchObject({ status: 409 });
    await expect(service.schedule({ reel: R3, caption: "c", now: true })).rejects.toMatchObject({ status: 409 });
    await vi.waitFor(() => expect(publish).toHaveBeenCalled());
    finish();
    await service.idle();
  });
});

describe("JsonPostsStore", () => {
  it("marks an interrupted publish as failed on restart, never as scheduled", async () => {
    const { service, file } = setup();
    const post = await service.schedule({ reel: R1, caption: "a" });
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.posts[0].status = "publishing";
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, JSON.stringify(raw));

    const fresh = new JsonPostsStore(file);
    await fresh.recoverInterrupted();
    expect(await fresh.get(post.id)).toMatchObject({ status: "failed", error: expect.stringContaining("check Instagram") });
  });

  it("refuses to start over a corrupt queue rather than forgetting it", async () => {
    const { file } = setup();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, "{ not json");
    await expect(new JsonPostsStore(file).list()).rejects.toThrow();
  });
});
