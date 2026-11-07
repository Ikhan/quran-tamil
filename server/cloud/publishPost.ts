/**
 * What the cloud publisher does when an alarm (or "Post now") fires for a post.
 *
 * The same rules as the queue on the Mac, because a double post is worse than
 * a late one:
 * - The post is claimed first, in one conditional write. Only one invocation
 *   can win it; a duplicate delivery, or an alarm for a post that has since
 *   been moved, edited or canceled, finds nothing to do.
 * - A failure Instagram cannot have acted on is retried: three attempts,
 *   fifteen minutes apart, each with its own alarm.
 * - A failure where the publish call itself was ambiguous is marked failed and
 *   never retried on its own. A person checks Instagram, then retries.
 *
 * AWS clients come in as dependencies, so this is tested without AWS.
 */
import { PublishError, type ReelPublisher } from "../instagram/publisher.js";
import { nextFreeSlots, takenTimes } from "../posts/slots.js";
import type { PostsStore } from "../posts/store.js";
import type { PostEntry } from "../posts/types.js";
import type { Alarms } from "./alarms.js";
import type { PostFiles } from "./files.js";
import type { PublishEvent } from "./names.js";

export interface CloudPublishDeps {
  store: PostsStore;
  alarms: Alarms;
  files: PostFiles;
  /** Built on first use: reading the token is only worth doing once a post is won. */
  publisher: () => Promise<ReelPublisher>;
  now?: () => Date;
  retryDelayMs?: number;
  maxAttempts?: number;
  log?: Pick<Console, "info" | "error">;
}

export type PublishOutcome =
  | { result: "posted"; permalink: string | null }
  | { result: "retrying"; at: string }
  | { result: "failed"; error: string }
  | { result: "deferred"; at: string }
  | { result: "skipped"; reason: string };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const postKeys = (post: PostEntry): string[] =>
  [post.reel_key, post.cover_key].filter((k): k is string => Boolean(k));

export async function handlePublish(event: PublishEvent, deps: CloudPublishDeps): Promise<PublishOutcome> {
  const post = await deps.store.get(event.postId);
  if (!post) return { result: "skipped", reason: "No such post" };

  if (event.claim === undefined && (await deps.store.settings()).paused) {
    return defer(post, event, deps);
  }

  const claimed = await claim(post, event, deps.store);
  if (!claimed) return { result: "skipped", reason: `The post is ${post.status}, or was moved` };
  return publish(claimed, deps);
}

/**
 * The dashboard claims a "Post now" itself (so the page can show it posting at
 * once) and passes the token; the publisher only goes ahead with that token.
 * An alarm claims the post here, and only if it is still at the alarm's time.
 */
function claim(post: PostEntry, event: PublishEvent, store: PostsStore): Promise<PostEntry | null> {
  const attempts = post.attempts + 1;
  if (event.claim !== undefined) {
    return store.claim(
      post.id,
      { status: ["publishing"], claimToken: event.claim },
      { claim_token: null, attempts }
    );
  }
  return store.claim(
    post.id,
    { status: ["scheduled"], scheduledAt: event.at ?? "" },
    { status: "publishing", attempts, error: null }
  );
}

/** Paused: nothing goes out. The post moves to the next free slot and keeps its place in line. */
async function defer(post: PostEntry, event: PublishEvent, deps: CloudPublishDeps): Promise<PublishOutcome> {
  const now = deps.now?.() ?? new Date();
  const others = (await deps.store.list()).filter((p) => p.id !== post.id);
  const [slot] = nextFreeSlots(await deps.store.settings(), takenTimes(others), now, 1);
  const at = slot.toISOString();
  const moved = await deps.store.claim(
    post.id,
    { status: ["scheduled"], scheduledAt: event.at ?? "" },
    { scheduled_at: at, error: "Paused when it was due — moved to the next free slot" }
  );
  if (!moved) return { result: "skipped", reason: `The post is ${post.status}, or was moved` };
  await deps.alarms.arm(post.id, at);
  return { result: "deferred", at };
}

async function publish(post: PostEntry, deps: CloudPublishDeps): Promise<PublishOutcome> {
  const log = deps.log ?? console;
  const now = () => deps.now?.() ?? new Date();
  try {
    if (!post.reel_key) throw new PublishError("The reel was never copied to S3 — schedule it again", false);
    const publisher = await deps.publisher().catch((error: unknown) => {
      throw new PublishError(`Instagram token: ${message(error)}`, true);
    });
    const [videoUrl, coverUrl] = await Promise.all([
      deps.files.link(post.reel_key),
      post.cover_key ? deps.files.link(post.cover_key) : Promise.resolve(null),
    ]);
    const result = await publisher.publish({
      videoUrl,
      coverUrl,
      caption: post.caption,
      onContainer: async (containerId) => void (await deps.store.update(post.id, { container_id: containerId })),
    });
    await deps.store.update(post.id, {
      status: "posted",
      media_id: result.mediaId,
      permalink: result.permalink,
      posted_at: now().toISOString(),
      error: null,
    });
    log.info(`[publisher] posted ${post.reference} → ${result.permalink ?? result.mediaId}`);
    await cleanUp(post, deps);
    return { result: "posted", permalink: result.permalink };
  } catch (error: unknown) {
    return failed(post, error, deps, now());
  }
}

async function failed(post: PostEntry, error: unknown, deps: CloudPublishDeps, now: Date): Promise<PublishOutcome> {
  const log = deps.log ?? console;
  const msg = message(error);
  const maxAttempts = deps.maxAttempts ?? 3;
  const retry = (!(error instanceof PublishError) || error.safeToRetry) && post.attempts < maxAttempts;
  log.error(`[publisher] posting ${post.reference} failed (attempt ${post.attempts}): ${msg}`);

  if (!retry) {
    await deps.store.update(post.id, { status: "failed", error: msg });
    return { result: "failed", error: msg };
  }
  const at = new Date(now.getTime() + (deps.retryDelayMs ?? 15 * 60_000)).toISOString();
  await deps.store.update(post.id, {
    status: "scheduled",
    scheduled_at: at,
    error: `Attempt ${post.attempts} failed: ${msg} — retrying`,
  });
  try {
    await deps.alarms.arm(post.id, at);
  } catch (alarmError: unknown) {
    const why = `${msg} — and the retry could not be set: ${message(alarmError)}`;
    await deps.store.update(post.id, { status: "failed", error: why });
    return { result: "failed", error: why };
  }
  return { result: "retrying", at };
}

/** The files are only needed until the post is out. A failed clean-up is logged, not fatal: the post did go out. */
async function cleanUp(post: PostEntry, deps: CloudPublishDeps): Promise<void> {
  try {
    await deps.files.remove(postKeys(post));
  } catch (error: unknown) {
    (deps.log ?? console).error(`[publisher] could not delete ${post.reference}'s files: ${message(error)}`);
  }
}
