// Identity regression for the bounded streaming migration (docs/BOUNDED_STREAMING_HTTP_TRANSPORT_V1.md §14, §16, §28). The pinned values were captured from the
// transport before the migration (fa6e27e), with a fixed clock. The migration is transport-only, so every value must be reproduced exactly, whether the bytes
// arrive whole, in chunks, or from a native Response. No network call is made.

import { expect, it } from 'vitest';
import { FinancialConnectorRegistry } from '../../src/financial/financial-registry.js';
import { FinancialDataGateway } from '../../src/financial/financial-gateway.js';
import { MassiveNewsRestConnector } from '../../src/financial/massive-news-connector.js';
import { RestFinancialConnector } from '../../src/financial/rest-transport.js';
import { SecSourceAttestor } from '../../src/financial/sec-source-attestation.js';
import { ResilientCaller, type FetchLike, type HttpResponseLike } from '../../src/market-data/providers/resilience.js';
import { archiveHeaderText, sealedWithoutDatabase, secFyEvidence } from './sec-attestation-fixtures.js';
import { bodyOf, chunksOf, responseWith } from './http-body-fixtures.js';
import { AAPL_ID, change, FUNDAMENTALS_RAW, instrumentRegistry, PROVIDER, RESEARCH_ONLY, T0 } from './fixtures.js';
import { ARTICLE_A, ARTICLE_B, MASSIVE_PROVIDER, MASSIVE_SECRET, NEWS_REQUEST, PAGE, json, massiveInstruments, scriptedFetch } from './massive-fixtures.js';
import { ALL_FILINGS, baseConcepts, clock, companyFactsText, CLOCK_ISO, FUNDAMENTALS_REQUEST, json200, secCaller, secGateway, secHttp, secInstruments, submissionsText, TEST_USER_AGENT } from './sec-fixtures.js';

const PINNED = {
  "sec": {
    "evidenceId": "fe_8e0e670e044c39a362d2a5fab4f82c5de161f73a55732c6986b914541113fd88",
    "rawPayloadHash": "dc9803be35e2710ea3f31330d38fae609696169359f9f1cef379133b1f8d1004",
    "contentHash": "203a9c57606fe9d36dc9e1503f216b36a1d26c4d6678ff2db8d3a7015b803f3e",
    "queryFingerprint": "38768df8371fb45f22af806f5ca7660111c9e35cbc58df8eff9b249038a47b6d"
  },
  "attestation": {
    "attestationId": "fsa_ea312665e8c579dfa4a7a55b8e8ac73e7a4a386fa1e4a856f5c198bc11edf228",
    "attestationHash": "e35340d206d9e994c184dfe71324eec6050855a8610f9b7422603c09a6084179",
    "sourceArtifactHash": "19f5323f8fd0b10fba863909c1512a08886f59be80273af2f737b385406b003b",
    "selectedFactsHash": "b4823776d49640be4d5b6bf26aa7ebf4e06d7d5d87ad2f808bf33ea2af71a0c8"
  },
  "massive": [
    {
      "evidenceId": "fe_137920193cc3a4b48f78bd4dfeae2d5bf619120bf6d43ea2bfa2a37d7ef81819",
      "rawPayloadHash": "3da021a6d9d6100cc77815d5164db268da4c4968a4a576a4f5e233cf51340a06",
      "contentHash": "6531d148e4259e9e68aa16cf7eb4edfbbbe8a9fb43ef5daaf550dbb1ad40aa35"
    },
    {
      "evidenceId": "fe_566560eafd4491b37eeac74016bb48568a1532ef7fc3bc05b1f9a269d8c57c9a",
      "rawPayloadHash": "69f693c45363def782c29a4690b417ecb7e0ed7d26e50a499bc749b6bf912089",
      "contentHash": "acd7a13e904ed0f8ed07a88572689281b6097687d982848ce10649f1bde227e4"
    }
  ],
  "rest": {
    "evidenceId": "fe_fe273ad12ab7900737eba7b91f23d0069be5e3edbb3451c2a671f41f362100c4",
    "rawPayloadHash": "42f7b4a9db92a4f37bfe15fafdcf81a7214e851b8305f6d10144a150c51e146a",
    "contentHash": "6197f88cfd3c7e03263e4accde27b95d22e7d0b8b255b3f53e9c56f73cda869e"
  }
};

const FIXED = () => new Date(CLOCK_ISO);
const enc = new TextEncoder();
const SUBMISSIONS = submissionsText(ALL_FILINGS);
const FACTS = companyFactsText(baseConcepts());

async function secAttestation() {
  const http = secHttp([json200(SUBMISSIONS), json200(FACTS), { status: 200, body: archiveHeaderText() }]);
  const sealed = sealedWithoutDatabase(await secFyEvidence());
  return new SecSourceAttestor({ userAgent: TEST_USER_AGENT, fetch: http.fetch, caller: secCaller(), clock, instruments: await secInstruments() }).attest(sealed);
}

async function massiveBatch(fetchFn: FetchLike) {
  const connector = new MassiveNewsRestConnector({
    secrets: { get: (ref: string) => (ref === 'massive-api-key' ? MASSIVE_SECRET : undefined) },
    fetch: fetchFn,
    caller: new ResilientCaller(MASSIVE_PROVIDER, { timeoutMs: 1000, maxAttempts: 1 }, { now: () => 0, sleep: async () => undefined, random: () => 0.5 }),
    clock: FIXED,
  });
  const registry = await FinancialConnectorRegistry.open();
  await registry.register({ connectorId: 'massive-news-rest', provider: MASSIVE_PROVIDER, transport: 'rest', capabilities: ['news'], license: { status: 'unreviewed', redistribution: 'unknown' }, mode: 'RESEARCH' }, change());
  await registry.enable('massive-news-rest', change());
  const gateway = new FinancialDataGateway({ registry, instruments: await massiveInstruments(), connectors: [connector], clock: FIXED });
  return (await gateway.fetchBatch(NEWS_REQUEST())).evidence;
}

async function restEvidence() {
  const connector = new RestFinancialConnector({
    connectorId: 'rest-1',
    provider: PROVIDER,
    baseUrl: 'https://api.example.invalid',
    credentialRef: 'rest-fixture-key',
    secrets: { get: (ref: string) => (ref === 'rest-fixture-key' ? 'sentinel-fixed' : undefined) },
    fetch: async (): Promise<HttpResponseLike> => responseWith({ status: 200, body: bodyOf(JSON.stringify(FUNDAMENTALS_RAW)) }),
    caller: new ResilientCaller(PROVIDER, { timeoutMs: 50, maxAttempts: 1 }, { now: () => 0, sleep: async () => undefined, random: () => 0.5 }),
    endpoints: { fundamentals: () => ({ path: '/v1/fundamentals', query: { symbol: 'AAPL' } }) },
    map: (_c: string, raw: unknown) => ({ candidate: raw, providerSymbol: 'AAPL' }),
    clock: FIXED,
    maxResponseBytes: 1024 * 1024,
  });
  const registry = await FinancialConnectorRegistry.open();
  await registry.register({ connectorId: 'rest-1', provider: PROVIDER, transport: 'rest', capabilities: ['fundamentals'], license: RESEARCH_ONLY, mode: 'RESEARCH' }, change());
  await registry.enable('rest-1', change());
  const gateway = new FinancialDataGateway({ registry, instruments: await instrumentRegistry(), connectors: [connector], clock: FIXED });
  return gateway.fetch({ requestId: 'r-rest', capability: 'fundamentals', connectorId: 'rest-1', asOf: T0, environment: 'research', instrumentId: AAPL_ID, currency: 'USD', period: '2025-Q4' });
}

const secIdentity = (e: { evidenceId: string; rawPayloadHash: string; contentHash: string; queryFingerprint: string }) => ({ evidenceId: e.evidenceId, rawPayloadHash: e.rawPayloadHash, contentHash: e.contentHash, queryFingerprint: e.queryFingerprint });
const massiveIdentity = (batch: ReadonlyArray<{ evidenceId: string; rawPayloadHash: string; contentHash: string }>) => batch.map((e) => ({ evidenceId: e.evidenceId, rawPayloadHash: e.rawPayloadHash, contentHash: e.contentHash }));

it('the SEC FY2024 evidence is reproduced exactly from whole bodies', async () => {
  expect(secIdentity(await secFyEvidence())).toEqual(PINNED.sec);
});

it('the SEC FY2024 evidence is reproduced exactly when the bodies arrive in small chunks', async () => {
  const fetch: FetchLike = async (url) => responseWith({ status: 200, body: bodyOf(chunksOf(url.includes('companyfacts') ? FACTS : SUBMISSIONS, 7)) });
  const { gateway } = await secGateway([], { fetch });
  expect(secIdentity(await gateway.fetch(FUNDAMENTALS_REQUEST()))).toEqual(PINNED.sec);
});

it('the SEC FY2024 evidence is reproduced exactly from native Response bodies', async () => {
  const fetch: FetchLike = async (url) => new Response(enc.encode(url.includes('companyfacts') ? FACTS : SUBMISSIONS)) as unknown as HttpResponseLike;
  const { gateway } = await secGateway([], { fetch });
  expect(secIdentity(await gateway.fetch(FUNDAMENTALS_REQUEST()))).toEqual(PINNED.sec);
});

it('the SEC source attestation is reproduced exactly', async () => {
  const a = await secAttestation();
  expect({ attestationId: a.attestationId, attestationHash: a.attestationHash, sourceArtifactHash: a.sourceArtifactHash, selectedFactsHash: a.selectedFactsHash }).toEqual(PINNED.attestation);
});

it('the Massive evidence is reproduced exactly from whole bodies', async () => {
  expect(massiveIdentity(await massiveBatch(scriptedFetch([json(200, PAGE([ARTICLE_A, ARTICLE_B]))]).fetch))).toEqual(PINNED.massive);
});

it('the Massive evidence is reproduced exactly when the body arrives in small chunks', async () => {
  const text = JSON.stringify(PAGE([ARTICLE_A, ARTICLE_B]));
  expect(massiveIdentity(await massiveBatch(async () => responseWith({ status: 200, body: bodyOf(chunksOf(text, 11)) })))).toEqual(PINNED.massive);
});

it('the generic REST evidence is reproduced exactly', async () => {
  const e = await restEvidence();
  expect({ evidenceId: e.evidenceId, rawPayloadHash: e.rawPayloadHash, contentHash: e.contentHash }).toEqual(PINNED.rest);
});
