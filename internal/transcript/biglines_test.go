package transcript

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// withBigLine sets the shortest line that gets a record (1<<62: none).
func withBigLine(n int) Option { return func(l *Log) { l.bigLine = n } }

func TestB64Cuts(t *testing.T) {
	long := strings.Repeat("QUJD", minCut/4)            // minCut of base64
	short := strings.Repeat("QUJD", minCut/4-1)         // just under it
	url := "data:image/png;base64," + long              // a data URL
	escaped := long[:minCut/2] + `\/` + long[:minCut/2] // an escape: text
	cases := []struct {
		name string
		line string
		want []int // string values cut (their index among the line's strings)
	}{
		{"value", `{"a":"x","data":"` + long + `"}`, []int{3}},
		{"data url", `{"image_url":"` + url + `"}`, []int{1}},
		{"key", `{"` + long + `":1}`, nil},
		{"key, spaced", `{"` + long + "\" \t:1}", nil},
		{"value then key", `{"a":"` + long + `","` + long + `":"` + long + `"}`, []int{1, 3}},
		{"too short", `{"data":"` + short + `"}`, nil},
		{"escape inside", `{"data":"` + escaped + `"}`, nil},
		{"text around", `{"t":"look: ` + long + `"}`, nil},
		{"after escaped quotes", `{"t":"say \"hi\\\" there","d":["` + long + `","` + url + `"]}`, []int{3, 4}},
		{"unterminated", `{"data":"` + long, nil},
		{"unterminated after", `{"data":"` + long + `","t":"abc`, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			line := []byte(c.line)
			var want []cutRange
			for _, k := range c.want {
				from, to := stringAt(t, line, k)
				want = append(want, cutRange{int32(from + cutKeep), int32(to)})
			}
			if got := b64Cuts(line); fmt.Sprint(got) != fmt.Sprint(want) {
				t.Errorf("cuts %v, want %v", got, want)
			}
		})
	}
}

// b64Word agrees with b64Byte on every byte value in every place of a
// word, among base64 bytes and among others.
func TestB64Word(t *testing.T) {
	for _, fill := range []byte{'A', 'z', '9', '+', '/', '=', '-', '_', 0x7f, 0x80, ' '} {
		for at := range 8 {
			for c := range 256 {
				var b [8]byte
				for i := range b {
					b[i] = fill
				}
				b[at] = byte(c)
				want := true
				for _, x := range b {
					want = want && b64Byte[x]
				}
				if got := b64Word(binary.LittleEndian.Uint64(b[:])); got != want {
					t.Fatalf("%q: %v, want %v", b, got, want)
				}
			}
		}
	}
	if b64Run([]byte(`QUJDREVGR0hJSktM+/=-_9a\QUJD`)) != 23 {
		t.Error("b64Run")
	}
}

// stringAt is where the k-th string of a JSON line starts and ends (its
// content, without quotes).
func stringAt(t *testing.T, line []byte, k int) (int, int) {
	t.Helper()
	n := -1
	for i := 0; i < len(line); i++ {
		if line[i] != '"' {
			continue
		}
		end := stringEnd(line, i+1)
		if n++; n == k {
			return i + 1, end
		}
		i = end
	}
	t.Fatalf("no string %d", k)
	return 0, 0
}

// bigPNG is a PNG of about n bytes (its tail is padding after the image).
func bigPNG(t testing.TB, n, seed int) []byte {
	data := append(pngBytes(t, 2, 2, seed), make([]byte, n)...)
	data[len(data)-1] = byte(seed)
	return data
}

// base64Text is text that is all base64 (what a tool printed), n long.
func base64Text(n int) string { return strings.Repeat("Zm9vYmFy", n/8) }

// escapedText is a big output that is text (lines, quotes): never cut.
func escapedText(n int) string {
	var sb strings.Builder
	for i := 0; sb.Len() < n; i++ {
		fmt.Fprintf(&sb, "line %d: \"quoted\" <tag> [Image #%d: /nowhere.png]\n", i, i)
	}
	return sb.String()
}

func claudeCall(t testing.TB, msg, id, name string, input m) string {
	return jl(t, m{"type": "assistant", "uuid": "a-" + id, "timestamp": "2026-10-20T10:00:00.000Z", "message": m{"id": msg,
		"role": "assistant", "content": []any{m{"type": "tool_use", "id": id, "name": name, "input": input}}}})
}

func claudeResultLine(t testing.TB, id string, content any, toolUseResult any) string {
	v := m{"type": "user", "uuid": "r-" + id, "timestamp": "2026-10-20T10:00:01.000Z", "message": m{"role": "user",
		"content": []any{m{"type": "tool_result", "tool_use_id": id, "content": content}}}}
	if toolUseResult != nil {
		v["toolUseResult"] = toolUseResult
	}
	return jl(t, v)
}

func rolloutLine(t testing.TB, typ string, payload m) string {
	return jl(t, m{"timestamp": "2026-10-20T10:00:00.000Z", "type": typ, "payload": payload})
}

func dataURL64(data []byte) string { return "data:image/png;base64," + b64(data) }

// bigClaude is a Claude transcript of big lines of every kind.
func bigClaude(t testing.TB) string {
	png1, png2, png3 := bigPNG(t, 300<<10, 1), bigPNG(t, 400<<10, 2), bigPNG(t, 300<<10, 3)
	var sb strings.Builder
	sb.WriteString(claudeUserLine(t, "u1", claudeText("look at these"), claudeImg("image/png", png1)))
	// A Read of an image: the image, and its copy in toolUseResult.
	sb.WriteString(claudeCall(t, "m1", "toolu_read", "Read", m{"file_path": "/tmp/shot.png"}))
	sb.WriteString(claudeResultLine(t, "toolu_read", []any{claudeImg("image/png", png2)},
		m{"type": "image", "file": m{"base64": b64(png2), "type": "image/png", "originalSize": len(png2)}}))
	// A tool that printed base64: text, capped like any text.
	sb.WriteString(claudeCall(t, "m2", "toolu_b64", "Bash", m{"command": "base64 blob"}))
	sb.WriteString(claudeResultLine(t, "toolu_b64", base64Text(300<<10), nil))
	// A big text output: nothing to cut.
	sb.WriteString(claudeCall(t, "m3", "toolu_txt", "Bash", m{"command": "cat log"}))
	sb.WriteString(claudeResultLine(t, "toolu_txt", escapedText(300<<10), nil))
	// A Write of a base64 file: its diff line is longer than any list keeps.
	sb.WriteString(claudeCall(t, "m4", "toolu_w", "Write", m{"file_path": "/tmp/blob.b64", "content": base64Text(300 << 10)}))
	sb.WriteString(claudeResultLine(t, "toolu_w", "File created", m{"type": "create", "filePath": "/tmp/blob.b64",
		"content": base64Text(300<<10) + "\nshort line\n", "structuredPatch": []any{}}))
	// Mixed: text, an image and base64 text in one result.
	sb.WriteString(claudeCall(t, "m5", "toolu_mix", "mcp__shot", m{"url": "http://x"}))
	sb.WriteString(claudeResultLine(t, "toolu_mix", []any{claudeText("captured"), claudeImg("image/png", png3),
		claudeText(base64Text(200 << 10))}, nil))
	sb.WriteString(jl(t, m{"type": "attachment", "uuid": "att", "timestamp": "2026-10-20T10:00:02.000Z",
		"attachment": m{"type": "date", "blob": base64Text(300 << 10)}}))
	return sb.String()
}

// bigCodex is a Codex rollout of big lines of every kind.
func bigCodex(t testing.TB) string {
	png1, png2, png3, png4 := bigPNG(t, 300<<10, 4), bigPNG(t, 500<<10, 5), bigPNG(t, 300<<10, 6), bigPNG(t, 300<<10, 7)
	var sb strings.Builder
	sb.WriteString(rolloutLine(t, "session_meta", m{"id": "s1", "cli_version": "0.170.0"}))
	sb.WriteString(rolloutLine(t, "response_item", m{"type": "message", "role": "user", "content": []any{
		m{"type": "input_text", "text": "see"}, m{"type": "input_image", "image_url": dataURL64(png1)}}}))
	// A tool that viewed images: text parts and data URLs.
	sb.WriteString(rolloutLine(t, "response_item", m{"type": "custom_tool_call", "call_id": "c1", "name": "exec",
		"input": "view_image('/tmp/a.png')"}))
	sb.WriteString(rolloutLine(t, "response_item", m{"type": "custom_tool_call_output", "call_id": "c1", "output": []any{
		m{"type": "input_text", "text": "Script completed"}, m{"type": "input_image", "image_url": dataURL64(png2)},
		m{"type": "input_text", "text": "and"}, m{"type": "input_image", "image_url": dataURL64(png3)}}}))
	// A generated image, and the item_completed that repeats it.
	sb.WriteString(rolloutLine(t, "event_msg", m{"type": "item_completed", "item": m{"type": "Extension",
		"id": "ig_1", "status": "completed", "result": b64(png4), "savedPath": "/tmp/gen.png"}}))
	sb.WriteString(rolloutLine(t, "event_msg", m{"type": "image_generation_end", "call_id": "ig_1", "result": b64(png4),
		"saved_path": "/tmp/gen.png"}))
	// A call whose output is base64 text, and one of big text.
	sb.WriteString(rolloutLine(t, "response_item", m{"type": "function_call", "call_id": "c2", "name": "shell",
		"arguments": `{"command":["base64","blob"]}`}))
	sb.WriteString(rolloutLine(t, "response_item", m{"type": "function_call_output", "call_id": "c2",
		"output": base64Text(300 << 10)}))
	sb.WriteString(rolloutLine(t, "response_item", m{"type": "function_call", "call_id": "c3", "name": "shell",
		"arguments": `{"command":["cat","log"]}`}))
	sb.WriteString(rolloutLine(t, "response_item", m{"type": "function_call_output", "call_id": "c3",
		"output": escapedText(300 << 10)}))
	// A patch adding a base64 file: a diff line longer than a list keeps.
	sb.WriteString(rolloutLine(t, "response_item", m{"type": "custom_tool_call", "call_id": "c4", "name": "apply_patch",
		"input": "*** Begin Patch\n*** Add File: blob.b64\n+" + base64Text(300<<10) + "\n+tail\n*** End Patch\n"}))
	sb.WriteString(rolloutLine(t, "event_msg", m{"type": "item_completed", "item": m{"type": "FileChange", "id": "c4",
		"status": "completed", "changes": m{"/tmp/blob.b64": m{"type": "add", "content": base64Text(300<<10) + "\ntail\n"}}}}))
	sb.WriteString(rolloutLine(t, "response_item", m{"type": "custom_tool_call_output", "call_id": "c4", "output": "Success"}))
	return sb.String()
}

// pad gives every line of a transcript a big base64 field no parser reads,
// so every line gets a record.
func pad(t testing.TB, content string) string {
	var sb strings.Builder
	for line := range strings.Lines(content) {
		var v map[string]any
		if json.Unmarshal([]byte(line), &v) != nil {
			sb.WriteString(line)
			continue
		}
		v["zzPad"] = base64Text(bigLine)
		sb.WriteString(jl(t, v))
	}
	return sb.String()
}

func writeTranscript(t testing.TB, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "t.jsonl")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func readLog(t testing.TB, harness, path string, opts ...Option) *Log {
	t.Helper()
	l, err := Read(context.Background(), harness, path, opts...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(l.Close)
	return l
}

func allIdx(l *Log) []int32 {
	idx := make([]int32, l.Len())
	for i := range idx {
		idx[i] = int32(i)
	}
	return idx
}

// sameCapped checks that every list item of a log with records is the item
// a log of the same file builds from whole lines, byte for byte.
func sameCapped(t *testing.T, harness, path string) (*Log, []proto.TranscriptItem) {
	t.Helper()
	capped := readLog(t, harness, path)
	whole := readLog(t, harness, path, withBigLine(1<<62))
	if len(whole.big) != 0 {
		t.Fatal("records without big lines")
	}
	got, err := capped.items(allIdx(capped), false)
	if err != nil {
		t.Fatal(err)
	}
	want, err := whole.items(allIdx(whole), false)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != len(want) {
		t.Fatalf("%d items, want %d", len(got), len(want))
	}
	for i := range got {
		g, _ := json.Marshal(got[i])
		w, _ := json.Marshal(want[i])
		if !bytes.Equal(g, w) {
			t.Errorf("item %d (%s) differs:\n got %.400s\nwant %.400s", i, want[i].ID, g, w)
		}
	}
	// A page is the same items.
	p, err := capped.Before(0, MaxTranscriptLimit)
	if err != nil {
		t.Fatal(err)
	}
	q, err := whole.Before(0, MaxTranscriptLimit)
	if err != nil {
		t.Fatal(err)
	}
	if g, w := jsonOf(t, p), jsonOf(t, q); g != w {
		t.Errorf("pages differ")
	}
	return capped, got
}

func jsonOf(t testing.TB, v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// A list item built from a big line read without its base64 is the item
// built from the whole line: text, tool output, diffs, images and hidden
// notices; transcript.item still has everything.
func TestCappedBigLines(t *testing.T) {
	for _, c := range []struct {
		harness, content string
		records          int
		b64Text          string // the item whose output is base64 text
	}{
		{Claude, bigClaude(t), 6, "toolu_b64"},
		{Codex, bigCodex(t), 5, "c2"}, // a patch and its record are text: no records
	} {
		t.Run(c.harness, func(t *testing.T) {
			path := writeTranscript(t, c.content)
			l, items := sameCapped(t, c.harness, path)
			if len(l.big) != c.records {
				t.Errorf("%d records, want %d", len(l.big), c.records)
			}
			images, truncated := 0, 0
			for _, it := range items {
				for _, r := range itemImages(&it) {
					if r.Hash == "" || r.Width != 2 {
						t.Errorf("%s: image %+v", it.ID, r)
					}
					images++
				}
				if it.Tool != nil && it.Tool.OutputTruncated {
					truncated++
				}
			}
			if images < 3 || truncated < 2 {
				t.Errorf("%d images, %d truncated outputs: the fixture lost its big lines", images, truncated)
			}
			full, ok, err := l.Item(c.b64Text)
			if err != nil || !ok {
				t.Fatal(ok, err)
			}
			if got := full.Tool.OutputText; got != base64Text(300<<10) || full.Tool.OutputTruncated {
				t.Errorf("full item: %d bytes of output, truncated %v", len(got), full.Tool.OutputTruncated)
			}
		})
	}
}

// Every fixture, its lines made big: the records change no list item.
func TestCappedFixtures(t *testing.T) {
	for _, harness := range []string{Claude, Codex} {
		files, err := filepath.Glob(filepath.Join("testdata", harness, "*.jsonl"))
		if err != nil || len(files) == 0 {
			t.Fatal(files, err)
		}
		for _, f := range files {
			t.Run(harness+"/"+filepath.Base(f), func(t *testing.T) {
				b, err := os.ReadFile(f)
				if err != nil {
					t.Fatal(err)
				}
				l, _ := sameCapped(t, harness, writeTranscript(t, pad(t, string(b))))
				if len(l.big) == 0 {
					t.Error("no records")
				}
			})
		}
	}
}

// The first page of a transcript of big image lines reads their text, not
// their base64; the images' bytes are still there to fetch.
func TestCappedPageSkipsBase64(t *testing.T) {
	path := writeTranscript(t, bigCodex(t)+bigCodex(t))
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	var c *counting
	l, err := follow(Codex, path, fi, fi.Size(), func(r io.ReaderAt) io.ReaderAt { c = &counting{r: r}; return c })
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	ready(t, l)
	before := c.n.Load()
	s, p, err := l.Subscribe(200)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	read := c.n.Load() - before
	cut := 0
	for _, r := range l.big {
		cut += r.cut
	}
	if read > fi.Size()-int64(cut) || int64(cut) < fi.Size()/2 {
		t.Errorf("the page read %d of %d bytes (%d cut)", read, fi.Size(), cut)
	}
	var hash string
	for _, it := range p.Items {
		if rs := itemImages(&it); len(rs) > 0 {
			hash = rs[0].Hash
		}
	}
	if !l.Knows(hash) {
		t.Fatalf("image %q not known", hash)
	}
	if b, err := l.Image(hash); err != nil || len(b) < 300<<10 {
		t.Errorf("image bytes: %d, %v", len(b), err)
	}
}

// A record that no longer matches its line (the file changed) is not used:
// the item is read from the whole line.
func TestCappedMismatchReadsWholeLine(t *testing.T) {
	path := writeTranscript(t, bigClaude(t))
	whole := readLog(t, Claude, path, withBigLine(1<<62))
	want, err := whole.items(allIdx(whole), false)
	if err != nil {
		t.Fatal(err)
	}
	l := readLog(t, Claude, path)
	tampered := 0
	l.mu.Lock()
	for off, r := range l.big {
		if len(r.imgs) > 0 {
			l.big[off] = &bigRec{cuts: r.cuts, cut: r.cut, imgs: r.imgs[1:]}
			tampered++
		}
	}
	l.mu.Unlock()
	if tampered < 3 {
		t.Fatalf("%d records with images", tampered)
	}
	got, err := l.items(allIdx(l), false)
	if err != nil {
		t.Fatal(err)
	}
	if jsonOf(t, got) != jsonOf(t, want) {
		t.Error("items differ")
	}
}

// Lines the tail adds get their records too.
func TestCappedLiveLines(t *testing.T) {
	content := bigCodex(t)
	path := writeTranscript(t, "")
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	l, err := Follow(Codex, path, fi, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	ready(t, l)
	writeLines(t, path, content)
	off := int64(0)
	for line := range strings.Lines(content) {
		l.Line(off, []byte(strings.TrimSuffix(line, "\n")))
		off += int64(len(line))
	}
	whole := readLog(t, Codex, path, withBigLine(1<<62))
	got, err := l.items(allIdx(l), false)
	if err != nil {
		t.Fatal(err)
	}
	want, err := whole.items(allIdx(whole), false)
	if err != nil {
		t.Fatal(err)
	}
	if len(l.big) != 5 || jsonOf(t, got) != jsonOf(t, want) {
		t.Errorf("%d records; items equal: %v", len(l.big), jsonOf(t, got) == jsonOf(t, want))
	}
}
