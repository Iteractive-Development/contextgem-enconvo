---
name: contextgem-enconvo
description: >
  Extract structured data from text and documents through the ContextGem framework: aspects and typed concepts (strings, booleans, numbers, dates, ratings, labels, JSON objects) with source references, justifications and probabilities, using the LLM providers and credentials already set up in Enconvo, or a decision model such as Jev for closed questions.
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

Check readiness with `contextgem-enconvo/status`. If `ready` is false, POST `{}` to `contextgem-enconvo/setup` (installs a private uv-managed venv with contextgem; with `{"install_docling": true}` it also installs file support). The extraction LLM is an Enconvo provider you already have set up: the default LLM, or `llm_provider` (e.g. `anthropic`, `z_ai`, `open_ai`, a custom id like `open_ai_ab12`) with an optional `llm_model` in the extract call. Its key comes from Enconvo's credentials, so never ask the user for one. Only the optional decision model has its own preference and key.

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

- Engine choice: `llm` (default) for everything; `decision_model` only for booleans/labels/ratings + aspects; `auto` routes closed concepts to the decision model and the rest to the LLM.
- `dry_run: true` builds the plan (validation, document build) without calling any model — cheap preflight.
- Only the decision model is a LiteLLM string (e.g. `typesafe/jev-latest`); `llm_options` takes advanced LiteLLM overrides (temperature, max_tokens, reasoning_effort, output_language) for the LLM.
- An `LLM_UNAVAILABLE` error means the chosen Enconvo provider is missing or not reachable through LiteLLM; its hint says what to change.
- Extraction can take minutes on long documents; raise `timeout_seconds` (30–3600) if needed.
