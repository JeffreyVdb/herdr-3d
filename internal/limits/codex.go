package limits

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"slices"
	"strconv"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/codex"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

var codexArgs = []string{"app-server"}

const (
	codexInitialize  = `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"herdr-world","title":"herdr-world","version":"1"}}}`
	codexInitialized = `{"jsonrpc":"2.0","method":"initialized"}`
	codexRead        = `{"jsonrpc":"2.0","id":2,"method":"account/rateLimits/read"}`
)

// probeCodex asks `codex app-server` (JSON-RPC over stdio) for the rate
// limits.
func (c *Config) probeCodex(ctx context.Context) (proto.Limits, error) {
	dir, err := os.MkdirTemp("", "h3d-limits-")
	if err != nil {
		return proto.Limits{}, err
	}
	defer os.RemoveAll(dir)
	s, err := startSession(c.Runner, Cmd{Path: c.CodexBin, Args: codexArgs, Dir: dir, Env: probeEnv(c.Env())}, c.timing())
	if err != nil {
		return proto.Limits{}, err
	}
	defer s.finish()
	timer := time.NewTimer(c.Timeout)
	defer timer.Stop()
	reply := func(id string) (json.RawMessage, error) {
		for {
			line, err := s.next(ctx, timer.C)
			if err != nil {
				return nil, err
			}
			var m struct {
				ID     json.RawMessage `json:"id"`
				Result json.RawMessage `json:"result"`
				Error  *struct {
					Message string `json:"message"`
				} `json:"error"`
			}
			if json.Unmarshal(line, &m) != nil || string(bytes.TrimSpace(m.ID)) != id {
				continue // a notification, or the other request's answer
			}
			if m.Error != nil {
				return nil, fmt.Errorf("app-server: %s", trunc(m.Error.Message, 200))
			}
			return m.Result, nil
		}
	}
	if err := s.send(codexInitialize); err != nil {
		return proto.Limits{}, fmt.Errorf("write initialize: %w", err)
	}
	if _, err := reply("1"); err != nil {
		return proto.Limits{}, err
	}
	if err := s.send(codexInitialized); err != nil {
		return proto.Limits{}, fmt.Errorf("write initialized: %w", err)
	}
	if err := s.send(codexRead); err != nil {
		return proto.Limits{}, fmt.Errorf("write read: %w", err)
	}
	res, err := reply("2")
	if err != nil {
		return proto.Limits{}, err
	}
	return parseCodexRead(res, c.Now())
}

// codexLimit is one rate limit as either source spells it: the app-server's
// camelCase (account/rateLimits/read) and the rollout's snake_case
// (token_count.rate_limits). Unknown keys are ignored.
type codexLimit struct {
	LimitID    string     `json:"limitId"`
	LimitName  string     `json:"limitName"`
	PlanType   string     `json:"planType"`
	Reached    *string    `json:"rateLimitReachedType"`
	SnakeID    string     `json:"limit_id"`
	SnakeName  string     `json:"limit_name"`
	SnakePlan  string     `json:"plan_type"`
	SnakeReach *string    `json:"rate_limit_reached_type"`
	Primary    *codexWin  `json:"primary"`
	Secondary  *codexWin  `json:"secondary"`
	Credits    *codexCred `json:"credits"`
}

type codexWin struct {
	UsedPercent *float64 `json:"usedPercent"`
	Mins        int      `json:"windowDurationMins"`
	ResetsAt    int64    `json:"resetsAt"`
	SnakeUsed   *float64 `json:"used_percent"`
	SnakeMins   int      `json:"window_minutes"`
	SnakeResets int64    `json:"resets_at"`
}

type codexCred struct {
	Has       bool   `json:"hasCredits"`
	SnakeHas  bool   `json:"has_credits"`
	Unlimited bool   `json:"unlimited"`
	Balance   string `json:"balance"`
}

func (l *codexLimit) id() string {
	if l.LimitID != "" {
		return l.LimitID
	}
	return l.SnakeID
}

func (l *codexLimit) name() string {
	if l.LimitName != "" {
		return l.LimitName
	}
	return l.SnakeName
}

func (l *codexLimit) plan() string {
	if l.PlanType != "" {
		return l.PlanType
	}
	return l.SnakePlan
}

func (l *codexLimit) reached() string {
	for _, r := range []*string{l.Reached, l.SnakeReach} {
		if r != nil && *r != "" {
			return *r
		}
	}
	return ""
}

// windows lists the limit's windows; model names them when the limit is
// not the account's own.
func (l *codexLimit) windows(model string) []proto.LimitWindow {
	var out []proto.LimitWindow
	for _, w := range []*codexWin{l.Primary, l.Secondary} {
		if w == nil {
			continue
		}
		used := w.UsedPercent
		if used == nil {
			used = w.SnakeUsed
		}
		mins, resets := w.Mins, w.ResetsAt
		if mins == 0 {
			mins = w.SnakeMins
		}
		if resets == 0 {
			resets = w.SnakeResets
		}
		if used == nil {
			continue
		}
		out = append(out, proto.LimitWindow{Label: windowLabel(mins), Model: model, Pct: *used,
			ResetsAt: resets * 1000, WindowMins: mins})
	}
	return out
}

// windowLabel names a window by its length.
func windowLabel(mins int) string {
	switch {
	case mins <= 0:
		return "limit"
	case mins == 300:
		return "5h"
	case mins == 10080:
		return "week"
	case mins%1440 == 0:
		return strconv.Itoa(mins/1440) + "d"
	case mins%60 == 0:
		return strconv.Itoa(mins/60) + "h"
	}
	return strconv.Itoa(mins) + "m"
}

// limits turns the account's own limit into readings' fields.
func (l *codexLimit) fill(out *proto.Limits) {
	out.Plan = l.plan()
	out.Reached = l.reached()
	out.Windows = append(out.Windows, l.windows("")...)
	if c := l.Credits; c != nil {
		out.Credits = &proto.LimitCredits{Has: c.Has || c.SnakeHas, Unlimited: c.Unlimited, Balance: c.Balance}
	}
}

// parseCodexRead reads the result of account/rateLimits/read.
func parseCodexRead(res json.RawMessage, now time.Time) (proto.Limits, error) {
	var r struct {
		RateLimits        *codexLimit           `json:"rateLimits"`
		RateLimitsByLimit map[string]codexLimit `json:"rateLimitsByLimitId"`
	}
	l := proto.Limits{Provider: proto.LimitsCodex, At: now.UnixMilli(), Source: proto.LimitsProbe, Windows: []proto.LimitWindow{}}
	if err := json.Unmarshal(res, &r); err != nil || r.RateLimits == nil {
		return l, errors.New("account/rateLimits/read: no rateLimits")
	}
	r.RateLimits.fill(&l)
	// More than one limit (a model's own, e.g. Spark): its windows follow,
	// named by the limit, in a stable order.
	ids := make([]string, 0, len(r.RateLimitsByLimit))
	for id := range r.RateLimitsByLimit {
		if id != r.RateLimits.id() {
			ids = append(ids, id)
		}
	}
	slices.Sort(ids)
	for _, id := range ids {
		o := r.RateLimitsByLimit[id]
		name := o.name()
		if name == "" {
			name = id
		}
		l.Windows = append(l.Windows, o.windows(name)...)
		if l.Reached == "" {
			l.Reached = o.reached()
		}
	}
	if len(l.Windows) == 0 {
		return l, errNoPlan
	}
	return l, nil
}

// rolloutTail is how much of the end of a rollout the fallback reads: a
// token_count line is about a kilobyte and they come every turn.
const rolloutTail = 1 << 20

// maxRollouts is how many of the newest rollouts the fallback looks in.
const maxRollouts = 40

// fromTranscript is the fallback: the last token_count rate_limits any of
// the newest rollouts recorded, at the time it recorded them. It only
// reads.
func (c *Config) fromTranscript() (proto.Limits, bool) {
	if c.CodexSessions == "" {
		return proto.Limits{}, false
	}
	for _, path := range codex.NewestRollouts(c.CodexSessions, maxRollouts) {
		if l, ok := rolloutLimits(path); ok {
			return l, true
		}
	}
	return proto.Limits{}, false
}

// rolloutLimits reads the last rate_limits of one rollout.
func rolloutLimits(path string) (proto.Limits, bool) {
	f, err := os.Open(path)
	if err != nil {
		return proto.Limits{}, false
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return proto.Limits{}, false
	}
	off := max(st.Size()-rolloutTail, 0)
	buf := make([]byte, st.Size()-off)
	if _, err := f.ReadAt(buf, off); err != nil && !errors.Is(err, io.EOF) {
		return proto.Limits{}, false
	}
	lines := bytes.Split(buf, []byte("\n"))
	for i := len(lines) - 1; i >= 0; i-- {
		line := lines[i]
		if !bytes.Contains(line, []byte(`"token_count"`)) || !bytes.Contains(line, []byte(`"rate_limits"`)) {
			continue
		}
		var m struct {
			Timestamp string `json:"timestamp"`
			Payload   struct {
				Type       string      `json:"type"`
				RateLimits *codexLimit `json:"rate_limits"`
			} `json:"payload"`
		}
		if json.Unmarshal(line, &m) != nil || m.Payload.Type != "token_count" || m.Payload.RateLimits == nil {
			continue // the first line of a tail may be cut
		}
		at, err := time.Parse(time.RFC3339Nano, m.Timestamp)
		if err != nil {
			continue
		}
		l := proto.Limits{Provider: proto.LimitsCodex, At: at.UnixMilli(), Stale: true, Source: proto.LimitsTranscript,
			Windows: []proto.LimitWindow{}}
		m.Payload.RateLimits.fill(&l)
		if len(l.Windows) == 0 {
			continue
		}
		return l, true
	}
	return proto.Limits{}, false
}
