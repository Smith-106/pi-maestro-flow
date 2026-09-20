import assert from "node:assert/strict";
import test from "node:test";
import {
  applyClassifierEnvOverrides,
  DEFAULT_CLASSIFIER_CONFIG,
  envOverrideForClassifier,
  normalizeClassifierConfig,
} from "../src/classifier/config.ts";
import { buildDomainTestInput, signalTypeDomain } from "../src/classifier/domains.ts";

test("normalizeClassifierConfig applies defaults and validates fields", () => {
  const config = normalizeClassifierConfig(undefined);
  assert.equal(config.enabled, false);
  assert.deepEqual(config.domains, DEFAULT_CLASSIFIER_CONFIG.domains);

  const loaded = normalizeClassifierConfig({
    enabled: true,
    endpoint: "openrouter",
    model: "typesafe/jev-1.13",
    timeoutMs: 2500,
    maxCallsPerSession: 7,
    domains: { "retry-error": "shadow", "file-value": "bogus", "signal-type": "jev" },
  });
  assert.equal(loaded.enabled, true);
  assert.equal(loaded.endpoint, "openrouter");
  assert.equal(loaded.model, "typesafe/jev-1.13");
  assert.equal(loaded.timeoutMs, 2500);
  assert.equal(loaded.maxCallsPerSession, 7);
  assert.equal(loaded.domains["retry-error"], "shadow");
  assert.equal(loaded.domains["signal-type"], "jev");
  // Invalid mode entries are dropped, not normalized.
  assert.equal(loaded.domains["file-value"], DEFAULT_CLASSIFIER_CONFIG.domains["file-value"]);

  // Unknown endpoint values are rejected.
  assert.equal(normalizeClassifierConfig({ endpoint: "other" }).endpoint, undefined);
  // Non-object input falls back to defaults.
  assert.equal(normalizeClassifierConfig("yes").enabled, false);
});

test("envOverrideForClassifier parses truthy flags only", () => {
  assert.equal(envOverrideForClassifier(undefined), undefined);
  assert.equal(envOverrideForClassifier("1"), true);
  assert.equal(envOverrideForClassifier("yes"), true);
  assert.equal(envOverrideForClassifier("off"), false);
  assert.equal(envOverrideForClassifier("0"), false);
});

test("applyClassifierEnvOverrides reads endpoint/model env vars", () => {
  const savedEndpoint = process.env.PI_CLASSIFIER_ENDPOINT;
  const savedModel = process.env.PI_CLASSIFIER_MODEL;
  try {
    process.env.PI_CLASSIFIER_ENDPOINT = "typesafe";
    process.env.PI_CLASSIFIER_MODEL = "jev-latest";
    const config = applyClassifierEnvOverrides(normalizeClassifierConfig(undefined));
    assert.equal(config.endpoint, "typesafe");
    assert.equal(config.model, "jev-latest");
    process.env.PI_CLASSIFIER_ENDPOINT = "bogus";
    assert.equal(applyClassifierEnvOverrides(normalizeClassifierConfig(undefined)).endpoint, undefined);
  } finally {
    if (savedEndpoint === undefined) delete process.env.PI_CLASSIFIER_ENDPOINT;
    else process.env.PI_CLASSIFIER_ENDPOINT = savedEndpoint;
    if (savedModel === undefined) delete process.env.PI_CLASSIFIER_MODEL;
    else process.env.PI_CLASSIFIER_MODEL = savedModel;
  }
});

test("buildDomainTestInput shapes per-domain inputs from free text", () => {
  assert.deepEqual(buildDomainTestInput("retry-error", "HTTP 429 rate limit"), {
    message: "HTTP 429 rate limit",
    status: 429,
  });
  assert.deepEqual(buildDomainTestInput("retry-error", "plain error"), { message: "plain error" });
  assert.deepEqual(buildDomainTestInput("file-value", "src/a.ts fix the bug"), {
    path: "src/a.ts",
    nextAction: "fix the bug",
  });
  assert.deepEqual(buildDomainTestInput("signal-type", "决定采用 X 因为 Y"), { text: "决定采用 X 因为 Y" });
});

test("signal-type domain rules treat unknown as provisional", () => {
  const spec = signalTypeDomain.rules({ text: "决策：采用方案 A 因为 B" });
  assert.equal(spec?.label, "spec");
  assert.equal(spec?.terminal, true);
  const narration = signalTypeDomain.rules({ text: "I checked the file and it looks fine." });
  assert.equal(narration?.label, "unknown");
  assert.equal(narration?.terminal, false);
});
