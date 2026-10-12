// Shared fixtures for the historical source attestation tests (docs/HISTORICAL_FINANCIAL_SOURCE_ATTESTATION_V1.md). No network. The archive header is a small,
// sanitised copy of the structure an official SEC index-headers page shows: the same field names, tab separators, a 14-digit acceptance value, and a
// filer block. Nothing here is a live filing.

import { hashOf } from '../../src/persistence/canonical-json.js';
import type { FinancialEvidence } from '../../src/financial/financial-evidence.js';
import type { SealedFinancialEvidence } from '../../src/financial/financial-knowledge.js';
import { FILINGS, FUNDAMENTALS_REQUEST, secGateway, standardAnswers } from './sec-fixtures.js';

export const CIK_PADDED = '0000320193';
export const FY_ACCESSION = FILINGS.fy2024.accession;
export const FY_FILING_DATE = FILINGS.fy2024.filingDate;
/** The acceptance value as the archive carries it: 14 digits, YYYYMMDDHHMMSS. Its time zone is not converted anywhere (§16). */
export const FY_ACCEPTANCE = '20241101060130';

export interface ArchiveHeaderOptions {
  readonly accession?: string;
  readonly form?: string;
  /** YYYY-MM-DD. Written as YYYYMMDD, as the archive writes it. */
  readonly filed?: string;
  readonly acceptance?: string | null;
  readonly ciks?: readonly string[];
}

/** A small archive header in the shape the official index-headers page uses. */
export function archiveHeaderText(options: ArchiveHeaderOptions = {}): string {
  const accession = options.accession ?? FY_ACCESSION;
  const form = options.form ?? '10-K';
  const filed = (options.filed ?? FY_FILING_DATE).replace(/-/g, '');
  const acceptance = options.acceptance === undefined ? FY_ACCEPTANCE : options.acceptance;
  const ciks = options.ciks ?? [CIK_PADDED];
  const lines = [
    '<SEC-HEADER>',
    'ACCESSION NUMBER:\t\t' + accession,
    'CONFORMED SUBMISSION TYPE:\t' + form,
    'PUBLIC DOCUMENT COUNT:\t\t1',
    'CONFORMED PERIOD OF REPORT:\t20240928',
    'FILED AS OF DATE:\t\t' + filed,
    'DATE AS OF CHANGE:\t\t' + filed,
    ...(acceptance === null ? [] : ['ACCEPTANCE-DATETIME\t' + acceptance]),
    'FILER:',
    ...ciks.flatMap((cik) => ['\tCOMPANY DATA:', '\t\tCOMPANY CONFORMED NAME:\t\tFixture Co', '\t\tCENTRAL INDEX KEY:\t\t\t' + cik]),
    '</SEC-HEADER>',
    '',
  ];
  return lines.join('\n');
}

/** A sealed record as a store returns it, without the database: the record, its hash, its semantic hash, and no seal. */
export function sealedWithoutDatabase(evidence: FinancialEvidence): SealedFinancialEvidence {
  return { evidence, recordHash: hashOf(evidence), semanticHash: evidence.evidenceId.slice(3), seal: null };
}

/** One verified SEC FY2024 evidence record, built by the real connector and gateway from fixture HTTP answers. */
export async function secFyEvidence(): Promise<FinancialEvidence> {
  const { gateway } = await secGateway(standardAnswers());
  return gateway.fetch(FUNDAMENTALS_REQUEST());
}
