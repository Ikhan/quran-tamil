/**
 * One reel at a time: stage the job, hand it to Remotion, report where it got
 * to.
 *
 * One at a time because a render saturates every core for minutes — two at once
 * would take longer than the same two in sequence, and would also fight over
 * `src/data/reelData.json`, which is a single staged job by design.
 *
 * Progress is polled by the dashboard rather than pushed. It keeps the server
 * free of sockets, and it survives a page refresh mid-render — which matters
 * when the thing being waited on takes minutes.
 */
import fs from "fs/promises";
import path from "path";
import { config } from "../config/config.js";
import { postFolder, REEL_FILE } from "./outputPaths.js";
import { buildCover } from "./coverBuilder.js";
import {
  reelFileName,
  reelPath,
  renderStaged,
  stageReel,
  type StageRequest,
} from "./reelBuilder.js";

export type RenderStatus =
  | "idle"
  | "preparing"
  | "rendering"
  | "completed"
  | "error";

export interface RenderProgress {
  status: RenderStatus;
  /** One line, written for someone watching a spinner. */
  step: string;
  reference?: string;
  file?: string;
  error?: string;
  startedAt?: string;
  /** Present only while a batch is running, or after one has finished. */
  batch?: BatchProgress;
}

export interface BatchProgress {
  total: number;
  /** Rendered by this run. */
  done: number;
  /** Already on disk, so not rendered again. */
  skipped: number;
  /** The verse being worked on, or the one that failed. */
  current?: number;
  /** Reels this run produced or found, in the order they were asked for. */
  files: string[];
  /** Set when a verse failed; the run stops there. */
  failedAt?: number;
}

export interface FinishedReel {
  /** Path relative to `output/` — the sura and range folders, then the name. */
  file: string;
  bytes: number;
  createdAt: string;
}

let progress: RenderProgress = { status: "idle", step: "" };

export const getProgress = (): RenderProgress => progress;

export const isBusy = (): boolean =>
  progress.status === "preparing" || progress.status === "rendering";

export interface RenderRequest extends Omit<StageRequest, "onProgress"> {
  dark: boolean;
}

/**
 * Starts a render and returns immediately.
 *
 * The promise is deliberately not returned: an HTTP request cannot be held open
 * for the minutes this takes, so the caller polls `getProgress` instead. The
 * only thing the caller learns synchronously is whether it was accepted.
 */
/**
 * Writes a post's caption beside its reel.
 *
 * A plain .txt in the post's own folder, so everything one Instagram post
 * needs — reel, cover, words — is in one place and can be worked through a
 * folder at a time when the week is scheduled.
 *
 * The text is built by the page, with the same `buildCaption` the single view
 * uses, and sent when the batch starts. Generating it here would mean a second
 * implementation of the caption, and the two would drift.
 */
const writeCaption = async (
  surah: number,
  ayah: number,
  caption: string
): Promise<void> => {
  const dir = path.join(
    config.paths.output,
    await postFolder(surah, ayah, ayah)
  );
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `caption-${String(surah).padStart(3, "0")}-${String(ayah).padStart(3, "0")}.txt`),
    caption,
    "utf-8"
  );
};

/**
 * The reel this request would produce, if it is already on disk.
 *
 * Asked before staging rather than after, so a verse already rendered costs a
 * stat instead of minutes. Built from the same `reelPath` the render writes to,
 * so the two cannot disagree about where a reel lives.
 */
const existingReel = async (
  request: RenderRequest
): Promise<string | null> => {
  const name = path.join(
    await postFolder(request.surah, request.from, request.to),
    reelFileName(request.surah, request.from, request.to, request.dark)
  );
  try {
    await fs.access(path.join(config.paths.output, name));
    return name;
  } catch {
    return null;
  }
};

/**
 * Stages and renders one reel, reporting into `progress` as it goes.
 *
 * Shared by the single render and the batch rather than written twice: the
 * batch runs unattended, so it is the last place that should drift from the
 * path a person watches.
 *
 * Returns the reel's path relative to `output/`.
 */
const renderOne = async (
  request: RenderRequest,
  note: (step: string) => string = (step) => step
): Promise<string> => {
  const file = await stageReel({
    ...request,
    onProgress: (step) => {
      progress = { ...progress, step: note(step) };
    },
  });

  const name = await reelPath(file, request.dark);
  progress = {
    ...progress,
    status: "rendering",
    reference: file.reference,
    step: note(`rendering ${file.verses.length} verse(s)`),
  };

  await renderStaged(file, request.dark);
  return name;
};

export const startRender = (
  request: RenderRequest,
  extras: { cover?: boolean; surahTamil?: string } = {}
): void => {
  progress = {
    status: "preparing",
    step: "resolving the verses",
    startedAt: new Date().toISOString(),
  };

  void (async () => {
    try {
      const name = await renderOne(request);

      // The same three files a batch produces. Making the reel without its
      // cover left this path unable to use the opening frame at all, and the
      // operator to remember a step the batch does for them.
      if (extras.cover) {
        progress = { ...progress, step: "cover" };
        const coverFile = await buildCover({
          surah: request.surah,
          from: request.from,
          to: request.to,
          surahTamil: extras.surahTamil ?? "",
        });
      }

      progress = {
        status: "completed",
        step: "done",
        reference: progress.reference,
        file: name,
        startedAt: progress.startedAt,
      };
    } catch (error) {
      progress = {
        status: "error",
        step: "failed",
        error: (error as Error).message,
        startedAt: progress.startedAt,
      };
    }
  })();
};

/**
 * Renders one reel per verse, in order, one at a time.
 *
 * Sequential for the same reason a single render is: a render saturates every
 * core, and there is one staged job file. A queue here rather than in the page
 * so that closing the tab does not abandon the rest of the week's posts — the
 * same reason progress is polled rather than pushed.
 *
 * **Stops at the first failure.** The posts go out in mushaf order, so a gap in
 * the middle is worse than a short run: better to fix verse 7 and re-run than
 * to discover later that only 7 of 10 exist. Re-running is cheap because a
 * verse whose reel is already on disk is skipped.
 */
export interface BatchVerse {
  ayah: number;
  /** Overrides the batch's reciter for this verse alone. */
  reciterId?: string;
  /** Written beside the reel, ready to paste into Instagram. */
  caption?: string;
}

export const startBatch = (
  items: BatchVerse[],
  base: Omit<RenderRequest, "from" | "to">,
  extras: { cover: boolean; surahTamil: string }
): void => {
  progress = {
    status: "preparing",
    step: "starting",
    startedAt: new Date().toISOString(),
    batch: { total: items.length, done: 0, skipped: 0, files: [] },
  };

  void (async () => {
    const batch: BatchProgress = progress.batch!;

    for (const [index, item] of items.entries()) {
      const ayah = item.ayah;
      const position = `${index + 1} of ${items.length}`;
      progress = {
        ...progress,
        status: "preparing",
        batch: { ...batch, current: ayah },
      };

      const request: RenderRequest = {
        ...base,
        from: ayah,
        to: ayah,
        reciterId: item.reciterId || base.reciterId,
      };

      try {
        // Already rendered is a success, not work: re-running a range after
        // fixing one verse should not spend minutes redoing the rest. The
        // cover and caption are made anyway — they cost seconds, and a post
        // missing one of them is as unusable as a post missing the reel.
        const existing = await existingReel(request);
        if (existing) {
          batch.skipped += 1;
          batch.files.push(existing);
        } else {
          const name = await renderOne(
            request,
            (step) => `${base.surah}:${ayah} (${position}) — ${step}`
          );
          batch.done += 1;
          batch.files.push(name);
        }

        if (extras.cover) {
          progress = {
            ...progress,
            step: `${base.surah}:${ayah} (${position}) — cover`,
          };
          await buildCover({
            surah: base.surah,
            from: ayah,
            to: ayah,
            surahTamil: extras.surahTamil,
          });
        }

        if (item.caption) {
          await writeCaption(base.surah, ayah, item.caption);
        }

        progress = { ...progress, batch: { ...batch, current: ayah } };
      } catch (error) {
        batch.failedAt = ayah;
        progress = {
          status: "error",
          step: `stopped at ${base.surah}:${ayah}`,
          error: (error as Error).message,
          startedAt: progress.startedAt,
          batch: { ...batch, current: ayah },
        };
        return;
      }
    }

    progress = {
      status: "completed",
      step:
        batch.done === 0
          ? `all ${batch.total} already rendered`
          : `${batch.done} rendered` +
            (batch.skipped ? `, ${batch.skipped} already there` : ""),
      startedAt: progress.startedAt,
      batch: { ...batch, current: undefined },
    };
  })();
};

export const reset = (): void => {
  if (!isBusy()) {
    progress = { status: "idle", step: "" };
  }
};

/**
 * Every reel under `output/`, newest first.
 *
 * Walked two levels deep — sura folder, then range folder — and the top level
 * as well, because everything rendered before the per-sura layout sits flat
 * there and should not vanish from the list.
 */
const collect = async (
  dir: string,
  prefix: string,
  depth: number
): Promise<FinishedReel[]> => {
  const entries = await fs
    .readdir(dir, { withFileTypes: true })
    .catch(() => []);

  const found = await Promise.all(
    entries.map(async (entry): Promise<FinishedReel[]> => {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        return depth > 0
          ? collect(path.join(dir, entry.name), relative, depth - 1)
          : [];
      }

      if (!REEL_FILE.test(entry.name)) {
        return [];
      }

      const stat = await fs.stat(path.join(dir, entry.name));
      // The path carries the sura and the range already, so nothing else is
      // stored. A sidecar for this would be one more thing to keep in step
      // with the directory.
      return [
        {
          file: relative,
          bytes: stat.size,
          createdAt: stat.mtime.toISOString(),
        },
      ];
    })
  );

  return found.flat();
};

/** Everything rendered so far, newest first. */
export const history = async (): Promise<FinishedReel[]> => {
  const reels = await collect(config.paths.output, "", 2);
  return reels.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
};
