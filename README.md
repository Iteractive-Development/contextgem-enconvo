# contextgem-enconvo

An [Enconvo](https://enconvo.ai) plugin that wraps [ContextGem](https://contextgem.shcherbak.ai) (Apache-2.0): aspect-based retrieval and typed concept extraction over text and document files, running on your Enconvo LLM providers and (for closed questions) Jev on Enconvo Cloud — with no API keys to manage anywhere in the plugin.

By [Iteractive Development](https://iteractive.dev).

## What it gives you

- **`contextgem-enconvo/extract`**: the core API route. Takes `text` (or `file_path` with the docling extra), `aspects`, `concepts`, `engine` (`llm`, `decision_model` or `auto`) and `dry_run`. Returns extracted values with optional references, justifications, probabilities and usage stats.
- **Pipelines**: `pipeline_save`, `pipeline_list` and `pipeline_delete` name an aspects/concepts spec once so `extract` can reuse it with `pipeline: "<name>"`.
- **`contextgem-enconvo/status`** and **`contextgem-enconvo/setup`**: environment health and a one-shot install into a private, uv-managed venv in the plugin's support directory. Nothing touches your system Python.
- **ContextGem Extract** command: run an extraction from the Smart Bar with a JSON spec or an attached file.
- **ContextGem Doctor** command: health report; run it with the input `setup` to install or repair.

## Models, bridges and keys

Every model the plugin uses is one you already have in Enconvo, reached through two local bridges that live for the length of one extraction. No API key is stored, copied or typed anywhere in the plugin.

**Chat bridge (the extraction LLM).** ContextGem's runner speaks OpenAI chat completions to a localhost endpoint the plugin opens per job; the endpoint calls the provider through Enconvo's own chat mechanism (`LLMProvider`). That means every provider the app supports works — Enconvo Cloud points models, Anthropic, Z.AI, OpenAI-compatible custom instances such as OrcaRouter, OAuth providers, and local servers — with the provider's model choice, key and per-model preferences applied by Enconvo itself.

- Commands have an **LLM Model** preference, a standard provider picker. The default follows your default LLM.
- API routes use your default LLM, or `llm_provider` (an Enconvo provider id such as `anthropic`, `z_ai`, `open_ai`, or a custom one such as `open_ai_ab12`) with an optional `llm_model`. An unknown name fails with `LLM_UNAVAILABLE` rather than silently substituting another provider.
- `llm_options: { model, api_base, api_key, ... }` bypasses both bridges and talks to any endpoint you name directly (advanced; also used for testing).

**Decision bridge (Jev, optional).** Closed questions — booleans, labels, ratings — can go to Jev for calibrated probabilities. Set the **Decision Engine** preference to **Jev (Enconvo Cloud)**: the runner's decision model points at a second localhost endpoint that relays to Enconvo Cloud's System One gateway (the same one the app's own judge/classify workflow steps use), authenticating with the app's session. Decisions bill Enconvo Cloud points; there is no TypeSafe key to manage. `engine: "auto"` sends closed concepts to Jev and open ones to the LLM; `decision_threshold` (0-1) tunes how sure Jev must be.

The job and both bridge tokens travel to the Python runner on stdin (nothing sensitive touches disk), and tokens and keys are redacted from any error text.

## Setup

1. Install the plugin, then run **ContextGem Doctor** with the input `setup` (or POST `{}` to `contextgem-enconvo/setup`). The first run creates the venv and installs contextgem.
2. Optional: set **Decision Engine** to **Jev (Enconvo Cloud)** (needs an Enconvo Cloud sign-in with points); then `engine: "auto"` sends booleans, labels and ratings to Jev for calibrated probabilities.
3. Optional: enable **Install Docling** and re-run setup for PDF, DOCX, PPTX, XLSX and HTML file support (large download).

## Example

```json
POST contextgem-enconvo/extract
{
  "text": "Acme Corp invoice INV-2031, dated March 3, 2026... total $4,200, paid in full.",
  "concepts": [
    { "type": "string", "name": "invoice_number", "description": "the invoice ID", "singular_occurrence": true },
    { "type": "date", "name": "invoice_date", "description": "issue date" },
    { "type": "numerical", "name": "total", "description": "grand total", "numeric_type": "float" },
    { "type": "boolean", "name": "paid_in_full", "description": "whether fully paid", "add_justifications": true }
  ],
  "engine": "auto"
}
```

Each concept returns `items: [{ value, justification?, reference_paragraphs?, probabilities? }]`.

## Errors

Routes answer `{ ok: false, code, error, hint }`: `BAD_INPUT` and `BAD_SPEC` (400), `NOT_FOUND` (404), `SETUP_REQUIRED` and `LLM_UNAVAILABLE` (409), `EXTRACTION_FAILED` (502), `TIMEOUT` (504).

## Development

```sh
npm install --include=dev
npm run typecheck
npm run build     # builds into Enconvo (runs enconvo plugin build)
npm run validate
```

The Python runner lives in `assets/python/runner.py`; `src/lib/bridge.ts` opens the chat and decision bridges per job; `src/lib/env.ts` owns the venv lifecycle and the job; `src/lib/llm.ts` resolves the Enconvo provider.

## License

MIT © Iteractive Development. ContextGem itself is Apache-2.0 © its authors.
