// The one format rule for an eToro key (O20), shared by the runtime configuration and the transport. A key is printable ASCII
// with no space and no control character, 1 to ETORO_KEY_MAX_LENGTH characters long. Its exact format is not assumed beyond that:
// real user keys are longer than 256 characters. This function never trims or changes a value; trimming copy/paste whitespace is
// the configuration's job. A caller reports a refusal by variable name only, never with the value.

export const ETORO_KEY_MAX_LENGTH = 1024;

const ETORO_KEY_FORMAT = new RegExp('^[\\x21-\\x7e]{1,' + ETORO_KEY_MAX_LENGTH + '}$');

export function isValidEtoroKey(value: unknown): value is string {
  return typeof value === 'string' && ETORO_KEY_FORMAT.test(value);
}
