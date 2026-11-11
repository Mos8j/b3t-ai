/** Strips personal data from text before it reaches logs, errors or diagnostics. */
const RULES: [RegExp, string][] = [
  [/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN]'],
  [/\b(?:\d[ -]?){13,19}\b/g, '[CARD]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[EMAIL]'],
  [/(?<!\d)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g, '[PHONE]'],
];

export function redact(text: string): string {
  return RULES.reduce((t, [re, label]) => t.replace(re, label), text);
}

const SENSITIVE_KEY = /pass|secret|token|ssn|social|birth|dob|email|phone|address|name|resume|license|passport|card|account/i;

/** Deep-copies a value, replacing anything under a sensitive-looking key and redacting text in the rest. */
export function redactObject(value: unknown, key = ''): unknown {
  if (key && SENSITIVE_KEY.test(key) && value !== null && value !== undefined) return '[REDACTED]';
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(v => redactObject(v, key));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactObject(v, k)]));
  return value;
}
