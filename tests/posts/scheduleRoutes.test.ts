import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { scheduleRouter } from "../../server/routes/schedule.js";
import { PostService } from "../../server/posts/service.js";
import { JsonPostsStore } from "../../server/posts/store.js";

const REEL = "112-al-ikhlaas/reel-112-001.mp4";

function setup({ loggedIn = true } = {}) {
  const store = new JsonPostsStore(join(mkdtempSync(join(tmpdir(), "routes-")), "schedule.json"));
  const posts = new PostService({
    store,
    publisher: null,
    locate: async (r) =>
      r === REEL ? { relative: REEL, absolute: `/out/${REEL}`, reference: "112:1", cover: null, caption: null } : null,
    now: () => new Date("2026-11-06T08:00:00Z"),
    log: { info: () => undefined, error: () => undefined },
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: object }).session = loggedIn ? { user: { username: "u" } } : {};
    next();
  });
  app.use(
    "/api/schedule",
    scheduleRouter({
      posts,
      instagram: async () => ({ configured: false, username: null, error: null, quota: null }),
    })
  );
  return app;
}

describe("schedule routes", () => {
  it("needs a login", async () => {
    expect((await request(setup({ loggedIn: false })).get("/api/schedule")).status).toBe(401);
  });

  it("lists settings, posts and the connection", async () => {
    const res = await request(setup()).get("/api/schedule");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      settings: { times: ["19:00"], timezone: "Asia/Kolkata", paused: false },
      posts: [],
      instagram: { configured: false },
      connected: false,
    });
  });

  it("schedules a reel and refuses it twice", async () => {
    const app = setup();
    const first = await request(app).post("/api/schedule").send({ reel: REEL, caption: "Say" });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ reference: "112:1", scheduled_at: "2026-11-06T13:30:00.000Z" });
    const again = await request(app).post("/api/schedule").send({ reel: REEL, caption: "Say" });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("112:1 is already scheduled");
  });

  it("refuses a caption Instagram would refuse", async () => {
    const app = setup();
    const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" ");
    const many = await request(app).post("/api/schedule").send({ reel: REEL, caption: `Say ${tags}` });
    expect(many.status).toBe(400);
    expect(many.body.error).toMatch(/30 hashtags/);
    const long = await request(app).post("/api/schedule").send({ reel: REEL, caption: "x".repeat(2201) });
    expect(long.body.error).toMatch(/2200 characters/);
    const empty = await request(app).post("/api/schedule").send({ reel: REEL, caption: "   " });
    expect(empty.body.error).toMatch(/empty/);
  });

  it("refuses unknown fields and bad settings", async () => {
    const app = setup();
    expect((await request(app).post("/api/schedule").send({ reel: REEL, caption: "a", extra: 1 })).status).toBe(400);
    const bad = await request(app).put("/api/schedule/settings").send({ times: ["25:00"], timezone: "Asia/Kolkata", paused: false });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/HH:MM/);
    const zone = await request(app).put("/api/schedule/settings").send({ times: ["09:00"], timezone: "Mars/Olympus", paused: false });
    expect(zone.body.error).toMatch(/time zone/);
    const good = await request(app).put("/api/schedule/settings").send({ times: ["09:00", "19:00"], timezone: "Asia/Kolkata", paused: true });
    expect(good.body).toEqual({ times: ["09:00", "19:00"], timezone: "Asia/Kolkata", paused: true });
  });

  it("says Instagram is not connected when asked to post now", async () => {
    const res = await request(setup()).post("/api/schedule").send({ reel: REEL, caption: "a", now: true });
    expect(res.status).toBe(503);
  });

  it("schedules many and reports what it skipped", async () => {
    const res = await request(setup())
      .post("/api/schedule/many")
      .send({ items: [{ reel: REEL, caption: "a" }, { reel: "x/reel-001-001.mp4", caption: "b" }] });
    expect(res.status).toBe(201);
    expect(res.body.scheduled).toHaveLength(1);
    expect(res.body.skipped).toEqual([{ reel: "x/reel-001-001.mp4", reason: "That reel is not on disk" }]);
  });

  it("edits and cancels, and 404s an unknown post", async () => {
    const app = setup();
    const { body: post } = await request(app).post("/api/schedule").send({ reel: REEL, caption: "a" });
    expect((await request(app).patch(`/api/schedule/${post.id}`).send({ caption: "b" })).body.caption).toBe("b");
    expect((await request(app).patch(`/api/schedule/${post.id}`).send({})).status).toBe(400);
    expect((await request(app).post(`/api/schedule/${post.id}/cancel`)).body.status).toBe("canceled");
    expect((await request(app).post("/api/schedule/nope/cancel")).status).toBe(404);
  });
});
