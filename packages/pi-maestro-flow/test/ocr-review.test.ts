import assert from "node:assert/strict";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, statSync } from "node:fs";
import test from "node:test";
import { Check } from "typebox/value";
import { OcrReviewParams } from "../src/extension/schemas.ts";
import {
  encodeExtraHeaders,
  executeOcrReview,
  resolveOpenCodeReviewLlmEnv,
  scopeArgs,
} from "../src/tools/ocr-review.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

function ocrOnPath(): boolean {
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  return (process.env.PATH ?? "").split(delimiter).some((dir) =>
    exts.some((ext) => {
      const candidate = join(dir.trim().replace(/^"|"$/g, ""), `ocr${ext.toLowerCase()}`);
      try {
        return existsSync(candidate) && statSync(candidate).isFile();
      } catch {
        return false;
      }
    }),
  );
}

test("ocr-review params schema validates actions and scope flags", () => {
  assert.ok(Check(OcrReviewParams, { action: "preview" }));
  assert.ok(Check(OcrReviewParams, { action: "rules", paths: ["a.ts", "b.ts"] }));
  assert.ok(Check(OcrReviewParams, { action: "review", commit: "abc123", background: "ctx" }));
  assert.ok(Check(OcrReviewParams, { action: "health" }));
  assert.ok(!Check(OcrReviewParams, { action: "bogus" }));
  assert.ok(!Check(OcrReviewParams, { action: "review", extra: 1 }));
});

test("ocr-review scopeArgs maps flags and rejects conflicts", () => {
  assert.deepEqual(scopeArgs({}), []);
  assert.deepEqual(scopeArgs({ commit: "abc" }), ["--commit", "abc"]);
  assert.deepEqual(
    scopeArgs({ from: "main", to: "feat" }),
    ["--from", "main", "--to", "feat"],
  );
  assert.deepEqual(scopeArgs({ exclude: "a,b" }), ["--exclude", "a,b"]);
  assert.throws(() => scopeArgs({ from: "main" }), /from.*to/);
  assert.throws(() => scopeArgs({ commit: "x", from: "a", to: "b" }), /either/i);
  assert.throws(() => scopeArgs({ resume: "s1", commit: "x" }), /resume/i);
});

test("open-code-review encodeExtraHeaders quotes comma values", () => {
  assert.equal(encodeExtraHeaders({}), "");
  assert.equal(encodeExtraHeaders({ "X-A": "1", "X-B": "v2" }), "X-A=1,X-B=v2");
  assert.equal(encodeExtraHeaders({ "X-C": "a,b" }), 'X-C="a,b"');
  assert.equal(encodeExtraHeaders({ "X-Keep": "yes", "X-Removed": null }), "X-Keep=yes");
});

test("open-code-review inherits runtime-resolved API manager gateway auth", async () => {
  const model = {
    provider: "managed-gateway",
    id: "review-model",
    api: "openai-responses",
    baseUrl: "https://stale.example/v1",
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
  const ctx = {
    cwd: process.cwd(),
    model,
    modelRegistry: {
      async getApiKeyAndHeaders(received: unknown) {
        assert.equal(received, model);
        return {
          ok: true as const,
          apiKey: "runtime-token",
          baseUrl: "https://gateway.example/v1",
          headers: { "X-Gateway": "active", "X-Route": "review" },
        };
      },
    },
  } as unknown as ExtensionContext;

  assert.deepEqual(await resolveOpenCodeReviewLlmEnv(ctx, "session"), {
    OCR_LLM_URL: "https://gateway.example/v1",
    OCR_LLM_TOKEN: "runtime-token",
    OCR_LLM_MODEL: "review-model",
    OCR_LLM_PROTOCOL: "openai-responses",
    OCR_LLM_EXTRA_HEADERS: "X-Gateway=active,X-Route=review",
  });
});

test("open-code-review preview returns JSON file selection (requires ocr)", { skip: !ocrOnPath(), timeout: 120_000 }, async () => {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const ctx = { cwd: repo, model: undefined } as unknown as ExtensionContext;
  const result = await executeOcrReview({ action: "preview" }, undefined, ctx);
  assert.notEqual(result.isError, true);
  const text = result.content.find((item) => item.type === "text");
  const parsed = JSON.parse(text && "text" in text ? text.text : "{}") as {
    schema_version?: string;
    mode?: string;
    reviewable_files?: unknown[];
  };
  assert.equal(parsed.schema_version, "1");
  assert.ok(["workspace", "range", "commit"].includes(parsed.mode ?? ""));
  assert.ok(Array.isArray(parsed.reviewable_files));
});
