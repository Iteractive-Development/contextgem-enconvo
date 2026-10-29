import { KV } from "@enconvo/api";
import { ContextGemError } from "./env";

/** A saved extraction spec: aspects and/or concepts, reusable by name. */
export interface Pipeline {
    name: string;
    description: string;
    aspects: unknown[];
    concepts: unknown[];
    engine: string;
    updated_at: string;
}

const INDEX_KEY = "contextgem-enconvo.pipelines.index";
const specKey = (name: string) => `contextgem-enconvo.pipelines.spec.${name}`;

export const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

export async function readIndex(): Promise<string[]> {
    const raw = await KV.get(INDEX_KEY);
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === "string") : [];
    } catch {
        return [];
    }
}

async function writeIndex(names: string[]): Promise<void> {
    await KV.set(INDEX_KEY, JSON.stringify([...new Set(names)].sort()));
}

export async function getPipeline(name: string): Promise<Pipeline | null> {
    const raw = await KV.get(specKey(name));
    if (!raw) return null;
    try {
        return JSON.parse(raw) as Pipeline;
    } catch {
        return null;
    }
}

export async function requirePipeline(name: string): Promise<Pipeline> {
    const pipeline = await getPipeline(name);
    if (!pipeline) {
        throw new ContextGemError(
            "NOT_FOUND",
            `pipeline "${name}" is not saved`,
            404,
            "List saved pipelines with /api/contextgem-enconvo/pipeline_list."
        );
    }
    return pipeline;
}

export async function savePipeline(pipeline: Pipeline): Promise<void> {
    await KV.set(specKey(pipeline.name), JSON.stringify(pipeline));
    await writeIndex([...(await readIndex()), pipeline.name]);
}

export async function deletePipeline(name: string): Promise<void> {
    await KV.set(specKey(name), "");
    await writeIndex((await readIndex()).filter((n) => n !== name));
}
