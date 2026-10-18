"""Verify reports and replay all unions with the frozen structure probe.

Model unions are accuracy replays, not measured end-to-end pipeline latency.
"""
import hashlib
import json
from pathlib import Path

from bench import evaluate, merge
from rules_probe import combine, scan

HERE=Path(__file__).resolve().parent
OUT=HERE/'followup'
probe_hash=hashlib.sha256((HERE/'rules_probe.py').read_bytes()).hexdigest()
manifest=json.loads((OUT/'challenge-manifest.json').read_text())
assert probe_hash==manifest['rules_frozen_sha256'], 'No tuning after challenge'
summary={}
for corpus_file in [HERE/'corpus.json',OUT/'challenge-corpus.json']:
    cases=json.loads(corpus_file.read_text())
    digest=hashlib.sha256(corpus_file.read_bytes()).hexdigest()
    if corpus_file.stem=='challenge-corpus':
        assert digest==manifest['corpus_sha256']
    for c in cases:
        assert all(0<=a<b<=len(c['text']) for a,b in c['expected'])
        assert all(x[1]<=y[0] for x,y in zip(c['expected'],c['expected'][1:]))
    pattern_report=json.loads((OUT/f'{corpus_file.stem}-structure.json').read_text())
    assert pattern_report['meta']['probe_sha256']==probe_hash
    structures={c['id']:scan(c['text']) for c in cases}
    pattern=pattern_report['results']['combined@0.5']['predictions']
    family_cases=[{**c,'group':c.get('family',c['group'])} for c in cases]
    dataset={}
    for file in sorted(OUT.glob(f'{corpus_file.stem}-*.json')):
        if file.name in ['challenge-corpus.json']:
            continue
        r=json.loads(file.read_text())
        if 'raw' not in r: continue
        assert r['meta']['corpus_sha256']==digest,file
        assert set(r['raw'])=={c['id'] for c in cases},file
        for c in cases:
            for e in r['raw'][c['id']]:
                assert 0<=e['start']<e['end']<=len(c['text']),(file,c['id'])
                if 'text' in e:
                    assert e['text']==c['text'][e['start']:e['end']],(file,c['id'])
        for key,res in r['results'].items():
            assert res['metrics']==evaluate(cases,res['predictions']),(file,key)
        results={}
        thresholds=[.5] if file.stem.endswith('-structure') else [.3,.5,.7,.9]
        for t in thresholds:
            raw={k:merge([[e['start'],e['end']] for e in es if e['score']>=t]) for k,es in r['raw'].items()}
            replay=pattern if file.stem.endswith('-structure') else {k:combine(pattern[k],raw[k]) for k in raw}
            for name,pred in [('raw',raw),('pattern_union',replay)]:
                results[f'{name}@{t}']=dict(metrics=evaluate(cases,pred),per_family=evaluate(family_cases,pred)['groups'],predictions=pred)
        dataset[file.stem]=dict(short_latency_ms=r['short_latency_ms'],proc_peak_rss_mib=r['proc_peak_rss_mib'],
                                child_proc_peak_rss_mib=r.get('child_proc_peak_rss_mib'),load_seconds=r['load_seconds'],
                                long_timings_ms={c['id']:r['timings_ms'][c['id']] for c in cases if c['group']=='long'},
                                recorded_probe_sha256=r['meta']['probe_sha256'],results=results)
        print(file.stem,'short',r['short_latency_ms'],'RSS MiB',r['proc_peak_rss_mib'])
        for t in ([.5] if file.stem.endswith('-structure') else [.5,.7]):
            for name in ['raw','pattern_union']:
                m=results[f'{name}@{t}']['metrics']
                print(' ',name,t,f'exact {m["exact_tp"]}/{m["secrets"]}, precision {m["exact_precision"]:.1%}, full {m["fully_covered"]}, partial {m["partial_only"]}, clean {m["negative_prompts_flagged"]}/{m["negative_prompts"]}')
    summary[corpus_file.stem]=dict(corpus_sha256=digest,reports=dataset)
ablation_file=OUT/'clean-ablation-corpus.json'
ablation=json.loads(ablation_file.read_text())
ablation_report=json.loads((OUT/'clean-ablation-corpus-gliner2-described.json').read_text())
assert ablation_report['meta']['corpus_sha256']==hashlib.sha256(ablation_file.read_bytes()).hexdigest()
assert ablation_report['meta']['probe_sha256']==probe_hash
for key,res in ablation_report['results'].items():
    assert res['metrics']==evaluate(ablation,res['predictions']),key
summary['clean_ablation']=dict(corpus_sha256=ablation_report['meta']['corpus_sha256'],
    method='Thirty unique challenge clean templates with only appended request-ID metadata removed; unchanged model and one positive evaluator anchor.',
    results=ablation_report['results'])
(OUT/'summary.json').write_text(json.dumps(dict(frozen_probe_sha256=probe_hash,
    method='Raw inference retained. Pattern unions replayed using the frozen probe; component model timings only. Historical recorded probe hashes can differ before freeze.',
    datasets=summary),indent=2,ensure_ascii=False)+'\n')
