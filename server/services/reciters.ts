/**
 * The Arabic reciters the dashboard can pair a Tamil translation with.
 *
 * `id` must stay exact: it is the everyayah.com folder the audio comes from,
 * and it is the only user-supplied value that reaches a URL and a file path.
 * Nothing is built from a reciter string that is not found in this list —
 * `findReciter` is the gate, and callers must go through it.
 *
 * Ported from ../quran-reels/src/lib/reciters.ts, minus that project's
 * `coverage` field. There, coverage records whether a reciter has word-level
 * timings, because it lights each word as it is recited. Here the Arabic is
 * played whole, so every reciter works equally and the caveat would be a
 * warning about nothing.
 */
export interface Reciter {
  id: string;
  name: string;
  /** Murattal is measured recitation; Mujawwad is the slower, ornamented style. */
  style: "Murattal" | "Mujawwad" | "Muallim";
  /** A sentence on how it sounds, to narrow the choice before listening. */
  character: string;
}

export const RECITERS: readonly Reciter[] = [
  {
    id: "Alafasy_128kbps",
    name: "Mishary Rashid Alafasy",
    style: "Murattal",
    character:
      "The most widely recognised voice on social media. Clear, measured, evenly paced.",
  },
  {
    id: "Husary_64kbps",
    name: "Mahmoud Khalil Al-Husary",
    style: "Murattal",
    character:
      "The classical reference recitation. Precise and unhurried, with textbook tajwīd.",
  },
  {
    id: "Husary_Muallim_128kbps",
    name: "Al-Husary (Muallim)",
    style: "Muallim",
    character:
      "Teaching style: every word separated deliberately. The best fit for a learning audience.",
  },
  {
    id: "Abdul_Basit_Murattal_64kbps",
    name: "Abdul Basit Abdus Samad",
    style: "Murattal",
    character:
      "Warm and resonant, slower than Alafasy. Longer clips for the same verse.",
  },
  {
    id: "Abdul_Basit_Mujawwad_128kbps",
    name: "Abdul Basit (Mujawwad)",
    style: "Mujawwad",
    character:
      "Highly ornamented and drawn out. Beautiful, but a single verse can run very long.",
  },
  {
    id: "Minshawy_Murattal_128kbps",
    name: "Mohamed Siddiq El-Minshawy",
    style: "Murattal",
    character: "Gentle and reflective, moderate pace.",
  },
  {
    id: "Minshawy_Mujawwad_192kbps",
    name: "El-Minshawy (Mujawwad)",
    style: "Mujawwad",
    character: "The ornamented style — sonorous and slow.",
  },
  {
    id: "Abdurrahmaan_As-Sudais_192kbps",
    name: "Abdurrahman As-Sudais",
    style: "Murattal",
    character:
      "The Makkah imam's voice, familiar from the Haram. Emotive, moderately paced.",
  },
  {
    id: "Saood_ash-Shuraym_128kbps",
    name: "Saud Al-Shuraim",
    style: "Murattal",
    character: "Deep and steady, the other Haram voice. Calm and even.",
  },
  {
    id: "Abu_Bakr_Ash-Shaatree_128kbps",
    name: "Abu Bakr Ash-Shatri",
    style: "Murattal",
    character: "Bright and flowing, slightly quicker than Alafasy.",
  },
  {
    id: "Hani_Rifai_192kbps",
    name: "Hani Ar-Rifai",
    style: "Murattal",
    character: "Light and quick. The shortest clips of the set.",
  },
  {
    id: "Mohammad_al_Tablaway_128kbps",
    name: "Mohammad Al-Tablaway",
    style: "Murattal",
    character: "Strong and declamatory, with pronounced phrasing.",
  },
  {
    id: "MaherAlMuaiqly128kbps",
    name: "Maher Al-Muaiqly",
    style: "Murattal",
    character: "The other Makkah imam. Close to Alafasy in pace but warmer.",
  },
  {
    id: "Yasser_Ad-Dussary_128kbps",
    name: "Yasser Al-Dosari",
    style: "Murattal",
    character:
      "The voice most common in recent reels. Emotive and unhurried, with long pauses.",
  },
  {
    id: "Ghamadi_40kbps",
    name: "Saad Al-Ghamdi",
    style: "Murattal",
    character:
      "Gentle and very evenly paced. Note the audio is only 40kbps — the lowest of the set.",
  },
  {
    id: "Husary_128kbps_Mujawwad",
    name: "Al-Husary (Mujawwad)",
    style: "Mujawwad",
    character:
      "The ornamented counterpart to the Husary above. Slow and declamatory.",
  },
  {
    id: "khalefa_al_tunaiji_64kbps",
    name: "Khalifa Al-Tunaiji",
    style: "Murattal",
    character:
      "Less widely known, bright and quick. Useful when the familiar voices feel overused.",
  },
  {
    // Neither quran-align nor the QUL imports cover this voice, so there is no
    // timings file: interleaved audio works, a reel refuses until one is added.
    id: "Ahmed_ibn_Ali_al-Ajamy_128kbps_ketaballah.net",
    name: "Ahmed Al-Ajamy",
    style: "Murattal",
    character:
      "Melodic and emotive, moderately paced. Audio only for now — no word timings, so no reels yet.",
  },
];

export const DEFAULT_RECITER = "Alafasy_128kbps";

/**
 * The only way a reciter id should enter the rest of the app. Returns
 * undefined for anything not listed, which callers must treat as a rejection
 * rather than a default — silently falling back would build a clip in a voice
 * the operator did not choose.
 */
export const findReciter = (id: string): Reciter | undefined =>
  RECITERS.find((reciter) => reciter.id === id);

/** everyayah.com names its files `{surah:3}{ayah:3}.mp3`. */
export const everyAyahFile = (surah: number, ayah: number): string =>
  `${String(surah).padStart(3, "0")}${String(ayah).padStart(3, "0")}.mp3`;

export const everyAyahUrl = (
  reciterId: string,
  surah: number,
  ayah: number
): string =>
  `https://everyayah.com/data/${reciterId}/${everyAyahFile(surah, ayah)}`;

/**
 * Al-Fātiḥa 1:1 — short, universally known, and present for every reciter.
 * Auditioning a voice on the verse actually chosen would be better, but that
 * verse may not be resolved yet when the choice is being made.
 */
export const SAMPLE_VERSE = { surah: 1, ayah: 1 };
