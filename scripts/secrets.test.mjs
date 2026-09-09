import assert from "node:assert/strict";
import { test } from "node:test";

import { CONTEXT_SECRET_PATTERNS, REDACTED_PRIVATE_KEY, REDACTED_SECRET, STRONG_SECRET_PATTERNS, findSensitivePatterns, redactSensitiveContent } from "./secrets.mjs";

// Samples are assembled at run time so that no token-shaped literal is
// stored in the repository (secret scanning would flag the test file).
const rep = (ch, n) => ch.repeat(n);
const alnum = (n) => Array.from({ length: n }, (_, i) => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[(i * 7) % 62]).join("");
const hex = (n) => Array.from({ length: n }, (_, i) => "0123456789abcdef"[(i * 5) % 16]).join("");

const samples = {
  "telegram-bot-token": `${"1234567890"}:${"AAH"}${alnum(32)}`,
  "google-api-key": `${"AIza"}${alnum(35)}`,
  "hashicorp-vault-token": `${"s."}${alnum(24)}`,
  "hashicorp-vault-token-new": `${"hvs."}${alnum(30)}`,
  "docker-swarm-join-token": `${"SWMTKN-1-"}${hex(50)}-${hex(25)}`,
  "aws-access-key-id": `${"AKIA"}${rep("A", 16)}`,
  "github-token": `${"ghp_"}${alnum(36)}`,
  "github-fine-grained": `${"github_pat_"}${alnum(40)}`,
  "openai-key": `${"sk-proj-"}${alnum(40)}`,
  "anthropic-key": `${"sk-ant-"}${alnum(40)}`,
  "hugging-face-token": `${"hf_"}${alnum(34)}`,
  "slack-token": `${"xoxb-"}${"1234567890-"}${alnum(24)}`,
  "slack-webhook": `${"https://hooks.slack.com/services/"}T${alnum(8)}/B${alnum(8)}/${alnum(24)}`,
  "google-oauth-client-secret": `${"GOCSPX-"}${alnum(28)}`,
  "jwt": `${"eyJ"}${alnum(20)}.${"eyJ"}${alnum(30)}.${alnum(40)}`,
  "stripe-key": `${"sk_test_"}${alnum(24)}`,
  "sendgrid-key": `${"SG."}${alnum(22)}.${alnum(43)}`,
  "digitalocean-token": `${"dop_v1_"}${hex(64)}`,
  "databricks-token": `${"dapi"}${hex(32)}`,
  "yandex-cloud-token": `${"AQVN"}${alnum(40)}`,
  "age-secret-key": `${"AGE-SECRET-KEY-1"}${rep("Q", 58)}`,
  "private-key-block": `${"-----BEGIN "}${"RSA PRIVATE KEY-----"}\nMIIE${alnum(40)}\n${"-----END "}${"RSA PRIVATE KEY-----"}`
};

test("every strong pattern has a name and a global regex", () => {
  for (const entry of [...STRONG_SECRET_PATTERNS, ...CONTEXT_SECRET_PATTERNS]) {
    assert.ok(entry.name, "pattern without a name");
    assert.ok(entry.pattern instanceof RegExp && entry.pattern.global, `${entry.name} must be a global RegExp`);
  }
});

test("token shapes reported by GitHub secret scanning are redacted and detected", () => {
  for (const [label, sample] of Object.entries(samples)) {
    const text = `Пример конфигурации: TOKEN=${sample} и дальше текст.`;
    const redacted = redactSensitiveContent(text);
    assert.ok(!redacted.includes(sample), `${label}: sample survived redaction: ${redacted}`);
    assert.ok(redacted.includes(REDACTED_SECRET) || redacted.includes(REDACTED_PRIVATE_KEY), `${label}: no marker in ${redacted}`);
    assert.ok(findSensitivePatterns(text).length > 0, `${label}: not detected`);
    assert.deepEqual(findSensitivePatterns(redacted), [], `${label}: marker itself is flagged`);
  }
});

test("context patterns redact only the value and keep the prefix", () => {
  const cases = [
    [`https://user:${alnum(12)}@example.com/path`, `https://user:${REDACTED_SECRET}@example.com/path`],
    [`Authorization: Bearer ${alnum(20)}`, `Authorization: Bearer ${REDACTED_SECRET}`],
    [`https://api.example.com/?api_key=${alnum(16)}&x=1`, `https://api.example.com/?api_key=${REDACTED_SECRET}&x=1`],
    [`password = "${alnum(12)}"`, `password = "${REDACTED_SECRET}"`]
  ];
  for (const [input, expected] of cases) assert.equal(redactSensitiveContent(input), expected);
  // Context matches are a precaution in the builder and are not reported by the checker.
  assert.deepEqual(findSensitivePatterns(`password = "${alnum(12)}"`), []);
});

test("ordinary news text is left alone", () => {
  const texts = [
    "https://lenta.ru/news/2026/09/09/sk-na-ataku-vsu-na-rossiyskiy-gorod/",
    "Ключевая ставка ЦБ: 16% годовых; токен доверия к рублю вырос.",
    "Docs. Читайте документацию по адресу https://docs.example.com/s.pages/index",
    "В 2026 году выпущено 1234567890 устройств: рекорд отрасли.",
    "Версия 4.5.3 пакета fast-xml-parser содержит уязвимость CVE-2026-26278.",
    "Telegram-бот: t.me/example_bot, ключ выдаёт BotFather.",
    `Хеш коммита ${hex(40)} и контрольная сумма ${hex(64)}.`
  ];
  for (const text of texts) {
    assert.equal(redactSensitiveContent(text), text, text);
    assert.deepEqual(findSensitivePatterns(text), [], text);
  }
});

test("redaction is idempotent and tolerates non-strings", () => {
  const once = redactSensitiveContent(`token: ${samples["github-token"]}`);
  assert.equal(redactSensitiveContent(once), once);
  assert.equal(redactSensitiveContent(""), "");
  assert.equal(redactSensitiveContent(undefined), "");
  assert.equal(redactSensitiveContent(null), "");
});
