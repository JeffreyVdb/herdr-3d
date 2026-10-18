"""Research probes for provider delimiters and the product's 16 KiB limit."""
import json
import os
from pathlib import Path
import subprocess
import time

from followup import OUT
from rules_probe import combine, scan


def main():
    cases=json.loads((OUT/'challenge-corpus.json').read_text())
    hf=next(c for c in cases if c['family']=='hf-valid')
    a,b=hf['expected'][0]
    token=hf['text'][a:b]
    assert len(token)==37 and token[3:].isalpha()
    svc=subprocess.Popen(['/tmp/herdr-secret-tools/gitleaks-service'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True,env={**os.environ,'GOMAXPROCS':'4'})
    def detect(text):
        svc.stdin.write(json.dumps({'text':text})+'\n'); svc.stdin.flush()
        return json.loads(svc.stdout.readline())
    detect('Warmup.')
    boundaries={}
    for name,suffix in [('end',''),('space',' '),('period','.'),('comma',','),('semicolon',';'),('right-paren',')'),('quote','"'),('newline','\n')]:
        text='Use '+token+suffix
        r=detect(text)
        boundaries[name]=dict(exact=any(f['Secret']==token for f in r['findings'] or []),rule_ids=[f['RuleID'] for f in r['findings'] or []])
    max_cases=[]
    value='NeverIssued9!'+('A1b2C3d4'*3)
    insertion='\nDB_PASSWORD="'+value+'"\n'
    n=16384-len(insertion)
    padding=('Review the module. '*(n//19+1))[:n]
    for position in [0,n//2,n]:
        text=padding[:position]+insertion+padding[position:]
        assert len(text.encode())==16384
        expected=[position+len('\nDB_PASSWORD="'),position+len('\nDB_PASSWORD="')+len(value)]
        elapsed=[]
        for _ in range(5):
            start=time.perf_counter()
            r=detect(text)
            import re
            pred=[m.span() for f in r['findings'] or [] for m in re.finditer(re.escape(f['Secret']),text)]
            pred=combine(scan(text),pred)
            elapsed.append((time.perf_counter()-start)*1000)
        max_cases.append(dict(position=position,bytes=len(text.encode()),expected=expected,predictions=pred,exact=tuple(expected) in pred,latencies_ms=elapsed))
    svc.stdin.close(); assert svc.wait(timeout=5)==0
    out=dict(provider='huggingface',token=token,delimiters=boundaries,max_accepted_prompt_bytes=16384,max_prompt_cases=max_cases,
             note='Synthetic scanner-grammar-valid token, not provider-issued; original 17,064-byte pilot is above current worker.prompt limit. No application integration tested.')
    (OUT/'boundaries.json').write_text(json.dumps(out,indent=2)+'\n')
    print(json.dumps(out,indent=2))


if __name__=='__main__': main()
