// Hard limits of the IBKR read-only path. Raising one is a reviewed change, never a configuration value.

/** One response body. A 100-position page is a few hundred KiB at most; anything larger is refused. */
export const IBKR_MAX_RESPONSE_BYTES_DEFAULT = 1024 * 1024;
/** Per request. The gateway answers in milliseconds when it is healthy. */
export const IBKR_REQUEST_TIMEOUT_MS = 10_000;
/** Accounts a session may list. More than this is treated as an invalid response. */
export const IBKR_MAX_ACCOUNTS = 20;
/** Open orders accepted in one response. */
export const IBKR_MAX_ORDERS = 500;
