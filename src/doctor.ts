import { EnconvoResponse, type RequestOptions } from "@enconvo/api";
import { explain, resolveConfig, setupEnvironment, status } from "./lib/env";
import { formatStatus } from "./lib/format";
import { describeLlm } from "./lib/llm";

/** The ContextGem Doctor command: checks the Python environment, the contextgem install and the model configuration and prints what to fix. With the input setup it builds or repairs the environment first. */
export default async function main(request: Request) {
    try {
        const options = (await request.json()) as RequestOptions;
        const config = await resolveConfig(options as Record<string, unknown>);
        const wantsSetup = /\b(setup|install|fix|repair)\b/i.test(String(options.input_text ?? ""));

        let steps: string[] = [];
        if (wantsSetup) {
            steps = await setupEnvironment({ installDocling: config.install_docling, pythonPref: config.python_bin });
        }
        return EnconvoResponse.text(formatStatus(await status(config, await describeLlm()), steps));
    } catch (error) {
        return EnconvoResponse.text(`**ContextGem Doctor error**: ${explain(error)}`);
    }
}
