import assert from "node:assert/strict";
import test from "node:test";
import type { ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";
import { bindClassifierRuntime, unbindClassifierRuntime, configureClassifier, classify, classifySync, resetClassifierForTest, classifierStatus } from "../src/classify/engine.ts";
import { createNativeJevClient, type ClassifierRuntime } from "../src/classify/client.ts";
import { fileValueDomain } from "../src/classify/domains.ts";

const model: ClassifierModel<"typesafe-system-one"> = { type: "classifier", id: "jev-latest", name: "JEV", provider: "typesafe", api: "typesafe-system-one", baseUrl: "https://api.typesafe.ai", input: ["text"], contextWindow: 32000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
function fakeRuntime(classifyFn: ClassifierRuntime["classify"]): ClassifierRuntime {
  return {
    getAvailableOfType: async () => [model],
    getModelOfType: (_type, provider, id) => provider === model.provider && id === model.id ? model : undefined,
    classify: classifyFn,
  };
}
function result(answers: ClassifierResult["answers"]): ClassifierResult {
  return { api: model.api, provider: model.provider, model: model.id, answers, stopReason: "stop", timestamp: 0 };
}

test("native classifier adapts choice, score and noul without losing probabilities", async () => {
  const runtime = fakeRuntime(async (selected, context, options) => {
    assert.equal(selected, model);
    assert.deepEqual(context.state, { text: "decision input" });
    assert.deepEqual(context.questions.yes, { type: "bool", instructions: "is it", criteria: { true: "Yes", false: "No" } });
    assert.ok(options?.signal);
    return result({ pick: { type: "choice", choice: "a", confidence: 0.8, probabilities: { a: 0.8, b: 0.2 } }, rank: { type: "score", score: 2, confidence: 0.9 }, yes: { type: "bool", probability: 0.7 } });
  });
  const response = await createNativeJevClient(runtime, { endpoint: "typesafe" }).decide({ state: "decision input", questions: {
    pick: { type: "choice", instructions: "choose", criteria: { a: "A", b: "B" } },
    rank: { type: "score", instructions: "rank", criteria: ["low", "high"] },
    yes: { type: "noul", instructions: "is it" },
  } });
  assert.deepEqual(response.answers.yes, { type: "noul", noul: 0.7 });
  assert.equal(response.model, "typesafe/jev-latest");
  assert.deepEqual(response.answers.pick, { type: "choice", choice: "a", confidence: 0.8, probabilities: { a: 0.8, b: 0.2 } });
});

test("native domain pipeline preserves cache, shadow, and call budget; never calls HTTP", async () => {
  resetClassifierForTest();
  let calls = 0;
  const runtime = fakeRuntime(async () => { calls++; return result({ value: { type: "choice", choice: "required", confidence: 0.9, probabilities: { required: 0.9, unknown: 0.1 } } }); });
  bindClassifierRuntime({ hostVersion: "0.99.0", runtime });
  configureClassifier({ enabled: true, hostVersion: "0.98.0", apiKey: "legacy-key", fetchFn: async () => { throw new Error("HTTP must not execute"); }, domains: { "file-value": "jev" }, maxCallsPerSession: 1 });
  const input = { path: "src/a.ts" };
  assert.equal((await classify(fileValueDomain, input)).label, "required");
  assert.equal((await classify(fileValueDomain, input)).layer, "jev");
  assert.equal(calls, 1);
  assert.match((await classify(fileValueDomain, { path: "src/b.ts" })).degradedReason ?? "", /budget/);
  const shadow = new Promise<void>((resolve) => configureClassifier({ enabled: true, domains: { "file-value": "shadow" }, onShadow: (record) => { assert.equal(record.jev?.label, "required"); resolve(); } }));
  assert.notEqual(classifySync(fileValueDomain, input).layer, "jev");
  await shadow;
  assert.equal(classifierStatus().callsUsed, 1);
});

test("classifier shutdown clears the current runtime but cannot unbind a newer host", async () => {
  resetClassifierForTest();
  let calls = 0;
  const previous = fakeRuntime(async () => result({}));
  const current = fakeRuntime(async () => { calls++; return result({ value: { type: "choice", choice: "required", confidence: 0.9, probabilities: { required: 0.9, unknown: 0.1 } } }); });
  bindClassifierRuntime({ hostVersion: "0.99.0", runtime: previous });
  bindClassifierRuntime({ hostVersion: "0.99.0", runtime: current });
  configureClassifier({ enabled: true, domains: { "file-value": "jev" } });
  unbindClassifierRuntime(previous);
  assert.equal((await classify(fileValueDomain, { path: "a.ts" })).label, "required");
  unbindClassifierRuntime(current);
  assert.match((await classify(fileValueDomain, { path: "a.ts" })).degradedReason ?? "", /runtime unavailable/);
  assert.equal(calls, 1);
});

test("native and unknown hosts fail explicitly rather than using HTTP; auth errors remain visible", async () => {
  for (const hostVersion of ["0.99.0", "unknown"]) {
    resetClassifierForTest();
    configureClassifier({ enabled: true, hostVersion, apiKey: "key", domains: { "file-value": "jev" }, fetchFn: async () => { throw new Error("unexpected HTTP fallback"); } });
    assert.match((await classify(fileValueDomain, { path: "a.ts" })).degradedReason ?? "", /runtime unavailable/);
  }
  bindClassifierRuntime({ hostVersion: "0.99.0", runtime: fakeRuntime(async () => ({ ...result({}), stopReason: "error", errorMessage: "typesafe authentication unavailable" })) });
  configureClassifier({ enabled: true, domains: { "file-value": "jev" } });
  assert.match((await classify(fileValueDomain, { path: "a.ts" })).degradedReason ?? "", /authentication unavailable/);
});
