import type { RunnerResult, StatusReport } from "./env";

const MAX_INLINE_JSON = 6000;

function truncate(value: string, max = 140): string {
    const flat = value.replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function fmtValue(value: unknown): string {
    if (value === null || value === undefined) return "∅";
    if (typeof value === "string") return `"${truncate(value)}"`;
    if (typeof value === "boolean" || typeof value === "number") return String(value);
    return truncate(JSON.stringify(value));
}

type Row = Record<string, unknown>;

function itemsOf(row: Row): Row[] {
    return Array.isArray(row.items) ? (row.items as Row[]) : [];
}

function describeItems(row: Row, limit: number): string {
    const items = itemsOf(row);
    if (!items.length) return "no items";
    const shown = items
        .slice(0, limit)
        .map((i) => fmtValue(i.value))
        .join(" · ");
    return `${items.length} item(s) — ${shown}${items.length > limit ? " …" : ""}`;
}

function aspectLines(aspects: Row[], depth: number): string[] {
    const lines: string[] = [];
    for (const a of aspects) {
        lines.push(`${"  ".repeat(depth)}- **${String(a.name)}**: ${describeItems(a, 1)}`);
        const concepts = Array.isArray(a.concepts) ? (a.concepts as Row[]) : [];
        for (const c of concepts) {
            lines.push(`${"  ".repeat(depth + 1)}- ${String(c.name)} (${String(c.type)}): ${describeItems(c, 3)}`);
        }
        const nested = Array.isArray(a.aspects) ? (a.aspects as Row[]) : [];
        if (nested.length) lines.push(...aspectLines(nested, depth + 1));
    }
    return lines;
}

/** A readable summary of an extraction, with the full JSON underneath when it is small enough to show. */
export function formatResult(result: RunnerResult): string {
    const lines: string[] = [];
    if (result.dry_run) {
        lines.push("**ContextGem dry run** — the plan is valid; no model was called.", "", "```json", JSON.stringify(result.plan, null, 2), "```");
        return lines.join("\n");
    }
    lines.push(`**ContextGem** — ${result.engine ?? "llm"} engine`);
    const document = result.document;
    if (document && typeof document.paragraphs === "number") {
        lines.push(`Document: ${document.paragraphs} paragraph(s) from ${String(document.source ?? "text")}`);
    }
    const concepts = result.concepts ?? [];
    if (concepts.length) {
        lines.push("", `**Concepts** (${concepts.length})`);
        for (const c of concepts) lines.push(`- **${String(c.name)}** (${String(c.type)}): ${describeItems(c, 4)}`);
    }
    const aspects = result.aspects ?? [];
    if (aspects.length) {
        lines.push("", `**Aspects** (${aspects.length})`, ...aspectLines(aspects, 0));
    }
    if (result.stats && Object.keys(result.stats).length) {
        lines.push("", `Usage: \`${truncate(JSON.stringify(result.stats), 400)}\``);
    }
    const full = JSON.stringify({ concepts, aspects }, null, 2);
    if (full.length <= MAX_INLINE_JSON) {
        lines.push("", "Full result:", "", "```json", full, "```");
    } else {
        lines.push("", `The full result is ${full.length} characters; call /api/contextgem-enconvo/extract to get all of it as JSON.`);
    }
    return lines.join("\n");
}

function check(ok: boolean, label: string, detail = ""): string {
    return `${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`;
}

/** The Doctor report: every line a pass or a fail with the fix. */
export function formatStatus(report: StatusReport, setupSteps: string[] = []): string {
    const lines = [
        "**ContextGem Doctor**",
        "",
        check(
            report.python.found,
            "Python 3.11-3.14",
            report.python.found
                ? `${report.python.bin} (${report.python.version})`
                : "not found; run `brew install python@3.13` or set the Python Binary preference"
        ),
        check(report.uv, "uv", report.uv ? "found (fast installs)" : "optional; absent, so pip is used"),
        check(report.venv, "Plugin venv", report.venv ? "built" : "missing; run this command with the input setup"),
        check(
            report.contextgem.installed,
            "contextgem",
            report.contextgem.installed ? `v${report.contextgem.version}` : "not installed; run this command with the input setup"
        ),
        check(
            report.docling,
            "docling (file support)",
            report.docling ? "installed" : "optional; enable Install Docling (file support) in the preferences, then run setup"
        ),
        check(report.runner_bundled, "Runner script", report.runner_bundled ? "bundled" : "missing; reinstall the plugin"),
        "",
        "**Models**",
        "",
        report.llm.error
            ? check(false, "LLM (Enconvo provider)", report.llm.error)
            : check(true, "LLM (Enconvo provider)", `${report.llm.provider} → ${report.llm.model}${report.llm.api_base ? ` at ${report.llm.api_base}` : ""}`),
        ...(report.llm.error
            ? []
            : [
                  check(
                      !!report.llm.key_set,
                      "LLM key",
                      report.llm.key_set
                          ? "set in Enconvo's credentials"
                          : "none stored for this provider; fine for local models, otherwise add it in Enconvo Settings › Credentials"
                  ),
              ]),
        check(
            !!report.decision_model.model,
            "Decision model",
            report.decision_model.model || "none; engine auto sends everything to the LLM"
        ),
    ];
    if (report.decision_model.model) {
        lines.push(
            check(
                report.decision_model.key_set,
                "Decision model key",
                report.decision_model.key_set ? "set" : "not set; add one under ContextGem Decision Model Key"
            )
        );
    }
    lines.push("", check(report.ready, "Overall", report.ready ? "ready to extract" : "not ready"));
    if (setupSteps.length) lines.push("", "**Setup steps**", "", ...setupSteps.map((s) => `- ${s}`));
    return lines.join("\n");
}
