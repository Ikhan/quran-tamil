/**
 * Turns a resolved verse range into the job file the composition renders from,
 * and hands that to Remotion.
 *
 * Shared by the CLI (`npm run reel`) and the dashboard, so a reel made either
 * way is the same reel. Every timing is resolved to frames here — the
 * composition never works out when a word is spoken, it only draws what it is
 * told.
 */
import { execFile } from "child_process";
import fs from "fs/promises";
import path from "path";
import { promisify } from "util";
import { PROJECT_ROOT, config } from "../config/config.js";
import {
  assertAligned,
  loadArabicTimings,
  toWordTimings,
} from "./arabicTimings.js";
import { postFolder } from "./outputPaths.js";
import { defectiveVerses, RATE } from "./verseDefects.js";
import { loadSources, verseKey } from "./quranSources.js";
import { ensureRecitation } from "./recitations.js";
import { findReciter } from "./reciters.js";
import { SURAH_NAMES } from "./surahNames.js";
import { loadSurahTimings } from "./timings.js";
import { FPS, layoutVerse } from "../../src/lib/layout.js";
import type { TamilReelFile, TamilVerse } from "../../src/lib/tamilTypes.js";

const run = promisify(execFile);

/** Remotion serves audio from here, and only from here. */
export const PUBLIC_AUDIO = path.join(PROJECT_ROOT, "public", "audio");
export const JOB_FILE = path.join(PROJECT_ROOT, "src", "data", "reelData.json");

/**
 * Silences between the two languages, matching the dashboard's audio mixer.
 *
 * `afterArabic` is short: the translation answers the recitation, and a long
 * hole between them reads as a mistake. `betweenVerses` is longer, because it
 * is the only thing telling a listener that one verse has ended.
 */
const GAP_AFTER_ARABIC = 0.45;
const GAP_BETWEEN_VERSES = 0.9;

const pad3 = (value: number) => String(value).padStart(3, "0");
const toFrames = (seconds: number) => Math.round(seconds * FPS);

const measure = async (file: string): Promise<number> => {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "csv=p=0",
    file,
  ]);

  const seconds = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(seconds)) {
    throw new Error(`ffprobe could not measure ${path.basename(file)}`);
  }

  return seconds;
};

/**
 * Copies a cached recitation into `public/` and gives it an ID3 header.
 *
 * everyayah serves bare MPEG streams. Remotion's media parser identifies mp3 by
 * the `ID3` magic bytes and rejects a file without them outright, which fails
 * the render with `Unknown file format` and names no file. `-c copy` remuxes:
 * the audio is untouched, only a header is added.
 */
const publishArabic = async (
  reciterId: string,
  surah: number,
  ayah: number
): Promise<string> => {
  const cached = await ensureRecitation(reciterId, surah, ayah);
  const name = `${reciterId}_${pad3(surah)}${pad3(ayah)}.mp3`;
  const dest = path.join(PUBLIC_AUDIO, name);

  if (!(await fs.access(dest).then(() => true, () => false))) {
    await run("ffmpeg", [
      "-v", "error", "-y",
      "-i", cached,
      "-c", "copy", "-write_id3v2", "1",
      dest,
    ]);
  }

  return name;
};

/** Cuts one Tamil verse out of its surah mp3, into `public/`. */
const publishTamil = async (
  surah: number,
  ayah: number,
  start: number,
  end: number
): Promise<string> => {
  const { leadIn, tailOut } = config.clip;
  const from = Math.max(0, start - leadIn);
  const duration = end - start + leadIn + tailOut;
  if (duration <= 0) {
    throw new Error(`Refusing to cut a zero-length clip for ${surah}:${ayah}`);
  }

  const name = `tamil_${pad3(surah)}${pad3(ayah)}.mp3`;
  const dest = path.join(PUBLIC_AUDIO, name);

  // Re-encoded, never stream-copied: a copy can only cut on a frame boundary
  // and carries the original encoder delay, which is audible as a click.
  await run("ffmpeg", [
    "-v", "error", "-y",
    "-ss", from.toFixed(3),
    "-t", duration.toFixed(3),
    "-i", path.join(config.paths.data, `${pad3(surah)}.mp3`),
    "-map", "0:a",
    "-c:a", "libmp3lame", "-q:a", "2",
    "-af",
    `afade=t=in:st=0:d=0.06,afade=t=out:st=${Math.max(
      0,
      duration - 0.12
    ).toFixed(3)}:d=0.12`,
    "-write_id3v2", "1",
    dest,
  ]);

  return name;
};

export interface StageRequest {
  surah: number;
  from: number;
  /** 0 means "to the end of the sura". */
  to: number;
  reciterId: string;
  onProgress?: (message: string) => void;
}

export const stageReel = async ({
  surah,
  from,
  to,
  reciterId,
  onProgress,
}: StageRequest): Promise<TamilReelFile> => {
  const reciter = findReciter(reciterId);
  if (!reciter) {
    throw new Error(`Unknown reciter: ${reciterId}`);
  }

  const { arabic: arabicText, tamil: tamilText } = await loadSources();
  const arabicTimings = await loadArabicTimings(reciter.id);

  const tamilIndex = await loadSurahTimings(surah);
  if (!tamilIndex) {
    throw new Error(
      `Surah ${surah} has not been indexed yet. Run: npm run align -- ${surah}`
    );
  }

  // Worked out once for the whole surah rather than per verse: the test needs
  // every placement to see which sit out of sequence.
  const defects = defectiveVerses(surah, tamilIndex, tamilText);

  let ayahCount = 0;
  while (arabicText.has(verseKey(surah, ayahCount + 1))) {
    ayahCount += 1;
  }

  // A reference may overshoot the end of the sura — 110:1-4, where An-Nasr has
  // three verses — so the range is clamped to what exists rather than trusted.
  const first = Math.max(1, from);
  const last = Math.min(to || ayahCount, ayahCount);
  if (first > ayahCount) {
    throw new Error(
      `Surah ${surah} has ${ayahCount} verses; asked to start at ${first}`
    );
  }

  await fs.mkdir(PUBLIC_AUDIO, { recursive: true });

  const verses: TamilVerse[] = [];
  let cursor = 0;

  for (let ayah = first; ayah <= last; ayah += 1) {
    const key = verseKey(surah, ayah);
    const arabic = arabicText.get(key) ?? "";
    const segments = arabicTimings.get(key) ?? [];
    assertAligned(key, arabic.split(/\s+/).filter(Boolean), segments);

    const timing = tamilIndex.get(key);
    if (!timing) {
      throw new Error(
        `${key} is not in the Tamil index, so it cannot be paired with its ` +
          `recitation. Re-align surah ${surah}.`
      );
    }

    onProgress?.(`preparing ${key}`);
    const arabicFile = await publishArabic(reciter.id, surah, ayah);

    // A verse whose narration is unusable is cut out of the reel's audio but
    // kept on its card: the translation is correct and worth reading, and the
    // Arabic recitation beneath it is from a different source and unaffected.
    // Playing what is there instead would put another verse's words under this
    // verse's text, which is the one failure worth going quiet for.
    const skipped = defects.get(ayah);
    const tamilFile = skipped
      ? null
      : await publishTamil(surah, ayah, timing.start, timing.end);

    const arabicFrames = toFrames(
      await measure(path.join(PUBLIC_AUDIO, arabicFile))
    );
    // With no track to measure, the text sets its own pace — the same
    // seconds-per-character the index is built on, so a silent verse is held
    // for about as long as it would have taken to recite.
    const tamilFrames = tamilFile
      ? toFrames(await measure(path.join(PUBLIC_AUDIO, tamilFile)))
      : toFrames((tamilText.get(key) ?? "").length * RATE);

    const arabicStart = cursor;
    const tamilStart = arabicStart + arabicFrames + toFrames(GAP_AFTER_ARABIC);
    cursor =
      tamilStart +
      tamilFrames +
      (ayah === last ? 0 : toFrames(GAP_BETWEEN_VERSES));

    // Split by the same measure the card draws it at, so a line's share of the
    // audio belongs to the line actually on screen.
    const tamil = tamilText.get(key) ?? "";
    const { tamilLines } = layoutVerse(arabic, tamil);
    const totalChars =
      tamilLines.reduce((sum, line) => sum + line.length, 0) || 1;
    let lineCursor = 0;

    verses.push({
      ayah,
      arabic,
      words: toWordTimings(arabic, segments, FPS),
      arabicAudio: `audio/${arabicFile}`,
      arabicStart,
      arabicFrames,
      tamil,
      tamilAudio: tamilFile ? `audio/${tamilFile}` : null,
      tamilStart,
      tamilFrames,
      ...(skipped ? { tamilSkipped: skipped } : {}),
      confidence: timing.confidence,
      lines: tamilLines.map((text) => {
        // Each line earns the share of the audio its length implies.
        const share = Math.round((text.length / totalChars) * tamilFrames);
        const at = lineCursor;
        lineCursor += share;
        return { text, fromFrame: at, toFrame: lineCursor };
      }),
    });
  }

  const names = SURAH_NAMES[surah];
  const file: TamilReelFile = {
    createdAt: new Date().toISOString(),
    surah,
    surahName: names?.english ?? `Surah ${surah}`,
    surahNameArabic: names?.arabic ?? "",
    reference:
      `${names?.english ?? surah} ${surah}:${first}` +
      (last === first ? "" : `-${last}`),
    reciter: reciter.id,
    durationInFrames: cursor,
    verses,
  };

  await fs.mkdir(path.dirname(JOB_FILE), { recursive: true });
  await fs.writeFile(JOB_FILE, JSON.stringify(file, null, 2));

  return file;
};

/** The first and last verse actually staged. */
const spanOf = (file: TamilReelFile): [number, number] => {
  const first = file.verses[0]?.ayah ?? 1;
  return [first, file.verses[file.verses.length - 1]?.ayah ?? first];
};

/**
 * The output name carries the range and the palette, not just the sura: two
 * reels cut from one sura must not write to the same file, or the second
 * silently replaces the first. It repeats what the folder says so that a file
 * dragged out of its folder still names itself.
 */
export const reelFileName = (
  surah: number,
  first: number,
  last: number,
  dark: boolean
): string =>
  `reel-${pad3(surah)}-${pad3(first)}` +
  (last === first ? "" : `-${pad3(last)}`) +
  (dark ? "-dark" : "") +
  ".mp4";

export const reelName = (file: TamilReelFile, dark: boolean): string => {
  const [first, last] = spanOf(file);
  return reelFileName(file.surah, first, last, dark);
};

/** Where the reel lands, relative to `output/` — sura folder, range, name. */
export const reelPath = async (
  file: TamilReelFile,
  dark: boolean
): Promise<string> => {
  const [first, last] = spanOf(file);
  return path.join(await postFolder(file.surah, first, last), reelName(file, dark));
};

export const renderStaged = async (
  file: TamilReelFile,
  dark = false
): Promise<string> => {
  const relative = await reelPath(file, dark);
  const dest = path.join(config.paths.output, relative);
  await fs.mkdir(path.dirname(dest), { recursive: true });

  await run(
    "npx",
    [
      "remotion",
      "render",
      "src/index.ts",
      dark ? "TamilCardDark" : "TamilCard",
      dest,
    ],
    { cwd: PROJECT_ROOT, maxBuffer: 64 * 1024 * 1024 }
  );

  return relative;
};
