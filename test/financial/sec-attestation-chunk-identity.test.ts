// Chunk identity of the SEC source attestation (docs/BOUNDED_STREAMING_TRANSPORT_V2.md §13). The attestation reads three SEC bodies: the submissions, the
// companyfacts and the archive header. The same bytes, delivered as whole bodies, as tiny chunks or as irregular chunks that cross the 64 KiB blocks and the
// UTF-8 sequences, must produce exactly the same attestation. The archive carries a multibyte filler after its header, so it spans more than two blocks.
// No network. The attestation semantics are not changed here: only the delivery of the bytes varies.

import { expect, it } from 'vitest';
import { SecSourceAttestor } from '../../src/financial/sec-source-attestation.js';
import { sha256Hex } from '../../src/persistence/canonical-json.js';
import type { FetchLike } from '../../src/market-data/providers/resilience.js';
import { bodyOf, responseWith } from './http-body-fixtures.js';
import { archiveHeaderText, sealedWithoutDatabase, secFyEvidence } from './sec-attestation-fixtures.js';
import { ALL_FILINGS, baseConcepts, clock, companyFactsText, secCaller, secInstruments, submissionsText, TEST_USER_AGENT } from './sec-fixtures.js';

const enc = new TextEncoder();
const SUBMISSIONS = submissionsText(ALL_FILINGS);
const FACTS = companyFactsText(baseConcepts());
/** Multibyte filler after the real header: about 160 KB, so the archive crosses two 64 KiB blocks and carries three- and four-byte sequences. */
const FILLER = Array.from({ length: 4_000 }, (_, i) => 'Ünïcode € 😀 filler line ' + i + '\n').join('');
const ARCHIVE = archiveHeaderText() + FILLER;

/** Splits the bytes into chunks of the given sizes, cycling through them. */
function chunked(bytes: Uint8Array, sizes: readonly number[]): Uint8Array[] {
  const parts: Uint8Array[] = [];
  for (let at = 0, i = 0; at < bytes.byteLength; i++) {
    const size = sizes[i % sizes.length]!;
    parts.push(bytes.slice(at, at + size));
    at += size;
  }
  return parts;
}

const WHOLE = (bytes: Uint8Array) => [bytes];
const TINY = (bytes: Uint8Array) => chunked(bytes, [1, 2, 3, 4, 5, 6, 7]);
const IRREGULAR = (bytes: Uint8Array) => chunked(bytes, [1, 5, 13, 64, 1_024, 3, 16_384, 65_535, 65_537]);

/** Builds the attestation of the fixture record, with each SEC body delivered by the given chunker. */
async function attestWith(chunker: (bytes: Uint8Array) => Uint8Array[]) {
  const fetch: FetchLike = async (url) => {
    const text = url.includes('companyfacts') ? FACTS : url.includes('/Archives/') ? ARCHIVE : SUBMISSIONS;
    return responseWith({ status: 200, body: bodyOf(chunker(enc.encode(text))) });
  };
  const sealed = sealedWithoutDatabase(await secFyEvidence());
  return new SecSourceAttestor({ userAgent: TEST_USER_AGENT, fetch, caller: secCaller(), clock, instruments: await secInstruments() }).attest(sealed);
}

const identityOf = (a: { sourceArtifactHash: string; selectedFactsHash: string; attestationId: string; attestationHash: string }) => ({
  sourceArtifactHash: a.sourceArtifactHash,
  selectedFactsHash: a.selectedFactsHash,
  attestationId: a.attestationId,
  attestationHash: a.attestationHash,
});

it('the archive exercises the boundaries: it is larger than two 64 KiB blocks and holds multibyte text', () => {
  expect(enc.encode(ARCHIVE).byteLength).toBeGreaterThan(2 * 65_536);
  expect(ARCHIVE).toMatch(/[^\x00-\x7f]/);
});

it('the SEC source attestation is identical for whole, tiny and irregular chunks, including chunks that cross the 64 KiB blocks and UTF-8 sequences', async () => {
  const whole = identityOf(await attestWith(WHOLE));
  expect(whole.sourceArtifactHash).toBe(sha256Hex(ARCHIVE));
  expect(identityOf(await attestWith(TINY))).toEqual(whole);
  expect(identityOf(await attestWith(IRREGULAR))).toEqual(whole);
});
