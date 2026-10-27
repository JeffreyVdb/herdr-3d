package app

import (
	"bytes"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/manual/askpass"
)

func TestManualAskpassDispatch(t *testing.T) {
	root, err := os.MkdirTemp(os.Getenv("TMPDIR"), "mah")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	t.Setenv("XDG_RUNTIME_DIR", root)
	dir := filepath.Join(root, "mp_01234567")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := askpass.Env(dir, "mp_01234567"); err != nil {
		t.Fatal(err)
	}
	path := askpass.SocketPath()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	received := make(chan askpass.Request, 1)
	go func() {
		c, e := listener.Accept()
		if e != nil {
			return
		}
		defer c.Close()
		var req askpass.Request
		if json.NewDecoder(c).Decode(&req) != nil {
			return
		}
		received <- req
		_ = json.NewEncoder(c).Encode(askpass.Response{OK: true, Secret: []byte("synthetic-marker")})
	}()
	var stdout, stderr bytes.Buffer
	if got := World("herdr-world", []string{"manual-askpass", dir, "password prompt"}, &stdout, &stderr); got != 0 {
		t.Fatalf("exit %d stderr %q", got, stderr.String())
	}
	if stdout.String() != "synthetic-marker\n" || stderr.Len() != 0 {
		t.Fatalf("output %q %q", stdout.String(), stderr.String())
	}
	select {
	case req := <-received:
		if req.Process != "mp_01234567" || req.Prompt != "password prompt" || len(req.Nonce) != 64 {
			t.Fatalf("request %+v", req)
		}
	case <-time.After(time.Second):
		t.Fatal("no request")
	}
	if got := World("herdr-world", []string{"manual-askpass", dir}, &stdout, &stderr); got != 1 {
		t.Fatalf("missing prompt exit %d", got)
	}
	if strings.Contains(stderr.String(), "synthetic-marker") {
		t.Fatal("secret in stderr")
	}
}
