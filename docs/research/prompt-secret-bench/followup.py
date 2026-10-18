"""Research-only ablations. Keeps the original fixtures/reports untouched."""
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import resource
import statistics
import subprocess
import time

from bench import evaluate, merge
from rules_probe import combine, scan as structure_scan

HERE = Path(__file__).resolve().parent
OUT = HERE / "followup"
MODEL = "fastino/gliner2-privacy-filter-PII-multi"
REV = "1cb4166094dc58fa8d836429f060d6c95f62b495"


def proc_peak(pid):
    # ru_maxrss can carry a launcher's historical high-water mark across exec.
    for line in Path(f"/proc/{pid}/status").read_text().splitlines():
        if line.startswith("VmHWM:"):
            return int(line.split()[1])/1024
    return None


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--variant", choices=["structure", "gliner2-original", "gliner2-window128", "gliner2-narrow", "gliner2-described"], required=True)
    p.add_argument("--corpus", type=Path, default=HERE / "corpus.json")
    p.add_argument("--repeats", type=int, default=3)
    args = p.parse_args()
    cases = json.loads(args.corpus.read_text())
    OUT.mkdir(exist_ok=True)
    start = time.perf_counter()
    meta = dict(variant=args.variant, repeats=args.repeats, corpus_sha256=hashlib.sha256(args.corpus.read_bytes()).hexdigest(),
                probe_sha256=hashlib.sha256((HERE / "rules_probe.py").read_bytes()).hexdigest(),
                runner_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
    service = None
    if args.variant == "structure":
        service = subprocess.Popen(["/tmp/herdr-secret-tools/gitleaks-service"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env={**os.environ, "GOMAXPROCS": "4"})
        def detector(text):
            service.stdin.write(json.dumps(dict(text=text)) + "\n")
            service.stdin.flush()
            result = json.loads(service.stdout.readline())
            meta["rules_load_ms"] = result["load_ms"]
            import re
            return [dict(start=m.start(), end=m.end(), score=1, label=f["RuleID"]) for f in result["findings"] or [] for m in re.finditer(re.escape(f["Secret"]), text)]
        thresholds = [.5]
    else:
        import torch
        from gliner2 import GLiNER2
        torch.set_num_threads(4)
        model = GLiNER2.from_pretrained(MODEL, revision=REV, local_files_only=True).eval()
        labels = ["password", "secret", "api_key", "access_token", "recovery_code"]
        if args.variant == "gliner2-narrow":
            labels = ["password", "api_key", "access_token"]
        if args.variant == "gliner2-described":
            labels = {
                "password": "An actual literal password or passphrase value, including all punctuation; exclude variable names, placeholders and references to files.",
                "api_key": "An actual secret API credential value, excluding its variable name and example placeholders.",
                "access_token": "An actual secret authentication or bearer token value, excluding labels, public keys and example placeholders.",
            }
        window = 128 if args.variant == "gliner2-window128" else 384
        meta.update(model=MODEL, revision=REV, labels=labels, chunk_size=window, chunk_overlap=32 if window==128 else 64, batch_size=1, threads=4,
                    versions={n:importlib.metadata.version(n) for n in ["gliner2", "torch", "transformers"]})
        def detector(text):
            with torch.inference_mode():
                common = dict(threshold=.3, include_confidence=True, include_spans=True)
                if len(text) > 4096:
                    result = model.extract_entities_long(text, labels, chunk_size=window, chunk_overlap=meta["chunk_overlap"], batch_size=1, **common)
                else:
                    result = model.extract_entities(text, labels, **common)
            return [dict(start=e["start"], end=e["end"], score=e["confidence"], label=label) for label, ents in result["entities"].items() for e in ents]
        thresholds = [.3, .5, .7, .9]
    load_seconds = time.perf_counter() - start
    detector("The password is Pilot9!Sparrow.")
    raw, timing, structure_timing = {}, {}, {}
    structures, strict = {}, {}
    for c in cases:
        elapsed, struct_elapsed = [], []
        for _ in range(args.repeats):
            start = time.perf_counter()
            entities = detector(c["text"])
            elapsed.append((time.perf_counter()-start)*1000)
            start = time.perf_counter()
            spans = structure_scan(c["text"])
            struct_elapsed.append((time.perf_counter()-start)*1000)
        raw[c["id"]], timing[c["id"]], structure_timing[c["id"]] = entities, elapsed, struct_elapsed
        structures[c["id"]] = spans
        strict[c["id"]] = structure_scan(c["text"], prose=False)
    child_proc_peak = proc_peak(service.pid) if service else None
    if service:
        service.stdin.close()
        assert service.wait(timeout=5) == 0
    results = {}
    for t in thresholds:
        pred = {k:merge([[e["start"],e["end"]] for e in es if e["score"]>=t]) for k, es in raw.items()}
        candidates = {"raw":pred, "structure":structures, "strict_structure":strict,
                      "combined":{k:combine(structures[k],pred[k]) for k in pred},
                      "strict_combined":{k:combine(strict[k],pred[k]) for k in pred}}
        for name, predictions in candidates.items():
            key=f"{name}@{t}"
            results[key]=dict(metrics=evaluate(cases,predictions), predictions=predictions)
    def latency(timings):
        short = [v for c in cases if c["group"]!="long" for v in timings[c["id"]]]
        return dict(p50=statistics.median(short),p95=sorted(short)[int(len(short)*.95)])
    combined_timing = {k:[a+b for a,b in zip(timing[k],structure_timing[k])] for k in timing}
    result=dict(meta=meta, load_seconds=load_seconds, raw=raw, timings_ms=timing, structure_timings_ms=structure_timing,
                combined_timings_ms=combined_timing, short_latency_ms=latency(timing), combined_short_latency_ms=latency(combined_timing),
                proc_peak_rss_mib=proc_peak(os.getpid()), child_proc_peak_rss_mib=child_proc_peak,
                peak_rss_mib=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024,
                child_peak_rss_mib=resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss/1024, results=results)
    filename = OUT / f"{args.corpus.stem}-{args.variant}.json"
    filename.write_text(json.dumps(result,indent=2,ensure_ascii=False)+"\n")
    print(filename)
    print(json.dumps({k:result[k] for k in ["load_seconds","short_latency_ms","combined_short_latency_ms","peak_rss_mib","child_peak_rss_mib"]}))
    for key, value in results.items():
        m=value["metrics"]
        print(key, f'exact {m["exact_tp"]}/{m["secrets"]}, precision {m["exact_precision"]:.1%}, clean flagged {m["negative_prompts_flagged"]}/{m["negative_prompts"]}, partial {m["partial_only"]}')


if __name__ == "__main__":
    main()
