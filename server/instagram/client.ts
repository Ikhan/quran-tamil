import { readFile } from 'node:fs/promises';

/**
 * Minimal Instagram Graph API client — just what reel publishing needs.
 * https://developers.facebook.com/docs/instagram-platform/content-publishing
 *
 * Two kinds of token work:
 * - "instagram" (IGAA…, Instagram Login): graph.instagram.com; the video must be at a public URL.
 * - "facebook"  (EAA…, Facebook Login / Business system user): graph.facebook.com; the video
 *   file is uploaded straight from this Mac (resumable upload), no public URL needed.
 */
export type LoginKind = 'instagram' | 'facebook';

const HOSTS: Record<LoginKind, string> = {
  instagram: 'https://graph.instagram.com',
  facebook: 'https://graph.facebook.com',
};
const UPLOAD_HOST = 'https://rupload.facebook.com/ig-api-upload';
export const DEFAULT_GRAPH_VERSION = 'v24.0';

/** EAA… tokens come from Facebook Login; IG… tokens from Instagram Login. */
export const loginKindOf = (token: string): LoginKind => (token.startsWith('EAA') ? 'facebook' : 'instagram');

/**
 * Which kind of token this is, asked of Instagram rather than read off the prefix.
 *
 * The prefix used to be enough, but Meta's "Instagram API (Unified Login)"
 * now issues Instagram Login tokens that start with EAA too, and sending one
 * to graph.facebook.com fails with "Object … does not exist". If Instagram's
 * own endpoint accepts the token, it is an Instagram Login token. The prefix is
 * only the fallback for when Instagram cannot be reached at all.
 */
export async function detectLoginKind(token: string, version = DEFAULT_GRAPH_VERSION, fetchImpl: typeof fetch = fetch): Promise<LoginKind> {
  const query = new URLSearchParams({ fields: 'user_id,username', access_token: token });
  try {
    const res = await fetchImpl(`${HOSTS.instagram}/${version}/me?${query}`);
    const body = (await res.json().catch(() => ({}))) as { user_id?: unknown };
    return res.ok && body.user_id ? 'instagram' : 'facebook';
  } catch {
    return loginKindOf(token);
  }
}

/**
 * The reel's cover: a separate still Instagram fetches from a public URL.
 * Without one, Instagram picks a frame itself.
 */
const coverParam = (url: string | undefined): Record<string, string> => (url ? { cover_url: url } : {});

export class InstagramApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | null,
  ) {
    super(message);
    this.name = 'InstagramApiError';
  }
}

export interface InstagramClientOptions {
  /** Current access token (it is refreshed and stored elsewhere). */
  token: () => Promise<string>;
  login?: LoginKind;
  /** Instagram professional account id. Needed for Facebook system-user tokens, which have no /me Instagram link. */
  igUserId?: string | null;
  version?: string;
  fetch?: typeof fetch;
}

export type ContainerCode = 'EXPIRED' | 'ERROR' | 'FINISHED' | 'IN_PROGRESS' | 'PUBLISHED';

interface PageAccounts {
  data: Array<{ instagram_business_account?: { id: string; username?: string } }>;
}

export class InstagramClient {
  readonly login: LoginKind;
  private readonly version: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: InstagramClientOptions) {
    this.login = options.login ?? 'instagram';
    this.version = options.version ?? DEFAULT_GRAPH_VERSION;
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** True when the video can be uploaded from disk (no public URL needed). */
  get uploadsDirectly(): boolean {
    return this.login === 'facebook';
  }

  async me(): Promise<{ userId: string; username: string }> {
    if (this.login === 'instagram') {
      const r = await this.get<{ user_id: string; username: string }>('me', { fields: 'user_id,username' });
      return { userId: String(r.user_id), username: r.username };
    }
    let igId = this.options.igUserId ?? null;
    if (!igId) {
      const pages = await this.get<PageAccounts>('me/accounts', { fields: 'instagram_business_account{id,username}' });
      igId = pages.data.find((p) => p.instagram_business_account)?.instagram_business_account?.id ?? null;
    }
    if (!igId) {
      throw new InstagramApiError(
        'This token can’t see any Instagram account. In Business settings, give the system user access to the Instagram account (or set INSTAGRAM_USER_ID in .env).',
        400,
        null,
      );
    }
    const r = await this.get<{ id: string; username: string }>(igId, { fields: 'id,username' });
    return { userId: String(r.id), username: r.username };
  }

  /** Instagram Login: Instagram fetches the video from a public URL. */
  async createReel(igId: string, input: { videoUrl: string; caption: string; coverUrl?: string }): Promise<string> {
    const r = await this.post<{ id: string }>(`${igId}/media`, {
      media_type: 'REELS',
      video_url: input.videoUrl,
      caption: input.caption,
      share_to_feed: 'true',
      ...coverParam(input.coverUrl),
    });
    return r.id;
  }

  /** Facebook Login: create an empty reel container, then `uploadVideo` the file into it. */
  async createReelUpload(igId: string, input: { caption: string; coverUrl?: string }): Promise<string> {
    const r = await this.post<{ id: string }>(`${igId}/media`, {
      media_type: 'REELS',
      upload_type: 'resumable',
      caption: input.caption,
      share_to_feed: 'true',
      ...coverParam(input.coverUrl),
    });
    return r.id;
  }

  async uploadVideo(containerId: string, path: string): Promise<void> {
    const token = await this.options.token();
    const bytes = await readFile(path);
    let res: Response;
    try {
      res = await this.fetchImpl(`${UPLOAD_HOST}/${this.version}/${containerId}`, {
        method: 'POST',
        headers: { Authorization: `OAuth ${token}`, offset: '0', file_size: String(bytes.byteLength) },
        body: bytes,
      });
    } catch (error: unknown) {
      throw new InstagramApiError(`Could not upload the video: ${error instanceof Error ? error.message : 'network error'}`, 0, null);
    }
    const body = (await res.json().catch(() => ({}))) as { success?: boolean; debug_info?: { message?: string } };
    if (!res.ok || body.success !== true) {
      const message = (body.debug_info?.message ?? `Video upload failed (HTTP ${res.status})`).split(token).join('[token]');
      throw new InstagramApiError(message, res.status, null);
    }
  }

  async containerStatus(containerId: string): Promise<{ code: ContainerCode; detail: string | null }> {
    const r = await this.get<{ status_code: ContainerCode; status?: string }>(containerId, { fields: 'status_code,status' });
    return { code: r.status_code, detail: r.status ?? null };
  }

  async publish(igId: string, containerId: string): Promise<string> {
    return (await this.post<{ id: string }>(`${igId}/media_publish`, { creation_id: containerId })).id;
  }

  async permalink(mediaId: string): Promise<string | null> {
    return (await this.get<{ permalink?: string }>(mediaId, { fields: 'permalink' })).permalink ?? null;
  }

  async publishingLimit(igId: string): Promise<{ used: number; total: number }> {
    const r = await this.get<{ data: Array<{ quota_usage: number; config?: { quota_total?: number } }> }>(
      `${igId}/content_publishing_limit`,
      { fields: 'quota_usage,config' },
    );
    const row = r.data[0];
    return { used: row?.quota_usage ?? 0, total: row?.config?.quota_total ?? 100 };
  }

  /** Instagram Login tokens last 60 days; refreshing returns a new 60-day token. */
  async refreshToken(token: string): Promise<{ token: string; expiresInSec: number }> {
    const r = await this.request<{ access_token: string; expires_in: number }>(
      'GET',
      `${HOSTS.instagram}/refresh_access_token`,
      { grant_type: 'ig_refresh_token', access_token: token },
      token,
    );
    return { token: r.access_token, expiresInSec: r.expires_in };
  }

  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    const token = await this.options.token();
    return this.request<T>('GET', `${HOSTS[this.login]}/${this.version}/${path}`, { ...params, access_token: token }, token);
  }

  private async post<T>(path: string, params: Record<string, string>): Promise<T> {
    const token = await this.options.token();
    return this.request<T>('POST', `${HOSTS[this.login]}/${this.version}/${path}`, { ...params, access_token: token }, token);
  }

  private async request<T>(method: 'GET' | 'POST', base: string, params: Record<string, string>, token: string): Promise<T> {
    const query = new URLSearchParams(params);
    const url = method === 'GET' ? `${base}?${query}` : base;
    let res: Response;
    try {
      res = await this.fetchImpl(url, method === 'POST' ? { method, body: query } : { method });
    } catch (error: unknown) {
      throw new InstagramApiError(`Could not reach Instagram: ${error instanceof Error ? error.message : 'network error'}`, 0, null);
    }
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: number } } & T;
    if (!res.ok || body.error) {
      const message = (body.error?.message ?? `Instagram API error (HTTP ${res.status})`).split(token).join('[token]');
      throw new InstagramApiError(message, res.status, body.error?.code ?? null);
    }
    return body;
  }
}
