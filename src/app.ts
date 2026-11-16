import { Readable } from 'node:stream';
import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyServerOptions,
} from 'fastify';
import type { Logger } from 'pino';
import type { Acquisition } from './acquire/queue.js';
import type { AuthObserver } from './auth/bitchord.js';
import type { Config } from './config.js';
import type { Store } from './db.js';
import { CORS_HEADERS, htmlBody, jsonBody } from './http.js';
import { artKeyFor } from './art.js';
import { contentTypeFor, mediaUrl, verifyMedia } from './media.js';
import { redactUrl } from './log.js';
import { normalizeQuery, tokenize } from './parse.js';
import type { Prober } from './probe/worker.js';
import { adminPage, healthBody } from './routes/admin.js';
import { ADDON_VERSION, buildManifest } from './routes/manifest.js';
import { hasUsableQuery, normalizeTier, rankRows, toAddonTrack } from './routes/search.js';
import { linkFor, qualityLabel, resolveStream, type LinkCache } from './routes/stream.js';
import type { Sync } from './sync.js';
import type { TorBoxClient } from './torbox.js';

/**
 * The HTTP surface, assembled from parts so tests can stand in for TorBox.
 *
 * Route layout follows the protocol's one hard structural rule: the addon base is
 * whatever the listener pasted, and BitChord appends `/manifest.json`, `/search`
 * and `/stream/{id}` to it. An unguessable path segment therefore sits in front of
 * everything, and the manifest is the only route that never needs credentials.
 */
export type AppDeps = {
  cfg: Config;
  store: Store;
  log: Logger;
  auth: AuthObserver;
  torbox?: TorBoxClient;
  prober?: Prober;
  acquisition?: Acquisition;
  sync?: Sync;
  /** Injected so the media route can be tested without a network. */
  fetchImpl?: typeof fetch;
};

/** The miss wording `resolveStream` uses, so the retry hint can be attached to it. */
const NOT_HELD = 'Not held by this addon';
const RETRY_AFTER_SECONDS = 30;

export function createApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    // Pino's Logger is richer than Fastify's own interface; the cast keeps the
    // factory's inferred instance type equal to the one this function declares.
    loggerInstance: deps.log as unknown as FastifyBaseLogger,
    // Fastify's own incoming/completed lines are off: one line per request is
    // emitted by the verifier hook below, with the auth outcome included.
    logController: new LogController({
      disableRequestLogging: true,
    }) as unknown as NonNullable<FastifyServerOptions['logController']>,
    trustProxy: true,
  });
  const cache: LinkCache = new Map();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const manifest = buildManifest(deps.cfg);
  const base = `/${deps.cfg.pathSecret}`;

  /**
   * One hook for both cross-cutting concerns.
   *
   * Auth is **observed, never enforced** — see `auth/bitchord.ts` for why the web
   * and desktop apps must keep working. Preflight is answered before anything else
   * so a browser never has to satisfy the verifier.
   */
  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'OPTIONS') return reply.code(204).headers(CORS_HEADERS).send();
    const observation = await deps.auth.observe({ headers: request.headers as Record<string, unknown> });
    deps.log.info(
      {
        method: request.method,
        url: redactUrl(request.url, deps.cfg.pathSecret),
        auth: observation.code,
        sub: observation.sub,
        ver: observation.ver,
      },
      'request',
    );
    return;
  });

  /**
   * Status and latency for every answer.
   *
   * Without this the logs say a request arrived but not what came of it, which is
   * useless for "the app spins forever" — the interesting question is always
   * "200 in 12 ms" or "502 in 15 s".
   */
  app.addHook('onResponse', async (request, reply) => {
    deps.log.info(
      {
        method: request.method,
        url: redactUrl(request.url, deps.cfg.pathSecret),
        status: reply.statusCode,
        ms: Math.round(reply.elapsedTime),
      },
      'response',
    );
  });

  const send = (reply: FastifyReply, payload: { status: number; headers: Record<string, string>; body: string }) =>
    reply.code(payload.status).headers(payload.headers).send(payload.body);

  // ── Root: a human landing page, and the manifest ─────────────────────────
  app.get('/', async (_request, reply) =>
    reply.code(200).headers({ ...CORS_HEADERS, 'cache-control': 'no-store' }).send(
      jsonBody({
        name: 'TorBox Lossless — BitChord addon',
        addonUrl: `https://${deps.cfg.publicHosts[0] ?? 'localhost'}${base}`,
        hint: 'Paste that URL into BitChord → Settings → Sources → Add an addon.',
      }).body,
    ),
  );

  app.get(`${base}/manifest.json`, async (_request, reply) =>
    send(reply, jsonBody(manifest)),
  );

  // ── Search ──────────────────────────────────────────────────────────────
  app.get<{ Querystring: { q?: string; quality?: string; atmos?: string } }>(
    `${base}/search`,
    async (request, reply) => {
      const query = request.query.q ?? '';
      if (!hasUsableQuery(query)) return send(reply, jsonBody({ tracks: [] }));

      // YouTube-sourced queries carry packaging (`(From "Film")`, `[Official Video]`)
      // that no library stores; strip it before it reaches the index.
      const tokens = tokenize(normalizeQuery(query));
      const tier = normalizeTier(request.query.quality);
      const atmosWanted = /^(auto|1|true|on)$/i.test(request.query.atmos ?? '');

      let rows = deps.store.searchTracks(tokens, 60);

      // The one path that makes Home-screen playback work: a row has to exist
      // before BitChord will ask for a stream, so an empty search tries to
      // acquire the album itself (cached-only, deadline-bounded).
      if (rows.length === 0 && deps.acquisition) {
        const indexed = await deps.acquisition.acquireInline(query);
        if (indexed > 0) rows = deps.store.searchTracks(tokens, 60);
      }

      const ranked = rankRows(rows, tier, atmosWanted, tokens).slice(0, 30);
      const artKeys = deps.store.artExists(ranked.map((row) => artKeyFor(row.artist, row.album)));
      const host = deps.cfg.publicHosts[0] ?? 'localhost';
      const tracks = ranked.map((row) =>
        toAddonTrack(
          row,
          artKeys.has(artKeyFor(row.artist, row.album))
            ? `https://${host}${base}/art/${artKeyFor(row.artist, row.album)}`
            : undefined,
        ),
      );
      deps.log.debug(
        { query, tokens, tier, atmosWanted, candidates: rows.length, offered: tracks.length },
        'search',
      );
      return send(reply, jsonBody({ tracks }));
    },
  );

  // ── Stream ──────────────────────────────────────────────────────────────
  app.get<{ Params: { id: string }; Querystring: { quality?: string; atmos?: string } }>(
    `${base}/stream/:id`,
    async (request, reply) => {
      const answer = await resolveStream(
        {
          store: deps.store,
          torbox: deps.torbox,
          prober: deps.prober,
          log: deps.log,
          cache,
          media: deps.cfg.media.proxy
            ? {
                url: (id: string, ext: string) =>
                  mediaUrl({
                    host: deps.cfg.publicHosts[0] ?? 'localhost',
                    basePath: deps.cfg.pathSecret,
                    id,
                    ext,
                    exp: Math.floor(Date.now() / 1000) + deps.cfg.media.ttlSeconds,
                    secret: deps.cfg.media.secret,
                  }),
              }
            : undefined,
          onMiss: (track) => {
            // Silent by design: BitChord has no notice channel, so a miss is a miss
            // this time and a track that exists shortly afterwards.
            if (!deps.acquisition) return;
            void deps.acquisition.queueForTrack(track).catch((error: unknown) => {
              deps.log.warn({ err: String(error).slice(0, 160) }, 'could not queue acquisition');
            });
          },
        },
        request.params.id,
        { quality: request.query.quality, atmos: request.query.atmos },
      );

      // A miss that acquisition is working on is worth describing. BitChord's
      // own design for debrid addons (issue #1523) reads `retryAfter` on an
      // answer with no URL and asks again while the track plays; releases that
      // predate it ignore the field, and a 404 is not cached either way, so the
      // next play asks again regardless.
      if (answer.status === 404 && deps.acquisition && answer.body.error === NOT_HELD) {
        answer.body = {
          ...answer.body,
          error: 'Not held yet — TorBox is being asked for this album',
          retryAfter: RETRY_AFTER_SECONDS,
        };
      }
      return send(reply, jsonBody(answer.body, answer.status));
    },
  );

  // ── Album art ───────────────────────────────────────────────────────────
  app.get<{ Params: { key: string } }>(`${base}/art/:key`, async (request, reply) => {
    const key = request.params.key.replace(/\.[a-z0-9]+$/i, '');
    const art = deps.store.art(key);
    if (!art) return reply.code(404).send();
    // Immutable and long-lived: an album's cover does not change, and the app's
    // image loader should never ask twice.
    return reply
      .code(200)
      .headers({
        'content-type': art.mime,
        'cache-control': 'public, max-age=31536000, immutable',
        ...CORS_HEADERS,
      })
      .send(Buffer.from(art.bytes));
  });

  // ── Media, when the proxy is on ─────────────────────────────────────────
  if (deps.cfg.media.proxy) {
    const serveMedia = async (
      request: {
        params: { file: string };
        query: { exp?: string; sig?: string };
        headers: Record<string, string | string[] | undefined>;
        method: string;
      },
      reply: FastifyReply,
    ) => {
      const file = request.params.file;
      const dot = file.lastIndexOf('.');
      const id = decodeURIComponent(dot > 0 ? file.slice(0, dot) : file);
      const ext = dot > 0 ? file.slice(dot + 1).toLowerCase() : 'flac';

      const verdict = verifyMedia({
        id,
        exp: request.query.exp,
        sig: request.query.sig,
        secret: deps.cfg.media.secret,
      });
      if (!verdict.ok) {
        return send(reply, jsonBody({ error: `Media link ${verdict.reason}` }, 403));
      }
      const track = deps.store.getTrack(id);
      if (!track) return send(reply, jsonBody({ error: 'Not held by this addon' }, 404));
      if (!deps.torbox) return send(reply, jsonBody({ error: 'TorBox key not configured' }, 503));

      const range = request.headers.range;
      let upstream: Response;
      try {
        const link = await linkFor(cache, track.id, () =>
          deps.torbox!.requestLink(track.kind, track.itemId, track.fileId),
        );
        upstream = await fetchImpl(link, {
          headers: {
            ...(typeof range === 'string' ? { range } : {}),
            // Harmless if the CDN ignores it, required if it does not.
            authorization: `Bearer ${deps.cfg.torboxKey ?? ''}`,
          },
          redirect: 'follow',
        });
      } catch (error) {
        deps.log.warn({ id, err: String(error).slice(0, 120) }, 'media fetch failed');
        return send(reply, jsonBody({ error: 'Upstream fetch failed' }, 502));
      }

      const headers: Record<string, string> = {
        'content-type': upstream.headers.get('content-type') ?? contentTypeFor(ext),
        'accept-ranges': upstream.headers.get('accept-ranges') ?? 'bytes',
        'cache-control': 'private, max-age=60',
        ...CORS_HEADERS,
      };
      const length = upstream.headers.get('content-length');
      const contentRange = upstream.headers.get('content-range');
      if (length) headers['content-length'] = length;
      if (contentRange) headers['content-range'] = contentRange;

      reply.code(upstream.status).headers(headers);
      if (request.method === 'HEAD' || !upstream.body) return reply.send();
      // A player that seeks or cancels closes the socket mid-stream; Fastify treats
      // that as a normal end, so nothing here needs to handle it.
      return reply.send(Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]));
    };

    app.get<{ Params: { file: string }; Querystring: { exp?: string; sig?: string } }>(
      `${base}/media/:file`,
      serveMedia as never,
    );
    // Fastify answers HEAD from the GET route automatically (exposeHeadRoutes), and
    // `serveMedia` already short-circuits when the method is HEAD.
  }

  // ── Health and the operator page ────────────────────────────────────────
  app.get(`${base}/health`, async (_request, reply) =>
    send(reply, jsonBody(healthBody(deps.store.stats(), ADDON_VERSION))),
  );

  app.get(`${base}/admin`, async (_request, reply) =>
    send(
      reply,
      htmlBody(
        adminPage({
          stats: deps.store.stats(),
          auth: deps.auth.counters(),
          host: deps.cfg.publicHosts[0] ?? 'localhost',
          basePath: deps.cfg.pathSecret,
          queue: deps.store.recentQueue(20),
          tracks: deps.store.sampleTracks(30).map((track) => ({
            id: track.id,
            title: track.title,
            artist: track.artist,
            album: track.album,
            quality: qualityLabel(track),
            durationSec: track.durationSec,
          })),
          budgetLeft: deps.acquisition?.budgetLeft() ?? 0,
          acquireEnabled: deps.cfg.acquire.enabled,
          allowUncached: deps.cfg.acquire.allowUncached,
        }),
      ),
    ),
  );

  app.get<{ Querystring: { limit?: string } }>(`${base}/admin/tracks`, async (request, reply) => {
    const limit = Number(request.query.limit ?? 50);
    const tracks = deps.store
      .sampleTracks(Number.isFinite(limit) ? limit : 50)
      .map((track) => ({
        id: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        quality: qualityLabel(track),
        codec: track.codec,
        sampleRate: track.sampleRate,
        bitDepth: track.bitDepth,
        durationSec: track.durationSec,
        probed: track.probedAt !== null,
      }));
    return send(reply, jsonBody({ count: tracks.length, tracks }));
  });

  app.post(`${base}/admin/sync`, async (_request, reply) => {
    if (!deps.sync) return send(reply, jsonBody({ error: 'TorBox key not configured' }, 503));
    const results = await deps.sync.walkUntilDone({ maxPages: 50 });
    return send(reply, jsonBody({ ok: true, results }));
  });

  app.post(`${base}/admin/probe`, async (_request, reply) => {
    if (!deps.prober) return send(reply, jsonBody({ error: 'TorBox key not configured' }, 503));
    const result = await deps.prober.runBatch(deps.cfg.probe.batchSize);
    return send(reply, jsonBody({ ok: true, ...result }));
  });

  app.setNotFoundHandler(async (_request, reply) => send(reply, jsonBody({ error: 'Not found' }, 404)));

  return app;
}
