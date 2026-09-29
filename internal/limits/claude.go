package limits

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// claudeArgs start a Claude Code that only answers control requests: no
// tools, settings, MCP servers or slash commands, and no session file.
var claudeArgs = []string{"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
	"--tools", "", "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"}

const claudeRequest = `{"type":"control_request","request_id":"usage","request":{"subtype":"get_usage","skip_behaviors":true}}`

// errNoPlan is a probe that worked and found no plan limits.
var errNoPlan = errors.New("no plan")

// probeClaude asks Claude Code for the plan limits. Errors are errNoPlan,
// errNotInstalled, errTimeout or another failure.
func (c *Config) probeClaude(ctx context.Context) (proto.Limits, error) {
	dir, err := os.MkdirTemp("", "h3d-limits-")
	if err != nil {
		return proto.Limits{}, err
	}
	defer os.RemoveAll(dir)
	s, err := startSession(c.Runner, Cmd{Path: c.ClaudeBin, Args: claudeArgs, Dir: dir, Env: probeEnv(c.Env())}, c.timing())
	if err != nil {
		return proto.Limits{}, err
	}
	defer s.finish() // runs before the directory goes
	if err := s.send(claudeRequest); err != nil {
		return proto.Limits{}, fmt.Errorf("write request: %w", err)
	}
	timer := time.NewTimer(c.Timeout)
	defer timer.Stop()
	for {
		line, err := s.next(ctx, timer.C)
		if err != nil {
			return proto.Limits{}, err
		}
		if l, ok, err := parseClaude(line, c.Now()); ok {
			return l, err
		}
	}
}

type claudeWindow struct {
	Utilization *float64 `json:"utilization"`
	ResetsAt    *string  `json:"resets_at"`
}

type claudeScoped struct {
	DisplayName string   `json:"display_name"`
	Utilization *float64 `json:"utilization"`
	ResetsAt    *string  `json:"resets_at"`
}

type claudeControl struct {
	Type     string `json:"type"`
	Response struct {
		Subtype   string `json:"subtype"`
		RequestID string `json:"request_id"`
		Error     string `json:"error"`
		Response  struct {
			SubscriptionType    string `json:"subscription_type"`
			RateLimitsAvailable *bool  `json:"rate_limits_available"`
			RateLimits          *struct {
				FiveHour       *claudeWindow  `json:"five_hour"`
				SevenDay       *claudeWindow  `json:"seven_day"`
				SevenDayOpus   *claudeWindow  `json:"seven_day_opus"`
				SevenDaySonnet *claudeWindow  `json:"seven_day_sonnet"`
				ModelScoped    []claudeScoped `json:"model_scoped"`
			} `json:"rate_limits"`
		} `json:"response"`
	} `json:"response"`
}

// parseClaude reads one output line. ok is false for a line that is not the
// answer to the usage request (the stream carries other messages); unknown
// keys are ignored (the response has many codename fields).
func parseClaude(line []byte, now time.Time) (l proto.Limits, ok bool, err error) {
	var m claudeControl
	if json.Unmarshal(line, &m) != nil || m.Type != "control_response" || m.Response.RequestID != "usage" {
		return l, false, nil
	}
	r := m.Response
	if r.Subtype != "success" {
		return l, true, fmt.Errorf("get_usage: %s", trunc(r.Error, 200))
	}
	l = proto.Limits{Provider: proto.LimitsClaude, Plan: r.Response.SubscriptionType, At: now.UnixMilli(),
		Source: proto.LimitsProbe, Windows: []proto.LimitWindow{}}
	rl := r.Response.RateLimits
	if a := r.Response.RateLimitsAvailable; (a != nil && !*a) || rl == nil {
		return l, true, errNoPlan
	}
	add := func(label, model string, mins int, w *claudeWindow) {
		if w == nil || w.Utilization == nil {
			return
		}
		l.Windows = append(l.Windows, proto.LimitWindow{Label: label, Model: model, Pct: *w.Utilization,
			ResetsAt: isoMillis(w.ResetsAt), WindowMins: mins})
	}
	add("5h", "", 300, rl.FiveHour)
	add("week", "", 10080, rl.SevenDay)
	if len(rl.ModelScoped) > 0 {
		for _, s := range rl.ModelScoped {
			add("week", s.DisplayName, 10080, &claudeWindow{Utilization: s.Utilization, ResetsAt: s.ResetsAt})
		}
	} else { // the older shape
		add("week", "Opus", 10080, rl.SevenDayOpus)
		add("week", "Sonnet", 10080, rl.SevenDaySonnet)
	}
	if len(l.Windows) == 0 {
		return l, true, errors.New("get_usage: no windows")
	}
	return l, true, nil
}

// isoMillis is an ISO 8601 time as unix ms (0: none or unreadable).
func isoMillis(s *string) int64 {
	if s == nil || *s == "" {
		return 0
	}
	t, err := time.Parse(time.RFC3339Nano, *s)
	if err != nil {
		return 0
	}
	return t.UnixMilli()
}

func trunc(s string, n int) string {
	s = strings.ToValidUTF8(s, "")
	if len(s) > n {
		return s[:n]
	}
	return s
}
