package herdr

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
)

func TestCodexStartupHookReview(t *testing.T) {
	const screen = "Hooks need review\n1. Review hooks\n2. Trust all and continue\n3. Continue without trusting (hooks won't run)"
	for _, code := range []string{"timeout", "agent_name_not_found"} {
		for _, launch := range []string{"embedded", "shared", "resume", "embedded resume"} {
			t.Run(code+"/"+launch, func(t *testing.T) {
				var calls [][]string
				c := &Control{CodexRun: "/run/codex", Run: func(_ context.Context, argv []string) ([]byte, []byte, error) {
					calls = append(calls, slices.Clone(argv))
					if slices.Contains(argv, "start") {
						return nil, []byte(fmt.Sprintf(`{"error":{"code":%q,"message":"startup failed"}}`, code)), errors.New("exit 1")
					}
					if slices.Contains(argv, "read") {
						return []byte(screen), nil, nil
					}
					return []byte(`{"result":{}}`), nil, nil
				}}
				a := Agent{Harness: "codex", Model: "mock", Effort: "low"}
				r := Remote{Socket: "/run/codex/a00000000001.sock", Cwd: "/tmp/project"}
				ctx := context.Background()
				var err error
				switch launch {
				case "embedded":
					err = c.StartAgent(ctx, "s", "w1:p1", "worker", a)
				case "shared":
					err = c.StartCodexRemote(ctx, "s", "w1:p1", "worker", a, r)
				case "resume":
					err = c.ResumeCodexRemote(ctx, "s", "w1:p1", "worker", "01a11172-ac09-7aa0-ab6b-84485199ada3", a, r)
				case "embedded resume":
					err = c.ResumeCodexEmbedded(ctx, "s", "w1:p1", "worker", "01a11172-ac09-7aa0-ab6b-84485199ada3", a)
				}
				var api *APIError
				if !errors.As(err, &api) || api.Code != "agent_not_ready" {
					t.Fatalf("startup = %v", err)
				}
				if len(calls) != 3 || strings.Join(calls[2][1:], " ") != "--session s agent rename w1:p1 worker" {
					t.Fatalf("expected one start, read, rename; got %v", calls)
				}
			})
		}
	}
}

func TestCodexStartupKeepsUnrelatedFailures(t *testing.T) {
	for _, tc := range []struct {
		name, code, screen string
		renameFails        bool
	}{
		{"ordinary timeout", "timeout", "loading", false},
		{"partial hook text", "timeout", "Hooks need review", false},
		{"another startup failure", "agent_pane_busy", "Hooks need review\nTrust all and continue\nContinue without trusting", false},
		{"name restoration failed", "timeout", "Hooks need review\nTrust all and continue\nContinue without trusting", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			original := &APIError{Code: tc.code, Message: "startup failed"}
			c := &Control{Run: func(_ context.Context, argv []string) ([]byte, []byte, error) {
				if slices.Contains(argv, "read") {
					return []byte(tc.screen), nil, nil
				}
				if tc.renameFails {
					return nil, nil, errors.New("rename failed")
				}
				t.Fatalf("unexpected command: %v", argv)
				return nil, nil, nil
			}}
			if err := c.codexStartupResult(context.Background(), "s", "w1:p1", "worker", original); !errors.Is(err, original) {
				t.Fatalf("lost startup failure: %v", err)
			}
		})
	}
}
