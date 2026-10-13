import { describe, expect, it } from 'vitest';
import { FinancialDataGateway, strongO1Eligible } from '../../src/financial/financial-gateway.js';
import { FinancialConnectorRegistry } from '../../src/financial/financial-registry.js';
import { verifyFinancialSourceAttestation } from '../../src/financial/financial-source-attestation.js';
import { MassiveNewsRestConnector } from '../../src/financial/massive-news-connector.js';
import { SecSourceAttestor } from '../../src/financial/sec-source-attestation.js';
import { EnvironmentSecretProvider } from '../../src/financial/secrets.js';
import { ResilientCaller, type FetchLike } from '../../src/market-data/providers/resilience.js';
import { sha256Hex } from '../../src/persistence/canonical-json.js';
import { change, UNREVIEWED } from './fixtures.js';
import { ARTICLE_A, MASSIVE_CONNECTOR, MASSIVE_PROVIDER, MASSIVE_SECRET, NEWS_REQUEST, PAGE, json, massiveInstruments, scriptedFetch } from './massive-fixtures.js';
import { bodyOf, newProbe, responseWith } from './http-body-fixtures.js';
import { archiveHeaderText, CIK_PADDED, FY_ACCEPTANCE, FY_ACCESSION, sealedWithoutDatabase, secFyEvidence } from './sec-attestation-fixtures.js';
import { ALL_FILINGS, baseConcepts, clock, companyFactsText, type Concepts, json200, secCaller, secHttp, secInstruments, submissionsText, TEST_USER_AGENT } from './sec-fixtures.js';

// docs/HISTORICAL_FINANCIAL_SOURCE_ATTESTATION_V1.md §9–§17, §25. The attestor re-fetches SEC data, reconstructs the fundamentals with the shared
// selection, and attests only when the reconstruction equals the stored record. It takes no accession, form, CIK or filing date from its caller. Every
// request goes to a fixed SEC URL. No test makes a network call: every answer is scripted.

interface Call {
  url: string;
  headers: Record<string, string>;
}

const SUBMISSIONS = () => json200(submissionsText(ALL_FILINGS));
const FACTS = () => json200(companyFactsText(baseConcepts()));
const ARCHIVE = (options: Parameters<typeof archiveHeaderText>[0] = {}) => ({ status: 200, body: archiveHeaderText(options) });

/** An attestor wired to scripted answers and the fixture mapping. Pass `fetch` to script a response the answer list cannot express. */
async function attestorWith(answers: Parameters<typeof secHttp>[0], options: { userAgent?: string | undefined; caller?: ResilientCaller; fetch?: FetchLike } = {}) {
  const http = options.fetch ? { fetch: options.fetch, calls: [] as Call[] } : secHttp(answers);
  const attestor = new SecSourceAttestor({
    userAgent: 'userAgent' in options ? options.userAgent : TEST_USER_AGENT,
    fetch: http.fetch,
    caller: options.caller ?? secCaller(),
    clock,
    instruments: await secInstruments(),
  });
  return { attestor, http };
}

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'UNEXPECTED';
  }
}

/** The fixture concepts with the FY2024 revenue fact's value replaced. Everything else stays the same. */
function revenueWith(val: string): Concepts {
  const first = (baseConcepts().RevenueFromContractWithCustomerExcludingAssessedTax as { USD: Record<string, unknown>[] }).USD[0]!;
  return { ...baseConcepts(), RevenueFromContractWithCustomerExcludingAssessedTax: { USD: [{ ...first, val }] } as unknown as Concepts[string] };
}

/** A genuine Massive news evidence record, built through the real connector and gateway from scripted answers. Used only for the unsupported-provider path. */
async function massiveEvidence() {
  const http = scriptedFetch([json(200, PAGE([ARTICLE_A]))]);
  const connector = new MassiveNewsRestConnector({
    secrets: new EnvironmentSecretProvider({ MASSIVE_API_KEY: MASSIVE_SECRET }),
    fetch: http.fetch,
    caller: new ResilientCaller(MASSIVE_PROVIDER, { timeoutMs: 1000, maxAttempts: 1 }, { now: () => 0, sleep: async () => undefined, random: () => 0.5 }),
    clock,
  });
  const registry = await FinancialConnectorRegistry.open();
  await registry.register({ connectorId: MASSIVE_CONNECTOR, provider: MASSIVE_PROVIDER, transport: 'rest', capabilities: ['news'], license: UNREVIEWED, mode: 'RESEARCH' }, change());
  await registry.enable(MASSIVE_CONNECTOR, change());
  const gateway = new FinancialDataGateway({ registry, instruments: await massiveInstruments(), connectors: [connector], clock });
  return (await gateway.fetchBatch(NEWS_REQUEST())).evidence[0]!;
}

describe('the attestation of the FY2024 evidence (brief 9–13)', () => {
  it('attests with the official accession, form, filing date, CIK, acceptance and archive hash', async () => {
    const evidence = await secFyEvidence();
    const sealed = sealedWithoutDatabase(evidence);
    const { attestor } = await attestorWith([SUBMISSIONS(), FACTS(), ARCHIVE()]);
    const attestation = await attestor.attest(sealed);
    expect(attestation).toMatchObject({
      provider: 'sec-edgar',
      connectorId: 'sec-edgar-fundamentals-rest',
      capability: 'fundamentals',
      cik: CIK_PADDED,
      sourceId: FY_ACCESSION,
      sourceForm: '10-K',
      sourceFilingDate: '2024-11-01',
      sourceAcceptanceRaw: FY_ACCEPTANCE,
      policyVersion: 'sec-filing-date-next-ny-day:v1',
    });
    expect(attestation.sourceArtifactHash).toBe(sha256Hex(archiveHeaderText()));
    expect(() =>
      verifyFinancialSourceAttestation(attestation, {
        evidenceId: evidence.evidenceId,
        evidenceRecordHash: sealed.recordHash,
        evidenceContentHash: evidence.contentHash,
        instrumentId: evidence.instrumentId,
      }),
    ).not.toThrow();
  });

  it('the evidence record is unchanged: no identity, provider time or O1 field moves', async () => {
    const evidence = await secFyEvidence();
    const before = JSON.stringify(evidence);
    const { attestor } = await attestorWith([SUBMISSIONS(), FACTS(), ARCHIVE()]);
    await attestor.attest(sealedWithoutDatabase(evidence));
    expect(JSON.stringify(evidence)).toBe(before);
    expect(evidence.providerPublishedAt).toBeNull();
    expect(evidence.effectiveAt).toBeNull();
  });

  it('a source-attested record stays not O1-eligible', async () => {
    const evidence = await secFyEvidence();
    const { attestor } = await attestorWith([SUBMISSIONS(), FACTS(), ARCHIVE()]);
    await attestor.attest(sealedWithoutDatabase(evidence));
    expect(strongO1Eligible(evidence, null)).toEqual({ eligible: false, reason: 'UNSEALED_EXTERNAL_EVIDENCE' });
  });

  it('every request goes to the fixed SEC URLs, in order, with the declared contact and no credential', async () => {
    const evidence = await secFyEvidence();
    const { attestor, http } = await attestorWith([SUBMISSIONS(), FACTS(), ARCHIVE()]);
    await attestor.attest(sealedWithoutDatabase(evidence));
    expect(http.calls.map((c) => c.url)).toEqual([
      'https://data.sec.gov/submissions/CIK0000320193.json',
      'https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json',
      'https://www.sec.gov/Archives/edgar/data/320193/000032019324000081/0000320193-24-000081-index-headers.html',
    ]);
    for (const call of http.calls) {
      expect(call.headers['User-Agent']).toBe(TEST_USER_AGENT);
      expect(Object.keys(call.headers).map((k) => k.toLowerCase())).not.toContain('authorization');
    }
  });
});

describe('the official archive must agree with the selection (brief 15)', () => {
  it('a wrong accession in the archive header is an artifact mismatch, and no attestation is produced', async () => {
    const evidence = await secFyEvidence();
    const { attestor } = await attestorWith([SUBMISSIONS(), FACTS(), ARCHIVE({ accession: '0000320193-24-000099' })]);
    expect(await codeOf(attestor.attest(sealedWithoutDatabase(evidence)))).toBe('SOURCE_ARTIFACT_MISMATCH');
  });

  it('a wrong CIK in the archive header is an artifact mismatch', async () => {
    const evidence = await secFyEvidence();
    const { attestor } = await attestorWith([SUBMISSIONS(), FACTS(), ARCHIVE({ ciks: ['0000320194'] })]);
    expect(await codeOf(attestor.attest(sealedWithoutDatabase(evidence)))).toBe('SOURCE_ARTIFACT_MISMATCH');
  });

  it('a wrong form in the archive header, an amendment, is an artifact mismatch', async () => {
    const evidence = await secFyEvidence();
    const { attestor } = await attestorWith([SUBMISSIONS(), FACTS(), ARCHIVE({ form: '10-K/A' })]);
    expect(await codeOf(attestor.attest(sealedWithoutDatabase(evidence)))).toBe('SOURCE_ARTIFACT_MISMATCH');
  });

  it('a wrong filing date in the archive header is an artifact mismatch', async () => {
    const evidence = await secFyEvidence();
    const { attestor } = await attestorWith([SUBMISSIONS(), FACTS(), ARCHIVE({ filed: '2024-11-02' })]);
    expect(await codeOf(attestor.attest(sealedWithoutDatabase(evidence)))).toBe('SOURCE_ARTIFACT_MISMATCH');
  });

  it('an archive response from another host is refused, and nothing is followed', async () => {
    const evidence = await secFyEvidence();
    const { attestor } = await attestorWith([SUBMISSIONS(), FACTS(), { status: 200, url: 'https://evil.example/archive.html', body: archiveHeaderText() }]);
    expect(await codeOf(attestor.attest(sealedWithoutDatabase(evidence)))).toBe('SOURCE_ARTIFACT_MISMATCH');
  });

  it('an archive header above 2 MiB is refused before its body is read', async () => {
    const evidence = await secFyEvidence();
    const probe = newProbe();
    const fetch: FetchLike = async (url) => {
      if (url.startsWith('https://www.sec.gov/')) {
        return responseWith({ headers: { 'content-length': String(2 * 1024 * 1024 + 1) }, body: bodyOf('', probe) });
      }
      const text = url.includes('companyfacts') ? companyFactsText(baseConcepts()) : submissionsText(ALL_FILINGS);
      return responseWith({ status: 200, body: bodyOf(text) });
    };
    const { attestor } = await attestorWith([], { fetch });
    expect(await codeOf(attestor.attest(sealedWithoutDatabase(evidence)))).toBe('SOURCE_ARTIFACT_MISMATCH');
    expect(probe.reads).toBe(0);
  });
});

describe('the reconstruction must equal the stored record (brief 12)', () => {
  it('a changed artifact gives a different attestation identity, so two observations never collapse into one', async () => {
    const evidence = await secFyEvidence();
    const first = await (await attestorWith([SUBMISSIONS(), FACTS(), ARCHIVE()])).attestor.attest(sealedWithoutDatabase(evidence));
    const changed = await (await attestorWith([SUBMISSIONS(), FACTS(), ARCHIVE({ acceptance: '20241101060131' })])).attestor.attest(sealedWithoutDatabase(evidence));
    expect(changed.sourceArtifactHash).not.toBe(first.sourceArtifactHash);
    expect(changed.attestationId).not.toBe(first.attestationId);
  });

  it('a current SEC representation that no longer reproduces the stored values is a semantic mismatch, and no attestation is produced', async () => {
    const evidence = await secFyEvidence();
    const drifted = json200(companyFactsText(revenueWith('391035000001')));
    const { attestor } = await attestorWith([SUBMISSIONS(), drifted, ARCHIVE()]);
    expect(await codeOf(attestor.attest(sealedWithoutDatabase(evidence)))).toBe('SOURCE_SEMANTIC_MISMATCH');
  });

  it('a different lexeme for the same selected value changes the selected-facts projection, and so the identity', async () => {
    const evidence = await secFyEvidence();
    const baseline = await (await attestorWith([SUBMISSIONS(), FACTS(), ARCHIVE()])).attestor.attest(sealedWithoutDatabase(evidence));
    // Same canonical value, different source text: the candidate is equal, but the projection of the exact text is not.
    const other = await (await attestorWith([SUBMISSIONS(), json200(companyFactsText(revenueWith('391035000000.0'))), ARCHIVE()])).attestor.attest(sealedWithoutDatabase(evidence));
    expect(other.attestationId).not.toBe(baseline.attestationId);
  });
});

describe('the caller supplies nothing that is a source claim (brief 10, 13)', () => {
  it('a supplied filing date, accession, form or CIK is ignored: the official values are used', async () => {
    const evidence = await secFyEvidence();
    const sealed = { ...sealedWithoutDatabase(evidence), sourceFilingDate: '2030-01-01', accession: '0000000000-00-000000', sourceForm: '10-Q', cik: '0000000001' };
    const { attestor } = await attestorWith([SUBMISSIONS(), FACTS(), ARCHIVE()]);
    const attestation = await attestor.attest(sealed as never);
    expect(attestation).toMatchObject({ sourceFilingDate: '2024-11-01', sourceId: FY_ACCESSION, sourceForm: '10-K', cik: CIK_PADDED });
  });

  it('a record that is not the stored record is refused before any SEC request', async () => {
    const evidence = await secFyEvidence();
    const sealed = { ...sealedWithoutDatabase(evidence), recordHash: '0'.repeat(64) };
    const { attestor, http } = await attestorWith([SUBMISSIONS(), FACTS(), ARCHIVE()]);
    expect(await codeOf(attestor.attest(sealed))).toBe('SOURCE_ATTESTATION_INVALID');
    expect(http.calls).toHaveLength(0);
  });
});

describe('scope, contact and pacing (brief 10, 41)', () => {
  it('a provider other than SEC is unsupported, before any SEC request', async () => {
    const evidence = await massiveEvidence();
    const { attestor, http } = await attestorWith([SUBMISSIONS(), FACTS(), ARCHIVE()]);
    expect(await codeOf(attestor.attest(sealedWithoutDatabase(evidence)))).toBe('SOURCE_ATTESTATION_UNSUPPORTED');
    expect(http.calls).toHaveLength(0);
  });

  it('without a valid contact the attestor is not connected, and makes no request', async () => {
    const evidence = await secFyEvidence();
    for (const userAgent of [undefined, 'NEXUS']) {
      const { attestor, http } = await attestorWith([SUBMISSIONS(), FACTS(), ARCHIVE()], { userAgent });
      expect(attestor.connection()).toBe('not_connected');
      expect(await codeOf(attestor.attest(sealedWithoutDatabase(evidence)))).toBe('DATA_NOT_CONNECTED');
      expect(http.calls).toHaveLength(0);
    }
  });

  it('a caller that paces faster than 125 ms is refused at construction', async () => {
    await expect(attestorWith([], { caller: new ResilientCaller('sec-edgar', { minIntervalMs: 0 }) })).rejects.toBeDefined();
    await expect(attestorWith([], { caller: new ResilientCaller('sec-edgar', { minIntervalMs: 124 }) })).rejects.toBeDefined();
  });
});
