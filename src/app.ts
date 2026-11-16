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
import { redactUrl } from './log.js';
import { tokenize } from './parse.js';
import type { Prober } from './probe/worker.js';
import { adminPage, healthBody } from './routes/admin.js';
import { ADDON_VERSION, buildManifest } from './routes/manifest.js';
import { hasUsableQuery, normalizeTier, rankRows, toAddonTrack } from './routes/search.js';
import { qualityLabel, resolveStream, type LinkCache } from './routes/stream.js';
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
};

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

      const tokens = tokenize(query);
      const tier = normalizeTier(request.query.quality);
      const atmosWanted = /^(auto|1|true|on)$/i.test(request.query.atmos ?? '');

      const rows = deps.store.searchTracks(tokens, 60);
      const ranked = rankRows(rows, tier, atmosWanted).slice(0, 30);
      deps.log.debug(
        { query, tokens, tier, atmosWanted, candidates: rows.length, offered: ranked.length },
        'search',
      );
      return send(reply, jsonBody({ tracks: ranked.map(toAddonTrack) }));
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
      return send(reply, jsonBody(answer.body, answer.status));
    },
  );

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
