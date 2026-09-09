/**
 * The cover still: which surah, in both languages, over an uploaded photograph.
 *
 * The Tamil name of a surah is typed rather than looked up — there is no
 * vendored Tamil name list, and inventing 114 of them from memory is not
 * something to do to scripture. What is typed is kept, so the list builds
 * itself correctly over time from the person who actually knows.
 */
import { execFile } from "child_process";
import fs from "fs/promises";
import path from "path";
import { promisify } from "util";
import { PROJECT_ROOT, config } from "../config/config.js";
import { postFolder } from "./outputPaths.js";
import { SURAH_NAMES } from "./surahNames.js";
import { SURAH_NAMES_TAMIL } from "./surahNamesTamil.js";
import type { CoverFile } from "../../src/lib/coverTypes.js";

const run = promisify(execFile);

const COVER_IMAGES = path.join(PROJECT_ROOT, "public", "covers");
const JOB_FILE = path.join(PROJECT_ROOT, "src", "data", "coverData.json");
/**
 * Corrections to the vendored Tamil names, remembered between sessions.
 *
 * Only what has been edited is stored, so the file stays a short list of
 * deliberate changes rather than a second copy of the vendored one that could
 * drift out of step with it.
 */
const NAME_FILE = path.join(config.paths.data, "surah-names-tamil.json");

const pad3 = (value: number) => String(value).padStart(3, "0");

/**
 * Accepted by content, not by extension — a `.png` that is really something
 * else would fail inside the renderer, where the error names no file.
 */
const IMAGE_KINDS: Array<{ ext: string; magic: number[] }> = [
  { ext: "png", magic: [0x89, 0x50, 0x4e, 0x47] },
  { ext: "jpg", magic: [0xff, 0xd8, 0xff] },
  { ext: "webp", magic: [0x52, 0x49, 0x46, 0x46] },
];

const kindOf = (bytes: Buffer): string | null =>
  IMAGE_KINDS.find((kind) =>
    kind.magic.every((byte, index) => bytes[index] === byte)
  )?.ext ?? null;

const readOverrides = async (): Promise<Record<string, string>> => {
  try {
    return JSON.parse(await fs.readFile(NAME_FILE, "utf-8"));
  } catch {
    return {};
  }
};

/** The vendored name for a sura, or the correction if one has been made. */
export const tamilNameOf = async (surah: number): Promise<string> => {
  const overrides = await readOverrides();
  return overrides[surah] ?? SURAH_NAMES_TAMIL[surah] ?? "";
};

const rememberTamilName = async (
  surah: number,
  name: string
): Promise<void> => {
  const overrides = await readOverrides();

  // Nothing to record when the name is what the vendored list already says —
  // storing it would turn the corrections file into a duplicate of the list.
  if (name === SURAH_NAMES_TAMIL[surah]) {
    if (overrides[surah] === undefined) {
      return;
    }
    delete overrides[surah];
  } else {
    if (overrides[surah] === name) {
      return;
    }
    overrides[surah] = name;
  }

  await fs.writeFile(NAME_FILE, JSON.stringify(overrides, null, 2));
};

/**
 * Stores an uploaded image under `public/` and returns its staticFile path.
 *
 * With an `ayah` the image belongs to that verse alone — `cover-003-180.png` —
 * which is what lets a batch hold a different photograph for every post.
 * Without one it is the sura's image, as before, and a single-verse cover made
 * from the dashboard still overwrites it rather than accumulating.
 */
export const saveCoverImage = async (
  dataUrl: string,
  surah: number,
  ayah?: number
): Promise<string> => {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bytes = Buffer.from(base64, "base64");

  const kind = kindOf(bytes);
  if (!kind) {
    throw new Error("That file is not a PNG, JPEG or WebP image");
  }

  await fs.mkdir(COVER_IMAGES, { recursive: true });
  const name =
    ayah === undefined
      ? `cover-${pad3(surah)}.${kind}`
      : `cover-${pad3(surah)}-${pad3(ayah)}.${kind}`;
  await fs.writeFile(path.join(COVER_IMAGES, name), bytes);

  return `covers/${name}`;
};

/**
 * The photograph to put behind a verse's cover.
 *
 * A verse's own image wins over the sura's, so a batch that uploaded ten
 * photographs uses them, while a sura that only ever had one still works.
 * Returns "" when there is neither, which the composition renders as plain
 * ground rather than failing.
 */
const imageFor = async (surah: number, from: number): Promise<string> => {
  const existing = await fs.readdir(COVER_IMAGES).catch(() => [] as string[]);
  const verse = existing.find((name) =>
    name.startsWith(`cover-${pad3(surah)}-${pad3(from)}.`)
  );
  if (verse) {
    return `covers/${verse}`;
  }
  const sura = existing.find((name) =>
    name.startsWith(`cover-${pad3(surah)}.`)
  );
  return sura ? `covers/${sura}` : "";
};

export interface CoverRequest {
  surah: number;
  from: number;
  to: number;
  surahTamil: string;
  /** A data URL, or empty to keep whatever image the surah already has. */
  image?: string;
}

export const buildCover = async ({
  surah,
  from,
  to,
  surahTamil,
  image,
}: CoverRequest): Promise<string> => {
  const names = SURAH_NAMES[surah];
  const tamil = surahTamil.trim();
  if (tamil) {
    await rememberTamilName(surah, tamil);
  }

  const imagePath = image
    ? await saveCoverImage(image, surah)
    : await imageFor(surah, from);

  const file: CoverFile = {
    createdAt: new Date().toISOString(),
    surah,
    surahEnglish: names?.english ?? `Surah ${surah}`,
    surahArabic: names?.arabic ?? "",
    surahTamil: tamil,
    from,
    to,
    image: imagePath,
  };

  await fs.writeFile(JOB_FILE, JSON.stringify(file, null, 2));

  // The cover lands in the same folder as the reel for that range, so a post is
  // one folder. The name repeats the range anyway: two covers from one sura
  // must not write to the same file, or the second silently replaces the first.
  const outName =
    `cover-${pad3(surah)}-${pad3(from)}` +
    (to > from ? `-${pad3(to)}` : "") +
    ".png";
  const relative = path.join(await postFolder(surah, from, to), outName);
  const dest = path.join(config.paths.output, relative);
  await fs.mkdir(path.dirname(dest), { recursive: true });

  await run(
    "npx",
    ["remotion", "still", "src/index.ts", "Cover", dest],
    { cwd: PROJECT_ROOT, maxBuffer: 64 * 1024 * 1024 }
  );

  return relative;
};
