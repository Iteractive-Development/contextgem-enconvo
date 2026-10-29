import { ContextGemError, errorResponse, readJson } from "../lib/env";
import { SLUG, savePipeline } from "../lib/pipelines";

interface PipelineSaveParams {
    /** Pipeline name: a slug of lowercase letters, digits and dashes, up to 64 characters */
    name: string;
    /** What this pipeline extracts and from which kind of document */
    description?: string;
    /** Document sections to find (same shape as extract's aspects) */
    aspects?: unknown[];
    /** Typed values to extract (same shape as extract's concepts) */
    concepts?: unknown[];
    /** @default llm Default engine: llm, decision_model or auto */
    engine?: "llm" | "decision_model" | "auto";
}

/** Save an extraction spec (aspects and/or concepts) under a name so extract can run it with just {pipeline, text}. Saving an existing name replaces it. @param {Request} request - Request object, body is {@link PipelineSaveParams} */
export default async function main(request: Request) {
    try {
        const params = await readJson<PipelineSaveParams>(request);
        if (typeof params.name !== "string" || !SLUG.test(params.name)) {
            throw new ContextGemError("BAD_INPUT", "name must be a slug: lowercase letters, digits and dashes, up to 64 characters", 400);
        }
        if (!params.aspects?.length && !params.concepts?.length) {
            throw new ContextGemError("BAD_INPUT", "provide aspects or concepts for the pipeline", 400);
        }
        const engine = params.engine ?? "llm";
        if (!["llm", "decision_model", "auto"].includes(engine)) {
            throw new ContextGemError("BAD_INPUT", "engine must be llm, decision_model or auto", 400);
        }
        const updated_at = new Date().toISOString();
        await savePipeline({
            name: params.name,
            description: params.description ?? "",
            aspects: params.aspects ?? [],
            concepts: params.concepts ?? [],
            engine,
            updated_at,
        });
        return Response.json({ ok: true, saved: params.name, updated_at });
    } catch (error) {
        return errorResponse(error);
    }
}
