/**
 * The Arabic side of a clip: one mp3 per verse, from everyayah.com.
 *
 * Downloaded once and kept, because a build of a long passage would otherwise
 * fetch the same verses again on every rebuild, and because the dashboard is
 * useful on a train. The cache is keyed by reciter and verse, which is exactly
 * how everyayah is organised, so the layout is a mirror rather than a mapping.
 *
 * Nothing here accepts a reciter string directly — callers pass an id already
 * checked against RECITERS by `findReciter`. That check is what keeps a
 * user-supplied value out of both the URL and the file path.
 */
import fs from "fs/promises";
import path from "path";
import { config } from "../config/config.js";
import { everyAyahFile, everyAyahUrl } from "./reciters.js";

/**
 * everyayah serves bare MPEG streams — no ID3 tag, straight in on a frame
 * sync. Both forms are accepted; anything else is an error page that arrived
 * with a 200, which is the failure this guards against. Caching an HTML error
 * as `001001.mp3` would poison the cache until someone deleted it by hand.
 */
const looksLikeMp3 = (bytes: Buffer): boolean =>
  bytes.length > 2 &&
  (bytes.subarray(0, 3).toString("latin1") === "ID3" ||
    (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0));

/** Below this a "download" is a stub or an error body, not a recitation. */
const MIN_BYTES = 2048;

const reciterDir = (reciterId: string) =>
  path.join(config.paths.recitations, reciterId);

export const recitationPath = (
  reciterId: string,
  surah: number,
  ayah: number
) => path.join(reciterDir(reciterId), everyAyahFile(surah, ayah));

/**
 * In-flight downloads, so a passage that needs the same verse twice — or two
 * builds racing — fetch it once. Keyed by the destination path.
 */
const inFlight = new Map<string, Promise<string>>();

const download = async (
  reciterId: string,
  surah: number,
  ayah: number,
  dest: string
): Promise<string> => {
  const url = everyAyahUrl(reciterId, surah, ayah);

  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(config.recitation.timeoutMs),
    });
  } catch (error) {
    throw new Error(
      `Could not reach everyayah.com for ${surah}:${ayah} ` +
        `(${(error as Error).message}). The Arabic needs a connection the ` +
        `first time a verse is used; the Tamil does not.`
    );
  }

  if (!response.ok) {
    throw new Error(
      `everyayah.com returned ${response.status} for ${surah}:${ayah} in ` +
        `${reciterId}`
    );
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < MIN_BYTES || !looksLikeMp3(bytes)) {
    throw new Error(
      `everyayah.com sent ${bytes.length} bytes for ${surah}:${ayah} that are ` +
        `not an mp3 — refusing to cache it`
    );
  }

  await fs.mkdir(path.dirname(dest), { recursive: true });

  // Write then rename, for the same reason the aligner does: a file killed
  // mid-write stays on disk, and the cache check only tests that the path
  // exists — so a truncated verse would be served forever.
  const temporary = `${dest}.part`;
  await fs.writeFile(temporary, bytes);
  await fs.rename(temporary, dest);

  return dest;
};

/** Returns the local path, downloading it first if this is its first use. */
export const ensureRecitation = async (
  reciterId: string,
  surah: number,
  ayah: number
): Promise<string> => {
  const dest = recitationPath(reciterId, surah, ayah);

  const cached = await fs.stat(dest).catch(() => null);
  if (cached && cached.size >= MIN_BYTES) {
    return dest;
  }

  const running = inFlight.get(dest);
  if (running) {
    return running;
  }

  const job = download(reciterId, surah, ayah, dest).finally(() => {
    inFlight.delete(dest);
  });
  inFlight.set(dest, job);
  return job;
};

/**
 * Fetches a whole range, a few at a time.
 *
 * Sequential downloads make a 30-verse passage feel broken; unbounded parallel
 * downloads are a burst of 286 requests at a free host that is doing us a
 * favour. Neither is worth it for the seconds involved.
 */
export const ensureRange = async (
  reciterId: string,
  surah: number,
  from: number,
  to: number
): Promise<string[]> => {
  const ayahs = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const paths: string[] = new Array(ayahs.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < ayahs.length) {
      const index = next;
      next += 1;
      paths[index] = await ensureRecitation(reciterId, surah, ayahs[index]);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(config.recitation.concurrency, ayahs.length) },
      worker)
  );

  return paths;
};
