// Storage-side redaction. Provider prompts can still use the original text.
// This keeps canonical logs safe to persist by default.

const PRIVATE_BLOCK_RE = /<private>[\s\S]*?<\/private>/gi;

// Very lightweight credential-ish patterns. Intentionally conservative.
const OPENAI_KEY_RE = /\bsk-[A-Za-z0-9]{20,}\b/g;
const GOOGLE_KEY_RE = /\bAIza[0-9A-Za-z_-]{20,}\b/g;

export function redactForStorage(input: string): string {
  let out = input;

  // Remove sensitive spans marked by the user.
  out = out.replace(PRIVATE_BLOCK_RE, "<private>[REDACTED]</private>");

  // Opportunistic key redaction.
  out = out.replace(OPENAI_KEY_RE, "sk-[REDACTED]");
  out = out.replace(GOOGLE_KEY_RE, "AIza[REDACTED]");

  return out;
}

