/**
 * A post's reel and cover in S3: copied up at schedule time, handed to
 * Instagram as short-lived signed links, deleted once the post is done.
 *
 * The bucket is private. A signed link lets whoever holds it read that one
 * object for an hour, which is how Instagram fetches it — nothing is public.
 */
import { readFile } from "node:fs/promises";
import { DeleteObjectsCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface PostFiles {
  upload(key: string, absolutePath: string, contentType: string): Promise<void>;
  link(key: string): Promise<string>;
  remove(keys: readonly string[]): Promise<void>;
}

const LINK_SECONDS = 3600;

export class S3PostFiles implements PostFiles {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    region: string,
    client?: S3Client
  ) {
    this.client = client ?? new S3Client({ region });
  }

  async upload(key: string, absolutePath: string, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: await readFile(absolutePath),
        ContentType: contentType,
      })
    );
  }

  link(key: string): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: LINK_SECONDS,
    });
  }

  async remove(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.client.send(
      new DeleteObjectsCommand({
        Bucket: this.bucket,
        Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
      })
    );
  }
}
