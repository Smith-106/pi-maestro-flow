import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerFff } from "../src/tools/fff.ts";
import { buildArgs } from "../src/tools/search-rg.ts";

test("FFF tools are registered for the root Maestro session", () => {
  const tools: string[] = [];
  registerFff({
    registerTool(tool: ToolDefinition) { tools.push(tool.name); },
    on() {},
  } as unknown as ExtensionAPI);

  assert.ok(tools.includes("search"));
  assert.ok(tools.includes("fffind"));
  assert.ok(!tools.includes("ffgrep"), "ffgrep is replaced by search");
});

test("FFF refuses home-directory workspace roots", async () => {
  const tools: ToolDefinition[] = [];
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const register = {
    registerTool(tool: ToolDefinition) { tools.push(tool); },
    registerCommand() {},
    on(event: string, handler: (...args: unknown[]) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  };
  registerFff(register as unknown as ExtensionAPI);

  const grep = tools.find((tool) => tool.name === "search");
  assert.ok(grep);
  const ctx = {
    cwd: homedir(),
    ui: { notify() {} },
    sessionManager: { getEntries: () => [] },
  } as unknown as ExtensionContext;
  await assert.rejects(
    grep.execute(
      "fff-home-reject",
      { pattern: "needle", limit: 5 },
      new AbortController().signal,
      undefined,
      ctx,
    ),
    /does not index home directories/,
  );
});

test("FFF destroys an initializing finder when the session shuts down", async () => {
  const tools: ToolDefinition[] = [];
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  let finishScan!: (result: { ok: true; value: boolean }) => void;
  let destroyCount = 0;
  let createCount = 0;
  const finder = {
    isDestroyed: false,
    destroy() {
      if (finder.isDestroyed) return;
      finder.isDestroyed = true;
      destroyCount += 1;
    },
    waitForScan() {
      return new Promise<{ ok: true; value: boolean }>((resolve) => {
        finishScan = resolve;
      });
    },
  };
  const replacementFinder = {
    isDestroyed: false,
    destroy() { replacementFinder.isDestroyed = true; },
    async waitForScan() { return { ok: true as const, value: true }; },
    grep() { return { ok: true as const, value: { items: [] } }; },
  };
  const register = {
    registerTool(tool: ToolDefinition) { tools.push(tool); },
    registerCommand() {},
    on(event: string, handler: (...args: unknown[]) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  };
  registerFff(register as unknown as ExtensionAPI, {
    createFinder: () => ({
      ok: true,
      value: (++createCount === 1 ? finder : replacementFinder) as never,
    }),
    scanTimeoutMs: 60_000,
  });

  const grep = tools.find((tool) => tool.name === "search");
  assert.ok(grep);
  const root = join(tmpdir(), "pi-fff-pending");
  const ctx = { cwd: root } as unknown as ExtensionContext;
  const execution = grep.execute(
    "fff-shutdown",
    { pattern: "needle", limit: 5 },
    new AbortController().signal,
    undefined,
    ctx,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  for (const handler of handlers.get("session_shutdown") ?? []) await handler();
  assert.equal(destroyCount, 1);
  const replacement = await grep.execute(
    "fff-replacement",
    { pattern: "needle", limit: 5 },
    new AbortController().signal,
    undefined,
    ctx,
  );
  assert.equal(replacement.content[0]?.text, "No matches found");
  assert.equal(createCount, 2);

  finishScan({ ok: true, value: true });
  await assert.rejects(execution, /session ended/);
  await grep.execute(
    "fff-cached-replacement",
    { pattern: "needle", limit: 5 },
    new AbortController().signal,
    undefined,
    ctx,
  );
  assert.equal(createCount, 2, "the old initializer must not delete the replacement reservation");
  assert.equal(destroyCount, 1);
});

test("FFF loads its native index and searches a selected workspace subdirectory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fff-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "needle.ts"), "export const FFF_INTEGRATION_NEEDLE = true;\n");
  const tools: ToolDefinition[] = [];
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const register = {
    registerTool(tool: ToolDefinition) { tools.push(tool); },
    registerCommand() {},
    on(event: string, handler: (...args: unknown[]) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  };

  try {
    registerFff(register as unknown as ExtensionAPI);
    const ctx = {
      cwd: root,
      ui: { notify() {} },
      sessionManager: { getEntries: () => [] },
    } as unknown as ExtensionContext;
    const grep = tools.find((tool) => tool.name === "search");
    assert.ok(grep);
    const result = await grep.execute(
      "fff-smoke",
      { pattern: "FFF_INTEGRATION_NEEDLE", path: "src", limit: 10 },
      new AbortController().signal,
      undefined,
      ctx,
    );
    assert.match(result.content[0]?.text ?? "", /needle\.ts/);

    const find = tools.find((tool) => tool.name === "fffind");
    assert.ok(find);
    const found = await find.execute(
      "fff-find-smoke",
      { pattern: "needle", path: "src", limit: 10 },
      new AbortController().signal,
      undefined,
      ctx,
    );
    assert.match(found.content[0]?.text ?? "", /needle\.ts/);
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function fakeRegister(): {
  tools: ToolDefinition[];
  register: ExtensionAPI;
} {
  const tools: ToolDefinition[] = [];
  const register = {
    registerTool(tool: ToolDefinition) { tools.push(tool); },
    on() {},
  };
  return { tools, register: register as unknown as ExtensionAPI };
}

test("search falls back to ripgrep when the index cannot initialize", async () => {
  const { tools, register } = fakeRegister();
  const rgCalls: Array<{ pattern: string; output: string }> = [];
  registerFff(register, {
    createFinder: () => ({ ok: false, error: "native binding missing" }) as never,
    runRg: async (request) => {
      rgCalls.push({ pattern: request.pattern, output: request.output });
      return { text: "src/a.ts:3: hit", limitReached: false };
    },
  });
  const search = tools.find((tool) => tool.name === "search");
  assert.ok(search);
  const ctx = { cwd: join(tmpdir(), "pi-fff-rg-fallback") } as unknown as ExtensionContext;
  const result = await search.execute(
    "search-rg",
    { pattern: "needle", limit: 5 },
    new AbortController().signal,
    undefined,
    ctx,
  );
  assert.equal(rgCalls.length, 1);
  assert.equal(rgCalls[0]?.output, "lines");
  assert.match(result.content[0]?.text ?? "", /src\/a\.ts:3: hit/);
  assert.match(result.content[0]?.text ?? "", /engine: rg/);
});

test("search mode=fuzzy reports an explicit error when the index is unavailable", async () => {
  const { tools, register } = fakeRegister();
  let rgCalled = false;
  registerFff(register, {
    createFinder: () => ({ ok: false, error: "native binding missing" }) as never,
    runRg: async () => {
      rgCalled = true;
      return { text: "", limitReached: false };
    },
  });
  const search = tools.find((tool) => tool.name === "search");
  assert.ok(search);
  const ctx = { cwd: join(tmpdir(), "pi-fff-fuzzy") } as unknown as ExtensionContext;
  await assert.rejects(
    search.execute(
      "search-fuzzy",
      { pattern: "needle", mode: "fuzzy", limit: 5 },
      new AbortController().signal,
      undefined,
      ctx,
    ),
    /index unavailable/,
  );
  assert.equal(rgCalled, false, "fuzzy must not silently degrade to rg");
});

test("search aggregates files/count output and filters by path prefix", async () => {
  const { tools, register } = fakeRegister();
  const finder = {
    isDestroyed: false,
    destroy() { finder.isDestroyed = true; },
    async waitForScan() { return { ok: true as const, value: true }; },
    grep(_pattern: string, options: { cursor?: unknown }) {
      const page = options.cursor === null || options.cursor === undefined ? 0 : 1;
      const items = page === 0
        ? [
            { relativePath: "src/a.ts", lineNumber: 1, lineContent: "hit" },
            { relativePath: "other/b.ts", lineNumber: 2, lineContent: "hit" },
          ]
        : [
            { relativePath: "src/a.ts", lineNumber: 9, lineContent: "hit" },
            { relativePath: "src/c.ts", lineNumber: 4, lineContent: "hit" },
          ];
      return {
        ok: true as const,
        value: {
          items,
          totalMatched: items.length,
          totalFilesSearched: 3,
          nextCursor: page === 0 ? ({ _offset: 1 } as never) : null,
        },
      };
    },
  };
  registerFff(register, { createFinder: () => ({ ok: true, value: finder }) as never });
  const search = tools.find((tool) => tool.name === "search");
  assert.ok(search);
  const ctx = { cwd: join(tmpdir(), "pi-fff-aggregate") } as unknown as ExtensionContext;

  const files = await search.execute(
    "search-files",
    { pattern: "hit", path: "src", output: "files", limit: 10 },
    new AbortController().signal,
    undefined,
    ctx,
  );
  assert.equal(files.content[0]?.text, "src/a.ts\nsrc/c.ts");

  const counts = await search.execute(
    "search-count",
    { pattern: "hit", path: "src", output: "count", limit: 10 },
    new AbortController().signal,
    undefined,
    ctx,
  );
  assert.equal(counts.content[0]?.text, "src/a.ts:2\nsrc/c.ts:1");
});

test("search routes forced-insensitive uppercase patterns to ripgrep", async () => {
  const { tools, register } = fakeRegister();
  const rgCalls: Array<{ ignoreCase?: boolean }> = [];
  let finderCreated = false;
  registerFff(register, {
    createFinder: () => {
      finderCreated = true;
      return { ok: false, error: "should not be created" } as never;
    },
    runRg: async (request) => {
      rgCalls.push({ ignoreCase: request.ignoreCase });
      return { text: "src/a.ts:1: HIT", limitReached: false };
    },
  });
  const search = tools.find((tool) => tool.name === "search");
  assert.ok(search);
  const ctx = { cwd: join(tmpdir(), "pi-fff-insensitive") } as unknown as ExtensionContext;
  const result = await search.execute(
    "search-icase",
    { pattern: "Needle", ignoreCase: true, limit: 5 },
    new AbortController().signal,
    undefined,
    ctx,
  );
  assert.equal(finderCreated, false, "forced-insensitive uppercase goes straight to rg");
  assert.equal(rgCalls[0]?.ignoreCase, true);
  assert.match(result.content[0]?.text ?? "", /engine: rg/);
});

test("ripgrep fallback argv mirrors the FFF engine's case semantics", () => {
  const base = { pattern: "needle", regex: false, path: "/w", context: 0, output: "lines" as const, limit: 10 };
  assert.ok(buildArgs({ ...base, ignoreCase: undefined }).includes("--smart-case"));
  assert.ok(buildArgs({ ...base, ignoreCase: true }).includes("--ignore-case"));
  const sensitive = buildArgs({ ...base, ignoreCase: false });
  assert.ok(!sensitive.includes("--ignore-case") && !sensitive.includes("--smart-case"));
  assert.ok(buildArgs({ ...base, ignoreCase: undefined }).includes("--fixed-strings"));
  assert.ok(!buildArgs({ ...base, ignoreCase: undefined, regex: true }).includes("--fixed-strings"));
});

test("search surfaces the index's regex-to-literal fallback as a note", async () => {
  const { tools, register } = fakeRegister();
  const finder = {
    isDestroyed: false,
    destroy() { finder.isDestroyed = true; },
    async waitForScan() { return { ok: true as const, value: true }; },
    grep() {
      return {
        ok: true as const,
        value: {
          items: [{ relativePath: "src/a.ts", lineNumber: 1, lineContent: "foo(" }],
          totalMatched: 1,
          totalFilesSearched: 1,
          nextCursor: null,
          regexFallbackError: "unclosed group",
        },
      };
    },
  };
  registerFff(register, { createFinder: () => ({ ok: true, value: finder }) as never });
  const search = tools.find((tool) => tool.name === "search");
  assert.ok(search);
  const ctx = { cwd: join(tmpdir(), "pi-fff-regex-fallback") } as unknown as ExtensionContext;
  const result = await search.execute(
    "search-regex-fallback",
    { pattern: "foo(", mode: "regex", limit: 5 },
    new AbortController().signal,
    undefined,
    ctx,
  );
  assert.match(result.content[0]?.text ?? "", /src\/a\.ts:1: foo\(/);
  assert.match(result.content[0]?.text ?? "", /invalid regex — matched literally \(unclosed group\)/);
});
