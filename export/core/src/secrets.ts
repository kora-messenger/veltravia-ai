import { containsSecretShapedContent } from '@veltravia/project-core';

/**
 * Content scanner for the export.
 *
 * It answers one question per file: "does this look like it holds a credential?"
 * and returns only a KIND (a fixed label), never the matched text, never an
 * offset into the file. The result is safe to log and to show to the user.
 *
 * It is a heuristic and says so wherever it is reported: it reduces the chance
 * of shipping a key, it cannot prove a file is clean.
 *
 * Layers:
 *  1. The shared project-engine detector (whole-value shapes).
 *  2. Line-aware token shapes for many providers, so a key in the middle of a
 *     source file is found (the shared patterns are anchored and miss those).
 *  3. Assignments of a long literal to a secret-looking name.
 */

interface Rule {
  readonly kind: string;
  readonly pattern: RegExp;
}

const TOKEN_RULES: readonly Rule[] = [
  { kind: 'private key block', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/ },
  { kind: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { kind: 'GitHub token', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { kind: 'OpenRouter key', pattern: /\bsk-or-[A-Za-z0-9_-]{16,}/ },
  { kind: 'Groq key', pattern: /\bgsk_[A-Za-z0-9]{20,}/ },
  { kind: 'Anthropic key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/ },
  // Generic `sk-` last among the sk- shapes, so the specific labels above win.
  { kind: 'OpenAI-style key', pattern: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}/ },
  { kind: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{30,}/ },
  { kind: 'AWS access key id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: 'Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  {
    kind: 'Slack webhook',
    pattern: /hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]+/,
  },
  { kind: 'Stripe key', pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/ },
  { kind: 'Twilio key', pattern: /\bSK[0-9a-f]{32}\b/ },
  { kind: 'npm token', pattern: /\bnpm_[A-Za-z0-9]{30,}/ },
  { kind: 'SendGrid key', pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/ },
  { kind: 'bearer token', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/ },
  {
    kind: 'JSON web token',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
  // scheme://user:password@host - a password inside a connection string.
  {
    kind: 'password in a URL',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:[^\s@'"/]{3,}@[^\s'"]+/i,
  },
];

/**
 * `name = "literal"` / `name: 'literal'` / `NAME=literal` where the name says
 * secret and the value is a long unbroken literal. Placeholders and obvious
 * references (env lookups, templates, empty values) are not findings.
 */
const SECRET_NAME =
  '(?:api[_-]?key|apikey|secret|client[_-]?secret|access[_-]?token|auth[_-]?token|refresh[_-]?token|private[_-]?key|password|passwd|pwd|token)';
const ASSIGNMENT = new RegExp(
  `(?:^|[^A-Za-z0-9])[A-Za-z0-9_.-]*${SECRET_NAME}[A-Za-z0-9_.-]*["']?\\s*[:=]\\s*["']?([^\\s"'\`,;)}]{12,})`,
  'i',
);

const PLACEHOLDER =
  /^(?:your[_-]|<|\$\{|\{\{|%|xxx|\*{3,}|changeme|example|placeholder|replace|todo|dummy|test[_-]?(?:key|token|secret)?$|process\.env|import\.meta|os\.environ|env\[|getenv|secret(?:s)?\.|config\.|settings\.|args\.|params\.|this\.|self\.|options\.)/i;

/** Names whose values are references or types, not literals. */
function looksLikeReference(value: string): boolean {
  if (PLACEHOLDER.test(value)) return true;
  // a function call, member access chain or type annotation, not a literal
  if (/[()[\]]/.test(value) && !/^[A-Za-z0-9+/=_-]{20,}$/.test(value)) return true;
  // all one repeated character, or only lowercase words joined by separators
  if (/^(.)\1+$/.test(value)) return true;
  if (/^[a-z]+(?:[_-][a-z]+)+$/.test(value)) return true;
  return false;
}

/** Entropy-ish check: a real key mixes character classes. */
function looksRandom(value: string): boolean {
  if (value.length < 16) return false;
  const classes =
    Number(/[a-z]/.test(value)) +
    Number(/[A-Z]/.test(value)) +
    Number(/[0-9]/.test(value)) +
    Number(/[^A-Za-z0-9]/.test(value));
  return classes >= 2;
}

export interface SecretFinding {
  /** A fixed label such as "GitHub token". Never the matched text. */
  readonly kind: string;
}

/** Scan one file's text. Returns the first finding's kind, or null. */
export function scanForSecrets(text: string): SecretFinding | null {
  for (const rule of TOKEN_RULES) {
    if (rule.pattern.test(text)) return { kind: rule.kind };
  }
  for (const line of text.split('\n')) {
    // Very long lines (minified bundles) are scanned in slices so a pathological
    // line cannot make the regexes slow.
    const slices = line.length > 4000 ? sliceLine(line) : [line];
    for (const slice of slices) {
      const match = ASSIGNMENT.exec(slice);
      if (match !== null) {
        const value = match[1] ?? '';
        if (!looksLikeReference(value) && looksRandom(value)) {
          return { kind: 'secret-looking assignment' };
        }
      }
    }
  }
  if (containsSecretShapedContent(text)) return { kind: 'credential-shaped value' };
  // The shared detector anchors some shapes to a whole value; check per line too.
  for (const line of text.split('\n')) {
    if (line.length > 4000) continue;
    if (containsSecretShapedContent(line.trim())) return { kind: 'credential-shaped value' };
  }
  return null;
}

function sliceLine(line: string): string[] {
  const out: string[] = [];
  for (let index = 0; index < line.length; index += 3000) {
    out.push(line.slice(index, index + 3500));
  }
  return out;
}
