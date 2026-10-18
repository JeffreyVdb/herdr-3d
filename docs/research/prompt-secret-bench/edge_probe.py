"""Offline research comparison of published GLiNER ONNX artifacts."""
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import statistics
import time

from bench import LABELS, evaluate, merge
from followup import HERE, OUT, proc_peak
from rules_probe import combine, scan as structure_scan


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--size",choices=["edge","small"],default="edge")
    parser.add_argument("--format",choices=["quint8","fp32"],default="quint8")
    args=parser.parse_args()
    start = time.perf_counter()
    import torch
    import onnxruntime as ort
    from gliner import GLiNER
    torch.set_num_threads(4)
    revision="9b7f39b0a2da971a5beea78d35f1539d4009c891" if args.size=="edge" else "d21aad5b4a7ec82b3d0970fd1ac74a12c087d85e"
    snapshot=Path.home()/f".cache/huggingface/hub/models--knowledgator--gliner-pii-{args.size}-v1.0/snapshots/{revision}"
    artifact="onnx/model_quint8.onnx" if args.format=="quint8" else "onnx/model.onnx"
    opts=ort.SessionOptions()
    opts.intra_op_num_threads=4
    opts.inter_op_num_threads=1
    model=GLiNER.from_pretrained(snapshot,local_files_only=True,runtime="onnxruntime",runtime_model_file=artifact,
                               runtime_options={"session_options":opts,"providers":["CPUExecutionProvider"]})
    load_seconds=time.perf_counter()-start
    def scan(text):
        words=list(re.finditer(r"\S+",text))
        chunks=[(0,len(text))] if len(words)<=160 else [(words[i].start(),words[min(i+160,len(words))-1].end()) for i in range(0,len(words),128)]
        entities=[]
        for a,b in chunks:
            for e in model.predict_entities(text[a:b],LABELS,threshold=.3):
                e={**e,"start":e["start"]+a,"end":e["end"]+a}
                assert e["text"]==text[e["start"]:e["end"]]
                entities.append(e)
        return entities
    scan("The password is Pilot9!Sparrow.")
    for filename in [HERE/"corpus.json",OUT/"challenge-corpus.json"]:
        cases=json.loads(filename.read_text())
        pattern_report=json.loads((OUT/f"{filename.stem}-structure.json").read_text())
        pattern=pattern_report["results"]["combined@0.5"]["predictions"]
        raw,timings={},{}
        for c in cases:
            elapsed=[]
            for _ in range(3):
                start=time.perf_counter()
                entities=scan(c["text"])
                elapsed.append((time.perf_counter()-start)*1000)
            raw[c["id"]],timings[c["id"]]=entities,elapsed
        results={}
        for threshold in [.3,.5,.7,.9]:
            pred={k:merge([[e["start"],e["end"]] for e in v if e["score"]>=threshold]) for k,v in raw.items()}
            union={k:combine(pattern[k],pred[k]) for k in pred}
            for name,predictions in [("raw",pred),("combined",union)]:
                results[f"{name}@{threshold}"]=dict(metrics=evaluate(cases,predictions),predictions=predictions)
        short=[v for c in cases if c["group"]!="long" for v in timings[c["id"]]]
        result=dict(meta=dict(model=f"knowledgator/gliner-pii-{args.size}-v1.0",revision=revision,artifact=artifact,
                             artifact_sha256=hashlib.sha256((snapshot/artifact).read_bytes()).hexdigest(),
                             corpus_sha256=hashlib.sha256(filename.read_bytes()).hexdigest(),labels=LABELS,threads=4,inter_op_threads=1,
                             chunk_size=160,chunk_overlap=32,repeats=3,
                             probe_sha256=hashlib.sha256((HERE/"rules_probe.py").read_bytes()).hexdigest(),
                             versions={n:importlib.metadata.version(n) for n in ["gliner","onnxruntime","torch","transformers"]}),
                    load_seconds=load_seconds,proc_peak_rss_mib=proc_peak(os.getpid()),raw=raw,timings_ms=timings,
                    short_latency_ms=dict(p50=statistics.median(short),p95=sorted(short)[int(len(short)*.95)]),results=results)
        suffix="uint8" if args.format=="quint8" else "fp32"
        output=OUT/f"{filename.stem}-{args.size}-{suffix}.json"
        output.write_text(json.dumps(result,indent=2,ensure_ascii=False)+"\n")
        print(output,flush=True)
        print({k:result[k] for k in ["load_seconds","proc_peak_rss_mib","short_latency_ms"]},flush=True)
        for key,res in results.items():
            m=res["metrics"]
            print(key,f'exact {m["exact_tp"]}/{m["secrets"]}, precision {m["exact_precision"]:.1%}, clean flagged {m["negative_prompts_flagged"]}/{m["negative_prompts"]}',flush=True)


if __name__=="__main__":
    main()
