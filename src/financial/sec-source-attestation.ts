// The SEC source attestor (docs/HISTORICAL_FINANCIAL_SOURCE_ATTESTATION_V1.md §9–§17, §25). It attests an existing verified SEC FinancialEvidence record. It
// re-fetches the official SEC submissions and companyfacts, reconstructs the fundamentals with the shared selection, and attests only when the reconstruction
// equals the stored canonical data. The accession, form, CIK and filing date come from that selection and the official submissions row. The caller supplies
// none of them. The attestation is a separate object: the evidence is never changed.

import { FinancialEvidenceIntegrityError, verifyFinancialEvidence, type FinancialEvidence } from './financial-evidence.js';
import type { SealedFinancialEvidence } from './financial-knowledge.js';
import { FinancialGatewayError } from './financial-types.js';
import { buildFinancialSourceAttestation, type FinancialSourceAttestation } from './financial-source-attestation.js';
import { SOURCE_POLICY_VERSION } from './historical-policy.js';
import type { InstrumentRegistry } from '../market-data/instrument-registry.js';
import type { ConnectionState } from './connector.js';
import { secUrlsOf, secUserAgentOf, SEC_CONNECTOR_ID, SEC_HOST, SEC_MAX_RESPONSE_BYTES, SEC_MIN_INTERVAL_MS, SEC_PROVIDER } from './sec-edgar-fundamentals.js';
import { checkArchiveHeader, parseSecArchiveHeader, secArchiveHeaderUrl, SEC_ARCHIVE_HOST, SEC_ARCHIVE_MAX_BYTES } from './sec-archive-header.js';
import { parseSecJson } from './sec-edgar-json.js';
import { companyFactsOf, selectFundamentals, submissionsOf } from './sec-fact-selection.js';
import { secTextOf } from './sec-transport.js';
import { FinancialSourceAttestationError } from './source-attestation-errors.js';
import type { FetchLike, ResilientCaller } from '../market-data/providers/resilience.js';
import { hashOf, sha256Hex } from '../persistence/canonical-json.js';

export interface SecSourceAttestorOptions {
  /** The declared contact. Undefined, or any value that fails secUserAgentOf, means not connected. */
  readonly userAgent?: string | undefined;
  readonly fetch: FetchLike;
  /** Must pace at least SEC_MIN_INTERVAL_MS between requests. Share it with the connector, so the process rate is one rate. */
  readonly caller: ResilientCaller;
  readonly clock: () => Date;
  /** The instrument mapping at the evidence's as-of. The CIK comes from here, never from the caller. */
  readonly instruments: InstrumentRegistry;
}

const CIK = /^\d{10}$/;

function invalid(message: string): never {
  throw new FinancialSourceAttestationError('SOURCE_ATTESTATION_INVALID', message);
}

function unsupported(message: string): never {
  throw new FinancialSourceAttestationError('SOURCE_ATTESTATION_UNSUPPORTED', message);
}

function semanticMismatch(message: string): never {
  throw new FinancialSourceAttestationError('SOURCE_SEMANTIC_MISMATCH', message);
}

function codeOfError(error: unknown): string {
  return (error as { code?: string }).code ?? (error instanceof Error ? error.message : 'UNEXPECTED');
}

export class SecSourceAttestor {
  private readonly userAgent: string | undefined;

  constructor(private readonly options: SecSourceAttestorOptions) {
    if (options.caller.policy.minIntervalMs < SEC_MIN_INTERVAL_MS) {
      throw new FinancialGatewayError('REGISTRATION_INVALID', 'the SEC attestor must pace at least ' + SEC_MIN_INTERVAL_MS + ' ms between requests');
    }
    this.userAgent = secUserAgentOf(options.userAgent);
  }

  connection(): ConnectionState {
    return this.userAgent === undefined ? 'not_connected' : 'connected';
  }

  /**
   * Attests one stored SEC fundamentals record. Every check that does not need the network runs first: the record, its seal, its scope, and the declared
   * contact. The network is used only after those pass, and the archive is fetched only after the reconstruction equals the stored data.
   */
  async attest(sealed: SealedFinancialEvidence): Promise<FinancialSourceAttestation> {
    let evidence: FinancialEvidence;
    try {
      evidence = verifyFinancialEvidence(sealed.evidence);
    } catch (error) {
      if (error instanceof FinancialEvidenceIntegrityError) invalid('the evidence record failed verification: ' + error.message);
      throw error;
    }
    if (hashOf(evidence) !== sealed.recordHash) invalid('the seal does not name the stored record');
    if (evidence.provider !== SEC_PROVIDER || evidence.connectorId !== SEC_CONNECTOR_ID || evidence.capability !== 'fundamentals') {
      unsupported('the evidence is not SEC EDGAR fundamentals: ' + evidence.provider + '/' + evidence.connectorId + '/' + evidence.capability);
    }
    if (evidence.instrumentId === null) invalid('the evidence names no instrument');
    if (this.userAgent === undefined) {
      throw new FinancialGatewayError('DATA_NOT_CONNECTED', SEC_CONNECTOR_ID + ' has no valid SEC_USER_AGENT; no request was made');
    }
    const request = evidence.request as { period: string; currency: string; asOf: string };
    const mapping = this.options.instruments.mappingAt(evidence.instrumentId, SEC_PROVIDER, request.asOf);
    if (!mapping) throw new FinancialGatewayError('INSTRUMENT_MAPPING_MISSING', 'no SEC CIK is mapped for this instrument at ' + request.asOf);
    const cik = mapping.providerSymbol;
    if (!CIK.test(cik)) throw new FinancialGatewayError('REQUEST_INVALID', 'the mapped SEC identifier must be exactly ten digits');

    const urls = secUrlsOf(cik);
    const submissionsText = await this.json(urls.submissions);
    const submissions = submissionsOf(parseSecJson(submissionsText), cik);
    const factsText = await this.json(urls.companyFacts);
    const facts = companyFactsOf(parseSecJson(factsText), cik);

    let selection: ReturnType<typeof selectFundamentals>;
    try {
      selection = selectFundamentals({ period: request.period, currency: request.currency, asOf: request.asOf }, submissions, facts);
    } catch (error) {
      semanticMismatch('the current SEC data no longer selects the stored record: ' + codeOfError(error));
    }
    if (hashOf(selection.candidate) !== hashOf(evidence.data)) {
      semanticMismatch('the current SEC representation does not reproduce the stored canonical data');
    }
    const filing = submissions.filings.find((f) => f.accession === selection.accession);
    if (!filing) semanticMismatch('the selected accession is not a filing in the current submissions');

    const selectedFactsHash = hashOf(
      selection.selectedFacts.map((fact) => ({
        taxonomy: fact.taxonomy,
        concept: fact.concept,
        unit: fact.unit,
        accession: fact.accession,
        start: fact.start,
        end: fact.end,
        val: fact.lexeme,
      })),
    );

    const headerText = await this.archive(secArchiveHeaderUrl(cik, selection.accession));
    const header = parseSecArchiveHeader(headerText);
    checkArchiveHeader(header, { accession: selection.accession, form: filing.form, filingDate: filing.filingDate, cik });

    return buildFinancialSourceAttestation({
      evidenceId: evidence.evidenceId,
      evidenceRecordHash: sealed.recordHash,
      evidenceContentHash: evidence.contentHash,
      provider: SEC_PROVIDER,
      connectorId: SEC_CONNECTOR_ID,
      capability: 'fundamentals',
      instrumentId: evidence.instrumentId,
      cik,
      sourceId: selection.accession,
      sourceForm: filing.form,
      sourceFilingDate: filing.filingDate,
      sourceAcceptanceRaw: header.acceptanceRaw,
      sourceArtifactHash: sha256Hex(headerText),
      selectedFactsHash,
      policyVersion: SOURCE_POLICY_VERSION,
    });
  }

  /** A paced GET of one SEC JSON document. Refusals keep the connector's error types, so the two paths report the same way. */
  private json(url: string): Promise<string> {
    return this.options.caller.call((signal) =>
      secTextOf({
        fetch: this.options.fetch,
        clock: this.options.clock,
        provider: SEC_PROVIDER,
        accept: 'application/json',
        userAgent: this.userAgent ?? '',
        url,
        signal,
        allowedHosts: [SEC_HOST],
        maxBytes: SEC_MAX_RESPONSE_BYTES,
        refuse: (kind, message) => {
          throw kind === 'host' ? new FinancialGatewayError('CONNECTOR_PAYLOAD_INVALID', 'SEC response: ' + message) : new FinancialGatewayError('SCHEMA_INVALID', 'SEC response: ' + message);
        },
      }),
    );
  }

  /** A paced GET of the filing's archive header. Any refusal is an artifact mismatch: the archive cannot support the record. */
  private archive(url: string): Promise<string> {
    return this.options.caller.call((signal) =>
      secTextOf({
        fetch: this.options.fetch,
        clock: this.options.clock,
        provider: SEC_PROVIDER,
        accept: 'text/html',
        userAgent: this.userAgent ?? '',
        url,
        signal,
        allowedHosts: [SEC_ARCHIVE_HOST],
        maxBytes: SEC_ARCHIVE_MAX_BYTES,
        refuse: (_kind, message) => {
          throw new FinancialSourceAttestationError('SOURCE_ARTIFACT_MISMATCH', 'archive header: ' + message);
        },
      }),
    );
  }
}
