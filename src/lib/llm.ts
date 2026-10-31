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
    let instance: LLMProvider;
    try {
        instance = opts.provider
            ? await LLMProvider.create(opts.provider as never)
            : await LLMProvider.fromEnv();
    } catch (error) {
        throw new ContextGemError(
            "LLM_UNAVAILABLE",
            `could not load the Enconvo LLM provider${opts.provider ? ` "${opts.provider}"` : ""}: ${error instanceof Error ? error.message : String(error)}`,
            409,
            "Pick a provider under the LLM Model preference, or add one in Enconvo Settings › AI Models."
        );
    }
    const options = instance.getOptions() as Record<string, any>;
    // LLMProvider.create falls back to the default provider for a name it does not know;
    // a request that names a provider must get that provider or an error, never another one.
    if (opts.provider && ![text(options.commandName), text(options.originCommandName)].includes(opts.provider)) {
        throw new ContextGemError(
            "LLM_UNAVAILABLE",
            `no Enconvo LLM provider named "${opts.provider}"`,
            409,
            "Use a provider id from Enconvo Settings › AI Models, e.g. anthropic, z_ai, open_ai or a custom one such as open_ai_ab12."
        );
    }
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
