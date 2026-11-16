/**
 * Ambient types for the vendored BitChord addon-auth verifier.
 *
 * The verifier is copied verbatim from the official docs
 * (https://bitchord.kushagrasingh.in/addon-auth/bitchord-addon-auth.mjs) and is
 * never edited, so these types describe its public surface only. If the vendor
 * file is ever updated, this declaration is the one thing to re-read.
 */
declare module '*.mjs' {
  export type VerifyOk = {
    ok: true;
    claims: { sub: string; ver: number; exp: number; sl: string };
  };
  export type VerifyFail = {
    ok: false;
    status: number;
    error:
      | 'missing'
      | 'expired'
      | 'invalid_token'
      | 'invalid_proof'
      | 'stale_proof'
      | 'unavailable';
    message: string;
  };
  export type VerifyResult = VerifyOk | VerifyFail;

  export function createBitChordAuth(options: {
    hosts: string[];
    maxProofAgeSeconds?: number;
    clockSkewSeconds?: number;
    issuer?: string;
    jwksUrl?: string;
    fetch?: typeof fetch;
    now?: () => number;
  }): {
    verify(input: { token?: string | null; proof?: string | null }): Promise<VerifyResult>;
    verifyRequest(request: { headers: Record<string, unknown> }): Promise<VerifyResult>;
    rejection(result: VerifyFail): {
      status: number;
      headers: Record<string, string>;
      body: string;
    };
    guard(request: Request): Promise<Response | null>;
    express(): (req: unknown, res: unknown, next: () => void) => Promise<void>;
  };

  export const BITCHORD_AUTH_ISSUER: string;
  export const BITCHORD_AUTH_AUDIENCE: string;
  export const TOKEN_HEADER: string;
  export const PROOF_HEADER: string;
}
