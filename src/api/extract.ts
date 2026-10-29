import {
    buildJob,
    errorResponse,
    readJson,
    resolveConfig,
    runExtractJob,
    timeoutMsFor,
    validateInput,
} from "../lib/env";
import { resolveLlm } from "../lib/llm";
import { requirePipeline } from "../lib/pipelines";

/** A typed value to pull out of the document. */
interface ConceptSpec {
    /** Value type: string, boolean, numerical, date, rating, json_object or label */
    type: "string" | "boolean" | "numerical" | "date" | "rating" | "json_object" | "label";
    /** Short, specific name, e.g. invoice_number */
    name: string;
    /** What the value means and where it appears; be specific */
    description: string;
    /** label only: the allowed labels */
    labels?: string[];
    /** label only: multi_class (exactly one) or multi_label (any number). Default multi_class */
    classification_type?: "multi_class" | "multi_label";
    /** rating only: the inclusive scale, e.g. [1, 5] */
    rating_scale?: [number, number];
    /** numerical only: int, float or any. Default any */
    numeric_type?: "int" | "float" | "any";
    /** json_object only: field names to types (string, integer, number, boolean, array, object, any); objects nest, a one-item list types an array's items */
    structure?: Record<string, unknown>;
    /** Attach the source text each item came from */
    add_references?: boolean;
    /** What a reference is: paragraphs or sentences */
    reference_depth?: "paragraphs" | "sentences";
    /** Attach the model's justification to each item */
    add_justifications?: boolean;
    /** How detailed a justification is: brief, balanced or comprehensive */
    justification_depth?: "brief" | "balanced" | "comprehensive";
    /** string only: expect one value per document rather than a list */
    singular_occurrence?: boolean;
    /** Example values that sharpen extraction */
    examples?: unknown[];
}

/** A section of the document to find, with optional nested aspects and concepts extracted inside it. */
interface AspectSpec {
    /** Short, specific name, e.g. payment_terms */
    name: string;
    /** What the section covers */
    description: string;
    /** Nested aspects found within this one */
    aspects?: AspectSpec[];
    /** Concepts extracted from this aspect's text */
    concepts?: ConceptSpec[];
    /** What a reference is: paragraphs or sentences */
    reference_depth?: "paragraphs" | "sentences";
    /** Attach the model's justification to each item */
    add_justifications?: boolean;
}

interface ExtractParams {
    /** The document text. Give this or file_path */
    text?: string;
    /** Absolute path of a file to convert with Docling (needs the docling extra). Give this or text */
    file_path?: string;
    /** Name of a pipeline saved with pipeline_save; its aspects, concepts and engine apply unless the request sets its own */
    pipeline?: string;
    /** Document sections to find */
    aspects?: AspectSpec[];
    /** Typed values to extract */
    concepts?: ConceptSpec[];
    /** llm (default), decision_model (booleans, labels and ratings only) or auto (closed concepts to the decision model, the rest to the LLM) */
    engine?: "llm" | "decision_model" | "auto";
    /** Build and validate the plan without calling any model */
    dry_run?: boolean;
    /** How the text is split into paragraphs: newlines (default) or sat (a model) */
    segmentation?: "newlines" | "sat";
    /** Enconvo LLM provider to use, e.g. anthropic, z_ai, open_ai or a custom one such as open_ai_ab12. Defaults to the user's default LLM in Enconvo */
    llm_provider?: string;
    /** Model for that provider, e.g. claude-haiku-5-5. Defaults to the provider's selected model */
    llm_model?: string;
    /** Advanced LiteLLM overrides: temperature, max_tokens, reasoning_effort, output_language, system_message, num_retries (model, api_base and api_key override the Enconvo provider) */
    llm_options?: Record<string, unknown>;
    /** Per-request decision-model overrides: model, api_key, api_base, decision_threshold */
    decision_model?: Record<string, unknown>;
    /** @default 600 Seconds before the run is stopped (30-3600); defaults to the Extraction Timeout preference */
    timeout_seconds?: number;
}

/** Extract aspects and typed concepts from a document with ContextGem. Returns each concept's and aspect's items with values, optional justifications, source references and decision-model probabilities, plus usage stats. Needs the plugin's environment: check /status, create it with /setup. @param {Request} request - Request object, body is {@link ExtractParams} */
export default async function main(request: Request) {
    try {
        const params = await readJson<ExtractParams>(request);
        const config = await resolveConfig();

        let { aspects, concepts, engine } = params;
        if (params.pipeline) {
            const saved = await requirePipeline(params.pipeline);
            aspects = aspects?.length ? aspects : (saved.aspects as AspectSpec[]);
            concepts = concepts?.length ? concepts : (saved.concepts as ConceptSpec[]);
            engine = engine || (saved.engine as ExtractParams["engine"]);
        }

        const input = { ...params, aspects, concepts, engine };
        validateInput(input);
        const llm = await resolveLlm({ provider: params.llm_provider, model: params.llm_model });
        const result = await runExtractJob(buildJob(input, config, llm), timeoutMsFor(config, params.timeout_seconds));
        return Response.json(result);
    } catch (error) {
        return errorResponse(error);
    }
}
