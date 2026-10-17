/**
 * Is this safe to share? A scan for what should not leave the machine.
 *
 * Two levels. A secret (a private key, an API token, a password, a JWT, a URL with
 * credentials in it) lets whoever reads the link act as you, so every surface stops
 * and asks before it shares one. Personal details (an email address, a public IP, a
 * home directory that names your account) only identify you, so they are pointed out
 * and nothing stops.
 *
 * The page, the API, the CLI and MCP all run this same scan, so they agree. It is a
 * warning, never a guarantee: a clean scan does not prove a file is safe, and every
 * match comes back masked, so the warning itself never repeats a secret.
 */

export type SensitiveLevel = "secret" | "personal";

export type SensitiveFinding = {
  level: SensitiveLevel;
  /** What was found, as a phrase: "an OpenAI API key". */
  label: string;
  /** The first line it is on, from 1. */
  line: number;
  /** How many times it occurs. */
  count: number;
  /** The first match, masked when it is a secret. */
  sample: string;
};

export type SensitiveReport = {
  /** The worst level found, or null when nothing was. */
  level: SensitiveLevel | null;
  findings: SensitiveFinding[];
};

type Rule = {
  level: SensitiveLevel;
  label: string;
  pattern: RegExp;
  /** The part of the match to report; the whole match when omitted. */
  group?: number;
  /** A second look at a match the pattern alone cannot judge. */
  keep?: (value: string) => boolean;
};

// Words that sit where a secret would but are not one: placeholders, booleans,
// variable references and the redactions tools already applied.
const PLACEHOLDER = /^(?:x+|\*+|\.+|-+|<.*>|\[.*\]|\{.*\}|\$.*|%.*%|changeme|password|secret|token|redacted|hidden|masked|null|none|nil|undefined|true|false|yes|no|present|missing|set|unset|example.*|sample.*|dummy.*|test.*|your[_-].*|my[_-].*|todo|tbd)$/i;

const PRIVATE_IP = /^(?:0|10|127)\.|^169\.254\.|^172\.(?:1[6-9]|2\d|3[01])\.|^192\.168\.|^255\./;
const DOCUMENTATION_IP = /^(?:192\.0\.2|198\.51\.100|203\.0\.113)\./;
const GENERIC_ACCOUNT = /^(?:user|username|users|runner|ubuntu|debian|admin|you|me|name|your[-_]?name|yourname|someone|example|shared|public|default|guest|vagrant|node|app|www|\$\w+|%\w+%|<.*>|\{.*\}|\*)$/i;
const EXAMPLE_EMAIL = /@(?:example\.(?:com|org|net)|[\w.-]+\.(?:test|example|invalid|localhost))$|^(?:no-?reply|do-?not-?reply|git|noreply\+?.*)@|@users\.noreply\.github\.com$/i;

const RULES: Rule[] = [
  { level: "secret", label: "a private key", pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g },
  { level: "secret", label: "an Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { level: "secret", label: "an OpenAI API key", pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, keep: (v) => !v.startsWith("sk-ant-") && /\d/.test(v) },
  { level: "secret", label: "an AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { level: "secret", label: "a GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g },
  { level: "secret", label: "a GitLab token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { level: "secret", label: "an npm token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { level: "secret", label: "a Stripe secret key", pattern: /\b[rs]k_live_[A-Za-z0-9]{20,}/g },
  { level: "secret", label: "a Slack token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { level: "secret", label: "a Slack webhook", pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/g },
  { level: "secret", label: "a Discord webhook", pattern: /https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{20,}/g },
  { level: "secret", label: "a Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { level: "secret", label: "a SendGrid key", pattern: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g },
  { level: "secret", label: "a Twilio key", pattern: /\bSK[0-9a-f]{32}\b/g },
  { level: "secret", label: "a JSON Web Token", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  {
    level: "secret",
    label: "a password in a URL",
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/?#@"'<>]+:([^\s/?#@"'<>]+)@[\w.-]+/gi,
    group: 0,
    keep: (v) => !PLACEHOLDER.test(v.match(/:\/\/[^:]+:([^@]+)@/)?.[1] ?? ""),
  },
  {
    // NAME=value, "name": "value", name: value, where the name says it is a secret.
    level: "secret",
    label: "a password or key in a setting",
    pattern: /["']?\b([A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|passwd|pwd|api[_-]?key|apikey|private[_-]?key|access[_-]?key|auth[_-]?key|client[_-]?secret|credentials?)[A-Za-z0-9_.-]*)["']?\s*[:=]\s*["']?([A-Za-z0-9_\-+/=.~!@#%^&*]{8,})/gi,
    group: 2,
    keep: (v) => !PLACEHOLDER.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v) && !/^\d+(?:\.\d+)*$/.test(v),
  },
  {
    level: "personal",
    label: "an email address",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g,
    keep: (v) => !EXAMPLE_EMAIL.test(v),
  },
  {
    level: "personal",
    label: "a public IP address",
    pattern: /(?<![\w.])(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?![\w.])/g,
    keep: (v) => !PRIVATE_IP.test(v) && !DOCUMENTATION_IP.test(v),
  },
  {
    level: "personal",
    label: "a home directory with your account name",
    pattern: /(?:\/home\/|\/Users\/|[A-Za-z]:\\Users\\)([A-Za-z0-9._-]+)/g,
    group: 1,
    keep: (v) => !GENERIC_ACCOUNT.test(v),
  },
];

/** The start and end of a secret, enough to recognise it and not enough to use it. */
function mask(value: string): string {
  if (value.length <= 8) return "•".repeat(value.length);
  return `${value.slice(0, 4)}…${value.slice(-2)}`;
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = source.indexOf("\n"); i !== -1 && i < index; i = source.indexOf("\n", i + 1)) line++;
  return line;
}

export function scanSensitive(source: string): SensitiveReport {
  const findings: SensitiveFinding[] = [];
  // Text one rule reported as a secret is not reported again by a looser rule, nor as
  // the email address a password-in-a-URL looks like.
  const claimed: [number, number][] = [];
  const overlaps = (start: number, end: number) => claimed.some(([a, b]) => start < b && end > a);
  for (const rule of RULES) {
    let first: { index: number; value: string } | null = null;
    const seen = new Set<string>();
    for (const match of source.matchAll(rule.pattern)) {
      const value = match[rule.group ?? 0] ?? match[0];
      const start = match.index!;
      const end = start + match[0].length;
      if (rule.keep && !rule.keep(value)) continue;
      if (overlaps(start, end)) continue;
      if (rule.level === "secret") claimed.push([start, end]);
      seen.add(value);
      first ??= { index: start, value };
    }
    if (!first) continue;
    findings.push({
      level: rule.level,
      label: rule.label,
      line: lineOf(source, first.index),
      count: seen.size,
      sample: rule.level === "secret" ? mask(first.value) : first.value,
    });
  }
  const level = findings.some((f) => f.level === "secret") ? "secret" : findings.length ? "personal" : null;
  return { level, findings };
}

/** One line per finding, for a terminal or a tool result. */
export function describeSensitive(report: SensitiveReport): string[] {
  return report.findings.map((f) =>
    `${f.level === "secret" ? "secret" : "personal"}: ${f.label} on line ${f.line}${f.count > 1 ? ` (${f.count} different)` : ""}: ${f.sample}`,
  );
}
