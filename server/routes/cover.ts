/**
 * The cover still for a reel.
 *
 * Quick enough to render inline — one frame, a second or two — so unlike a reel
 * this needs no progress polling.
 */
import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import {
  buildCover,
  saveCoverImage,
  tamilNameOf,
} from "../services/coverBuilder.js";
import { COVER_FILE, safeOutputPath } from "../services/outputPaths.js";
import { SURAH_NAMES } from "../services/surahNames.js";

const router = Router();
router.use(requireAuth);

/** The English name, and the Tamil one if it has been typed before. */
router.get("/names/:surah", async (req: Request, res: Response) => {
  const surah = Number(req.params.surah);
  if (!surah || surah < 1 || surah > 114) {
    return res.status(400).json({ error: "Bad surah" });
  }

  res.json({
    surah,
    english: SURAH_NAMES[surah]?.english ?? `Surah ${surah}`,
    tamil: await tamilNameOf(surah),
  });
});

router.post("/render", async (req: Request, res: Response) => {
  const surah = Number(req.body?.surah);
  const from = Number(req.body?.from);
  const to = Number(req.body?.to ?? from);
  const surahTamil = String(req.body?.surahTamil ?? "");
  const image = req.body?.image ? String(req.body.image) : undefined;

  if (!surah || !from || surah < 1 || surah > 114 || from < 1 || to < from) {
    return res.status(400).json({ error: "Bad surah or verse range" });
  }

  try {
    const file = await buildCover({ surah, from, to, surahTamil, image });
    res.json({ file, url: `/api/cover/file/${file}` });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * Photographs for a batch, one per verse.
 *
 * Uploaded up front rather than one at a time, because the point of a batch is
 * that it runs unattended — a run that stopped to ask for the next image would
 * be the manual loop again with extra steps.
 *
 * Images are handed out in the order they were given, cycling when there are
 * fewer of them than verses. Cycling rather than leaving the rest bare: a
 * repeated photograph is a choice someone might make, an empty cover is not.
 * In order rather than shuffled so that a re-run pairs them the same way and a
 * photograph you disliked on a verse is the one you can go and replace.
 */
router.post("/pool", async (req: Request, res: Response) => {
  const surah = Number(req.body?.surah);
  const verses: number[] = Array.isArray(req.body?.verses)
    ? req.body.verses.map(Number)
    : [];
  const images: string[] = Array.isArray(req.body?.images)
    ? req.body.images.map(String)
    : [];

  if (!surah || surah < 1 || surah > 114) {
    return res.status(400).json({ error: "Bad surah" });
  }
  if (!verses.length || verses.some((v) => !Number.isInteger(v) || v < 1)) {
    return res.status(400).json({ error: "Bad verse list" });
  }
  if (!images.length) {
    return res.status(400).json({ error: "No images" });
  }

  try {
    const assigned: Record<number, string> = {};
    for (const [index, ayah] of verses.entries()) {
      assigned[ayah] = await saveCoverImage(
        images[index % images.length],
        surah,
        ayah
      );
    }
    res.json({ assigned });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

router.get("/file/*splat", (req: Request, res: Response) => {
  // Serve only from the output directory, and only paths of the shape this
  // layout produces — every segment is matched, so nothing walks out of it.
  const parts = req.params.splat;
  const relative = Array.isArray(parts) ? parts.join("/") : String(parts ?? "");
  const file = safeOutputPath(relative, COVER_FILE);
  if (!file) {
    return res.status(400).json({ error: "Bad file name" });
  }
  res.sendFile(file);
});

export default router;
