---
name: contextgem-enconvo
description: >
  Structured document and text extraction with the ContextGem framework, running on your Enconvo LLM providers through a local bridge — no API keys to manage. Route closed questions to Jev on Enconvo Cloud for calibrated probabilities. Aspects and typed concepts (string, boolean, numerical, date, rating, JSON, label) come back with justifications, source references and usage stats; save reusable pipelines; extract from files with the optional docling extra.
metadata:
  author: Iteractive Development
  version: "1.0.0"
---

# ContextGem

Extract structured data from documents through the ContextGem framework: aspect-based retrieval (find the relevant sections) and typed concept extraction (strings, booleans, numbers, dates, ratings, labels, JSON objects), each item optionally grounded with source references, LLM justifications and calibrated probabilities. Files (PDF, DOCX, …) are supported when the docling extra is installed.

## When to use this

- The task is **extraction with a schema**, not conversation: you know the fields (aspects/concepts) and want values back with evidence (reference paragraphs, justifications, probabilities).
- You need **aspect-style retrieval**: locate every passage matching a description (clauses, obligations, findings), then read only those.
- A closed judgment (is_paid: yes/no, labels, ratings) benefits from a **decision model** with calibrated probabilities — cheaper and auditable — while open fields (strings, JSON objects) go to an LLM. `engine: "auto"` splits the work exactly this way when a decision model is configured.
- Long documents where plain prompting leaks or truncates context: ContextGem chunks internally and extracts per paragraph.

Prefer a normal chat answer when the user just asks a question about text; use ContextGem when they want structured output, repeated runs with the same schema, or evidence-backed items.

## Setup

Check readiness with `contextgem-enconvo/status`. If `ready` is false, POST `{}` to `contextgem-enconvo/setup` (installs a private uv-managed venv with contextgem; with `{"install_docling": true}` it also installs file support). Models come from Enconvo, through per-job local bridges, so never ask the user for any key. The extraction LLM is the default LLM or `llm_provider` (e.g. `anthropic`, `z_ai`, `open_ai`, a custom id like `open_ai_ab12`) with an optional `llm_model`; every provider the app supports works, including Enconvo Cloud points models and OAuth providers. Closed questions (booleans, labels, ratings) go to Jev by default (the **Decision Engine** preference is Jev, Enconvo Cloud — native to every Enconvo): decisions bill points, calibrated probabilities come back on the items, no TypeSafe key exists. If Jev is unavailable, `engine: "auto"` runs fall back to the LLM and add a `notes` entry.

## Spec shape

Concepts: `{ type, name, description }` plus type-specific fields —

- `string` — `singular_occurrence` when one value per document
- `boolean`, `rating` (`rating_scale: [1,5]`), `date`, `numerical` (`numeric_type: int|float|any`)
- `label` — `labels: [...]`, `classification_type: multi_class|multi_label`
- `json_object` — `structure: { "field": "string"|"number"|"integer"|"boolean"|"array"|"object" }` (nested objects allowed)

Common optional fields: `add_references` (attach source text), `reference_depth` (paragraphs|sentences), `add_justifications`, `justification_depth` (brief|balanced|comprehensive), `examples`.

Aspects: `{ name, description }` with the same reference/justification options, plus nested `aspects` and `concepts` extracted within each aspect's items. Aspect items carry the passage text in `value`.

Reuse a schema across runs: save it once with `contextgem-enconvo/pipeline_save` (also `pipeline_list`, `pipeline_delete`) and call extract with `pipeline: "<name>"`.

## Notes

- Engine choice: `llm` for everything; `auto` (recommended) routes closed concepts to Jev and the rest to the LLM; `decision_model` only for booleans/labels/ratings (needs Decision Engine on, which is the default).
- `dry_run: true` builds the plan (validation, document build) without calling any model — cheap preflight.
- `llm_options` names its own endpoint (model, api_base, api_key) and bypasses both bridges for advanced or testing use; other keys pass through as LiteLLM overrides.
- An `LLM_UNAVAILABLE` error means the named provider does not exist (or has no model selected); its hint says what to change.
- Extraction can take minutes on long documents; raise `timeout_seconds` (30–3600) if needed.
