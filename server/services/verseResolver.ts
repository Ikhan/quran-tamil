/**
 * Turns whatever was pasted into a verse range the pipeline can build.
 *
 * Four things are accepted, because all four are how someone actually has a
 * verse to hand:
 *   - a reference:      `112`, `2:255`, `55:13-18`
 *   - the Arabic itself, pasted from anywhere
 *   - several verses of Arabic at once, pasted as a block
 *   - Arabic with an English translation under it, pasted together
 *
 * Arabic is matched on its **letter skeleton** — diacritics removed — so text
 * copied from a site that points it differently, or that carries verse-number
 * ornaments, still resolves.
 *
 * **The Arabic that was pasted is never rendered.** It resolves to a
 * `surah:ayah` and the build then draws the vendored Tanzil text, because that
 * is the edition the word timings index — a paste is how you *find* a verse,
 * not how you supply one.
 *
 * **English pasted alongside it is different, and is used as given.** There is
 * no timing data riding on it and no single correct wording, so someone pasting
 * Asad or Pickthall under the Arabic means to see Asad or Pickthall, not to be
 * silently given Saheeh International instead. It is carried through as a
 * supplied translation and takes precedence over the vendored file.
 */
import { loadSources, type VerseKey } from "./quranSources.js";

export interface ResolvedRange {
  surah: number;
  from: number;
  to: number;
  /** How it was worked out, shown back so a wrong match is obvious. */
  matchedBy: "reference" | "arabic";
  /**
   * English pasted with the Arabic, by verse. Absent when none was pasted,
   * which is the usual case and leaves the vendored translation in charge.
   */
  translations?: Record<VerseKey, string>;
}

/** Arabic diacritics and Qur'anic annotation marks. */
const DIACRITICS = /[ً-ْٰۖ-ۭ]/g;
/** Verse-end ornaments, tatweel, and the Arabic-Indic digits inside them. */
const ORNAMENTS = /[ـ۝۞٠-٩۰-۹]/g;

/** Letters only: how two spellings of the same verse are compared. */
export const skeleton = (text: string): string =>
  text
    .normalize("NFC")
    .replace(DIACRITICS, "")
    .replace(ORNAMENTS, "")
    // The alef variants are written inconsistently across sources.
    .replace(/[آأإٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^ء-ي\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const REFERENCE = /^(\d{1,3})(?::(\d{1,3})(?:\s*-\s*(\d{1,3}))?)?$/;

const parseReference = (input: string): ResolvedRange | undefined => {
  const match = input.trim().replace(/\s+/g, "").match(REFERENCE);
  if (!match) {
    return undefined;
  }

  const surah = Number(match[1]);
  if (surah < 1 || surah > 114) {
    return undefined;
  }

  const from = match[2] ? Number(match[2]) : 1;
  const to = match[3] ? Number(match[3]) : match[2] ? from : 0;

  // `to: 0` means "to the end of the sura"; the builder stops when it runs out.
  return { surah, from, to, matchedBy: "reference" };
};

/** Verse skeletons, built once — 6236 entries, cheap to keep in memory. */
let index: Map<string, VerseKey> | undefined;

const getIndex = async (): Promise<Map<string, VerseKey>> => {
  if (index) {
    return index;
  }

  const { arabic } = await loadSources();
  const built = new Map<string, VerseKey>();

  for (const [key, text] of arabic) {
    const stripped = skeleton(text);
    // First writing wins: a handful of verses repeat word for word (the refrain
    // of Ar-Rahman, for instance), and the earlier occurrence is the safer
    // guess when someone pastes it without a reference.
    if (stripped && !built.has(stripped)) {
      built.set(stripped, key);
    }
  }

  index = built;
  return built;
};

const asKey = (key: VerseKey): { surah: number; ayah: number } => {
  const [surah, ayah] = key.split(":").map(Number);
  return { surah, ayah };
};

/**
 * Matches pasted Arabic. Handles a block of several consecutive verses by
 * matching each line, and falls back to matching the whole paste as one verse.
 */
const resolveArabic = async (
  input: string
): Promise<ResolvedRange | undefined> => {
  const lookup = await getIndex();

  const whole = lookup.get(skeleton(input));
  if (whole) {
    const { surah, ayah } = asKey(whole);
    return { surah, from: ayah, to: ayah, matchedBy: "arabic" };
  }

  // A pasted block: every line has to match, and they have to be consecutive
  // verses of one sura, or this is not a range and we should not guess at one.
  const lines = input
    .split(/[\n\r]+/)
    .map((line) => skeleton(line))
    .filter(Boolean);

  if (lines.length < 2) {
    return undefined;
  }

  const keys = lines.map((line) => lookup.get(line));
  if (keys.some((key) => key === undefined)) {
    return undefined;
  }

  const verses = (keys as VerseKey[]).map(asKey);
  const surah = verses[0].surah;

  const consecutive = verses.every(
    (verse, position) =>
      verse.surah === surah && verse.ayah === verses[0].ayah + position
  );

  return consecutive
    ? {
        surah,
        from: verses[0].ayah,
        to: verses[verses.length - 1].ayah,
        matchedBy: "arabic",
      }
    : undefined;
};

const ARABIC_LETTER = /[ء-ي]/;
const LATIN_LETTER = /[A-Za-z]/;

/** One verse of a paste: its Arabic, and the English pasted under it if any. */
interface PasteBlock {
  arabic: string;
  english?: string;
}

/**
 * Separates a paste into verses, and each verse into its two scripts.
 *
 * Split per word rather than per line, so the two arrangements people actually
 * paste both work: the translation on its own line under the Arabic, and the
 * translation run onto the same line after it.
 *
 * A new block starts at the first Arabic after some English, which is what
 * makes an interleaved block of several verses come apart correctly:
 *
 *     ٱلْـعَرَبِيَّة        ← verse 1
 *     The English.         ← verse 1
 *     ٱلْـعَرَبِيَّة        ← verse 2, because English came just before it
 *     The English.         ← verse 2
 */
const splitIntoBlocks = (input: string): PasteBlock[] => {
  const blocks: PasteBlock[] = [];
  let englishJustSeen = false;

  const add = (block: PasteBlock, key: "arabic" | "english", text: string) => {
    const existing = block[key];
    block[key] = existing ? `${existing} ${text}` : text;
  };

  for (const line of input.split(/[\n\r]+/)) {
    const words = line.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      continue;
    }

    const arabic = words.filter((word) => ARABIC_LETTER.test(word)).join(" ");
    // Everything that is not an Arabic word, so punctuation stays with the
    // English it belongs to rather than being dropped.
    const rest = words.filter((word) => !ARABIC_LETTER.test(word)).join(" ");
    const english = LATIN_LETTER.test(rest) ? rest : "";

    if (arabic) {
      if (blocks.length === 0 || englishJustSeen) {
        blocks.push({ arabic });
      } else {
        add(blocks[blocks.length - 1], "arabic", arabic);
      }
      englishJustSeen = false;
    }

    if (english && blocks.length > 0) {
      add(blocks[blocks.length - 1], "english", english);
      englishJustSeen = true;
    }
  }

  return blocks;
};

/**
 * Attaches pasted English to the verses it was resolved to.
 *
 * Only when the counts agree. A paste with three Arabic verses and two English
 * paragraphs is one where the pairing is genuinely unknown, and guessing it
 * would put the wrong gloss under scripture — the vendored translation is used
 * instead, which is at least certainly right.
 */
const pairTranslations = (
  blocks: readonly PasteBlock[],
  range: ResolvedRange
): Record<VerseKey, string> | undefined => {
  const supplied = blocks.filter((block) => block.english?.trim());
  if (supplied.length === 0) {
    return undefined;
  }

  // `to: 0` means "to the end of the sura", so the verse count is not known
  // here. That only comes from a reference, which carries no English anyway.
  if (range.to === 0) {
    return undefined;
  }

  const verses = range.to - range.from + 1;
  if (blocks.length !== verses || supplied.length !== verses) {
    return undefined;
  }

  return Object.fromEntries(
    blocks.map((block, index) => [
      `${range.surah}:${range.from + index}` as VerseKey,
      block.english!.trim(),
    ])
  ) as Record<VerseKey, string>;
};

export const resolveInput = async (input: string): Promise<ResolvedRange> => {
  const trimmed = input.trim();

  if (!trimmed) {
    throw new Error("Paste a verse, or a reference like 112 or 2:255");
  }

  const byReference = parseReference(trimmed);
  if (byReference) {
    return byReference;
  }

  const byArabic = await resolveArabic(trimmed);
  if (byArabic) {
    const translations = pairTranslations(splitIntoBlocks(trimmed), byArabic);
    return translations ? { ...byArabic, translations } : byArabic;
  }

  if (/[ء-ي]/.test(trimmed)) {
    throw new Error(
      "That Arabic does not match a verse. It is matched against the whole Qur'an " +
        "ignoring diacritics, so a mismatch usually means a word was cut off, two " +
        "verses were run together on one line, or it is not Qur'anic text."
    );
  }

  throw new Error(
    "Could not read that. Paste the Arabic of a verse, or a reference like " +
      "112, 2:255 or 55:13-18."
  );
};
