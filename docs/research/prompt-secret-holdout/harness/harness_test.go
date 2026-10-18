package promptsecret_test

import (
 "bufio"
 "encoding/json"
 "os"
 "runtime"
 "strings"
 "strconv"
 "sync"
 "syscall"
 "testing"
 "time"
 ps "github.com/JeffreyVdb/herdr-3d/internal/promptsecret"
)
type request struct { Action string; Text string; Texts []string; Count int }
func rss() map[string]int64 {
 b,_:=os.ReadFile("/proc/self/status"); m:=map[string]int64{}
 for _,l:=range strings.Split(string(b),"\n") { f:=strings.Fields(l); if len(f)>1 && (f[0]=="VmRSS:" || f[0]=="VmHWM:") { v,_:=strconv.ParseInt(f[1],10,64); m[f[0]]=v } }
 var r syscall.Rusage; syscall.Getrusage(syscall.RUSAGE_SELF,&r); m["ru_maxrss_kib"]=r.Maxrss; return m
}
func TestIndependentPhase2(t *testing.T) {
 if os.Getenv("H3D_EVAL_RPC")!="1" { t.Skip("external evaluator only") }
 dec:=json.NewDecoder(bufio.NewReader(os.Stdin)); enc:=json.NewEncoder(os.Stdout)
 for { var q request; if err:=dec.Decode(&q);err!=nil{return}
 switch q.Action {
 case "scan":
  st:=time.Now(); cs:=ps.Scan(q.Text,nil); ns:=time.Since(st).Nanoseconds()
  enc.Encode(map[string]any{"candidates":cs,"scan_ns":ns})
 case "stats": enc.Encode(map[string]any{"memory":rss(),"go":runtime.Version(),"gomaxprocs":runtime.GOMAXPROCS(0),"cpus":runtime.NumCPU()})
 case "concurrent":
  ps.Scan(q.Texts[0],nil); runtime.GC(); baseline:=rss(); start:=make(chan struct{}); var wg sync.WaitGroup
  times:=make([][]int64,4); counts:=make([][]int,4)
  for w:=0;w<4;w++ { wg.Add(1); go func(w int){defer wg.Done(); <-start; for i:=0;i<q.Count;i++ { st:=time.Now(); cs:=ps.Scan(q.Texts[(w*q.Count+i)%len(q.Texts)],nil); times[w]=append(times[w],time.Since(st).Nanoseconds()); counts[w]=append(counts[w],len(cs)) } }(w) }
  close(start); wg.Wait(); enc.Encode(map[string]any{"worker_ns":times,"candidate_counts":counts,"baseline":baseline,"after":rss(),"queue":"four fixed workers, one synchronous scan in flight per worker; no pending work queue"})
 case "exit": enc.Encode(map[string]any{"memory":rss()}); return
 default: t.Fatal("unknown action")
 }
 }
}
