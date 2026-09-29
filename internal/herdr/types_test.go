package herdr

import "testing"

func TestSnapshotPaneSize(t *testing.T) {
	layout := func(w, h int) []LayoutInfo {
		return []LayoutInfo{{Panes: []LayoutPane{{PaneID: "p1", Rect: Rect{Width: w, Height: h}}}}}
	}
	pane := func(rows int) []PaneInfo {
		return []PaneInfo{{PaneID: "p1", Scroll: &PaneScroll{ViewportRows: rows}}}
	}
	for _, tc := range []struct {
		name       string
		s          Snapshot
		cols, rows int
		ok         bool
	}{
		{"layout only", Snapshot{Layouts: layout(90, 30)}, 90, 30, true},
		{"layout agrees with the pane", Snapshot{Layouts: layout(90, 30), Panes: pane(30)}, 90, 30, true},
		{"a shorter pane keeps the layout's height", Snapshot{Layouts: layout(90, 30), Panes: pane(20)}, 90, 30, true},
		{"a taller pane than a laid-out one keeps its width", Snapshot{Layouts: layout(90, 30), Panes: pane(56)}, 90, 56, true},
		{"headless layout: the pane's height, a width to match", Snapshot{Layouts: layout(120, 40), Panes: pane(56)}, 156, 56, true},
		{"headless layout, a pane no taller", Snapshot{Layouts: layout(120, 40), Panes: pane(40)}, 120, 40, true},
		{"no such pane", Snapshot{Layouts: layout(120, 40)}, 0, 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cols, rows, ok := tc.s.PaneSize("p1")
			if !tc.ok {
				cols, rows, ok = tc.s.PaneSize("nope")
			}
			if cols != tc.cols || rows != tc.rows || ok != tc.ok {
				t.Fatalf("PaneSize = %d×%d %v, want %d×%d %v", cols, rows, ok, tc.cols, tc.rows, tc.ok)
			}
		})
	}
}
