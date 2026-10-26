package manual

import "testing"

func TestServeEffectAdapter(t *testing.T) {
	command := "sudo tailscale serve --bg --https=8443 http://127.0.0.1:39525"
	effect, ok := Effects.Parse(command)
	if !ok || effect.Endpoint != "https:8443" || Effects.CleanupCommand(effect) != "sudo tailscale serve --bg --https=8443 off" {
		t.Fatalf("unexpected effect: %+v, %v", effect, ok)
	}
	if conflict, err := Effects.Conflict([]byte(`{"TCP":{"8443":{"HTTPS":true}}}`), effect); err != nil || !conflict {
		t.Fatalf("expected conflict, got %v, %v", conflict, err)
	}
	if conflict, err := Effects.Conflict([]byte(`{"TCP":{"443":{"HTTPS":true}}}`), effect); err != nil || conflict {
		t.Fatalf("unexpected conflict: %v, %v", conflict, err)
	}
	if _, ok := Effects.Parse("tailscale serve --https=8443 http://127.0.0.1:39525"); ok {
		t.Fatal("foreground serve is not a persistent effect")
	}
}
