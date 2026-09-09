/**
 * The verse-timing index: where each verse begins and ends inside its surah mp3.
 *
 * The audio is one file per surah with nothing marking verse boundaries, so
 * this index is the only thing that makes a single verse addressable. It is
 * built offline by `scripts/align_tamil.py` — see that file for how.
 *
 * The index is read per-surah, so a partially built index is usable: surahs
 * that have been aligned work, the rest report themselves as not yet indexed
 * rather than failing.
 */
import fs from "fs/promises";
import path from "path";
import { config } from "../config/config.js";
import { verseKey, type VerseKey } from "./quranSources.js";

export interface VerseTiming {
  start: number;
  end: number;
  confidence: number;
  /** Re-aligned by the repair pass after the first attempt was rejected. */
  repaired?: boolean;
}

interface SurahPart {
  surah: number;
  duration: number;
  ayahCount: number;
  complete: boolean;
  placed: Array<{
    ayah: number;
    start: number;
    end: number;
    confidence: number;
    repaired?: boolean;
  }>;
}

/** Below this a placement is shown as doubtful rather than served silently. */
export const CONFIDENCE_FLOOR = 0.5;

/**
 * Parsed parts, keyed by surah and stamped with the file's mtime.
 *
 * The stamp is what makes it safe to cache: part files are rewritten while the
 * server runs — a surah gets indexed for the first time, or an existing one is
 * re-aligned and repaired — and a cache that never rechecked served the old
 * answer until someone restarted. A cached *miss* was worse: a surah read
 * before it was indexed stayed "not indexed" for the life of the process, so
 * finishing an alignment appeared to do nothing.
 */
interface CacheEntry {
  mtimeMs: number | null;
  verses: Map<VerseKey, VerseTiming> | null;
}

const cache = new Map<number, CacheEntry>();

const partPath = (surah: number) =>
  path.join(config.paths.timings, `${String(surah).padStart(3, "0")}.json`);

/** Returns null when the surah has not been indexed yet. */
export const loadSurahTimings = async (
  surah: number
): Promise<Map<VerseKey, VerseTiming> | null> => {
  // One stat per call, against re-reading and re-parsing a file that can run
  // to a few hundred KB. A surah that is still absent stats as null and is
  // simply looked at again next time.
  let mtimeMs: number | null = null;
  try {
    mtimeMs = (await fs.stat(partPath(surah))).mtimeMs;
  } catch {
    mtimeMs = null;
  }

  const hit = cache.get(surah);
  if (hit && hit.mtimeMs === mtimeMs) {
    return hit.verses;
  }

  if (mtimeMs === null) {
    cache.set(surah, { mtimeMs: null, verses: null });
    return null;
  }

  let part: SurahPart;
  try {
    part = JSON.parse(await fs.readFile(partPath(surah), "utf-8"));
  } catch {
    // Present but unreadable — a part file caught mid-write, though the
    // aligner renames into place to avoid exactly that. Not cached against
    // this mtime, so the next call retries rather than serving the failure.
    return null;
  }

  const verses = new Map<VerseKey, VerseTiming>();
  for (const p of part.placed) {
    // Label 0 is the bismillah, aligned only so it does not bleed into verse 1.
    if (p.ayah > 0) {
      verses.set(verseKey(surah, p.ayah), {
        start: p.start,
        end: p.end,
        confidence: p.confidence,
        repaired: p.repaired,
      });
    }
  }

  cache.set(surah, { mtimeMs, verses });
  return verses;
};

/** Which surahs are indexed — the dashboard shows this so gaps are visible. */
export const coverage = async (): Promise<number[]> => {
  let names: string[];
  try {
    names = await fs.readdir(config.paths.timings);
  } catch {
    return [];
  }

  return names
    .filter((n) => n.endsWith(".json"))
    .map((n) => Number(n.replace(".json", "")))
    .filter((n) => n >= 1 && n <= 114)
    .sort((a, b) => a - b);
};
