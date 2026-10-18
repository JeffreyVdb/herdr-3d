"""Isolate the challenge's random request-ID suffix without detector tuning.

Thirty unique clean templates, stripped only of the appended metadata. A single
unchanged positive anchor keeps the shared evaluator's recall denominator valid.
This is a paired stress ablation, not another independent holdout.
"""
import json
from pathlib import Path

out=Path(__file__).resolve().parent/'followup'
cases=json.loads((out/'challenge-corpus.json').read_text())
selected=[next(c for c in cases if c['family']=='env-quoted')]
seen=set()
for c in cases:
    if c['expected'] or c['family'] in seen:
        continue
    seen.add(c['family'])
    text,suffix=c['text'].rsplit('\nContext request ',1)
    assert suffix and not c['expected']
    selected.append({**c,'text':text,'id':c['id']+'-no-identifier'})
assert len(selected)==31 and len(seen)==30
(out/'clean-ablation-corpus.json').write_text(json.dumps(selected,indent=2,ensure_ascii=False)+'\n')
print('Wrote 30 clean templates without metadata and one unchanged positive anchor.')
