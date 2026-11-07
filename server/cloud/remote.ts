/**
 * The dashboard's side of the cloud publisher: copy a post's files up, set or
 * move its alarm, and hand "Post now" to the Lambda. Publishing itself never
 * happens on the Mac in this mode, so a closed lid stops nothing.
 */
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { ReelFile } from "../posts/reelFiles.js";
import { coverPath } from "../posts/reelFiles.js";
import { SchedulerAlarms } from "./alarms.js";
import { S3PostFiles } from "./files.js";
import { objectKeys, type CloudNames, type PublishEvent } from "./names.js";

export interface RemotePublishing {
  /** Copies the reel (and cover, if any) to S3 for this post. */
  upload(postId: string, reel: ReelFile): Promise<{ reel_key: string; cover_key: string | null }>;
  arm(postId: string, at: string): Promise<void>;
  disarm(postId: string): Promise<void>;
  discard(keys: readonly string[]): Promise<void>;
  /** Starts the publisher and returns at once; the post's status shows the rest. */
  invoke(event: PublishEvent): Promise<void>;
}

export interface AwsRemoteOptions {
  names: CloudNames;
  functionArn: string;
  schedulerRoleArn: string;
}

export class AwsRemote implements RemotePublishing {
  private readonly files: S3PostFiles;
  private readonly alarms: SchedulerAlarms;
  private readonly lambda: LambdaClient;

  constructor(private readonly options: AwsRemoteOptions) {
    const { names } = options;
    this.files = new S3PostFiles(names.bucket, names.region);
    this.alarms = new SchedulerAlarms(
      { group: names.scheduleGroup, functionArn: options.functionArn, roleArn: options.schedulerRoleArn },
      names.region
    );
    this.lambda = new LambdaClient({ region: names.region });
  }

  async upload(postId: string, reel: ReelFile): Promise<{ reel_key: string; cover_key: string | null }> {
    const keys = objectKeys(postId);
    const cover = coverPath(reel.cover);
    await Promise.all([
      this.files.upload(keys.reel, reel.absolute, "video/mp4"),
      cover ? this.files.upload(keys.cover, cover, "image/png") : Promise.resolve(),
    ]);
    return { reel_key: keys.reel, cover_key: cover ? keys.cover : null };
  }

  arm(postId: string, at: string): Promise<void> {
    return this.alarms.arm(postId, at);
  }

  disarm(postId: string): Promise<void> {
    return this.alarms.disarm(postId);
  }

  discard(keys: readonly string[]): Promise<void> {
    return this.files.remove(keys);
  }

  async invoke(event: PublishEvent): Promise<void> {
    const { StatusCode } = await this.lambda.send(
      new InvokeCommand({
        FunctionName: this.options.functionArn,
        InvocationType: "Event",
        Payload: new TextEncoder().encode(JSON.stringify(event)),
      })
    );
    if (StatusCode !== 202) throw new Error(`The publisher did not accept the request (HTTP ${StatusCode})`);
  }
}
