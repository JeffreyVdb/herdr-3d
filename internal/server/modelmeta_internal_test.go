package server

import (
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// H3D-2: shownModel's precedence, field by field, and the transcript session
// its observed values belong to (usageTag: the session the usage was read
// from, and the one herdr named for the worker then; empty: none).
func TestShownModel(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name          string
		reported      modelEffort
		usage         *proto.Usage
		tag           usageTag
		agent         string
		model, effort string
	}{
		{"nothing known", modelEffort{}, nil, usageTag{"", ""}, "s1", "", ""},
		{"reported only", modelEffort{"x", "high"}, nil, usageTag{"", ""}, "s1", "x", "high"},
		{"observed over reported", modelEffort{"x", "high"}, &proto.Usage{Model: "y", Effort: "medium"}, usageTag{"s1", "s1"}, "s1", "y", "medium"},
		{"observed without a reported", modelEffort{}, &proto.Usage{Model: "y", Effort: "medium"}, usageTag{"s1", "s1"}, "s1", "y", "medium"},
		{"per field: no observed effort", modelEffort{"x", "high"}, &proto.Usage{Model: "y"}, usageTag{"s1", "s1"}, "s1", "y", "high"},
		{"per field: no observed model", modelEffort{"x", "high"}, &proto.Usage{Effort: "low"}, usageTag{"s1", "s1"}, "s1", "x", "low"},
		{"model id as the catalog writes it", modelEffort{"claude-opus-5-5", "high"}, &proto.Usage{Model: "claude-opus-5-5[1m]"}, usageTag{"s1", "s1"}, "s1", "claude-opus-5-5", "high"},
		{"synthetic is not evidence", modelEffort{"x", ""}, &proto.Usage{Model: "<synthetic>"}, usageTag{"s1", "s1"}, "s1", "x", ""},
		{"an effort that is not one", modelEffort{"x", "high"}, &proto.Usage{Effort: "high!"}, usageTag{"s1", "s1"}, "s1", "x", "high"},
		{"another session's usage", modelEffort{"x", "high"}, &proto.Usage{Model: "y", Effort: "low"}, usageTag{"s1", "s1"}, "s2", "x", "high"},
		{"the session is gone", modelEffort{}, &proto.Usage{Model: "y", Effort: "low"}, usageTag{"s1", "s1"}, "", "", ""},
		{"read before herdr named the session (a Codex found by its cwd), still none", modelEffort{"x", "high"}, &proto.Usage{Model: "y", Effort: "low"}, usageTag{"", "s1"}, "", "y", "low"},
		{"found by its cwd, then herdr names that rollout", modelEffort{"x", "high"}, &proto.Usage{Model: "y", Effort: "low"}, usageTag{"", "s1"}, "s1", "y", "low"},
		{"found by its cwd, then herdr names another session", modelEffort{"x", "high"}, &proto.Usage{Model: "y", Effort: "low"}, usageTag{"", "s1"}, "s2", "x", "high"},
		{"named s1 and read for it, then herdr names none", modelEffort{"x", "high"}, &proto.Usage{Model: "y", Effort: "low"}, usageTag{"s1", "s1"}, "", "x", "high"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			h := &Hub{reported: map[string]modelEffort{"w": tc.reported}, usage: map[string]*proto.Usage{}, usageFor: map[string]usageTag{}}
			if tc.usage != nil {
				h.usage["w"], h.usageFor["w"] = tc.usage, tc.tag
			}
			if model, effort := h.shownModel("w", tc.agent); model != tc.model || effort != tc.effort {
				t.Fatalf("shows %q %q, want %q %q", model, effort, tc.model, tc.effort)
			}
		})
	}
}
