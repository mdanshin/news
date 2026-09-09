import fs from "node:fs/promises";
import path from "node:path";

import { findSensitivePatterns } from "./secrets.mjs";

// Files or directories to scan; directories are expanded to their *.json files.
const targets = process.argv.length > 2 ? process.argv.slice(2) : ["data/news.json", "data/articles"];

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
  for (const hit of findSensitivePatterns(text, { limit: MAX_FINDINGS - findings.length })) {
    findings.push({ file, name: hit.name, ...getLocation(text, hit.index) });
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
