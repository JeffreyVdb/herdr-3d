package codexapp

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// #139: what account/read and configRequirements/read say, as far as they
// are read: never the email.
func TestReadProfile(t *testing.T) {
	signedIn := map[string]any{"account": map[string]any{"type": "chatgpt", "email": "a@example.invalid", "planType": "team"},
		"requiresOpenaiAuth": true, "workspaceRouting": map[string]any{"chatgptAccountId": "acct-1", "accountRoutingOverride": "NO_CONSTRAINT"}}
	for _, c := range []struct {
		name      string
		acct, req any
		want      Account
		wantReq   Requirements
	}{
		{"signed in, no policy", signedIn, map[string]any{"requirements": nil}, Account{SignedIn: true, Plan: "team", ID: "acct-1"}, Requirements{}},
		{"not signed in", map[string]any{"account": nil, "requiresOpenaiAuth": true}, map[string]any{"requirements": nil}, Account{}, Requirements{}},
		{"no workspaceRouting", map[string]any{"account": map[string]any{"type": "chatgpt", "email": "a@example.invalid", "planType": "plus"}},
			map[string]any{"requirements": nil}, Account{SignedIn: true, Plan: "plus"}, Requirements{}},
		{"a policy", signedIn, map[string]any{"requirements": map[string]any{
			"allowedApprovalPolicies": []any{"on-request", map[string]any{"granular": map[string]any{}}},
			"allowedSandboxModes":     []any{"read-only", "workspace-write"}}},
			Account{SignedIn: true, Plan: "team", ID: "acct-1"},
			Requirements{Present: true, Approvals: []string{"on-request", "granular"}, Sandboxes: []string{"read-only", "workspace-write"}}},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newFakeServer(t)
			f.respond = func(method string, params map[string]any) (any, any, bool) {
				switch method {
				case "account/read":
					if params["refreshToken"] != false {
						t.Errorf("account/read params %v", params)
					}
					return c.acct, nil, false
				case "configRequirements/read":
					return c.req, nil, false
				}
				return nil, map[string]any{"code": -32601, "message": "unknown"}, false
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			a, r, err := ReadProfile(ctx, f.sock)
			if err != nil {
				t.Fatal(err)
			}
			if a != c.want || r.Present != c.wantReq.Present || !slices.Equal(r.Approvals, c.wantReq.Approvals) || !slices.Equal(r.Sandboxes, c.wantReq.Sandboxes) {
				t.Fatalf("got %+v %+v, want %+v %+v", a, r, c.want, c.wantReq)
			}
			if strings.Contains(fmt.Sprintf("%#v %#v", a, r), "example.invalid") {
				t.Fatal("the email was kept")
			}
			init := f.messages()[0]
			if caps, _ := init["params"].(map[string]any)["capabilities"].(map[string]any); init["method"] != "initialize" || caps["experimentalApi"] != true {
				t.Fatalf("initialize %v", init)
			}
		})
	}
}

func TestRequirementsRefuses(t *testing.T) {
	for _, c := range []struct {
		r    Requirements
		want bool
	}{
		{Requirements{}, false},
		{Requirements{Present: true}, false}, // nothing limited
		{Requirements{Present: true, Approvals: []string{"on-request", "never"}, Sandboxes: []string{"danger-full-access"}}, false},
		{Requirements{Present: true, Approvals: []string{"on-request"}}, true},
		{Requirements{Present: true, Sandboxes: []string{"read-only", "workspace-write"}}, true},
		{Requirements{Present: true, Approvals: []string{}}, true},
	} {
		if got := c.r.Refuses(); got != c.want {
			t.Errorf("%+v: Refuses = %v", c.r, got)
		}
	}
}

// fakeStdioCodex is `codex app-server` on stdio (TestMain): it answers
// initialize and account/read, signed in as its CODEX_HOME's last element,
// or not signed in when that is "nobody".
func fakeStdioCodex() {
	sc := bufio.NewScanner(os.Stdin)
	for sc.Scan() {
		var m map[string]any
		if json.Unmarshal(sc.Bytes(), &m) != nil || m["id"] == nil {
			continue
		}
		var res any = map[string]any{}
		switch m["method"] {
		case "initialize":
			caps, _ := m["params"].(map[string]any)["capabilities"].(map[string]any)
			if caps["experimentalApi"] != true {
				os.Exit(4)
			}
		case "account/read":
			home := filepath.Base(os.Getenv("CODEX_HOME"))
			res = map[string]any{"account": map[string]any{"type": "chatgpt", "email": "x@example.invalid", "planType": "team"},
				"workspaceRouting": map[string]any{"chatgptAccountId": home}}
			if home == "nobody" {
				res = map[string]any{"account": nil}
			}
		}
		fmt.Println(`{"method":"configWarning","params":{}}`) // a notification first: skipped
		b, _ := json.Marshal(map[string]any{"id": m["id"], "result": res})
		fmt.Println(string(b))
	}
}

func TestReadHomeAccount(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(t.TempDir(), "codex")
	if err := os.Symlink(self, bin); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	a, err := ReadHomeAccount(ctx, bin, []string{"CODEX_HOME=/home/u/.codex-work"})
	if err != nil || a != (Account{SignedIn: true, Plan: "team", ID: ".codex-work"}) {
		t.Fatalf("got %+v, %v", a, err)
	}
	if a, err := ReadHomeAccount(ctx, bin, []string{"CODEX_HOME=/home/u/nobody"}); err != nil || a.SignedIn {
		t.Fatalf("not signed in: %+v, %v", a, err)
	}
	if _, err := ReadHomeAccount(ctx, filepath.Join(t.TempDir(), "nope"), nil); err == nil {
		t.Fatal("a missing codex answered")
	}
}
