package server

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/repodisc"
)

func co(path, common, origin string) repodisc.Checkout {
	return repodisc.Checkout{Path: path, Common: common, Main: common == path+"/.git", Origin: origin}
}

// #54: the floors' rows and the discovered repositories, one row per
// repository: floor URLs that a discovered checkout clones, remote
// spellings, subfolders, several floors of one repository, same-name
// unrelated repositories, local-only and non-GitHub ones.
func TestMergeRepos(t *testing.T) {
	work := "Work"
	cat := repodisc.NewCatalog(4, []repodisc.Checkout{
		withGH(co("/d/x", "/d/x/.git", "git@github.com:Acme/X.git"), "Acme/X"),
		withGH(co("/d/x-wt", "/d/x/.git", "git@github.com:Acme/X.git"), "Acme/X"),
		withGH(co("/d/api", "/d/api/.git", "https://github.com/acme/API"), "acme/API"),
		withGH(co("/home/y", "/home/y/.git", "https://github.com/acme/y.git"), "acme/y"),
		withGH(co("/d/y", "/d/y/.git", "https://github.com/acme/y.git"), "acme/y"),
		co("/d/z", "/d/z/.git", ""),
		co("/c/tool", "/c/tool/.git", ""),
		co("/e/tool", "/e/tool/.git", "https://gitlab.com/o/tool.git"),
	})
	floor := func(s, repo, dir string, cloned bool, root, gh string) floorRepo {
		return floorRepo{ref: proto.RepoRef{Session: s, Building: &work, SameBuilding: true, Repo: repo, Dir: dir, Cloned: cloned}, root: root, gh: gh}
	}
	got := mergeRepos([]floorRepo{
		floor("x-url", "acme/x", "", false, "", ""),              // a URL the scan has a checkout of
		floor("api", "ACME/api", "/elsewhere", false, "", ""),    // a folder that is not a checkout of it: the scan's is
		floor("y", "acme/y", "/home/y/src", true, "/home/y", ""), // a floor's own checkout wins over the scan's
		floor("z-sub", "", "/d/z/sub", false, "/d/z", ""),        // a subfolder of a discovered checkout
		floor("w1", "acme/w", "", false, "", ""),                 // two floors of one repository: the one with a checkout
		floor("w2", "acme/w", "/w2", true, "/w2", ""),
		floor("w3", "acme/w", "/w3", true, "/w3", ""),   // a second checkout: the first floor's wins
		floor("q", "", "/q/sub", false, "/q", "acme/q"), // a folder-only floor whose checkout's origin is a floor's repository
		floor("q-url", "acme/q", "", false, "", ""),
		floor("plain", "", "/srv/files", false, "", ""),
		floor("plain2", "", "/srv/files/", false, "", ""),
	}, cat)
	want := []proto.RepoRef{
		{ID: "gh:acme/x", Source: "floor", Session: "x-url", Building: &work, SameBuilding: true, Repo: "acme/x", Dir: "/d/x", Cloned: true, Checkouts: 2},
		{ID: "gh:acme/api", Source: "floor", Session: "api", Building: &work, SameBuilding: true, Repo: "ACME/api", Dir: "/d/api", Cloned: true, Checkouts: 1},
		{ID: "gh:acme/y", Source: "floor", Session: "y", Building: &work, SameBuilding: true, Repo: "acme/y", Dir: "/home/y/src", Cloned: true, Checkouts: 2},
		{ID: "git:/d/z/.git", Source: "floor", Session: "z-sub", Building: &work, SameBuilding: true, Dir: "/d/z/sub", Checkouts: 1},
		{ID: "gh:acme/w", Source: "floor", Session: "w2", Building: &work, SameBuilding: true, Repo: "acme/w", Dir: "/w2", Cloned: true},
		{ID: "gh:acme/q", Source: "floor", Session: "q", Building: &work, SameBuilding: true, Repo: "acme/q", Dir: "/q/sub", Cloned: true},
		{ID: "dir:/srv/files", Source: "floor", Session: "plain", Building: &work, SameBuilding: true, Dir: "/srv/files"},
		// The rest of the scan, by name: same-name repositories apart, local-only and non-GitHub ones too.
		{ID: "git:/c/tool/.git", Source: "discovered", Dir: "/c/tool", Checkouts: 1},
		{ID: "git:/e/tool/.git", Source: "discovered", Dir: "/e/tool", Checkouts: 1},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("merged:\n got %+v\nwant %+v", got, want)
	}

	// No discovery: the floors as they were, merged among themselves.
	got = mergeRepos([]floorRepo{floor("a", "acme/a", "", false, "", ""), floor("b", "acme/a", "/b", true, "/b", "")}, nil)
	if len(got) != 1 || got[0].Session != "b" || got[0].Dir != "/b" || got[0].Checkouts != 0 {
		t.Fatalf("floors only: %+v", got)
	}
	if got := mergeRepos(nil, nil); got == nil || len(got) != 0 {
		t.Fatalf("nothing: %#v", got)
	}
}

func withGH(c repodisc.Checkout, gh string) repodisc.Checkout {
	c.GitHub = gh
	return c
}

// resolveRepoRefs finds a folder's checkout and, for a folder-only floor,
// that checkout's origin.
func TestResolveRepoRefsRoots(t *testing.T) {
	stat := func(dir string) error {
		if dir == "/gone" {
			return errors.New("no")
		}
		return nil
	}
	origins := map[string]string{"/q": "acme/q", "/r": "acme/r"}
	origin := func(_ context.Context, dir string) string { return origins[dir] }
	root := func(dir string) string {
		switch dir {
		case "/q/sub":
			return "/q"
		case "/r":
			return "/r"
		}
		return ""
	}
	rows := resolveRepoRefs(context.Background(), []proto.RepoRef{
		{Session: "q", Dir: "/q/sub"},
		{Session: "r", Repo: "acme/r", Dir: "/r"},
		{Session: "gone", Dir: "/gone"},
		{Session: "plain", Dir: "/plain"},
	}, stat, origin, root)
	if len(rows) != 3 || rows[0].root != "/q" || rows[0].gh != "acme/q" || rows[1].root != "/r" || !rows[1].ref.Cloned || rows[2].root != "" || rows[2].gh != "" {
		t.Fatalf("rows = %+v", rows)
	}
}
