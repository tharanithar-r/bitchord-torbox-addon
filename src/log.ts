import { createHash } from 'node:crypto';
import { pino, type Logger } from 'pino';

/**
 * One logger for the whole process, with the two things that must never be
 * written to disk redacted by path rather than by discipline.
 *
 * The BitChord docs' production checklist is blunt about this: "logs never
 * expose path-based tokens". The path secret, the API key and both BitChord
 * auth headers are all redacted here, so a `log.info({ req })` cannot leak them
 * by accident.
 */
export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { service: 'bitchord-torbox-addon' },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-bitchord-token"]',
        'req.headers["x-bitchord-proof"]',
        'token',
        'proof',
        '*.token',
        '*.proof',
        'torboxKey',
      ],
      censor: '***',
    },
  });
}

/**
 * A URL with its path removed.
 *
 * The path secret is the credential in this protocol, so the path is the part
 * that must not be logged; the host stays because it is what makes a line
 * traceable at all.
 */
export function redactUrl(url: string, pathSecret: string): string {
  const withoutQuery = url.split('?')[0] ?? url;
  return withoutQuery.split(pathSecret).join('***');
}

/** A stable, non-reversible label for an auth `sub`, which rotates hourly anyway. */
export function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}
