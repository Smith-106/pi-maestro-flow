/**
 * OpenCodeReview tool — wraps the `ocr` CLI.
 *
 * Actions:
 * - preview / rules: `ocr delegate …` — deterministic file selection and rule
 *   resolution. No LLM is involved on the OCR side; the host agent performs the
 *   review itself.
 * - review: `ocr review --audience agent --format json` — OCR-managed review.
 *   The current pi model is injected via OCR_LLM_* env vars, so no separate
 *   `ocr config provider` step is required.
 * - health: `ocr version` + `ocr llm test` (with the same env injection).
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadOcrConfig } from "../ocr-review/config.ts";
import type { FlowToolResult } from "./tool-result.ts";

export interface OcrReviewInput {
  action?: "review" | "preview" | "rules" | "health";
  commit?: string;
  from?: string;
  to?: string;
  resume?: string;
  /** File paths for action=rules. */
  paths?: string[];
  background?: string;
  exclude?: string;
  /** Repository root; defaults to ctx.cwd. */
  repo?: string;
  /** Per-file-group OCR timeout in minutes (review action). */
  timeoutMinutes?: number;
  /** Wall-clock cap for the whole ocr process in minutes. */
  overallTimeoutMinutes?: number;
  /**
   * Review model override: "provider/modelId" or "session" (default). Falls
   * back to the api-manager.json `ocr.modelRef` pin, then the session model.
   */
  model?: string;
}

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUTS: Record<string, number> = {
  preview: 120_000,
  rules: 120_000,
  health: 90_000,
  review: 45 * 60_000,
};

// ---------------------------------------------------------------------------
// Install probe — PATH scan honoring PATHEXT so a missing `ocr` reports a clean
// install hint instead of a spawn ENOENT.
// ---------------------------------------------------------------------------

let ocrPresent: boolean | undefined;

/** Probe PATH (PATHEXT-aware) so a missing install reports a clean install hint. */
export function ocrInstalled(): boolean {
  if (ocrPresent !== undefined) return ocrPresent;
  const dirs = (process.env.PATH ?? "").split(delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  outer: for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, `ocr${ext.toLowerCase()}`);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          ocrPresent = true;
          break outer;
        }
      } catch {
        // keep scanning
      }
    }
  }
  return (ocrPresent ??= false);
}

// ---------------------------------------------------------------------------
// Process runner
// ---------------------------------------------------------------------------

interface OcrRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

class OcrError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(message: string, opts: { exitCode?: number | null; stderr?: string } = {}) {
    super(message);
    this.name = "OcrError";
    this.exitCode = opts.exitCode ?? null;
    this.stderr = opts.stderr ?? "";
  }
}

function quoteCmdArg(arg: string): string {
  if (!/[\s"&|<>^%]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

async function runOcr(
  args: string[],
  opts: { cwd: string; env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal },
): Promise<OcrRunResult> {
  if (!ocrInstalled()) {
    throw new OcrError(
      "ocr CLI not found on PATH. Install with: npm i -g @alibaba-group/open-code-review",
    );
  }
  const { cwd, signal } = opts;
  const timeoutMs = opts.timeoutMs ?? 120_000;

  // Bare "ocr" + cmd.exe on Windows: cmd resolves the npm ocr.cmd shim itself,
  // which sidesteps spawn's broken quoting of absolute .cmd paths.
  const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "ocr";
  const spawnArgs = process.platform === "win32"
    ? ["/d", "/s", "/c", "ocr", ...args.map(quoteCmdArg)]
    : args;

  return await new Promise<OcrRunResult>((resolvePromise, rejectPromise) => {
    const child = spawn(command, spawnArgs, {
      cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let aborted = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const kill = () => {
      if (child.killed) return;
      if (process.platform === "win32" && child.pid !== undefined) {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        child.kill("SIGTERM");
      }
    };
    const onAbort = () => {
      aborted = true;
      kill();
      finish(() => rejectPromise(new OcrError("ocr run aborted.")));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }

    const collect = (sink: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        kill();
        finish(() => rejectPromise(new OcrError(`ocr output exceeded ${MAX_OUTPUT_BYTES}-byte limit.`)));
        return;
      }
      sink.push(chunk);
    };
    child.stdout.on("data", collect(stdoutChunks));
    child.stderr.on("data", collect(stderrChunks));

    child.on("error", (error) => {
      finish(() => rejectPromise(new OcrError(`Failed to start ocr: ${error.message}`)));
    });
    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      finish(() => {
        if (aborted) return;
        if (code === 0) {
          resolvePromise({ stdout, stderr, exitCode: 0 });
          return;
        }
        rejectPromise(new OcrError(
          stderr || stdout || `ocr exited with code ${code ?? 1}`,
          { exitCode: code, stderr },
        ));
      });
    });

    timer = setTimeout(() => {
      kill();
      finish(() => rejectPromise(new OcrError(
        `ocr timed out after ${Math.round(timeoutMs / 1000)}s.`,
      )));
    }, timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// Model injection — pi api-manager provider → OCR_LLM_* env overlay.
// Resolution order inside ocr is env > config.json, so this needs no writes to
// the user's ~/.opencodereview/config.json.
// ---------------------------------------------------------------------------

const API_TO_OCR_PROTOCOL: Record<string, string> = {
  "anthropic-messages": "anthropic",
  "openai-completions": "openai",
  "openai-responses": "openai-responses",
};

/** Exported for tests: encodes a header map into OCR_LLM_EXTRA_HEADERS format. */
export function encodeExtraHeaders(headers: Record<string, string | null>): string {
  // OCR splits on unquoted commas; quote values that contain commas/quotes.
  // Pi uses null to remove a configured header, so it must not reach the CLI.
  return Object.entries(headers)
    .flatMap(([key, value]) => {
      if (value === null) return [];
      const safe = /[",\n]/.test(value) ? `"${value.replace(/"/g, "")}"` : value;
      return [`${key}=${safe}`];
    })
    .join(",");
}

/** Resolve the review model: explicit param > api-manager ocr.modelRef pin > session model. */
async function resolveReviewModel(
  ctx: ExtensionContext,
  override?: string,
): Promise<NonNullable<ExtensionContext["model"]>> {
  const sessionModel = ctx.model;
  const persisted = override?.trim()
    ? undefined
    : await loadOcrConfig(join(getAgentDir(), "api-manager.json")).catch(() => undefined);
  const modelRef = override?.trim() || persisted?.modelRef || "session";
  if (modelRef === "session") {
    if (!sessionModel) {
      throw new OcrError("No active model in this session — cannot inject OCR_LLM_* env.");
    }
    return sessionModel;
  }
  const slash = modelRef.indexOf("/");
  if (slash <= 0 || slash === modelRef.length - 1) {
    throw new OcrError(`Invalid model ref "${modelRef}" — expected "provider/modelId" or "session".`);
  }
  const provider = modelRef.slice(0, slash);
  const id = modelRef.slice(slash + 1);
  const all = typeof ctx.modelRegistry?.getAll === "function" ? ctx.modelRegistry.getAll() : [];
  const pinned = all.find((entry) => entry.provider === provider && entry.id === id);
  if (pinned) return pinned;
  if (sessionModel) return sessionModel;
  throw new OcrError(
    `Pinned review model "${modelRef}" is not registered and no session model is available.`,
  );
}

export async function resolveOpenCodeReviewLlmEnv(
  ctx: ExtensionContext,
  modelOverride?: string,
): Promise<Record<string, string>> {
  const model = await resolveReviewModel(ctx, modelOverride);
  const protocol = API_TO_OCR_PROTOCOL[model.api];
  if (!protocol) {
    throw new OcrError(
      `Model api "${model.api}" is not supported by OpenCodeReview (needs anthropic|openai|openai-responses). ` +
      `Use action=preview + action=rules and review with the host agent instead.`,
    );
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    throw new OcrError(
      `Authentication for review model "${model.provider}/${model.id}" is unavailable: ${auth.error}`,
    );
  }
  if (!auth.apiKey) {
    throw new OcrError(
      `No API key resolved for review model "${model.provider}/${model.id}". ` +
      `Configure it via /api-manager, or use action=preview + action=rules (no LLM needed).`,
    );
  }
  const baseUrl = auth.baseUrl || model.baseUrl;
  if (!baseUrl) {
    throw new OcrError(`No gateway URL resolved for review model "${model.provider}/${model.id}".`);
  }

  const env: Record<string, string> = {
    OCR_LLM_URL: baseUrl,
    OCR_LLM_TOKEN: auth.apiKey,
    OCR_LLM_MODEL: model.id,
    OCR_LLM_PROTOCOL: protocol,
  };
  if (auth.headers && Object.keys(auth.headers).length > 0) {
    env.OCR_LLM_EXTRA_HEADERS = encodeExtraHeaders(auth.headers);
  }
  return env;
}

// ---------------------------------------------------------------------------
// Argument building + action dispatch
// ---------------------------------------------------------------------------

/** Exported for tests: maps review scope params to ocr CLI flags, rejecting bad combinations. */
export function scopeArgs(params: OcrReviewInput): string[] {
  const hasRange = params.from !== undefined || params.to !== undefined;
  if (hasRange && (!params.from || !params.to)) {
    throw new OcrError("Both 'from' and 'to' are required for a range review.");
  }
  if (params.commit && hasRange) {
    throw new OcrError("Use either 'commit' or 'from'/'to', not both.");
  }
  if (params.resume && (params.commit || hasRange)) {
    throw new OcrError("'resume' cannot be combined with 'commit' or 'from'/'to'.");
  }
  const args: string[] = [];
  if (params.commit) args.push("--commit", params.commit);
  if (params.from) args.push("--from", params.from);
  if (params.to) args.push("--to", params.to);
  if (params.exclude) args.push("--exclude", params.exclude);
  return args;
}

function okText(text: string): FlowToolResult {
  return { content: [{ type: "text", text }], details: {} };
}

function errText(text: string): FlowToolResult {
  return { content: [{ type: "text", text }], isError: true, details: {} };
}

export async function executeOcrReview(
  params: OcrReviewInput,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<FlowToolResult> {
  const action = params.action ?? "review";
  const repo = params.repo ? resolve(ctx.cwd, params.repo) : ctx.cwd;

  try {
    switch (action) {
      case "preview": {
        const args = ["delegate", "preview", "--format", "json", "--repo", repo, ...scopeArgs(params)];
        const bg = await writeBackgroundFile(params.background);
        try {
          if (bg) args.push("--background-file", bg.path);
          const result = await runOcr(args, { cwd: repo, timeoutMs: DEFAULT_TIMEOUTS.preview, signal });
          return okText(result.stdout || "No files changed.");
        } finally {
          await bg?.cleanup();
        }
      }

      case "rules": {
        const paths = params.paths?.filter((p) => typeof p === "string" && p.length > 0) ?? [];
        if (paths.length === 0) {
          return errText("action=rules requires non-empty 'paths' (files from a preview run).");
        }
        const args = ["delegate", "rule", "--format", "json", "--repo", repo, ...paths];
        const result = await runOcr(args, { cwd: repo, timeoutMs: DEFAULT_TIMEOUTS.rules, signal });
        return okText(result.stdout || "No rules matched.");
      }

      case "health": {
        let envError: string | undefined;
        const env = await resolveOpenCodeReviewLlmEnv(ctx, params.model).catch((error: unknown) => {
          envError = error instanceof Error ? error.message : String(error);
          return undefined;
        });
        const [version, llm] = await Promise.allSettled([
          runOcr(["version"], { cwd: repo, timeoutMs: 30_000, signal }),
          env
            ? runOcr(["llm", "test"], { cwd: repo, env, timeoutMs: DEFAULT_TIMEOUTS.health, signal })
            : Promise.resolve(undefined),
        ]);
        const parts: string[] = [];
        if (version.status === "fulfilled") parts.push(version.value.stdout || "ocr version ok");
        else parts.push(`version: ${version.reason instanceof Error ? version.reason.message : String(version.reason)}`);
        if (!env) {
          parts.push(`llm: skipped — ${envError ?? "model not injectable"}`);
        } else if (llm.status === "fulfilled") {
          parts.push(`llm: ${llm.value?.stdout || "ok"}`);
        } else {
          parts.push(`llm: ${llm.reason instanceof Error ? llm.reason.message : String(llm.reason)}`);
        }
        const failed = version.status === "rejected" || (env !== undefined && llm.status === "rejected");
        return { content: [{ type: "text", text: parts.join("\n") }], isError: failed, details: {} };
      }

      case "review": {
        const env = await resolveOpenCodeReviewLlmEnv(ctx, params.model);
        const tmp = await mkdtemp(join(tmpdir(), "ocr-review-"));
        const outputPath = join(tmp, "result.json");
        try {
          const args = [
            "review", "--audience", "agent", "--format", "json",
            "--output", outputPath, "--repo", repo,
            ...scopeArgs(params),
          ];
          if (params.resume) args.push("--resume", params.resume);
          if (params.timeoutMinutes) args.push("--timeout", String(params.timeoutMinutes));
          const bg = await writeBackgroundFile(params.background, tmp);
          if (bg) args.push("--background-file", bg.path);
          const timeoutMs = (params.overallTimeoutMinutes ?? 45) * 60_000;
          await runOcr(args, { cwd: repo, env, timeoutMs, signal });
          let body = "";
          try {
            body = await readFile(outputPath, "utf8");
          } catch {
            // fall back to stdout summary below
          }
          const text = body.trim() || "(ocr produced no output file)";
          return okText(text);
        } finally {
          await rm(tmp, { recursive: true, force: true });
        }
      }
    }
  } catch (error) {
    return errText(error instanceof Error ? error.message : String(error));
  }
}

async function writeBackgroundFile(
  background: string | undefined,
  dir?: string,
): Promise<{ path: string; cleanup: () => Promise<void> } | undefined> {
  if (!background?.trim()) return undefined;
  const own = dir === undefined;
  const targetDir = dir ?? await mkdtemp(join(tmpdir(), "ocr-bg-"));
  const path = join(targetDir, "background.md");
  await writeFile(path, background, "utf8");
  return {
    path,
    cleanup: async () => {
      if (own) await rm(targetDir, { recursive: true, force: true });
    },
  };
}
