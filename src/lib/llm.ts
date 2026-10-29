import { LLMProvider } from "@enconvo/api";
import { ContextGemError } from "./env";

/** What the Python runner needs to talk to a model through LiteLLM. */
export interface ResolvedLlm {
    /** The Enconvo provider's display name, e.g. OrcaRouter or Z.AI */
    provider: string;
    /** LiteLLM model string, e.g. openai/orcarouter/auto or anthropic/claude-haiku-5-5 */
    model: string;
    api_key?: string;
    api_base?: string;
}

/**
 * Enconvo LLM provider (origin command name) to LiteLLM provider prefix.
 * `base` marks providers whose credentials carry a base URL that must be passed on
 * (OpenAI-compatible endpoints and local servers); the others use LiteLLM's own default.
 */
const PROVIDERS: Record<string, { prefix: string; base?: boolean }> = {
    open_ai: { prefix: "openai", base: true },
    anthropic: { prefix: "anthropic" },
    gemini: { prefix: "gemini" },
    ollama: { prefix: "ollama_chat", base: true },
    lm_studio: { prefix: "lm_studio", base: true },
    z_ai: { prefix: "zai" },
    x_ai: { prefix: "xai" },
    deepseek: { prefix: "deepseek" },
    groq: { prefix: "groq" },
    mistral: { prefix: "mistral" },
    openrouter: { prefix: "openrouter" },
    together_ai: { prefix: "together_ai" },
    fireworks: { prefix: "fireworks_ai" },
    cerebras: { prefix: "cerebras" },
    perplexity: { prefix: "perplexity" },
    moonshot: { prefix: "moonshot" },
    dashscope: { prefix: "dashscope" },
    sambanova: { prefix: "sambanova" },
    deepinfra: { prefix: "deepinfra" },
    minimax: { prefix: "minimax" },
    vercel_ai_gateway: { prefix: "vercel_ai_gateway" },
};

function text(v: unknown): string {
    return typeof v === "string" ? v.trim() : "";
}

/**
 * Resolve the LLM from Enconvo's own provider and credential management.
 *
 * With no argument this follows the command's LLM Model preference (or, from a route, the
 * user's default LLM). `provider` names another Enconvo provider (open_ai, anthropic, z_ai,
 * or a custom instance such as open_ai_ab12) and `model` overrides its model.
 */
export async function resolveLlm(opts: { provider?: string; model?: string } = {}): Promise<ResolvedLlm> {
    let options: Record<string, any>;
    try {
        const provider = opts.provider ? await LLMProvider.create(opts.provider as never) : await LLMProvider.fromEnv();
        options = provider.getOptions() as Record<string, any>;
    } catch (error) {
        throw new ContextGemError(
            "LLM_UNAVAILABLE",
            `could not load the Enconvo LLM provider${opts.provider ? ` "${opts.provider}"` : ""}: ${error instanceof Error ? error.message : String(error)}`,
            409,
            "Pick a provider under the LLM Model preference, or add one in Enconvo Settings › AI Models."
        );
    }

    // LLMProvider.create falls back to the default provider for a name it does not know;
    // a request that names a provider must get that provider or an error, never another one.
    if (opts.provider && ![options.commandName, options.originCommandName].includes(opts.provider)) {
        throw new ContextGemError(
            "LLM_UNAVAILABLE",
            `no Enconvo LLM provider named "${opts.provider}"`,
            409,
            "Use a provider id from Enconvo Settings \u203a AI Models, e.g. anthropic, z_ai, open_ai or a custom one such as open_ai_ab12."
        );
    }
    const origin = text(options.originCommandName) || text(options.commandName);
    const rawModel = options.modelName;
    const model = text(opts.model) || text(rawModel?.originalValue) || text(rawModel?.value) || text(typeof rawModel === "string" ? rawModel : "");
    const creds = (options.credentials ?? {}) as Record<string, unknown>;
    const apiKey = text(creds.apiKey);
    const baseUrl = text(creds.baseUrl);
    const label = text(options.title) || origin;

    if (!model) {
        throw new ContextGemError("LLM_UNAVAILABLE", `the Enconvo provider ${label} has no model selected`, 409, "Choose a model for it in Enconvo Settings › AI Models.");
    }

    const known = PROVIDERS[origin];
    if (known) {
        return {
            provider: label,
            model: model.includes("/") && !known.base ? model : `${known.prefix}/${model}`,
            api_key: apiKey || undefined,
            api_base: known.base && baseUrl ? baseUrl : undefined,
        };
    }
    // Not a provider LiteLLM names, but it still works when it speaks the OpenAI protocol at a base URL.
    if (baseUrl) {
        return { provider: label, model: `openai/${model}`, api_key: apiKey || undefined, api_base: baseUrl };
    }
    throw new ContextGemError(
        "LLM_UNAVAILABLE",
        `the Enconvo provider ${label} (${origin}) is not one ContextGem can reach through LiteLLM`,
        409,
        "Pick an OpenAI-compatible, Anthropic, Gemini, Ollama or other supported provider under the LLM Model preference."
    );
}

/** For status and Doctor: what resolveLlm finds right now, or why it finds nothing. Never returns the key. */
export async function describeLlm(): Promise<{ provider?: string; model?: string; api_base?: string; key_set?: boolean; error?: string }> {
    try {
        const llm = await resolveLlm();
        return { provider: llm.provider, model: llm.model, api_base: llm.api_base, key_set: !!llm.api_key };
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    }
}
