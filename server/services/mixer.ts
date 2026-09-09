/**
 * Arabic recitation and Tamil translation, alternating one verse at a time.
 *
 * Verse by verse rather than surah by surah: the recitation and its meaning
 * belong next to each other, and interleaving is the only reason the verse
 * index exists — appending a whole Tamil surah after a whole Arabic one would
 * need no index at all.
 *
 * The two sources have nothing in common technically. The Arabic arrives from
 * everyayah at whatever sample rate and bitrate that reciter was encoded at
 * (40kbps mono up to 192kbps), and the Tamil is cut live out of a surah-length
 * mp3. Concatenating streams that disagree on rate or channel count produces
 * either a refusal or, worse, audio that plays at the wrong speed. So every
 * piece is decoded to one common PCM format first, joined, and encoded once at
 * the end — which also means the Tamil is never encoded twice.
 */
import { execFile } from "child_process";
import fs from "fs/promises";
import path from "path";
import { promisify } from "util";
import { config } from "../config/config.js";
import { fadeFilter } from "./clipper.js";

const run = promisify(execFile);

/** The format every piece is decoded to before being joined. */
const RATE = 44100;
const CHANNELS = 2;

export interface MixVerse {
  ayah: number;
  /** Where this verse sits inside the surah mp3, from the timing index. */
  start: number;
  end: number;
  /**
   * The narration here belongs to another verse, so leave it out. The Arabic
   * still plays; only the Tamil is dropped.
   */
  skipTamil?: boolean;
}

export interface MixRequest {
  surah: number;
  from: number;
  to: number;
  reciterId: string;
  verses: readonly MixVerse[];
  /** Local paths to the Arabic mp3s, in verse order. */
  arabic: readonly string[];
}

const pad3 = (value: number) => String(value).padStart(3, "0");

const surahSource = (surah: number) =>
  path.join(config.paths.data, `${pad3(surah)}.mp3`);

/**
 * The reciter id is part of the name on purpose. Rebuilding the same verses in
 * a different voice would otherwise write to the same path, and the dashboard
 * would play the previous voice out of the browser cache while reporting the
 * new one.
 */
export const mixedClipName = (
  surah: number,
  from: number,
  to: number,
  reciterId: string
): string =>
  `${pad3(surah)}-${pad3(from)}` +
  (to === from ? "" : `-${pad3(to)}`) +
  `-ar-${reciterId}.mp3`;

/** Decodes a whole file to the common format, with silence added after it. */
const arabicPiece = async (
  source: string,
  dest: string,
  padAfter: number
): Promise<void> => {
  await run("ffmpeg", [
    "-v", "error",
    "-y",
    "-i", source,
    "-map", "0:a",
    "-af", `apad=pad_dur=${padAfter.toFixed(3)}`,
    "-ar", String(RATE),
    "-ac", String(CHANNELS),
    "-c:a", "pcm_s16le",
    dest,
  ]);
};

/** Cuts one verse out of the surah mp3, faded and padded, in that format. */
const tamilPiece = async (
  surah: number,
  verse: MixVerse,
  dest: string,
  padAfter: number
): Promise<void> => {
  const { leadIn, tailOut } = config.clip;
  const start = Math.max(0, verse.start - leadIn);
  const duration = verse.end - verse.start + leadIn + tailOut;

  if (duration <= 0) {
    throw new Error(
      `Refusing to cut a zero-length clip for ${surah}:${verse.ayah}`
    );
  }

  await run("ffmpeg", [
    "-v", "error",
    "-y",
    "-ss", start.toFixed(3),
    "-t", duration.toFixed(3),
    "-i", surahSource(surah),
    "-map", "0:a",
    "-af", `${fadeFilter(duration)},apad=pad_dur=${padAfter.toFixed(3)}`,
    "-ar", String(RATE),
    "-ac", String(CHANNELS),
    "-c:a", "pcm_s16le",
    dest,
  ]);
};

/** Seconds of audio, read from the finished file rather than added up. */
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

export interface MixResult {
  name: string;
  seconds: number;
}

export const buildMixedClip = async (req: MixRequest): Promise<MixResult> => {
  if (req.verses.length !== req.arabic.length) {
    throw new Error("Every verse needs its Arabic recitation");
  }

  const name = mixedClipName(req.surah, req.from, req.to, req.reciterId);
  const dest = path.join(config.paths.output, name);

  // One scratch directory per build, named after the clip, so two builds
  // running at once cannot overwrite each other's pieces.
  const work = path.join(config.paths.output, ".work", name);
  await fs.rm(work, { recursive: true, force: true });
  await fs.mkdir(work, { recursive: true });
  await fs.mkdir(config.paths.output, { recursive: true });

  try {
    const pieces: string[] = [];

    for (const [index, verse] of req.verses.entries()) {
      const last = index === req.verses.length - 1;
      const ar = path.join(work, `${pad3(verse.ayah)}-ar.wav`);
      const ta = path.join(work, `${pad3(verse.ayah)}-ta.wav`);

      // A verse whose narration is unusable contributes its Arabic and
      // nothing else. Omitted rather than left as silence: a clip has no text
      // on screen to read during a gap, so silence would only sound broken.
      // The caller is told which verses lost their Tamil so it can say so.
      if (verse.skipTamil) {
        await arabicPiece(
          req.arabic[index],
          ar,
          last ? 0 : config.mix.betweenVerses
        );
        pieces.push(ar);
        continue;
      }

      await arabicPiece(req.arabic[index], ar, config.mix.afterArabic);
      // The clip ends on the last Tamil verse; trailing silence there is dead
      // air a listener has to sit through, or edit off later.
      await tamilPiece(
        req.surah,
        verse,
        ta,
        last ? 0 : config.mix.betweenVerses
      );

      pieces.push(ar, ta);
    }

    // The concat demuxer takes a file list, which has no command-line length
    // limit — a 286-verse surah is 572 pieces and would not fit in argv.
    const list = path.join(work, "pieces.txt");
    await fs.writeFile(
      list,
      pieces.map((piece) => `file '${piece.replace(/'/g, "'\\''")}'`).join("\n")
    );

    await run("ffmpeg", [
      "-v", "error",
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", list,
      "-c:a", "libmp3lame",
      "-q:a", "2",
      "-ar", String(RATE),
      "-ac", String(CHANNELS),
      dest,
    ]);

    return { name, seconds: Number((await measure(dest)).toFixed(2)) };
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
};

/**
 * The Arabic of a range, end to end, for auditioning a voice.
 *
 * Separate from `buildMixedClip` because there is no Tamil in it and no
 * interleaving to do — the point is to hear the reciter, not the reel.
 *
 * Cached under the recitation cache: the same range in the same voice is asked
 * for repeatedly while someone tries the list, and re-cutting it each time
 * makes the button feel slow for no reason.
 */
export const buildArabicRun = async (
  reciterId: string,
  surah: number,
  from: number,
  to: number,
  sources: readonly string[]
): Promise<string> => {
  const runs = path.join(config.paths.recitations, "_runs");
  const name =
    `${reciterId}-${pad3(surah)}-${pad3(from)}` +
    (to === from ? "" : `-${pad3(to)}`) +
    ".mp3";
  const dest = path.join(runs, name);

  const cached = await fs.stat(dest).catch(() => null);
  if (cached && cached.size > 2048) {
    return dest;
  }

  await fs.mkdir(runs, { recursive: true });
  const work = path.join(runs, `.work-${name}`);
  await fs.rm(work, { recursive: true, force: true });
  await fs.mkdir(work, { recursive: true });

  try {
    const pieces: string[] = [];
    for (const [index, source] of sources.entries()) {
      const piece = path.join(work, `${pad3(index)}.wav`);
      await run("ffmpeg", [
        "-v", "error",
        "-y",
        "-i", source,
        "-map", "0:a",
        // A breath between verses, so the run does not read as one long verse.
        "-af", `apad=pad_dur=${index === sources.length - 1 ? 0 : 0.35}`,
        "-ar", String(RATE),
        "-ac", String(CHANNELS),
        "-c:a", "pcm_s16le",
        piece,
      ]);
      pieces.push(piece);
    }

    const list = path.join(work, "pieces.txt");
    await fs.writeFile(
      list,
      pieces.map((piece) => `file '${piece.replace(/'/g, "'\\''")}'`).join("\n")
    );

    await run("ffmpeg", [
      "-v", "error",
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", list,
      "-c:a", "libmp3lame",
      "-q:a", "2",
      dest,
    ]);

    return dest;
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
};
