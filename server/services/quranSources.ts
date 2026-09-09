/**
 * Reads the two vendored texts: the Arabic a paste is matched against, and the
 * Tamil shown beside the audio.
 *
 * The Arabic is the Tanzil Uthmani edition, the same file quran-reels uses, so
 * a paste that resolves there resolves here identically.
 */
import fs from "fs/promises";
import path from "path";
import { config } from "../config/config.js";

export type VerseKey = `${number}:${number}`;

export const verseKey = (surah: number, ayah: number): VerseKey =>
  `${surah}:${ayah}`;

/** Arabic diacritics and Qur'anic annotation marks. */
const DIACRITICS = /[ً-ْٰۖ-ۭ]/g;

const skeleton = (text: string): string =>
  text.normalize("NFC").replace(DIACRITICS, "");

const BASMALA_SKELETON = skeleton("بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ");
const BASMALA_LENGTH = 4;

/**
 * Tanzil prefixes the Basmala to the first verse of most suras. It is stripped
 * so that a paste of verse 1 taken from anywhere still matches, and so the
 * Arabic shown next to the audio is the verse itself.
 *
 * Sura 1 is the exception — there the Basmala *is* the first verse.
 */
const stripLeadingBasmala = (
  surah: number,
  ayah: number,
  text: string
): string => {
  if (ayah !== 1 || surah === 1) {
    return text;
  }

  const words = text.split(/\s+/);
  const opening = skeleton(words.slice(0, BASMALA_LENGTH).join(" "));

  return opening === BASMALA_SKELETON
    ? words.slice(BASMALA_LENGTH).join(" ")
    : text;
};

/** "1|1|..." -> { "1:1": "..." }, ignoring Tanzil's trailing comment lines. */
const parsePipeFile = (
  contents: string,
  stripBasmala = false
): Map<VerseKey, string> => {
  const verses = new Map<VerseKey, string>();

  for (const line of contents.split("\n")) {
    const parts = line.trim().split("|");
    if (parts.length !== 3 || !/^\d+$/.test(parts[0])) {
      continue;
    }

    const surah = Number(parts[0]);
    const ayah = Number(parts[1]);
    const text = parts[2].trim();

    verses.set(
      verseKey(surah, ayah),
      stripBasmala ? stripLeadingBasmala(surah, ayah, text) : text
    );
  }

  return verses;
};

export interface QuranSources {
  arabic: Map<VerseKey, string>;
  tamil: Map<VerseKey, string>;
}

let cached: QuranSources | undefined;

export const loadSources = async (): Promise<QuranSources> => {
  if (cached) {
    return cached;
  }

  const [arabicRaw, tamilRaw] = await Promise.all([
    fs.readFile(path.join(config.paths.data, "quran-uthmani.txt"), "utf-8"),
    fs.readFile(path.join(config.paths.data, "ta.tamil.txt"), "utf-8"),
  ]);

  cached = {
    arabic: parsePipeFile(arabicRaw, true),
    tamil: parsePipeFile(tamilRaw),
  };

  return cached;
};
