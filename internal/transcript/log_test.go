package transcript

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/jsonl"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// counting counts the bytes read through it and can hold reads back.
type counting struct {
	r    io.ReaderAt
	n    atomic.Int64
	gate chan struct{} // reads wait for it to be closed (nil: never)
}

func (c *counting) ReadAt(p []byte, off int64) (int, error) {
	if c.gate != nil {
		<-c.gate
	}
	n, err := c.r.ReadAt(p, off)
	c.n.Add(int64(n))
	return n, err
}

func userLine(i int) string {
	return fmt.Sprintf(`{"type":"user","uuid":"u%d","timestamp":"2026-09-29T10:00:00.000Z","message":{"role":"user","content":"prompt %d"}}`+"\n", i, i)
}

func noiseLine(i int) string {
	return fmt.Sprintf(`{"type":"attachment","uuid":"a%d","timestamp":"2026-09-29T10:00:00.000Z","attachment":{"type":"date"}}`+"\n", i)
}

func writeLines(t *testing.T, path string, lines ...string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(strings.Join(lines, "")); err != nil {
		t.Fatal(err)
	}
}

func ready(t *testing.T, l *Log) {
	t.Helper()
	select {
	case <-l.Ready():
	case <-time.After(10 * time.Second):
		t.Fatal("not ready")
	}
	if err := l.Err(); err != nil {
		t.Fatal(err)
	}
}

// Paging walks back from the newest to the first item by cursor, limit
// visible items a page (hidden ones come along), each item once, reading
// only the lines of the items it returns: the index is built once.
func TestPaging(t *testing.T) {
	path := filepath.Join(t.TempDir(), "t.jsonl")
	var lines []string
	for i := range 3000 {
		lines = append(lines, userLine(i))
		if i%3 == 0 {
			lines = append(lines, noiseLine(i))
		}
	}
	writeLines(t, path, lines...)
	size := int64(len(strings.Join(lines, "")))
	c := &counting{}
	l, err := follow(Claude, path, nil, size, func(r io.ReaderAt) io.ReaderAt { c.r = r; return c })
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	ready(t, l)
	if got := c.n.Load(); got != size {
		t.Fatalf("the build read %d bytes of %d", got, size)
	}
	if l.Len() != 4000 {
		t.Fatalf("%d items", l.Len())
	}
	var seqs []int64
	seq, pages := int64(0), 0
	for {
		c.n.Store(0)
		p, err := l.Before(seq, 200)
		if err != nil {
			t.Fatal(err)
		}
		pages++
		visible := 0
		for _, it := range p.Items {
			if !it.Hidden {
				visible++
			}
		}
		if visible > 200 || (p.HasMore && visible != 200) {
			t.Fatalf("page %d: %d visible items", pages, visible)
		}
		if read := c.n.Load(); read > size/10 {
			t.Fatalf("page %d read %d bytes of %d", pages, read, size)
		}
		seqs = append(append([]int64{}, itemSeqs(p.Items)...), seqs...)
		if !p.HasMore {
			break
		}
		if seq, _ = ParseCursor(p.Cursor); seq != p.Items[0].Seq {
			t.Fatalf("cursor %q, oldest %d", p.Cursor, p.Items[0].Seq)
		}
	}
	if pages != 15 || len(seqs) != 4000 {
		t.Fatalf("%d pages, %d items", pages, len(seqs))
	}
	for i, s := range seqs {
		if s != int64(i+1) {
			t.Fatalf("item %d has seq %d", i, s)
		}
	}
	if p, _ := l.Before(1, 200); len(p.Items) != 0 || p.HasMore {
		t.Fatalf("before the first: %+v", p)
	}
	for _, bad := range []string{"", "c:", "c:0", "x:5", "c:-1", "c:1x"} {
		if _, ok := ParseCursor(bad); ok {
			t.Errorf("cursor %q accepted", bad)
		}
	}
}

func itemSeqs(items []proto.TranscriptItem) []int64 {
	out := make([]int64, len(items))
	for i, it := range items {
		out[i] = it.Seq
	}
	return out
}

// Follow reads what the tail read before it, once; the tail's later lines
// come through Line only, also while the build is still running.
func TestFollowSharesTheTail(t *testing.T) {
	path := filepath.Join(t.TempDir(), "t.jsonl")
	writeLines(t, path, assistantBlock("m1", 0, toolUse("toolu_a", "Bash")), userLine(1))
	tail := jsonl.NewTail(path)
	if err := tail.Next(func(int64, []byte) {}); err != nil { // usage read it
		t.Fatal(err)
	}
	c := &counting{gate: make(chan struct{})}
	l, err := follow(Claude, path, tail.File(), tail.Delivered(), func(r io.ReaderAt) io.ReaderAt { c.r = r; return c })
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	// While the build waits, the tail reads on: the result and a prompt.
	writeLines(t, path, toolResult("toolu_a", "done", false), userLine(2))
	if err := tail.Next(l.Line); err != nil {
		t.Fatal(err)
	}
	close(c.gate)
	ready(t, l)
	end := tail.Delivered()
	if got := c.n.Load(); got != end {
		t.Fatalf("the build read %d bytes, the file has %d", got, end)
	}
	s, p, err := l.Subscribe(200)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	check(t, "caught up", p.Items, []want{
		{kind: proto.ItemTool, id: "toolu_a", status: proto.ToolOK},
		{kind: proto.ItemUser, text: "prompt 1"},
		{kind: proto.ItemUser, text: "prompt 2"},
	})
	if p.HasMore || p.Cursor != "c:1" {
		t.Fatalf("page head: %+v", p)
	}

	// Live: a new call is a new item; its result an update of it.
	c.n.Store(0)
	writeLines(t, path, assistantBlock("m2", 0, toolUse("toolu_b", "Bash")))
	if err := tail.Next(l.Line); err != nil {
		t.Fatal(err)
	}
	<-s.Wake()
	news, ups, err := s.Take()
	if err != nil || len(news) != 1 || len(ups) != 0 || news[0].ID != "toolu_b" || news[0].Seq != 4 ||
		news[0].Tool.Status != proto.ToolRunning {
		t.Fatalf("take: %+v %+v %v", news, ups, err)
	}
	writeLines(t, path, toolResult("toolu_b", "listing", false), userLine(3))
	if err := tail.Next(l.Line); err != nil {
		t.Fatal(err)
	}
	<-s.Wake()
	news, ups, err = s.Take()
	if err != nil || len(news) != 1 || news[0].Kind != proto.ItemUser || len(ups) != 1 || ups[0].ID != "toolu_b" ||
		ups[0].Seq != 4 || ups[0].Tool.Status != proto.ToolOK || ups[0].Tool.OutputText != "listing" {
		t.Fatalf("take: %+v %+v %v", news, ups, err)
	}
	// Only the lines of the items taken were read back; none by the build.
	if got, max := c.n.Load(), int64(6*len(toolResult("toolu_b", "listing", false))); got > max {
		t.Fatalf("read %d bytes back for 3 items", got)
	}
	if news, ups, err = s.Take(); len(news)+len(ups) != 0 || err != nil {
		t.Fatalf("nothing new: %+v %+v %v", news, ups, err)
	}
}

// #151: Codex's nested MCP calls are events only. Live, a start is a new
// running row, its completion an update of it, and a completion alone a new
// finished row, each after the lines before it; paging gives the same rows.
func TestCodexMCPLive(t *testing.T) {
	path := filepath.Join(t.TempDir(), "t.jsonl")
	call := func(id, status, extra string) string {
		typ := "item_completed"
		if status == "inProgress" {
			typ = "item_started"
		}
		return fmt.Sprintf(`{"timestamp":"2026-10-05T19:38:2%s.000Z","type":"event_msg","payload":{"type":"%s","item":{"type":"McpToolCall","id":"exec-%s","server":"alterlab","tool":"alterlab_search","arguments":{"query":"q %s"},"status":"%s"%s}}}`+"\n",
			id, typ, id, id, status, extra)
	}
	done := `,"result":{"content":[{"type":"text","text":"found it"}]},"duration":{"secs":1,"nanos":0}`
	writeLines(t, path, `{"timestamp":"2026-10-05T19:38:20.000Z","type":"response_item","payload":{"type":"custom_tool_call","call_id":"call_x","name":"exec","input":"run"}}`+"\n")
	tail := jsonl.NewTail(path)
	if err := tail.Next(func(int64, []byte) {}); err != nil {
		t.Fatal(err)
	}
	l, err := follow(Codex, path, tail.File(), tail.Delivered(), func(r io.ReaderAt) io.ReaderAt { return r })
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	ready(t, l)
	s, _, err := l.Subscribe(200)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	take := func(wantNews, wantUps int) ([]proto.TranscriptItem, []proto.TranscriptItem) {
		t.Helper()
		if err := tail.Next(l.Line); err != nil {
			t.Fatal(err)
		}
		<-s.Wake()
		news, ups, err := s.Take()
		if err != nil || len(news) != wantNews || len(ups) != wantUps {
			t.Fatalf("take: %+v %+v %v", news, ups, err)
		}
		return news, ups
	}
	writeLines(t, path, call("1", "inProgress", ""))
	news, _ := take(1, 0)
	if it := news[0]; it.ID != "exec-1" || it.Seq != 2 || it.Tool.Name != "alterlab.alterlab_search" || it.Tool.Status != proto.ToolRunning {
		t.Fatalf("start: %+v", it)
	}
	writeLines(t, path, call("1", "completed", done))
	_, ups := take(0, 1)
	if it := ups[0]; it.ID != "exec-1" || it.Seq != 2 || it.Tool.Status != proto.ToolOK || it.Tool.OutputText != "found it" {
		t.Fatalf("completion: %+v", it.Tool)
	}
	writeLines(t, path, call("2", "completed", done)) // no start event
	news, _ = take(1, 0)
	if it := news[0]; it.ID != "exec-2" || it.Seq != 3 || it.Tool.Status != proto.ToolOK || it.Tool.InputSummary != "q 2" {
		t.Fatalf("completion alone: %+v", it)
	}
	writeLines(t, path, call("3", "failed", `,"error":{"message":"rejected"}`))
	news, _ = take(1, 0)
	if it := news[0]; it.Seq != 4 || it.Tool.Status != proto.ToolError || it.Tool.OutputText != "rejected" {
		t.Fatalf("failed: %+v", it.Tool)
	}
	// Paging, one at a time from the newest, finds the same rows in order.
	var ids []string
	for seq := int64(0); ; {
		p, err := l.Before(seq, 1)
		if err != nil {
			t.Fatal(err)
		}
		for i := len(p.Items) - 1; i >= 0; i-- {
			ids = append([]string{p.Items[i].ID}, ids...)
		}
		if !p.HasMore {
			break
		}
		seq, _ = ParseCursor(p.Cursor)
	}
	if strings.Join(ids, " ") != "call_x exec-1 exec-2 exec-3" {
		t.Fatalf("paged ids: %v", ids)
	}
	it, ok, err := l.Item("exec-2")
	if err != nil || !ok || it.Tool.Name != "alterlab.alterlab_search" || it.Tool.OutputText != "found it" {
		t.Fatalf("item: %+v %v %v", it, ok, err)
	}
}

// A log whose file the tail found replaced or gone ends; its subscribers
// learn why.
func TestVoid(t *testing.T) {
	for _, gone := range []bool{false, true} {
		path := filepath.Join(t.TempDir(), "t.jsonl")
		writeLines(t, path, userLine(1))
		l, err := Follow(Claude, path, nil, int64(len(userLine(1))))
		if err != nil {
			t.Fatal(err)
		}
		ready(t, l)
		s, _, err := l.Subscribe(10)
		if err != nil {
			t.Fatal(err)
		}
		l.Void(gone)
		<-s.Wake()
		want := ErrReplaced
		if gone {
			want = ErrGone
		}
		if _, _, err := s.Take(); !errors.Is(err, want) || !errors.Is(l.Err(), want) {
			t.Errorf("gone %v: take %v, err %v", gone, err, l.Err())
		}
		<-l.Done()
		l.Line(0, []byte(userLine(2))) // nothing more
		if l.Len() != 1 {
			t.Errorf("indexed after the end")
		}
	}
	// A file that is not the tail's: replaced before the log could open it.
	path := filepath.Join(t.TempDir(), "t.jsonl")
	writeLines(t, path, userLine(1))
	other := filepath.Join(filepath.Dir(path), "o.jsonl")
	writeLines(t, other, userLine(1))
	fi, _ := os.Stat(other)
	if _, err := Follow(Claude, path, fi, 0); !errors.Is(err, ErrReplaced) {
		t.Errorf("another file: %v", err)
	}
	// A symlink is never followed.
	link := filepath.Join(filepath.Dir(path), "l.jsonl")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if _, err := Read(context.Background(), Claude, link); err == nil {
		t.Error("read through a symlink")
	}
}

// A subscriber that falls MaxPending changes behind overflows (the watch
// resyncs) instead of piling them up.
func TestSubscriberOverflow(t *testing.T) {
	path := filepath.Join(t.TempDir(), "t.jsonl")
	writeLines(t, path, userLine(0))
	l, err := Follow(Claude, path, nil, int64(len(userLine(0))))
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	ready(t, l)
	s, _, _ := l.Subscribe(10)
	off := int64(len(userLine(0)))
	for i := range MaxPending + 1 {
		b := []byte(strings.TrimSuffix(userLine(i+1), "\n"))
		l.Line(off, b)
		off += int64(len(b)) + 1
	}
	if _, _, err := s.Take(); !errors.Is(err, ErrOverflow) {
		t.Fatalf("take: %v", err)
	}
}

// A 50 MB transcript, mostly base64 images as real sessions are: the
// index builds in the background, the first page is quick, memory stays
// far below the file's size and paging reaches the top.
func TestLargeTranscript(t *testing.T) {
	if testing.Short() {
		t.Skip("writes 50 MB")
	}
	path := filepath.Join(t.TempDir(), "big.jsonl")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	img := strings.Repeat("iVBORw0KGgoAAAANSUhEUgAA", 1<<20/24) // ~1 MB of base64
	var size int64
	for i := 0; size < 50<<20; i++ {
		var line string
		switch {
		case i%500 == 0:
			line = fmt.Sprintf(`{"type":"user","uuid":"img%d","timestamp":"2026-09-29T10:00:00.000Z","message":{"role":"user","content":[`+
				`{"type":"tool_result","tool_use_id":"toolu_%d","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":%q}}]}]}}`+"\n",
				i, i-1, img)
		case i%500 == 499:
			line = assistantBlock(fmt.Sprintf("m%d", i), 0, toolUse(fmt.Sprintf("toolu_%d", i), "Read"))
		case i%2 == 0:
			line = userLine(i)
		default:
			line = assistantBlock(fmt.Sprintf("m%d", i), 0, text(strings.Repeat("words ", 40)))
		}
		n, err := f.WriteString(line)
		if err != nil {
			t.Fatal(err)
		}
		size += int64(n)
	}
	f.Close()

	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	start := time.Now()
	l, err := Follow(Claude, path, nil, size)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	ready(t, l)
	built := time.Since(start)
	start = time.Now()
	s, p, err := l.Subscribe(200)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	first := time.Since(start)
	runtime.GC()
	runtime.ReadMemStats(&after)
	grew := int64(after.HeapAlloc) - int64(before.HeapAlloc)
	t.Logf("%d MB, %d items: built in %s, first page (%d items) in %s, heap +%d MB", size>>20, l.Len(), built,
		len(p.Items), first, grew>>20)
	if first > time.Second {
		t.Errorf("first page took %s", first)
	}
	if grew > 100<<20 {
		t.Errorf("heap grew %d MB", grew>>20)
	}
	pages := 0
	for seq := int64(0); ; pages++ {
		p, err := l.Before(seq, 500)
		if err != nil {
			t.Fatal(err)
		}
		if !p.HasMore {
			if p.Items[0].Seq != 1 {
				t.Fatalf("stopped at %d", p.Items[0].Seq)
			}
			break
		}
		seq = p.Items[0].Seq
	}
	// No image data in any item.
	it, _, _ := l.Item("toolu_499")
	b, _ := json.Marshal(it)
	if strings.Contains(string(b), "iVBOR") || len(it.Tool.Images) != 1 {
		t.Errorf("image item = %s", b)
	}
}
