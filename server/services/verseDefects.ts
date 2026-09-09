/**
 * Verses whose Tamil narration cannot be trusted.
 *
 * The recitation is not always faithful to the text. Surah 2 around verses
 * 173-186 plays 173, jumps to 177, cuts 177 off mid-verse and then plays 175 —
 * confirmed by ear, and the same defect is present in the archive.org copy
 * (byte-identical), so it is in the source recording rather than in this
 * download. No alignment can fix audio that is out of order; the aligner has
 * only ever been choosing where to put text that has nowhere to go.
 *
 * These are detected rather than listed, so the set stays right as verses are
 * repaired, and so the same test covers surahs nobody has listened to yet.
 *
 * Only signals that survived being checked by ear are used. A merely soft
 * confidence score is not one: 88:3 scores 0.23 and 7:63 scores 0.46, and both
 * were confirmed to play correctly — their scores are low because the
 * recitation words a verse differently from this translation, not because the
 * audio is wrong. What does hold up is a placement whose *duration* is far from
 * what the text needs, or one that sits out of sequence.
 */
import { verseKey, type VerseKey } from "./quranSources.js";
import type { VerseTiming } from "./timings.js";

/** Seconds of speech per Tamil character; the aligner's own figure. */
export const RATE = 0.0747;

/** Below 80 characters the estimate is too noisy to judge a duration by. */
const MIN_CHARS = 80;

/** A placement this far from the text's length is not describing this verse. */
const TOO_LONG = 1.7;
const TOO_SHORT = 0.55;

/** Below this the model found nothing it recognised at all. */
const NOTHING_FOUND = 0.20;

export interface Defect {
  ayah: number;
  reason: string;
}

/**
 * Which verses of a surah have unusable Tamil narration.
 *
 * The reel still shows their text — the translation is correct and worth
 * reading — but plays no Tamil audio for them, because what is there belongs
 * to another verse.
 */
export const defectiveVerses = (
  surah: number,
  timings: Map<VerseKey, VerseTiming>,
  tamil: Map<VerseKey, string>
): Map<number, string> => {
  const out = new Map<number, string>();

  const placed = [...timings.entries()]
    .map(([k, t]) => ({ ayah: Number(k.split(":")[1]), ...t }))
    .sort((a, b) => a.ayah - b.ayah);

  for (const [i, p] of placed.entries()) {
    const text = tamil.get(verseKey(surah, p.ayah)) ?? "";

    // Out of sequence is decisive whatever the text length: a verse starting
    // before the one before it ended is playing somebody else's recitation.
    if (i > 0 && p.start < placed[i - 1].end - 0.05) {
      out.set(p.ayah, "out of order");
      continue;
    }

    if (text.length < MIN_CHARS) continue;

    const expected = text.length * RATE;
    const ratio = (p.end - p.start) / expected;

    if (ratio >= TOO_LONG) {
      out.set(p.ayah, `${ratio.toFixed(1)}x longer than the text`);
    } else if (ratio <= TOO_SHORT) {
      out.set(p.ayah, `${Math.round((1 - ratio) * 100)}% shorter than the text`);
    } else if (p.confidence < NOTHING_FOUND) {
      out.set(p.ayah, "not recognised in the audio");
    }
  }

  return out;
};
