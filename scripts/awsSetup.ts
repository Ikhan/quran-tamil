/**
 * Creates (or brings up to date) everything the cloud publisher needs, in one
 * region — Mumbai unless AWS_POSTING_REGION says otherwise:
 *
 *   S3 bucket        quran-tamil-posts-<account>   private
 *   DynamoDB table   quran-tamil-posts             the queue and settings
 *   SSM parameter    /quran-tamil/instagram-token  SecureString, from .env
 *   IAM roles        quran-tamil-publisher-role, quran-tamil-scheduler-role
 *   Lambda           quran-tamil-publisher         Node 22, this repo's code
 *   Schedule group   quran-tamil                   one alarm per queued post
 *
 * Safe to run again: what exists is left in place and its settings re-applied,
 * and the Lambda gets the current code. Nothing outside these names is touched.
 *
 *   npm run aws:setup     everything
 *   npm run aws:deploy    only the Lambda's code (after changing server/cloud or server/instagram)
 *   npm run aws:token     only the token, after pasting a new one into .env
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { CloudWatchLogsClient, CreateLogGroupCommand, PutRetentionPolicyCommand } from "@aws-sdk/client-cloudwatch-logs";
import { CreateTableCommand, DescribeTableCommand, DynamoDBClient, ResourceNotFoundException, waitUntilTableExists } from "@aws-sdk/client-dynamodb";
import { AttachRolePolicyCommand, CreateRoleCommand, GetRoleCommand, IAMClient, NoSuchEntityException, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import {
  CreateFunctionCommand,
  GetFunctionCommand,
  LambdaClient,
  PutFunctionEventInvokeConfigCommand,
  ResourceNotFoundException as LambdaNotFound,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
  waitUntilFunctionActiveV2,
  waitUntilFunctionUpdatedV2,
} from "@aws-sdk/client-lambda";
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketLifecycleConfigurationCommand,
  PutPublicAccessBlockCommand,
  S3Client,
  type BucketLocationConstraint,
} from "@aws-sdk/client-s3";
import { CreateScheduleGroupCommand, GetScheduleGroupCommand, ResourceNotFoundException as GroupNotFound, SchedulerClient } from "@aws-sdk/client-scheduler";
import { PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { cloudNames, type CloudNames } from "../server/cloud/names.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLOUD_FILE = path.join(ROOT, "data", "aws-posting.json");
const LOG_DAYS = 30;

const step = (text: string) => console.info(`• ${text}`);
const named = (error: unknown, name: string) => (error as { name?: string })?.name === name;

interface Context {
  names: CloudNames;
  account: string;
  arns: { table: string; parameter: string; functionArn: string; publisherRole: string; schedulerRole: string; schedules: string };
}

async function context(): Promise<Context> {
  const base = cloudNames(process.env);
  const { Account } = await new STSClient({ region: base.region }).send(new GetCallerIdentityCommand({}));
  if (!Account) throw new Error("AWS did not say which account this is — check `aws sts get-caller-identity`");
  const names = cloudNames(process.env, Account);
  const { region } = names;
  return {
    names,
    account: Account,
    arns: {
      table: `arn:aws:dynamodb:${region}:${Account}:table/${names.table}`,
      parameter: `arn:aws:ssm:${region}:${Account}:parameter${names.tokenParameter}`,
      functionArn: `arn:aws:lambda:${region}:${Account}:function:${names.functionName}`,
      publisherRole: `arn:aws:iam::${Account}:role/${names.publisherRole}`,
      schedulerRole: `arn:aws:iam::${Account}:role/${names.schedulerRole}`,
      schedules: `arn:aws:scheduler:${region}:${Account}:schedule/${names.scheduleGroup}/*`,
    },
  };
}

async function bucket({ names }: Context): Promise<void> {
  const s3 = new S3Client({ region: names.region });
  try {
    await s3.send(new HeadBucketCommand({ Bucket: names.bucket }));
    step(`S3 bucket ${names.bucket} exists`);
  } catch (error: unknown) {
    if (!named(error, "NotFound")) throw error;
    await s3.send(
      new CreateBucketCommand({
        Bucket: names.bucket,
        CreateBucketConfiguration: { LocationConstraint: names.region as BucketLocationConstraint },
      })
    );
    step(`S3 bucket ${names.bucket} created`);
  }
  await s3.send(
    new PutPublicAccessBlockCommand({
      Bucket: names.bucket,
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true },
    })
  );
  // No expiry on the files themselves: a post can be queued months ahead, and
  // its reel must still be there. They are deleted once posted or canceled.
  await s3.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: names.bucket,
      LifecycleConfiguration: {
        Rules: [{ ID: "abort-unfinished-uploads", Status: "Enabled", Filter: { Prefix: "" }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } }],
      },
    })
  );
  step("  private; public access blocked");
}

async function table({ names }: Context): Promise<void> {
  const db = new DynamoDBClient({ region: names.region });
  try {
    await db.send(new DescribeTableCommand({ TableName: names.table }));
    step(`DynamoDB table ${names.table} exists`);
  } catch (error: unknown) {
    if (!(error instanceof ResourceNotFoundException)) throw error;
    await db.send(
      new CreateTableCommand({
        TableName: names.table,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
        KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
      })
    );
    await waitUntilTableExists({ client: db, maxWaitTime: 120 }, { TableName: names.table });
    step(`DynamoDB table ${names.table} created`);
  }
}

async function token({ names }: Context): Promise<void> {
  const value = process.env.INSTAGRAM_ACCESS_TOKEN?.trim();
  if (!value) throw new Error("INSTAGRAM_ACCESS_TOKEN is empty in .env — nothing to copy to AWS");
  await new SSMClient({ region: names.region }).send(
    new PutParameterCommand({ Name: names.tokenParameter, Value: value, Type: "SecureString", Overwrite: true })
  );
  step(`Token stored encrypted in ${names.tokenParameter}`);
}

/** Creates the role if missing; returns true if it was just created (IAM then needs a moment). */
async function role(iam: IAMClient, name: string, service: string, account: string, policy: object): Promise<boolean> {
  let created = false;
  try {
    await iam.send(new GetRoleCommand({ RoleName: name }));
  } catch (error: unknown) {
    if (!(error instanceof NoSuchEntityException)) throw error;
    const trust = {
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Principal: { Service: service }, Action: "sts:AssumeRole", Condition: { StringEquals: { "aws:SourceAccount": account } } }],
    };
    await iam.send(new CreateRoleCommand({ RoleName: name, AssumeRolePolicyDocument: JSON.stringify(trust) }));
    created = true;
  }
  await iam.send(new PutRolePolicyCommand({ RoleName: name, PolicyName: "access", PolicyDocument: JSON.stringify(policy) }));
  step(`IAM role ${name} ${created ? "created" : "updated"}`);
  return created;
}

async function roles({ names, account, arns }: Context): Promise<boolean> {
  const iam = new IAMClient({ region: names.region });
  const publisher = await role(iam, names.publisherRole, "lambda.amazonaws.com", account, {
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: ["s3:GetObject", "s3:DeleteObject"], Resource: `arn:aws:s3:::${names.bucket}/reels/*` },
      { Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Scan"], Resource: arns.table },
      { Effect: "Allow", Action: "ssm:GetParameter", Resource: arns.parameter },
      { Effect: "Allow", Action: "scheduler:CreateSchedule", Resource: arns.schedules },
      { Effect: "Allow", Action: "iam:PassRole", Resource: arns.schedulerRole },
    ],
  });
  await iam.send(
    new AttachRolePolicyCommand({ RoleName: names.publisherRole, PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" })
  );
  const scheduler = await role(iam, names.schedulerRole, "scheduler.amazonaws.com", account, {
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Action: "lambda:InvokeFunction", Resource: [arns.functionArn, `${arns.functionArn}:*`] }],
  });
  return publisher || scheduler;
}

/** The Lambda's code: server/cloud/lambda.ts and what it imports, as one file. */
async function bundle(): Promise<Uint8Array> {
  const dir = mkdtempSync(path.join(tmpdir(), "quran-tamil-lambda-"));
  try {
    await build({
      entryPoints: [path.join(ROOT, "server/cloud/lambda.ts")],
      outfile: path.join(dir, "index.js"),
      bundle: true,
      platform: "node",
      target: "node22",
      format: "cjs",
      external: ["@aws-sdk/*"],
      logLevel: "warning",
    });
    execFileSync("zip", ["-q", "-j", path.join(dir, "code.zip"), path.join(dir, "index.js")]);
    return readFileSync(path.join(dir, "code.zip"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function environment({ names, arns }: Context): Record<string, string> {
  const optional = (key: string) => (process.env[key]?.trim() ? { [key]: process.env[key]!.trim() } : {});
  return {
    AWS_POSTING_REGION: names.region,
    AWS_POSTING_BUCKET: names.bucket,
    AWS_POSTING_TABLE: names.table,
    AWS_POSTING_SCHEDULE_GROUP: names.scheduleGroup,
    AWS_POSTING_TOKEN_PARAMETER: names.tokenParameter,
    SCHEDULER_ROLE_ARN: arns.schedulerRole,
    ...optional("INSTAGRAM_USER_ID"),
    ...optional("INSTAGRAM_GRAPH_VERSION"),
    ...optional("INSTAGRAM_LOGIN"),
  };
}

async function lambda(ctx: Context, freshRoles: boolean): Promise<void> {
  const { names, arns } = ctx;
  const client = new LambdaClient({ region: names.region });
  const ZipFile = await bundle();
  step(`Lambda code bundled (${Math.round(ZipFile.byteLength / 1024)} KB)`);
  const settings = {
    FunctionName: names.functionName,
    Role: arns.publisherRole,
    Handler: "index.handler",
    Runtime: "nodejs22.x" as const,
    // Instagram can take several minutes to process a reel; the publisher waits up to ten.
    Timeout: 900,
    MemorySize: 512,
    Environment: { Variables: environment(ctx) },
  };

  let exists = true;
  try {
    await client.send(new GetFunctionCommand({ FunctionName: names.functionName }));
  } catch (error: unknown) {
    if (!(error instanceof LambdaNotFound)) throw error;
    exists = false;
  }

  if (exists) {
    await client.send(new UpdateFunctionCodeCommand({ FunctionName: names.functionName, ZipFile }));
    await waitUntilFunctionUpdatedV2({ client, maxWaitTime: 120 }, { FunctionName: names.functionName });
    await client.send(new UpdateFunctionConfigurationCommand(settings));
    await waitUntilFunctionUpdatedV2({ client, maxWaitTime: 120 }, { FunctionName: names.functionName });
    step(`Lambda ${names.functionName} updated`);
  } else {
    await createFunction(client, { ...settings, Code: { ZipFile }, Architectures: ["arm64"] }, freshRoles);
    await waitUntilFunctionActiveV2({ client, maxWaitTime: 120 }, { FunctionName: names.functionName });
    step(`Lambda ${names.functionName} created`);
  }

  // Never re-run a failed invocation on AWS's own initiative: retries are the
  // publisher's decision, made with knowledge of what reached Instagram.
  await client.send(
    new PutFunctionEventInvokeConfigCommand({ FunctionName: names.functionName, MaximumRetryAttempts: 0, MaximumEventAgeInSeconds: 3600 })
  );
  await logRetention(names);
}

/** A role made seconds ago is not yet assumable by Lambda; wait and try again. */
async function createFunction(client: LambdaClient, input: ConstructorParameters<typeof CreateFunctionCommand>[0], freshRoles: boolean): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await client.send(new CreateFunctionCommand(input));
      return;
    } catch (error: unknown) {
      const waiting = named(error, "InvalidParameterValueException") && /role|assume/i.test(String((error as Error).message));
      if (!waiting || attempt >= 10) throw error;
      if (attempt === 1 && freshRoles) step("  waiting for the new IAM roles to take effect…");
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function logRetention(names: CloudNames): Promise<void> {
  const logs = new CloudWatchLogsClient({ region: names.region });
  const logGroupName = `/aws/lambda/${names.functionName}`;
  await logs.send(new CreateLogGroupCommand({ logGroupName })).catch((error: unknown) => {
    if (!named(error, "ResourceAlreadyExistsException")) throw error;
  });
  await logs.send(new PutRetentionPolicyCommand({ logGroupName, retentionInDays: LOG_DAYS }));
  step(`  logs kept ${LOG_DAYS} days in ${logGroupName}`);
}

async function scheduleGroup({ names }: Context): Promise<void> {
  const scheduler = new SchedulerClient({ region: names.region });
  try {
    await scheduler.send(new GetScheduleGroupCommand({ Name: names.scheduleGroup }));
    step(`Schedule group ${names.scheduleGroup} exists`);
  } catch (error: unknown) {
    if (!(error instanceof GroupNotFound)) throw error;
    await scheduler.send(new CreateScheduleGroupCommand({ Name: names.scheduleGroup }));
    step(`Schedule group ${names.scheduleGroup} created`);
  }
}

function record({ names, arns }: Context): void {
  const setup = {
    names: { region: names.region, bucket: names.bucket, table: names.table, scheduleGroup: names.scheduleGroup },
    functionArn: arns.functionArn,
    schedulerRoleArn: arns.schedulerRole,
  };
  writeFileSync(CLOUD_FILE, `${JSON.stringify(setup, null, 2)}\n`);
  step(`Recorded in ${path.relative(ROOT, CLOUD_FILE)} — the dashboard now posts from AWS (restart it)`);
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "all";
  const ctx = await context();
  console.info(`AWS account ${ctx.account}, region ${ctx.names.region}\n`);
  if (mode === "token") return token(ctx);
  if (mode === "code") return lambda(ctx, false);
  if (mode !== "all") throw new Error(`Unknown mode "${mode}" — use all, code or token`);

  await bucket(ctx);
  await table(ctx);
  await token(ctx);
  const fresh = await roles(ctx);
  await lambda(ctx, fresh);
  await scheduleGroup(ctx);
  record(ctx);
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
