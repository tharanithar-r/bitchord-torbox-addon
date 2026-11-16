import { Acquisition } from './acquire/queue.js';
import { createApp } from './app.js';
import { createBitchordAuth } from './auth/bitchord.js';
import { loadConfig, loadDotEnv, type Config } from './config.js';
import { Store } from './db.js';
import { createLogger } from './log.js';
import { Prober } from './probe/worker.js';
import { Sync } from './sync.js';
import { TorBoxClient } from './torbox.js';

/**
 * Boot: config, index, workers, server.
 *
 * The server starts even without a `TORBOX_KEY` — it answers the manifest, the
 * health route and an empty search — so a deployment can be checked from the app
 * before the key is in place. Everything that needs the account simply does not
 * start.
 */
async function main(): Promise<void> {
  loadDotEnv();
  const cfg: Config = loadConfig();
  const log = createLogger(cfg.logLevel);
  const store = Store.open(cfg.dbPath);
  const auth = createBitchordAuth(cfg.publicHosts);

  const torbox = cfg.torboxKey ? new TorBoxClient(cfg.torboxKey) : undefined;
  const sync = torbox ? new Sync(store, torbox, log) : undefined;
  const prober = torbox
    ? new Prober(store, torbox, log, { maxBytes: cfg.probe.maxBytes, artFinder: cfg.probe.artFinder })
    : undefined;
  const acquisition =
    torbox && sync
      ? new Acquisition(store, torbox, sync, log, {
          enabled: cfg.acquire.enabled,
          allowUncached: cfg.acquire.allowUncached,
          maxAlbumsPerHour: cfg.acquire.maxAlbumsPerHour,
          minSeeders: cfg.acquire.minSeeders,
          maxAlbumGb: cfg.acquire.maxAlbumGb,
        })
      : undefined;

  if (!torbox) {
    log.warn('TORBOX_KEY is not set: index-only mode (manifest and health only, no search results or streams)');
  }

  const app = createApp({ cfg, store, log, auth, torbox, prober, acquisition, sync });

  await app.listen({ port: cfg.port, host: cfg.bindHost });
  // Every effective setting that is not a secret, so "did my env apply?" is
  // answerable from the deploy log instead of from the code.
  log.info(
    {
      addonUrlTemplate: `https://${cfg.publicHosts[0] ?? 'localhost'}/<PATH_SECRET>`,
      hosts: cfg.publicHosts,
      db: cfg.dbPath,
      port: cfg.port,
      acquire: cfg.acquire,
      probe: cfg.probe,
      media: { proxy: cfg.media.proxy, ttlSeconds: cfg.media.ttlSeconds },
      syncIntervalMinutes: cfg.syncIntervalMinutes,
      torboxKey: cfg.torboxKey ? 'set' : 'missing',
    },
    'addon listening',
  );

  // ── Background work ─────────────────────────────────────────────────────
  // Each loop guards its own overlap: a slow page must not stack up behind a timer.
  let syncing = false;
  let probing = false;
  let acquiring = false;

  /**
   * One walk pass, bounded by a page budget.
   *
   * Returns whether every kind finished, so the scheduler knows whether to come
   * back in twenty seconds (a partial walk, e.g. a first run over a big library)
   * or after the configured interval.
   */
  const runSync = async (): Promise<boolean> => {
    if (!sync || syncing) return true;
    syncing = true;
    try {
      const results = await sync.walkUntilDone({ maxPages: 50 });
      const done = results.every((result) => result.done);
      log.info({ results, done }, 'sync pass finished');
      return done;
    } catch (error) {
      log.warn({ err: (error as Error).message }, 'sync loop failed');
      return false;
    } finally {
      syncing = false;
    }
  };

  const runProbe = async (): Promise<void> => {
    if (!prober || probing) return;
    probing = true;
    try {
      await prober.runBatch(cfg.probe.batchSize);
    } catch (error) {
      log.warn({ err: (error as Error).message }, 'probe loop failed');
    } finally {
      probing = false;
    }
  };

  const runAcquire = async (): Promise<void> => {
    if (!acquisition || acquiring) return;
    acquiring = true;
    try {
      for (let i = 0; i < 3; i++) {
        const outcome = await acquisition.processOne();
        if (outcome === 'empty' || outcome === 'budget' || outcome === 'skipped') break;
      }
      // A release added while still downloading becomes searchable here, not at
      // the next library walk.
      await acquisition.refreshInflight();
    } catch (error) {
      log.warn({ err: (error as Error).message }, 'acquisition loop failed');
    } finally {
      acquiring = false;
    }
  };

  const timers: NodeJS.Timeout[] = [];
  let syncTimer: NodeJS.Timeout | null = null;
  if (sync) {
    // A first run is fired immediately; while it is still incomplete the next pass
    // is 20 s away, and only a finished walk waits for the long interval.
    const scheduleSync = (delayMs: number): void => {
      syncTimer = setTimeout(() => {
        void runSync().then((done) => {
          scheduleSync(done ? Math.max(1, cfg.syncIntervalMinutes) * 60_000 : 20_000);
        });
      }, delayMs);
      syncTimer.unref();
    };
    scheduleSync(0);
  }
  if (prober) timers.push(setInterval(() => void runProbe(), 3 * 60_000));
  if (acquisition) timers.push(setInterval(() => void runAcquire(), 60_000));
  for (const timer of timers) timer.unref();

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'shutting down');
    for (const timer of timers) clearInterval(timer);
    if (syncTimer) clearTimeout(syncTimer);
    await app.close().catch(() => undefined);
    store.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  // Nothing is listening yet, so a stack trace on stderr is the only channel left.
  console.error('fatal:', error instanceof Error ? error.message : error);
  process.exit(1);
});
