package server

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"

	"github.com/JeffreyVdb/herdr-3d/internal/gitremote"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// hireOptions is what can be hired (and chosen as a floor's default hire).
var hireOptions = proto.HireOptions{
	Claude: proto.HarnessOptions{
		Models:  []string{"claude-opus-5-5", "claude-fable-5-1"},
		Efforts: []string{"low", "medium", "high", "xhigh", "max"},
	},
	Codex: proto.HarnessOptions{
		Models:       []string{"gpt-6-sol", "gpt-6-luna", "gpt-6-astra"},
		Efforts:      []string{"low", "medium", "high", "xhigh", "max"},
		ExtraEfforts: map[string][]string{"gpt-6-sol": {"ultra"}, "gpt-6-astra": {"ultra"}},
	},
}

// HireOptions returns a copy of what can be hired.
func HireOptions() proto.HireOptions {
	c := hireOptions
	c.Codex.ExtraEfforts = map[string][]string{}
	for m, e := range hireOptions.Codex.ExtraEfforts {
		c.Codex.ExtraEfforts[m] = slices.Clone(e)
	}
	c.Claude.Models, c.Claude.Efforts = slices.Clone(c.Claude.Models), slices.Clone(c.Claude.Efforts)
	c.Codex.Models, c.Codex.Efforts = slices.Clone(c.Codex.Models), slices.Clone(c.Codex.Efforts)
	return c
}

func validHire(h proto.Hire) error {
	if err := validHireIn(hireOptions, h); err != nil {
		return fmt.Errorf("default_hire.%w", err)
	}
	return nil
}

// validHireIn checks a harness/model/effort against hire options.
func validHireIn(all proto.HireOptions, h proto.Hire) error {
	var opts proto.HarnessOptions
	switch h.Harness {
	case "claude":
		opts = all.Claude
	case "codex":
		opts = all.Codex
	default:
		return fmt.Errorf("harness must be claude or codex, got %q", h.Harness)
	}
	if !slices.Contains(opts.Models, h.Model) {
		return fmt.Errorf("model %q is not a %s model (%s)", h.Model, h.Harness, strings.Join(opts.Models, ", "))
	}
	if !slices.Contains(opts.Efforts, h.Effort) && !slices.Contains(opts.ExtraEfforts[h.Model], h.Effort) {
		return fmt.Errorf("effort %q is not an effort of %s", h.Effort, h.Model)
	}
	return nil
}

// Limits of the status_field setting.
const (
	maxFieldLen   = 64
	maxOptions    = 20
	maxProjectNum = 1 << 31
)

func validStatusField(f proto.StatusField) error {
	if !validLabel(f.Name) {
		return fmt.Errorf("status_field.name must be 1-%d bytes", maxFieldLen)
	}
	if len(f.Options) < 1 || len(f.Options) > maxOptions {
		return fmt.Errorf("status_field.options must have 1-%d entries", maxOptions)
	}
	seen := map[string]bool{}
	for _, o := range f.Options {
		if !validLabel(o) {
			return fmt.Errorf("status_field.options entries must be 1-%d bytes", maxFieldLen)
		}
		if seen[o] {
			return fmt.Errorf("status_field.options has %q twice", o)
		}
		seen[o] = true
	}
	return nil
}

func validLabel(s string) bool { return strings.TrimSpace(s) != "" && len(s) <= maxFieldLen }

// applySettings folds floor.settings.set args into a floor's settings:
// absent keys stay, null clears, a value (validated) replaces.
func applySettings(cur store.FloorSettings, a proto.FloorSettingsArgs, statDir func(string) error) (store.FloorSettings, error) {
	next := cur
	next.StatusOptions = slices.Clone(cur.StatusOptions)
	bad := func(format string, args ...any) error { return &badArgsError{fmt.Errorf(format, args...)} }
	if a.Repo.Set {
		next.Repo = ""
		if v := a.Repo.Value; v != nil {
			if !gitremote.ValidRepo(*v) {
				return cur, bad("repo must be a GitHub owner/repo, got %q", *v)
			}
			next.Repo = *v
		}
	}
	if a.Project.Set {
		next.ProjectOwner, next.ProjectNumber = "", 0
		if v := a.Project.Value; v != nil {
			if !gitremote.ValidOwner(v.Owner) {
				return cur, bad("project.owner must be a GitHub user or organization, got %q", v.Owner)
			}
			if v.Number < 1 || v.Number >= maxProjectNum {
				return cur, bad("project.number must be a positive integer, got %d", v.Number)
			}
			next.ProjectOwner, next.ProjectNumber = v.Owner, v.Number
		}
	}
	if a.StatusField.Set {
		next.StatusField, next.StatusOptions = "", nil
		if v := a.StatusField.Value; v != nil {
			if err := validStatusField(*v); err != nil {
				return cur, &badArgsError{err}
			}
			next.StatusField, next.StatusOptions = v.Name, slices.Clone(v.Options)
		}
	}
	if a.DefaultCwd.Set {
		next.DefaultCwd = ""
		if v := a.DefaultCwd.Value; v != nil {
			dir := *v
			if !filepath.IsAbs(dir) || strings.ContainsRune(dir, 0) {
				return cur, bad("default_cwd must be an absolute path, got %q", dir)
			}
			dir = filepath.Clean(dir)
			if err := statDir(dir); err != nil {
				return cur, bad("default_cwd %q: %v", dir, err)
			}
			next.DefaultCwd = dir
		}
	}
	if a.DefaultHire.Set {
		next.HireHarness, next.HireModel, next.HireEffort = "", "", ""
		if v := a.DefaultHire.Value; v != nil {
			if err := validHire(*v); err != nil {
				return cur, &badArgsError{err}
			}
			next.HireHarness, next.HireModel, next.HireEffort = v.Harness, v.Model, v.Effort
		}
	}
	return next, nil
}

// isDir is the default Options.StatDir: dir exists and is a directory.
func isDir(dir string) error {
	fi, err := os.Stat(dir)
	if err != nil {
		return errors.Unwrap(err)
	}
	if !fi.IsDir() {
		return errors.New("not a directory")
	}
	return nil
}

// settingsView renders stored settings for the protocol (nil: none set).
func settingsView(s store.FloorSettings) *proto.FloorSettings {
	if s.IsZero() {
		return nil
	}
	v := &proto.FloorSettings{Repo: s.Repo, DefaultCwd: s.DefaultCwd}
	if s.ProjectNumber != 0 {
		v.Project = &proto.Project{Owner: s.ProjectOwner, Number: s.ProjectNumber}
	}
	if s.StatusField != "" {
		v.StatusField = &proto.StatusField{Name: s.StatusField, Options: slices.Clone(s.StatusOptions)}
	}
	if s.HireHarness != "" {
		v.DefaultHire = &proto.Hire{Harness: s.HireHarness, Model: s.HireModel, Effort: s.HireEffort}
	}
	return v
}

// setSettings runs floor.settings.set.
func (h *Hub) setSettings(ctx context.Context, a proto.FloorSettingsArgs) error {
	f, err := h.floorFor(a.Session)
	if err != nil {
		return err
	}
	if err := h.notBusy(a.Session, f); err != nil {
		return err
	}
	cur := h.settings[a.Session]
	next, err := applySettings(cur, a, h.opts.StatDir)
	if err != nil {
		return err
	}
	if settingsEqual(cur, next) {
		return nil
	}
	if err := h.st.SetFloorSettings(ctx, a.Session, next); err != nil {
		return err
	}
	if next.IsZero() {
		delete(h.settings, a.Session)
	} else {
		h.settings[a.Session] = next
	}
	h.refreshSuggested(a.Session, f)
	return nil
}

func settingsEqual(a, b store.FloorSettings) bool {
	return reflect.DeepEqual(settingsView(a), settingsView(b))
}
