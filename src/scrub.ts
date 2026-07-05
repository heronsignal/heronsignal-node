// Client-side scrubbing mirrors the server's default-on redaction: values under
// sensitive-looking keys are replaced before they ever leave the process. The
// server scrubs again, but scrubbing here means secrets are never sent at all.

// Keep this regex in sync with @heronsignal/web and the mobile SDKs so
// redaction behaves identically everywhere. Short tokens (otp/pin/pwd/ssn)
// require a word boundary so keys like "shipping" are not redacted.
const SENSITIVE_KEY =
  /(access[_-]?token|api[_-]?key|auth|authorization|bearer|card|client[_-]?secret|cookie|credit|csrf|cvv|jwt|passwd|password|private[_-]?key|refresh[_-]?token|secret|session|set[_-]?cookie|token|xsrf|(^|[_-])(otp|pin|pwd|ssn)([_-]|$))/i;

const MAX_ENTRIES = 40;
const MAX_STRING = 1024;
const MAX_DEPTH = 4;

export function scrubAttributes(
  attributes: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!attributes) {
    return undefined;
  }

  return scrubObject(attributes, 0);
}

function scrubObject(
  value: Record<string, unknown>,
  depth: number,
): Record<string, unknown> {
  const entries = Object.entries(value).slice(0, MAX_ENTRIES);
  const out: Record<string, unknown> = {};

  for (const [key, entry] of entries) {
    out[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : scrubValue(entry, depth);
  }

  return out;
}

function scrubValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    return value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value;
  }

  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) {
      return "[nested]";
    }
    return value.slice(0, 20).map((item) => scrubValue(item, depth + 1));
  }

  if (value && typeof value === "object") {
    if (depth >= MAX_DEPTH) {
      return "[nested]";
    }
    return scrubObject(value as Record<string, unknown>, depth + 1);
  }

  return value;
}
