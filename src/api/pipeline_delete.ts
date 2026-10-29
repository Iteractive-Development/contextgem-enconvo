import { ContextGemError, errorResponse, readJson } from "../lib/env";
import { deletePipeline, requirePipeline } from "../lib/pipelines";

interface PipelineDeleteParams {
    /** Name of the saved pipeline to delete */
    name: string;
}

/** Delete a saved extraction pipeline by name. @param {Request} request - Request object, body is {@link PipelineDeleteParams} */
export default async function main(request: Request) {
    try {
        const params = await readJson<PipelineDeleteParams>(request);
        if (typeof params.name !== "string" || !params.name) {
            throw new ContextGemError("BAD_INPUT", "name is required", 400);
        }
        await requirePipeline(params.name);
        await deletePipeline(params.name);
        return Response.json({ ok: true, deleted: params.name });
    } catch (error) {
        return errorResponse(error);
    }
}
