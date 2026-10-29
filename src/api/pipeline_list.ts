import { errorResponse } from "../lib/env";
import { getPipeline, readIndex } from "../lib/pipelines";

/** List the saved extraction pipelines with their description, default engine and how many aspects and concepts each holds. @param {Request} request - Request object; the body is unused */
export default async function main(_request: Request) {
    try {
        const names = await readIndex();
        const found = await Promise.all(names.map((name) => getPipeline(name)));
        const pipelines = found
            .filter((p): p is NonNullable<typeof p> => p !== null)
            .map((p) => ({
                name: p.name,
                description: p.description,
                engine: p.engine,
                aspects: p.aspects.length,
                concepts: p.concepts.length,
                updated_at: p.updated_at,
            }));
        return Response.json({ ok: true, count: pipelines.length, pipelines });
    } catch (error) {
        return errorResponse(error);
    }
}
