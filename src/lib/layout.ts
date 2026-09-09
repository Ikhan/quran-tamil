/**
 * Frame geometry and type sizing for the verse card.
 *
 * Owned here and imported by both the composition and the build script,
 * because two places need the identical answer: the composition draws the
 * lines, and the build script gives each line its share of the audio. If they
 * disagreed about where the text breaks, every highlight after the first would
 * light a line that is not the one being spoken.
 */

export const FRAME_WIDTH = 1080;
export const FRAME_HEIGHT = 1920;
export const FPS = 30;

/**
 * Where content may sit, as fractions of the frame.
 *
 * The bottom 15% is left clear for Instagram's username and caption overlay,
 * the top 7% for its back and camera controls. The right side is inset further
 * than the left would need to be on its own: the like/comment/share rail sits
 * over roughly the right 12% between a third and four fifths of the way down.
 */
export const SAFE_AREA = {
  top: 0.07,
  bottom: 0.15,
  left: 0.06,
  right: 0.13,
} as const;

const CONTENT_WIDTH = FRAME_WIDTH * (1 - SAFE_AREA.left - SAFE_AREA.right);
const CARD_HEIGHT = FRAME_HEIGHT * (1 - SAFE_AREA.top - SAFE_AREA.bottom);

/**
 * Arabic in Amiri Quran is wider per character than Latin and needs far more
 * leading — the Uthmani marks sit well above and below the baseline, and
 * cramping them is what makes a verse look like a smudge.
 */
const ARABIC_GLYPH_WIDTH_EM = 0.52;
export const ARABIC_LINE_HEIGHT = 2.0;

/** Tamil carries tall ascenders and deep descenders; it needs the leading. */
export const TAMIL_LINE_HEIGHT = 1.6;
/**
 * Measured against the rendered card, not derived. Tamil character widths vary
 * far more than a Latin face — கு and ணி are half again the width of ன — so a
 * mean is not safe here. This is deliberately generous: a logical line that
 * overflows wraps visually, which splits it into two lines the highlight then
 * lights as one, and that reads as broken.
 */
const TAMIL_GLYPH_WIDTH_EM = 0.58;

/** Room reserved outside the two blocks: ornament, verse marker, footer. */
const CARD_FURNITURE = 250;

export const tamilCharsPerLine = (size: number): number =>
  Math.max(8, Math.floor(CONTENT_WIDTH / (size * TAMIL_GLYPH_WIDTH_EM)));

/** Breaks the translation at word boundaries to fill the measure. */
export const splitTamilLines = (text: string, size: number): string[] => {
  const perLine = tamilCharsPerLine(size);
  const lines: string[] = [];
  let current = "";

  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (current && current.length + word.length + 1 > perLine) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) {
    lines.push(current);
  }

  return lines.length ? lines : [text];
};

/**
 * The Arabic runs a little larger than the Tamil beside it. Amiri Quran sets
 * small for its em — the marks need room the letters do not use — so matching
 * the two by pixel size would leave the Arabic looking the smaller of the pair.
 */
const ARABIC_TO_TAMIL = 1.25;
const MIN_SIZE = 8;

const arabicLinesAt = (chars: number, size: number): number =>
  Math.ceil(
    chars / Math.max(4, Math.floor(CONTENT_WIDTH / (size * ARABIC_GLYPH_WIDTH_EM)))
  );

/**
 * The largest size at which the whole verse fits the card.
 *
 * The whole verse, always. A long verse is set smaller, never continued
 * elsewhere: splitting it would put the highlight on a page the viewer is not
 * looking at, and the frame would stop being the complete verse that makes it
 * worth screenshotting.
 *
 * The two scripts are sized together on one parameter rather than fitted one
 * after the other. Fitting them in turn means the first takes what it likes and
 * the second lives on the remainder — which on a long verse left the Arabic at
 * its floor and crushed the Tamil to a smear while a third of the card stayed
 * empty. Tied together they shrink in proportion and keep filling the frame.
 *
 * Searched rather than solved: line count is a ceiling, so height is a step
 * function of size, and inverting it algebraically would be wrong at every step
 * edge. Seventy iterations of arithmetic costs nothing and is exact.
 */
export const layoutVerse = (
  arabic: string,
  tamil: string
): { arabicSize: number; tamilSize: number; tamilLines: string[] } => {
  const available = CARD_HEIGHT - CARD_FURNITURE;
  const arabicChars = arabic.trim().length;

  for (let size = 76; size >= MIN_SIZE; size -= 1) {
    const arabicSize = Math.min(112, Math.round(size * ARABIC_TO_TAMIL));
    const arabicHeight =
      arabicLinesAt(arabicChars, arabicSize) * arabicSize * ARABIC_LINE_HEIGHT;

    const tamilLines = splitTamilLines(tamil, size);
    const tamilHeight = tamilLines.length * size * TAMIL_LINE_HEIGHT;

    if (arabicHeight + tamilHeight <= available) {
      return { arabicSize, tamilSize: size, tamilLines };
    }
  }

  // Unreachable for real text — at eight pixels a whole sura would fit — but a
  // sized answer beats a thrown one if it ever is.
  return {
    arabicSize: Math.round(MIN_SIZE * ARABIC_TO_TAMIL),
    tamilSize: MIN_SIZE,
    tamilLines: splitTamilLines(tamil, MIN_SIZE),
  };
};
