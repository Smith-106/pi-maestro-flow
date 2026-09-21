import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { JsonValue, SettingsChange, SettingsContextV1 } from "pi-maestro-settings-core/v1";
import { createClassifierSettingsProvider } from "../src/classifier/settings-provider.ts";
import type { FlowClassifierConfig } from "../src/classifier/config.ts";

const DOMAINS = [
  { name: "retry-error", modes: ["off", "shadow"] as const },
  { name: "file-value", modes: ["off", "shadow", "jev"] as const },
];

function harness(initial?: Record<string, unknown>, applied?: FlowClassifierConfig[]) {
  const directory = mkdtempSync(join(tmpdir(), "classifier-provider-"));
  const projectDir = join(directory, "project");
  const configPath = join(projectDir, ".pi", "classifier.json");
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  if (initial) writeFileSync(configPath, JSON.stringify(initial, null, 2));
  const provider = createClassifierSettingsProvider({
    getConfigPath: () => configPath,
    getDomains: () => DOMAINS.map((domain) => ({ name: domain.name, modes: [...domain.modes] })),
    apply: (config) => { applied?.push(config); },
  });
  const context: SettingsContextV1 = { cwd: projectDir, locale: "en" };
  return { provider, configPath, directory, context, applied };
}

function setChange(key: string, value: JsonValue): SettingsChange {
  return { operation: "set", key, scope: "project", value };
}

test("classifier provider describes scalars and one enum per domain", async () => {
  const { provider, directory } = harness();
  try {
    const description = await provider.describe({ context: { cwd: "/p", locale: "en" } });
    assert.equal(description.id, "pi-maestro-flow-classifier");
    const keys = description.settings.map((setting) => setting.key);
    assert.ok(keys.includes("classifier.enabled"));
    assert.ok(keys.includes("classifier.endpoint"));
    assert.ok(keys.includes("classifier.domains.retry-error"));
    assert.ok(keys.includes("classifier.domains.file-value"));
    // retry-error is shadow-only: the editor must not offer "jev".
    const retry = description.settings.find((s) => s.key === "classifier.domains.retry-error")!;
    assert.deepEqual(retry.editor.options?.map((option) => option.value), ["off", "shadow"]);
    const fileValue = description.settings.find((s) => s.key === "classifier.domains.file-value")!;
    assert.deepEqual(fileValue.editor.options?.map((option) => option.value), ["off", "shadow", "jev"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("read reports configured vs default state", async () => {
  const { provider, directory, context } = harness({ enabled: true, domains: { "retry-error": "shadow" } });
  try {
    const snapshot = await provider.read({ context });
    const configured = snapshot.configured.values;
    assert.equal(configured.find((v) => v.key === "classifier.enabled")?.state, "set");
    assert.equal(configured.find((v) => v.key === "classifier.domains.retry-error")?.state, "set");
    assert.equal(configured.find((v) => v.key === "classifier.model")?.state, "absent");
    const effective = snapshot.effective.values;
    assert.equal(effective.find((v) => v.key === "classifier.enabled")?.value, true);
    assert.equal(effective.find((v) => v.key === "classifier.domains.retry-error")?.value, "shadow");
    assert.equal(effective.find((v) => v.key === "classifier.domains.file-value")?.value, "off");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("prepare+commit writes classifier.json and hot-applies the config", async () => {
  const applied: FlowClassifierConfig[] = [];
  const { provider, configPath, directory, context } = harness(undefined, applied);
  try {
    const prepared = await provider.prepare!({
      context,
      transactionId: "c1",
      changes: [
        setChange("classifier.enabled", true),
        setChange("classifier.endpoint", "openrouter"),
        setChange("classifier.model", "typesafe/jev-1.13"),
        setChange("classifier.domains.retry-error", "shadow"),
      ],
    });
    assert.equal(prepared.prepared, true);
    await provider.commit!({ context, transactionId: "c1", prepareToken: prepared.prepareToken! });
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    assert.equal(raw.enabled, true);
    assert.equal(raw.endpoint, "openrouter");
    assert.equal(raw.model, "typesafe/jev-1.13");
    assert.equal((raw.domains as Record<string, unknown>)["retry-error"], "shadow");
    // Live apply fired with the committed config.
    assert.equal(applied.length, 1);
    assert.equal(applied[0]?.enabled, true);
    assert.equal(applied[0]?.domains["retry-error"], "shadow");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("endpoint auto unsets the field; empty model unsets it", async () => {
  const { provider, configPath, directory, context } = harness({ endpoint: "openrouter", model: "x" });
  try {
    const prepared = await provider.prepare!({
      context,
      transactionId: "c2",
      changes: [setChange("classifier.endpoint", "auto"), setChange("classifier.model", "")],
    });
    assert.equal(prepared.prepared, true);
    await provider.commit!({ context, transactionId: "c2", prepareToken: prepared.prepareToken! });
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    assert.equal(raw.endpoint, undefined);
    assert.equal(raw.model, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("validation rejects unsupported domain modes and unknown keys", async () => {
  const { provider, directory, context } = harness();
  try {
    const unsupported = await provider.validate({
      context,
      transactionId: "c3",
      changes: [setChange("classifier.domains.retry-error", "jev")],
    });
    assert.equal(unsupported.valid, false);
    const unknown = await provider.validate({
      context,
      transactionId: "c3",
      changes: [setChange("classifier.domains.nope", "shadow")],
    });
    assert.equal(unknown.valid, false);
    const badScope = await provider.validate({
      context,
      transactionId: "c3",
      changes: [{ operation: "set", key: "classifier.enabled", scope: "global", value: true }],
    });
    assert.equal(badScope.valid, false);
    const ok = await provider.validate({
      context,
      transactionId: "c3",
      changes: [setChange("classifier.domains.retry-error", "shadow")],
    });
    assert.equal(ok.valid, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
