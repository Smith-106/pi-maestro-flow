import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { applyNativeToolPolicy, isNativeDiscoverySelected, withNativeToolPolicy } from "../src/tools/native-tool-policy.ts";
import { registerSearchToolBm25 } from "../src/tools/search-tool-bm25.ts";

function tool(name: string): ToolDefinition {
  return { name, label: name, description: name, parameters: Type.Object({}), async execute() { return { content: [], details: {} }; } };
}

test("native discovery requires opt-in and honors disabled builtin and CLI tool selection", () => {
  assert.equal(isNativeDiscoverySelected({}), false);
  assert.equal(isNativeDiscoverySelected({ defaultTools: ["+tool_search"] }), true);
  assert.equal(isNativeDiscoverySelected({ defaultTools: ["+tool_search", "-tool_search"] }), false);
  assert.equal(isNativeDiscoverySelected({ defaultTools: ["+tool_search"], extensions: ["-builtin:tool-search"] }), false);
  assert.equal(isNativeDiscoverySelected({ defaultTools: ["+tool_search"], extensions: ["!builtin:*"] }), false);
  assert.equal(isNativeDiscoverySelected({ defaultTools: ["+tool_search"], cli: { extensions: ["!builtin:*"] } }), false);
  assert.equal(isNativeDiscoverySelected({ defaultTools: ["+tool_search"], cli: { tools: ["read"] } }), false);
  assert.equal(isNativeDiscoverySelected({ cli: { tools: ["tool_search"], noTools: true } }), false);
  assert.equal(isNativeDiscoverySelected({ cli: { tools: ["tool_search"], excludeTools: ["tool_search"] } }), false);
  assert.equal(isNativeDiscoverySelected({ cli: { tools: ["tool_search"], noExtensions: true } }), false);
  assert.equal(isNativeDiscoverySelected({ cli: { tools: ["tool_search"], noExtensions: true, extensions: ["builtin:tool-search"] } }), true);
});

test("native registrations preserve execution and output contracts and isolate controls", () => {
  const original = { ...tool("browser"), outputSchema: Type.Object({ ok: Type.Boolean() }), annotations: { readOnlyHint: false } };
  const result = applyNativeToolPolicy(original, true);
  assert.equal(result.exposure, "deferred");
  assert.equal(result.execute, original.execute);
  assert.equal(result.parameters, original.parameters);
  assert.equal(result.outputSchema, original.outputSchema);
  assert.equal(result.annotations, original.annotations);
  assert.equal(applyNativeToolPolicy(tool("browser"), false).exposure, "direct");
  for (const name of ["todo", "run-control", "plan-confirm", "ask-user-question", "new_context"]) {
    assert.equal(applyNativeToolPolicy(tool(name), true).exposure, "model-only");
  }
  assert.equal(applyNativeToolPolicy({ ...tool("browser"), exposure: "hidden" }, true).exposure, "hidden");
});

test("legacy and unknown hosts retain the original API without native metadata", () => {
  const api = {} as ExtensionAPI;
  assert.equal(withNativeToolPolicy(api, "0.87.0", true), api);
  assert.equal(withNativeToolPolicy(api, undefined, true), api);
  const registered: ToolDefinition[] = [];
  const native = withNativeToolPolicy({ registerTool(definition: ToolDefinition) { registered.push(definition); } } as ExtensionAPI, "0.99.0", true);
  native.registerTool(tool("lsp"));
  assert.equal(registered[0]?.exposure, "deferred");
});

test("registration decorators compose without mutating or recursively calling the host API", () => {
  const registered: ToolDefinition[] = [];
  const originalRegister = (definition: ToolDefinition): void => { registered.push(definition); };
  const original = { registerTool: originalRegister } as ExtensionAPI;
  const native = withNativeToolPolicy(original, "0.99.0", true);
  const previous = native.registerTool.bind(native);
  native.registerTool = (definition: ToolDefinition): void => previous({ ...definition, label: "wrapped" });
  native.registerTool(tool("todo"));
  assert.equal(registered.length, 1);
  assert.equal(registered[0]?.exposure, "model-only");
  assert.equal(registered[0]?.label, "wrapped");
  assert.equal(original.registerTool, originalRegister);
});

test("native and unknown hosts never register legacy discovery or its lifecycle handlers", () => {
  for (const version of ["0.99.0", "0.100.0", "0.99.0-rc.1", undefined]) {
    const api = new Proxy({} as ExtensionAPI, { get() { return () => assert.fail("legacy action attempted"); } });
    registerSearchToolBm25(api, version);
  }
});
