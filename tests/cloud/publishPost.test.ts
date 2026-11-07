import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handlePublish, type CloudPublishDeps } from "../../server/cloud/publishPost.js";
import { PublishError, type PublishInput, type ReelPublisher } from "../../server/instagram/publisher.js";
import { JsonPostsStore } from "../../server/posts/store.js";

const AT = "2026-11-06T13:30:00.000Z";
const NOW = new Date(AT);

async function setup(opts: { publish?: (input: PublishInput) => Promise<{ mediaId: string; permalink: string | null }>; withReel?: boolean } = {}) {
  const store = new JsonPostsStore(join(mkdtempSync(join(tmpdir(), "cloud-")), "schedule.json"));
  const post = await store.create({
    id: "112-1-abc",
    reel_file: "112-al-ikhlaas/reel-112-001.mp4",
    cover_file: "112-al-ikhlaas/cover-112-001.png",
    reference: "112:1",
    caption: "Say",
    scheduled_at: AT,
    ...(opts.withReel === false ? {} : { reel_key: "reels/112-1-abc/reel.mp4", cover_key: "reels/112-1-abc/cover.png" }),
  });
  const publish = vi.fn(opts.publish ?? (async () => ({ mediaId: "m1", permalink: "https://instagram.com/reel/x/" })));
  const publisher: ReelPublisher = { publish };
  const alarms = { arm: vi.fn(async () => undefined), disarm: vi.fn(async () => undefined) };
  const files = {
    upload: vi.fn(async () => undefined),
    link: vi.fn(async (key: string) => `https://s3.example/${key}?sig`),
    remove: vi.fn(async () => undefined),
  };
  const deps: CloudPublishDeps = {
    store,
    alarms,
    files,
    publisher: vi.fn(async () => publisher),
    now: () => NOW,
    retryDelayMs: 15 * 60_000,
    log: { info: () => undefined, error: () => undefined },
  };
  return { store, post, publish, alarms, files, deps };
}

describe("cloud publisher", () => {
  it("posts with signed links, records it, and deletes the files", async () => {
    const { store, publish, files, deps } = await setup();
    const outcome = await handlePublish({ postId: "112-1-abc", at: AT }, deps);
    expect(outcome).toEqual({ result: "posted", permalink: "https://instagram.com/reel/x/" });
    expect(publish.mock.calls[0][0]).toMatchObject({
      videoUrl: "https://s3.example/reels/112-1-abc/reel.mp4?sig",
      coverUrl: "https://s3.example/reels/112-1-abc/cover.png?sig",
      caption: "Say",
    });
    expect(await store.get("112-1-abc")).toMatchObject({ status: "posted", attempts: 1, media_id: "m1", posted_at: AT });
    expect(files.remove).toHaveBeenCalledWith(["reels/112-1-abc/reel.mp4", "reels/112-1-abc/cover.png"]);
  });

  it("does nothing on a second delivery of the same alarm", async () => {
    const { publish, deps } = await setup();
    await handlePublish({ postId: "112-1-abc", at: AT }, deps);
    const again = await handlePublish({ postId: "112-1-abc", at: AT }, deps);
    expect(again.result).toBe("skipped");
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("only one of two simultaneous deliveries publishes", async () => {
    const { publish, deps } = await setup();
    const both = await Promise.all([
      handlePublish({ postId: "112-1-abc", at: AT }, deps),
      handlePublish({ postId: "112-1-abc", at: AT }, deps),
    ]);
    expect(both.map((o) => o.result).sort()).toEqual(["posted", "skipped"]);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("leaves a post that was moved since the alarm was set", async () => {
    const { publish, deps } = await setup();
    const outcome = await handlePublish({ postId: "112-1-abc", at: "2026-11-05T13:30:00.000Z" }, deps);
    expect(outcome.result).toBe("skipped");
    expect(publish).not.toHaveBeenCalled();
  });

  it("leaves a canceled post alone", async () => {
    const { store, publish, deps } = await setup();
    await store.update("112-1-abc", { status: "canceled" });
    expect((await handlePublish({ postId: "112-1-abc", at: AT }, deps)).result).toBe("skipped");
    expect(publish).not.toHaveBeenCalled();
  });

  it("retries a safe failure fifteen minutes later with a new alarm", async () => {
    const { store, alarms, files, deps } = await setup({
      publish: async () => {
        throw new PublishError("Instagram could not process the video: ERROR", true);
      },
    });
    const outcome = await handlePublish({ postId: "112-1-abc", at: AT }, deps);
    expect(outcome).toEqual({ result: "retrying", at: "2026-11-06T13:45:00.000Z" });
    expect(alarms.arm).toHaveBeenCalledWith("112-1-abc", "2026-11-06T13:45:00.000Z");
    expect(await store.get("112-1-abc")).toMatchObject({ status: "scheduled", attempts: 1, scheduled_at: "2026-11-06T13:45:00.000Z" });
    expect(files.remove).not.toHaveBeenCalled();
    // The retry alarm fires and is honoured.
    const second = await handlePublish({ postId: "112-1-abc", at: "2026-11-06T13:45:00.000Z" }, deps);
    expect(second.result).toBe("retrying");
    expect((await store.get("112-1-abc"))?.attempts).toBe(2);
  });

  it("gives up after the third attempt", async () => {
    const { store, alarms, deps } = await setup({
      publish: async () => {
        throw new PublishError("busy", true);
      },
    });
    await store.update("112-1-abc", { attempts: 2 });
    const outcome = await handlePublish({ postId: "112-1-abc", at: AT }, deps);
    expect(outcome).toEqual({ result: "failed", error: "busy" });
    expect(alarms.arm).not.toHaveBeenCalled();
    expect((await store.get("112-1-abc"))?.status).toBe("failed");
  });

  it("never retries an ambiguous publish", async () => {
    const { store, alarms, files, deps } = await setup({
      publish: async () => {
        throw new PublishError("socket hang up — check Instagram before retrying", false);
      },
    });
    const outcome = await handlePublish({ postId: "112-1-abc", at: AT }, deps);
    expect(outcome.result).toBe("failed");
    expect(alarms.arm).not.toHaveBeenCalled();
    expect(files.remove).not.toHaveBeenCalled();
    expect((await store.get("112-1-abc"))?.error).toMatch(/check Instagram/);
  });

  it("treats an unreadable token as safe to retry", async () => {
    const { deps } = await setup();
    deps.publisher = async () => {
      throw new Error("AccessDenied");
    };
    const outcome = await handlePublish({ postId: "112-1-abc", at: AT }, deps);
    expect(outcome.result).toBe("retrying");
  });

  it("fails rather than leaving a post with no alarm", async () => {
    const { store, alarms, deps } = await setup({
      publish: async () => {
        throw new PublishError("busy", true);
      },
    });
    alarms.arm.mockRejectedValueOnce(new Error("AccessDenied"));
    const outcome = await handlePublish({ postId: "112-1-abc", at: AT }, deps);
    expect(outcome.result).toBe("failed");
    expect((await store.get("112-1-abc"))?.error).toMatch(/retry could not be set: AccessDenied/);
  });

  it("refuses a post whose reel never reached S3", async () => {
    const { store, publish, deps } = await setup({ withReel: false });
    expect((await handlePublish({ postId: "112-1-abc", at: AT }, deps)).result).toBe("failed");
    expect(publish).not.toHaveBeenCalled();
    expect((await store.get("112-1-abc"))?.status).toBe("failed");
  });

  it("while paused, moves the post to the next free slot instead", async () => {
    const { store, publish, alarms, deps } = await setup();
    await store.saveSettings({ times: ["19:00"], timezone: "Asia/Kolkata", paused: true });
    const outcome = await handlePublish({ postId: "112-1-abc", at: AT }, deps);
    expect(outcome).toEqual({ result: "deferred", at: "2026-11-07T13:30:00.000Z" });
    expect(publish).not.toHaveBeenCalled();
    expect(alarms.arm).toHaveBeenCalledWith("112-1-abc", "2026-11-07T13:30:00.000Z");
    expect(await store.get("112-1-abc")).toMatchObject({ status: "scheduled", scheduled_at: "2026-11-07T13:30:00.000Z" });
  });

  it("publishes a Post now only with the dashboard's claim token", async () => {
    const { store, publish, deps } = await setup();
    await store.update("112-1-abc", { status: "publishing", claim_token: "t-1" });
    expect((await handlePublish({ postId: "112-1-abc", claim: "t-other" }, deps)).result).toBe("skipped");
    expect(publish).not.toHaveBeenCalled();
    expect((await handlePublish({ postId: "112-1-abc", claim: "t-1" }, deps)).result).toBe("posted");
    expect(await store.get("112-1-abc")).toMatchObject({ status: "posted", claim_token: null });
  });

  it("posts a Post now even while paused — it was asked for by hand", async () => {
    const { store, deps } = await setup();
    await store.saveSettings({ times: ["19:00"], timezone: "Asia/Kolkata", paused: true });
    await store.update("112-1-abc", { status: "publishing", claim_token: "t-1" });
    expect((await handlePublish({ postId: "112-1-abc", claim: "t-1" }, deps)).result).toBe("posted");
  });
});
