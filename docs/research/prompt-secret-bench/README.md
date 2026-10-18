# Prompt-secret extraction pilot

Investigated 2026-10-18 on `d24562ac5ec42ec9e9fa2a560683b5ff46ee73de`.
Research only; no product integration. See [candidate review](../prompt-secret-detectors-sources.md)
for primary sources, licenses and unmeasured alternatives, and [findings](../prompt-secret-extraction.md)
for the interpretation and ticket.

`bench.py` generates `corpus.json` with seed 1831: 54 prompts, 36 secret occurrences
in 32 positive prompts and 22 negatives. Values are generated test data, never real
credentials; the PEM body and JWT signature are deliberately not cryptographically
valid. Provider keys have realistic shapes but are not provider-issued. No provider
verification is performed. Model downloads use public model IDs; inference uses
cached artifacts with `HF_HUB_OFFLINE=1`.

Positive cases include provider tokens, unknown API tokens, passwords/passphrases,
headers, credential URLs, JSON, `.env`, PEM, multiline values, repeated values,
Unicode/Dutch, and secrets at the end of roughly 8 KiB/16 KiB prompts. Negatives
include placeholders, hashes, UUIDs, public SSH keys, file references, code and
unrelated PII. Only credentials are labeled, not names, email addresses or public keys.
This is a hand-authored diagnostic set, with no train/tune/holdout split and no
claim of production recall. Model training contamination and accidental real-world
collision of generated strings cannot be ruled out by this experiment.

Exact precision/recall requires identical complete spans. Full coverage also counts
overbroad spans, which can hide a value but write the wrong credential to its file.
Partial-only overlap leaves at least one secret character exposed. Overlapping
predictions are merged for evaluation. Adapters finding a captured string redact
every identical literal occurrence; the production adapter should retain source
coordinates and validate offsets. GLiNER confidence thresholds 0.3/0.5/0.7 are a
sensitivity sweep, not thresholds tuned on a separate dataset.

Runs warm up once, then scan each prompt three times (CLI Gitleaks: once). Short
p50/p95 excludes the two long prompts; raw timings retain them. Timings include
Python adapter/IPC overhead. Gitleaks CLI timings include process startup and rule
compilation; `gitleaks-service` reuses a detector so it approximates integration in
the Go bridge. Its `rules_load_ms` measures one-time compilation. Process RSS is
Linux `ru_maxrss`; child RSS is separate, and model RSS is the whole Python
runtime including the largest input, not weights alone. `load_seconds` includes
imports and cached load, excludes downloads, and for the service the first warmup
incurs actual rule compilation (reported separately).

Hardware: Intel Core i7-10750H, 6 cores/12 threads, 31 GiB RAM; CPU only, four
PyTorch threads. This is a shared workstation with other background work, including
compilation, and some runs overlapped. Treat latency and RSS as indicative pilot
measurements, not an isolated performance comparison or deployment SLA. Model
defaults are deliberately exercised; the small model warned about truncating the
longest input. Production requires explicit bounded chunking and boundary tests.

`detect-secrets` uses its documented `scan_line` API, default plugins/thresholds,
and disables verification. Its eager entropy API returns below-threshold candidates
for diagnostic display; the adapter reapplies each configured entropy threshold
before treating a candidate as a detection. Unfiltered `scan_line` results are not
a meaningful classifier. No other prompt-specific tuning was applied.

## Reproduction

Use a temporary environment rather than changing the application's dependencies:

```sh
uv venv --python 3.12.15 /tmp/herdr-secret-bench-venv
uv pip install --python /tmp/herdr-secret-bench-venv/bin/python torch==2.14.1+cpu --index-url https://download.pytorch.org/whl/cpu
uv pip install --python /tmp/herdr-secret-bench-venv/bin/python -r docs/research/prompt-secret-bench/requirements.txt
```

Download the two pinned public model snapshots once with `huggingface_hub.snapshot_download`:

| Model | Revision |
| --- | --- |
| `knowledgator/gliner-pii-small-v1.0` | `d21aad5b4a7ec82b3d0970fd1ac74a12c087d85e` |
| `fastino/gliner2-privacy-filter-PII-multi` | `1cb4166094dc58fa8d836429f060d6c95f62b495` |

For first load, the framework may need public backbone/tokenizer artifacts in the
cache too. Load once online with synthetic text, then run all inference offline.
No real prompts should be supplied to this harness: JSON reports contain raw
predictions and extracted values. The saved reports contain synthetic data only.

Build the separate Gitleaks helper (its module leaves the product `go.mod` alone),
and download the official Gitleaks v8.30.1 Linux x64 release for the CLI comparison:

```sh
cd docs/research/prompt-secret-bench/gitleaks-service
mise exec go@1.27.0 -- go build -o /tmp/herdr-secret-tools/gitleaks-service .
```

From the repository root:

```sh
HF_HUB_OFFLINE=1 /tmp/herdr-secret-bench-venv/bin/python docs/research/prompt-secret-bench/bench.py --detector gliner --revision d21aad5b4a7ec82b3d0970fd1ac74a12c087d85e
HF_HUB_OFFLINE=1 /tmp/herdr-secret-bench-venv/bin/python docs/research/prompt-secret-bench/bench.py --detector gliner2 --model fastino/gliner2-privacy-filter-PII-multi --revision 1cb4166094dc58fa8d836429f060d6c95f62b495
HF_HUB_OFFLINE=1 /tmp/herdr-secret-bench-venv/bin/python docs/research/prompt-secret-bench/bench.py --detector gliner2 --model fastino/gliner2-privacy-filter-PII-multi --revision 1cb4166094dc58fa8d836429f060d6c95f62b495 --chunked --repeats 1
/tmp/herdr-secret-bench-venv/bin/python docs/research/prompt-secret-bench/bench.py --detector detect-secrets
GOMAXPROCS=4 /tmp/herdr-secret-bench-venv/bin/python docs/research/prompt-secret-bench/bench.py --detector gitleaks-service --gitleaks /tmp/herdr-secret-tools/gitleaks-service
GOMAXPROCS=4 /tmp/herdr-secret-bench-venv/bin/python docs/research/prompt-secret-bench/bench.py --detector gitleaks --repeats 1
/tmp/herdr-secret-bench-venv/bin/python docs/research/prompt-secret-bench/summarize.py
```

The chunked comparison uses the same GLiNER2 API for short prompts, and the official
`extract_entities_long` defaults (384-word windows, 64-word overlap) for inputs
longer than 4,096 characters. It is a single-repeat follow-up, not a tuned model.
The first GLiNER2 default run preceded the addition of corpus-hash/version metadata
fields to the harness; its pinned revision and raw output are retained, and the
summarizer checks every saved metric against the canonical fixture spans.

For the CLI Gitleaks run, historical rusage maxima from earlier chained commands
appear in the recorded parent/child RSS fields. Do not use those fields to estimate
CLI memory; the separate persistent helper's child measurement is the relevant one.

## Benchmark-hardening follow-up

See [findings](../prompt-secret-benchmark-followup.md) and
[additional primary sources](../prompt-secret-followup-sources.md). All follow-up
code is a disposable research adapter, not an application implementation.
`rules_probe.py` was developed on the pilot, then frozen before `challenge.py`
was authored. The challenge has 138 prompts, 84 occurrences and 60 negatives;
the manifest records hashes, family counts and its same-author/template limitations.
Do not treat it as an independent production holdout or tune on its results.

The original pilot's OpenAI/HF fixtures are credential-like strings, not evidence
of dedicated-provider grammar coverage. `boundary_probe.py` separately exercises
a fresh scanner-grammar-valid HF token with punctuation and quoted values at the
application's exact 16,384-byte limit. The pilot's 17,064-byte input is a stress
case beyond that current limit.

Install the extra CPU ONNX runtime in the same temporary environment:

```sh
uv pip install --python /tmp/herdr-secret-bench-venv/bin/python -r docs/research/prompt-secret-bench/requirements-followup.txt
```

Provision public ONNX snapshots once with `snapshot_download`, using
`allow_patterns=['*.json', '<artifact>']` and these pinned revisions. Never enable
provider verification. All inference commands below use the cache offline.

| Model | Revision | Artifacts tested |
| --- | --- | --- |
| `knowledgator/gliner-pii-edge-v1.0` | `9b7f39b0a2da971a5beea78d35f1539d4009c891` | `onnx/model.onnx`, `onnx/model_quint8.onnx` |
| `knowledgator/gliner-pii-small-v1.0` | `d21aad5b4a7ec82b3d0970fd1ac74a12c087d85e` | `onnx/model_quint8.onnx` |

From the repo root, run sequentially to avoid benchmark contention:

```sh
/tmp/herdr-secret-bench-venv/bin/python docs/research/prompt-secret-bench/followup.py --variant structure --repeats 5
/tmp/herdr-secret-bench-venv/bin/python docs/research/prompt-secret-bench/challenge.py
/tmp/herdr-secret-bench-venv/bin/python docs/research/prompt-secret-bench/followup.py --variant structure --corpus docs/research/prompt-secret-bench/followup/challenge-corpus.json --repeats 5
HF_HUB_OFFLINE=1 /tmp/herdr-secret-bench-venv/bin/python docs/research/prompt-secret-bench/followup.py --variant gliner2-window128 --repeats 3
HF_HUB_OFFLINE=1 /tmp/herdr-secret-bench-venv/bin/python docs/research/prompt-secret-bench/followup.py --variant gliner2-narrow --repeats 3
HF_HUB_OFFLINE=1 /tmp/herdr-secret-bench-venv/bin/python docs/research/prompt-secret-bench/followup.py --variant gliner2-described --repeats 3
HF_HUB_OFFLINE=1 /tmp/herdr-secret-bench-venv/bin/python docs/research/prompt-secret-bench/followup.py --variant gliner2-described --corpus docs/research/prompt-secret-bench/followup/challenge-corpus.json --repeats 3
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 /tmp/herdr-secret-bench-venv/bin/python docs/research/prompt-secret-bench/edge_probe.py
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 /tmp/herdr-secret-bench-venv/bin/python docs/research/prompt-secret-bench/edge_probe.py --format fp32
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 /tmp/herdr-secret-bench-venv/bin/python docs/research/prompt-secret-bench/edge_probe.py --size small
/tmp/herdr-secret-bench-venv/bin/python docs/research/prompt-secret-bench/boundary_probe.py
/tmp/herdr-secret-bench-venv/bin/python docs/research/prompt-secret-bench/clean_ablation.py
HF_HUB_OFFLINE=1 /tmp/herdr-secret-bench-venv/bin/python docs/research/prompt-secret-bench/followup.py --variant gliner2-described --corpus docs/research/prompt-secret-bench/followup/clean-ablation-corpus.json --repeats 3
/tmp/herdr-secret-bench-venv/bin/python docs/research/prompt-secret-bench/summarize_followup.py
```

GLiNER2 uses `batch_size=1` for long inputs in these experiments. The window
ablation uses 128/32; narrow/description schemas use 384/64. Short inputs keep
the direct API. ONNX uses 160 whitespace-word windows with 32 overlap for long
inputs; those are not subword-budget guarantees. Full window-boundary and
no-truncation validation remains an implementation gate. Every original character
is included in some chunk; short/long outputs and model revisions are retained.

Results live under `followup/`. `summary.json` recomputes all combinations with
the frozen structure probe, checks fixture hashes and metrics, and includes
per-family results. An early window run retains its historical pre-freeze probe
hash; its current combination is the replay in this summary. Model-union timings
are component timings, not measured full-pipeline latency. Structure+Gitleaks
timings do measure their sequential combined work including helper IPC, but
exclude application/network/file storage costs. Peak RSS uses `/proc` VmHWM to
avoid inherited launcher peaks; raw `ru_maxrss` is diagnostic only. Pattern RSS
is reported separately for the Python process and Go helper.

The challenge negatives all include generated request-ID metadata. Treat their
high model false-positive rates as an adversarial stress result, not production
prevalence. `clean_ablation.py` removes only that suffix and deduplicates to 30
base clean templates, with one unchanged positive anchor for the evaluator.
The exact same described GLiNER2 settings are then run without tuning. This
paired ablation is separately recorded and verified by the summarizer.
