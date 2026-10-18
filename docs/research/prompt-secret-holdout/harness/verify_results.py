#!/usr/bin/env python3
"""Independent cross-check of saved measurements, classifications and denominators."""
import collections,hashlib,json,subprocess
from pathlib import Path
p=Path(__file__).resolve().parent;e=p.parent
m=json.loads((p/'measurements.json').read_text());r=json.loads((p/'results.json').read_text())
corpus=[json.loads(x) for x in (e/'corpus.jsonl').read_text().splitlines()]
for name,h in json.loads((e/'freeze.json').read_text())['sha256'].items():assert hashlib.sha256((e/name).read_bytes()).hexdigest()==h,name
assert len(corpus)==len(m['accuracy'])==len(r['prompts'])==765
assert [x['id'] for x in corpus]==[x['id'] for x in m['accuracy']]==[x['id'] for x in r['prompts']]
counts=collections.Counter();cats=collections.defaultdict(collections.Counter)
for source,observed,result in zip(corpus,m['accuracy'],r['prompts']):
 cs=observed['candidates'] or [];spans=[(c['Start'],c['End']) for c in cs];b=source['text'].encode()
 assert len(spans)==len(set(spans));assert all(0<=a<z<=len(b) for a,z in spans)
 assert all(spans[i][1]<=spans[i+1][0] for i in range(len(spans)-1))
 for c,rc in zip(cs,result['candidates']):
  a,z=c['Start'],c['End'];assert b[a:z].decode()==rc['raw_source'];assert len(b[:a].decode().encode('utf-16-le'))//2==rc['start_u16'];assert len(b[:z].decode().encode('utf-16-le'))//2==rc['end_u16']
 if source['split']=='clean':counts['clean_highlights']+=len(cs);counts['clean_review_openings']+=bool(cs);continue
 if source.get('over_limit'):continue
 for s,rs in zip(source['secrets'],result['secrets']):
  a,z=s['start'],s['end'];exact=(a,z) in spans;ovs=[(x,y) for x,y in spans if x<z and y>a];partial=any(x>a or y<z for x,y in ovs);over=any(x<=a and y>=z and (x,y)!=(a,z) for x,y in ovs)
  uncovered=sum(all(not(x<=v<y) for x,y in spans) for v in range(a,z))
  expected='exact' if exact else 'overbroad' if over else 'partial_overlap' if partial else 'missed'
  assert rs['outcome']==expected;assert rs['unprotected_byte_count']==uncovered;assert rs['full_coverage']==(uncovered==0)
  for counter in [counts,cats[source['category']]]:
   counter['denominator']+=1;counter['exact']+=exact;counter['full_coverage']+=uncovered==0;counter['partial_overlap_occurrences']+=partial;counter['overbroad_occurrences']+=over;counter['missed']+=not bool(ovs)
assert counts['denominator']==478
for name in ['denominator','exact','full_coverage','partial_overlap_occurrences','overbroad_occurrences','missed']:assert counts[name]==r['pooled'][name],name
for name,counter in cats.items():
 for key,value in counter.items():assert r['per_category'][name][key]==value,(name,key)
assert counts['clean_highlights']==r['clean']['false_highlights'];assert counts['clean_review_openings']==r['clean']['review_openings']
ids=[s['id'] for s in corpus if s['category']=='length' and not s.get('over_limit')]
assert len(ids)==34;assert [s['id'] for s in m['warm']]==ids*100
assert all(len(w)==100 for w in m['concurrent']['worker_ns']);assert len(m['concurrent']['worker_ns'])==4;assert len(m['cold'])==10;assert len(m['clean_warm'])==100
byid={a['id']:a for a in m['accuracy']}
assert all(w['candidate_count']==len(byid[w['id']]['candidates'] or []) for w in m['warm'])
assert not subprocess.check_output(['git','status','--porcelain'],cwd=m['checkout'],text=True)
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=m['checkout'],text=True).strip()==r['commit']
summary={'verified':True,'frozen_hashes':'all match','checkout':'pinned and clean','independent_recount':dict(counts),'accuracy_prompts':765,'warm_samples':3400,'round_robin_order':'verified','four_worker_samples':400,'cold_processes':10,'clean_diagnostic_samples':100,'warm_candidate_count_stability':'verified'}
(p/'verification.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary,indent=2))
