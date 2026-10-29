import { errorResponse, resolveConfig, status } from "../lib/env";
import { describeLlm } from "../lib/llm";

/** Read-only health check: is a supported Python present, is the plugin's venv built, is contextgem (and the optional docling extra) importable, is the runner bundled, and which Enconvo LLM provider and model would run and whether a decision model is set. Never returns a key. @param {Request} request - Request object; the body is unused */
export default async function main(_request: Request) {
    try {
        return Response.json(await status(await resolveConfig(), await describeLlm()));
    } catch (error) {
        return errorResponse(error);
    }
}
