import { webcrypto as crypto, type webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createBitchordAuth } from '../src/auth/bitchord.js';

/**
 * The addon-auth path, exercised against a locally generated key pair.
 *
 * The official verifier is used unchanged — only its clock and its JWKS fetch are
 * injected — so these tests cover the real verification order (proof format, token
 * signature, claims, proof signature) without touching the network.
 */
const ISSUER = 'https://bitchord-auth.kushagrasingh.in';
const HOST = 'addon.example.com';

function b64url(input: ArrayBuffer | Uint8Array | string): string {
  const buffer =
    typeof input === 'string'
      ? Buffer.from(input)
      : input instanceof Uint8Array
        ? Buffer.from(input)
        : Buffer.from(new Uint8Array(input));
  return buffer.toString('base64url');
}

type KeyPair = { publicKey: webcrypto.CryptoKey; privateKey: webcrypto.CryptoKey };

type Fixture = {
  token: string;
  proof: string;
  fetchImpl: typeof fetch;
};

async function fixture(options: { host?: string; expOffset?: number; now?: number } = {}): Promise<Fixture> {
  const now = options.now ?? Date.now();
  const signing = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as unknown as KeyPair;
  const signingJwk = await crypto.subtle.exportKey('jwk', signing.publicKey);
  const device = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as unknown as KeyPair;
  const deviceJwk = await crypto.subtle.exportKey('jwk', device.publicKey);

  const header = b64url(JSON.stringify({ alg: 'EdDSA', kid: 'test-key', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      iss: ISSUER,
      aud: 'bitchord-addons',
      sub: 'install-thumbprint',
      iat: Math.floor(now / 1000),
      exp: Math.floor(now / 1000) + (options.expOffset ?? 3600),
      ver: 37,
      sl: 'tee',
      cnf: { jwk: { kty: 'EC', crv: 'P-256', x: deviceJwk.x, y: deviceJwk.y } },
    }),
  );
  const signature = await crypto.subtle.sign(
    { name: 'Ed25519' },
    signing.privateKey,
    Buffer.from(`${header}.${payload}`),
  );
  const token = `${header}.${payload}.${b64url(signature)}`;

  const tokenHash = b64url(await crypto.subtle.digest('SHA-256', Buffer.from(token)));
  const message = `bitchord-addon-proof/v1\n${options.host ?? HOST}\n${now}\n${tokenHash}`;
  const proofSignature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    device.privateKey,
    Buffer.from(message),
  );
  const proof = `v1.${now}.${b64url(proofSignature)}`;

  const jwks = { keys: [{ kty: 'OKP', crv: 'Ed25519', x: signingJwk.x, kid: 'test-key', alg: 'EdDSA', use: 'sig' }] };
  const fetchImpl = (async () =>
    new Response(JSON.stringify(jwks), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;

  return { token, proof, fetchImpl };
}

describe('BitChord addon auth (observed, never enforced)', () => {
  it('accepts a genuine proof and reports the claims', async () => {
    const now = Date.now();
    const fx = await fixture({ now });
    const auth = createBitchordAuth([HOST], { fetch: fx.fetchImpl, now: () => now });
    const observation = await auth.observe({
      headers: { 'x-bitchord-token': fx.token, 'x-bitchord-proof': fx.proof },
    });
    expect(observation.ok).toBe(true);
    expect(observation.code).toBe('ok');
    expect(observation.ver).toBe(37);
    expect(observation.sub).toHaveLength(8);
    expect(auth.counters()).toMatchObject({ total: 1, ok: 1 });
  });

  it('records `missing` for every client that cannot prove itself — and still serves', async () => {
    const auth = createBitchordAuth([HOST], { fetch: (async () => new Response('{}')) as unknown as typeof fetch });
    const observation = await auth.observe({ headers: {} });
    expect(observation).toMatchObject({ ok: false, code: 'missing' });
    expect(auth.counters().byCode.missing).toBe(1);
  });

  it('records `expired` for a stale token', async () => {
    const now = Date.now();
    const fx = await fixture({ now, expOffset: -3600 });
    const auth = createBitchordAuth([HOST], { fetch: fx.fetchImpl, now: () => now });
    const observation = await auth.observe({
      headers: { 'x-bitchord-token': fx.token, 'x-bitchord-proof': fx.proof },
    });
    expect(observation).toMatchObject({ ok: false, code: 'expired' });
  });

  it('records `invalid_proof` when hosts does not match the URL the app signed', async () => {
    const now = Date.now();
    const fx = await fixture({ now, host: 'somewhere-else.example.com' });
    const auth = createBitchordAuth([HOST], { fetch: fx.fetchImpl, now: () => now });
    const observation = await auth.observe({
      headers: { 'x-bitchord-token': fx.token, 'x-bitchord-proof': fx.proof },
    });
    expect(observation).toMatchObject({ ok: false, code: 'invalid_proof' });
  });

  it('records `stale_proof` when the proof clock is far off', async () => {
    const now = Date.now();
    const fx = await fixture({ now: now - 10 * 60 * 1000 });
    const auth = createBitchordAuth([HOST], { fetch: fx.fetchImpl, now: () => now });
    const observation = await auth.observe({
      headers: { 'x-bitchord-token': fx.token, 'x-bitchord-proof': fx.proof },
    });
    expect(observation).toMatchObject({ ok: false, code: 'stale_proof' });
  });

  it('never throws when the key fetch fails', async () => {
    const fx = await fixture();
    const auth = createBitchordAuth([HOST], {
      fetch: (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch,
      now: () => Date.now(),
    });
    const observation = await auth.observe({
      headers: { 'x-bitchord-token': fx.token, 'x-bitchord-proof': fx.proof },
    });
    expect(observation.ok).toBe(false);
    expect(auth.counters().total).toBe(1);
  });
});
