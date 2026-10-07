package kaneoconf

import (
	"context"
	"errors"
	"net/url"
	"slices"
	"strings"
	"sync"

	"github.com/JeffreyVdb/herdr-3d/internal/provider"
)

// FakeConnector is a Connector for tests: one made-up instance per origin,
// that accepts Key (any key when it is ""), with WorkspaceList and the
// projects of ProjectList. It never touches the network.
type FakeConnector struct {
	mu sync.Mutex
	// Key is the key the fake accepts ("" accepts any); another is a 401.
	Key           string
	WorkspaceList []Workspace
	// ProjectList are the projects, archived ones included (Projects
	// leaves those out like Kaneo).
	ProjectList []Project
	// Err, when set, is what every call answers.
	Err error
	// Gate, when set, holds every call until it is closed or ctx ends.
	Gate chan struct{}
	// Sent records the instance and key of every call, in order.
	Sent []FakeCall
}

// FakeCall is one call the fake answered.
type FakeCall struct {
	Op      string // test | workspaces | projects | project
	APIBase string
	Key     string
	Arg     string // the workspace or project id
}

// Resolve accepts http(s) origins and API bases: a trailing /api is not
// doubled.
func (f *FakeConnector) Resolve(raw string) (Instance, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return Instance{}, provider.Errorf(provider.ErrBadInput, "want an https URL of the instance")
	}
	origin := u.Scheme + "://" + strings.ToLower(u.Host)
	p := strings.TrimSuffix(strings.TrimSuffix(u.Path, "/"), "/api")
	return Instance{APIBase: origin + p + "/api", WebOrigin: origin + p}, nil
}

func (f *FakeConnector) enter(ctx context.Context, op string, in Instance, key, arg string) error {
	f.mu.Lock()
	f.Sent = append(f.Sent, FakeCall{Op: op, APIBase: in.APIBase, Key: key, Arg: arg})
	gate, ferr, want := f.Gate, f.Err, f.Key
	f.mu.Unlock()
	if gate != nil {
		select {
		case <-gate:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if ferr != nil {
		return ferr
	}
	if want != "" && key != want {
		return provider.Errorf(provider.ErrUnauthorized, "kaneo: 401 Unauthorized")
	}
	return nil
}

// Set changes the fake under its lock (a test's goroutine may race a call).
func (f *FakeConnector) Set(fn func(f *FakeConnector)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fn(f)
}

// Calls is a copy of Sent.
func (f *FakeConnector) Calls() []FakeCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.Sent)
}

func (f *FakeConnector) Test(ctx context.Context, in Instance, key string) (TestResult, error) {
	if err := f.enter(ctx, "test", in, key, ""); err != nil {
		return TestResult{}, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return TestResult{Workspaces: slices.Clone(f.WorkspaceList), User: "Fixture User"}, nil
}

func (f *FakeConnector) Workspaces(ctx context.Context, in Instance, key string) ([]Workspace, error) {
	if err := f.enter(ctx, "workspaces", in, key, ""); err != nil {
		return nil, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.WorkspaceList), nil
}

func (f *FakeConnector) Projects(ctx context.Context, in Instance, key, workspaceID string) ([]Project, error) {
	if err := f.enter(ctx, "projects", in, key, workspaceID); err != nil {
		return nil, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []Project
	for _, p := range f.ProjectList {
		if p.WorkspaceID == workspaceID && !p.Archived {
			out = append(out, p)
		}
	}
	return out, nil
}

// Project answers from the projects there were when it was called: a Gate
// only holds the answer back (an instance that answered, then was replaced).
func (f *FakeConnector) Project(ctx context.Context, in Instance, key, projectID string) (Project, error) {
	f.mu.Lock()
	var found *Project
	for _, p := range f.ProjectList {
		if p.ID == projectID {
			found = &p
		}
	}
	f.mu.Unlock()
	if err := f.enter(ctx, "project", in, key, projectID); err != nil {
		return Project{}, err
	}
	if found == nil {
		return Project{}, provider.Errorf(provider.ErrNotFound, "kaneo: 404 project")
	}
	return *found, nil
}

// Unreachable is the error a fake answers for a network failure.
func Unreachable() error {
	return errors.Join(ErrUnreachable, errors.New("dial tcp: connection refused"))
}
