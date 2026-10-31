#!/usr/bin/env python3
"""ContextGem runner for the contextgem-enconvo Enconvo plugin.

Reads a JSON job from stdin (so API keys never touch disk), runs the extraction
through the ContextGem framework, and writes a JSON result to the file given as
argv[1]. Progress lines are printed to stdout; errors go to the result file and
stderr.

Job shape (all keys optional unless marked):
  text                    document text (or file_path)
  file_path               file for Docling conversion (needs the docling extra)
  aspects                 list of aspect specs
  concepts                list of concept specs
  engine                  "llm" | "decision_model" | "auto"
  dry_run                 build everything, extract nothing
  segmentation            "newlines" | "sat"
  llm                     {model, api_key, api_base, api_version, reasoning_effort,
                          output_language, temperature, top_p, max_tokens, system_message, timeout}
  decision_model          {model, api_key, api_base, decision_threshold, timeout}
  register_model          optional litellm.register_model payload for unknown models

Aspect spec:  name*, description*, aspects (sub-aspects), concepts, reference_depth,
              add_justifications, justification_depth, justification_max_sents,
              decision_threshold, model_role
Concept spec: type* (string|boolean|numerical|date|rating|json_object|label), name*,
              description*, add_references, reference_depth, add_justifications,
              justification_depth, justification_max_sents, singular_occurrence,
              model_role, decision_threshold, numeric_type, rating_scale, structure,
              labels, classification_type, modality, examples
"""

import json
import sys
import traceback
from datetime import date, datetime
from decimal import Decimal

CLOSED_CONCEPT_TYPES = {"boolean", "label", "rating"}

CONCEPT_COMMON_FIELDS = (
    "add_references",
    "reference_depth",
    "add_justifications",
    "justification_depth",
    "justification_max_sents",
    "singular_occurrence",
    "model_role",
    "modality",
)

ASPECT_FIELDS = (
    "reference_depth",
    "add_justifications",
    "justification_depth",
    "justification_max_sents",
    "decision_threshold",
    "model_role",
)


class SpecError(Exception):
    """An error in the caller's spec, reported as BAD_SPEC."""


def stage(msg):
    print(f"[stage] {msg}", flush=True)


def pick(spec, fields):
    return {k: spec[k] for k in fields if k in spec and spec[k] is not None}


def structure_to_python(node, where):
    """Map a JSON-style structure spec to the python types JsonObjectConcept takes."""
    if isinstance(node, str):
        mapping = {
            "string": str,
            "integer": int,
            "number": float,
            "boolean": bool,
            "array": list,
            "object": dict,
            "any": None,
        }
        if node not in mapping:
            raise SpecError(
                f"{where}: unknown structure type '{node}' "
                f"(use one of: string, integer, number, boolean, array, object, any)"
            )
        return mapping[node]
    if isinstance(node, dict):
        return {k: structure_to_python(v, f"{where}.{k}") for k, v in node.items()}
    if isinstance(node, list):
        if len(node) != 1:
            raise SpecError(f"{where}: a list in structure must hold exactly one item, the type of its items")
        return [structure_to_python(node[0], f"{where}[]")]
    raise SpecError(f"{where}: structure entries must be strings, objects or one-item lists")


def build_concept(spec, where):
    from contextgem import (
        BooleanConcept,
        DateConcept,
        JsonObjectConcept,
        LabelConcept,
        NumericalConcept,
        RatingConcept,
        StringConcept,
    )

    ctype = spec.get("type")
    if not ctype:
        raise SpecError(f"{where}: concept is missing 'type'")
    if not spec.get("name") or not spec.get("description"):
        raise SpecError(f"{where}: concept needs a non-empty 'name' and 'description'")

    kwargs = pick(spec, CONCEPT_COMMON_FIELDS)

    if ctype == "string":
        cls = StringConcept
    elif ctype == "boolean":
        cls = BooleanConcept
        kwargs.update(pick(spec, ("decision_threshold",)))
    elif ctype == "numerical":
        cls = NumericalConcept
        nt = spec.get("numeric_type", "any")
        if nt not in ("int", "float", "any"):
            raise SpecError(f"{where}: numeric_type must be 'int', 'float' or 'any', got '{nt}'")
        kwargs["numeric_type"] = nt
    elif ctype == "date":
        cls = DateConcept
    elif ctype == "rating":
        cls = RatingConcept
        scale = spec.get("rating_scale")
        if scale is None:
            raise SpecError(f"{where}: rating concepts need 'rating_scale', e.g. [1, 5]")
        if not (isinstance(scale, list) and len(scale) == 2):
            raise SpecError(f"{where}: 'rating_scale' must be a two-item list like [1, 5]")
        kwargs["rating_scale"] = (int(scale[0]), int(scale[1]))
    elif ctype == "json_object":
        cls = JsonObjectConcept
        structure = spec.get("structure")
        if structure is None:
            raise SpecError(f"{where}: json_object concepts need 'structure'")
        kwargs["structure"] = structure_to_python(structure, f"{where}.structure")
    elif ctype == "label":
        cls = LabelConcept
        labels = spec.get("labels")
        if not (isinstance(labels, list) and labels and all(isinstance(x, str) and x for x in labels)):
            raise SpecError(f"{where}: label concepts need 'labels', a non-empty list of strings")
        kwargs["labels"] = labels
        ct = spec.get("classification_type", "multi_class")
        if ct not in ("multi_class", "multi_label"):
            raise SpecError(f"{where}: classification_type must be 'multi_class' or 'multi_label', got '{ct}'")
        kwargs["classification_type"] = ct
        kwargs.update(pick(spec, ("decision_threshold",)))
    else:
        raise SpecError(
            f"{where}: unknown concept type '{ctype}' "
            f"(use string, boolean, numerical, date, rating, json_object or label)"
        )

    examples = spec.get("examples")
    if examples:
        if not isinstance(examples, list):
            raise SpecError(f"{where}: 'examples' must be a list")
        from contextgem import JsonObjectExample, StringExample

        if ctype == "json_object":
            kwargs["examples"] = [JsonObjectExample(value=ex if isinstance(ex, dict) else {"value": ex}) for ex in examples]
        else:
            kwargs["examples"] = [StringExample(value=str(ex)) for ex in examples]

    kwargs["name"] = spec["name"]
    kwargs["description"] = spec["description"]
    try:
        return ctype, cls(**kwargs)
    except Exception as e:  # pydantic validation of the built kwargs
        raise SpecError(f"{where}: ContextGem rejected the concept: {e}") from e


def build_aspect(spec, where):
    from contextgem import Aspect

    if not spec.get("name") or not spec.get("description"):
        raise SpecError(f"{where}: aspect needs a non-empty 'name' and 'description'")
    kwargs = pick(spec, ASPECT_FIELDS)
    kwargs["name"] = spec["name"]
    kwargs["description"] = spec["description"]

    sub_aspects = spec.get("aspects") or spec.get("sub_aspects")
    if sub_aspects:
        kwargs["aspects"] = [build_aspect(a, f"{where}.aspects[{i}]") for i, a in enumerate(sub_aspects)]
    concepts = spec.get("concepts")
    if concepts:
        kwargs["concepts"] = [build_concept(c, f"{where}.concepts[{i}]")[1] for i, c in enumerate(concepts)]
    try:
        return Aspect(**kwargs)
    except Exception as e:
        raise SpecError(f"{where}: ContextGem rejected the aspect: {e}") from e


def build_document(job):
    from contextgem import Document

    text = job.get("text")
    file_path = job.get("file_path")
    if not text and not file_path:
        raise SpecError("provide either 'text' or 'file_path'")
    kwargs = {}
    segmentation = job.get("segmentation")
    if segmentation:
        if segmentation not in ("newlines", "sat"):
            raise SpecError("segmentation must be 'newlines' or 'sat'")
        kwargs["paragraph_segmentation_mode"] = segmentation
    if file_path:
        stage(f"converting {file_path} with Docling")
        try:
            from docling.document_converter import DocumentConverter
        except ImportError as e:
            raise SpecError(
                "DOCLING_MISSING: file extraction needs the docling extra. "
                "Run ContextGem Doctor or POST {\"install_docling\": true} to "
                "contextgem-enconvo/setup, then retry."
            ) from e
        result = DocumentConverter().convert(file_path)
        doc = Document.from_docling(result.document, **kwargs)
        source = f"file:{file_path}"
    else:
        doc = Document(raw_text=text, **kwargs)
        source = "text"
    return doc, source


def collect_concept_types(aspects, concepts):
    """Return (closed_locations, open_locations) across top-level and aspect-nested concepts."""
    closed, open_ = [], []

    def classify(specs, where):
        for i, c in enumerate(specs or []):
            ctype = c.get("type")
            loc = f"{c.get('name', where + '[' + str(i) + ']')}"
            (closed if ctype in CLOSED_CONCEPT_TYPES else open_).append(loc)

    classify(concepts, "concepts")

    def walk_aspects(specs, where):
        for i, a in enumerate(specs or []):
            aw = f"{where}[{i}]"
            classify(a.get("concepts"), f"{aw}.concepts")
            walk_aspects(a.get("aspects") or a.get("sub_aspects"), f"{aw}.aspects")

    walk_aspects(aspects, "aspects")
    return closed, open_


def mark_closed_concepts(aspects, concepts, role):
    """Set model_role on closed-type concepts (top-level and aspect-nested) for group routing."""

    def mark(specs):
        for c in specs or []:
            if c.get("type") in CLOSED_CONCEPT_TYPES and not c.get("model_role"):
                c["model_role"] = role

    mark(concepts)

    def walk(specs):
        for a in specs or []:
            mark(a.get("concepts"))
            walk(a.get("aspects") or a.get("sub_aspects"))

    walk(aspects)


def build_llm(cfg):
    from contextgem import DocumentLLM

    fields = (
        "model",
        "api_key",
        "api_base",
        "api_version",
        "reasoning_effort",
        "output_language",
        "temperature",
        "top_p",
        "max_tokens",
        "system_message",
        "timeout",
    )
    kwargs = {k: v for k, v in (cfg or {}).items() if k in fields and v not in (None, "")}
    if not kwargs.get("model"):
        raise SpecError("no LLM model configured: set the LLM Model preference or llm.model")
    # No key set: LiteLLM falls back to the provider's own environment variable
    # (OPENAI_API_KEY, ANTHROPIC_API_KEY, ...) and local models need none.
    return DocumentLLM(**kwargs)


def build_decision_model(cfg, role=None):
    from contextgem import DocumentDecisionModel

    fields = ("model", "api_key", "api_base", "decision_threshold", "timeout")
    kwargs = {k: v for k, v in (cfg or {}).items() if k in fields and v not in (None, "")}
    if not kwargs.get("model"):
        raise SpecError("no decision engine configured: set the Decision Engine preference to Jev")
    if role:
        kwargs["role"] = role
    return DocumentDecisionModel(**kwargs)


def ser_value(v):
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, (date, datetime)):
        return v.isoformat()
    if isinstance(v, dict):
        return {str(k): ser_value(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [ser_value(x) for x in v]
    dump = getattr(v, "model_dump", None)
    if callable(dump):
        try:
            return ser_value(dump())
        except Exception:
            pass
    return str(v)


def ser_probabilities(item):
    prob = getattr(item, "probabilities", None)
    if not prob:
        return None
    out = {}
    for k, v in prob.items():
        if k is True:
            key = "true"
        elif k is False:
            key = "false"
        else:
            key = str(k)
        try:
            out[key] = round(float(v), 4)
        except (TypeError, ValueError):
            out[key] = ser_value(v)
    return out


def ser_item(item):
    out = {"value": ser_value(getattr(item, "value", None))}
    justification = getattr(item, "justification", None)
    if justification:
        out["justification"] = justification
    for attr in ("reference_paragraphs", "reference_sentences"):
        refs = getattr(item, attr, None)
        if refs:
            texts = []
            for r in refs:
                t = getattr(r, "raw_text", None)
                texts.append(t if isinstance(t, str) else ser_value(r))
            out[attr] = texts
    pages = getattr(item, "reference_page_numbers", None)
    if pages:
        out["reference_page_numbers"] = [int(p) for p in pages]
    prob = ser_probabilities(item)
    if prob:
        out["probabilities"] = prob
    return out


def concept_type_of(concept):
    from contextgem import (
        BooleanConcept,
        DateConcept,
        JsonObjectConcept,
        LabelConcept,
        NumericalConcept,
        RatingConcept,
        StringConcept,
    )

    for cls, name in (
        (StringConcept, "string"),
        (BooleanConcept, "boolean"),
        (NumericalConcept, "numerical"),
        (DateConcept, "date"),
        (RatingConcept, "rating"),
        (JsonObjectConcept, "json_object"),
        (LabelConcept, "label"),
    ):
        if isinstance(concept, cls):
            return name
    return type(concept).__name__


def ser_concept(concept):
    return {
        "name": concept.name,
        "type": concept_type_of(concept),
        "items": [ser_item(i) for i in (concept.extracted_items or [])],
    }


def ser_aspect(aspect, depth=0):
    out = {
        "name": aspect.name,
        "items": [ser_item(i) for i in (aspect.extracted_items or [])],
        "concepts": [ser_concept(c) for c in (aspect.concepts or [])],
        "aspects": [ser_aspect(a, depth + 1) for a in (aspect.aspects or [])],
    }
    return out


def model_stats(model):
    """Token, call and cost totals only: the raw usage records hold every prompt and the document text."""
    stats = {}
    try:
        usage = [ser_value(u) for u in (model.get_usage() or [])]
        rows = []
        for u in usage:
            tokens = u.get("usage") or {}
            rows.append(
                {
                    "model": u.get("model"),
                    "role": u.get("role"),
                    "input_tokens": tokens.get("input"),
                    "output_tokens": tokens.get("output"),
                    "cache_read_tokens": tokens.get("cache_read"),
                    "cache_write_tokens": tokens.get("cache_write"),
                    "calls": len(tokens.get("calls") or []),
                }
            )
        if rows:
            stats["usage"] = rows
    except Exception:
        pass
    try:
        costs = []
        for c in model.get_cost() or []:
            cost = ser_value(getattr(c, "cost", None)) or {}
            costs.append({"model": getattr(c, "model", None), "role": getattr(c, "role", None), **cost})
        if costs:
            stats["cost"] = costs
    except Exception:
        pass
    return stats or None


def run(job):
    dry_run = bool(job.get("dry_run"))
    engine = job.get("engine") or "llm"
    if engine not in ("llm", "decision_model", "auto"):
        raise SpecError("engine must be 'llm', 'decision_model' or 'auto'")

    register = job.get("register_model")
    if register:
        import litellm

        litellm.register_model(register)

    aspects_specs = job.get("aspects") or []
    concepts_specs = job.get("concepts") or []
    if not aspects_specs and not concepts_specs:
        raise SpecError("nothing to extract: provide 'aspects' and/or 'concepts'")

    doc, source = build_document(job)

    closed_locs, open_locs = collect_concept_types(aspects_specs, concepts_specs)
    has_open = bool(aspects_specs or open_locs)

    dm_cfg = job.get("decision_model") or {}
    dm_configured = bool(dm_cfg.get("model"))

    if engine == "decision_model":
        if not dm_configured:
            raise SpecError(
                "engine 'decision_model' needs a decision engine: set the Decision Engine preference to Jev (Enconvo Cloud)"
            )
        if open_locs or aspects_specs:
            targets = (["aspects"] if aspects_specs else []) + open_locs
            raise SpecError(
                "a decision model extracts only boolean, label and rating concepts; "
                f"the spec also has open-ended targets: {', '.join(targets)}. "
                "Use engine 'auto' or 'llm' for those."
            )

    use_group = False
    if engine == "auto" and dm_configured and closed_locs:
        if has_open:
            use_group = True
            mark_closed_concepts(aspects_specs, concepts_specs, "decider")

    stage("building aspects and concepts")
    aspects = [build_aspect(a, f"aspects[{i}]") for i, a in enumerate(aspects_specs)]
    concepts = [build_concept(c, f"concepts[{i}]")[1] for i, c in enumerate(concepts_specs)]
    if aspects:
        doc.add_aspects(aspects)
    if concepts:
        doc.add_concepts(concepts)

    plan = {
        "source": source,
        "paragraphs": len(getattr(doc, "paragraphs", None) or []),
        "aspects": [a.name for a in aspects],
        "concepts": [f"{c.name} ({concept_type_of(c)})" for c in concepts],
        "engine": "model_group" if use_group else ("decision_model" if engine == "decision_model" or (engine == "auto" and dm_configured and not has_open) else "llm"),
    }

    if dry_run:
        return {"ok": True, "dry_run": True, "plan": plan}

    stats = {}
    if use_group:
        from contextgem import DocumentModelGroup

        stage("extracting with model group (LLM + decision model)")
        llm = build_llm(job.get("llm"))
        dm = build_decision_model(dm_cfg, role="decider")
        group = DocumentModelGroup(models=[llm, dm])
        group.extract_all(doc)
        stats["llm"] = model_stats(llm)
        stats["decision_model"] = model_stats(dm)
        used_engine = "model_group"
    elif engine == "decision_model" or (engine == "auto" and dm_configured and not has_open):
        stage("extracting with the decision model")
        dm = build_decision_model(dm_cfg)
        dm.extract_all(doc)
        stats["decision_model"] = model_stats(dm)
        used_engine = "decision_model"
    else:
        stage("extracting with the LLM")
        llm = build_llm(job.get("llm"))
        llm.extract_all(doc)
        stats["llm"] = model_stats(llm)
        used_engine = "llm"

    stage("serializing results")
    result = {
        "ok": True,
        "engine": used_engine,
        "document": plan,
        # ContextGem attaches the documents' own copies of the aspects and concepts, and
        # those carry the extracted items, so serialize from the document, not the inputs.
        "aspects": [ser_aspect(a) for a in (doc.aspects or [])],
        "concepts": [ser_concept(c) for c in (doc.concepts or [])],
    }
    stats = {k: v for k, v in stats.items() if v}
    if stats:
        result["stats"] = stats
    return result


def main():
    if len(sys.argv) != 2:
        print("usage: runner.py <out.json>  (job JSON on stdin)", file=sys.stderr)
        return 2
    out_path = sys.argv[1]
    try:
        try:
            job = json.load(sys.stdin)
        except json.JSONDecodeError as e:
            raise SpecError(f"the job on stdin is not valid JSON: {e}") from e
        if not isinstance(job, dict):
            raise SpecError("the job on stdin must be a JSON object")
        result = run(job)
        code = 0
    except SpecError as e:
        result = {"ok": False, "error": str(e), "error_code": "BAD_SPEC"}
        code = 1
    except KeyboardInterrupt:
        result = {"ok": False, "error": "interrupted", "error_code": "INTERRUPTED"}
        code = 130
    except Exception as e:
        result = {
            "ok": False,
            "error": f"{type(e).__name__}: {e}",
            "error_code": "EXTRACTION_FAILED",
            "traceback": traceback.format_exc(limit=8),
        }
        code = 1
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    if not result.get("ok"):
        print(result.get("error", "unknown error"), file=sys.stderr)
    return code


if __name__ == "__main__":
    sys.exit(main())
