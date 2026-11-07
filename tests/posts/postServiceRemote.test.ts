import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemotePublishing } from "../../server/cloud/remote.js";
import type { ReelFile } from "../../server/posts/reelFiles.js";
import { PostError, PostService } from "../../server/posts/service.js";
import { JsonPostsStore } from "../../server/posts/store.js";

const R1 = "112-al-ikhlaas/reel-112-001.mp4";
const REEL: ReelFile = {
  relative: R1,
  absolute: `/out/${R1}`,
  reference: "112:1",
  cover: "112-al-ikhlaas/cover-112-001.png",
  caption: "From the batch",
};
const START = new Date("2026-11-06T08:00:00Z");

function setup() {
  const store = new JsonPostsStore(join(mkdtempSync(join(tmpdir(), "remote-")), "schedule.json"));
  const remote = {
    upload: vi.fn(async (id: string) => ({ reel_key: `reels/${id}/reel.mp4`, cover_key: `reels/${id}/cover.png` })),
    arm: vi.fn(async () => undefined),
    disarm: vi.fn(async () => undefined),
    discard: vi.fn(async () => undefined),
    invoke: vi.fn(async () => undefined),
  } satisfies RemotePublishing;
  let now = START;
  const service = new PostService({
    store,
    publisher: null,
    remote,
    locate: async (r) => (r === R1 ? REEL : null),
    now: () => now,
    log: { info: () => undefined, error: () => undefined },
  });
  return { store, remote, service, setNow: (d: Date) => (now = d) };
}

describe("PostService in AWS mode", () => {
  it("copies the files up and sets an alarm for the slot", async () => {
    const { service, remote } = setup();
    expect(service.backend).toBe("aws");
    expect(service.connected).toBe(true);
    const post = await service.schedule({ reel: R1, caption: "Say" });
    expect(post).toMatchObject({ scheduled_at: "2026-11-06T13:30:00.000Z", reel_key: `reels/${post.id}/reel.mp4`, cover_key: `reels/${post.id}/cover.png` });
    expect(remote.upload).toHaveBeenCalledWith(post.id, REEL);
    expect(remote.arm).toHaveBeenCalledWith(post.id, "2026-11-06T13:30:00.000Z");
  });

  it("queues nothing when the upload fails", async () => {
    const { service, remote } = setup();
    remote.upload.mockRejectedValueOnce(new Error("AccessDenied"));
    await expect(service.schedule({ reel: R1, caption: "Say" })).rejects.toThrow(/Could not copy the reel to S3: AccessDenied/);
    expect(await service.list()).toEqual([]);
  });

  it("shows a post failed when its alarm cannot be set", async () => {
    const { service, remote } = setup();
    remote.arm.mockRejectedValueOnce(new Error("Throttled"));
    const post = await service.schedule({ reel: R1, caption: "Say" });
    expect(post).toMatchObject({ status: "failed", error: "Could not set the AWS alarm: Throttled" });
  });

  it("moves the alarm with the post, and not for a caption edit", async () => {
    const { service, remote } = setup();
    const post = await service.schedule({ reel: R1, caption: "Say" });
    remote.arm.mockClear();
    await service.update(post.id, { caption: "New" });
    expect(remote.arm).not.toHaveBeenCalled();
    await service.update(post.id, { scheduledAt: "2026-11-08T13:30:00.000Z" });
    expect(remote.disarm).toHaveBeenCalledWith(post.id);
    expect(remote.arm).toHaveBeenCalledWith(post.id, "2026-11-08T13:30:00.000Z");
  });

  it("cancel removes the alarm and the files", async () => {
    const { service, remote } = setup();
    const post = await service.schedule({ reel: R1, caption: "Say" });
    expect((await service.cancel(post.id)).status).toBe("canceled");
    expect(remote.disarm).toHaveBeenCalledWith(post.id);
    expect(remote.discard).toHaveBeenCalledWith([`reels/${post.id}/reel.mp4`, `reels/${post.id}/cover.png`]);
  });

  it("Post now claims the post and hands the Lambda the token", async () => {
    const { service, remote, store } = setup();
    const post = await service.schedule({ reel: R1, caption: "Say" });
    const started = await service.publishNow(post.id);
    expect(started.status).toBe("publishing");
    const token = (await store.get(post.id))!.claim_token!;
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    expect(remote.invoke).toHaveBeenCalledWith({ postId: post.id, claim: token });
    expect(remote.disarm).toHaveBeenCalledWith(post.id);
  });

  it("Post now from scratch uploads without setting an alarm", async () => {
    const { service, remote } = setup();
    const post = await service.schedule({ reel: R1, caption: "Say", now: true });
    expect(post.status).toBe("publishing");
    expect(remote.arm).not.toHaveBeenCalled();
    expect(remote.invoke).toHaveBeenCalledTimes(1);
  });

  it("puts a post back as it was if the Lambda cannot be started", async () => {
    const { service, remote, store } = setup();
    const post = await service.schedule({ reel: R1, caption: "Say" });
    remote.invoke.mockRejectedValueOnce(new Error("TooManyRequests"));
    await expect(service.publishNow(post.id)).rejects.toBeInstanceOf(PostError);
    expect(await store.get(post.id)).toMatchObject({ status: "scheduled", claim_token: null });
    expect(remote.arm).toHaveBeenLastCalledWith(post.id, post.scheduled_at);
  });

  it("will not edit a post the publisher has claimed", async () => {
    const { service, store } = setup();
    const post = await service.schedule({ reel: R1, caption: "Say" });
    // The listing said scheduled; the Lambda claims it a moment later.
    const original = store.claim.bind(store);
    vi.spyOn(store, "claim").mockImplementationOnce(async (id, when, patch) => {
      await store.update(id, { status: "publishing" });
      return original(id, when, patch);
    });
    await expect(service.update(post.id, { caption: "x" })).rejects.toThrow(/being published/);
  });

  it("a publish that never reported back becomes failed, to be checked", async () => {
    const { service, store, setNow } = setup();
    const post = await service.schedule({ reel: R1, caption: "Say" });
    await store.update(post.id, { status: "publishing" });
    const touched = Date.parse((await store.get(post.id))!.updated_at);
    setNow(new Date(touched + 5 * 60_000));
    expect((await service.list())[0].status).toBe("publishing");
    setNow(new Date(touched + 21 * 60_000));
    expect((await service.list())[0]).toMatchObject({ status: "failed", error: expect.stringMatching(/check Instagram/) });
  });

  it("the minute tick does nothing — the alarms do the work", async () => {
    const { service, remote, setNow } = setup();
    await service.schedule({ reel: R1, caption: "Say" });
    setNow(new Date("2026-11-06T14:00:00Z"));
    await service.tick();
    expect(remote.invoke).not.toHaveBeenCalled();
  });
});
