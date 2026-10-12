// The official SEC archive header for one filing (docs/HISTORICAL_FINANCIAL_SOURCE_ATTESTATION_V1.md §12–§16). The URL is built only from the validated mapped
// CIK and the selected accession, on the fixed Archives path. The header is parsed strictly, and it must agree with the selection on the accession, the exact
// form, the filing date and the CIK. The acceptance value is kept as raw text: it is not converted, and it is never a historical availability claim.

import { FinancialSourceAttestationError } from './source-attestation-errors.js';

export const SEC_ARCHIVE_HOST = 'www.sec.gov';
/** The explicit bound for one archive header (§13). The body is read as a bounded stream, and Content-Length only refuses early. */
export const SEC_ARCHIVE_MAX_BYTES = 2 * 1024 * 1024;

const CIK = /^\d{10}$/;
const ACCESSION = /^\d{10}-\d{2}-\d{6}$/;
const ACCEPTANCE_RAW = /^\d{14}$/;

export interface ArchiveHeader {
  readonly accession: string;
  /** The conformed submission type, exactly as the header states it. */
  readonly submissionType: string;
  /** The FILED AS OF DATE, converted from YYYYMMDD to YYYY-MM-DD. */
  readonly filedAsOfDate: string;
  /** Every CENTRAL INDEX KEY the header names, zero-padded to ten digits. */
  readonly centralIndexKeys: readonly string[];
  /** The ACCEPTANCE-DATETIME value as the archive carries it (14 digits), or null when the header has none. */
  readonly acceptanceRaw: string | null;
}

function refuse(message: string): never {
  throw new FinancialSourceAttestationError('SOURCE_ARTIFACT_MISMATCH', 'archive header: ' + message);
}

/** The fixed archive URL of one filing. The CIK is written without leading zeros and the accession without dashes, as the SEC path requires. */
export function secArchiveHeaderUrl(cik: string, accession: string): string {
  if (!CIK.test(cik)) throw new FinancialSourceAttestationError('SOURCE_ATTESTATION_INVALID', 'the CIK must be exactly ten digits');
  if (!ACCESSION.test(accession)) throw new FinancialSourceAttestationError('SOURCE_ATTESTATION_INVALID', 'the accession must be a valid accession number');
  return 'https://' + SEC_ARCHIVE_HOST + '/Archives/edgar/data/' + String(Number(cik)) + '/' + accession.replace(/-/g, '') + '/' + accession + '-index-headers.html';
}

function fieldOf(text: string, pattern: RegExp): string | null {
  const match = pattern.exec(text);
  return match === null ? null : (match[1] ?? '');
}

/** Parses the fields the attestation needs. Missing required fields and malformed values fail closed. Other header lines are not read. */
export function parseSecArchiveHeader(text: string): ArchiveHeader {
  const accession = fieldOf(text, /^ACCESSION NUMBER:\s*(\S+)\s*$/m);
  if (accession === null || !ACCESSION.test(accession)) refuse('ACCESSION NUMBER is missing or malformed');
  const submissionType = fieldOf(text, /^CONFORMED SUBMISSION TYPE:\s*(\S+)\s*$/m);
  if (submissionType === null || submissionType === '') refuse('CONFORMED SUBMISSION TYPE is missing');
  const filed = fieldOf(text, /^FILED AS OF DATE:\s*(\S+)\s*$/m);
  if (filed === null || !/^\d{8}$/.test(filed)) refuse('FILED AS OF DATE must be YYYYMMDD');
  const filedAsOfDate = filed.slice(0, 4) + '-' + filed.slice(4, 6) + '-' + filed.slice(6, 8);
  const back = new Date(Date.UTC(Number(filed.slice(0, 4)), Number(filed.slice(4, 6)) - 1, Number(filed.slice(6, 8))));
  if (back.getUTCDate() !== Number(filed.slice(6, 8)) || back.getUTCMonth() !== Number(filed.slice(4, 6)) - 1) refuse('FILED AS OF DATE is not a calendar date');
  const acceptanceLine = fieldOf(text, /^ACCEPTANCE-DATETIME:?\s*(.*?)\s*$/m);
  if (acceptanceLine !== null && acceptanceLine !== '' && !ACCEPTANCE_RAW.test(acceptanceLine)) refuse('ACCEPTANCE-DATETIME must be 14 digits');
  const acceptanceRaw = acceptanceLine === null || acceptanceLine === '' ? null : acceptanceLine;
  const centralIndexKeys = [...text.matchAll(/^\s*CENTRAL INDEX KEY:\s*(\S+)\s*$/gm)].map((m) => m[1] ?? '');
  if (centralIndexKeys.length === 0 || centralIndexKeys.some((key) => !CIK.test(key))) refuse('CENTRAL INDEX KEY must name at least one ten-digit filer');
  return { accession, submissionType, filedAsOfDate, centralIndexKeys, acceptanceRaw };
}

export interface ArchiveExpectation {
  readonly accession: string;
  readonly form: string;
  readonly filingDate: string;
  readonly cik: string;
}

/** The header must agree with the deterministic selection on every field. A header may name several filers; the mapped CIK must be one of them. */
export function checkArchiveHeader(header: ArchiveHeader, expected: ArchiveExpectation): void {
  if (header.accession !== expected.accession) refuse('the accession differs from the selected accession');
  if (header.submissionType !== expected.form) refuse('the submission type differs from the selected form');
  if (header.filedAsOfDate !== expected.filingDate) refuse('the filed date differs from the submissions filing date');
  if (!header.centralIndexKeys.includes(expected.cik)) refuse('the mapped CIK is not among the filers');
}
