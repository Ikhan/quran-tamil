/**
 * `npm run aws:check` — proves the cloud publisher works end to end without
 * posting anything:
 *
 *   1. The Lambda reads its token from SSM and sees the Instagram account (read-only).
 *   2. A file in S3 is readable by a signed link, and not without one.
 *   3. A real alarm fires the Lambda, which claims a dummy post and fails it
 *      safely (the dummy has no reel, so Instagram is never contacted). The
 *      alarm then deletes itself and the dummy is removed.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { ListSchedulesCommand, SchedulerClient } from "@aws-sdk/client-scheduler";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SchedulerAlarms } from "../server/cloud/alarms.js";
import { DynamoPostsStore } from "../server/cloud/dynamoStore.js";
import { S3PostFiles } from "../server/cloud/files.js";
import { schedulePrefix } from "../server/cloud/names.js";
import type { CloudSetup } from "../server/posts/posting.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const setup = JSON.parse(readFileSync(path.join(ROOT, "data", "aws-posting.json"), "utf8")) as CloudSetup;
const { region, bucket, table, scheduleGroup } = setup.names;

let failures = 0;
const pass = (text: string) => console.info(`  ✓ ${text}`);
const fail = (text: string) => {
  failures++;
  console.error(`  ✗ ${text}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function lambdaCheck(): Promise<void> {
  console.info("1. Publisher can read its token and see Instagram");
  const lambda = new LambdaClient({ region });
  const res = await lambda.send(
    new InvokeCommand({ FunctionName: setup.functionArn, Payload: new TextEncoder().encode(JSON.stringify({ check: true })) })
  );
  const body = JSON.parse(new TextDecoder().decode(res.Payload)) as { result: string; username?: string; error?: string; errorMessage?: string };
  if (res.FunctionError) fail(`Lambda crashed: ${body.errorMessage}`);
  else if (body.result === "ok") pass(`connected as @${body.username}`);
  else fail(body.error ?? JSON.stringify(body));
}

async function linkCheck(): Promise<void> {
  console.info("2. S3 files reach Instagram by signed link only");
  const files = new S3PostFiles(bucket, region);
  const key = `reels/smoke-${Date.now()}/reel.mp4`;
  const bytes = path.join(ROOT, "package.json");
  await files.upload(key, bytes, "video/mp4");
  try {
    const signed = await fetch(await files.link(key));
    const same = signed.ok && (await signed.text()) === readFileSync(bytes, "utf8");
    if (same) pass("signed link serves the file");
    else fail(`signed link: HTTP ${signed.status}`);
    const bare = await fetch(`https://${bucket}.s3.${region}.amazonaws.com/${key}`);
    if (bare.status === 403) pass("unsigned link refused (bucket is private)");
    else fail(`unsigned link: HTTP ${bare.status} — the bucket should refuse it`);
  } finally {
    await files.remove([key]);
  }
}

async function alarmCheck(): Promise<void> {
  console.info("3. An alarm fires the publisher, which claims the post (about two minutes)");
  const store = new DynamoPostsStore(table, region);
  const alarms = new SchedulerAlarms({ group: scheduleGroup, functionArn: setup.functionArn, roleArn: setup.schedulerRoleArn }, region);
  const id = `smoke-${Date.now().toString(36)}`;
  const at = new Date(Date.now() + 75_000).toISOString();
  // No reel_key: the publisher refuses it before it ever reads the token.
  await store.create({ id, reel_file: "smoke-test.mp4", cover_file: null, reference: "smoke test", caption: "smoke test", scheduled_at: at });
  try {
    await alarms.arm(id, at);
    pass(`alarm set for ${at}`);
    const deadline = Date.now() + 4 * 60_000;
    let post = await store.get(id);
    while (post?.status === "scheduled" && Date.now() < deadline) {
      await sleep(10_000);
      post = await store.get(id);
    }
    if (post?.status === "failed" && /never copied to S3/.test(post.error ?? "") && post.attempts === 1) {
      pass(`fired at ${post.updated_at}; claimed once and stopped safely: "${post.error}"`);
    } else {
      fail(`post ended ${post?.status} (${post?.error}) — see CloudWatch logs /aws/lambda/quran-tamil-publisher`);
    }
    const left = await new SchedulerClient({ region }).send(
      new ListSchedulesCommand({ GroupName: scheduleGroup, NamePrefix: schedulePrefix(id) })
    );
    if ((left.Schedules ?? []).length === 0) pass("the alarm deleted itself after firing");
    else fail("the alarm is still there after firing");
  } finally {
    await alarms.disarm(id).catch(() => undefined);
    await DynamoDBDocumentClient.from(new DynamoDBClient({ region })).send(new DeleteCommand({ TableName: table, Key: { id } }));
  }
}

await lambdaCheck();
await linkCheck();
await alarmCheck();
console.info(failures ? `\n${failures} check(s) failed` : "\nAll good — nothing was posted.");
process.exitCode = failures ? 1 : 0;
