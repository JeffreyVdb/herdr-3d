"""Verify pilot reports and evaluate simple detector unions without tuning."""
import hashlib
import json
from pathlib import Path

from bench import corpus, evaluate, merge

HERE = Path(__file__).resolve().parent
cases = json.loads((HERE / "corpus.json").read_text())
assert cases == corpus(), "Regenerate results after changing the fixture generator"
digest = hashlib.sha256((HERE / "corpus.json").read_bytes()).hexdigest()
files = ["gitleaks", "gitleaks-service", "detect-secrets", "gliner-pii-small-v1.0", "gliner2-privacy-filter-PII-multi", "gliner2-privacy-filter-PII-multi-chunked"]
reports, summary = {}, {}
for name in files:
    report = json.loads((HERE / (name + ".json")).read_text())
    if "corpus_sha256" in report["meta"]:
        assert report["meta"]["corpus_sha256"] == digest, name
    for threshold, result in report["results"].items():
        assert result["metrics"] == evaluate(cases, result["predictions"]), name
        summary[name + "@" + threshold] = result["metrics"]
    # The two frameworks return text as well as offsets. Check the offsets against
    # the canonical corpus, especially the repeated values and Unicode cases.
    for case in cases:
        for entity in report["raw"][case["id"]]:
            if "text" in entity:
                assert entity["text"] == case["text"][entity["start"]:entity["end"]], (name, case["id"])
    reports[name] = report

assert reports["gitleaks"]["results"]["0.5"]["predictions"] == reports["gitleaks-service"]["results"]["0.5"]["predictions"]
baseline = reports["gitleaks-service"]["results"]["0.5"]["predictions"]
hybrids = {}
for name in ["gliner-pii-small-v1.0", "gliner2-privacy-filter-PII-multi", "gliner2-privacy-filter-PII-multi-chunked"]:
    for threshold in ["0.3", "0.5", "0.7"]:
        model = reports[name]["results"][threshold]["predictions"]
        union = {case["id"]: merge(baseline[case["id"]] + model[case["id"]]) for case in cases}
        key = "gitleaks+" + name + "@" + threshold
        metrics = evaluate(cases, union)
        summary[key] = metrics
        hybrids[key] = dict(metrics=metrics, predictions=union)
(HERE / "hybrids.json").write_text(json.dumps(hybrids, indent=2) + "\n")
(HERE / "summary.json").write_text(json.dumps(dict(corpus_sha256=digest, results=summary), indent=2) + "\n")
for name, m in summary.items():
    print(f'{name}: exact {m["exact_tp"]}/{m["secrets"]}, precision {m["exact_precision"]:.1%}, covered {m["fully_covered"]}/{m["secrets"]}, negatives {m["negative_prompts_flagged"]}/{m["negative_prompts"]}')
for name, r in reports.items():
    print(name, "latency", r["short_latency_ms"], "RSS", r["peak_rss_mib"], "child RSS", r.get("child_peak_rss_mib"), "load_s", r["load_seconds"], "rules_ms", r["meta"].get("rules_load_ms"))
    for case in cases:
        if case["group"] == "long":
            print(" ", case["id"], len(case["text"].encode()), r["timings_ms"][case["id"]])
