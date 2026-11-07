/**
 * Putting the posting queue together from `.env`.
 *
 * Without INSTAGRAM_ACCESS_TOKEN nothing is wrong: posts can still be queued,
 * they just wait until a token is added and the server restarted.
 *
 * Two kinds of token work. They are told apart by asking Instagram, not by
 * prefix: Meta's Unified Login issues Instagram Login tokens starting EAA too.
 * INSTAGRAM_LOGIN=instagram|facebook settles it by hand if detection is wrong.
 * - Instagram Login: Instagram fetches the reel from a temporary public link (a
 *   Cloudflare quick tunnel that serves that one file and nothing else).
 * - Facebook Login / Business system user: the reel is uploaded straight from
 *   this Mac.
 *
 * Either way the cover still goes by a temporary link: Instagram only takes a
 * custom cover as a URL.
 *
 * Where posts are published from:
 * - AWS, once `npm run aws:setup` has written `data/aws-posting.json`: the
 *   queue is in DynamoDB and the cloud publisher posts with this Mac off. The
 *   .env token is still used here, but only to show who we are connected as.
 * - This Mac otherwise, or when POSTING_BACKEND=local.
 */
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { config, PROJECT_ROOT } from "../config/config.js";
import { DEFAULT_GRAPH_VERSION, detectLoginKind, InstagramClient, type LoginKind } from "../instagram/client.js";
import { connectionStatus } from "../instagram/connection.js";
import { InstagramAccount, InstagramPublisher } from "../instagram/publisher.js";
import { TokenStore } from "../instagram/tokenStore.js";
import { TunnelVideoHost } from "../instagram/videoHost.js";
import { DynamoPostsStore } from "../cloud/dynamoStore.js";
import { cloudNames } from "../cloud/names.js";
import { AwsRemote } from "../cloud/remote.js";
import { PostService } from "./service.js";
import { JsonPostsStore } from "./store.js";
import type { InstagramConnection } from "./types.js";

const DAY_MS = 86_400_000;

export interface Posting {
  posts: PostService;
  instagram: () => Promise<InstagramConnection>;
  /** Starts the minute tick and, for Instagram Login tokens, the weekly refresh. */
  start: () => Promise<void>;
  describe: () => Promise<string>;
}

export async function setUpPosting(env: NodeJS.ProcessEnv = process.env): Promise<Posting> {
  const token = env.INSTAGRAM_ACCESS_TOKEN?.trim();
  let account: InstagramAccount | null = null;
  let publisher: InstagramPublisher | null = null;
  let refresh: (() => Promise<void>) | null = null;

  if (token) {
    const version = env.INSTAGRAM_GRAPH_VERSION?.trim() || DEFAULT_GRAPH_VERSION;
    const holder: { tokens?: TokenStore; client?: InstagramClient } = {};
    // Refreshed tokens are kept beside the data, mode 0600, never in .env.
    holder.tokens = new TokenStore(
      path.join(config.paths.data, "instagram-token.json"),
      token,
      (t) => holder.client!.refreshToken(t)
    );
    // Asked with the token actually in use (a refreshed one may have replaced
    // the .env one), unless INSTAGRAM_LOGIN settles it.
    const forced = env.INSTAGRAM_LOGIN?.trim();
    const login: LoginKind =
      forced === "instagram" || forced === "facebook"
        ? forced
        : await detectLoginKind(await holder.tokens.get(), version);
    const client = new InstagramClient({
      token: () => holder.tokens!.get(),
      login,
      igUserId: env.INSTAGRAM_USER_ID?.trim() || null,
      version,
    });
    holder.client = client;
    console.log(
      `   🔑 Instagram token: ${login === "instagram" ? "Instagram Login (video by temporary link)" : "Facebook/Business (direct upload)"}`
    );
    if (login === "instagram") {
      // Instagram Login tokens lapse after 60 days unless refreshed; Business tokens do not.
      refresh = () =>
        holder.tokens!.refreshIfDue().catch((e: unknown) =>
          console.error("[instagram] token refresh failed:", e instanceof Error ? e.message : e)
        );
    }
    account = new InstagramAccount(client);
    publisher = new InstagramPublisher(account, new TunnelVideoHost());
  }

  const cloud = await cloudSetup(env);
  let posts: PostService;
  if (cloud) {
    const names = { ...cloudNames(env), ...cloud.names };
    posts = new PostService({
      store: new DynamoPostsStore(names.table, names.region),
      publisher: null,
      remote: new AwsRemote({ names, functionArn: cloud.functionArn, schedulerRoleArn: cloud.schedulerRoleArn }),
    });
  } else {
    await mkdir(config.paths.output, { recursive: true });
    const store = new JsonPostsStore(path.join(config.paths.output, "schedule.json"));
    await store.recoverInterrupted();
    posts = new PostService({ store, publisher });
  }
  const instagram = connectionStatus(account);

  return {
    posts,
    instagram,
    start: async () => {
      if (refresh) {
        await refresh();
        setInterval(refresh, DAY_MS).unref();
      }
      posts.start();
    },
    describe: async () => {
      const c = await instagram();
      if (!c.configured) return "not connected — set INSTAGRAM_ACCESS_TOKEN in .env to post";
      return c.username ? `connected as @${c.username}` : `token problem: ${c.error}`;
    },
  };
}

/** What `npm run aws:setup` records about the resources it made. */
export const CLOUD_FILE = path.join(config.paths.data, "aws-posting.json");

export interface CloudSetup {
  names: { region: string; bucket: string; table: string; scheduleGroup: string };
  functionArn: string;
  schedulerRoleArn: string;
}

async function cloudSetup(env: NodeJS.ProcessEnv): Promise<CloudSetup | null> {
  const wanted = env.POSTING_BACKEND?.trim();
  if (wanted === "local") return null;
  const raw = await readFile(CLOUD_FILE, "utf8").catch(() => null);
  if (!raw) {
    if (wanted === "aws") throw new Error(`POSTING_BACKEND=aws but ${CLOUD_FILE} is missing — run npm run aws:setup`);
    return null;
  }
  return JSON.parse(raw) as CloudSetup;
}

/** Where the queue lives, for the startup banner. */
export const SCHEDULE_FILE = path.relative(
  PROJECT_ROOT,
  path.join(config.paths.output, "schedule.json")
);
