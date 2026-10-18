# Prompt-secret benchmark follow-up: source findings

Investigated 2026-10-18 for [#108](https://github.com/JeffreyVdb/herdr-3d/issues/108).
This is source research, not new accuracy or latency measurements. The existing
[pilot](prompt-secret-bench/README.md) remains a diagnostic set. GLiNER2 source
links below pin repository revision `b86d35c02f2c1a4d9840ea50197bd1b6d13b031e`;
the installed pilot package was also inspected as `gliner2==2.1.0`.

## Highest-value hypotheses

**Separate credential recognition from exact boundary recovery.** GLiNER2's
default splitter keeps an entire HTTP URL as one word token and splits much other
punctuation into separate tokens. Character spans come from word-token start/end
positions. Consequently a query parameter value inside an atomic URL cannot be
an exact model prediction, even with perfect semantic recognition. The PII
checkpoint also has `max_width=8`: a punctuation-heavy password spanning more
than eight word tokens cannot be represented as one prediction. These are
representation limits, not threshold mistakes. Recover URL query/userinfo,
assignment/quoted values, authorization values and complete PEM blocks with
structure-aware boundaries; preserve original source bytes and measure those
recognizers independently. Do not blindly extend arbitrary prose predictions.
[Splitter source](https://github.com/fastino-ai/GLiNER2/blob/b86d35c02f2c1a4d9840ea50197bd1b6d13b031e/gliner2/processing/word_splitter.py),
[offset conversion](https://github.com/fastino-ai/GLiNER2/blob/b86d35c02f2c1a4d9840ea50197bd1b6d13b031e/gliner2/inference/candidate_decoder.py),
[PII configuration](https://huggingface.co/fastino/gliner2-privacy-filter-PII-multi/blob/1cb4166094dc58fa8d836429f060d6c95f62b495/config.json).

**Try narrower schemas before another large model.** The PII card explicitly
allows subsets of its credential labels. Compare all five pilot labels with
`password`/`api_key`/`access_token`, removing the broad `secret` label, then compare
descriptions that request literal authentication values and exclude variable
names, paths and placeholders. GLiNER2 supports descriptions and per-label
thresholds. A precision improvement here is a hypothesis: the framework's
documentation examples do not establish credential results. Tune on development
examples, lock the schema/thresholds, and evaluate fresh templates and negatives.
[PII labels and limitations](https://huggingface.co/fastino/gliner2-privacy-filter-PII-multi),
[schema/threshold tutorial](https://github.com/fastino-ai/GLiNER2/blob/b86d35c02f2c1a4d9840ea50197bd1b6d13b031e/tutorial/2-ner.md).

**Resolve conflicts deliberately.** GLiNER2 supplies `allow`, `flat`/`disallow`,
`nested` and `longest` policies. `disallow` uses weighted interval scheduling;
it does not simply merge all intersecting spans. Resolution is per query/label,
so a hybrid still needs a global rule for conflicts across labels and detectors.
Compare model policies and prefer validated structural/format boundaries over
overbroad model spans. Report accuracy before and after resolution: merging
overlaps can destroy an otherwise exact prediction or create misleading coverage.
[Overlap implementation](https://github.com/fastino-ai/GLiNER2/blob/b86d35c02f2c1a4d9840ea50197bd1b6d13b031e/gliner2/inference/overlap.py),
[per-query decoding](https://github.com/fastino-ai/GLiNER2/blob/b86d35c02f2c1a4d9840ea50197bd1b6d13b031e/gliner2/inference/candidate_decoder.py).

## CPU cost and alternative checkpoints

- **Chunk size and batching:** the long API defaults to 384 words, 64 overlap,
  batch size 8. Compare smaller windows such as 128/32 or 192/32 and batch size
  1/2 on CPU. Include secrets at every boundary and preserve enough surrounding
  context. These windows count words, not encoder subwords; token-heavy values
  and label overhead still need an encoded-input budget and explicit truncation
  detection. A span crossing every window cannot be reconstructed automatically.
  [Long extraction API](https://github.com/fastino-ai/GLiNER2/blob/b86d35c02f2c1a4d9840ea50197bd1b6d13b031e/gliner2/inference/runtime.py),
  [chunk construction](https://github.com/fastino-ai/GLiNER2/blob/b86d35c02f2c1a4d9840ea50197bd1b6d13b031e/gliner2/inference/chunking.py).
- **Knowledgator edge ONNX:** Apache-2.0, credential-aware, Ettin 32M backbone.
  Published `onnx/model_quint8.onnx` is 45,820,894 bytes, versus 181,078,966 bytes
  for float32 ONNX. This is the most concrete low-cost alternative to test against
  the pilot small model. Artifact size is not process RSS or measured speed.
  Compare float32 and UINT8 with identical labels, offsets and thread settings.
  [Model card](https://huggingface.co/knowledgator/gliner-pii-edge-v1.0),
  [configuration](https://huggingface.co/knowledgator/gliner-pii-edge-v1.0/blob/9b7f39b0a2da971a5beea78d35f1539d4009c891/gliner_config.json),
  [artifact inventory](https://huggingface.co/knowledgator/gliner-pii-edge-v1.0/tree/9b7f39b0a2da971a5beea78d35f1539d4009c891/onnx).
- **GLiNER2.5 small:** Apache-2.0, 74M parameters, English, general extraction.
  Its boundary architecture removes the fixed width cap and loads through
  `AutoExtractor`, but still predicts word boundaries. It cannot alone recover a
  substring inside an atomic URL. It merits a small diagnostic comparison;
  there is no cited credential-specific result establishing superiority to the
  tested privacy fine-tune. [Model card](https://huggingface.co/fastino/gliner2.5-small-v1).
- **Quantization caveat:** legacy GLiNER2 `quantize()` calls `half()` (float16);
  it is not a CPU INT8 deployment path. ONNX Runtime warns that quantization can
  change accuracy and can be slower on some hardware. Its CPU thread pool also
  defaults independently of PyTorch; configure both explicitly and measure
  idle CPU/RSS as well as warm latency. [GLiNER2 implementation](https://github.com/fastino-ai/GLiNER2/blob/b86d35c02f2c1a4d9840ea50197bd1b6d13b031e/gliner2/models/span/model.py),
  [ONNX quantization](https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html),
  [ONNX threading](https://onnxruntime.ai/docs/performance/tune-performance/threading.html).

Changing the pretrained word splitter is supported but can change quality because
public checkpoints were trained with the default. Treat custom splitting as a
separate model experiment, not an innocent offset repair. No reviewed source
establishes a model with both better developer-credential recall and lower local
CPU latency than this shortlist. [Runtime splitter guidance](https://github.com/fastino-ai/GLiNER2/blob/b86d35c02f2c1a4d9840ea50197bd1b6d13b031e/README.md#custom-word-splitters).

## Source-inspected edge UINT8 load recipe

This recipe matches installed `gliner==0.2.29`. It was initially source-inspected;
the [benchmark follow-up](prompt-secret-benchmark-followup.md) subsequently
executed this load path and records the measured results.
Install CPU `onnxruntime` in the temporary benchmark environment. Provision public
files once, then load the returned local directory with offline flags:

```python
from huggingface_hub import snapshot_download
from gliner import GLiNER
import onnxruntime as ort

local_snapshot = snapshot_download(
    "knowledgator/gliner-pii-edge-v1.0",
    revision="9b7f39b0a2da971a5beea78d35f1539d4009c891",
    allow_patterns=["*.json", "onnx/model_quint8.onnx"],
)
options = ort.SessionOptions()
options.intra_op_num_threads = 4
options.inter_op_num_threads = 1
model = GLiNER.from_pretrained(
    local_snapshot,
    local_files_only=True,
    runtime="onnxruntime",
    runtime_model_file="onnx/model_quint8.onnx",
    runtime_options={
        "session_options": options,
        "providers": ["CPUExecutionProvider"],
    },
)
```

The ONNX branch wraps the exported graph and uses the checkpoint's shipped
`tokenizer_config.json`/`tokenizer.json`; it does not construct the PyTorch
encoder. Separate `jhu-clsp/ettin-encoder-32m` backbone weights are therefore not
required by this path with the complete local tokenizer assets. Calling GLiNER
with the remote repository ID instead of the selected local directory snapshots
the whole repository by default, including unnecessary float32/PyTorch files.
The legacy argument equivalent is `load_onnx_model=True` with
`onnx_model_file="onnx/model_quint8.onnx"`. These are code-path findings, not a
guarantee that the published artifact runs correctly with every runtime version.
[Loader/tokenizer source](https://github.com/urchade/GLiNER/blob/f3c945702b9b5cde381c27b95310c47909bcfd80/gliner/model.py),
[runtime adapter](https://github.com/urchade/GLiNER/blob/f3c945702b9b5cde381c27b95310c47909bcfd80/gliner/runtime/onnx.py),
[checkpoint assets](https://huggingface.co/knowledgator/gliner-pii-edge-v1.0/tree/9b7f39b0a2da971a5beea78d35f1539d4009c891).

## Corpus correction before comparing headline scores

The pilot's `openai` value is `sk-proj-` plus 120 random alphanumeric characters;
Gitleaks 8.30.1's dedicated rule requires the embedded marker `T3BlbkFJ` and
specific lengths. The pilot's Hugging Face generator allows digits; the dedicated
rule matches `hf_` followed by 34 letters. Keep these examples as malformed or
unknown-token cases, and add independently generated values matching documented
scanner grammars. Otherwise the provider group mixes format coverage with
contextual fallback. Matching scanner grammar does not prove provider validity.
[Pinned OpenAI rule](https://github.com/gitleaks/gitleaks/blob/v8.30.1/cmd/generate/config/rules/openai.go),
[pinned Hugging Face rule](https://github.com/gitleaks/gitleaks/blob/v8.30.1/cmd/generate/config/rules/huggingface.go),
[pilot generator](prompt-secret-bench/bench.py).

Use the pilot for failure analysis, not a new holdout. Any tuned result needs a
fresh corpus with more clean prompts, multiple seeds/templates per credential
family, Unicode/casefolding, escaped values, repeated literals and long-window
boundary positions. Report exact spans, per-family misses, partial leakage,
negative-prompt false positives, cold load, warm p50/p95 and RSS separately.
