import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ftsQuery, ftsQueryLoose } from './parse.js';

export type Kind = 'torrents' | 'usenet' | 'webdl';

/** Short codes keep track ids compact in a URL path: `t:1234:567`. */
export const KIND_CODE: Record<Kind, string> = { torrents: 't', usenet: 'u', webdl: 'w' };
export const CODE_KIND: Record<string, Kind> = { t: 'torrents', u: 'usenet', w: 'webdl' };

export const KINDS: Kind[] = ['torrents', 'usenet', 'webdl'];

export function trackId(kind: Kind, itemId: number, fileId: number): string {
  return `${KIND_CODE[kind]}:${itemId}:${fileId}`;
}

export function parseTrackId(id: string): { kind: Kind; itemId: number; fileId: number } | null {
  const match = /^([tuw]):(\d{1,20}):(\d{1,20})$/.exec(id);
  if (!match) return null;
  const kind = CODE_KIND[match[1] ?? ''];
  if (!kind) return null;
  return { kind, itemId: Number(match[2]), fileId: Number(match[3]) };
}

export type ItemRow = {
  kind: Kind;
  itemId: number;
  name: string;
  hash: string | null;
  sizeBytes: number | null;
  addedAt: number | null;
};

export type FileInput = {
  kind: Kind;
  itemId: number;
  fileId: number;
  shortName: string;
};

export type TrackRow = {
  id: string;
  kind: Kind;
  itemId: number;
  fileId: number;
  title: string;
  artist: string;
  album: string;
  discNo: number | null;
  trackNo: number | null;
  seq: number | null;
  format: string;
  codec: string | null;
  container: string | null;
  sampleRate: number | null;
  bitDepth: number | null;
  durationSec: number | null;
  isrc: string | null;
  sizeBytes: number | null;
  lossless: boolean;
  atmos: boolean;
  playable: boolean;
  probedAt: number | null;
  probeNote: string | null;
};

export type TrackUpsert = Omit<
  TrackRow,
  'lossless' | 'atmos' | 'playable' | 'probedAt' | 'probeNote'
> & {
  lossless?: boolean;
  atmos?: boolean;
  playable?: boolean;
};

export type QueueRow = {
  hash: string;
  name: string;
  sizeBytes: number | null;
  seeders: number | null;
  source: string | null;
  artist: string | null;
  album: string | null;
  wantedTitle: string | null;
  state: 'pending' | 'adding' | 'added' | 'failed' | 'skipped';
  attempts: number;
  itemKind: Kind | null;
  itemId: number | null;
  createdAt: number;
  updatedAt: number;
  note: string | null;
};

export type Stats = {
  items: Record<Kind, number>;
  tracks: number;
  probed: number;
  lossless: number;
  atmos: number;
  queue: Record<string, number>;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  kind        TEXT    NOT NULL,
  item_id     INTEGER NOT NULL,
  name        TEXT    NOT NULL DEFAULT '',
  hash        TEXT,
  size_bytes  INTEGER,
  added_at    INTEGER,
  PRIMARY KEY (kind, item_id)
);

CREATE TABLE IF NOT EXISTS tracks (
  id           TEXT PRIMARY KEY,
  kind         TEXT    NOT NULL,
  item_id      INTEGER NOT NULL,
  file_id      INTEGER NOT NULL,
  title        TEXT    NOT NULL,
  artist       TEXT    NOT NULL DEFAULT '',
  album        TEXT    NOT NULL DEFAULT '',
  disc_no      INTEGER,
  track_no     INTEGER,
  seq          INTEGER,
  format       TEXT    NOT NULL,
  codec        TEXT,
  container    TEXT,
  sample_rate  INTEGER,
  bit_depth    INTEGER,
  duration_sec REAL,
  isrc         TEXT,
  size_bytes   INTEGER,
  lossless     INTEGER NOT NULL DEFAULT 0,
  atmos        INTEGER NOT NULL DEFAULT 0,
  playable     INTEGER NOT NULL DEFAULT 1,
  probed_at    INTEGER,
  probe_note   TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS tracks_file  ON tracks (kind, item_id, file_id);
CREATE INDEX        IF NOT EXISTS tracks_probe ON tracks (id) WHERE probed_at IS NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
  title, artist, album,
  content = 'tracks',
  content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS tracks_ai AFTER INSERT ON tracks BEGIN
  INSERT INTO tracks_fts (rowid, title, artist, album)
  VALUES (new.rowid, new.title, new.artist, new.album);
END;

CREATE TRIGGER IF NOT EXISTS tracks_ad AFTER DELETE ON tracks BEGIN
  INSERT INTO tracks_fts (tracks_fts, rowid, title, artist, album)
  VALUES ('delete', old.rowid, old.title, old.artist, old.album);
END;

CREATE TRIGGER IF NOT EXISTS tracks_au AFTER UPDATE ON tracks BEGIN
  INSERT INTO tracks_fts (tracks_fts, rowid, title, artist, album)
  VALUES ('delete', old.rowid, old.title, old.artist, old.album);
  INSERT INTO tracks_fts (rowid, title, artist, album)
  VALUES (new.rowid, new.title, new.artist, new.album);
END;

CREATE TABLE IF NOT EXISTS queue (
  hash         TEXT PRIMARY KEY,
  name         TEXT NOT NULL DEFAULT '',
  size_bytes   INTEGER,
  seeders      INTEGER,
  source       TEXT,
  artist       TEXT,
  album        TEXT,
  wanted_title TEXT,
  state        TEXT NOT NULL DEFAULT 'pending',
  attempts     INTEGER NOT NULL DEFAULT 0,
  item_kind    TEXT,
  item_id      INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  note         TEXT
);

CREATE INDEX IF NOT EXISTS queue_state ON queue (state, created_at);

CREATE TABLE IF NOT EXISTS art (
  art_key    TEXT PRIMARY KEY,
  mime       TEXT    NOT NULL,
  bytes      BLOB    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_state (
  kind      TEXT PRIMARY KEY,
  cursor    INTEGER NOT NULL DEFAULT 0,
  last_walk INTEGER,
  last_full INTEGER
);
`;

type Raw = Record<string, unknown>;

function trackFromRaw(raw: Raw): TrackRow {
  return {
    id: String(raw.id),
    kind: String(raw.kind) as Kind,
    itemId: Number(raw.item_id),
    fileId: Number(raw.file_id),
    title: String(raw.title),
    artist: String(raw.artist ?? ''),
    album: String(raw.album ?? ''),
    discNo: raw.disc_no === null ? null : Number(raw.disc_no),
    trackNo: raw.track_no === null ? null : Number(raw.track_no),
    seq: raw.seq === null ? null : Number(raw.seq),
    format: String(raw.format),
    codec: raw.codec === null ? null : String(raw.codec),
    container: raw.container === null ? null : String(raw.container),
    sampleRate: raw.sample_rate === null ? null : Number(raw.sample_rate),
    bitDepth: raw.bit_depth === null ? null : Number(raw.bit_depth),
    durationSec: raw.duration_sec === null ? null : Number(raw.duration_sec),
    isrc: raw.isrc === null ? null : String(raw.isrc),
    sizeBytes: raw.size_bytes === null ? null : Number(raw.size_bytes),
    lossless: Number(raw.lossless) === 1,
    atmos: Number(raw.atmos) === 1,
    playable: Number(raw.playable) === 1,
    probedAt: raw.probed_at === null ? null : Number(raw.probed_at),
    probeNote: raw.probe_note === null ? null : String(raw.probe_note),
  };
}

/**
 * The index: one SQLite file, no server, rebuilt from TorBox whenever it is lost.
 *
 * `node:sqlite` (built into Node 24+) keeps the container free of a native build
 * step, and FTS5 with `remove_diacritics 2` is what makes `cafe` find `Café`.
 * Nothing here is a source of truth — the account is — so the schema favours
 * "cheap to rebuild" over migrations.
 */
export class Store {
  private constructor(private readonly db: DatabaseSync) {}

  static open(path: string): Store {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec(SCHEMA);
    return new Store(db);
  }

  close(): void {
    this.db.close();
  }

  upsertItem(item: ItemRow): void {
    this.db
      .prepare(
        `INSERT INTO items (kind, item_id, name, hash, size_bytes, added_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (kind, item_id) DO UPDATE SET
           name = excluded.name,
           hash = excluded.hash,
           size_bytes = excluded.size_bytes,
           added_at = COALESCE(excluded.added_at, items.added_at)`,
      )
      .run(
        item.kind,
        item.itemId,
        item.name,
        item.hash,
        item.sizeBytes,
        item.addedAt,
      );
  }

  /**
   * Insert or refresh one track row.
   *
   * Unprobed columns are deliberately left alone on conflict: a resync of the
   * library must not throw away the sample rate, duration and ISRC that a
   * previous probe paid for.
   */
  upsertTrack(track: TrackUpsert): void {
    this.db
      .prepare(
        `INSERT INTO tracks (
           id, kind, item_id, file_id, title, artist, album, disc_no, track_no, seq,
           format, codec, container, sample_rate, bit_depth, duration_sec, isrc,
           size_bytes, lossless, atmos, playable, probed_at, probe_note
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
         ON CONFLICT (id) DO UPDATE SET
           title = excluded.title,
           artist = excluded.artist,
           album = excluded.album,
           disc_no = COALESCE(excluded.disc_no, tracks.disc_no),
           track_no = COALESCE(excluded.track_no, tracks.track_no),
           seq = COALESCE(excluded.seq, tracks.seq),
           format = excluded.format,
           size_bytes = COALESCE(excluded.size_bytes, tracks.size_bytes),
           lossless = excluded.lossless,
           atmos = excluded.atmos,
           playable = excluded.playable`,
      )
      .run(
        track.id,
        track.kind,
        track.itemId,
        track.fileId,
        track.title,
        track.artist,
        track.album,
        track.discNo,
        track.trackNo,
        track.seq,
        track.format,
        track.codec ?? null,
        track.container ?? null,
        track.sampleRate ?? null,
        track.bitDepth ?? null,
        track.durationSec ?? null,
        track.isrc ?? null,
        track.sizeBytes ?? null,
        track.lossless === false ? 0 : 1,
        track.atmos ? 1 : 0,
        track.playable === false ? 0 : 1,
      );
  }

  /** Record what the prober found, or that it could not describe the file. */
  recordProbe(
    id: string,
    probe: {
      codec: string | null;
      container: string | null;
      sampleRate: number | null;
      bitDepth: number | null;
      durationSec: number | null;
      isrc: string | null;
      lossless: boolean;
      atmos: boolean;
      playable: boolean;
      note: string | null;
      title?: string;
      artist?: string;
      album?: string;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE tracks SET
           codec = ?, container = ?, sample_rate = ?, bit_depth = ?, duration_sec = ?,
           isrc = COALESCE(?, isrc), lossless = ?, atmos = ?, playable = ?,
           title = COALESCE(?, title), artist = COALESCE(?, artist), album = COALESCE(?, album),
           probed_at = ?, probe_note = ?
         WHERE id = ?`,
      )
      .run(
        probe.codec,
        probe.container,
        probe.sampleRate,
        probe.bitDepth,
        probe.durationSec,
        probe.isrc,
        probe.lossless ? 1 : 0,
        probe.atmos ? 1 : 0,
        probe.playable ? 1 : 0,
        probe.title ?? null,
        probe.artist ?? null,
        probe.album ?? null,
        Math.floor(Date.now() / 1000),
        probe.note,
        id,
      );
  }

  getTrack(id: string): TrackRow | null {
    const raw = this.db.prepare('SELECT * FROM tracks WHERE id = ?').get(id) as Raw | undefined;
    return raw ? trackFromRaw(raw) : null;
  }

  /** First rows of the index, for the operator page and the debug route. */
  sampleTracks(limit = 30): TrackRow[] {
    const rows = this.db
      .prepare('SELECT * FROM tracks ORDER BY rowid LIMIT ?')
      .all(Math.max(1, Math.min(500, limit))) as Raw[];
    return rows.map(trackFromRaw);
  }

  tracksNeedingProbe(limit: number): TrackRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tracks
          WHERE probed_at IS NULL AND playable = 1
          ORDER BY seq IS NULL, seq, rowid
          LIMIT ?`,
      )
      .all(limit) as Raw[];
    return rows.map(trackFromRaw);
  }

  /**
   * Full-text search, strict first.
   *
   * `title artist` from BitChord is an AND of prefixes: that finds the record and
   * not every album by the artist. Only when that returns nothing does the loose
   * OR form run, which is what keeps a two-word query from answering with silence
   * on a catalogue that spells the artist differently.
   */
  searchTracks(tokens: string[], limit = 30): TrackRow[] {
    const strict = ftsQuery(tokens);
    if (strict) {
      const rows = this.db
        .prepare(
          `SELECT t.* FROM tracks_fts f JOIN tracks t ON t.rowid = f.rowid
            WHERE tracks_fts MATCH ?
            ORDER BY f.rank
            LIMIT ?`,
        )
        .all(strict, limit) as Raw[];
      if (rows.length > 0) return rows.map(trackFromRaw);
    }
    const loose = ftsQueryLoose(tokens);
    if (!loose) return [];
    const rows = this.db
      .prepare(
        `SELECT t.* FROM tracks_fts f JOIN tracks t ON t.rowid = f.rowid
          WHERE tracks_fts MATCH ?
          ORDER BY f.rank
          LIMIT ?`,
      )
      .all(loose, limit) as Raw[];
    return rows.map(trackFromRaw);
  }

  stats(): Stats {
    const count = (sql: string, ...params: (string | number)[]): number =>
      Number((this.db.prepare(sql).get(...params) as Raw | undefined)?.n ?? 0);
    const items: Record<Kind, number> = {
      torrents: count('SELECT COUNT(*) AS n FROM items WHERE kind = ?', 'torrents'),
      usenet: count('SELECT COUNT(*) AS n FROM items WHERE kind = ?', 'usenet'),
      webdl: count('SELECT COUNT(*) AS n FROM items WHERE kind = ?', 'webdl'),
    };
    const queue: Record<string, number> = {};
    for (const row of this.db
      .prepare('SELECT state, COUNT(*) AS n FROM queue GROUP BY state')
      .all() as Raw[]) {
      queue[String(row.state)] = Number(row.n);
    }
    return {
      items,
      tracks: count('SELECT COUNT(*) AS n FROM tracks'),
      probed: count('SELECT COUNT(*) AS n FROM tracks WHERE probed_at IS NOT NULL'),
      lossless: count('SELECT COUNT(*) AS n FROM tracks WHERE lossless = 1'),
      atmos: count('SELECT COUNT(*) AS n FROM tracks WHERE atmos = 1'),
      queue,
    };
  }

  // ── Album art ────────────────────────────────────────────────────────────

  /** Store a cover once per album; later tracks of the same album reuse it. */
  putArt(key: string, mime: string, bytes: Uint8Array): void {
    this.db
      .prepare(
        `INSERT INTO art (art_key, mime, bytes, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (art_key) DO NOTHING`,
      )
      .run(key, mime, bytes, Math.floor(Date.now() / 1000));
  }

  art(key: string): { mime: string; bytes: Uint8Array } | null {
    const raw = this.db.prepare('SELECT mime, bytes FROM art WHERE art_key = ?').get(key) as
      | { mime: string; bytes: Uint8Array }
      | undefined;
    return raw ? { mime: raw.mime, bytes: raw.bytes } : null;
  }

  /** Which of these album keys already have a cover — one query per search. */
  artExists(keys: string[]): Set<string> {
    const unique = [...new Set(keys.filter((k) => k !== ''))];
    if (unique.length === 0) return new Set();
    const placeholders = unique.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT art_key FROM art WHERE art_key IN (${placeholders})`)
      .all(...unique) as Raw[];
    return new Set(rows.map((row) => String(row.art_key)));
  }

  // ── Sync cursors ──────────────────────────────────────────────────────────

  cursor(kind: Kind): { cursor: number; lastWalk: number | null; lastFull: number | null } {
    const raw = this.db
      .prepare('SELECT cursor, last_walk, last_full FROM sync_state WHERE kind = ?')
      .get(kind) as Raw | undefined;
    return {
      cursor: raw ? Number(raw.cursor) : 0,
      lastWalk: raw?.last_walk == null ? null : Number(raw.last_walk),
      lastFull: raw?.last_full == null ? null : Number(raw.last_full),
    };
  }

  setCursor(kind: Kind, cursor: number, full = false): void {
    this.db
      .prepare(
        `INSERT INTO sync_state (kind, cursor, last_walk, last_full) VALUES (?, ?, ?, ?)
         ON CONFLICT (kind) DO UPDATE SET
           cursor = excluded.cursor,
           last_walk = excluded.last_walk,
           last_full = COALESCE(excluded.last_full, sync_state.last_full)`,
      )
      .run(kind, cursor, Math.floor(Date.now() / 1000), full ? Math.floor(Date.now() / 1000) : null);
  }

  // ── Acquisition queue ─────────────────────────────────────────────────────

  enqueue(release: {
    hash: string;
    name: string;
    sizeBytes?: number | null;
    seeders?: number | null;
    source?: string | null;
    artist?: string | null;
    album?: string | null;
    wantedTitle?: string | null;
  }): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `INSERT INTO queue (hash, name, size_bytes, seeders, source, artist, album, wanted_title,
                            state, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
         ON CONFLICT (hash) DO UPDATE SET updated_at = excluded.updated_at`,
      )
      .run(
        release.hash.toLowerCase(),
        release.name,
        release.sizeBytes ?? null,
        release.seeders ?? null,
        release.source ?? null,
        release.artist ?? null,
        release.album ?? null,
        release.wantedTitle ?? null,
        now,
        now,
      );
  }

  nextQueue(): QueueRow | null {
    const raw = this.db
      .prepare(
        `SELECT * FROM queue WHERE state = 'pending' ORDER BY created_at LIMIT 1`,
      )
      .get() as Raw | undefined;
    if (!raw) return null;
    return {
      hash: String(raw.hash),
      name: String(raw.name ?? ''),
      sizeBytes: raw.size_bytes == null ? null : Number(raw.size_bytes),
      seeders: raw.seeders == null ? null : Number(raw.seeders),
      source: raw.source == null ? null : String(raw.source),
      artist: raw.artist == null ? null : String(raw.artist),
      album: raw.album == null ? null : String(raw.album),
      wantedTitle: raw.wanted_title == null ? null : String(raw.wanted_title),
      state: String(raw.state) as QueueRow['state'],
      attempts: Number(raw.attempts ?? 0),
      itemKind: raw.item_kind == null ? null : (String(raw.item_kind) as Kind),
      itemId: raw.item_id == null ? null : Number(raw.item_id),
      createdAt: Number(raw.created_at ?? 0),
      updatedAt: Number(raw.updated_at ?? 0),
      note: raw.note == null ? null : String(raw.note),
    };
  }

  updateQueue(
    hash: string,
    patch: {
      state?: QueueRow['state'];
      attempts?: number;
      itemKind?: Kind | null;
      itemId?: number | null;
      note?: string | null;
    },
  ): void {
    const sets: string[] = ['updated_at = ?'];
    const params: (string | number | null)[] = [Math.floor(Date.now() / 1000)];
    if (patch.state !== undefined) {
      sets.push('state = ?');
      params.push(patch.state);
    }
    if (patch.attempts !== undefined) {
      sets.push('attempts = ?');
      params.push(patch.attempts);
    }
    if (patch.itemKind !== undefined) {
      sets.push('item_kind = ?');
      params.push(patch.itemKind);
    }
    if (patch.itemId !== undefined) {
      sets.push('item_id = ?');
      params.push(patch.itemId);
    }
    if (patch.note !== undefined) {
      sets.push('note = ?');
      params.push(patch.note);
    }
    params.push(hash.toLowerCase());
    this.db.prepare(`UPDATE queue SET ${sets.join(', ')} WHERE hash = ?`).run(...params);
  }

  recentQueue(limit = 20): QueueRow[] {
    const rows = this.db
      .prepare('SELECT * FROM queue ORDER BY updated_at DESC LIMIT ?')
      .all(limit) as Raw[];
    return rows.map((raw) => ({
      hash: String(raw.hash),
      name: String(raw.name ?? ''),
      sizeBytes: raw.size_bytes == null ? null : Number(raw.size_bytes),
      seeders: raw.seeders == null ? null : Number(raw.seeders),
      source: raw.source == null ? null : String(raw.source),
      artist: raw.artist == null ? null : String(raw.artist),
      album: raw.album == null ? null : String(raw.album),
      wantedTitle: raw.wanted_title == null ? null : String(raw.wanted_title),
      state: String(raw.state) as QueueRow['state'],
      attempts: Number(raw.attempts ?? 0),
      itemKind: raw.item_kind == null ? null : (String(raw.item_kind) as Kind),
      itemId: raw.item_id == null ? null : Number(raw.item_id),
      createdAt: Number(raw.created_at ?? 0),
      updatedAt: Number(raw.updated_at ?? 0),
      note: raw.note == null ? null : String(raw.note),
    }));
  }
}
