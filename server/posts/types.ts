/**
 * The Instagram post queue: what a scheduled post is, and what the dashboard
 * may send to change one.
 */
import { z } from "zod";

export const POST_STATUSES = [
  "scheduled",
  "publishing",
  "posted",
  "failed",
  "canceled",
] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

/** Instagram refuses a caption over 2,200 characters, or with more than 30 hashtags. */
export const CAPTION_MAX = 2200;
export const HASHTAG_MAX = 30;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The same count `captionTagCount` in caption.js makes, so page and server agree. */
export const hashtagCount = (text: string): number =>
  (text.match(/#[^\s#]+/g) ?? []).length;

const captionSchema = z
  .string()
  .trim()
  .min(1, "The caption is empty")
  .max(CAPTION_MAX, `Instagram allows ${CAPTION_MAX} characters in a caption`)
  .refine(
    (c) => hashtagCount(c) <= HASHTAG_MAX,
    `Instagram refuses more than ${HASHTAG_MAX} hashtags`
  );

export const scheduleSettingsSchema = z.object({
  /** Daily posting times, 24h "HH:MM" in `timezone`. One post per time per day. */
  times: z
    .array(z.string().regex(TIME, "Times must be HH:MM"))
    .min(1, "Give at least one posting time")
    .max(6, "At most six posts a day")
    .refine((t) => new Set(t).size === t.length, "The same time is listed twice"),
  timezone: z.string().min(1).refine(isTimeZone, "Unknown time zone"),
  paused: z.boolean(),
});
export type ScheduleSettings = z.infer<typeof scheduleSettingsSchema>;

export const DEFAULT_SETTINGS: ScheduleSettings = {
  times: ["19:00"],
  timezone: "Asia/Kolkata",
  paused: false,
};

export const postEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  /** The reel, relative to `output/` — e.g. `002-al-baqara/reel-002-255.mp4`. */
  reel_file: z.string(),
  /** Its cover still, relative to `output/`, when one was made. */
  cover_file: z.string().nullable(),
  /** "2:255" or "55:13-18", for people reading the queue. */
  reference: z.string(),
  caption: z.string().max(CAPTION_MAX),
  scheduled_at: z.string(),
  status: z.enum(POST_STATUSES),
  attempts: z.number().int().min(0),
  container_id: z.string().nullable(),
  media_id: z.string().nullable(),
  permalink: z.string().nullable(),
  error: z.string().nullable(),
  posted_at: z.string().nullable(),
  /** AWS mode: the reel and cover copied to S3 at schedule time, for the cloud publisher. */
  reel_key: z.string().nullable().optional(),
  cover_key: z.string().nullable().optional(),
  /** AWS mode: set by "Post now" so only the publish that was asked for proceeds. */
  claim_token: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type PostEntry = z.infer<typeof postEntrySchema>;

const reelField = z.string().min(1).max(300);
const whenField = z.string().datetime({ offset: true });

export const createPostSchema = z
  .object({
    reel: reelField,
    caption: captionSchema,
    /** Omitted: the next free slot. */
    scheduledAt: whenField.optional(),
    /** Post right away instead of queueing. */
    now: z.boolean().optional(),
  })
  .strict();

/** A batch's reels, in the order they should go out. */
export const createManySchema = z
  .object({
    items: z
      .array(
        // Without a caption, the one a batch wrote beside the reel is used.
        z.object({ reel: reelField, caption: captionSchema.optional() }).strict()
      )
      .min(1)
      .max(200),
  })
  .strict();

export const updatePostSchema = z
  .object({
    caption: captionSchema.optional(),
    scheduledAt: whenField.optional(),
  })
  .strict()
  .refine(
    (v) => v.caption !== undefined || v.scheduledAt !== undefined,
    "Nothing to update"
  );

export interface InstagramConnection {
  configured: boolean;
  username: string | null;
  error: string | null;
  /** Posts published through the API in the last 24 h, and Instagram's cap. */
  quota: { used: number; total: number } | null;
}
