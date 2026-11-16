import type { AuthCounters } from '../auth/bitchord.js';
import type { Stats } from '../db.js';
import { escapeHtml } from '../http.js';

/**
 * The health answer BitChord probes, plus the operator page.
 *
 * BitChord's own "Test" runs `/manifest.json` and then a `/search?q=music` probe —
 * there is no `/health` requirement in the protocol, so this exists for humans and
 * for uptime checks. It is never gated by anything.
 */
export function healthBody(stats: Stats, version: string): Record<string, unknown> {
  return {
    ok: true,
    version,
    items: stats.items,
    tracks: stats.tracks,
    probed: stats.probed,
    lossless: stats.lossless,
    atmos: stats.atmos,
    queue: stats.queue,
  };
}

export function adminPage(input: {
  stats: Stats;
  auth: AuthCounters;
  host: string;
  basePath: string;
  queue: Array<{
    hash: string;
    name: string;
    state: string;
    seeders: number | null;
    note: string | null;
    source: string | null;
  }>;
  budgetLeft: number;
  acquireEnabled: boolean;
  allowUncached: boolean;
}): string {
  const { stats, auth } = input;
  const codes = Object.entries(auth.byCode)
    .sort((a, b) => b[1] - a[1])
    .map(([code, count]) => `<li><code>${escapeHtml(code)}</code> — ${count}</li>`)
    .join('');
  const queue = input.queue
    .map(
      (row) => `<tr>
        <td><code>${escapeHtml(row.hash.slice(0, 12))}</code></td>
        <td>${escapeHtml(row.name.slice(0, 90))}</td>
        <td>${escapeHtml(row.state)}</td>
        <td>${escapeHtml(row.seeders ?? '—')}</td>
        <td>${escapeHtml(row.source ?? '—')}</td>
        <td>${escapeHtml((row.note ?? '').slice(0, 80))}</td>
      </tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>TorBox Lossless — addon</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { color-scheme: dark }
  body { font: 15px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 2rem; background:#0f1115; color:#e6e6e6 }
  h1 { font-size: 1.3rem; margin: 0 0 .25rem }
  p.sub { margin: 0 0 2rem; color:#8b93a1 }
  section { margin-bottom: 2rem; max-width: 60rem }
  h2 { font-size: .85rem; text-transform: uppercase; letter-spacing: .08em; color:#8b93a1; margin: 0 0 .75rem }
  table { border-collapse: collapse; width: 100%; font-size: 13px }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #1e232c }
  th { color:#8b93a1; font-weight: 500 }
  code { background:#181d25; padding: .1rem .3rem; border-radius: 4px; font-size: 12px }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: .75rem }
  .card { background:#151a21; border:1px solid #1e232c; border-radius: 10px; padding: .8rem 1rem }
  .card b { display:block; font-size: 1.4rem }
  .card span { color:#8b93a1; font-size: 12px }
  ul { margin:.2rem 0; padding-left: 1.1rem }
  .warn { color:#e8c07d }
</style></head>
<body>
<h1>TorBox Lossless</h1>
<p class="sub">Addon URL: <code>https://${escapeHtml(input.host)}/${escapeHtml(input.basePath)}</code></p>

<section><h2>Library</h2>
  <div class="grid">
    <div class="card"><b>${stats.tracks}</b><span>tracks indexed</span></div>
    <div class="card"><b>${stats.probed}</b><span>measured</span></div>
    <div class="card"><b>${stats.lossless}</b><span>lossless</span></div>
    <div class="card"><b>${stats.atmos}</b><span>Dolby Atmos</span></div>
    <div class="card"><b>${stats.items.torrents}</b><span>torrents</span></div>
    <div class="card"><b>${stats.items.usenet}</b><span>usenet</span></div>
    <div class="card"><b>${stats.items.webdl}</b><span>web downloads</span></div>
  </div>
</section>

<section><h2>BitChord auth (observed, never enforced)</h2>
  <div class="grid">
    <div class="card"><b>${auth.total}</b><span>requests</span></div>
    <div class="card"><b>${auth.ok}</b><span>verified Android</span></div>
    <div class="card"><b>${auth.total - auth.ok}</b><span>other clients / web</span></div>
  </div>
  <ul>${codes || '<li>no requests yet</li>'}</ul>
  <p class="sub">Log-only by design: BitChord Web, Windows, macOS and Linux cannot produce the
  hardware proof, and refusing them would cut off platforms this addon is meant to serve.</p>
</section>

<section><h2>Acquisition</h2>
  <p class="sub">enabled: <b>${input.acquireEnabled ? 'yes' : 'no'}</b> ·
  uncached adds: <b>${input.allowUncached ? 'allowed' : 'skipped'}</b> ·
  budget left this hour: <b>${input.budgetLeft}</b></p>
  <form method="post" action="/${escapeHtml(input.basePath)}/admin/sync"><button>Sync library now</button></form>
  <form method="post" action="/${escapeHtml(input.basePath)}/admin/probe"><button>Probe next batch</button></form>
  <table><thead><tr><th>hash</th><th>release</th><th>state</th><th>seeders</th><th>source</th><th>note</th></tr></thead>
  <tbody>${queue || '<tr><td colspan="6">queue is empty</td></tr>'}</tbody></table>
</section>
</body></html>`;
}
