import { Router, type Request, type Response } from "express";
import fs from "fs/promises";
import path from "path";
import { config } from "../config/config.js";
import { requireAuth } from "../middleware/auth.js";
import { buildClip } from "../services/clipper.js";
import { recitationSeconds } from "../services/arabicTimings.js";
import { defectiveVerses } from "../services/verseDefects.js";
import { buildArabicRun, buildMixedClip } from "../services/mixer.js";
import { loadSources, verseKey } from "../services/quranSources.js";
import { ensureRecitation, ensureRange } from "../services/recitations.js";
import {
  DEFAULT_RECITER,
  RECITERS,
  SAMPLE_VERSE,
  findReciter,
} from "../services/reciters.js";
import { SURAH_NAMES } from "../services/surahNames.js";
import {
  CONFIDENCE_FLOOR,
  coverage,
  loadSurahTimings,
} from "../services/timings.js";
import { resolveInput } from "../services/verseResolver.js";

const router = Router();
router.use(requireAuth);

/** Longest audition, in verses. Past this nobody is still listening. */
const SAMPLE_MAX_VERSES = 12;

/** Which surahs have audio available, so the gaps are visible up front. */
router.get("/coverage", async (_req: Request, res: Response) => {
  const indexed = await coverage();
  res.json({ indexed, total: 114 });
});

/** The voices the Arabic can be recited in, for the picker. */
router.get("/reciters", (_req: Request, res: Response) => {
  res.json({ reciters: RECITERS, default: DEFAULT_RECITER });
});

/**
 * Auditions a voice on the verses being worked on.
 *
 * The whole resolved range, end to end — hearing Alafasy on the first verse of
 * a passage does not tell you how the passage sounds. `?surah=&from=&to=`
 * carries it; without them, or if that range cannot be fetched, it falls back
 * to Al-Fatiha 1:1, which is short and exists for every reciter.
 *
 * Proxied rather than linked straight to everyayah so that hearing a voice also
 * warms the cache for it — the build that follows then has the files already —
 * and so the dashboard behaves the same whether or not the browser can reach
 * the internet directly.
 */
router.get("/sample/:reciter", async (req: Request, res: Response) => {
  const reciter = findReciter(String(req.params.reciter));
  if (!reciter) {
    return res.status(400).json({ error: "Unknown reciter" });
  }

  const surah = Number(req.query.surah);
  const from = Number(req.query.from);
  const asked = Number(req.query.to ?? from);

  const { arabic } = await loadSources();
  const valid =
    Number.isInteger(surah) &&
    Number.isInteger(from) &&
    from >= 1 &&
    asked >= from &&
    arabic.has(verseKey(surah, from));

  // A whole sura may be resolved, and a two-hour audition is not an audition.
  // Longer ranges are cut short rather than refused: the first verses are what
  // tells you whether the voice suits, and the rest would never be listened to.
  let last = valid ? Math.min(asked, from + SAMPLE_MAX_VERSES - 1) : from;
  // And a range may overshoot the end of the sura — 110:1-9, where An-Nasr has
  // three verses. Trim to what exists rather than collapsing to one verse.
  while (last > from && !arabic.has(verseKey(surah, last))) {
    last -= 1;
  }

  try {
    if (valid) {
      const files = await ensureRange(reciter.id, surah, from, last);
      const path_ =
        last === from
          ? files[0]
          : await buildArabicRun(reciter.id, surah, from, last, files);

      // Says what was served, so a range trimmed to the cap — or a fallback —
      // is visible rather than silently sounding like the wrong choice.
      res.set(
        "X-Sample-Verse",
        `${surah}:${from}` + (last === from ? "" : `-${last}`)
      );
      return res.type("audio/mpeg").sendFile(path_);
    }
  } catch {
    // Fall through to Al-Fatiha rather than failing the audition outright.
  }

  try {
    const file = await ensureRecitation(
      reciter.id,
      SAMPLE_VERSE.surah,
      SAMPLE_VERSE.ayah
    );
    res.set("X-Sample-Verse", `${SAMPLE_VERSE.surah}:${SAMPLE_VERSE.ayah}`);
    res.type("audio/mpeg").sendFile(file);
  } catch (error) {
    res.status(502).json({ error: (error as Error).message });
  }
});

/**
 * How long a resolved range will run, before anything is built.
 *
 * A render takes minutes and a reel over 90s is not worth posting, so the
 * length is worth knowing at the point the range is chosen rather than after
 * waiting for a file. Tamil comes from the index, Arabic from the reciter's
 * word timings; interleaved, a verse costs both.
 *
 * Its own route rather than part of `/resolve` because the answer depends on
 * the reciter, which is picked after resolving and changed freely afterwards —
 * and because the timing files are 34MB across seventeen reciters, far too
 * much to hand to the page so it can work the total out itself.
 */
router.get("/duration", async (req: Request, res: Response) => {
  const surah = Number(req.query.surah);
  const from = Number(req.query.from);
  const to = Number(req.query.to);
  if (!Number.isInteger(surah) || surah < 1 || surah > 114 ||
      !Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
    return res.status(400).json({ error: "Bad range" });
  }

  const timings = await loadSurahTimings(surah);
  let tamil = 0;
  for (let ayah = from; ayah <= to; ayah += 1) {
    const timing = timings?.get(verseKey(surah, ayah));
    if (timing) {
      tamil += timing.end - timing.start;
    }
  }

  // A reciter id reaches a file path, so it is only ever used after
  // findReciter has matched it against the list.
  let arabic: number | null = null;
  const wanted = req.query.reciter ? String(req.query.reciter) : null;
  if (wanted) {
    if (!findReciter(wanted)) {
      return res.status(400).json({ error: `Unknown reciter: ${wanted}` });
    }
    try {
      arabic = await recitationSeconds(wanted, surah, from, to);
    } catch {
      // No word timings vendored for that voice. The Tamil figure is still
      // worth showing, so report the gap rather than failing the request.
      arabic = null;
    }
  }

  res.json({
    tamilSeconds: Number(tamil.toFixed(1)),
    arabicSeconds: arabic === null ? null : Number(arabic.toFixed(1)),
  });
});

/**
 * Paste in, verses out — with the Arabic and Tamil for each, so a wrong match
 * is obvious before anything is cut.
 */
router.post("/resolve", async (req: Request, res: Response) => {
  const input = String(req.body?.input ?? "");

  let range;
  try {
    range = await resolveInput(input);
  } catch (error) {
    return res.status(400).json({ error: (error as Error).message });
  }

  const { arabic, tamil } = await loadSources();
  const timings = await loadSurahTimings(range.surah);

  // `to: 0` means "to the end of the sura".
  let last = range.to || 0;
  if (!last) {
    last = range.from;
    while (arabic.has(verseKey(range.surah, last + 1))) {
      last += 1;
    }
  }

  const verses = [];
  for (let ayah = range.from; ayah <= last; ayah += 1) {
    const key = verseKey(range.surah, ayah);
    if (!arabic.has(key)) {
      break;
    }
    const timing = timings?.get(key);
    verses.push({
      ayah,
      arabic: arabic.get(key) ?? "",
      tamil: tamil.get(key) ?? "",
      hasAudio: Boolean(timing),
      confidence: timing?.confidence ?? null,
      doubtful: timing ? timing.confidence < CONFIDENCE_FLOOR : false,
      seconds: timing ? Number((timing.end - timing.start).toFixed(2)) : null,
    });
  }

  // A reference may overshoot the end of the sura (110:1-4, where An-Nasr has
  // three verses). Report the range that exists, not the one that was asked
  // for, or `build` inherits a verse number that was never there.
  const actualTo = verses.length ? verses[verses.length - 1].ayah : range.from;

  res.json({
    surah: range.surah,
    surahName: SURAH_NAMES[range.surah]?.english ?? `Surah ${range.surah}`,
    from: range.from,
    to: actualTo,
    requestedTo: last !== actualTo ? last : undefined,
    matchedBy: range.matchedBy,
    indexed: timings !== null,
    verses,
  });
});

/** Cuts the audio for a resolved range and returns the file to download. */
router.post("/build", async (req: Request, res: Response) => {
  const surah = Number(req.body?.surah);
  const from = Number(req.body?.from);
  const to = Number(req.body?.to ?? from);

  if (!surah || !from || surah < 1 || surah > 114 || to < from) {
    return res.status(400).json({ error: "Bad range" });
  }

  const { arabic } = await loadSources();
  let verseCount = 0;
  while (arabic.has(verseKey(surah, verseCount + 1))) {
    verseCount += 1;
  }
  if (from > verseCount || to > verseCount) {
    return res.status(400).json({
      error: `Surah ${surah} has ${verseCount} verses; asked for ${from}-${to}`,
    });
  }

  const timings = await loadSurahTimings(surah);
  if (!timings) {
    return res.status(409).json({
      error:
        `Surah ${surah} has not been indexed yet. Run: npm run align -- ${surah}`,
    });
  }

  // No reciter means Tamil alone, which is what this app did before the Arabic
  // was an option. An unknown one is rejected rather than quietly replaced by
  // the default: the operator would get a clip in a voice they did not pick.
  const requested = req.body?.reciter ? String(req.body.reciter) : null;
  const reciter = requested ? findReciter(requested) : null;
  if (requested && !reciter) {
    return res.status(400).json({ error: `Unknown reciter: ${requested}` });
  }

  const first = timings.get(verseKey(surah, from));
  const final = timings.get(verseKey(surah, to));
  if (!first || !final) {
    return res.status(409).json({
      error: `Verses ${from}-${to} are not in the index for surah ${surah}`,
    });
  }

  if (!reciter) {
    try {
      const name = await buildClip({
        surah,
        from,
        to,
        start: first.start,
        end: final.end,
      });
      return res.json({
        file: name,
        url: `/api/clips/file/${name}`,
        seconds: Number((final.end - first.start).toFixed(2)),
        confidence: Math.min(first.confidence, final.confidence),
      });
    } catch (error) {
      return res.status(500).json({ error: (error as Error).message });
    }
  }

  // Interleaving needs a boundary for every verse, not just the two ends. A
  // straight Tamil cut only needs where the range starts and stops, so a gap
  // in the middle of the index goes unnoticed there — here it would drop a
  // verse out of the alternation without saying so.
  // Verses whose narration belongs to somebody else. Their Arabic still plays;
  // the Tamil is left out rather than serving another verse's words.
  const { tamil: tamilText } = await loadSources();
  const defects = defectiveVerses(surah, timings, tamilText);

  const verses = [];
  const confidences: number[] = [];
  const skipped: number[] = [];
  for (let ayah = from; ayah <= to; ayah += 1) {
    const timing = timings.get(verseKey(surah, ayah));
    if (!timing) {
      return res.status(409).json({
        error:
          `Verse ${surah}:${ayah} is not in the index, so it cannot be paired ` +
          `with its recitation. Re-align surah ${surah}.`,
      });
    }
    const skipTamil = defects.has(ayah);
    if (skipTamil) skipped.push(ayah);
    verses.push({ ayah, start: timing.start, end: timing.end, skipTamil });
    confidences.push(timing.confidence);
  }

  try {
    const recitations = await ensureRange(reciter.id, surah, from, to);
    const built = await buildMixedClip({
      surah,
      from,
      to,
      reciterId: reciter.id,
      verses,
      arabic: recitations,
    });
    res.json({
      file: built.name,
      url: `/api/clips/file/${built.name}`,
      seconds: built.seconds,
      confidence: Math.min(...confidences),
      reciter: reciter.name,
      // Said plainly rather than left to be noticed: a clip quietly missing a
      // translation is worse than one that says which.
      ...(skipped.length ? { tamilSkipped: skipped } : {}),
    });
  } catch (error) {
    // A download failure is the remote host's, not a bug here — 502 keeps the
    // two apart in the log when a build starts failing.
    const message = (error as Error).message;
    const remote = message.includes("everyayah.com");
    res.status(remote ? 502 : 500).json({ error: message });
  }
});

/**
 * A clip's file name, exactly.
 *
 * Tamil-only clips are `114-001.mp3` or `114-001-006.mp3`; an Arabic-and-Tamil
 * clip carries the reciter, `114-001-006-ar-Alafasy_128kbps.mp3`.
 *
 * Shared by serving and deleting rather than written twice: the delete side is
 * where a pattern that drifted loose would cost a file, and a reel — which
 * lives in a sub-folder and is named `reel-001-001-007.mp4` — must never match.
 */
const CLIP_NAME = /^\d{3}-\d{3}(-\d{3})?(-ar-[A-Za-z0-9_-]+)?\.mp3$/;

router.get("/file/:name", (req: Request, res: Response) => {
  // Serve only from the output directory, by exact basename.
  const name = path.basename(String(req.params.name));
  if (!CLIP_NAME.test(name)) {
    return res.status(400).json({ error: "Bad file name" });
  }
  res.sendFile(path.join(config.paths.output, name));
});

/**
 * Removes one built clip.
 *
 * Clips accumulate — one per range per reciter, and a long passage runs to
 * megabytes — so the dashboard offers to delete the one just built rather than
 * leaving the operator to find it on disk. Only a clip: `basename` and
 * CLIP_NAME together mean nothing outside `output/`, and no reel or cover, can
 * be named here.
 *
 * A file that is already gone is a success, not an error: the button is next
 * to Download and a double click should not report a failure.
 */
router.delete("/file/:name", async (req: Request, res: Response) => {
  const name = path.basename(String(req.params.name));
  if (!CLIP_NAME.test(name)) {
    return res.status(400).json({ error: "Bad file name" });
  }
  try {
    await fs.unlink(path.join(config.paths.output, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return res.status(500).json({ error: `Could not delete ${name}` });
    }
  }
  res.json({ deleted: name });
});

export default router;
