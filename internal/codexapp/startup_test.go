package codexapp

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/mcpdiag"
)

func TestStartupObserverReadsOnlyNamedThreadConnections(t *testing.T) {
	f := newFakeServer(t)
	f.respond = func(method string, p map[string]any) (any, any, bool) {
		switch method {
		case "config/read":
			return map[string]any{"config": map[string]any{"mcp_servers": map[string]any{"code-intel": map[string]any{}, "disabled": map[string]any{"enabled": false}}}}, nil, false
		case "mcpServerStatus/list":
			if p["threadId"] != "th1" || p["serverName"] != "code-intel" {
				t.Errorf("unsafe status request: %v", p)
			}
			return map[string]any{"data": []any{map[string]any{"name": "code-intel", "runtimeStatus": "failed", "toolsError": "timeout https://PRIVATE.example"}}}, nil, false
		}
		t.Errorf("unexpected request %s", method)
		return nil, nil, false
	}
	changed := make(chan []mcpdiag.Diagnostic, 8)
	s, err := ObserveStartup(context.Background(), f.sock, "/w", func(rows []mcpdiag.Diagnostic) { changed <- rows })
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if slices.Contains(f.methods(), "mcpServerStatus/list") {
		t.Fatal("listed without a thread")
	}
	f.mu.Lock()
	c := f.conns[0]
	f.mu.Unlock()
	f.send(c, map[string]any{"method": "thread/started", "params": map[string]any{"thread": f.thread}})
	select {
	case rows := <-changed:
		b, _ := json.Marshal(rows)
		if len(rows) != 1 || rows[0].Category != "timeout" || strings.Contains(string(b), "PRIVATE") {
			t.Fatalf("unsafe or missing evidence: %s", b)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no diagnostic before the first turn")
	}
	s.Close()
	for _, method := range f.methods() {
		if !slices.Contains([]string{"initialize", "initialized", "config/read", "mcpServerStatus/list"}, method) {
			t.Fatalf("observer sent %s", method)
		}
	}
}

func TestStartupNotificationSafeAndScoped(t *testing.T) {
	p := json.RawMessage(`{"threadId":"th1","name":"code-intel","status":"failed","error":"PRIVATE URL timed out","failureReason":"reauthenticationRequired"}`)
	d, ok := StartupNotification("th1", "mcpServer/startupStatus/updated", p)
	if !ok || d.Category != "auth" || d.Source != "notification" {
		t.Fatalf("notification %+v %t", d, ok)
	}
	if _, ok := StartupNotification("other", "mcpServer/startupStatus/updated", p); ok {
		t.Fatal("another thread's diagnostic")
	}
	if _, ok := StartupNotification("", "mcpServer/startupStatus/updated", p); ok {
		t.Fatal("unscoped diagnostic")
	}
}
