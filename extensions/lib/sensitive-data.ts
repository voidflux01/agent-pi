// ABOUTME: Conservative redaction for persisted execution artifacts and prompts.
// ABOUTME: Hashes and verification decisions still use raw workspace bytes; only displayed/stored text is redacted.

const SECRET_PATTERNS = [
  /(sk-[A-Za-z0-9_-]{12,})/g,
  /(AKIA[0-9A-Z]{16})/g,
  /((?:token|secret|password|passwd|api[_-]?key)\s*[=:]\s*)([^\s,;]+)/gi,
  /(Bearer\s+)[A-Za-z0-9._~-]+/gi,
];

export function redactSensitive(value: string): string {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(new RegExp(pattern.source, pattern.flags), (match, prefix?: string) => prefix && prefix !== match ? `${prefix}[REDACTED]` : "[REDACTED]"), value);
}
