/**
 * The `quran-tamil-publisher` Lambda. Bundled by `npm run aws:setup` into one
 * file; the AWS SDK is left out because the Node runtime already has it.
 *
 * Its configuration comes from the function's environment, set by the setup
 * script. The Instagram token is read from SSM (encrypted) on each run, so a
 * new token only needs `npm run aws:token`, not a redeploy.
 */
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DEFAULT_GRAPH_VERSION, detectLoginKind, InstagramClient, type LoginKind } from "../instagram/client.js";
import { InstagramAccount, InstagramPublisher } from "../instagram/publisher.js";
import { SchedulerAlarms } from "./alarms.js";
import { DynamoPostsStore } from "./dynamoStore.js";
import { S3PostFiles } from "./files.js";
import { cloudNames, type PublishEvent } from "./names.js";
import { handlePublish, type PublishOutcome } from "./publishPost.js";

const names = cloudNames(process.env);

async function readToken(ssm: SSMClient): Promise<string> {
  const { Parameter } = await ssm.send(
    new GetParameterCommand({ Name: names.tokenParameter, WithDecryption: true })
  );
  const token = Parameter?.Value?.trim();
  if (!token) throw new Error(`${names.tokenParameter} is empty — run npm run aws:token`);
  return token;
}

async function buildPublisher(): Promise<InstagramPublisher> {
  const token = await readToken(new SSMClient({ region: names.region }));
  const version = process.env.INSTAGRAM_GRAPH_VERSION?.trim() || DEFAULT_GRAPH_VERSION;
  const forced = process.env.INSTAGRAM_LOGIN?.trim();
  const login: LoginKind =
    forced === "instagram" || forced === "facebook" ? forced : await detectLoginKind(token, version);
  const client = new InstagramClient({
    token: async () => token,
    login,
    igUserId: process.env.INSTAGRAM_USER_ID?.trim() || null,
    version,
  });
  // No link host: the cloud always hands Instagram signed S3 links.
  return new InstagramPublisher(new InstagramAccount(client), null);
}

const isEvent = (value: unknown): value is PublishEvent =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as PublishEvent).postId === "string" &&
  /^[a-z0-9-]{1,100}$/.test((value as PublishEvent).postId);

/** `npm run aws:check`: can the publisher read its token and see the account? Posts nothing. */
async function check(): Promise<{ result: "ok"; username: string } | { result: "error"; error: string }> {
  try {
    const publisher = await buildPublisher();
    return { result: "ok", username: (await publisher.account.info()).username };
  } catch (error: unknown) {
    return { result: "error", error: error instanceof Error ? error.message : String(error) };
  }
}

export async function handler(
  event: unknown,
  context: { invokedFunctionArn: string }
): Promise<PublishOutcome | Awaited<ReturnType<typeof check>>> {
  if (typeof event === "object" && event !== null && (event as { check?: unknown }).check === true) return check();
  if (!isEvent(event)) return { result: "skipped", reason: "Not a publish event" };
  const outcome = await handlePublish(event, {
    store: new DynamoPostsStore(names.table, names.region),
    files: new S3PostFiles(names.bucket, names.region),
    alarms: new SchedulerAlarms(
      {
        group: names.scheduleGroup,
        // The alarm's own ARN without a version qualifier, so retries call $LATEST.
        functionArn: context.invokedFunctionArn.split(":").slice(0, 7).join(":"),
        roleArn: process.env.SCHEDULER_ROLE_ARN ?? "",
      },
      names.region
    ),
    publisher: buildPublisher,
  });
  console.info(`[publisher] ${event.postId}: ${JSON.stringify(outcome)}`);
  return outcome;
}
