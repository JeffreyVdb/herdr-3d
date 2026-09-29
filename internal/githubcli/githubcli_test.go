package githubcli

import (
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/provider"
)

type call struct {
	argv  []string
	stdin []byte
}

func fake(out, errOut string, err error, calls *[]call) Runner {
	return func(ctx context.Context, argv []string, stdin []byte) ([]byte, []byte, error) {
		if calls != nil {
			*calls = append(*calls, call{argv, stdin})
		}
		return []byte(out), []byte(errOut), err
	}
}

// TestGitHubAllowlist is the tripwire for what the bridge runs through gh:
// one command shape, and a fixed set of documents.
func TestGitHubAllowlist(t *testing.T) {
	if want := []string{"{gh}", "api", "graphql", "--method", "POST", "--input", "-"}; !slices.Equal(argv, want) {
		t.Fatalf("argv = %q", argv)
	}
	want := []Doc{"add-comment", "add-project-item", "close-issue", "create-pr", "feed", "issue-detail", "issue-node", "merge-pr",
		"open-issues-page", "open-pr-for-head", "open-prs-page", "pr-detail", "pr-node", "set-status", "status-target"}
	if got := Docs(); !slices.Equal(got, want) {
		t.Fatalf("documents = %q", got)
	}
	// Exactly these mutations may be in any document, and no other operation.
	mutations := map[Doc][]string{
		"add-comment": {"addComment"}, "add-project-item": {"addProjectV2ItemById"}, "close-issue": {"closeIssue"},
		"create-pr": {"createPullRequest"}, "merge-pr": {"mergePullRequest"}, "set-status": {"updateProjectV2ItemFieldValue"},
	}
	inputRe := regexp.MustCompile(`(\w+)\(input:`)
	for _, d := range Docs() {
		text := Text(d)
		isMutation := strings.HasPrefix(text, "mutation ")
		if !isMutation && !strings.HasPrefix(text, "query ") {
			t.Errorf("%s is neither a query nor a mutation: %.40s", d, text)
		}
		var found []string
		for _, m := range inputRe.FindAllStringSubmatch(text, -1) {
			found = append(found, m[1])
		}
		if !slices.Equal(found, mutations[d]) {
			t.Errorf("%s writes %q, want %q", d, found, mutations[d])
		}
		if isMutation != (mutations[d] != nil) {
			t.Errorf("%s: mutation = %v", d, isMutation)
		}
		if strings.Count(text, "query ")+strings.Count(text, "mutation ") != 1 || strings.Contains(text, "subscription") {
			t.Errorf("%s holds more than one operation", d)
		}
	}
	// The exported methods.
	var methods []string
	typ := reflect.TypeOf(&Client{})
	for i := range typ.NumMethod() {
		methods = append(methods, typ.Method(i).Name)
	}
	if !slices.Equal(methods, []string{"Query"}) {
		t.Fatalf("Client methods = %v", methods)
	}

	// What runs: the shape, with the document and its variables on stdin.
	var calls []call
	c := &Client{Bin: "/opt/gh", Run: fake(`{"data":{"x":1}}`, "", nil, &calls)}
	resp, err := c.Query(context.Background(), DocAddComment, map[string]any{"subjectId": "I_1", "body": "hi; rm -rf /"})
	if err != nil || string(resp.Data) != `{"x":1}` {
		t.Fatalf("Query = %+v %v", resp, err)
	}
	if !slices.Equal(calls[0].argv, []string{"/opt/gh", "api", "graphql", "--method", "POST", "--input", "-"}) {
		t.Fatalf("argv = %q", calls[0].argv)
	}
	var in struct {
		Query     string         `json:"query"`
		Variables map[string]any `json:"variables"`
	}
	if err := json.Unmarshal(calls[0].stdin, &in); err != nil || in.Query != Text(DocAddComment) || in.Variables["body"] != "hi; rm -rf /" {
		t.Fatalf("stdin = %s", calls[0].stdin)
	}
	// Nothing but an embedded document runs.
	calls = nil
	for _, d := range []Doc{"", "nope", "../feed", "feed ", "query { viewer { login } }"} {
		if _, err := c.Query(context.Background(), d, nil); !errors.Is(err, ErrNotAllowed) {
			t.Errorf("Query(%q): %v", d, err)
		}
	}
	if len(calls) != 0 {
		t.Fatal("a refused document ran")
	}
}

func TestEnv(t *testing.T) {
	got := Env([]string{"PATH=/bin", "HOME=/home/u", "GH_TOKEN=keep", "CLAUDECODE=1", "CLAUDE_CODE_ENTRYPOINT=cli", "HERDR_ENV=1",
		"HERDR_SESSION=s", "HERDR_SOCKET_PATH=/x", "XDG_CONFIG_HOME=/c"})
	for _, kv := range []string{"CLAUDECODE=1", "CLAUDE_CODE_ENTRYPOINT=cli", "HERDR_ENV=1", "HERDR_SESSION=s", "HERDR_SOCKET_PATH=/x"} {
		if slices.Contains(got, kv) {
			t.Errorf("%s is passed on", kv)
		}
	}
	for _, kv := range []string{"PATH=/bin", "HOME=/home/u", "GH_TOKEN=keep", "XDG_CONFIG_HOME=/c", "GH_PROMPT_DISABLED=1", "NO_COLOR=1", "GH_NO_UPDATE_NOTIFIER=1"} {
		if !slices.Contains(got, kv) {
			t.Errorf("%s is missing", kv)
		}
	}
}

func TestClassify(t *testing.T) {
	exit := func(code int) error { return &ExitError{Code: code} }
	cases := []struct {
		name         string
		out, errOut  string
		err          error
		wantErr      error
		wantContains string
		wantErrors   int
		rate         bool
	}{
		{name: "data", out: `{"data":{"a":1}}`},
		{name: "errors with data and exit 0", out: `{"data":{"a":null},"errors":[{"type":"NOT_FOUND","message":"gone"}]}`, wantErrors: 1},
		{name: "errors and exit 1", out: `{"data":{"repository":null},"errors":[{"type":"NOT_FOUND","message":"Could not resolve"}]}`, err: exit(1), wantErrors: 1},
		{name: "bad credentials", out: `{"message":"Bad credentials","status":"401"}`, errOut: "gh: Bad credentials (HTTP 401)", err: exit(1),
			wantErr: provider.ErrFailed, wantContains: "GitHub auth"},
		{name: "not logged in", errOut: "To get started with GitHub CLI, please run:  gh auth login", err: exit(4), wantErr: provider.ErrFailed, wantContains: "GitHub auth"},
		{name: "network", errOut: `Post "https://api.github.com/graphql": proxyconnect tcp: dial tcp 127.0.0.1:1: connect: connection refused`, err: exit(1),
			wantErr: provider.ErrFailed, wantContains: "connection refused"},
		{name: "rate limit error", out: `{"data":{"rateLimit":{"resetAt":"2026-09-29T13:00:00Z"}},"errors":[{"type":"RATE_LIMITED","message":"API rate limit exceeded"}]}`,
			err: exit(1), rate: true},
		{name: "secondary rate limit", out: `{"message":"You have exceeded a secondary rate limit.","status":"403"}`, errOut: "gh: You have exceeded a secondary rate limit. (HTTP 403)",
			err: exit(1), rate: true},
		{name: "not JSON", out: `<html>`, wantErr: provider.ErrFailed, wantContains: "not JSON"},
		{name: "a token in stderr", errOut: "gh: fatal ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked", err: exit(1), wantErr: provider.ErrFailed, wantContains: "[token]"},
		{name: "not found", err: exec.ErrNotFound, wantErr: provider.ErrFailed, wantContains: "gh not found"},
		{name: "too large", err: errTooLarge, wantErr: provider.ErrFailed, wantContains: "too large"},
	}
	for _, c := range cases {
		cl := &Client{Run: fake(c.out, c.errOut, c.err, nil)}
		resp, err := cl.Query(context.Background(), DocFeed, nil)
		switch {
		case c.rate:
			var rl *provider.RateLimitError
			if !errors.As(err, &rl) {
				t.Errorf("%s: err = %v, want a rate limit", c.name, err)
			}
			if strings.Contains(c.out, "resetAt") && !rl.ResetAt.Equal(time.Date(2026, 9, 29, 13, 0, 0, 0, time.UTC)) {
				t.Errorf("%s: reset at %v", c.name, rl.ResetAt)
			}
		case c.wantErr != nil:
			if !errors.Is(err, c.wantErr) || !strings.Contains(err.Error(), c.wantContains) {
				t.Errorf("%s: err = %v, want %v with %q", c.name, err, c.wantErr, c.wantContains)
			}
			if strings.Contains(err.Error(), "ghp_") {
				t.Errorf("%s: a token in %q", c.name, err)
			}
		default:
			if err != nil || len(resp.Errors) != c.wantErrors {
				t.Errorf("%s: %+v %v", c.name, resp, err)
			}
		}
	}
}

func TestTimeout(t *testing.T) {
	c := &Client{Timeout: 10 * time.Millisecond, Run: func(ctx context.Context, _ []string, _ []byte) ([]byte, []byte, error) {
		<-ctx.Done()
		return nil, nil, ctx.Err()
	}}
	_, err := c.Query(context.Background(), DocFeed, nil)
	if !errors.Is(err, provider.ErrFailed) || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("err = %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := (&Client{Run: func(ctx context.Context, _ []string, _ []byte) ([]byte, []byte, error) {
		return nil, nil, ctx.Err()
	}}).Query(ctx, DocFeed, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("a cancelled caller: %v", err)
	}
}

// The default runner: real processes, a missing gh, a stub that echoes its
// stdin, output capped.
func TestExecRunner(t *testing.T) {
	c := &Client{Bin: "/nonexistent/gh"}
	if _, err := c.Query(context.Background(), DocFeed, nil); !errors.Is(err, provider.ErrFailed) || !strings.Contains(err.Error(), "gh not found") {
		t.Fatalf("missing gh: %v", err)
	}
	out, _, err := execRunner(context.Background(), []string{"sh", "-c", "cat"}, []byte(`{"data":1}`))
	if err != nil || string(out) != `{"data":1}` {
		t.Fatalf("cat: %q %v", out, err)
	}
	_, _, err = execRunner(context.Background(), []string{"sh", "-c", "exit 4"}, nil)
	var ee *ExitError
	if !errors.As(err, &ee) || ee.Code != 4 {
		t.Fatalf("exit 4: %v", err)
	}
	_, _, err = execRunner(context.Background(), []string{"sh", "-c", "head -c 9000000 /dev/zero"}, nil)
	if !errors.Is(err, errTooLarge) {
		t.Fatalf("too much output: %v", err)
	}
}
