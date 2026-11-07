import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { z } from 'zod';

const REFRESH_EVERY_MS = 7 * 86_400_000;

const fileSchema = z.object({
  access_token: z.string().min(1),
  /** Hash of the .env token this was derived from — a newly pasted token wins. */
  env_hash: z.string(),
  refreshed_at: z.string(),
  expires_at: z.string().nullable(),
});
type TokenFile = z.infer<typeof fileSchema>;

export type RefreshFn = (token: string) => Promise<{ token: string; expiresInSec: number }>;

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/**
 * Long-lived Instagram tokens expire after 60 days unless refreshed. The first
 * token comes from .env; refreshed ones go to a private (0600) file under data/.
 */
export class TokenStore {
  private state: TokenFile | null = null;

  constructor(
    private readonly file: string,
    private readonly envToken: string,
    private readonly refresh: RefreshFn,
  ) {}

  private async load(now = new Date()): Promise<TokenFile> {
    if (this.state) return this.state;
    try {
      const saved = fileSchema.parse(JSON.parse(await readFile(this.file, 'utf8')));
      if (saved.env_hash === hash(this.envToken)) return (this.state = saved);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError) && !(error instanceof z.ZodError)) throw error;
    }
    const fresh: TokenFile = { access_token: this.envToken, env_hash: hash(this.envToken), refreshed_at: now.toISOString(), expires_at: null };
    await this.save(fresh);
    return fresh;
  }

  private async save(next: TokenFile): Promise<void> {
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, this.file);
    this.state = next;
  }

  async get(): Promise<string> {
    return (await this.load()).access_token;
  }

  /** Refresh once a week. Throws if Instagram refuses — the current token keeps working until it expires. */
  async refreshIfDue(now = new Date()): Promise<void> {
    const state = await this.load(now);
    if (now.getTime() - Date.parse(state.refreshed_at) < REFRESH_EVERY_MS) return;
    const r = await this.refresh(state.access_token);
    await this.save({
      ...state,
      access_token: r.token,
      refreshed_at: now.toISOString(),
      expires_at: new Date(now.getTime() + r.expiresInSec * 1000).toISOString(),
    });
  }
}
