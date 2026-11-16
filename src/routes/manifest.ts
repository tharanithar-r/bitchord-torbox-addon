import type { Config } from '../config.js';

/**
 * The manifest: what BitChord reads before it trusts anything else.
 *
 * Field-by-field, against the official guide:
 *
 *  - `bitchordAuth: true` — clears the "Outdated addon" note in Sources on every
 *    platform. The verification itself is log-only (see `auth/bitchord.ts`), so the
 *    flag claims the addon is current without locking out the web or desktop apps,
 *    which cannot produce the hardware-backed proof.
 *  - `allowDownloads: 1` — a saved track is a real FLAC from the account, so offline
 *    playback is worth having.
 *  - `checkValidLossless: 0` — no lossless-output gate. The addon is asked on the
 *    phone speaker too; the codec it returns is still honest in "Stats for nerds".
 *  - `settings.quality` — the picker. **Best option first**, because BitChord sends
 *    the first option when the listener has not chosen, and it never looks for the
 *    word "lossless".
 *  - No other settings: only `quality` is drawn, and everything else would be sent
 *    as a query parameter that nothing reads.
 */
export const ADDON_ID = 'app.torbox.lossless';
export const ADDON_VERSION = '1.0.0';

export type Manifest = Record<string, unknown>;

export function buildManifest(_config?: Config): Manifest {
  return {
    id: ADDON_ID,
    name: 'TorBox Lossless',
    version: ADDON_VERSION,
    description:
      'Lossless FLAC/ALAC/WAV and Dolby Atmos from your TorBox library, with on-demand acquisition from free indexers.',
    resources: ['search', 'stream'],
    bitchordAuth: true,
    allowDownloads: 1,
    checkValidLossless: 0,
    settings: [
      {
        key: 'quality',
        type: 'select',
        label: 'Audio quality',
        default: 'max',
        options: [
          { value: 'max', label: 'Max (best available)' },
          { value: 'atmos', label: 'Atmos (DD+ JOC)' },
          { value: 'hires', label: 'Hi-Res (24-bit)' },
          { value: 'cd', label: 'CD (16/44.1)' },
        ],
      },
    ],
  };
}
