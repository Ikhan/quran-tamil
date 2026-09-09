/**
 * Where each Arabic word falls inside its verse's recitation.
 *
 * From cpfair/quran-align, vendored as `data/timings-<reciter>.json` — the same
 * data and the same files the reels project uses, because it is the same audio
 * from everyayah.com.
 *
 * **The whole thing hangs on one invariant:** a verse's words are
 * `quran-uthmani.txt` split on spaces, and the timing file's indices are
 * offsets into exactly that. Do not "tidy" the Arabic — normalising a space or
 * a mark shifts every highlight after it, silently.
 */
import fs from "fs/promises";
import path from "path";
import { config } from "../config/config.js";
import type { ArabicWord } from "../../src/lib/tamilTypes.js";
import { verseKey, type VerseKey } from "./quranSources.js";

/** `[firstWord, lastWord + 1, startMs, endMs]`. */
export type RawSegment = [number, number, number, number];

interface RawTiming {
  surah: number;
  ayah: number;
  segments: RawSegment[];
}

const cache = new Map<string, Map<VerseKey, RawSegment[]>>();

export const loadArabicTimings = async (
  reciterId: string
): Promise<Map<VerseKey, RawSegment[]>> => {
  const hit = cache.get(reciterId);
  if (hit) {
    return hit;
  }

  const file = path.join(config.paths.data, `timings-${reciterId}.json`);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch {
    throw new Error(
      `No Arabic word timings for ${reciterId} (${path.basename(file)}). ` +
        `Word-by-word highlighting needs them; pick another reciter.`
    );
  }

  const map = new Map<VerseKey, RawSegment[]>(
    (JSON.parse(raw) as RawTiming[]).map((entry) => [
      verseKey(entry.surah, entry.ayah),
      entry.segments,
    ])
  );
  cache.set(reciterId, map);

  return map;
};

/**
 * Refuses a verse whose timings do not fit its words.
 *
 * Cheap to check and worth checking: a silent off-by-one here would light the
 * wrong word of scripture on every reel, which is the one failure this project
 * cannot ship.
 */
export const assertAligned = (
  key: VerseKey,
  words: string[],
  segments: RawSegment[]
): void => {
  if (segments.length === 0) {
    throw new Error(`${key}: no word timings in the recitation data`);
  }

  const furthest = Math.max(...segments.map(([, end]) => end));
  if (furthest > words.length) {
    throw new Error(
      `${key}: timings reference word ${furthest} but the verse has ` +
        `${words.length}. The Arabic text and the timing data have gone out ` +
        `of step.`
    );
  }
};

/**
 * Turns one verse's segments into per-word frame ranges.
 *
 * Words the aligner did not cover — it occasionally merges or drops one — are
 * given the gap between their neighbours rather than left dark, so the
 * highlight never stalls mid-verse.
 */
export const toWordTimings = (
  arabic: string,
  segments: RawSegment[],
  fps: number
): ArabicWord[] => {
  const words = arabic.split(/\s+/).filter(Boolean);
  const toFrame = (ms: number) => Math.round((ms / 1000) * fps);
  const timed: (ArabicWord | undefined)[] = words.map(() => undefined);

  for (const [start, end, startMs, endMs] of segments) {
    const spans = Math.max(1, end - start);
    for (let index = start; index < end && index < words.length; index += 1) {
      timed[index] = {
        text: words[index],
        fromFrame: toFrame(startMs),
        toFrame: toFrame(endMs),
        grouped: spans > 1,
      };
    }
  }

  return words.map((text, index) => {
    const existing = timed[index];
    if (existing) {
      return existing;
    }

    const previousEnd = timed.slice(0, index).reverse().find(Boolean)?.toFrame;
    const nextStart = timed.slice(index + 1).find(Boolean)?.fromFrame;

    return {
      text,
      fromFrame: previousEnd ?? 0,
      toFrame: nextStart ?? previousEnd ?? 0,
      grouped: true,
    };
  });
};

/**
 * How long a range takes to recite, in seconds, for one reciter.
 *
 * A verse's span is its first word's start to its last word's end — the same
 * segments the highlighting uses, so the number cannot drift from what is
 * actually played. Reciters differ enormously here (Mujawwad runs to twice
 * Murattal on the same verse), which is the whole reason this is per-reciter
 * rather than one figure for the range.
 *
 * A verse with no timings contributes nothing rather than throwing: the total
 * is an estimate shown before a build, and one gap should round the figure
 * down, not blank the panel.
 */
export const recitationSeconds = async (
  reciterId: string,
  surah: number,
  from: number,
  to: number
): Promise<number> => {
  const timings = await loadArabicTimings(reciterId);
  let total = 0;
  for (let ayah = from; ayah <= to; ayah += 1) {
    const segments = timings.get(verseKey(surah, ayah));
    if (!segments?.length) {
      continue;
    }
    const start = Math.min(...segments.map(([, , startMs]) => startMs));
    const end = Math.max(...segments.map(([, , , endMs]) => endMs));
    total += (end - start) / 1000;
  }
  return total;
};
