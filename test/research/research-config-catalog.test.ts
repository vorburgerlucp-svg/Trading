// R1 configuration, catalog, final-bar filter and status (unit).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MarketBar } from '../../src/market-data/market-data-types.js';
import type { MarketDataProvider } from '../../src/market-data/market-data-provider.js';
import { FinalBarsOnlyProvider } from '../../src/research/final-bars-provider.js';
import { parseResearchCatalog, researchCatalogFingerprint, RESEARCH_CATALOG_MAX_INSTRUMENTS } from '../../src/research/research-catalog.js';
import { forbiddenVariablesIn, loadResearchConfig, researchDatabaseOf, ResearchConfigError } from '../../src/research/research-config.js';
import { exitCodeOf, summaryOf } from '../../src/research/research-main.js';
import { summarizeRuns } from '../../src/research/research-status.js';
import type { ResearchRunRecord } from '../../src/research/research-run-log.js';
import { AAPL_ENTRY, BTC_ENTRY, catalogOf } from './research-fixtures.js';

const URL_OK = 'postgres://nexus_research_app:pw-secret-123@localhost:5432/nexus_research';
const BASE = { NEXUS_RESEARCH_DATABASE_URL: URL_OK, TWELVE_DATA_API_KEY: 'td-key-secret-456', NEXUS_RESEARCH_CATALOG_FILE: 'catalog.json' };

function refusal(env: Record<string, string>): ResearchConfigError {
  try {
    loadResearchConfig(env);
  } catch (error) {
    if (error instanceof ResearchConfigError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('R1 configuration: fail closed', () => {
  it('a complete research environment loads with the documented defaults; no clearance means none', () => {
    const config = loadResearchConfig(BASE);
    expect(config).toMatchObject({ database: { name: 'nexus_research', user: 'nexus_research_app' }, dataClearance: null, budget: { dailyCredits: 400, minuteCredits: 6 }, maxRunMs: 240_000, minFreeMemoryMb: 2048, maxCatchUpMs: 24 * 3_600_000 });
  });

  it('refuses to start with any broker, trading, operator or production variable, naming only the variables', () => {
    for (const name of ['ETORO_API_KEY', 'ETORO_USER_KEY', 'ETORO_DEMO_EXECUTION_ENABLED', 'NEXUS_BROKER_ACCESS_KEY', 'NEXUS_OPERATOR_TOKEN', 'TRADING_MODE', 'ALLOW_LIVE_TRADING', 'DATABASE_URL', 'NEXUS_TWELVE_DATA_DEMO']) {
      const error = refusal({ ...BASE, [name]: 'value-must-not-appear-777' });
      expect(error.code, name).toBe('RESEARCH_FORBIDDEN_VARIABLE');
      expect(error.message).toContain(name);
      expect(error.message).not.toContain('value-must-not-appear-777');
    }
    expect(forbiddenVariablesIn({ ETORO_ENABLED: '' })).toEqual([]); // empty means unset
  });

  it('connects only to nexus_research as a nexus_research role (never the productive database or its roles)', () => {
    expect(researchDatabaseOf(URL_OK)).toEqual({ name: 'nexus_research', user: 'nexus_research_app', host: 'localhost' });
    expect(researchDatabaseOf('postgres://nexus_research_app:x@localhost/nexus_research_restore1')).toMatchObject({ name: 'nexus_research_restore1' });
    for (const url of [
      'postgres://nexus_research_app:x@localhost/nexus',
      'postgres://nexus_app:x@localhost/nexus_research',
      'postgres://postgres:x@localhost/nexus_research',
      'postgres://nexus_readonly:x@localhost/nexus_research',
      'postgres://nexus_research_app:x@localhost/nexus_researchx',
      'postgres://nexus_research_app:x@localhost/nexus_research?options=-c%20search_path%3Dother',
      'mysql://nexus_research_app:x@localhost/nexus_research',
      'not a url',
    ]) {
      expect(() => researchDatabaseOf(url), url).toThrow(ResearchConfigError);
    }
    expect(refusal({ ...BASE, NEXUS_RESEARCH_DATABASE_URL: 'postgres://nexus_app:pw-secret-123@localhost/nexus' }).message).not.toContain('pw-secret-123');
  });

  it('limits: never above the Twelve Data Basic plan; malformed numbers and the demo key are refused', () => {
    expect(loadResearchConfig({ ...BASE, NEXUS_RESEARCH_DAILY_CREDIT_LIMIT: '800', NEXUS_RESEARCH_MINUTE_CREDIT_LIMIT: '8' }).budget).toEqual({ dailyCredits: 800, minuteCredits: 8 });
    expect(refusal({ ...BASE, NEXUS_RESEARCH_DAILY_CREDIT_LIMIT: '801' }).code).toBe('RESEARCH_CONFIG_INVALID');
    expect(refusal({ ...BASE, NEXUS_RESEARCH_MINUTE_CREDIT_LIMIT: '9' }).code).toBe('RESEARCH_CONFIG_INVALID');
    expect(refusal({ ...BASE, NEXUS_RESEARCH_MAX_RUN_SECONDS: '601' }).code).toBe('RESEARCH_CONFIG_INVALID');
    expect(refusal({ ...BASE, NEXUS_RESEARCH_MIN_FREE_MEMORY_MB: '100' }).code).toBe('RESEARCH_CONFIG_INVALID');
    expect(refusal({ ...BASE, NEXUS_RESEARCH_DAILY_CREDIT_LIMIT: '1e3' }).code).toBe('RESEARCH_CONFIG_INVALID');
    expect(refusal({ ...BASE, TWELVE_DATA_API_KEY: 'demo' }).code).toBe('RESEARCH_CONFIG_INVALID');
    expect(refusal({ ...BASE, NEXUS_RESEARCH_DATA_CLEARANCE: 'short' }).code).toBe('RESEARCH_CONFIG_INVALID');
    expect(loadResearchConfig({ ...BASE, NEXUS_RESEARCH_DATA_CLEARANCE: 'TD terms 2026-01-01 reviewed by owner 2026-10-30' }).dataClearance).toBe('TD terms 2026-01-01 reviewed by owner 2026-10-30');
  });
});

describe('R1 catalog', () => {
  it('the shipped example catalog is valid', () => {
    const catalog = parseResearchCatalog(readFileSync(join(__dirname, '..', '..', 'ops', 'research', 'research-catalog.example.json'), 'utf8'));
    expect(catalog.instruments).toHaveLength(6);
  });

  it('refuses unknown fields, wrong interval or version, duplicates, too many instruments and inconsistent calendars', () => {
    const base = { version: 'research-catalog:v1', catalogId: 'c', interval: '15m', instruments: [AAPL_ENTRY] };
    const bad = [
      { ...base, extra: 1 },
      { ...base, interval: '5m' },
      { ...base, version: 'research-catalog:v2' },
      { ...base, instruments: [] },
      { ...base, instruments: [AAPL_ENTRY, AAPL_ENTRY] },
      { ...base, instruments: [AAPL_ENTRY, { ...AAPL_ENTRY, instrumentId: 'rsx_other' }] },
      { ...base, instruments: Array.from({ length: RESEARCH_CATALOG_MAX_INSTRUMENTS + 1 }, (_, i) => ({ ...BTC_ENTRY, instrumentId: 'rsx_c' + i, providerSymbol: 'C' + i + '/USD' })) },
      { ...base, instruments: [{ ...BTC_ENTRY, tradingCalendar: 'XNAS' }] },
      { ...base, instruments: [{ ...AAPL_ENTRY, mic: undefined }] },
      { ...base, instruments: [{ ...AAPL_ENTRY, instrumentId: 'ins_aapl' }] },
      { ...base, instruments: [{ ...AAPL_ENTRY, tradingCalendar: 'NOPE' }] },
      { ...base, instruments: [{ ...AAPL_ENTRY, orderType: 'market' }] },
    ];
    for (const catalog of bad) expect(() => parseResearchCatalog(JSON.stringify(catalog)), JSON.stringify(catalog).slice(0, 120)).toThrow();
    expect(() => parseResearchCatalog('{')).toThrow(/JSON/);
  });

  it('the fingerprint identifies the catalog content', () => {
    expect(researchCatalogFingerprint(catalogOf([AAPL_ENTRY]))).toBe(researchCatalogFingerprint(catalogOf([AAPL_ENTRY])));
    expect(researchCatalogFingerprint(catalogOf([AAPL_ENTRY]))).not.toBe(researchCatalogFingerprint(catalogOf([AAPL_ENTRY, BTC_ENTRY])));
  });
});

describe('R1 final bars only', () => {
  const bar = (startTime: string, isFinal: boolean, vintage: 'contemporaneous' | 'historical_reconstruction'): MarketBar =>
    ({ startTime, isFinal, knowledge: { knownAt: '2026-10-07T15:31:00.000Z', knowledgeSource: 'captured_by_nexus', vintage, vintagePolicy: 'bar-vintage:v1' } }) as unknown as MarketBar;
  const inner = (bars: MarketBar[]): MarketDataProvider =>
    ({ providerId: 'twelvedata', getHistoricalBars: async () => ({ source: {} as never, bars, requests: 1 }), health: () => ({ provider: 'twelvedata', state: 'closed', consecutiveFailures: 0 }) }) as unknown as MarketDataProvider;

  it('an in-progress bar is dropped and counted; final bars pass with their vintage', async () => {
    const provider = new FinalBarsOnlyProvider(inner([bar('a', true, 'historical_reconstruction'), bar('b', true, 'contemporaneous'), bar('c', false, 'contemporaneous')]));
    const out = await provider.getHistoricalBars({} as never);
    expect(out.bars.map((b) => b.startTime)).toEqual(['a', 'b']);
    expect(provider.last).toEqual({ finalBars: 2, droppedInProgress: 1, requests: 1, contemporaneous: 1, historicalReconstruction: 1 });
  });

  it('quotes, searches and instrument lookups are refused', async () => {
    const provider = new FinalBarsOnlyProvider(inner([]));
    await expect(provider.getQuote()).rejects.toThrow(/not part of R1/);
    await expect(provider.searchInstruments()).rejects.toThrow();
    await expect(provider.getInstrument()).rejects.toThrow();
  });
});

describe('R1 status and exit codes', () => {
  const S = 'research-run:v1' as const;
  it('summarizes runs, skips, abandoned and unfinished runs, and the credits of the UTC day', () => {
    const records: ResearchRunRecord[] = [
      { schema: S, kind: 'run_started', runId: 'a', at: '2026-10-07T15:00:00.000Z', codeVersion: 'unversioned', catalogId: 'c', catalogFingerprint: 'f', configFingerprint: 'g', dataClearance: 'x'.repeat(8) },
      { schema: S, kind: 'credit_reserved', runId: 'a', at: '2026-10-07T15:00:01.000Z', credits: 1, endpoint: '/time_series' },
      { schema: S, kind: 'run_finished', runId: 'a', at: '2026-10-07T15:00:05.000Z', status: 'completed', instruments: [], creditsUsed: 1 },
      { schema: S, kind: 'run_skipped', runId: 'b', at: '2026-10-07T15:15:00.000Z', reason: 'LOCK_HELD' },
      { schema: S, kind: 'run_started', runId: 'c', at: '2026-10-07T15:30:00.000Z', codeVersion: 'unversioned', catalogId: 'c', catalogFingerprint: 'f', configFingerprint: 'g', dataClearance: null },
      { schema: S, kind: 'credit_reserved', runId: 'c', at: '2026-10-07T15:30:01.000Z', credits: 1, endpoint: '/time_series' },
    ];
    const status = summarizeRuns(records, Date.parse('2026-10-07T15:30:30.000Z'), { dailyCredits: 400, minuteCredits: 6 });
    expect(status).toMatchObject({ lastRun: { runId: 'c', status: 'unfinished', creditsUsed: null }, runsLast24h: { completed: 1 }, skippedLast24h: { LOCK_HELD: 1 }, unfinished: ['c'], credits: { today: 2, lastMinute: 1 } });
  });

  it('exit codes: 0 normal or another worker running, 2 needs attention, 1 failure; the summary carries no secret', () => {
    expect(exitCodeOf({ kind: 'skipped', runId: 'r', reason: 'LOCK_HELD' })).toBe(0);
    expect(exitCodeOf({ kind: 'skipped', runId: 'r', reason: 'LOW_MEMORY' })).toBe(2);
    const finished = (status: 'completed' | 'failed' | 'license_not_cleared') => ({ kind: 'finished' as const, runId: 'r', status, instruments: [], creditsUsed: 0, abandonedRuns: [] });
    expect(exitCodeOf(finished('completed'))).toBe(0);
    expect(exitCodeOf(finished('license_not_cleared'))).toBe(2);
    expect(exitCodeOf(finished('failed'))).toBe(1);
    expect(JSON.stringify(summaryOf(finished('completed')))).not.toMatch(/key|password|postgres:/i);
  });
});

describe('R1 operations drafts', () => {
  const ops = (file: string) => readFileSync(join(__dirname, '..', '..', 'ops', 'research', file), 'utf8');

  it('the Windows task is a disabled draft: one instance, bounded run time, below-normal priority, no wake, no catch-up burst', () => {
    const xml = ops('nexus-research-task.draft.xml');
    expect(xml.match(/<Enabled>(\w+)<\/Enabled>/g)).toEqual(['<Enabled>false</Enabled>', '<Enabled>false</Enabled>']);
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
    expect(xml).toContain('<ExecutionTimeLimit>PT6M</ExecutionTimeLimit>');
    expect(xml).toContain('<Priority>7</Priority>');
    expect(xml).toContain('<WakeToRun>false</WakeToRun>');
    expect(xml).toContain('<StartWhenAvailable>false</StartWhenAvailable>');
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
  });

  it('the wrapper bounds the heap and never builds, migrates or pulls code', () => {
    const ps = ops('run-research.ps1');
    expect(ps).toContain('--max-old-space-size=512');
    expect(ps).toContain("PriorityClass = 'BelowNormal'");
    expect(ps).not.toMatch(/npm run|research-migrate|git pull|git checkout|schtasks/);
  });

  it('the environment example sets no forbidden variable and no clearance', () => {
    const env = Object.fromEntries(
      ops('env.research.example')
        .split(/\r?\n/)
        .filter((l) => /^[A-Z_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
    expect(forbiddenVariablesIn(env)).toEqual([]);
    expect(env.NEXUS_RESEARCH_DATA_CLEARANCE).toBeUndefined();
  });
});
