// The only accepted IBKR base URL: the local Client Portal Gateway. The official gateway runs on the same machine and only
// accepts logins and requests from that machine (docs: "Limitations of the Client Portal Gateway"), so the base URL must be a
// loopback HTTPS address with the gateway's /v1/api path. No credentials, query or fragment are allowed in it.

export const IBKR_DEFAULT_BASE_URL = 'https://localhost:5000/v1/api' as const;

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

export class IbkrBaseUrlError extends Error {
  override readonly name = 'IbkrBaseUrlError';
}

export function parseLoopbackBaseUrl(text: string): URL {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new IbkrBaseUrlError('IBKR_BASE_URL is not a valid URL');
  }
  if (url.protocol !== 'https:') throw new IbkrBaseUrlError('IBKR_BASE_URL must use https (the gateway serves HTTPS)');
  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) throw new IbkrBaseUrlError('IBKR_BASE_URL must be a loopback address (localhost, 127.0.0.1 or ::1): the gateway is local only');
  if (url.username !== '' || url.password !== '') throw new IbkrBaseUrlError('IBKR_BASE_URL must not contain credentials');
  if (url.search !== '' || url.hash !== '') throw new IbkrBaseUrlError('IBKR_BASE_URL must not contain a query or fragment');
  const path = url.pathname.replace(/\/+$/, '');
  if (path !== '/v1/api') throw new IbkrBaseUrlError('IBKR_BASE_URL must end with the gateway path /v1/api');
  return new URL(url.origin + '/v1/api');
}
