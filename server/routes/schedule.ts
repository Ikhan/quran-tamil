/**
 * The Instagram queue, for the dashboard.
 *
 *   GET    /                 settings, every post, and who Instagram says we are
 *   GET    /reels            every rendered reel, and whether it is queued
 *   PUT    /settings         daily times, time zone, paused
 *   POST   /                 one reel: next free slot, a chosen time, or now
 *   POST   /many             a batch's reels into consecutive slots
 *   PATCH  /:id              caption or time
 *   POST   /:id/cancel
 *   POST   /:id/publish      post now — also the retry for a failed post
 *
 * Responses follow the rest of this server: the value itself, or `{ error }`.
 */
import { Router, type Response } from "express";
import type { ZodError } from "zod";
import { requireAuth } from "../middleware/auth.js";
import type { Posting } from "../posts/posting.js";
import { PostError } from "../posts/service.js";
import { history } from "../services/renderService.js";
import {
  createManySchema,
  createPostSchema,
  scheduleSettingsSchema,
  updatePostSchema,
} from "../posts/types.js";

const firstIssue = (e: ZodError): string => e.issues[0]?.message ?? "Invalid request";

/** A PostError is the caller's to fix and says so; anything else is ours and goes to the error handler. */
const handle = (res: Response, error: unknown): void => {
  if (error instanceof PostError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  throw error;
};

export function scheduleRouter({ posts, instagram }: Pick<Posting, "posts" | "instagram">): Router {
  const router = Router();
  router.use(requireAuth);

  router.get("/", async (_req, res) => {
    const [settings, list, connection] = await Promise.all([
      posts.settings(),
      posts.list(),
      instagram(),
    ]);
    res.json({ settings, posts: list, instagram: connection, connected: posts.connected, backend: posts.backend });
  });

  router.get("/reels", async (_req, res) => {
    const files = (await history()).map((r) => r.file);
    res.json({ reels: await posts.reels(files) });
  });

  router.put("/settings", async (req, res) => {
    const parsed = scheduleSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstIssue(parsed.error) });
      return;
    }
    res.json(await posts.saveSettings(parsed.data));
  });

  router.post("/", async (req, res) => {
    const parsed = createPostSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstIssue(parsed.error) });
      return;
    }
    try {
      const post = await posts.schedule(parsed.data);
      res.status(parsed.data.now ? 202 : 201).json(post);
    } catch (error: unknown) {
      handle(res, error);
    }
  });

  router.post("/many", async (req, res) => {
    const parsed = createManySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstIssue(parsed.error) });
      return;
    }
    res.status(201).json(await posts.scheduleMany(parsed.data.items));
  });

  router.patch("/:id", async (req, res) => {
    const parsed = updatePostSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstIssue(parsed.error) });
      return;
    }
    try {
      res.json(await posts.update(req.params.id, parsed.data));
    } catch (error: unknown) {
      handle(res, error);
    }
  });

  router.post("/:id/cancel", async (req, res) => {
    try {
      res.json(await posts.cancel(req.params.id));
    } catch (error: unknown) {
      handle(res, error);
    }
  });

  router.post("/:id/publish", async (req, res) => {
    try {
      res.status(202).json(await posts.publishNow(req.params.id));
    } catch (error: unknown) {
      handle(res, error);
    }
  });

  return router;
}
