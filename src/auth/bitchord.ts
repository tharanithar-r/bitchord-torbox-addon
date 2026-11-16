import { createBitChordAuth } from '../../vendor/bitchord-addon-auth.mjs';
import { shortHash } from '../log.js';

/**
 * BitChord addon auth, observed and never enforced.
 *
 * The official verifier proves a request came from the release-signed Android app
 * on a phone with an intact OS. That proof is worth having, but refusing requests
 * without it would cut off exactly the clients this addon is meant to serve —
 * BitChord's web player, and the Windows/macOS/Linux builds, none of which can
 * produce a hardware-backed assertion. So the manifest declares
 * `bitchordAuth: true` (which is what clears the "Outdated addon" note) and every
 * request is verified and counted, but the result is only ever logged.
 *
 * That leaves the path secret as the actual gate, which is why it is long, rotated
 * by changing one env var, and redacted out of every log line.
 */
export type AuthObservation = {
  ok: boolean;
  code: string;
  /** Per-install key id from the token, hashed — not an identity, and rotates hourly. */
  sub?: string;
  /** BitChord version code, when a valid token was presented. */
  ver?: number;
};

export type AuthCounters = {
  total: number;
  ok: number;
  byCode: Record<string, number>;
};

export type AuthObserver = {
  observe(request: { headers: Record<string, unknown> }): Promise<AuthObservation>;
  counters(): AuthCounters;
};

export type BitchordAuthOptions = {
  fetch?: typeof fetch;
  now?: () => number;
  jwksUrl?: string;
  clockSkewSeconds?: number;
};

export function createBitchordAuth(hosts: string[], options: BitchordAuthOptions = {}): AuthObserver {
  const verifier = createBitChordAuth({ hosts, ...options });
  const byCode: Record<string, number> = {};
  let total = 0;
  let ok = 0;

  return {
    async observe(request): Promise<AuthObservation> {
      total += 1;
      try {
        const result = await verifier.verifyRequest(request);
        if (result.ok) {
          ok += 1;
          byCode.ok = (byCode.ok ?? 0) + 1;
          return {
            ok: true,
            code: 'ok',
            sub: shortHash(String(result.claims.sub ?? '')),
            ver: Number(result.claims.ver ?? 0) || undefined,
          };
        }
        byCode[result.error] = (byCode[result.error] ?? 0) + 1;
        return { ok: false, code: result.error };
      } catch (error) {
        // A verifier fault must never take a request down with it — it is an
        // observation here, not a gate.
        const code = error instanceof Error && /fetch|JWKS/i.test(error.message) ? 'keys_unavailable' : 'verify_error';
        byCode[code] = (byCode[code] ?? 0) + 1;
        return { ok: false, code };
      }
    },

    counters(): AuthCounters {
      return { total, ok, byCode: { ...byCode } };
    },
  };
}
