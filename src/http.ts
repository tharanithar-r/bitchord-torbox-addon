/**
 * Shared HTTP shape for every route.
 *
 * BitChord itself needs no CORS (it is a native client), but BitChord **Web**
 * does, and it is one of the platforms this addon is meant to work on: a browser
 * origin cannot read a cross-origin JSON response without these headers. Sending
 * them costs nothing for the native apps.
 */
export const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-bitchord-token, x-bitchord-proof',
  'access-control-expose-headers': 'retry-after',
};

/** No response here is worth caching in a browser or proxy; TTLs are ours. */
export const NO_STORE = 'no-store';

export function jsonBody(data: unknown, status = 200): {
  status: number;
  headers: Record<string, string>;
  body: string;
} {
  return {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': NO_STORE,
      ...CORS_HEADERS,
    },
    body: JSON.stringify(data),
  };
}

export function htmlBody(html: string, status = 200): {
  status: number;
  headers: Record<string, string>;
  body: string;
} {
  return {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': NO_STORE,
      ...CORS_HEADERS,
    },
    body: html,
  };
}

/** Escape untrusted text before it goes into the admin page. */
export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
