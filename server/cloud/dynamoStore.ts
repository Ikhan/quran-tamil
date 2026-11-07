/**
 * The queue in DynamoDB — the same contract as `output/schedule.json`, so the
 * dashboard and the Lambda share one record of what is queued and what went out.
 *
 * One item per post, keyed by its id, plus one item for the settings. A few
 * hundred posts at most, so listing is a scan.
 *
 * `claim` is a conditional write: the post moves to "publishing" only if it is
 * still in the state the caller saw. Two invocations for the same post cannot
 * both win it, which is what keeps a verse from going out twice.
 */
import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
  type ScanCommandOutput,
} from "@aws-sdk/lib-dynamodb";
import { newEntry, type ClaimCondition, type NewPost, type PostPatch, type PostsStore } from "../posts/store.js";
import {
  DEFAULT_SETTINGS,
  postEntrySchema,
  scheduleSettingsSchema,
  type PostEntry,
  type ScheduleSettings,
} from "../posts/types.js";

const SETTINGS_ID = "#settings";

export interface Expression {
  UpdateExpression: string;
  ExpressionAttributeNames: Record<string, string>;
  ExpressionAttributeValues: Record<string, unknown>;
  ConditionExpression?: string;
}

/**
 * A patch as a DynamoDB update, always stamping `updated_at`, and guarded by
 * `when` if given. Pure, so it is tested without AWS.
 */
export function updateExpression(patch: PostPatch, updatedAt: string, when?: ClaimCondition): Expression {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets = Object.entries({ ...patch, updated_at: updatedAt })
    .filter(([, v]) => v !== undefined)
    .map(([key, value], i) => {
      names[`#f${i}`] = key;
      values[`:f${i}`] = value;
      return `#f${i} = :f${i}`;
    });

  const conditions = ["attribute_exists(id)"];
  if (when) {
    names["#status"] = "status";
    const options = when.status.map((s, i) => {
      values[`:s${i}`] = s;
      return `:s${i}`;
    });
    conditions.push(`#status IN (${options.join(", ")})`);
    if (when.scheduledAt !== undefined) {
      names["#at"] = "scheduled_at";
      values[":at"] = when.scheduledAt;
      conditions.push("#at = :at");
    }
    if (when.claimToken !== undefined) {
      names["#claim"] = "claim_token";
      values[":claim"] = when.claimToken;
      conditions.push("#claim = :claim");
    }
    if (when.updatedAt !== undefined) {
      names["#seen"] = "updated_at";
      values[":seen"] = when.updatedAt;
      conditions.push("#seen = :seen");
    }
  }
  return {
    UpdateExpression: `SET ${sets.join(", ")}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ConditionExpression: conditions.join(" AND "),
  };
}

export class DynamoPostsStore implements PostsStore {
  private readonly db: DynamoDBDocumentClient;

  constructor(
    private readonly table: string,
    region: string,
    client?: DynamoDBDocumentClient
  ) {
    this.db =
      client ??
      DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
        marshallOptions: { removeUndefinedValues: true },
      });
  }

  async settings(): Promise<ScheduleSettings> {
    const { Item } = await this.db.send(new GetCommand({ TableName: this.table, Key: { id: SETTINGS_ID } }));
    const parsed = scheduleSettingsSchema.safeParse(Item?.settings);
    return parsed.success ? parsed.data : DEFAULT_SETTINGS;
  }

  async saveSettings(settings: ScheduleSettings): Promise<ScheduleSettings> {
    await this.db.send(new PutCommand({ TableName: this.table, Item: { id: SETTINGS_ID, settings } }));
    return settings;
  }

  async list(): Promise<readonly PostEntry[]> {
    const items: Record<string, unknown>[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const page: ScanCommandOutput = await this.db.send(
        new ScanCommand({ TableName: this.table, ExclusiveStartKey: start, ConsistentRead: true })
      );
      items.push(...(page.Items ?? []));
      start = page.LastEvaluatedKey;
    } while (start);
    // A malformed item fails loudly, like a corrupt schedule.json: quietly
    // dropping it would forget a post that may already have gone out.
    return items.filter((item) => item.id !== SETTINGS_ID).map((item) => postEntrySchema.parse(item));
  }

  async get(id: string): Promise<PostEntry | null> {
    const { Item } = await this.db.send(
      new GetCommand({ TableName: this.table, Key: { id }, ConsistentRead: true })
    );
    return Item && id !== SETTINGS_ID ? postEntrySchema.parse(Item) : null;
  }

  async create(post: NewPost): Promise<PostEntry> {
    const entry = newEntry(post);
    await this.db.send(
      new PutCommand({ TableName: this.table, Item: entry, ConditionExpression: "attribute_not_exists(id)" })
    );
    return entry;
  }

  update(id: string, patch: PostPatch): Promise<PostEntry | null> {
    return this.write(id, updateExpression(patch, new Date().toISOString()));
  }

  claim(id: string, when: ClaimCondition, patch: PostPatch): Promise<PostEntry | null> {
    return this.write(id, updateExpression(patch, new Date().toISOString(), when));
  }

  private async write(id: string, expression: Expression): Promise<PostEntry | null> {
    try {
      const { Attributes } = await this.db.send(
        new UpdateCommand({ TableName: this.table, Key: { id }, ReturnValues: "ALL_NEW", ...expression })
      );
      return Attributes ? postEntrySchema.parse(Attributes) : null;
    } catch (error: unknown) {
      if (error instanceof ConditionalCheckFailedException) return null;
      throw error;
    }
  }
}
