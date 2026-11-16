import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { mediaSecretOrRandom } from './media.js';

/**
 * Everything the addon is configured with, read once at boot.
 *
 * Every knob is an environment variable so the container carries no secrets and
 * a change is a `docker compose up -d`, not a rebuild. `loadConfig` takes the
 * environment as an argument rather than reading `process.env` directly: tests
 * build a config from a literal map, and nothing has to mutate the process.
 */
export type Config = {
  port: number;
  bindHost: string;
  /** Hostnames BitChord reaches us at, exactly as pasted (no scheme, no port). */
  publicHosts: string[];
  /** Unguessable first path segment. The only thing between the URL and the audio. */
  pathSecret: string;
  /** Absent means index-only mode: the server boots, but cannot stream or sync. */
  torboxKey?: string;
  dbPath: string;
  logLevel: string;
  acquire: {
    enabled: boolean;
    /** Off by default: uncached adds are throttled to 60/h and can be dead on arrival. */
    allowUncached: boolean;
    maxAlbumsPerHour: number;
    minSeeders: number;
    maxAlbumGb: number;
  };
  probe: {
    batchSize: number;
    maxBytes: number;
    /** Look up a cover from a free catalogue when the file carries none. */
    artFinder: boolean;
  };
  /**
   * Serve audio through this server instead of handing over TorBox's presigned URL.
   * Off by default: direct is faster and costs no bandwidth here. Turned on when the
   * CDN URL is not directly playable (extensionless / header-gated).
   */
  media: {
    proxy: boolean;
    secret: string;
    ttlSeconds: number;
  };
  syncIntervalMinutes: number;
};

const Raw = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8099),
  BIND_HOST: z.string().default('127.0.0.1'),
  PUBLIC_HOSTS: z.string().min(1).default('localhost'),
  PATH_SECRET: z.string().min(16, 'PATH_SECRET must be at least 16 characters'),
  TORBOX_KEY: z
    .string()
    .transform((v) => v.trim())
    .refine((v) => v === '' || v.length >= 8, 'TORBOX_KEY is too short to be an API key')
    .optional(),
  DB_PATH: z.string().default('./data/index.db'),
  LOG_LEVEL: z.string().default('info'),
  ACQUIRE_ENABLED: z.string().default('1'),
  ACQUIRE_UNCACHED: z.string().default('0'),
  MAX_ALBUMS_PER_HOUR: z.coerce.number().int().min(0).default(6),
  MIN_SEEDERS: z.coerce.number().int().min(0).default(1),
  MAX_ALBUM_GB: z.coerce.number().min(0).default(8),
  MEDIA_PROXY: z.string().default('0'),
  MEDIA_SECRET: z.string().optional(),
  MEDIA_TTL_SECONDS: z.coerce.number().int().min(300).max(86_400).default(1800),
  ART_FINDER: z.string().default('1'),
  PROBE_BATCH: z.coerce.number().int().min(0).default(40),
  PROBE_MAX_BYTES: z.coerce.number().int().min(8192).default(524288),
  SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(0).default(360),
});

/**
 * `Example.COM:8443` and `https://x.example.com/path` are both what people paste,
 * and both mean the same hostname to the verifier, so normalise the same way it
 * does: lowercase, no scheme, no port, no path, no trailing dot.
 */
export function normalizeHost(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
}

export function parseHosts(raw: string): string[] {
  const hosts = raw
    .split(/[,\s]+/)
    .map(normalizeHost)
    .filter((h) => h.length > 0);
  return [...new Set(hosts)];
}

/**
 * Minimal `.env` reader.
 *
 * Node has `--env-file`, but it fails the process when the file is missing, and
 * a file-missing boot is a normal state here (the container is configured by
 * compose instead). Twelve lines beats a dependency, and existing environment
 * always wins over the file.
 */
export function loadDotEnv(path = '.env', target: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key in target && target[key] !== '') continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    target[key] = value;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Raw.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`);
    throw new Error(`Invalid configuration:\n  ${problems.join('\n  ')}\nSee .env.example.`);
  }
  const v = parsed.data;
  return {
    port: v.PORT,
    bindHost: v.BIND_HOST,
    publicHosts: parseHosts(v.PUBLIC_HOSTS),
    pathSecret: v.PATH_SECRET,
    torboxKey: v.TORBOX_KEY && v.TORBOX_KEY.length > 0 ? v.TORBOX_KEY : undefined,
    dbPath: v.DB_PATH,
    logLevel: v.LOG_LEVEL,
    acquire: {
      enabled: v.ACQUIRE_ENABLED === '1' || v.ACQUIRE_ENABLED.toLowerCase() === 'true',
      allowUncached: v.ACQUIRE_UNCACHED === '1' || v.ACQUIRE_UNCACHED.toLowerCase() === 'true',
      maxAlbumsPerHour: v.MAX_ALBUMS_PER_HOUR,
      minSeeders: v.MIN_SEEDERS,
      maxAlbumGb: v.MAX_ALBUM_GB,
    },
    probe: {
      batchSize: v.PROBE_BATCH,
      maxBytes: v.PROBE_MAX_BYTES,
      artFinder: v.ART_FINDER === '1' || v.ART_FINDER.toLowerCase() === 'true',
    },
    media: {
      proxy: v.MEDIA_PROXY === '1' || v.MEDIA_PROXY.toLowerCase() === 'true',
      secret: mediaSecretOrRandom(v.MEDIA_SECRET),
      ttlSeconds: v.MEDIA_TTL_SECONDS,
    },
    syncIntervalMinutes: v.SYNC_INTERVAL_MINUTES,
  };
}
