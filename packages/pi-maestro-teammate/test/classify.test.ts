import assert from "node:assert/strict";
import test from "node:test";
import {
  classify,
  classifierStatus,
  classifySync,
  configureClassifier,
  registerClassifyDomain,
  resetClassifierForTest,
  type ClassifierConfig,
} from "../src/classify/engine.ts";
import type { ClassifyShadowRecord } from "../src/classify/types.ts";
import {
  fileValueDomain,
  registerBuiltinClassifyDomains,
  retryErrorDomain,
} from "../src/classify/domains.ts";
import { parseJevResponse } from "../src/classify/client.ts";
import { classifyRetryError, classifyRetryErrorDetailed } from "../src/runs/retry.ts";
import type { ClassifyDomain, JevResponse } from "../src/classify/types.ts";

function fakeFetch(response: JevResponse | { status: number }, calls: Array<unknown> = []): typeof fetch {
  return (async (_url: unknown, init: unknown) => {
    calls.push(init);
    if ("status" in response && typeof response.status === "number") {
      return new Response("error", { status: response.status });
    }
    return new Response(JSON.stringify(response), { status: 200 });
  }) as unknown as typeof fetch;
}

const JEV_FILE_VALUE_RESPONSE: JevResponse = {
  model: "jev-1.13.0",
  answers: {
    value: { type: "choice", choice: "required", confidence: 0.9, probabilities: { required: 0.9, conditional: 0.07, skip: 0.02, unknown: 0.01 } },
  },
};

function baseConfig(overrides: Partial<ClassifierConfig> = {}): ClassifierConfig {
  return {
    enabled: true,
    endpoint: "openrouter",
    apiKey: "test-key",
    fetchFn: fakeFetch(JEV_FILE_VALUE_RESPONSE),
    domains: {},
    ...overrides,
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("parseJevResponse validates answers against question types", () => {
  const questions = {
    kind: { type: "choice" as const, instructions: "x", criteria: { a: "A", b: "B" } },
    urgent: { type: "noul" as const, instructions: "y" },
  };
  const ok = parseJevResponse(
    { model: "jev-1.13.0", answers: { kind: { type: "choice", choice: "a", confidence: 0.8 }, urgent: { type: "noul", noul: 0.9 } } },
    questions,
  );
  assert.equal(ok?.model, "jev-1.13.0");
  assert.deepEqual(ok?.answers.urgent, { type: "noul", noul: 0.9 });

  // Unknown choice option → invalid.
  assert.equal(
    parseJevResponse({ answers: { kind: { type: "choice", choice: "zzz" }, urgent: { type: "noul", noul: 0.5 } } }, questions),
    undefined,
  );
  // Missing answer → invalid.
  assert.equal(parseJevResponse({ answers: { kind: { type: "choice", choice: "a" } } }, questions), undefined);
  // Malformed payload → invalid.
  assert.equal(parseJevResponse("nope", questions), undefined);
});

test("classifyRetryErrorDetailed flags the unknown-failure default branch", () => {
  assert.deepEqual(classifyRetryErrorDetailed("fetch failed"), { kind: "network", defaulted: false });
  assert.deepEqual(classifyRetryErrorDetailed("Provider error", 429), { kind: "provider", defaulted: false });
  assert.deepEqual(classifyRetryErrorDetailed("some totally new failure mode"), { kind: "provider", defaulted: true });
  assert.deepEqual(classifyRetryErrorDetailed(undefined), { kind: "provider", defaulted: true });
  // The sync contract is unchanged.
  assert.equal(classifyRetryError("fetch failed"), "network");
});

test("classify returns the rule label and never calls JEV when disabled", async () => {
  resetClassifierForTest();
  const calls: unknown[] = [];
  configureClassifier(baseConfig({ enabled: false, fetchFn: fakeFetch(JEV_FILE_VALUE_RESPONSE, calls) }));
  registerClassifyDomain(fileValueDomain);
  const result = await classify(fileValueDomain, { path: "src/a.ts" });
  assert.equal(result.label, "unknown");
  assert.equal(result.layer, "degraded");
  assert.equal(calls.length, 0);
});

test("classify adjudicates through JEV in jev mode", async () => {
  resetClassifierForTest();
  const calls: unknown[] = [];
  configureClassifier(baseConfig({ fetchFn: fakeFetch(JEV_FILE_VALUE_RESPONSE, calls), domains: { "file-value": "jev" } }));
  registerClassifyDomain(fileValueDomain);
  const result = await classify("file-value", { path: "src/engine.ts", nextAction: "fix the classifier" });
  assert.equal(result.label, "required");
  assert.equal(result.layer, "jev");
  assert.equal(result.confidence, 0.9);
  assert.equal(result.model, "jev-1.13.0");
  assert.equal(calls.length, 1);
  // Cache: second identical call does not hit the network again.
  const second = await classify("file-value", { path: "src/engine.ts", nextAction: "fix the classifier" });
  assert.equal(second.label, "required");
  assert.equal(calls.length, 1);
});

test("classify degrades to the domain fallback on JEV transport failure", async () => {
  resetClassifierForTest();
  configureClassifier(baseConfig({ fetchFn: fakeFetch({ status: 503 }), domains: { "file-value": "jev" } }));
  registerClassifyDomain(fileValueDomain);
  const result = await classify("file-value", { path: "src/a.ts" });
  assert.equal(result.label, "unknown");
  assert.equal(result.layer, "degraded");
  assert.match(result.degradedReason ?? "", /HTTP 503/);
});

test("classify degrades when the session call budget is exhausted", async () => {
  resetClassifierForTest();
  const calls: unknown[] = [];
  configureClassifier(baseConfig({
    fetchFn: fakeFetch(JEV_FILE_VALUE_RESPONSE, calls),
    maxCallsPerSession: 1,
    domains: { "file-value": "jev" },
  }));
  registerClassifyDomain(fileValueDomain);
  const first = await classify("file-value", { path: "a.ts" });
  assert.equal(first.layer, "jev");
  const second = await classify("file-value", { path: "b.ts" });
  assert.equal(second.layer, "degraded");
  assert.match(second.degradedReason ?? "", /budget/);
  assert.equal(calls.length, 1);
});

test("shadow mode keeps the rule label and reports the JEV pair via onShadow", async () => {
  resetClassifierForTest();
  const shadows: ClassifyShadowRecord[] = [];
  const jevRetry: JevResponse = {
    model: "jev-1.13.0",
    answers: {
      kind: {
        type: "choice",
        choice: "network",
        confidence: 0.7,
        probabilities: { network: 0.7, provider: 0.2, "fallback-only": 0.05, auth: 0.03, "non-retryable": 0.02 },
      },
    },
  };
  const calls: unknown[] = [];
  configureClassifier(baseConfig({
    fetchFn: fakeFetch(jevRetry, calls),
    domains: { "retry-error": "shadow" },
    onShadow: (record) => shadows.push(record),
  }));
  registerBuiltinClassifyDomains();

  const result = classifySync(retryErrorDomain, { message: "some totally new failure mode" });
  // Sync path keeps the provisional rule label — zero behavior change.
  assert.equal(result.label, "provider");
  assert.equal(result.layer, "rule");
  await waitFor(() => shadows.length === 1);
  assert.equal(shadows[0]?.domain, "retry-error");
  assert.deepEqual(shadows[0]?.rule, { label: "provider", terminal: false });
  assert.equal(shadows[0]?.jev?.label, "network");
  assert.equal(shadows[0]?.agree, false);
});

test("unsupported modes resolve to off (retry-error is shadow-only)", async () => {
  resetClassifierForTest();
  const calls: unknown[] = [];
  configureClassifier(baseConfig({ fetchFn: fakeFetch(JEV_FILE_VALUE_RESPONSE, calls), domains: { "retry-error": "jev" } }));
  registerBuiltinClassifyDomains();
  const status = classifierStatus();
  assert.equal(status.domains["retry-error"]?.mode, "off");
  const result = classifySync(retryErrorDomain, { message: "some totally new failure mode" });
  assert.equal(result.label, "provider");
  assert.equal(calls.length, 0);
});

test("a custom domain with terminal rules short-circuits before JEV", async () => {
  resetClassifierForTest();
  const calls: unknown[] = [];
  configureClassifier(baseConfig({ fetchFn: fakeFetch(JEV_FILE_VALUE_RESPONSE, calls), domains: { demo: "jev" } }));
  const demo: ClassifyDomain<"a" | "b", { text: string }> = {
    name: "demo",
    modes: ["off", "shadow", "jev"],
    rules: (input) => ({ label: input.text === "yes" ? "a" : "b", terminal: true }),
    state: (input) => input.text,
    questions: () => ({ q: { type: "choice", instructions: "x", criteria: { a: "A", b: "B" } } }),
    decide: () => ({ label: "b", confidence: 0.9 }),
    fallback: () => ({ label: "b", confidence: 0 }),
  };
  registerClassifyDomain(demo);
  const result = await classify(demo, { text: "yes" });
  assert.equal(result.label, "a");
  assert.equal(result.layer, "rule");
  assert.equal(result.confidence, 1);
  assert.equal(calls.length, 0);
});
