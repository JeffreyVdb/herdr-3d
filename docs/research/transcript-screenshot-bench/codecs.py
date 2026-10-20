# Run: python docs/research/transcript-screenshot-bench/codecs.py PRIVATE_CAPTURE_DIR
# Re-encodes production preview pixels. Timings include ImageMagick process startup.
import json, pathlib, subprocess, time, statistics, sys
root=pathlib.Path(sys.argv[1]); rows=json.load(open(root/'capture-results.json')); results=[]
variants={
'png-default':['-define','png:compression-level=6'],
'png-best':['-define','png:compression-level=9'],
'webp-nearlossless-q75':['-define','webp:lossless=true','-define','webp:method=1','-quality','75'],
'webp-lossless':['-define','webp:lossless=true','-define','webp:method=4','-quality','100'],
'webp-q82':['-define','webp:method=4','-quality','82'],
'avif-q55':['-define','heic:speed=6','-define','heic:chroma=444','-quality','55'],
'jpeg-q82':['-background','white','-alpha','remove','-alpha','off','-sampling-factor','4:2:0','-quality','82']}
for kind,opts in variants.items():
 outdir=root/kind; outdir.mkdir(exist_ok=True); ext=kind.split('-')[0]
 for r in rows:
  src=root/'thumbs'/(r['hash']+'.png'); out=outdir/(r['hash']+'.'+ext); times=[]
  for repeat in range(3):
   st=time.perf_counter();subprocess.run(['magick',str(src),'-strip',*opts,str(out)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);times.append((time.perf_counter()-st)*1000)
  results.append(dict(hash=r['hash'],sourceMime=r['sourceMime'],variant=kind,bytes=out.stat().st_size,ms=statistics.median(times)))
 print(kind, 'bytes',sum(r['bytes'] for r in results if r['variant']==kind),'median ms',round(statistics.median(r['ms'] for r in results if r['variant']==kind),2),flush=True)
json.dump(results,open(root/'codec-results.json','w'),indent=2)
