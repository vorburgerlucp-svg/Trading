// The complete, fixed set of eToro operations this build may call (O20): demo, read-only, GET only. There is no generic request
// function, no caller-supplied path, no parameter and no body. Real-account endpoints do not appear here, and there is no route
// for an order, a modification or a cancellation. Paths follow the eToro public API; the demo portfolio path is the one observed
// in a live demo response.
//
// pnl.demo (O21A.1) is used only by the observation tool, never by the sync adapter: the official guides (available cash, total
// invested, profit/loss, equity) read the demo account from /trading/info/demo/pnl. It is documented, not yet live-observed.
//
// instrument.metadata.100001 (O22) is one fixed public market-data read, used only by the observation tool, to check the identity of
// the one eToro instrument observed in the demo portfolio: GET /api/v2/market-data/instruments?instrumentsIds=100001 ("Search for
// Securities Instruments by ID or Symbol", scope etoro-public:market-data:read or demo:read). The instrument id and the query are
// part of the constant: nothing about it is supplied by a caller. It reads no account data. Prepared, not yet executed.

export const ETORO_BASE_URL = 'https://public-api.etoro.com/api/v1' as const;
/** The v2 root, used by exactly one fixed market-data read. */
export const ETORO_API_V2_URL = 'https://public-api.etoro.com/api/v2' as const;

export const ETORO_ALLOWED_OPERATIONS = Object.freeze({
  'portfolio.demo': { method: 'GET', path: '/trading/info/demo/portfolio' },
  'pnl.demo': { method: 'GET', path: '/trading/info/demo/pnl' },
  'instrument.metadata.100001': { method: 'GET', base: ETORO_API_V2_URL, path: '/market-data/instruments?instrumentsIds=100001' },
} as const);

export type EtoroOperation = keyof typeof ETORO_ALLOWED_OPERATIONS;

/** The full URL of an allowed operation: its fixed base (v1 unless stated) and its fixed path. */
export function etoroOperationUrl(operation: EtoroOperation): string {
  const spec = ETORO_ALLOWED_OPERATIONS[operation];
  return ('base' in spec ? spec.base : ETORO_BASE_URL) + spec.path;
}
