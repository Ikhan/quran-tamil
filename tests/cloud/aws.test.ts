import { describe, expect, it, vi } from "vitest";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { ConflictException, ResourceNotFoundException, type SchedulerClient } from "@aws-sdk/client-scheduler";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { atExpression, scheduleInput, SchedulerAlarms } from "../../server/cloud/alarms.js";
import { DynamoPostsStore, updateExpression } from "../../server/cloud/dynamoStore.js";
import { cloudNames, objectKeys, scheduleName, schedulePrefix } from "../../server/cloud/names.js";

const TARGET = { group: "quran-tamil", functionArn: "arn:aws:lambda:ap-south-1:1:function:f", roleArn: "arn:aws:iam::1:role/r" };

describe("names", () => {
  it("defaults to Mumbai and the account's bucket", () => {
    const names = cloudNames({}, "387003110554");
    expect(names).toMatchObject({ region: "ap-south-1", bucket: "quran-tamil-posts-387003110554", table: "quran-tamil-posts" });
  });

  it("names each alarm for its post and time, within AWS's 64 characters", () => {
    const a = scheduleName("112-1-abc", "2026-11-06T13:30:00.000Z");
    const b = scheduleName("112-1-abc", "2026-11-06T13:45:00.000Z");
    expect(a).not.toBe(b);
    expect(a.startsWith(schedulePrefix("112-1-abc"))).toBe(true);
    expect(a).toMatch(/^[0-9a-zA-Z_.-]+$/);
    // One post's prefix is not another's.
    expect(scheduleName("112-1", "2026-11-06T13:30:00.000Z").startsWith(schedulePrefix("112-1-abc"))).toBe(false);
    expect(schedulePrefix("112-1-abc").startsWith(schedulePrefix("112-1"))).toBe(false);
    expect(scheduleName("x".repeat(100), "2026-11-06T13:30:00.000Z").length).toBeLessThanOrEqual(64);
    expect(objectKeys("112-1-abc")).toEqual({ reel: "reels/112-1-abc/reel.mp4", cover: "reels/112-1-abc/cover.png" });
  });
});

describe("alarms", () => {
  it("fires once, at the post's UTC time, then deletes itself", () => {
    expect(atExpression("2026-11-06T13:30:00.000Z")).toBe("at(2026-11-06T13:30:00)");
    const input = scheduleInput("112-1-abc", "2026-11-06T13:30:00.000Z", TARGET);
    expect(input).toMatchObject({
      Name: scheduleName("112-1-abc", "2026-11-06T13:30:00.000Z"),
      GroupName: "quran-tamil",
      ScheduleExpressionTimezone: "UTC",
      ActionAfterCompletion: "DELETE",
      FlexibleTimeWindow: { Mode: "OFF" },
    });
    expect(JSON.parse(input.Target!.Input!)).toEqual({ postId: "112-1-abc", at: "2026-11-06T13:30:00.000Z" });
  });

  it("setting the same alarm twice is harmless", async () => {
    const send = vi.fn().mockRejectedValueOnce(new ConflictException({ message: "exists", $metadata: {} }));
    const alarms = new SchedulerAlarms(TARGET, "ap-south-1", { send } as unknown as SchedulerClient);
    await alarms.arm("112-1-abc", "2026-11-06T13:30:00.000Z");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("disarm removes every alarm of the post, across pages", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Schedules: [{ Name: "post-112-1-abc--a" }], NextToken: "n" })
      .mockResolvedValueOnce({ Schedules: [{ Name: "post-112-1-abc--b" }] })
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new ResourceNotFoundException({ message: "gone", $metadata: {} }));
    await new SchedulerAlarms(TARGET, "ap-south-1", { send } as unknown as SchedulerClient).disarm("112-1-abc");
    const calls = send.mock.calls.map(([c]) => [c.constructor.name, c.input.Name ?? c.input.NamePrefix]);
    expect(calls).toEqual([
      ["ListSchedulesCommand", "post-112-1-abc--"],
      ["ListSchedulesCommand", "post-112-1-abc--"],
      ["DeleteScheduleCommand", "post-112-1-abc--a"],
      ["DeleteScheduleCommand", "post-112-1-abc--b"],
    ]);
  });

  it("an error other than not-found stops a disarm", async () => {
    const denied = vi.fn().mockRejectedValue(new Error("AccessDenied"));
    // (ListSchedules itself refused.)
    await expect(new SchedulerAlarms(TARGET, "ap-south-1", { send: denied } as unknown as SchedulerClient).disarm("x")).rejects.toThrow("AccessDenied");
  });
});

describe("DynamoDB queue", () => {
  it("writes a patch as SET, stamping updated_at and skipping undefined", () => {
    const e = updateExpression({ status: "posted", error: null, media_id: undefined }, "T");
    expect(e.UpdateExpression).toBe("SET #f0 = :f0, #f1 = :f1, #f2 = :f2");
    expect(e.ExpressionAttributeNames).toEqual({ "#f0": "status", "#f1": "error", "#f2": "updated_at" });
    expect(e.ExpressionAttributeValues).toEqual({ ":f0": "posted", ":f1": null, ":f2": "T" });
    expect(e.ConditionExpression).toBe("attribute_exists(id)");
  });

  it("guards a claim on status, time, token and last update", () => {
    const e = updateExpression({ status: "publishing" }, "T", {
      status: ["scheduled", "failed"],
      scheduledAt: "A",
      claimToken: "C",
      updatedAt: "U",
    });
    expect(e.ConditionExpression).toBe(
      "attribute_exists(id) AND #status IN (:s0, :s1) AND #at = :at AND #claim = :claim AND #seen = :seen"
    );
    expect(e.ExpressionAttributeValues).toMatchObject({ ":s0": "scheduled", ":s1": "failed", ":at": "A", ":claim": "C", ":seen": "U" });
  });

  it("a lost claim comes back null rather than throwing", async () => {
    const send = vi.fn().mockRejectedValue(new ConditionalCheckFailedException({ message: "no", $metadata: {} }));
    const store = new DynamoPostsStore("t", "ap-south-1", { send } as unknown as DynamoDBDocumentClient);
    expect(await store.claim("p", { status: ["scheduled"] }, { status: "publishing" })).toBeNull();
  });

  it("lists every page, leaving out the settings item", async () => {
    const post = {
      id: "112-1-abc", reel_file: "r", cover_file: null, reference: "112:1", caption: "c",
      scheduled_at: "A", status: "scheduled", attempts: 0, container_id: null, media_id: null,
      permalink: null, error: null, posted_at: null, created_at: "C", updated_at: "U",
    };
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Items: [{ id: "#settings", settings: {} }], LastEvaluatedKey: { id: "#settings" } })
      .mockResolvedValueOnce({ Items: [post] });
    const store = new DynamoPostsStore("t", "ap-south-1", { send } as unknown as DynamoDBDocumentClient);
    expect(await store.list()).toEqual([post]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("a malformed item stops the listing rather than vanishing", async () => {
    const send = vi.fn().mockResolvedValue({ Items: [{ id: "x", status: "weird" }] });
    const store = new DynamoPostsStore("t", "ap-south-1", { send } as unknown as DynamoDBDocumentClient);
    await expect(store.list()).rejects.toThrow();
  });
});
