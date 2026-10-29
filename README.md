# contextgem-enconvo

An [Enconvo](https://enconvo.ai) plugin that wraps [ContextGem](https://contextgem.shcherbak.ai) (Apache-2.0): aspect-based retrieval and typed concept extraction over text and document files, through your own Enconvo LLM providers or a decision model.

By [Iteractive Development](https://iteractive.dev).

## What it gives you

- **`contextgem-enconvo/extract`**: the core API route. Takes `text` (or `file_path` with the docling extra), `aspects`, `concepts`, `engine` (`llm`, `decision_model` or `auto`) and `dry_run`. Returns extracted values with optional references, justifications, probabilities and usage stats.
- **Pipelines**: `pipeline_save`, `pipeline_list` and `pipeline_delete` name an aspects/concepts spec once so `extract` can reuse it with `pipeline: "<name>"`.
- **`contextgem-enconvo/status`** and **`contextgem-enconvo/setup`**: environment health and a one-shot install into a private, uv-managed venv in the plugin's support directory. Nothing touches your system Python.
- **ContextGem Extract** command: run an extraction from the Smart Bar with a JSON spec or an attached file.
- **ContextGem Doctor** command: health report; run it with the input `setup` to install or repair.

## Models and keys

The extraction LLM is one of the providers you already set up in Enconvo. The plugin reads its model and its stored credential (key and base URL) through Enconvo's provider and credential management, so there is no second key to paste and no model string to type:

- Commands have an **LLM Model** preference, a standard provider picker. The default follows your default LLM.
- API routes use your default LLM, or `llm_provider` (an Enconvo provider id such as `anthropic`, `z_ai`, `open_ai`, or a custom one such as `open_ai_ab12`) with an optional `llm_model`.
- Providers are mapped to LiteLLM automatically: OpenAI-compatible endpoints (including custom ones with a base URL), Anthropic, Gemini, Ollama, LM Studio, Z.AI, xAI, DeepSeek, Groq, Mistral, OpenRouter and others. A provider ContextGem cannot reach fails with `LLM_UNAVAILABLE` and says what to change.
- Keys never touch disk: the job goes to the Python runner on stdin, and keys are redacted from any error text.

The optional **decision model** (for closed questions: booleans, labels, ratings) is not an Enconvo LLM provider, so it has its own preference (**Decision Model**, a LiteLLM string such as `typesafe/jev-latest`) and its own credential (**ContextGem Decision Model Key**, stored through Enconvo's credential management).

## Setup

1. Install the plugin, then run **ContextGem Doctor** with the input `setup` (or POST `{}` to `contextgem-enconvo/setup`). The first run creates the venv and installs contextgem.
2. Optional: set **Decision Model** and add a **ContextGem Decision Model Key**; then `engine: "auto"` sends booleans, labels and ratings to it with calibrated probabilities.
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

The Python bridge lives in `assets/python/runner.py`; `src/lib/env.ts` owns the venv lifecycle and the job bridge, and `src/lib/llm.ts` maps Enconvo providers to LiteLLM.

## License

MIT © Iteractive Development. ContextGem itself is Apache-2.0 © its authors.
