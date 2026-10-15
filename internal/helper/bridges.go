package helper

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"
)

// #57: the helper keeps a list of named bridges and tunnels to the one in use.
// The list lives in a 0600 JSON file next to the helper token (it names the
// machines the helper may reach, so it is the helper's, not a browser's or a
// bridge's) and is edited through /api/bridges.

// Bridge kinds.
const (
	KindSSH   = "ssh"   // ssh -N -L to a bridge socket on another host
	KindLocal = "local" // a bridge socket on this machine, dialled directly
)

// maxBridgeName is the longest name, in characters.
const maxBridgeName = 40

// BridgeEntry is one bridge the helper can tunnel to. ID is random and never
// changes; Name is what the game shows and can be renamed.
type BridgeEntry struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Kind string `json:"kind"`
	// ssh: the destination, [user@]host, and the bridge socket on it (empty:
	// asked over ssh, $XDG_RUNTIME_DIR/herdr-world/bridge.sock).
	Host         string `json:"host,omitempty"`
	RemoteSocket string `json:"remote_socket,omitempty"`
	// local: the bridge socket on this machine.
	Socket string `json:"socket,omitempty"`
}

// Address is how the entry reaches its bridge, for logs and the list.
func (e BridgeEntry) Address() string {
	if e.Kind == KindLocal {
		return e.Socket
	}
	if e.RemoteSocket != "" {
		return e.Host + ":" + e.RemoteSocket
	}
	return e.Host
}

// sameTarget reports whether two entries reach the same bridge the same way.
func (e BridgeEntry) sameTarget(o BridgeEntry) bool {
	return e.Kind == o.Kind && e.Host == o.Host && e.RemoteSocket == o.RemoteSocket && e.Socket == o.Socket
}

// BridgeList is the file's content: the entries in the order they were added
// and the id of the one in use ("" only when there are none).
type BridgeList struct {
	Active  string        `json:"active"`
	Bridges []BridgeEntry `json:"bridges"`
}

func (l BridgeList) find(id string) int {
	for i, e := range l.Bridges {
		if e.ID == id {
			return i
		}
	}
	return -1
}

// NewBridgeID is a random id: 10 hex digits, short because it is part of the
// tunnel's local socket path (MaxSocketPath).
func NewBridgeID() string {
	b := make([]byte, 5)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func validBridgeID(id string) bool {
	if len(id) != 10 {
		return false
	}
	_, err := hex.DecodeString(id)
	return err == nil && strings.ToLower(id) == id
}

// CheckSSHHost is the rule for an ssh destination: not empty, not something
// ssh would read as an option, no whitespace or control characters.
func CheckSSHHost(h string) error {
	switch {
	case h == "":
		return errors.New("host is empty: want [user@]host")
	case strings.HasPrefix(h, "-"):
		return fmt.Errorf("host %q starts with '-': want [user@]host", h)
	case strings.IndexFunc(h, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) >= 0:
		return fmt.Errorf("host %q has whitespace: want [user@]host", h)
	}
	return nil
}

// checkSocketPath is the rule for a bridge socket path: absolute, clean, no
// whitespace or control characters; local ones (dialled here) also fit a
// unix socket address.
func checkSocketPath(what, p string, local bool) error {
	switch {
	case !path.IsAbs(p):
		return fmt.Errorf("%s %q is not an absolute path (it starts with /)", what, p)
	case path.Clean(p) != p:
		return fmt.Errorf("%s %q is not a clean path (no //, . or .., no trailing /)", what, p)
	case strings.IndexFunc(p, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) >= 0:
		return fmt.Errorf("%s %q has whitespace", what, p)
	case local && len(p) > MaxSocketPath:
		return fmt.Errorf("%s is %d bytes, unix sockets allow %d: pick a shorter path", what, len(p), MaxSocketPath)
	}
	return nil
}

// cleanName trims a name and checks it: 1-40 characters, printable.
func cleanName(n string) (string, error) {
	n = strings.TrimSpace(n)
	switch {
	case n == "":
		return "", errors.New("name is empty")
	case !utf8.ValidString(n):
		return "", errors.New("name is not valid UTF-8")
	case utf8.RuneCountInString(n) > maxBridgeName:
		return "", fmt.Errorf("name is longer than %d characters", maxBridgeName)
	case strings.IndexFunc(n, unicode.IsControl) >= 0:
		return "", errors.New("name has control characters")
	}
	return n, nil
}

// CheckBridgeEntry cleans e (trims the name) and says what is wrong with it,
// in words the Settings form shows as they are.
func CheckBridgeEntry(e BridgeEntry) (BridgeEntry, error) {
	name, err := cleanName(e.Name)
	if err != nil {
		return e, err
	}
	e.Name = name
	switch e.Kind {
	case KindSSH:
		if e.Socket != "" {
			return e, errors.New("an ssh bridge has a host and an optional remote socket, not a local socket")
		}
		if err := CheckSSHHost(e.Host); err != nil {
			return e, err
		}
		if e.RemoteSocket != "" {
			if err := checkSocketPath("remote socket", e.RemoteSocket, false); err != nil {
				return e, err
			}
		}
	case KindLocal:
		if e.Host != "" || e.RemoteSocket != "" {
			return e, errors.New("a local bridge has a socket path only, no host")
		}
		if e.Socket == "" {
			return e, errors.New("socket is empty: want the bridge's socket path, e.g. /run/user/1000/herdr-world/bridge.sock")
		}
		if err := checkSocketPath("socket", e.Socket, true); err != nil {
			return e, err
		}
	default:
		return e, fmt.Errorf("kind %q: want %q or %q", e.Kind, KindSSH, KindLocal)
	}
	return e, nil
}

// checkList is the file's invariants: valid entries with distinct ids and
// names, and an active entry whenever there is one at all.
func checkList(l BridgeList) error {
	ids, names := map[string]bool{}, map[string]bool{}
	for _, e := range l.Bridges {
		if !validBridgeID(e.ID) {
			return fmt.Errorf("bridge id %q: want 10 lowercase hex digits", e.ID)
		}
		c, err := CheckBridgeEntry(e)
		if err != nil {
			return fmt.Errorf("bridge %s: %w", e.ID, err)
		}
		if c.Name != e.Name {
			return fmt.Errorf("bridge %s: name %q has surrounding spaces", e.ID, e.Name)
		}
		if ids[e.ID] {
			return fmt.Errorf("bridge id %s appears twice", e.ID)
		}
		if names[strings.ToLower(e.Name)] {
			return fmt.Errorf("bridge name %q appears twice", e.Name)
		}
		ids[e.ID], names[strings.ToLower(e.Name)] = true, true
	}
	switch {
	case len(l.Bridges) == 0 && l.Active != "":
		return fmt.Errorf("active bridge %s but no bridges", l.Active)
	case len(l.Bridges) > 0 && !ids[l.Active]:
		return fmt.Errorf("active bridge %q is not in the list", l.Active)
	}
	return nil
}

// LoadBridgeList reads the list file. A missing file is no error: ok is false.
func LoadBridgeList(file string) (l BridgeList, ok bool, err error) {
	b, err := os.ReadFile(file)
	if errors.Is(err, fs.ErrNotExist) {
		return BridgeList{}, false, nil
	}
	if err != nil {
		return BridgeList{}, false, err
	}
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&l); err != nil {
		return BridgeList{}, false, fmt.Errorf("bridge list %s: %w", file, err)
	}
	if err := checkList(l); err != nil {
		return BridgeList{}, false, fmt.Errorf("bridge list %s: %w (fix or remove the file)", file, err)
	}
	if l.Bridges == nil {
		l.Bridges = []BridgeEntry{}
	}
	return l, true, nil
}

// SaveBridgeList writes the list file atomically, mode 0600 in a 0700
// directory (it names the machines the helper reaches).
func SaveBridgeList(file string, l BridgeList) error {
	if err := checkList(l); err != nil {
		return err
	}
	if l.Bridges == nil {
		l.Bridges = []BridgeEntry{}
	}
	b, err := json.MarshalIndent(l, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(file), ".bridges-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(append(b, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), file); err != nil {
		return fmt.Errorf("saving the bridge list: %w", err)
	}
	return nil
}

// SeedBridgeList is the list a helper starts with. A list file that exists is
// the truth: what -host names is used only when there is no file yet (an
// install from before #57 comes up as it was, on its one host, named after
// it, in use), or when it is empty. changed says the list must be saved.
func SeedBridgeList(l BridgeList, exists bool, host, remote string) (out BridgeList, changed bool) {
	if (exists && len(l.Bridges) > 0) || host == "" {
		return l, false
	}
	name := host
	if utf8.RuneCountInString(name) > maxBridgeName {
		name = string([]rune(name)[:maxBridgeName])
	}
	e := BridgeEntry{ID: NewBridgeID(), Name: name, Kind: KindSSH, Host: host, RemoteSocket: remote}
	return BridgeList{Active: e.ID, Bridges: []BridgeEntry{e}}, true
}
