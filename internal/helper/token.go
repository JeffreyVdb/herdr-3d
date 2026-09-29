package helper

import (
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// LoadToken returns the helper token stored in path, creating it (random,
// file mode 0600, directory 0700) when the file is missing or malformed.
//
// The token outlives the helper: an installed game app (a Chrome web app on
// the Dock) keeps it in its own storage and starts without the #token= URL,
// so a helper restart, such as an update, must not invalidate it. Delete the
// file to rotate it; every open game then needs the new URL (`h3d-helper
// -print-url`).
func LoadToken(path string) (string, error) {
	if b, err := os.ReadFile(path); err == nil {
		if t := strings.TrimSpace(string(b)); validToken(t) {
			return t, nil
		}
	} else if !os.IsNotExist(err) {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", err
	}
	t := NewToken()
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(t+"\n"), 0o600); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, path); err != nil {
		return "", fmt.Errorf("saving the helper token: %w", err)
	}
	return t, nil
}

func validToken(t string) bool {
	if len(t) != 64 {
		return false
	}
	_, err := hex.DecodeString(t)
	return err == nil
}
