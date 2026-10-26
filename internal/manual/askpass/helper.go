package askpass

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const Timeout = 120 * time.Second

// SocketPath is private to the user's runtime directory.
func SocketPath() string {
	dir := os.Getenv("XDG_RUNTIME_DIR")
	if dir == "" {
		dir = filepath.Join("/run/user", strconv.Itoa(os.Getuid()))
	}
	return filepath.Join(dir, "herdr-world", "askpass.sock")
}

// Request is the helper's only message to the broker.
type Request struct {
	Process string `json:"process"`
	Nonce   string `json:"nonce"`
	Prompt  string `json:"prompt"`
}
type Response struct {
	Secret []byte `json:"secret,omitempty"`
	OK     bool   `json:"ok"`
}

func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'" }

// Env writes a private nonce and the fixed helper script for a process.
func Env(dir, id string) ([]string, error) {
	if filepath.Base(filepath.Clean(dir)) != id || !strings.HasPrefix(id, "mp_") {
		return nil, errors.New("invalid manual process directory")
	}
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	var n [32]byte
	if _, err = rand.Read(n[:]); err != nil {
		return nil, err
	}
	noncePath := filepath.Join(dir, "nonce")
	f, err := os.OpenFile(noncePath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return nil, err
	}
	if err = f.Chmod(0600); err != nil {
		_ = f.Close()
		return nil, err
	}
	_, err = f.Write([]byte(hex.EncodeToString(n[:])))
	closeErr := f.Close()
	if err != nil {
		return nil, err
	}
	if closeErr != nil {
		return nil, closeErr
	}

	script := "#!/bin/sh\nexec " + shellQuote(executable) + " manual-askpass " + shellQuote(dir) + " \"$@\"\n"
	path := filepath.Join(dir, "askpass")
	if err = os.WriteFile(path, []byte(script), 0700); err != nil {
		return nil, err
	}
	if err = os.Chmod(path, 0700); err != nil {
		return nil, err
	}
	return []string{"SUDO_ASKPASS=" + path}, nil
}

// Helper exchanges one prompt for a secret, emitting only the secret on stdout.
func Helper(dir, prompt string, out io.Writer) error {
	nonce, err := os.ReadFile(filepath.Join(dir, "nonce"))
	if err != nil {
		return errors.New("askpass unavailable")
	}
	conn, err := net.DialTimeout("unix", SocketPath(), 5*time.Second)
	if err != nil {
		return errors.New("askpass unavailable")
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(Timeout + 5*time.Second))
	if err := json.NewEncoder(conn).Encode(Request{Process: filepath.Base(filepath.Clean(dir)), Nonce: string(nonce), Prompt: prompt}); err != nil {
		return errors.New("askpass unavailable")
	}
	var response Response
	if err := json.NewDecoder(io.LimitReader(conn, 1<<20)).Decode(&response); err != nil || !response.OK {
		return errors.New("askpass cancelled")
	}
	defer clear(response.Secret)
	if _, err := out.Write(response.Secret); err != nil {
		return err
	}
	_, err = fmt.Fprintln(out)
	return err
}
