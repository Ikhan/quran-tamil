/**
 * The job file for an Arabic-then-Tamil reel.
 *
 * Separate from `types.ts` rather than bolted onto `AyahSegment`: that shape
 * describes one verse with one audio clip, and this one is two clips per verse
 * played in sequence. Every frame number here is already resolved by
 * `scripts/buildTamilReel.ts`, so the composition only draws what it is told.
 */
/** One word of the Arabic, with the frames it is being recited over. */
export interface ArabicWord {
  /** Uthmani text, exactly as it appears in `quran-uthmani.txt`. */
  text: string;
  /** Frames relative to the start of this verse's own Arabic clip. */
  fromFrame: number;
  toFrame: number;
  /**
   * True when the aligner could not separate this word from its neighbour, so
   * they share a timing and light together. Kept explicit rather than hidden,
   * because it is the one case where the highlight is coarser than a word.
   */
  grouped: boolean;
}

/** One line of the translation, and the frames it is revealed over. */
export interface TamilLine {
  text: string;
  /** Frames relative to the start of this verse's Tamil clip. */
  fromFrame: number;
  toFrame: number;
}

export interface TamilVerse {
  ayah: number;
  arabic: string;
  /** Frames relative to the start of this verse's Arabic clip. */
  words: ArabicWord[];
  /** Path under `public/`, as `staticFile()` wants it. */
  arabicAudio: string;
  /** Absolute frame, from the start of the reel. */
  arabicStart: number;
  arabicFrames: number;

  tamil: string;
  /**
   * Null when this verse's Tamil narration is unusable — the recitation there
   * belongs to another verse. The text is still shown and still paced across
   * `tamilFrames`; there is simply nothing to play under it.
   */
  tamilAudio: string | null;
  tamilStart: number;
  tamilFrames: number;
  /** Why the Tamil is silent, when it is. Shown in the studio, not on the card. */
  tamilSkipped?: string;
  lines: TamilLine[];

  /**
   * The verse index's own confidence in where this Tamil verse sits. Carried
   * through so a doubtful placement can be seen in the studio rather than
   * discovered in a finished reel.
   */
  confidence: number;
}

export interface TamilReelFile {
  createdAt: string;
  surah: number;
  surahName: string;
  surahNameArabic: string;
  reference: string;
  reciter: string;
  durationInFrames: number;
  verses: TamilVerse[];
}
