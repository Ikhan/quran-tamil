/**
 * The Instagram caption for a resolved range, built from what the page already
 * holds.
 *
 * The caption is the passage and its attribution, and nothing else: each Arabic
 * line with its Tamil directly beneath it, then the sura, the range and the
 * reciter, then the tags. An earlier version scaffolded a hook and left marked
 * placeholders for the lines only a person can write — those placeholders were
 * the part that had to be deleted every time, so they are gone. Anything worth
 * adding above the verses is typed into the box, which is editable.
 *
 * No DOM in here, and no names shared with `tamil.js` — both are classic
 * scripts, so a redeclared top-level `const` would throw before either runs.
 */

/**
 * The tag block, in three groups so the list stays editable.
 *
 * Twenty-eight, against Instagram's ceiling of thirty — two spare. Nothing is
 * derived per sura: a tag built from the sura name lands on `#surahalfaatiha`,
 * which nobody searches for and which spends one of the thirty.
 */
const CAPTION_TAGS = [
  // Tamil first: this is where the account's own audience searches, and it is
  // the half no competing account is filling.
  "#குர்ஆன்",
  "#தமிழ்குர்ஆன்",
  "#இஸ்லாம்",
  "#தமிழ்முஸ்லிம்",
  "#tamil",
  "#tamilverse",
  "#quranintamil",
  "#tamilquran",
  "#tamilmuslim",
  // Broad reach.
  "#allah",
  "#islam",
  "#quran",
  "#deen",
  "#muslim",
  "#sunnah",
  "#jannah",
  "#peace",
  // The genre and the format.
  "#islamicpost",
  "#islamicreels",
  "#islamicpage",
  "#islamicquestions",
  "#islamicknowledge",
  "#uloomulquran",
  "#deenreminders",
  "#reminder",
  "#quranverse",
  "#quranreminder",
  "#quranrecitation",
];

const CAPTION_HANDLE = "#ilmul_quran_tamil";

/** Instagram's ceiling. Over it, the post is refused outright. */
const CAPTION_TAG_LIMIT = 30;

/**
 * The passage: each Arabic line with its Tamil directly under it.
 *
 * Paired rather than one Arabic block followed by one Tamil block — a reader
 * following along needs the translation under the line it translates, and six
 * verses split into six Arabic lines then six Tamil ones is unreadable on a
 * phone. Both come through verbatim; nothing here reformats scripture.
 */
const captionVerses = (verses) =>
  (verses ?? []).flatMap((verse, index) => [
    ...(index ? [""] : []),
    String(verse.arabic ?? "").trim(),
    String(verse.tamil ?? "").trim(),
  ]);

const captionReference = ({ tamilName, englishName, surah, from, to }) => {
  // The vendored Tamil names already carry "ஸூரத்துல்", so nothing is prefixed
  // — doing so would read as "Surah Suratul Baqara".
  const name = (tamilName || englishName || `Surah ${surah}`).trim();
  return `${name} · ${surah}:${from}${to > from ? `-${to}` : ""}`;
};

// A repeat costs one of the thirty and buys nothing.
const captionTags = () => [...new Set([...CAPTION_TAGS, CAPTION_HANDLE])].join(" ");

/**
 * The caption for a resolved range, ready to be copied.
 *
 * The reference leads. Instagram shows about the first line and a half before
 * it cuts to "... more", and what shows should say which passage this is —
 * a caption opening on Arabic script tells a reader scrolling past nothing
 * they can act on.
 *
 * It is not repeated at the foot. Said twice in a caption this short it reads
 * as a mistake rather than as attribution, so the closing block is the
 * reciter alone.
 */
const buildCaption = (context) =>
  [
    captionReference(context),
    "",
    ...captionVerses(context.verses),
    ...(context.reciterName ? ["", `🎙 ${context.reciterName}`] : []),
    "",
    // Keeps the tags off the end of the reciter line, and pushes them below
    // the fold where they belong.
    "—",
    captionTags(),
  ].join("\n");

/** How many hashtags a caption carries, counted on the text as it stands. */
const captionTagCount = (text) => (String(text ?? "").match(/#[^\s#]+/g) ?? []).length;
