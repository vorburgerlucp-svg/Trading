// External content (news, web pages, social media, company pages) is untrusted input.
//
// The real protection is architectural, not this scanner:
//  - external text never becomes part of model instructions; it travels in a separate, quoted
//    `untrusted` field of the request
//  - models only return a parsed, validated opinion schema; free text cannot trigger anything
//  - risk limits, capital figures, live lock and approvals are owned by deterministic code and
//    frozen configuration; nothing in a model response or document can change them
//  - models have no tools, no broker access and no secrets
//
// The scanner below is a tripwire: it quarantines obviously manipulative text, records it for the
// audit trail, and forces human review of the decision. It is heuristic and can be evaded, which is
// why it is never the only line of defense.

export interface InjectionFlag {
  rule: string;
  excerpt: string;
}

const RULES: readonly { rule: string; pattern: RegExp }[] = [
  { rule: 'override_instructions', pattern: /\b(ignore|disregard|forget|override)\b.{0,40}\b(instruction|instructions|rules|prompt|guidelines|policy|policies)\b/i },
  { rule: 'disable_controls', pattern: /\b(ignore|disable|bypass|skip|override|turn off)\b.{0,30}\b(risk|limit|limits|safety|lock|engine|approval|guard)\b/i },
  { rule: 'role_hijack', pattern: /\b(you are now|act as|new instructions|system prompt|developer mode)\b/i },
  { rule: 'secret_request', pattern: /\b(api[ _-]?key|secret|password|credential|token|private key)\b/i },
  { rule: 'privilege_request', pattern: /\b(grant|give|enable)\b.{0,30}\b(access|permission|permissions|live trading|broker)\b/i },
  { rule: 'imperative_trade', pattern: /\b(buy|sell|transfer|withdraw)\b.{0,20}\b(now|immediately|everything|all funds|all capital)\b/i },
  { rule: 'shouted_trade_command', pattern: /\b(AND|THEN) (BUY|SELL)\b/ },
  // German phrasings (the scanner is a tripwire, never the primary boundary).
  { rule: 'override_instructions_de', pattern: /(ignorier\w*|missacht\w*|vergiss|übergeh\w*).{0,40}(regeln|anweisung\w*|vorgaben|richtlinien|instruktion\w*)/i },
  { rule: 'disable_controls_de', pattern: /(ignorier\w*|deaktivier\w*|umgeh\w*|abschalt\w*).{0,30}(risiko\w*|limit\w*|sperre\w*|freigabe\w*|sicherheit\w*|engine)/i },
  { rule: 'approval_command_de', pattern: /(genehmig\w*|gib\w* frei|freigeben).{0,30}(trade|kauf|order|transaktion)/i },
];

export function scanForInjection(text: string): InjectionFlag[] {
  const flags: InjectionFlag[] = [];
  for (const { rule, pattern } of RULES) {
    const match = pattern.exec(text);
    if (match) flags.push({ rule, excerpt: match[0].slice(0, 120) });
  }
  return flags;
}

/** External text as it is handed to a model: quoted data, possibly quarantined. */
export interface UntrustedBlock {
  evidenceId: string;
  source: string;
  text: string;
  quarantined: boolean;
  flags: InjectionFlag[];
}

export const QUARANTINE_NOTICE = '[QUARANTINED: content withheld because it contains instruction-like text; see audit trail]';

export function toUntrustedBlock(evidenceId: string, source: string, text: string): UntrustedBlock {
  const flags = scanForInjection(text);
  return { evidenceId, source, text: flags.length > 0 ? QUARANTINE_NOTICE : text, quarantined: flags.length > 0, flags };
}
