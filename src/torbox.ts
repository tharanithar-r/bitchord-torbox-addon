import type { Kind } from './db.js';

/**
 * A thin, honest client for the TorBox API.
 *
 * Three properties matter here and each is deliberate:
 *
 *  - **The envelope is checked.** TorBox answers `HTTP 200` with
 *    `{success: false, error, detail}` for plenty of failures, so trusting the
 *    status code alone would turn "no such torrent" into an empty success.
 *  - **The rate limits are respected.** 300 requests/minute per token, and
 *    `/torrents/createtorrent` is additionally capped at 60 **uncached** adds per
 *    hour. A per-minute budget is enforced here so a library crawl cannot eat the
 *    budget that a playback request needs.
 *  - **Errors carry what a caller can act on.** `code` names TorBox's own error,
 *    `status` is the HTTP status to mirror, and `retryAfterMs` carries a 429's
 *    back-pressure so a route can answer with `Retry-After` as BitChord expects.
 */

export const TORBOX_API = 'https://api.torbox.app/v1/api';

export class TorBoxError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 502,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'TorBoxError';
  }
}

export type TorBoxFile = {
  id: number;
  name?: string;
  short_name?: string;
  size?: number;
  mimetype?: string;
};

export type TorBoxItem = {
  id: number;
  name?: string;
  hash?: string;
  size?: number;
  created_at?: string;
  files?: TorBoxFile[];
};

export type CachedEntry = {
  name?: string;
  size?: number;
  hash?: string;
  files?: TorBoxFile[];
};

type Envelope<T> = { success?: boolean; error?: string | null; detail?: string; data?: T };

const API_PREFIX: Record<Kind, string> = {
  torrents: 'torrents',
  usenet: 'usenet',
  webdl: 'webdl',
};

/** The item-id parameter name differs per service; so does the create route. */
const ID_PARAM: Record<Kind, string> = { torrents: 'torrent_id', usenet: 'usenet_id', webdl: 'web_id' };

/**
 * A token bucket sized below TorBox's ceiling.
 *
 * 240/min rather than 300 leaves room for a playback request that arrives while a
 * crawl is running; a library walk is the only thing that ever saturates it.
 */
export class RateLimiter {
  private readonly windowMs = 60_000;
  private hits: number[] = [];

  constructor(private readonly perMinute = 240) {}

  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.hits = this.hits.filter((t) => now - t < this.windowMs);
      if (this.hits.length < this.perMinute) {
        this.hits.push(now);
        return;
      }
      const oldest = this.hits[0] ?? now;
      const wait = Math.max(25, this.windowMs - (now - oldest));
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

export type TorBoxClientOptions = {
  fetchImpl?: typeof fetch;
  limiter?: RateLimiter;
  baseUrl?: string;
  /** Injected sleep, so tests never wait. */
  sleep?: (ms: number) => Promise<void>;
};

export class TorBoxClient {
  private readonly limiter: RateLimiter;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly key: string,
    options: TorBoxClientOptions = {},
  ) {
    if (!key) throw new Error('TorBoxClient needs an API key');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.limiter = options.limiter ?? new RateLimiter();
    this.baseUrl = options.baseUrl ?? TORBOX_API;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Plan, limits and account state — used by the probe script and the admin page. */
  async me(): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>('user/me');
  }

  /**
   * One page of the account's downloads.
   *
   * `files=true` is what makes this useful: without it the response has names and
   * sizes but no file list, and the file ids are exactly what `requestdl` needs.
   */
  async list(
    kind: Kind,
    options: { offset?: number; limit?: number; id?: number; files?: boolean; bypassCache?: boolean } = {},
  ): Promise<TorBoxItem[]> {
    const data = await this.call<TorBoxItem[] | TorBoxItem | null>(`${API_PREFIX[kind]}/mylist`, {
      id: options.id,
      offset: options.offset ?? 0,
      limit: options.limit ?? 100,
      files: options.files === false ? 'false' : 'true',
      bypass_cache: options.bypassCache ? 'true' : undefined,
    });
    if (data == null) return [];
    return Array.isArray(data) ? data : [data];
  }

  /** One item, with its files — the second half of adding a release. */
  async item(kind: Kind, itemId: number): Promise<TorBoxItem | null> {
    const items = await this.list(kind, { id: itemId, files: true, bypassCache: true });
    return items.find((i) => Number(i.id) === itemId) ?? items[0] ?? null;
  }

  /**
   * Which of these infohashes are already on TorBox, and what is inside them.
   *
   * The single most valuable call in the design: it answers "can this play right
   * now" without adding anything to the account, and `listFiles` returns the file
   * names that the index is built from.
   */
  async checkCached(
    hashes: string[],
    options: { kind?: Kind; listFiles?: boolean } = {},
  ): Promise<Record<string, CachedEntry>> {
    const clean = hashes.map((h) => h.trim().toLowerCase()).filter((h) => h.length > 0);
    if (clean.length === 0) return {};
    const kind = options.kind ?? 'torrents';
    const data = await this.call<Record<string, CachedEntry> | CachedEntry[] | null>(
      `${API_PREFIX[kind]}/checkcached`,
      { hash: clean.join(','), format: 'object', list_files: options.listFiles ? 'true' : undefined },
    );
    if (data == null) return {};
    if (Array.isArray(data)) {
      const out: Record<string, CachedEntry> = {};
      for (const entry of data) {
        const hash = String((entry as CachedEntry).hash ?? '').toLowerCase();
        if (hash) out[hash] = entry;
      }
      return out;
    }
    return data;
  }

  /**
   * Add a magnet to the account.
   *
   * With `onlyIfCached` (the default) TorBox refuses a release it does not already
   * hold, which keeps the account clean and the 60/hour uncached budget untouched.
   * Only the opt-in uncached path passes `onlyIfCached: false`.
   */
  async addTorrent(
    magnet: string,
    options: { onlyIfCached?: boolean; name?: string } = {},
  ): Promise<{ torrentId: number; hash: string | null }> {
    const form = new FormData();
    form.set('magnet', magnet);
    form.set('add_only_if_cached', options.onlyIfCached === false ? 'false' : 'true');
    form.set('allow_zip', 'false');
    if (options.name) form.set('name', options.name);
    const data = await this.call<{ torrent_id?: number; hash?: string; auth_id?: string }>(
      'torrents/createtorrent',
      {},
      { method: 'POST', body: form },
    );
    const torrentId = Number(data?.torrent_id ?? 0);
    if (!torrentId) throw new TorBoxError('NO_TORRENT_ID', 'TorBox did not return a torrent id');
    return { torrentId, hash: data?.hash ? String(data.hash).toLowerCase() : null };
  }

  /**
   * A presigned, time-limited CDN link for one file.
   *
   * `redirect=false` keeps the answer as JSON so the URL can be handed to the
   * player; with `redirect=true` TorBox answers 302 and the fetch would follow it
   * into the audio file itself. The link is open for three hours to *start* a
   * transfer, which comfortably covers BitChord's five-minute stream cache.
   */
  async requestLink(kind: Kind, itemId: number, fileId: number): Promise<string> {
    const data = await this.call<string>(`${API_PREFIX[kind]}/requestdl`, {
      token: this.key,
      [ID_PARAM[kind]]: itemId,
      file_id: fileId,
      redirect: 'false',
    });
    if (typeof data !== 'string' || !/^https?:\/\//.test(data)) {
      throw new TorBoxError('NO_LINK', 'TorBox returned no usable download link');
    }
    return data;
  }

  /** Retry-After from a 429, whether it was seconds or an HTTP date. */
  private async call<T>(
    path: string,
    query: Record<string, string | number | undefined> = {},
    init: RequestInit = {},
    attempt = 0,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}/${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    await this.limiter.acquire();
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        headers: {
          authorization: `Bearer ${this.key}`,
          accept: 'application/json',
          ...(init.headers as Record<string, string> | undefined),
        },
        signal: init.signal ?? AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new TorBoxError('NETWORK', `TorBox unreachable: ${(error as Error).message}`, 502);
    }

    if (response.status === 429) {
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      if (attempt < 2) {
        await this.sleep(retryAfterMs);
        return this.call<T>(path, query, init, attempt + 1);
      }
      throw new TorBoxError('RATE_LIMITED', 'TorBox is rate limiting this token', 429, retryAfterMs);
    }

    let body: Envelope<T> | null = null;
    try {
      body = (await response.json()) as Envelope<T>;
    } catch {
      body = null;
    }

    if (!response.ok || body?.success === false) {
      const code = String(body?.error ?? `HTTP_${response.status}`);
      const detail = String(body?.detail ?? response.statusText ?? 'TorBox request failed');
      const status = response.status === 401 || response.status === 403 ? 502 : response.status >= 500 ? 502 : 404;
      throw new TorBoxError(code, detail, status);
    }
    return (body?.data ?? null) as T;
  }
}

function parseRetryAfter(header: string | null): number {
  if (!header) return 5_000;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(60_000, Math.max(1_000, seconds * 1000));
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.min(60_000, Math.max(1_000, date - Date.now()));
  return 5_000;
}
