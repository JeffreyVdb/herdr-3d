# Independent phase-1 prompt-secret holdout

Created 2026-10-18 for issue #108. Phase 1 only: deterministic synthetic corpus, source-grounded provider grammar claims and targets frozen before detector evaluation. All artifacts live outside the repository. Phase 2 must be requested separately; no candidate detector has been run here.

## Regenerate and verify

From this directory, run:

```bash
python3 -I generate.py
python3 -I - <<'PY'
import hashlib, json
from pathlib import Path
p = Path('.')
m = json.loads((p / 'manifest.json').read_text())
assert hashlib.sha256((p / 'corpus.jsonl').read_bytes()).hexdigest() == m['sha256']
frozen = json.loads((p / 'freeze.json').read_text())
for name, expected in frozen['sha256'].items():
    assert hashlib.sha256((p / name).read_bytes()).hexdigest() == expected, name
print('Manifest and frozen artifact hashes verified')
PY
```

The generator uses only Python 3 stdlib, a local `random.Random(10820261018)`, fixed declaration date and insertion-slot annotations. `python3 -I` excludes ambient Python import customizations. It writes only corpus.jsonl and manifest.json alongside itself. It checks raw byte slices, ordered nonoverlapping spans, UTF-8/UTF-16 endpoint conversion, JSON and URL decoding, the generated POSIX shell subset, generated YAML scalar semantics, unique clean prompts, exact limit lengths, every 512-byte boundary and minimum coverage counts. Provider generators assert scanner grammar conformance, and malformed values assert nonconformance. Regenerate from unchanged generate.py; do not refresh freeze.json after seeing a detector result. The frozen hash, not a newly rewritten manifest alone, establishes identity.

Each JSONL line is one original prompt. Half-open `start`/`end` use UTF-8 bytes and `start_u16`/`end_u16` use UTF-16 code units. Raw and decoded values are both present, equal when no transformation applies. See targets.md for annotation and file-byte policy, occurrence matching, pass/fail gates and phase-2 measurement protocol. The `length` category includes three over-limit cases; exclude them from occurrence recall and require explicit product rejection. Malformed strings are still positive because their task context explicitly supplies an actual credential, without claiming a provider would issue or accept it.

## Independence and sources

The evaluator read this brief and `gh issue view 108` first as specified. issue-108.md preserves that spec snapshot. The issue itself includes historical benchmark summaries; those numbers were unavoidably visible in the requested spec. Neither evaluator nor source-research subagent read anything under docs/research/prompt-secret-bench/, internal/promptsecret/, or ~/.herdr/worktrees/herdr-3d/. The two permitted Markdown research write-ups were not needed and were not read. No pilot generators, pilot examples, results artifacts or candidate detector source/output informed templates or annotations.

A background source researcher, required by the research skill, read only version-pinned public Gitleaks rule sources through Alterlab MCP and wrote sources.md. No `parallel`/`tavily` skill or context7 MCP was available in the provided catalog, so the brief's next preferred web mechanism, Alterlab, was used. These independent public grammar sources are the permitted validity evidence, not the local module cache. Public sources can coincide with detector dependencies; this does not make the corpus an implementation-derived test. Lexical grammar validity is not proof of provider issuance or authentication validity. All values are seeded synthetic data; no provider validation API was used. PEM values have a valid Ed25519 PKCS8 DER envelope; JWT values are locally HMAC signed. The credentials grant no intended access.

No repository file was modified. This directory contains only evaluation artifacts. Phase-1 completion is published by writing the sibling ground-eval-p1.json.tmp and renaming it to ground-eval-p1.json in the same directory; that JSON is the orchestrator handoff, not permission to begin phase 2.

## Limits

This is a single-author synthetic holdout with repeated families, not a representative sample of production prompts. Generated value variation does not create independent language families. The 320 clean prompts consist of 20 families with 16 variants; many differ mainly in IDs or fixture values. Positives also reuse structures, and the long cases use repeated benign build logs. Report per-family results and avoid confidence intervals that assume every variant is an independent production draw. No production precision, population false-positive rate, adversarial robustness or usability claim follows from these counts.

Only six providers are represented, with additional GitHub/OpenAI generations. Grammar-valid scanner shapes are narrower than all provider formats and include legacy formats. AWS occurrences are access IDs, not complete access-ID/secret-key pairs. Malformed examples deliberately break one required prefix/alphabet position, not every possible mutation. Unicode includes combining and astral characters but no invalid UTF-8; YAML/TOML/shell coverage is a declared subset. Punctuation wrappers and annotation intent are synthetic. URL userinfo/password and full DSN annotations intentionally differ according to explicit slot context. Fixed 512-byte probes cannot exercise unknown tokenizer boundaries or all alignments. Phase 1 proves artifact consistency, not detection quality, integration correctness, latency, RSS, review behavior or secret-file lifecycle safety.
