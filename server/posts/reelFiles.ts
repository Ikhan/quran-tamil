/**
 * From a reel's path under `output/` to what a post needs about it.
 *
 * Posts address a reel the same way the rest of the dashboard does — by the
 * relative path the history listing hands out — so there is no second registry
 * of reels to keep in step with the directory. The cover is found by name
 * beside the reel: `reel-112-003.mp4` and `cover-112-003.png` sit together, and
 * a dark reel shares the light one's cover because the cover has no dark form.
 */
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { COVER_FILE, REEL_FILE, safeOutputPath } from "../services/outputPaths.js";

export interface ReelFile {
  /** Relative to `output/`, with empty segments dropped. */
  relative: string;
  absolute: string;
  /** "112:3", "55:13-18". */
  reference: string;
  /** Relative to `output/`, or null when no cover was made for it. */
  cover: string | null;
  /** The caption a batch wrote beside it (`caption-112-003.txt`), if any. */
  caption: string | null;
}

const NAME = /^reel-(\d{3})-(\d{3})(?:-(\d{3}))?(-dark)?\.mp4$/;

const exists = (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false
  );

/** "reel-055-013-018-dark.mp4" → "55:13-18". */
export function referenceOf(name: string): string | null {
  const m = NAME.exec(name);
  if (!m) return null;
  const [, s, from, to] = m;
  return `${Number(s)}:${Number(from)}${to ? `-${Number(to)}` : ""}`;
}

/** The reel on disk, or null when the path is malformed or nothing is there. */
export async function locateReel(given: string): Promise<ReelFile | null> {
  // One spelling per file, so "a//b" cannot slip past the already-queued check.
  const relative = given.split("/").filter(Boolean).join("/");
  const absolute = safeOutputPath(relative, REEL_FILE);
  const name = path.basename(relative);
  const reference = referenceOf(name);
  if (!absolute || !reference || !(await exists(absolute))) return null;

  const coverName = name.replace(/^reel-/, "cover-").replace(/(-dark)?\.mp4$/, ".png");
  const folder = path.posix.dirname(relative);
  const coverRelative = folder === "." ? coverName : `${folder}/${coverName}`;
  const coverAbsolute = safeOutputPath(coverRelative, COVER_FILE);
  const cover = coverAbsolute && (await exists(coverAbsolute)) ? coverRelative : null;

  const captionName = coverName.replace(/^cover-/, "caption-").replace(/\.png$/, ".txt");
  const captionAbsolute = path.join(path.dirname(absolute), captionName);
  const caption = (await readFile(captionAbsolute, "utf8").catch(() => "")).trim() || null;

  return { relative, absolute, reference, cover, caption };
}

/** The cover's absolute path, re-checked at posting time rather than trusted from the queue. */
export function coverPath(relative: string | null): string | null {
  return relative ? safeOutputPath(relative, COVER_FILE) : null;
}
