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

/** Punctuation the translator placed between clauses, which moves with them. */
const CLAUSE_PUNCTUATION = /[,.;:!?'"“”‘’()]/g;

const wordsOf = (text: string): string =>
  text
    .replace(CLAUSE_PUNCTUATION, " ")
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");

/**
 * The recording sometimes reads a verse's clauses in a different order from
 * the Tanzil text — 2:56 is spoken in the Arabic's order, "We raised you after
 * your death, that you might be grateful", while the text puts the purpose
 * clause first. Shown as written, the card reads against the audio and every
 * line lights while the other is being spoken.
 *
 * `data/tamil-overrides.json` holds the reordered text. `ta.tamil.txt` itself
 * stays as it is: the aligner reads it. An override may only move words, never
 * change them, so one that does not carry exactly the source's words is
 * refused rather than shown.
 */
const applyOverrides = async (
  tamil: Map<VerseKey, string>
): Promise<Map<VerseKey, string>> => {
  let raw: string;
  try {
    raw = await fs.readFile(
      path.join(config.paths.data, "tamil-overrides.json"),
      "utf-8"
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return tamil;
    }
    throw err;
  }

  const overrides = JSON.parse(raw) as Record<string, string>;
  const merged = new Map(tamil);

  for (const [key, text] of Object.entries(overrides)) {
    const source = tamil.get(key as VerseKey);
    if (source === undefined) {
      throw new Error(`tamil-overrides.json: no verse ${key}`);
    }
    if (wordsOf(source) !== wordsOf(text)) {
      throw new Error(
        `tamil-overrides.json: ${key} changes the translation's words; ` +
          `an override may only reorder them`
      );
    }
    merged.set(key as VerseKey, text);
  }

  return merged;
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
    tamil: await applyOverrides(parsePipeFile(tamilRaw)),
  };

  return cached;
};
