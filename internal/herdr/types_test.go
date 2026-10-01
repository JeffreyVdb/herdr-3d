package herdr

import (
	"encoding/json"
	"testing"
)

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

func TestSnapshotPaneStateZoom(t *testing.T) {
	area := Rect{Width: 134, Height: 49}
	two := func(zoomed bool, focused string) []LayoutInfo {
		return []LayoutInfo{{TabID: "w1:t1", Zoomed: zoomed, FocusedPaneID: focused, Area: area, Panes: []LayoutPane{
			{PaneID: "p1", Rect: Rect{Width: 67, Height: 49}}, {PaneID: "p2", Rect: Rect{Width: 67, Height: 49, X: 67}}}}}
	}
	for _, tc := range []struct {
		name       string
		s          Snapshot
		pane       string
		cols, rows int
		state      ZoomState
	}{
		{"zoomed and focused: the tab's area", Snapshot{Layouts: two(true, "p1")}, "p1", 134, 49, ZoomZoomed},
		{"zoomed, another pane focused: the pane's rect", Snapshot{Layouts: two(true, "p2")}, "p1", 67, 49, ZoomSplit},
		{"the focused pane of an unzoomed tab: its rect", Snapshot{Layouts: two(false, "p1")}, "p1", 67, 49, ZoomSplit},
		{"zoomed, the area is shorter than the pane's real rows", Snapshot{Layouts: two(true, "p1"),
			Panes: []PaneInfo{{PaneID: "p1", Scroll: &PaneScroll{ViewportRows: 60}}}}, "p1", 134, 60, ZoomZoomed},
		{"zoomed headless: the area is herdr's 120 × 40", Snapshot{Layouts: []LayoutInfo{{Zoomed: true, FocusedPaneID: "p1",
			Area: Rect{Width: 120, Height: 40}, Panes: []LayoutPane{{PaneID: "p1", Rect: Rect{Width: 60, Height: 40}},
				{PaneID: "p2", Rect: Rect{Width: 60, Height: 40}}}}}}, "p1", 120, 40, ZoomZoomed},
		{"a zoom flag on a lone pane is no zoom", Snapshot{Layouts: []LayoutInfo{{Zoomed: true, FocusedPaneID: "p1",
			Area: area, Panes: []LayoutPane{{PaneID: "p1", Rect: Rect{Width: 134, Height: 49}}}}}}, "p1", 134, 49, ZoomSingle},
		{"zoomed without an area keeps the rect", Snapshot{Layouts: []LayoutInfo{{Zoomed: true, FocusedPaneID: "p1",
			Panes: []LayoutPane{{PaneID: "p1", Rect: Rect{Width: 60, Height: 20}}, {PaneID: "p2", Rect: Rect{Width: 60, Height: 20}}}}}}, "p1", 60, 20, ZoomZoomed},
	} {
		t.Run(tc.name, func(t *testing.T) {
			st, ok := tc.s.PaneState(tc.pane)
			if !ok || st.Cols != tc.cols || st.Rows != tc.rows || st.Zoom() != tc.state {
				t.Fatalf("PaneState = %+v %v (%s), want %d×%d %s", st, ok, st.Zoom(), tc.cols, tc.rows, tc.state)
			}
			cols, rows, ok := tc.s.PaneSize(tc.pane)
			if !ok || cols != tc.cols || rows != tc.rows {
				t.Fatalf("PaneSize = %d×%d, want %d×%d", cols, rows, tc.cols, tc.rows)
			}
		})
	}
}

func TestPaneStateHeadlessAndTab(t *testing.T) {
	s := Snapshot{Layouts: []LayoutInfo{{TabID: "w1:t1", Area: Rect{Width: 120, Height: 40}, Panes: []LayoutPane{
		{PaneID: "p1", Rect: Rect{Width: 60, Height: 40}}, {PaneID: "p2", Rect: Rect{Width: 60, Height: 40}}}}}}
	st, ok := s.PaneState("p2")
	if !ok || st.TabID != "w1:t1" || st.PaneCount != 2 || !st.Headless || st.Zoomed || st.Focused {
		t.Fatalf("PaneState = %+v %v", st, ok)
	}
	if _, ok := s.PaneState("nope"); ok {
		t.Fatal("a pane that is not there has a state")
	}
}

// The layout of a zoomed two-pane tab, as herdr 0.9.0 reports it: the split
// rectangles stay, `zoomed`, the focused pane and the area say the rest.
func TestSnapshotDecodesAZoomedLayout(t *testing.T) {
	const raw = `{"layouts":[{"area":{"height":49,"width":134,"x":0,"y":0},"focused_pane_id":"w1:p1",
	"panes":[{"focused":true,"pane_id":"w1:p1","rect":{"height":49,"width":67,"x":0,"y":0}},
	{"focused":false,"pane_id":"w1:p2","rect":{"height":49,"width":67,"x":67,"y":0}}],
	"splits":[],"tab_id":"w1:t1","workspace_id":"w1","zoomed":true}]}`
	var s Snapshot
	if err := json.Unmarshal([]byte(raw), &s); err != nil {
		t.Fatal(err)
	}
	st, ok := s.PaneState("w1:p1")
	if !ok || st.Cols != 134 || st.Rows != 49 || st.Zoom() != ZoomZoomed || st.TabID != "w1:t1" || st.Headless {
		t.Fatalf("p1 = %+v %v", st, ok)
	}
	st, _ = s.PaneState("w1:p2")
	if st.Cols != 67 || st.Zoom() != ZoomSplit {
		t.Fatalf("p2 = %+v", st)
	}
}
