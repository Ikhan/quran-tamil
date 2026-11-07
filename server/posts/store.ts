/**
 * `output/schedule.json`: the posting settings and the post queue.
 *
 * A file rather than a database because there is one operator and a few
 * hundred posts at most. Writes are serialised and atomic (temp file, then
 * rename), so a crash mid-write leaves the previous queue rather than half of
 * one — and the queue is the record of what has gone out to Instagram.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  DEFAULT_SETTINGS,
  postEntrySchema,
  scheduleSettingsSchema,
  type PostEntry,
  type ScheduleSettings,
} from "./types.js";

const fileSchema = z.object({
  settings: scheduleSettingsSchema,
  posts: z.array(postEntrySchema),
});
type ScheduleFile = z.infer<typeof fileSchema>;

export type NewPost = Pick<
  PostEntry,
  "id" | "reel_file" | "cover_file" | "reference" | "caption" | "scheduled_at"
> &
  Partial<Pick<PostEntry, "reel_key" | "cover_key">>;
export type PostPatch = Partial<
  Omit<PostEntry, "id" | "reel_file" | "created_at" | "updated_at">
>;

/** A guarded update: applied only while the post still matches. */
export interface ClaimCondition {
  status: readonly PostEntry["status"][];
  scheduledAt?: string;
  claimToken?: string;
  updatedAt?: string;
}

/** What the queue needs from storage — a JSON file here, DynamoDB in AWS mode. */
export interface PostsStore {
  settings(): Promise<ScheduleSettings>;
  saveSettings(settings: ScheduleSettings): Promise<ScheduleSettings>;
  list(): Promise<readonly PostEntry[]>;
  get(id: string): Promise<PostEntry | null>;
  create(post: NewPost): Promise<PostEntry>;
  update(id: string, patch: PostPatch): Promise<PostEntry | null>;
  /**
   * Update only if the post still matches `when`, in one atomic step; null if
   * it did not. This is what stops one post from being published twice.
   */
  claim(id: string, when: ClaimCondition, patch: PostPatch): Promise<PostEntry | null>;
}

/** A just-queued post, before anything has happened to it. */
export function newEntry(post: NewPost, now = new Date().toISOString()): PostEntry {
  return {
    ...post,
    status: "scheduled",
    attempts: 0,
    container_id: null,
    media_id: null,
    permalink: null,
    error: null,
    posted_at: null,
    created_at: now,
    updated_at: now,
  };
}

export const claimMatches = (p: PostEntry, when: ClaimCondition): boolean =>
  when.status.includes(p.status) &&
  (when.scheduledAt === undefined || p.scheduled_at === when.scheduledAt) &&
  (when.claimToken === undefined || p.claim_token === when.claimToken) &&
  (when.updatedAt === undefined || p.updated_at === when.updatedAt);

export class JsonPostsStore implements PostsStore {
  private cache: ScheduleFile | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  private async load(): Promise<ScheduleFile> {
    if (this.cache) return this.cache;
    try {
      this.cache = fileSchema.parse(JSON.parse(await readFile(this.file, "utf8")));
    } catch (error: unknown) {
      // Only a missing file starts empty. A corrupt one must stop the server:
      // starting empty would forget what is already queued, and what was posted.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.cache = { settings: DEFAULT_SETTINGS, posts: [] };
    }
    return this.cache;
  }

  private write(mutate: (data: ScheduleFile) => ScheduleFile): Promise<ScheduleFile> {
    const run = this.queue.then(async () => {
      const next = mutate(await this.load());
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      await rename(tmp, this.file);
      this.cache = next;
      return next;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async settings(): Promise<ScheduleSettings> {
    return (await this.load()).settings;
  }

  async saveSettings(settings: ScheduleSettings): Promise<ScheduleSettings> {
    return (await this.write((d) => ({ ...d, settings }))).settings;
  }

  async list(): Promise<readonly PostEntry[]> {
    return (await this.load()).posts;
  }

  async get(id: string): Promise<PostEntry | null> {
    return (await this.load()).posts.find((p) => p.id === id) ?? null;
  }

  async create(post: NewPost): Promise<PostEntry> {
    const entry = newEntry(post);
    await this.write((d) => ({ ...d, posts: [...d.posts, entry] }));
    return entry;
  }

  async update(id: string, patch: PostPatch): Promise<PostEntry | null> {
    let updated: PostEntry | null = null;
    await this.write((d) => ({
      ...d,
      posts: d.posts.map((p) =>
        p.id === id
          ? (updated = { ...p, ...patch, updated_at: new Date().toISOString() })
          : p
      ),
    }));
    return updated;
  }

  async claim(id: string, when: ClaimCondition, patch: PostPatch): Promise<PostEntry | null> {
    let updated: PostEntry | null = null;
    await this.write((d) => ({
      ...d,
      posts: d.posts.map((p) =>
        p.id === id && claimMatches(p, when)
          ? (updated = { ...p, ...patch, updated_at: new Date().toISOString() })
          : p
      ),
    }));
    return updated;
  }

  /**
   * A restart mid-publish leaves it unknown whether Instagram took the post,
   * so those are marked failed and never retried on their own — a retry could
   * post the same verse twice.
   */
  async recoverInterrupted(): Promise<void> {
    await this.write((d) => ({
      ...d,
      posts: d.posts.map((p) =>
        p.status === "publishing"
          ? {
              ...p,
              status: "failed",
              error: "Interrupted while posting — check Instagram before retrying",
              updated_at: new Date().toISOString(),
            }
          : p
      ),
    }));
  }
}
