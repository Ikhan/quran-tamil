/**
 * What a batch would produce, verse by verse, before anything is rendered.
 *
 * A reel is worth posting or it is not, and both ways of failing are knowable
 * from the text and the index alone:
 *
 *   type too small   The whole verse always goes on one frame — never split,
 *                    because a split would put the highlight on a page the
 *                    viewer is not looking at. So a long verse is set smaller
 *                    until it fits. Below ~30px Tamil stops being readable at
 *                    phone size: ண against ன and ற against ர differ by strokes
 *                    that thin out first.
 *
 *   reel too long    Past 90s it is long for the format.
 *
 * Both are computed with the same `layoutVerse` the composition draws with, so
 * the number shown here is the size the reel will actually use — not an
 * estimate of it.
 */
import { loadArabicTimings } from "./arabicTimings.js";
import { loadSources, verseKey } from "./quranSources.js";
import { postFolder } from "./outputPaths.js";
import { reelFileName } from "./reelBuilder.js";
import { loadSurahTimings } from "./timings.js";
import { config } from "../config/config.js";
import { layoutVerse } from "../../src/lib/layout.js";
import fs from "fs/promises";
import path from "path";

/** Below this the Tamil is too small to read on a phone. */
export const MIN_READABLE_PX = 30;

/** Past this a reel is long for the format. */
export const MAX_REEL_SECONDS = 90;

export interface PreflightVerse {
  ayah: number;
  /** The size `layoutVerse` settles on for this verse's Tamil. */
  tamilSize: number;
  /** Tamil translation only. */
  tamilSeconds: number;
  /** The recitation, when a reciter was named. */
  arabicSeconds: number | null;
  /** What the reel will run to — both, since they play one after the other. */
  totalSeconds: number;
  /** Already rendered; a batch would skip it. */
  rendered: boolean;
  /** Not in the index, so it cannot be rendered at all. */
  missing: boolean;
  /** "small" | "long" — advisory, in the order a reader would notice them. */
  warnings: string[];
}

export const preflight = async (
  surah: number,
  from: number,
  to: number,
  reciterId: string | null,
  dark = false
): Promise<PreflightVerse[]> => {
  const { arabic, tamil } = await loadSources();
  const timings = await loadSurahTimings(surah);
  const recitation = reciterId
    ? await loadArabicTimings(reciterId).catch(() => null)
    : null;

  const out: PreflightVerse[] = [];
  for (let ayah = from; ayah <= to; ayah += 1) {
    const key = verseKey(surah, ayah);
    const arabicText = arabic.get(key);
    if (!arabicText) {
      break; // past the end of the sura
    }

    const tamilText = tamil.get(key) ?? "";
    const { tamilSize } = layoutVerse(arabicText, tamilText);

    const timing = timings?.get(key);
    const tamilSeconds = timing ? timing.end - timing.start : 0;

    let arabicSeconds: number | null = null;
    const segments = recitation?.get(key);
    if (segments?.length) {
      const start = Math.min(...segments.map(([, , ms]) => ms));
      const end = Math.max(...segments.map(([, , , ms]) => ms));
      arabicSeconds = (end - start) / 1000;
    }

    const totalSeconds = tamilSeconds + (arabicSeconds ?? 0);

    // The palette is part of the file name, so "already rendered" has to be
    // asked about the one that would actually be made. Asked about the other,
    // a dark reel already on disk reads as missing and a batch remakes it in
    // the wrong colour alongside.
    const name = path.join(
      await postFolder(surah, ayah, ayah),
      reelFileName(surah, ayah, ayah, dark)
    );
    const rendered = await fs
      .access(path.join(config.paths.output, name))
      .then(() => true)
      .catch(() => false);

    const warnings: string[] = [];
    if (tamilSize < MIN_READABLE_PX) warnings.push("small");
    if (totalSeconds > MAX_REEL_SECONDS) warnings.push("long");

    out.push({
      ayah,
      tamilSize,
      tamilSeconds: Number(tamilSeconds.toFixed(1)),
      arabicSeconds:
        arabicSeconds === null ? null : Number(arabicSeconds.toFixed(1)),
      totalSeconds: Number(totalSeconds.toFixed(1)),
      rendered,
      missing: !timing,
      warnings,
    });
  }

  return out;
};
