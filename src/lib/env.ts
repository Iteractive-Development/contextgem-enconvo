import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PreferenceManageUtils } from "@enconvo/api";
import type { Bridge } from "./bridge";
import { startChatBridge, startDecisionBridge } from "./bridge";
import type { ResolvedLlm } from "./llm";

export const EXTENSION_NAME = "contextgem-enconvo";

/** ContextGem 1.5.0 declares Requires-Python >=3.11,<3.15. */
const PY_MIN_MINOR = 11;
const PY_MAX_MINOR = 14;

const MAX_TEXT_CHARS = 5_000_000;

export type ErrorCode =
    | "BAD_INPUT"
    | "BAD_SPEC"
    | "NOT_FOUND"
    | "LLM_UNAVAILABLE"
    | "SETUP_REQUIRED"
    | "NO_PYTHON"
    | "VENV_FAILED"
    | "INSTALL_FAILED"
    | "RUNNER_MISSING"
    | "RUNNER_ERROR"
    | "EXTRACTION_FAILED"
    | "TIMEOUT";

export class ContextGemError extends Error {
    code: ErrorCode;
    status: number;
    hint?: string;

    constructor(code: ErrorCode, message: string, status: number, hint?: string) {
        super(message);
        this.code = code;
        this.status = status;
        this.hint = hint;
    }
}

export const SETUP_HINT = "POST {} to /api/contextgem-enconvo/setup, or run ContextGem Doctor with the input setup.";

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

export interface RunResult {
    code: number;
    stdout: string;
    stderr: string;
}

/** Run a process to completion; `input` goes to stdin (used for jobs that carry bridge tokens, so they never touch disk). */
export function run(
    cmd: string,
    args: string[],
    timeoutMs: number,
    opts: { input?: string; env?: Record<string, string> } = {}
): Promise<RunResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, {
            stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
            env: { ...process.env, ...(opts.env || {}) },
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                child.kill("SIGKILL");
                reject(new ContextGemError("TIMEOUT", `${path.basename(cmd)} did not finish within ${Math.round(timeoutMs / 1000)}s`, 504));
            }
        }, timeoutMs);
        child.stdout!.on("data", (d: Buffer) => {
            if (stdout.length < 200_000) stdout += d.toString();
        });
        child.stderr!.on("data", (d: Buffer) => {
            if (stderr.length < 200_000) stderr += d.toString();
        });
        child.on("error", (err) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                reject(new ContextGemError("RUNNER_ERROR", `could not start ${path.basename(cmd)}: ${err.message}`, 500));
            }
        });
        child.on("close", (code) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve({ code: code ?? -1, stdout, stderr });
            }
        });
        if (opts.input !== undefined && child.stdin) {
            child.stdin.on("error", () => {
                // the child may exit before reading everything; its exit code tells the story
            });
            child.stdin.end(opts.input);
        }
    });
}

// ---------------------------------------------------------------------------
// Paths and environment detection
// ---------------------------------------------------------------------------

/** Where the plugin keeps its private venv and where its bundled runner lives (both deterministic per extension). */
export function paths() {
    const home = os.homedir();
    const support = path.join(home, ".config", "enconvo", ".support", EXTENSION_NAME);
    const assets = path.join(home, ".config", "enconvo", "extension", EXTENSION_NAME, "assets");
    const venvDir = path.join(support, "venv");
    return {
        support,
        venvDir,
        venvPython: path.join(venvDir, "bin", "python"),
        runner: path.join(assets, "python", "runner.py"),
    };
}

export interface PythonPick {
    bin: string;
    version: string;
}

/** Find a Python the framework supports: the preference if set, else the usual names, newest tested first. */
export async function detectPython(pref?: string): Promise<PythonPick | null> {
    const candidates = [
        ...(pref && pref.trim() ? [pref.trim()] : []),
        "python3.13",
        "python3.12",
        "python3.14",
        "python3.11",
        "python3",
    ];
    for (const bin of candidates) {
        try {
            const res = await run(bin, ["--version"], 10_000);
            const m = `${res.stdout}\n${res.stderr}`.match(/Python (\d+)\.(\d+)\.(\d+)/);
            if (res.code === 0 && m) {
                const major = parseInt(m[1], 10);
                const minor = parseInt(m[2], 10);
                if (major === 3 && minor >= PY_MIN_MINOR && minor <= PY_MAX_MINOR) {
                    return { bin, version: `${major}.${minor}.${m[3]}` };
                }
            }
        } catch {
            // not installed; try the next name
        }
    }
    return null;
}

export async function findUv(): Promise<string | null> {
    for (const bin of [path.join(os.homedir(), ".local", "bin", "uv"), "/opt/homebrew/bin/uv", "/usr/local/bin/uv", "uv"]) {
        try {
            const res = await run(bin, ["--version"], 10_000);
            if (res.code === 0) return bin;
        } catch {
            // keep looking
        }
    }
    return null;
}

export function venvReady(): boolean {
    try {
        return fs.statSync(paths().venvPython).isFile();
    } catch {
        return false;
    }
}

export function runnerPresent(): boolean {
    try {
        return fs.statSync(paths().runner).isFile();
    } catch {
        return false;
    }
}

async function pythonProbe(snippet: string, timeoutMs = 60_000): Promise<{ ok: boolean; out: string }> {
    if (!venvReady()) return { ok: false, out: "" };
    try {
        const res = await run(paths().venvPython, ["-c", snippet], timeoutMs, { env: { PYTHONNOUSERSITE: "1" } });
        return { ok: res.code === 0, out: res.stdout.trim() };
    } catch {
        return { ok: false, out: "" };
    }
}

export async function contextgemVersion(): Promise<string | null> {
    const probe = await pythonProbe("import importlib.metadata as m, contextgem; print(m.version('contextgem'))");
    return probe.ok && probe.out ? probe.out : null;
}

export async function doclingAvailable(): Promise<boolean> {
    return (await pythonProbe("import docling.document_converter")).ok;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/** Create the private venv and install contextgem into it. Idempotent: safe to run again to upgrade or repair. */
export async function setupEnvironment(opts: { installDocling?: boolean; pythonPref?: string } = {}): Promise<string[]> {
    const steps: string[] = [];
    const { support, venvDir, venvPython } = paths();
    fs.mkdirSync(support, { recursive: true });
    const uv = await findUv();

    if (!venvReady()) {
        const py = await detectPython(opts.pythonPref);
        if (!py) {
            throw new ContextGemError(
                "NO_PYTHON",
                `no Python 3.${PY_MIN_MINOR}-3.${PY_MAX_MINOR} found on this Mac`,
                409,
                "Install one (for example `brew install python@3.13`) or set the Python Binary preference."
            );
        }
        steps.push(`using ${py.bin} (Python ${py.version})`);
        const res = uv
            ? await run(uv, ["venv", "--python", py.bin, venvDir], 180_000)
            : await run(py.bin, ["-m", "venv", venvDir], 300_000);
        if (res.code !== 0) {
            throw new ContextGemError("VENV_FAILED", `creating the venv failed: ${res.stderr.trim().slice(-400)}`, 500);
        }
        steps.push(`created venv at ${venvDir}${uv ? " with uv" : ""}`);
    } else {
        steps.push(`venv already present at ${venvDir}`);
    }

    const pkg = opts.installDocling ? "contextgem[docling]" : "contextgem";
    const budget = opts.installDocling ? 1_800_000 : 600_000;
    let res: RunResult;
    if (uv) {
        res = await run(uv, ["pip", "install", "--python", venvPython, "-U", pkg], budget);
    } else {
        const ensure = await run(venvPython, ["-m", "ensurepip", "--upgrade"], 180_000);
        if (ensure.code !== 0) {
            throw new ContextGemError("INSTALL_FAILED", `bootstrapping pip failed: ${ensure.stderr.trim().slice(-400)}`, 500);
        }
        res = await run(venvPython, ["-m", "pip", "install", "-U", pkg], budget);
    }
    if (res.code !== 0) {
        throw new ContextGemError("INSTALL_FAILED", `installing ${pkg} failed: ${res.stderr.trim().slice(-500)}`, 500);
    }
    steps.push(`installed ${pkg}`);

    const version = await contextgemVersion();
    if (!version) {
        throw new ContextGemError("INSTALL_FAILED", "contextgem is still not importable after the install", 500);
    }
    steps.push(`contextgem ${version} importable`);
    if (opts.installDocling) {
        steps.push((await doclingAvailable()) ? "docling importable" : "docling did not import after the install");
    }
    return steps;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface Config {
    /** "jev" routes closed questions to Enconvo's Jev through the decision bridge; "" sends everything to the LLM. */
    decision_engine: string;
    python_bin: string;
    install_docling: boolean;
    timeout_seconds: number;
}

type Partial_ = Partial<Config>;

function str(v: unknown): string {
    return typeof v === "string" ? v.trim() : "";
}

function flatPrefs(info: unknown): Record<string, unknown> {
    const source = (info ?? {}) as Record<string, unknown>;
    return ((source.preferences as Record<string, unknown> | undefined) ?? source) as Record<string, unknown>;
}

function readPrefs(prefs: Record<string, unknown>): Partial_ {
    const out: Partial_ = {};
    if (str(prefs.decision_engine) === "jev") out.decision_engine = "jev";
    if (str(prefs.python_bin)) out.python_bin = str(prefs.python_bin);
    const docling = prefs.install_docling;
    if (docling === true || docling === "true" || docling === 1 || docling === "1") out.install_docling = true;
    if (docling === false || docling === "false" || docling === 0 || docling === "0") out.install_docling = false;
    const t = typeof prefs.timeout_seconds === "number" ? prefs.timeout_seconds : parseInt(str(prefs.timeout_seconds), 10);
    if (Number.isFinite(t) && t >= 30 && t <= 3600) out.timeout_seconds = t;
    return out;
}

async function readStored(key: string): Promise<Record<string, unknown>> {
    try {
        return flatPrefs(await PreferenceManageUtils.getPreferenceInfo(key));
    } catch {
        return {};
    }
}

/**
 * Resolve the plugin's configuration. A command's request body carries the merged
 * preferences; a Local API route's body does not, so the stored preferences are
 * read through the app. Values in the body always win over stored ones.
 */
export async function resolveConfig(options: Record<string, unknown> = {}): Promise<Config> {
    const body = readPrefs(options);
    const stored = readPrefs(await readStored(EXTENSION_NAME));
    return {
        decision_engine: body.decision_engine ?? stored.decision_engine ?? "",
        python_bin: body.python_bin ?? stored.python_bin ?? "",
        install_docling: body.install_docling ?? stored.install_docling ?? false,
        timeout_seconds: body.timeout_seconds ?? stored.timeout_seconds ?? 600,
    };
}

export function timeoutMsFor(config: Config, override?: unknown): number {
    let seconds = config.timeout_seconds;
    if (typeof override === "number" && override >= 30 && override <= 3600) seconds = override;
    return seconds * 1000;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface StatusReport {
    ok: true;
    ready: boolean;
    python: { found: boolean; bin?: string; version?: string };
    uv: boolean;
    venv: boolean;
    contextgem: { installed: boolean; version?: string };
    docling: boolean;
    runner_bundled: boolean;
    llm: { provider?: string; model?: string; error?: string };
    decision: { engine: string };
}

/** `llm` is what resolveLlm found (or why it found nothing). */
export async function status(config: Config, llm: StatusReport["llm"]): Promise<StatusReport> {
    const py = await detectPython(config.python_bin);
    const uv = (await findUv()) !== null;
    const version = await contextgemVersion();
    const docling = version ? await doclingAvailable() : false;
    return {
        ok: true,
        ready: !!version && runnerPresent(),
        python: py ? { found: true, bin: py.bin, version: py.version } : { found: false },
        uv,
        venv: venvReady(),
        contextgem: { installed: !!version, version: version ?? undefined },
        docling,
        runner_bundled: runnerPresent(),
        llm,
        decision: { engine: config.decision_engine || "none" },
    };
}

// ---------------------------------------------------------------------------
// Extraction jobs
// ---------------------------------------------------------------------------

export interface ExtractInput {
    text?: string;
    file_path?: string;
    aspects?: unknown[];
    concepts?: unknown[];
    engine?: string;
    dry_run?: boolean;
    segmentation?: string;
    llm_provider?: string;
    llm_model?: string;
    /** Direct LiteLLM access (model, api_base, api_key, temperature, …): bypasses the Enconvo provider and both bridges. */
    llm_options?: Record<string, unknown>;
    /** 0-1: how sure Jev must be before a yes is a yes (decision engine only). */
    decision_threshold?: number;
    timeout_seconds?: number;
}

export interface RunnerResult {
    ok: boolean;
    dry_run?: boolean;
    plan?: Record<string, unknown>;
    engine?: string;
    document?: Record<string, unknown>;
    aspects?: Array<Record<string, unknown>>;
    concepts?: Array<Record<string, unknown>>;
    stats?: Record<string, unknown>;
    error?: string;
    error_code?: string;
    traceback?: string;
}

/** Reject what the runner could not handle sensibly before spending a process on it. */
export function validateInput(input: ExtractInput): void {
    const hasText = typeof input.text === "string" && input.text.trim().length > 0;
    const hasFile = typeof input.file_path === "string" && input.file_path.trim().length > 0;
    if (!hasText && !hasFile) {
        throw new ContextGemError("BAD_INPUT", "provide text or file_path", 400);
    }
    if (hasText && hasFile) {
        throw new ContextGemError("BAD_INPUT", "provide either text or file_path, not both", 400);
    }
    if (hasText && input.text!.length > MAX_TEXT_CHARS) {
        throw new ContextGemError(
            "BAD_INPUT",
            `text is ${input.text!.length} characters; the limit is ${MAX_TEXT_CHARS}`,
            400,
            "Pass a file_path (with the docling extra) or split the document."
        );
    }
    if (hasFile) {
        const p = input.file_path!.trim();
        if (!path.isAbsolute(p)) {
            throw new ContextGemError("BAD_INPUT", "file_path must be an absolute path", 400);
        }
        let isFile = false;
        try {
            isFile = fs.statSync(p).isFile();
        } catch {
            isFile = false;
        }
        if (!isFile) {
            throw new ContextGemError("BAD_INPUT", `file_path does not point to a file: ${p}`, 400);
        }
    }
    if (!input.aspects?.length && !input.concepts?.length) {
        throw new ContextGemError(
            "BAD_INPUT",
            "provide aspects or concepts to extract, or name a saved pipeline",
            400,
            'Example: {"text": "...", "concepts": [{"type": "string", "name": "headline", "description": "the headline"}]}'
        );
    }
}

interface BuiltJob {
    job: Record<string, unknown>;
    /** true when llm_options named its own model, so neither bridge is used. */
    direct: boolean;
    /** true when the decision bridge is part of the job. */
    decisions: boolean;
}

/**
 * Build the runner job. In the default mode the LLM and (when enabled) Jev are
 * reached through localhost bridges, so their tokens are the only secrets in the
 * job and live for the job's lifetime. With `llm_options.model` set, the request
 * brings its own endpoint and both bridges are skipped.
 */
export function buildJob(
    input: ExtractInput,
    config: Config,
    llm: ResolvedLlm,
    bridges: { chat: { url: string; token: string }; decisions: { url: string; token: string } | null }
): BuiltJob {
    const job: Record<string, unknown> = {};
    if (input.text) job.text = input.text;
    if (input.file_path) job.file_path = input.file_path.trim();
    if (input.aspects?.length) job.aspects = input.aspects;
    if (input.concepts?.length) job.concepts = input.concepts;
    if (input.engine) job.engine = input.engine;
    if (input.dry_run) job.dry_run = true;
    if (input.segmentation) job.segmentation = input.segmentation;

    const overrides = input.llm_options ?? {};
    const direct = typeof overrides.model === "string" && (overrides.model as string).trim() !== "";
    const llmSection: Record<string, unknown> = direct
        ? {}
        : {
              model: `openai/${llm.model}`,
              api_base: bridges.chat.url,
              api_key: bridges.chat.token,
          };
    for (const [k, v] of Object.entries(overrides)) {
        if (v !== undefined && v !== null && v !== "") llmSection[k] = v;
    }
    if (!llmSection.model) {
        throw new ContextGemError(
            "LLM_UNAVAILABLE",
            "llm_options needs a model when it overrides the Enconvo provider",
            400
        );
    }
    job.llm = llmSection;

    const useJev = config.decision_engine === "jev" && !direct;
    if (useJev) {
        const dm: Record<string, unknown> = {
            model: "typesafe/jev-latest",
            api_base: bridges.decisions!.url,
            api_key: bridges.decisions!.token,
        };
        if (typeof input.decision_threshold === "number") {
            dm.decision_threshold = Math.min(1, Math.max(0, input.decision_threshold));
        }
        job.decision_model = dm;
    }
    return { job, direct, decisions: useJev };
}

function redact(text: string, secrets: string[]): string {
    let out = text;
    for (const secret of secrets) {
        if (secret.length >= 6) out = out.split(secret).join("***");
    }
    return out;
}

function secretsIn(job: Record<string, unknown>): string[] {
    const found: string[] = [];
    for (const section of ["llm", "decision_model"]) {
        const key = (job[section] as Record<string, unknown> | undefined)?.api_key;
        if (typeof key === "string" && key) found.push(key);
    }
    return found;
}

/** Bridge to the bundled Python runner: job in on stdin, result back through a private temp file. */
export async function runExtractJob(job: Record<string, unknown>, timeoutMs: number): Promise<RunnerResult> {
    if (!venvReady() || !(await contextgemVersion())) {
        throw new ContextGemError("SETUP_REQUIRED", "the ContextGem Python environment is not set up", 409, SETUP_HINT);
    }
    const { venvPython, runner } = paths();
    if (!runnerPresent()) {
        throw new ContextGemError("RUNNER_MISSING", `runner script not found at ${runner}`, 500, "Reinstall the plugin.");
    }

    const secrets = secretsIn(job);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "contextgem-")); // mode 0700
    const outPath = path.join(dir, "out.json");
    try {
        const res = await run(venvPython, [runner, outPath], timeoutMs, {
            input: JSON.stringify(job),
            env: { PYTHONNOUSERSITE: "1", PYTHONIOENCODING: "utf-8" },
        });
        let parsed: RunnerResult | null = null;
        try {
            parsed = JSON.parse(fs.readFileSync(outPath, "utf-8")) as RunnerResult;
        } catch {
            parsed = null;
        }
        if (parsed) {
            if (parsed.ok) return parsed;
            const message = redact(parsed.error || "the extraction failed", secrets);
            if (parsed.error_code === "BAD_SPEC") {
                const docling = message.startsWith("DOCLING_MISSING:");
                throw new ContextGemError(
                    docling ? "SETUP_REQUIRED" : "BAD_SPEC",
                    docling ? message.replace("DOCLING_MISSING: ", "") : message,
                    docling ? 409 : 400
                );
            }
            throw new ContextGemError(
                "EXTRACTION_FAILED",
                message,
                502,
                "Check the LLM Model preference (provider, model) and, for closed questions, the Jev decision engine; its decisions need an Enconvo Cloud sign-in with points."
            );
        }
        const tail = redact((res.stderr || res.stdout).trim().slice(-400), secrets);
        throw new ContextGemError("RUNNER_ERROR", `the runner exited with ${res.code} and no result${tail ? `: ${tail}` : ""}`, 500);
    } finally {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch {
            // best effort
        }
    }
}

/**
 * One extraction end to end: start the bridges the request needs, run the job,
 * always close the bridges. `llm_options.model` skips both bridges and talks to
 * the endpoint the request names.
 */
export async function runExtraction(input: ExtractInput, config: Config, llm: ResolvedLlm): Promise<RunnerResult> {
    const direct = typeof input.llm_options?.model === "string" && String(input.llm_options.model).trim() !== "";
    const needsDecisions = config.decision_engine === "jev" && !direct;
    const chat = direct ? null : await startChatBridge(llm.instance);
    const decisions = needsDecisions ? await startDecisionBridge() : null;
    try {
        const bridges = { chat: chat ?? { url: "", token: "" }, decisions };
        const built = buildJob(input, config, llm, bridges);
        return await runExtractJob(built.job, timeoutMsFor(config, input.timeout_seconds));
    } finally {
        await chat?.close();
        await decisions?.close();
    }
}

// ---------------------------------------------------------------------------
// HTTP helpers for routes
// ---------------------------------------------------------------------------

export async function readJson<T = Record<string, unknown>>(request: Request): Promise<T> {
    const text = await request.text();
    if (!text.trim()) return {} as T;
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as T;
    } catch {
        // fall through
    }
    throw new ContextGemError("BAD_INPUT", "the request body must be a JSON object", 400);
}

export function errorResponse(error: unknown): Response {
    if (error instanceof ContextGemError) {
        return Response.json({ ok: false, code: error.code, error: error.message, hint: error.hint }, { status: error.status });
    }
    return Response.json(
        { ok: false, code: "UNEXPECTED", error: error instanceof Error ? error.message : String(error) },
        { status: 500 }
    );
}

/** The same failure for commands, as readable text. */
export function explain(error: unknown): string {
    if (error instanceof ContextGemError) {
        return `${error.message} (${error.code})${error.hint ? `\n${error.hint}` : ""}`;
    }
    return error instanceof Error ? error.message : String(error);
}
