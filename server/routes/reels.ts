/**
 * Making a reel from the dashboard.
 *
 * Rendering takes minutes, so `POST /render` starts the work and returns at
 * once; the page polls `GET /progress`. Only one render runs at a time — see
 * `renderService` for why — so a second request is refused rather than queued,
 * which keeps the state one thing the page can display honestly.
 */
import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { REEL_FILE, safeOutputPath } from "../services/outputPaths.js";
import { findReciter } from "../services/reciters.js";
import {
  getProgress,
  history,
  isBusy,
  reset,
  startBatch,
  startRender,
} from "../services/renderService.js";
import { preflight } from "../services/reelPreflight.js";
import { verseCount } from "../services/outputPaths.js";

const router = Router();
router.use(requireAuth);

router.post("/render", (req: Request, res: Response) => {
  if (isBusy()) {
    return res.status(409).json({
      error: "A reel is already rendering. Wait for it to finish.",
    });
  }

  const surah = Number(req.body?.surah);
  const from = Number(req.body?.from);
  const to = Number(req.body?.to ?? from);
  const reciterId = String(req.body?.reciter ?? "");
  const dark = Boolean(req.body?.dark);

  if (!surah || !from || surah < 1 || surah > 114 || to < from) {
    return res.status(400).json({ error: "Bad range" });
  }
  if (!findReciter(reciterId)) {
    return res.status(400).json({ error: `Unknown reciter: ${reciterId}` });
  }

  startRender(
    { surah, from, to, reciterId, dark },
    {
      cover: Boolean(req.body?.cover),
        surahTamil: String(req.body?.surahTamil ?? ""),
    }
  );
  res.status(202).json({ started: true });
});

/**
 * One reel per verse across a range, queued and rendered in order.
 *
 * Separate from `/render`, which makes a single reel of the whole range — the
 * two produce very different things from the same numbers, and a flag on one
 * route would make it easy to get the wrong one.
 */
router.post("/batch", async (req: Request, res: Response) => {
  if (isBusy()) {
    return res.status(409).json({
      error: "A reel is already rendering. Wait for it to finish.",
    });
  }

  const surah = Number(req.body?.surah);
  const from = Number(req.body?.from);
  const to = Number(req.body?.to ?? from);
  const reciterId = String(req.body?.reciter ?? "");
  const dark = Boolean(req.body?.dark);

  if (!surah || !from || surah < 1 || surah > 114 || to < from) {
    return res.status(400).json({ error: "Bad range" });
  }
  if (!findReciter(reciterId)) {
    return res.status(400).json({ error: `Unknown reciter: ${reciterId}` });
  }

  const total = await verseCount(surah);
  if (from > total) {
    return res.status(400).json({
      error: `Surah ${surah} has ${total} verses; asked to start at ${from}`,
    });
  }

  // A range may overshoot the end of the sura; render what exists.
  const last = Math.min(to, total);

  // Per-verse overrides, keyed by ayah. A reciter id reaches a URL and a file
  // path, so every one is matched against the list before it is kept.
  const perVerse = (req.body?.perVerse ?? {}) as Record<
    string,
    { reciter?: string; caption?: string }
  >;

  const items = [];
  for (let ayah = from; ayah <= last; ayah += 1) {
    const own = perVerse[String(ayah)] ?? {};
    if (own.reciter && !findReciter(own.reciter)) {
      return res
        .status(400)
        .json({ error: `Unknown reciter for ${surah}:${ayah}: ${own.reciter}` });
    }
    items.push({
      ayah,
      reciterId: own.reciter || undefined,
      caption: own.caption || undefined,
    });
  }

  startBatch(items, { surah, reciterId, dark }, {
    cover: Boolean(req.body?.cover),
    surahTamil: String(req.body?.surahTamil ?? ""),
  });
  res.status(202).json({ started: true, verses: items.map((i) => i.ayah) });
});

/**
 * What a batch would produce, before committing minutes to it.
 *
 * Three things per verse, because each catches a different disappointment:
 * how small the type has to go to fit the verse on one frame, how long the
 * reel runs, and whether it is already on disk. A verse set under 30px or
 * running past 90s is not worth posting — see CLAUDE.md — and finding that out
 * after the render is finding out too late.
 *
 * Advisory only: it reports, it does not refuse. Whether a 27px reel is worth
 * posting is a judgement for a person.
 */
router.get("/preflight", async (req: Request, res: Response) => {
  const surah = Number(req.query.surah);
  const from = Number(req.query.from);
  const to = Number(req.query.to ?? from);
  const reciterId = String(req.query.reciter ?? "");
  const dark = req.query.dark === "1" || req.query.dark === "true";

  if (!surah || !from || surah < 1 || surah > 114 || to < from) {
    return res.status(400).json({ error: "Bad range" });
  }
  if (reciterId && !findReciter(reciterId)) {
    return res.status(400).json({ error: `Unknown reciter: ${reciterId}` });
  }

  try {
    const verses = await preflight(surah, from, to, reciterId || null, dark);
    res.json({ surah, verses });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

router.get("/progress", (_req: Request, res: Response) => {
  res.json(getProgress());
});

router.post("/reset", (_req: Request, res: Response) => {
  reset();
  res.json(getProgress());
});

router.get("/history", async (_req: Request, res: Response) => {
  res.json({ reels: await history() });
});

router.get("/file/*splat", (req: Request, res: Response) => {
  // Serve only from the output directory, and only paths of the shape this
  // layout produces — every segment is matched, so nothing walks out of it.
  const parts = req.params.splat;
  const relative = Array.isArray(parts) ? parts.join("/") : String(parts ?? "");
  const file = safeOutputPath(relative, REEL_FILE);
  if (!file) {
    return res.status(400).json({ error: "Bad file name" });
  }
  res.sendFile(file);
});

export default router;
