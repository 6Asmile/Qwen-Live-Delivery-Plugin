// Credentials belong only to temporary test servers. Security tests use native fetch directly.
const tokens = new Map();
export function authorize(origin, token) {
  if (token) tokens.set(new URL(origin).origin, token);
}
export function authorizeConfig(cfg) {
  authorize(`http://127.0.0.1:${cfg.port}`, cfg.accessToken);
}
export function fetch(url, options = {}) {
  const headers = new Headers(options.headers);
  const token = tokens.get(new URL(url).origin);
  if (token && !headers.has('Authorization')) headers.set('Authorization', 'Bearer ' + token);
  return globalThis.fetch(url, { ...options, headers });
}
