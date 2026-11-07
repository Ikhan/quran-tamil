/**
 * One EventBridge Scheduler alarm per queued post, firing the publisher once
 * at the post's time and then deleting itself.
 *
 * The alarm carries the time it was set for. If the post has been moved since,
 * the publisher sees the mismatch and leaves it to the newer alarm — so an
 * alarm that failed to be deleted can never post at the old time.
 *
 * Each alarm is named for its post and time, so setting a new one never
 * touches an old one; `disarm` removes all of a post's alarms.
 */
import {
  ConflictException,
  CreateScheduleCommand,
  DeleteScheduleCommand,
  ListSchedulesCommand,
  ResourceNotFoundException,
  SchedulerClient,
  type CreateScheduleCommandInput,
} from "@aws-sdk/client-scheduler";
import { scheduleName, schedulePrefix, type PublishEvent } from "./names.js";

export interface Alarms {
  /** Add an alarm for the post at `at`. Setting the same one twice is harmless. */
  arm(postId: string, at: string): Promise<void>;
  /** Remove every alarm the post has; fine if there are none. */
  disarm(postId: string): Promise<void>;
}

export interface AlarmTarget {
  group: string;
  functionArn: string;
  roleArn: string;
}

/** "2026-11-06T13:30:00.000Z" → "at(2026-11-06T13:30:00)", read as UTC. */
export const atExpression = (iso: string): string =>
  `at(${new Date(iso).toISOString().slice(0, 19)})`;

export function scheduleInput(postId: string, at: string, target: AlarmTarget): CreateScheduleCommandInput {
  const event: PublishEvent = { postId, at };
  return {
    Name: scheduleName(postId, at),
    GroupName: target.group,
    ScheduleExpression: atExpression(at),
    ScheduleExpressionTimezone: "UTC",
    FlexibleTimeWindow: { Mode: "OFF" },
    ActionAfterCompletion: "DELETE",
    Target: {
      Arn: target.functionArn,
      RoleArn: target.roleArn,
      Input: JSON.stringify(event),
      // A retried delivery is harmless: the publisher claims the post first.
      RetryPolicy: { MaximumRetryAttempts: 3, MaximumEventAgeInSeconds: 3600 },
    },
  };
}

export class SchedulerAlarms implements Alarms {
  private readonly client: SchedulerClient;

  constructor(
    private readonly target: AlarmTarget,
    region: string,
    client?: SchedulerClient
  ) {
    this.client = client ?? new SchedulerClient({ region });
  }

  async arm(postId: string, at: string): Promise<void> {
    try {
      await this.client.send(new CreateScheduleCommand(scheduleInput(postId, at, this.target)));
    } catch (error: unknown) {
      // Same name means same post and same time: that alarm is already set.
      if (!(error instanceof ConflictException)) throw error;
    }
  }

  async disarm(postId: string): Promise<void> {
    const names: string[] = [];
    let NextToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListSchedulesCommand({ GroupName: this.target.group, NamePrefix: schedulePrefix(postId), NextToken })
      );
      names.push(...(page.Schedules ?? []).map((s) => s.Name!).filter(Boolean));
      NextToken = page.NextToken;
    } while (NextToken);
    for (const Name of names) {
      try {
        await this.client.send(new DeleteScheduleCommand({ Name, GroupName: this.target.group }));
      } catch (error: unknown) {
        if (!(error instanceof ResourceNotFoundException)) throw error;
      }
    }
  }
}
