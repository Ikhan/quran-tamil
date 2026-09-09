/**
 * Cuts a verse out of its surah mp3.
 *
 * Re-encodes rather than stream-copies. A stream copy can only cut on a frame
 * boundary, which drifts the start by up to ~26ms and, worse, leaves the
 * encoder delay of the original file at the front — audible as a click.
 */
import { execFile } from "child_process";
import fs from "fs/promises";
import path from "path";
import { promisify } from "util";
import { config } from "../config/config.js";

const run = promisify(execFile);

export interface ClipRequest {
  surah: number;
  from: number;
  to: number;
  start: number;
  end: number;
}

const sourceFor = (surah: number) =>
  path.join(config.paths.data, `${String(surah).padStart(3, "0")}.mp3`);

export const clipName = (surah: number, from: number, to: number) =>
  from === to
    ? `${String(surah).padStart(3, "0")}-${String(from).padStart(3, "0")}.mp3`
    : `${String(surah).padStart(3, "0")}-${String(from).padStart(3, "0")}-${String(
        to
      ).padStart(3, "0")}.mp3`;

/**
 * A short fade at each end. The cut lands mid-room-tone, and without this the
 * change in noise floor is audible as a click at the join.
 *
 * Shared with the mixer so the two paths cannot drift into sounding different.
 */
export const fadeFilter = (duration: number): string =>
  `afade=t=in:st=0:d=0.06,afade=t=out:st=${Math.max(
    0,
    duration - 0.12
  ).toFixed(3)}:d=0.12`;

export const buildClip = async (req: ClipRequest): Promise<string> => {
  const { leadIn, tailOut } = config.clip;
  const start = Math.max(0, req.start - leadIn);
  const duration = req.end - req.start + leadIn + tailOut;

  if (duration <= 0) {
    throw new Error("Refusing to cut a clip of zero length");
  }

  await fs.mkdir(config.paths.output, { recursive: true });
  const name = clipName(req.surah, req.from, req.to);
  const dest = path.join(config.paths.output, name);

  await run("ffmpeg", [
    "-v", "error",
    "-y",
    "-ss", start.toFixed(3),
    "-t", duration.toFixed(3),
    "-i", sourceFor(req.surah),
    "-map", "0:a",
    "-c:a", "libmp3lame",
    "-q:a", "2",
    "-af", fadeFilter(duration),
    dest,
  ]);

  return name;
};
