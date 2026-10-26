package herdr

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

func TestManualTabControl(t *testing.T) {
	var calls [][]string
	c := &Control{ManualDir: "/state/manual", Run: func(_ context.Context, argv []string) ([]byte, []byte, error) {
		calls = append(calls, argv)
		return []byte(`{"result":{"tab":{"tab_id":"w1:t2"},"root_pane":{"pane_id":"w1:p3"}}}`), nil, nil
	}}
	tab, err := c.CreateManualTab(context.Background(), "test", "w1", "/work", "⚙ test")
	if err != nil || tab.TabID != "w1:t2" || tab.PaneID != "w1:p3" {
		t.Fatalf("tab=%+v err=%v", tab, err)
	}
	if err := c.LaunchManual(context.Background(), "test", tab.PaneID, "/state/manual/mp_12345678"); err != nil {
		t.Fatal(err)
	}
	if err := c.CloseManualTab(context.Background(), "test", tab.TabID); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(calls[0], []string{"herdr", "--session", "test", "tab", "create", "--workspace", "w1", "--cwd", "/work", "--label", "⚙ test", "--no-focus"}) {
		t.Fatalf("create: %q", calls[0])
	}
	for _, dir := range []string{"/state/manual/mp_1234567", "/state/manual/mp_12345678/child", "/state/manual/../mp_12345678", "/other/mp_12345678"} {
		if err := c.LaunchManual(context.Background(), "test", "w1:p3", dir); !errors.Is(err, ErrNotAllowed) {
			t.Errorf("dir %q: %v", dir, err)
		}
	}
}
