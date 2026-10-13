// Strict validation of Twelve Data responses (schemas per the official OpenAPI spec,
// api.twelvedata.com/doc/swagger/openapi.json, checked 2026-10-08).
//
// A provider response is untrusted input. Nothing leaves this module as `any`: every field used is
// checked for type and format; prices must be plain decimal strings. A response that violates the
// schema is rejected as a whole (schema_invalid, never retried). Free-text fields (instrument
// names) are sanitized and length-limited; they remain data, never instructions.

import { MarketDataError } from '../market-data-provider.js';

const PROVIDER = 'twelvedata';
// Plain decimal notation only (as observed from the real API). Exponents ("1e300") are rejected:
// they would smuggle absurd magnitudes past the type check.
const DECIMAL_TEXT = /^-?\d{1,20}(\.\d{1,20})?$/;
const INTRADAY_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CONTROL = /[\u0000-\u001f\u007f]/g;

function fail(message: string): never {
  throw new MarketDataError('schema_invalid', PROVIDER, 'response violates schema: ' + message);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path + ' must be an object');
  return value as Record<string, unknown>;
}

function array(value: unknown, path: string, max = 100_000): unknown[] {
  if (!Array.isArray(value)) fail(path + ' must be an array');
  if ((value as unknown[]).length > max) fail(path + ' has too many entries');
  return value as unknown[];
}

function str(value: unknown, path: string, max = 200): string {
  if (typeof value !== 'string' || value.length > max) fail(path + ' must be a string of at most ' + max + ' characters');
  return value as string;
}

function optStr(value: unknown, path: string, max = 200): string | undefined {
  return value === undefined || value === null ? undefined : str(value, path, max);
}

function decimalText(value: unknown, path: string): string {
  if (typeof value !== 'string' || !DECIMAL_TEXT.test(value)) fail(path + ' must be a decimal number string');
  return value as string;
}

function optDecimalText(value: unknown, path: string): string | undefined {
  return value === undefined || value === null || value === '' ? undefined : decimalText(value, path);
}

function finite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path + ' must be a finite number');
  return value as number;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path + ' must be a boolean');
  return value as boolean;
}

/** Free text from the provider: control characters removed, whitespace collapsed, bounded. */
export function sanitizeText(value: string, max = 200): string {
  return value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export interface TdTimeSeries {
  meta: { symbol: string; interval: string; currency?: string; exchangeTimezone?: string; exchange?: string; micCode?: string; type?: string };
  values: Array<{ datetime: string; open: string; high: string; low: string; close: string; volume?: string }>;
}

export function parseTimeSeries(body: unknown, intraday: boolean): TdTimeSeries {
  const root = record(body, 'response');
  if (root.status !== undefined && root.status !== 'ok') fail('status must be "ok"');
  const meta = record(root.meta, 'meta');
  const values = array(root.values, 'values', 5000);
  return {
    meta: {
      symbol: str(meta.symbol, 'meta.symbol', 64),
      interval: str(meta.interval, 'meta.interval', 16),
      ...(meta.currency !== undefined ? { currency: str(meta.currency, 'meta.currency', 16) } : {}),
      ...(meta.exchange_timezone !== undefined ? { exchangeTimezone: str(meta.exchange_timezone, 'meta.exchange_timezone', 64) } : {}),
      ...(meta.exchange !== undefined ? { exchange: str(meta.exchange, 'meta.exchange', 64) } : {}),
      ...(meta.mic_code !== undefined ? { micCode: str(meta.mic_code, 'meta.mic_code', 16) } : {}),
      ...(meta.type !== undefined ? { type: str(meta.type, 'meta.type', 64) } : {}),
    },
    values: values.map((raw, i) => {
      const v = record(raw, 'values[' + i + ']');
      const datetime = str(v.datetime, 'values[' + i + '].datetime', 32);
      if (!(intraday ? INTRADAY_DATETIME : DATE).test(datetime)) fail('values[' + i + '].datetime has an unexpected format');
      const volume = optDecimalText(v.volume, 'values[' + i + '].volume');
      return {
        datetime,
        open: decimalText(v.open, 'values[' + i + '].open'),
        high: decimalText(v.high, 'values[' + i + '].high'),
        low: decimalText(v.low, 'values[' + i + '].low'),
        close: decimalText(v.close, 'values[' + i + '].close'),
        ...(volume !== undefined ? { volume } : {}),
      };
    }),
  };
}

export interface TdQuote {
  symbol: string;
  name?: string;
  micCode?: string;
  currency?: string;
  timestamp: number;
  lastQuoteAt?: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume?: string;
  previousClose?: string;
  isMarketOpen: boolean;
}

export function parseQuote(body: unknown): TdQuote {
  const q = record(body, 'response');
  if (q.status !== undefined && q.status !== 'ok') fail('status must be "ok"');
  const timestamp = finite(q.timestamp, 'timestamp');
  const lastQuoteAt = q.last_quote_at === undefined || q.last_quote_at === null ? undefined : finite(q.last_quote_at, 'last_quote_at');
  const volume = optDecimalText(q.volume, 'volume');
  const previousClose = optDecimalText(q.previous_close, 'previous_close');
  const name = optStr(q.name, 'name', 300);
  const micCode = optStr(q.mic_code, 'mic_code', 16);
  const currency = optStr(q.currency, 'currency', 16);
  return {
    symbol: str(q.symbol, 'symbol', 64),
    ...(name !== undefined ? { name: sanitizeText(name) } : {}),
    ...(micCode !== undefined ? { micCode } : {}),
    ...(currency !== undefined ? { currency } : {}),
    timestamp,
    ...(lastQuoteAt !== undefined ? { lastQuoteAt } : {}),
    open: decimalText(q.open, 'open'),
    high: decimalText(q.high, 'high'),
    low: decimalText(q.low, 'low'),
    close: decimalText(q.close, 'close'),
    ...(volume !== undefined ? { volume } : {}),
    ...(previousClose !== undefined ? { previousClose } : {}),
    isMarketOpen: bool(q.is_market_open, 'is_market_open'),
  };
}

export interface TdSymbol {
  symbol: string;
  instrumentName: string;
  exchange: string;
  micCode: string;
  exchangeTimezone: string;
  instrumentType: string;
  country: string;
  currency: string;
}

export function parseSymbolSearch(body: unknown): TdSymbol[] {
  const root = record(body, 'response');
  if (root.status !== undefined && root.status !== 'ok') fail('status must be "ok"');
  return array(root.data, 'data', 500).map((raw, i) => {
    const s = record(raw, 'data[' + i + ']');
    return {
      symbol: str(s.symbol, 'data[' + i + '].symbol', 64),
      instrumentName: sanitizeText(str(s.instrument_name, 'data[' + i + '].instrument_name', 300)),
      exchange: str(s.exchange, 'data[' + i + '].exchange', 64),
      micCode: str(s.mic_code, 'data[' + i + '].mic_code', 16),
      exchangeTimezone: str(s.exchange_timezone, 'data[' + i + '].exchange_timezone', 64),
      instrumentType: str(s.instrument_type, 'data[' + i + '].instrument_type', 64),
      country: str(s.country, 'data[' + i + '].country', 64),
      currency: str(s.currency, 'data[' + i + '].currency', 16),
    };
  });
}

export interface TdSplits {
  currency?: string;
  exchangeTimezone?: string;
  splits: Array<{ date: string; fromFactor: number; toFactor: number }>;
}

export function parseSplits(body: unknown): TdSplits {
  const root = record(body, 'response');
  const meta = root.meta === undefined ? {} : record(root.meta, 'meta');
  return {
    ...(meta.currency !== undefined ? { currency: str(meta.currency, 'meta.currency', 16) } : {}),
    ...(meta.exchange_timezone !== undefined ? { exchangeTimezone: str(meta.exchange_timezone, 'meta.exchange_timezone', 64) } : {}),
    splits: array(root.splits, 'splits', 1000).map((raw, i) => {
      const s = record(raw, 'splits[' + i + ']');
      const date = str(s.date, 'splits[' + i + '].date', 16);
      if (!DATE.test(date)) fail('splits[' + i + '].date must be YYYY-MM-DD');
      return { date, fromFactor: finite(s.from_factor, 'splits[' + i + '].from_factor'), toFactor: finite(s.to_factor, 'splits[' + i + '].to_factor') };
    }),
  };
}

export interface TdDividends {
  currency?: string;
  dividends: Array<{ exDate: string; amount: number }>;
}

export function parseDividends(body: unknown): TdDividends {
  const root = record(body, 'response');
  const meta = root.meta === undefined ? {} : record(root.meta, 'meta');
  return {
    ...(meta.currency !== undefined ? { currency: str(meta.currency, 'meta.currency', 16) } : {}),
    dividends: array(root.dividends, 'dividends', 2000).map((raw, i) => {
      const d = record(raw, 'dividends[' + i + ']');
      const exDate = str(d.ex_date, 'dividends[' + i + '].ex_date', 16);
      if (!DATE.test(exDate)) fail('dividends[' + i + '].ex_date must be YYYY-MM-DD');
      return { exDate, amount: finite(d.amount, 'dividends[' + i + '].amount') };
    }),
  };
}

/** Error body shape { code, message, status: "error" } (often delivered with HTTP 200). */
export function errorBody(body: unknown): { code: number | null; message: string } | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (b.status !== 'error') return null;
  return { code: typeof b.code === 'number' ? b.code : null, message: typeof b.message === 'string' ? b.message : '' };
}
