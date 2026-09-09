import fs from "node:fs/promises";
import path from "node:path";

// Files or directories to scan; directories are expanded to their *.json files.
const targets = process.argv.length > 2 ? process.argv.slice(2) : ["data/news.json", "data/articles"];

const CHECKS = [
  ["private-key", /-----BEGIN [^-]{0,80}PRIVATE KEY-----/g],
  ["aws-access-key-id", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["github-token", /\b(?:ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]+)\b/g],
  ["gitlab-token", /\bglpat-[A-Za-z0-9_-]{20,}\b/g],
  ["npm-token", /\bnpm_[A-Za-z0-9]{36}\b/g],
  ["openai-token", /\b(?:sk-(?:proj|svcacct)-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,})\b/g],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]+\b/g],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["telegram-bot-token", /\b[0-9]{6,10}:[A-Za-z0-9_-]{35,}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ["stripe-key", /\b(?:sk_live|rk_live|pk_live)_[A-Za-z0-9]{20,}\b/g],
  ["url-credentials", /https?:\/\/[^/\s:@"'<>]+:(?!\[REDACTED_)[^@\s"'<>]+@/gi],
  ["auth-header", /\bAuthorization\s*[:=]\s*["']?(?:Bearer|Basic)\s+(?!\[REDACTED_)[A-Za-z0-9._~+/=-]{8,}/gi],
  ["sensitive-query", /[?&](?:access_token|refresh_token|token|api_key|apikey|key|signature|x-amz-signature|x-amz-credential|awsaccesskeyid)=(?!\[REDACTED_)[^&#\s"'<>]{8,}/gi]
];

const MAX_FINDINGS = 25;

function getLocation(text, index) {
  const before = text.slice(0, index);
  const lines = before.split("\n");
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

async function expand(target) {
  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    // A missing optional target (e.g. no article files yet) is not an error.
    return [];
  }
  if (!stat.isDirectory()) return [target];
  const names = await fs.readdir(target);
  return names.filter((n) => n.endsWith(".json")).sort().map((n) => path.join(target, n));
}

const files = (await Promise.all(targets.map(expand))).flat();
const findings = [];

for (const file of files) {
  const text = await fs.readFile(file, "utf8");
  for (const [name, pattern] of CHECKS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      findings.push({ file, name, ...getLocation(text, match.index) });
      if (findings.length >= MAX_FINDINGS) break;
    }
    if (findings.length >= MAX_FINDINGS) break;
  }
  if (findings.length >= MAX_FINDINGS) break;
}

if (findings.length > 0) {
  console.error("Sensitive patterns found:");
  for (const finding of findings) {
    console.error(`- ${finding.name} in ${finding.file} at ${finding.line}:${finding.column}`);
  }
  process.exit(1);
}

console.log(`No strong sensitive patterns found in ${files.length} file(s)`);
