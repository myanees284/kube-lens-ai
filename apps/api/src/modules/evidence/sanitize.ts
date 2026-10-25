const replacements: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted]"],
  [/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [redacted]"],
  [/\b((?:password|passwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*)(\S+)/gi, "$1[redacted]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]"],
];

export function sanitizeText(value: string): string {
  let sanitized = value;
  for (const [pattern, replacement] of replacements) {
    sanitized = sanitized.replace(pattern, replacement);
  }
  return sanitized;
}

export function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? (error.message.split("\n")[0] ?? "request failed") : "request failed";
  const sanitized = sanitizeText(raw).replace(/\s+/g, " ").trim();
  return (sanitized || "request failed").slice(0, 300);
}
