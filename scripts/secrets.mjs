// Secret detection and redaction shared by the data builder (which strips
// secret-looking fragments from external article text before writing the
// snapshot) and by `check-data-secrets.mjs` (which refuses to commit a
// snapshot that still contains one).
//
// Article text comes from other people's tutorials and code samples, so what
// gets caught here is almost never our secret. It still must not be
// committed: GitHub's secret scanning flags it, and the site would republish
// someone else's leaked credential.

export const REDACTED_SECRET = "[REDACTED_SECRET]";
export const REDACTED_PRIVATE_KEY = "[REDACTED_PRIVATE_KEY]";

/**
 * Strong, self-identifying token formats. Each entry is replaced wholesale.
 * Keep the shapes in sync with what GitHub secret scanning reports for this
 * repository; the names double as the report labels of the checker.
 */
export const STRONG_SECRET_PATTERNS = [
  { name: "private-key-block", pattern: /-----BEGIN [^-]{0,80}PRIVATE KEY-----[\s\S]*?-----END [^-]{0,80}PRIVATE KEY-----/g, replacement: REDACTED_PRIVATE_KEY },
  { name: "private-key-header", pattern: /-----(?:BEGIN|END) (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g, replacement: REDACTED_PRIVATE_KEY },
  { name: "age-secret-key", pattern: /\bAGE-SECRET-KEY-1[A-Z0-9]{58}\b/g },
  { name: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[0-9A-Z]{16}\b/g },
  { name: "alibaba-access-key-id", pattern: /\bLTAI[A-Za-z0-9]{20}\b/g },
  { name: "azure-storage-account-key", pattern: /\bAccountKey=[A-Za-z0-9+/]{86}==/g },
  { name: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { name: "gitlab-token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b|\bglptt-[a-f0-9]{40}\b|\bGR1348941[A-Za-z0-9_-]{20,}\b/g },
  { name: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: "pypi-token", pattern: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}\b/g },
  { name: "openai-key", pattern: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}\b|\bsk-[A-Za-z0-9]{20,}T3BlbkFJ[A-Za-z0-9]{20,}\b|\bsk-[A-Za-z0-9]{32,}\b/g },
  { name: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: "hugging-face-token", pattern: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { name: "slack-token", pattern: /\bxox[abposer]-[A-Za-z0-9-]{10,}\b/g },
  { name: "slack-webhook", pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]{20,}/g },
  { name: "discord-bot-token", pattern: /\b[MN][A-Za-z0-9]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/g },
  { name: "discord-webhook", pattern: /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]{60,}/g },
  { name: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "google-oauth-client-secret", pattern: /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/g },
  { name: "telegram-bot-token", pattern: /\b[0-9]{6,10}:[A-Za-z0-9_-]{35,}\b/g },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: "stripe-key", pattern: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
  { name: "sendgrid-key", pattern: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g },
  { name: "twilio-key", pattern: /\bSK[0-9a-f]{32}\b/g },
  { name: "mailgun-key", pattern: /\bkey-[a-f0-9]{32}\b/g },
  { name: "mailchimp-key", pattern: /\b[a-f0-9]{32}-us[0-9]{1,2}\b/g },
  { name: "hashicorp-vault-token", pattern: /\b(?:hvs|hvb|hvr)\.[A-Za-z0-9_-]{24,}\b|\bs\.[A-Za-z0-9]{24}\b/g },
  { name: "docker-swarm-join-token", pattern: /\bSWMTKN-1-[a-z0-9]{40,}-[a-z0-9]{20,}\b/g },
  { name: "digitalocean-token", pattern: /\bdo[opr]_v1_[a-f0-9]{64}\b/g },
  { name: "databricks-token", pattern: /\bdapi[a-f0-9]{32}\b/g },
  { name: "shopify-token", pattern: /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/g },
  { name: "linear-api-key", pattern: /\blin_api_[A-Za-z0-9]{40}\b/g },
  { name: "postman-api-key", pattern: /\bPMAK-[a-f0-9]{24}-[a-f0-9]{34}\b/g },
  { name: "grafana-token", pattern: /\bglc_[A-Za-z0-9+/=]{32,}\b|\bglsa_[A-Za-z0-9]{32}_[a-f0-9]{8}\b/g },
  { name: "yandex-cloud-token", pattern: /\bAQVN[A-Za-z0-9_-]{35,}\b|\by0_[A-Za-z0-9_-]{50,}\b|\bt1\.[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{30,}\b/g }
];

/**
 * Context patterns: a value is only a secret because of what precedes it
 * (a URL user:password, an Authorization header, a token query parameter, an
 * assignment to a variable called password/secret/token/...). The prefix is
 * kept and only the value is replaced.
 */
export const CONTEXT_SECRET_PATTERNS = [
  { name: "url-credentials", pattern: /(https?:\/\/[^/\s:@"'<>]+:)(?!\[REDACTED_)([^@\s"'<>]+)(@)/gi, replacement: `$1${REDACTED_SECRET}$3` },
  { name: "auth-header", pattern: /(\bAuthorization\s*[:=]\s*["']?(?:Bearer|Basic)\s+)(?!\[REDACTED_)[A-Za-z0-9._~+/=-]{8,}/gi, replacement: `$1${REDACTED_SECRET}` },
  { name: "sensitive-query", pattern: /([?&](?:access_token|refresh_token|token|api_key|apikey|key|signature|x-amz-signature|x-amz-credential|awsaccesskeyid)=)(?!\[REDACTED_)[^&#\s"'<>]{8,}/gi, replacement: `$1${REDACTED_SECRET}` },
  { name: "sensitive-assignment", pattern: /(\b(?:password|passwd|pwd|secret|token|api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|jwt[_-]?secret|private[_-]?key)\b\s*[:=]\s*["'`]?)(?!\[REDACTED_)([^"'`\s<>&;,\\]{8,})/gi, replacement: `$1${REDACTED_SECRET}` }
];

/** Replace every secret-looking fragment in a string. */
export function redactSensitiveContent(value) {
  if (typeof value !== "string" || value.length === 0) return value || "";
  let out = value;
  for (const { pattern, replacement } of STRONG_SECRET_PATTERNS) {
    out = out.replace(pattern, replacement || REDACTED_SECRET);
  }
  for (const { pattern, replacement } of CONTEXT_SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Strong-pattern matches in a text, for the pre-commit check. Context
 * patterns are not reported: they are a precaution in the builder, and
 * their prefixes appear legitimately in prose about configuration.
 *
 * @returns {Array<{name: string, index: number, match: string}>}
 */
export function findSensitivePatterns(text, { limit = 25 } = {}) {
  const findings = [];
  if (typeof text !== "string" || !text) return findings;
  for (const { name, pattern } of STRONG_SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      findings.push({ name, index: match.index, match: match[0] });
      if (findings.length >= limit) return findings;
      if (match[0].length === 0) pattern.lastIndex += 1;
    }
  }
  return findings;
}
