import { LLMProvider } from "@enconvo/api";
import { ContextGemError } from "./env";

/** The LLM an extraction runs on: a live Enconvo provider the chat bridge calls. */
export interface ResolvedLlm {
    /** The provider's display name, e.g. Z.AI or OrcaRouter */
    provider: string;
    /** The selected model, as the app names it */
    model: string;
    /** The live provider instance; every provider the app supports works, keys and all */
    instance: LLMProvider;
}

function text(v: unknown): string {
    return typeof v === "string" ? v.trim() : "";
}

/**
 * Resolve the LLM from Enconvo's provider management. With no argument this
 * follows the command's LLM Model preference (or, from a route, the default
 * LLM). `provider` names another Enconvo provider (z_ai, anthropic, or a custom
 * instance such as open_ai_ab12) and `model` overrides its selected model.
 */
export async function resolveLlm(opts: { provider?: string; model?: string } = {}): Promise<ResolvedLlm> {
    let base: LLMProvider;
    try {
        base = opts.provider ? await LLMProvider.create(opts.provider as never) : await LLMProvider.fromEnv();
    } catch (error) {
        throw new ContextGemError(
            "LLM_UNAVAILABLE",
            `could not load the Enconvo LLM provider${opts.provider ? ` "${opts.provider}"` : ""}: ${error instanceof Error ? error.message : String(error)}`,
            409,
            "Pick a provider under the LLM Model preference, or add one in Enconvo Settings › AI Models."
        );
    }
    const baseOptions = base.getOptions() as Record<string, any>;
    // LLMProvider.create falls back to the default provider for a name it does not know;
    // a request that names a provider must get that provider or an error, never another one.
    if (opts.provider && ![text(baseOptions.commandName), text(baseOptions.originCommandName)].includes(opts.provider)) {
        throw new ContextGemError(
            "LLM_UNAVAILABLE",
            `no Enconvo LLM provider named "${opts.provider}"`,
            409,
            "Use a provider id from Enconvo Settings › AI Models, e.g. anthropic, z_ai, open_ai or a custom one such as open_ai_ab12."
        );
    }

    // A named model reconfigures the provider through the SDK, so the bridge really
    // calls that model rather than just labelling it.
    let instance = base;
    if (opts.model) {
        const commandName = text(baseOptions.commandName) || text(baseOptions.originCommandName);
        try {
            instance = await LLMProvider.create(commandName as never, { modelName: opts.model } as never);
        } catch (error) {
            throw new ContextGemError(
                "LLM_UNAVAILABLE",
                `could not select model "${opts.model}" on ${text(baseOptions.title) || commandName}: ${error instanceof Error ? error.message : String(error)}`,
                409
            );
        }
    }

    const options = instance.getOptions() as Record<string, any>;
    const model =
        text(opts.model) ||
        text(options.modelName?.value) ||
        text(options.modelName?.originalValue) ||
        text(typeof options.modelName === "string" ? options.modelName : "");
    if (!model) {
        const label = text(options.title) || text(options.originCommandName);
        throw new ContextGemError(
            "LLM_UNAVAILABLE",
            `the Enconvo provider ${label} has no model selected`,
            409,
            "Choose a model for it in Enconvo Settings › AI Models."
        );
    }
    // Guard the silent fallback: if the provider kept its own model despite the
    // override, the request must fail rather than run a different model.
    // Exact match after stripping any provider prefix ("z_ai/glm-5.3" -> "glm-5.3");
        // substring matching would let "glm-5.3" pass while glm-5.3-flash runs.
    const norm = (s: unknown) =>
        typeof s === "string" ? s.replace(/^[a-z0-9_-]+\//i, "").toLowerCase() : "";
    if (opts.model) {
        const val = norm(options.modelName?.value);
        const orig = norm(options.modelName?.originalValue);
        if (opts.model.toLowerCase() !== val && opts.model.toLowerCase() !== orig) {
            throw new ContextGemError(
                "LLM_UNAVAILABLE",
                `no model "${opts.model}" on ${text(options.title) || text(options.commandName)}`,
                409,
                "Check the provider's model list in Enconvo Settings › AI Models."
            );
        }
        // The SDK stores any model string, so also check the provider's catalog —
        // the same list its picker shows. When no catalog is reachable (custom
        // providers without one), the provider's own call-time error stands.
        try {
            const base = String((globalThis as { environment?: { localServerBaseUrl?: string } }).environment?.localServerBaseUrl ?? "http://localhost:54535");
            const res = await fetch(`${base}/api/llm/models/${encodeURIComponent(text(options.commandName) || "")}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: "{}",
                signal: AbortSignal.timeout(10_000),
            });
            if (res.ok) {
                const models = (await res.json()) as Array<{ value?: string; originalValue?: string; title?: string }>;
                const wanted = norm(opts.model);
                const known = models.some((m) => norm(m.value) === wanted || norm(m.originalValue) === wanted);
                if (!known && models.length) {
                    const suggestions = models.slice(0, 5).map((m) => norm(m.value)).filter(Boolean).join(", ");
                    throw new ContextGemError(
                        "LLM_UNAVAILABLE",
                        `no model "${opts.model}" on ${text(options.title) || text(options.commandName)}`,
                        409,
                        suggestions ? `Models include: ${suggestions}… — see the full list in Enconvo Settings › AI Models.` : "Check the provider's model list in Enconvo Settings › AI Models."
                    );
                }
            }
        } catch (error) {
            if (error instanceof ContextGemError) throw error;
            // catalog unreachable: skip validation
        }
    }
    return {
        provider: text(options.title) || text(options.originCommandName) || text(options.commandName),
        model,
        instance,
    };
}

/** For status and Doctor: which provider and model would run. No keys are involved. */
export async function describeLlm(): Promise<{ provider?: string; model?: string; error?: string }> {
    try {
        const llm = await resolveLlm();
        return { provider: llm.provider, model: llm.model };
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    }
}
