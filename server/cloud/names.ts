/**
 * Every AWS resource the cloud publisher uses, by name. One place, so the
 * dashboard, the Lambda and the setup script cannot disagree about them.
 *
 * Mumbai by default. Nothing here reads the machine's default region: the
 * resources live in one region, wherever `aws configure` happens to point.
 */
export interface CloudNames {
  region: string;
  bucket: string;
  table: string;
  functionName: string;
  scheduleGroup: string;
  publisherRole: string;
  schedulerRole: string;
  tokenParameter: string;
}

export function cloudNames(env: NodeJS.ProcessEnv = process.env, accountId?: string): CloudNames {
  const pick = (key: string, fallback: string) => env[key]?.trim() || fallback;
  return {
    region: pick("AWS_POSTING_REGION", "ap-south-1"),
    bucket: pick("AWS_POSTING_BUCKET", accountId ? `quran-tamil-posts-${accountId}` : ""),
    table: pick("AWS_POSTING_TABLE", "quran-tamil-posts"),
    functionName: pick("AWS_POSTING_FUNCTION", "quran-tamil-publisher"),
    scheduleGroup: pick("AWS_POSTING_SCHEDULE_GROUP", "quran-tamil"),
    publisherRole: "quran-tamil-publisher-role",
    schedulerRole: "quran-tamil-scheduler-role",
    tokenParameter: pick("AWS_POSTING_TOKEN_PARAMETER", "/quran-tamil/instagram-token"),
  };
}

/** Where a post's files sit in the bucket. Deleted once it is posted or canceled. */
export const objectKeys = (postId: string) => ({
  reel: `reels/${postId}/reel.mp4`,
  cover: `reels/${postId}/cover.png`,
});

/** Every alarm of one post starts with this, so they can all be found and removed. */
export const schedulePrefix = (postId: string): string => `post-${postId}`.slice(0, 55) + "--";

/**
 * Names allow 64 characters of [0-9a-zA-Z-_.]. Each alarm is named for its
 * time: a fired alarm deletes itself a moment after it runs, and a new alarm
 * under the same name (a retry, a pause) could be deleted along with it.
 */
export const scheduleName = (postId: string, at: string): string =>
  `${schedulePrefix(postId)}${Math.floor(Date.parse(at) / 1000).toString(36)}`;

/** What an alarm (or "Post now") hands the Lambda. */
export interface PublishEvent {
  postId: string;
  /** Alarm: the time it was set for. A post moved since then is left alone. */
  at?: string;
  /** Post now: the token the dashboard claimed the post with. */
  claim?: string;
}
