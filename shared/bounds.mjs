// Generic output-size bounding for shared rig helpers.
//
// Captured child output (stderr/stdout tails folded into a thrown error, see
// #560) can be arbitrarily large. Retaining it unbounded reintroduces the V8
// per-string ceiling (~512MB) that #554/#555 fixed for the fixture matrix, this
// time on the failure path. These helpers cap any retained string so the failure
// payload stays human-readable and orders of magnitude below that ceiling.

// Per-string ceiling for any retained text field. Matches the fixture-matrix
// bound (#555) so failure tails are consistent across the rigs.
export const MAX_RETAINED_STRING_LENGTH = 2048;

const TRUNCATION_NOTICE = '…[truncated]';

// Truncate a single string to `max` characters, appending a visible notice so a
// consumer can tell the value was clipped. Non-strings pass through untouched.
export function truncateString(value, max = MAX_RETAINED_STRING_LENGTH) {
  if (typeof value !== 'string' || value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}${TRUNCATION_NOTICE}`;
}
