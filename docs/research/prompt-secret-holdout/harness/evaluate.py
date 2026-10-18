#!/usr/bin/env python3
import hashlib,json,math,os,platform,subprocess,sys,time
from pathlib import Path
P=Path(__file__).resolve().parent
E=P.parent
checkout=Path(sys.argv[1] if len(sys.argv)>1 else str(Path(__file__).resolve().parents[4])).resolve()
def command(args,cwd=None):
 return subprocess.check_output(args,cwd=cwd,text=True,stderr=subprocess.STDOUT)
def verify():
 for n,h in json.loads((E/'freeze.json').read_text())['sha256'].items():
  assert hashlib.sha256((E/n).read_bytes()).hexdigest()==h,n
 assert hashlib.sha256((E/'corpus.jsonl').read_bytes()).hexdigest()==json.loads((E/'manifest.json').read_text())['sha256']
verify()
status=command(['git','status','--porcelain'],checkout); assert not status,status
head=command(['git','rev-parse','HEAD'],checkout).strip()
def host():
 d={'utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'uname':platform.uname()._asdict(),'affinity':sorted(os.sched_getaffinity(0)),'loadavg':os.getloadavg(),'cpu_stat':Path('/proc/stat').read_text(),'memory':Path('/proc/meminfo').read_text(),'pressure_cpu':Path('/proc/pressure/cpu').read_text(),'pressure_memory':Path('/proc/pressure/memory').read_text(),'lscpu':command(['lscpu'])}
 return d
env=dict(os.environ,H3D_EVAL_RPC='1',GOMAXPROCS='4',GOTOOLCHAIN='local')
overlay={'Replace':{str(checkout/'internal/promptsecret/independent_phase2_test.go'):str(P/'harness_test.go')}}
(P/'overlay.json').write_text(json.dumps(overlay,indent=2)+'\n')
build=['mise','exec','--','go','test','-c','-overlay='+str(P/'overlay.json'),'-o',str(P/'detector.test'),'./internal/promptsecret']
(P/'commands.json').write_text(json.dumps({'cwd':str(checkout),'build':build,'binary':[str(P/'detector.test'),'-test.run=^TestIndependentPhase2$','-test.timeout=0'],'environment_overrides':{k:env[k] for k in ['H3D_EVAL_RPC','GOMAXPROCS','GOTOOLCHAIN']},'rerun':[str(P/'run.sh'),str(checkout)],'protocol':'measurement-plan.md'},indent=2)+'\n')
print('Building external test overlay',flush=True)
b=subprocess.run(build,cwd=checkout,env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
(P/'build.log').write_text(b.stdout); assert b.returncode==0,b.stdout
rows=[json.loads(l) for l in (E/'corpus.jsonl').read_text().splitlines()]
lengths=[r for r in rows if r['category']=='length' and not r.get('over_limit')]
assert len(lengths)==34
class RPC:
 def __init__(self): self.p=subprocess.Popen([str(P/'detector.test'),'-test.run=^TestIndependentPhase2$','-test.timeout=0'],env=env,cwd=checkout,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
 def call(self,action,**kw):
  st=time.perf_counter_ns(); self.p.stdin.write(json.dumps(dict(action=action,**kw))+'\n'); self.p.stdin.flush(); line=self.p.stdout.readline(); elapsed=time.perf_counter_ns()-st
  if not line: raise RuntimeError(self.p.stderr.read())
  return json.loads(line),elapsed
 def close(self):
  d,_=self.call('exit'); self.p.stdin.close(); rest=self.p.stdout.read(); self.p.wait(); err=self.p.stderr.read(); assert self.p.returncode==0,(rest,err); return d
raw={'checkout':str(checkout),'commit':head,'host_start':host(),'plan_sha256':hashlib.sha256((P/'measurement-plan.md').read_bytes()).hexdigest(),'accuracy':[],'warm':[],'clean_warm':[],'cold':[]}
rpc=RPC(); raw['runtime'],_=rpc.call('stats')
for r in rows:
 d,ns=rpc.call('scan',Text=r['text']); raw['accuracy'].append({'id':r['id'],**d,'roundtrip_ns':ns})
print('Accuracy scans complete; warming 34 exact-limit prompts',flush=True)
for _ in range(10):
 for r in lengths: rpc.call('scan',Text=r['text'])
for i in range(100):
 for r in lengths:
  d,ns=rpc.call('scan',Text=r['text']); raw['warm'].append({'id':r['id'],'scan_ns':d['scan_ns'],'roundtrip_ns':ns,'candidate_count':len(d['candidates'] or [])})
 if i%20==19: print('Warm round '+str(i+1)+'/100',flush=True)
line='build: asset compilation completed successfully; cache hit\n'; clean=(line*math.ceil(16384/len(line)))[:16384]; assert len(clean.encode())==16384
raw['clean_diagnostic']={'construction':repr(line)+' repeated and truncated to 16384 ASCII bytes','text_sha256':hashlib.sha256(clean.encode()).hexdigest()}
for _ in range(10): rpc.call('scan',Text=clean)
for _ in range(100):
 d,ns=rpc.call('scan',Text=clean);raw['clean_warm'].append({**d,'roundtrip_ns':ns})
raw['persistent_exit']=rpc.close()
print('Measuring isolated four-worker concurrency and ten fresh cold loads',flush=True)
rpc=RPC();raw['concurrent'],_=rpc.call('concurrent',Texts=[r['text'] for r in lengths],Count=100);raw['concurrent_exit']=rpc.close()
for i in range(10):
 st=time.perf_counter_ns(); rpc=RPC();d,ns=rpc.call('scan',Text=lengths[0]['text']); launched=time.perf_counter_ns()-st
 raw['cold'].append({**d,'rpc_roundtrip_ns':ns,'launch_through_response_ns':launched,'exit':rpc.close()})
raw['host_end']=host(); verify(); raw['git_status_end']=command(['git','status','--porcelain'],checkout); assert not raw['git_status_end']
(P/'measurements.json').write_text(json.dumps(raw,indent=2)+'\n')
print('Measurements saved; generating results and report',flush=True)
subprocess.run([sys.executable,'-I',str(P/'analyze.py')],check=True)

subprocess.run([sys.executable,'-I',str(P/'verify_results.py')],check=True)
