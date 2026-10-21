package server_test

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
)

// #147: what permessage-deflate costs the bridge per message and saves on
// the wire. H3D_ACKS names a directory of first-page acks as open.go writes
// them (docs/research/transcript-open-bench): they hold transcript text,
// keep them out of the repository. Without it the benchmarks skip.
//
//	H3D_ACKS=~/.cache/h3d-126-acks go test ./internal/server -run '^$' -bench Deflate -benchmem

// wireConn is the bridge's side of a connection whose peer reads at once:
// it counts what the bridge writes and drops it.
type wireConn struct {
	written int64
	closed  chan struct{}
}

func (c *wireConn) Write(p []byte) (int, error) { c.written += int64(len(p)); return len(p), nil }
func (c *wireConn) Read([]byte) (int, error)    { <-c.closed; return 0, io.EOF }
func (c *wireConn) Close() error {
	select {
	case <-c.closed:
	default:
		close(c.closed)
	}
	return nil
}
func (c *wireConn) LocalAddr() net.Addr              { return &net.UnixAddr{Name: "bridge.sock", Net: "unix"} }
func (c *wireConn) RemoteAddr() net.Addr             { return &net.UnixAddr{Name: "@", Net: "unix"} }
func (c *wireConn) SetDeadline(time.Time) error      { return nil }
func (c *wireConn) SetReadDeadline(time.Time) error  { return nil }
func (c *wireConn) SetWriteDeadline(time.Time) error { return nil }

type hijackRecorder struct {
	*httptest.ResponseRecorder
	conn *wireConn
}

func (h hijackRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return h.conn, bufio.NewReadWriter(bufio.NewReader(h.conn), bufio.NewWriter(h.conn)), nil
}

// chromeOffer is what Chrome offers.
const chromeOffer = "permessage-deflate; client_max_window_bits"

// acceptWire accepts a websocket on a wireConn as the bridge would, the
// client offering offer.
func acceptWire(b *testing.B, opts *websocket.AcceptOptions, offer string) (*websocket.Conn, *wireConn) {
	b.Helper()
	r := httptest.NewRequest(http.MethodGet, "/ws", nil)
	r.Header.Set("Connection", "Upgrade")
	r.Header.Set("Upgrade", "websocket")
	r.Header.Set("Sec-WebSocket-Version", "13")
	r.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
	r.Header.Set("Sec-WebSocket-Extensions", offer)
	wc := &wireConn{closed: make(chan struct{})}
	ws, err := websocket.Accept(hijackRecorder{httptest.NewRecorder(), wc}, r, opts)
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { ws.CloseNow() })
	return ws, wc
}

// deflateModes are the options compared: the bridge's own and the others.
var deflateModes = []struct {
	name string
	opts *websocket.AcceptOptions
}{
	{"off", &websocket.AcceptOptions{}},
	{"no-context-takeover", &websocket.AcceptOptions{CompressionMode: websocket.CompressionNoContextTakeover}},
	{"bridge", server.AcceptOptions},
}

// loadAcks reads $H3D_ACKS as transcript.watch acks, smallest first.
func loadAcks(b *testing.B) [][]byte {
	b.Helper()
	dir := os.Getenv("H3D_ACKS")
	if dir == "" {
		b.Skip("H3D_ACKS is not set")
	}
	files, _ := filepath.Glob(filepath.Join(dir, "*.json"))
	if len(files) == 0 {
		b.Fatalf("no acks in %s", dir)
	}
	var acks [][]byte
	for i, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			b.Fatal(err)
		}
		var page struct {
			Items json.RawMessage `json:"items"`
		}
		if err := json.Unmarshal(raw, &page); err != nil {
			b.Fatalf("%s: not an ack dump", filepath.Base(f))
		}
		ack, _ := json.Marshal(proto.Ack{T: proto.TAck, ReqID: fmt.Sprintf("tw-%d", i), Data: map[string]any{
			"items": page.Items, "updates": []any{}, "harness": "claude", "session": "s", "cursor": "c", "has_more": true}})
		acks = append(acks, ack)
	}
	slices.SortFunc(acks, func(a, b []byte) int { return len(a) - len(b) })
	return acks
}

func write(b *testing.B, ws *websocket.Conn, msg []byte) {
	if err := ws.Write(context.Background(), websocket.MessageText, msg); err != nil {
		b.Fatal(err)
	}
}

// BenchmarkDeflateAcks sends every ack on one connection and reports the
// bytes: in total, and on the wire for the median and the largest ack.
func BenchmarkDeflateAcks(b *testing.B) {
	acks := loadAcks(b)
	for _, m := range deflateModes {
		b.Run(m.name, func(b *testing.B) {
			var raw, wire, median, largest int64
			for b.Loop() {
				ws, wc := acceptWire(b, m.opts, chromeOffer)
				sizes := make([]int64, len(acks))
				raw = 0
				for i, a := range acks {
					before := wc.written
					write(b, ws, a)
					sizes[i] = wc.written - before
					raw += int64(len(a))
				}
				wire = wc.written
				median, largest = sizes[len(sizes)/2], sizes[len(sizes)-1]
				ws.CloseNow()
			}
			b.ReportMetric(float64(raw)/1e6, "MB-raw")
			b.ReportMetric(float64(wire)/1e6, "MB-wire")
			b.ReportMetric(float64(raw)/float64(wire), "ratio")
			b.ReportMetric(float64(len(acks[len(acks)/2]))/1e3, "kB-median-raw")
			b.ReportMetric(float64(median)/1e3, "kB-median-wire")
			b.ReportMetric(float64(len(acks[len(acks)-1]))/1e3, "kB-largest-raw")
			b.ReportMetric(float64(largest)/1e3, "kB-largest-wire")
		})
	}
}

// BenchmarkDeflateAckWrite is the bridge's write of the median and the
// largest ack.
func BenchmarkDeflateAckWrite(b *testing.B) {
	acks := loadAcks(b)
	for _, m := range deflateModes {
		for _, pick := range []struct {
			name string
			ack  []byte
		}{{"median", acks[len(acks)/2]}, {"largest", acks[len(acks)-1]}} {
			b.Run(m.name+"/"+pick.name, func(b *testing.B) {
				ws, wc := acceptWire(b, m.opts, chromeOffer)
				b.SetBytes(int64(len(pick.ack)))
				for b.Loop() {
					write(b, ws, pick.ack)
				}
				b.ReportMetric(float64(wc.written)/float64(b.N), "wire-B/op")
			})
		}
	}
}

// smallBursts are typical small messages: worker.status events of a floor
// of a dozen workers, and a watched transcript's live tail (one item a
// push, from the median ack).
func smallBursts(b *testing.B) map[string][][]byte {
	acks := loadAcks(b)
	var status [][]byte
	for i := range 200 {
		w := i % 12
		title := fmt.Sprintf("Reviewing PR #%d: %s", 140+w, []string{"tests", "the store", "lint", "the proxy"}[i%4])
		ev, _ := json.Marshal(proto.Event{T: proto.EvWorkerStatus, Seq: uint64(4000 + i), ID: fmt.Sprintf("wk_%08x", w*2654435761),
			Session: "herdr-3d", FloorID: "fl_1a2b3c4d", WorkspaceID: fmt.Sprintf("w%d", w+1),
			Status: []string{"working", "idle", "blocked"}[i%3], PrevStatus: []string{"idle", "working", "working"}[i%3],
			StatusSince: 1792560000000 + int64(i)*1733, Title: &title})
		status = append(status, ev)
	}
	var page struct {
		Data struct {
			Items []json.RawMessage `json:"items"`
		} `json:"data"`
	}
	if err := json.Unmarshal(acks[len(acks)/2], &page); err != nil {
		b.Fatal(err)
	}
	var tail [][]byte
	for _, it := range page.Data.Items {
		push, _ := json.Marshal(map[string]any{"t": proto.TTranscriptItems, "id": "wk_1", "items": []json.RawMessage{it}, "updates": []any{}})
		tail = append(tail, push)
	}
	return map[string][][]byte{"status": status, "tail": tail}
}

// BenchmarkDeflateSmall sends a burst of small messages per op, under each
// mode and compression threshold, and reports the cost of one message.
func BenchmarkDeflateSmall(b *testing.B) {
	bursts := smallBursts(b)
	modes := []struct {
		name string
		opts *websocket.AcceptOptions
	}{
		{"off", &websocket.AcceptOptions{}},
		{"no-context-takeover", &websocket.AcceptOptions{CompressionMode: websocket.CompressionNoContextTakeover}},
		{"takeover-0", &websocket.AcceptOptions{CompressionMode: websocket.CompressionContextTakeover, CompressionThreshold: 1}},
		{"takeover-128", &websocket.AcceptOptions{CompressionMode: websocket.CompressionContextTakeover}},
		{"takeover-512", &websocket.AcceptOptions{CompressionMode: websocket.CompressionContextTakeover, CompressionThreshold: 512}},
		{"takeover-1024", &websocket.AcceptOptions{CompressionMode: websocket.CompressionContextTakeover, CompressionThreshold: 1024}},
	}
	for _, kind := range []string{"status", "tail"} {
		burst := bursts[kind]
		var raw int64
		for _, msg := range burst {
			raw += int64(len(msg))
		}
		for _, m := range modes {
			b.Run(kind+"/"+m.name, func(b *testing.B) {
				ws, wc := acceptWire(b, m.opts, chromeOffer)
				for b.Loop() {
					for _, msg := range burst {
						write(b, ws, msg)
					}
				}
				n := float64(b.N) * float64(len(burst))
				b.ReportMetric(float64(b.Elapsed().Nanoseconds())/n, "ns/msg")
				b.ReportMetric(float64(raw)/float64(len(burst)), "B-raw/msg")
				b.ReportMetric(float64(wc.written)/n, "B-wire/msg")
			})
		}
	}
}
