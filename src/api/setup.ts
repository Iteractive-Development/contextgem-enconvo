import { errorResponse, readJson, resolveConfig, setupEnvironment, status } from "../lib/env";
import { describeLlm } from "../lib/llm";

interface SetupParams {
    /** Also install contextgem[docling] for PDF, DOCX, PPTX, XLSX and HTML support (large download). Defaults to the Install Docling preference */
    install_docling?: boolean;
    /** Python to build the venv from; defaults to the Python Binary preference, then auto-detect of 3.11-3.14 */
    python_bin?: string;
}

/** Create or repair the plugin's private Python environment (uv-managed venv under the plugin's support directory) and install contextgem into it. Idempotent: running it again upgrades contextgem. Takes minutes with docling. @param {Request} request - Request object, body is {@link SetupParams} */
export default async function main(request: Request) {
    try {
        const params = await readJson<SetupParams>(request);
        const config = await resolveConfig();
        const steps = await setupEnvironment({
            installDocling: params.install_docling ?? config.install_docling,
            pythonPref: params.python_bin || config.python_bin,
        });
        return Response.json({ ok: true, steps, status: await status(config, await describeLlm()) });
    } catch (error) {
        return errorResponse(error);
    }
}
