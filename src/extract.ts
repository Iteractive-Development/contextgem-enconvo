import { EnconvoResponse, type RequestOptions } from "@enconvo/api";
import { explain, resolveConfig, runExtraction, validateInput, type ExtractInput } from "./lib/env";
import { formatResult } from "./lib/format";
import { resolveLlm } from "./lib/llm";
import { requirePipeline } from "./lib/pipelines";

interface CommandSpec extends ExtractInput {
    pipeline?: string;
}

const USAGE =
    "ContextGem needs a document and what to extract. Give a JSON spec as the input:\n\n" +
    '`{"text": "...", "concepts": [{"type": "string", "name": "headline", "description": "the article headline"}]}`\n\n' +
    "or attach a file (with the docling extra) and give just the aspects and concepts. " +
    'To reuse a saved spec, name it: `{"pipeline": "invoices", "text": "..."}`.';

/** The ContextGem Extract command: run an extraction from a JSON spec in the input, optionally over an attached file. */
export default async function main(request: Request) {
    try {
        const options = (await request.json()) as RequestOptions;
        const raw = String(options.input_text ?? "").trim();

        let spec: CommandSpec = {};
        if (raw) {
            try {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) spec = parsed as CommandSpec;
                else return EnconvoResponse.text(USAGE);
            } catch {
                return EnconvoResponse.text(USAGE);
            }
        }

        if (!spec.text && !spec.file_path) {
            const attached = (options.context_files ?? [])[0] as unknown;
            const file = typeof attached === "string" ? attached : (attached as { path?: string } | undefined)?.path;
            if (file) spec.file_path = file;
        }

        if (spec.pipeline) {
            const saved = await requirePipeline(spec.pipeline);
            spec.aspects = spec.aspects?.length ? spec.aspects : saved.aspects;
            spec.concepts = spec.concepts?.length ? spec.concepts : saved.concepts;
            spec.engine = spec.engine || saved.engine;
        }

        if (!raw && !spec.file_path) return EnconvoResponse.text(USAGE);
        validateInput(spec);

        const config = await resolveConfig(options as Record<string, unknown>);
        const llm = await resolveLlm({ provider: spec.llm_provider, model: spec.llm_model });
        const result = await runExtraction(spec, config, llm);
        return EnconvoResponse.text(formatResult(result));
    } catch (error) {
        return EnconvoResponse.text(`**ContextGem error**: ${explain(error)}`);
    }
}
