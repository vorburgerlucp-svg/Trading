// The complete, fixed set of eToro operations this build may call (O20): demo, read-only, GET only. There is no generic request
// function, no caller-supplied path, no parameter and no body. Real-account endpoints do not appear here, and there is no route
// for an order, a modification or a cancellation. Paths follow the eToro public API; the demo portfolio path is the one observed
// in a live demo response.

export const ETORO_BASE_URL = 'https://public-api.etoro.com/api/v1' as const;

export const ETORO_ALLOWED_OPERATIONS = Object.freeze({
  'portfolio.demo': { method: 'GET', path: '/trading/info/demo/portfolio' },
} as const);

export type EtoroOperation = keyof typeof ETORO_ALLOWED_OPERATIONS;
