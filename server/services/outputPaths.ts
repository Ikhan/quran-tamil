/**
 * Where a finished reel and its cover are written.
 *
 * One folder per sura, one folder per range inside it, so everything belonging
 * to a single post sits together:
 *
 *   output/001-al-faatiha/full/reel-001-001-007.mp4
 *   output/001-al-faatiha/full/cover-001-001-007.png
 *   output/055-ar-rahmaan/13-18/reel-055-013-018.mp4
 *
 * The sura folder keeps its number: it sorts the directory into mushaf order,
 * and it keeps two suras that slug to the same name apart. The file names are
 * left carrying the range as well — a file dragged out of its folder and into
 * a scheduler still says what it is.
 *
 * Everything rendered before this layout existed sits flat in `output/`, so
 * `safeOutputPath` still accepts a bare name; the history listing finds both.
 */
import path from "path";
import { config } from "../config/config.js";
import { loadSources, verseKey } from "./quranSources.js";
import { SURAH_NAMES } from "./surahNames.js";

const pad3 = (value: number) => String(value).padStart(3, "0");

/**
 * "Al-An'aam" -> "al-anaam".
 *
 * Apostrophes are dropped rather than turned into a separator: "al-an-aam"
 * reads as a word break that is not in the name.
 */
const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const surahFolder = (surah: number): string =>
  `${pad3(surah)}-${slug(SURAH_NAMES[surah]?.english ?? `surah-${surah}`)}`;

const counts = new Map<number, number>();

/** How many verses a sura has, counted once from the vendored Arabic. */
export const verseCount = async (surah: number): Promise<number> => {
  const known = counts.get(surah);
  if (known !== undefined) {
    return known;
  }

  const { arabic } = await loadSources();
  let total = 0;
  while (arabic.has(verseKey(surah, total + 1))) {
    total += 1;
  }

  counts.set(surah, total);
  return total;
};

/**
 * Everything for one sura in one folder, relative to `output/`.
 *
 * A post's three files are found by their names, not by their folder:
 * `reel-002-009.mp4`, `cover-002-009.jpg`, `caption-002-009.txt` sort together
 * and cannot collide, because every name already carries the range.
 *
 * This used to be a folder per post — sura, then range — on the reasoning that
 * what is posted together should be found together. In practice a week is
 * scheduled by uploading twelve reels at once, and a folder each meant twelve
 * trips into and out of a directory. One folder per sura is what that workflow
 * actually wants.
 *
 * `from` and `to` are still taken so callers need not change and so the older
 * layout stays readable; they no longer affect where a file is written.
 */
export const postFolder = async (
  surah: number,
  _from: number,
  _to: number
): Promise<string> => surahFolder(surah);

/** The same folder, created and absolute. */
export const postDir = async (
  surah: number,
  from: number,
  to: number
): Promise<string> => path.join(config.paths.output, await postFolder(surah, from, to));

const SURAH_SEGMENT = /^\d{3}-[a-z0-9-]+$/;
const RANGE_SEGMENT = /^(full|\d+(-\d+)?)$/;

export const REEL_FILE = /^reel-\d{3}-\d{3}(-\d{3})?(-dark)?\.mp4$/;
export const COVER_FILE = /^cover-\d{3}-\d{3}(-\d{3})?\.png$/;

/**
 * Resolves a client-supplied path inside `output/`, or null.
 *
 * Every segment is matched against an anchored pattern, so a `..` cannot get
 * through: it matches none of them. Nothing is trusted from the request beyond
 * the shapes this layout actually produces.
 */
export const safeOutputPath = (
  relative: string,
  name: RegExp
): string | null => {
  const parts = relative.split("/").filter(Boolean);
  const base = parts.pop();
  if (!base || !name.test(base)) {
    return null;
  }

  // Flat: everything rendered before the per-sura layout.
  if (parts.length === 0) {
    return path.join(config.paths.output, base);
  }

  // One sura folder, the current shape.
  if (parts.length === 1 && SURAH_SEGMENT.test(parts[0])) {
    return path.join(config.paths.output, parts[0], base);
  }

  // Sura then range: everything rendered before the flattening. Still served,
  // because moving files under someone breaks whatever already points at them.
  if (
    parts.length !== 2 ||
    !SURAH_SEGMENT.test(parts[0]) ||
    !RANGE_SEGMENT.test(parts[1])
  ) {
    return null;
  }

  return path.join(config.paths.output, parts[0], parts[1], base);
};
