package app

import (
	"bytes"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/helper"
	"github.com/JeffreyVdb/herdr-3d/internal/webdist"
)

// Environment variables mirroring the h3d-helper flags.
const (
	EnvHelperHost          = "H3D_HELPER_HOST"
	EnvHelperRemoteSocket  = "H3D_HELPER_REMOTE_SOCKET"
	EnvHelperLocalSocket   = "H3D_HELPER_LOCAL_SOCKET"
	EnvHelperListen        = "H3D_HELPER_LISTEN"
	EnvHelperBundle        = "H3D_HELPER_BUNDLE"
	EnvHelperDevUpstream   = "H3D_HELPER_DEV_UPSTREAM"
	EnvHelperNoOpen        = "H3D_HELPER_NO_OPEN"
	EnvHelperChrome        = "H3D_HELPER_CHROME"
	EnvHelperChromeProfile = "H3D_HELPER_CHROME_PROFILE"
	EnvHelperTokenFile     = "H3D_HELPER_TOKEN_FILE"
	EnvHelperBridgesFile   = "H3D_HELPER_BRIDGES_FILE"
	EnvHelperMusicDir      = "H3D_HELPER_MUSIC_DIR"
	EnvHelperSSH           = "H3D_HELPER_SSH"
	EnvHelperLogLevel      = "H3D_HELPER_LOG_LEVEL"
	EnvHelperLogFormat     = "H3D_HELPER_LOG_FORMAT"
)

// DefaultHelperListen is where the helper serves the game. There is no default
// bridge host: the helper never guesses a machine (see resolveHelperTarget and
// resolveBridgeList).
const DefaultHelperListen = "127.0.0.1:7777"

// helperDir is <base>/h3d-helper, base being os.UserCacheDir or
// os.UserConfigDir (macOS: ~/Library/Caches, ~/Library/Application Support).
func helperDir(base func() (string, error), fallback string) string {
	dir, err := base()
	if err != nil {
		home, _ := os.UserHomeDir()
		dir = filepath.Join(home, fallback)
	}
	return filepath.Join(dir, "h3d-helper")
}

// DefaultLocalSocket anchors the tunnels' local ends (#57): each ssh bridge's
// is <dir of it>/bridges/<id>-<n>.sock.
func DefaultLocalSocket() string {
	return filepath.Join(helperDir(os.UserCacheDir, ".cache"), "bridge.sock")
}

// tunnelSocketDir is where the tunnels' local ends go for a -local-socket.
func tunnelSocketDir(localSocket string) string {
	return filepath.Join(filepath.Dir(localSocket), "bridges")
}

// DefaultBundle is where an installed game bundle lives.
func DefaultBundle() string { return filepath.Join(helperDir(os.UserConfigDir, ".config"), "dist") }

// DefaultTokenFile is where the helper keeps its token between runs.
func DefaultTokenFile() string { return filepath.Join(helperDir(os.UserConfigDir, ".config"), "token") }

// DefaultBridgesFile is the helper's bridge list (#57), next to its token.
func DefaultBridgesFile() string {
	return filepath.Join(helperDir(os.UserConfigDir, ".config"), "bridges.json")
}

// DefaultMusicDir is where the radio's tracks live on the Mac (h3d-update --music
// fills it). No space in the path, so rsync can name it.
func DefaultMusicDir() string { return filepath.Join(helperDir(os.UserCacheDir, ".cache"), "music") }

// GameAppName is the installed Chrome web app's name (manifest.webmanifest).
const GameAppName = "herdr-3d"

// DefaultChromeProfile is the Chrome profile of the game window.
func DefaultChromeProfile() string {
	return filepath.Join(helperDir(os.UserConfigDir, ".config"), "chrome")
}

// Where a helper setting came from.
const (
	sourceFlag = "flag"
	sourceEnv  = "env"
)

// helperTarget is the bridge the helper tunnels to. Remote is empty when
// nothing named it: discoverRemoteSocket asks the host.
type helperTarget struct {
	Host, Remote             string
	HostSource, RemoteSource string
}

// resolveHelperTarget picks the host and the remote socket: the flag, then the
// H3D_HELPER_* environment (on the Mac, the LaunchAgent's EnvironmentVariables).
// There is no built-in machine: with neither, Host is empty (#57: the bridge
// list may name some, or the game says to add one).
func resolveHelperTarget(flagHost, flagRemote string) (helperTarget, error) {
	// An unfilled @PLACEHOLDER@ (a LaunchAgent plist installed without its sed) is not a value.
	set := func(v string) bool { return v != "" && !(strings.HasPrefix(v, "@") && strings.HasSuffix(v, "@")) }
	pick := func(flagVal, key string) (val, source string) {
		switch {
		case set(flagVal):
			return flagVal, sourceFlag
		case set(os.Getenv(key)):
			return os.Getenv(key), sourceEnv
		}
		return "", ""
	}
	var t helperTarget
	t.Host, t.HostSource = pick(flagHost, EnvHelperHost)
	t.Remote, t.RemoteSource = pick(flagRemote, EnvHelperRemoteSocket)
	if t.Host == "" {
		return t, nil
	}
	if err := helper.CheckSSHHost(t.Host); err != nil {
		return t, fmt.Errorf("bridge host %q (%s): want [user@]host", t.Host, t.HostSource)
	}
	return t, nil
}

// resolveBridgeList is the list the helper starts with (#57). The list file,
// once it exists, is the truth; -host / $H3D_HELPER_HOST (with
// -remote-socket) only seed it when it is missing or empty: an install from
// before #57 comes up on its one host, named after it, in use, and from then
// on Settings → Bridges edits the file. Neither: an empty list, and the game
// says to add a bridge.
func resolveBridgeList(file string, t helperTarget, log *slog.Logger) (helper.BridgeList, error) {
	l, exists, err := helper.LoadBridgeList(file)
	if err != nil {
		return l, err
	}
	l, changed := helper.SeedBridgeList(l, exists, t.Host, t.Remote)
	if changed {
		if _, err := helper.CheckBridgeEntry(l.Bridges[0]); err != nil {
			return l, fmt.Errorf("bridge %s (%s): %w", t.Host, t.HostSource, err)
		}
		if err := helper.SaveBridgeList(file, l); err != nil {
			return l, fmt.Errorf("bridge list %s: %w", file, err)
		}
		log.Info("bridge list created", "file", file, "bridge", t.Host, "from", t.HostSource)
		return l, nil
	}
	if t.Host != "" && !hasHost(l, t.Host) {
		log.Warn("the bridge list is used, the host is not: add it in Settings → Bridges", "file", file, "host", t.Host, "from", t.HostSource)
	}
	return l, nil
}

func hasHost(l helper.BridgeList, host string) bool {
	for _, e := range l.Bridges {
		if e.Kind == helper.KindSSH && e.Host == host {
			return true
		}
	}
	return false
}

const discoverTimeout = 20 * time.Second

// discoverRemoteSocket asks host for its $XDG_RUNTIME_DIR over ssh (the same
// no-multiplexing options as the tunnel) and returns
// $XDG_RUNTIME_DIR/herdr-world/bridge.sock, the bridge's default socket.
func discoverRemoteSocket(ctx context.Context, sshBin, host string) (string, error) {
	cmd := exec.CommandContext(ctx, sshBin,
		"-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
		host, `printf %s "$XDG_RUNTIME_DIR"`)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	hint := "; set the bridge's remote socket in Settings → Bridges (for the host the helper starts with: pass -remote-socket or set $" + EnvHelperRemoteSocket + ")"
	if err != nil {
		return "", fmt.Errorf("asking %s for its runtime dir over ssh: %w (%s)%s", host, err, strings.TrimSpace(stderr.String()), hint)
	}
	dir := strings.TrimSpace(string(out))
	if dir == "" || !path.IsAbs(dir) || strings.ContainsAny(dir, " \t\r\n") || path.Clean(dir) != dir {
		return "", fmt.Errorf("%s reported no usable $XDG_RUNTIME_DIR (got %q)%s", host, dir, hint)
	}
	return path.Join(dir, "herdr-world", "bridge.sock"), nil
}

func envBool(key string) (bool, error) {
	v := os.Getenv(key)
	if v == "" {
		return false, nil
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return false, fmt.Errorf("%s: %w", key, err)
	}
	return b, nil
}

// Helper is the entry point of h3d-helper. It returns the exit code.
func Helper(name string, args []string, stdout, stderr io.Writer) int {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	err := helperMain(ctx, name, args, stdout, stderr)
	var exit exitError
	switch {
	case err == nil, errors.Is(err, flag.ErrHelp):
		return 0
	case errors.As(err, &exit):
		return int(exit)
	default:
		fmt.Fprintf(stderr, "%s: %v\n", name, err)
		return 1
	}
}

func helperMain(ctx context.Context, name string, args []string, stdout, stderr io.Writer) error {
	noOpen, err := envBool(EnvHelperNoOpen)
	if err != nil {
		return err
	}
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(stderr)
	host := fs.String("host", "", "ssh destination running the bridge, [user@]host: the first entry of a new bridge list, ignored once the list exists ($"+EnvHelperHost+")")
	remote := fs.String("remote-socket", "", "bridge socket on -host; default: $XDG_RUNTIME_DIR/herdr-world/bridge.sock as the host reports it over ssh ($"+EnvHelperRemoteSocket+")")
	local := fs.String("local-socket", envOr(EnvHelperLocalSocket, DefaultLocalSocket()), "the tunnels' local ends go next to it, one per ssh bridge: <its dir>/bridges/<id>-<n>.sock ($"+EnvHelperLocalSocket+")")
	bridgesFile := fs.String("bridges-file", envOr(EnvHelperBridgesFile, DefaultBridgesFile()), "the bridge list Settings → Bridges edits (0600 JSON) ($"+EnvHelperBridgesFile+")")
	listen := fs.String("listen", envOr(EnvHelperListen, DefaultHelperListen), "loopback address serving the game ($"+EnvHelperListen+")")
	bundle := fs.String("bundle", os.Getenv(EnvHelperBundle), "serve this built game directory (a copy of game/dist) instead of the game embedded in the binary; default: the embedded game, else "+DefaultBundle()+" ($"+EnvHelperBundle+")")
	dev := fs.String("dev-upstream", os.Getenv(EnvHelperDevUpstream), "proxy the game from this Vite dev server instead, e.g. http://127.0.0.1:5173 ($"+EnvHelperDevUpstream+")")
	fs.BoolVar(&noOpen, "no-open", noOpen, "do not open a Chrome window ($"+EnvHelperNoOpen+")")
	chrome := fs.String("chrome", envOr(EnvHelperChrome, "Google Chrome"), "macOS application that opens the game window ($"+EnvHelperChrome+")")
	profile := fs.String("chrome-profile", envOr(EnvHelperChromeProfile, DefaultChromeProfile()), "Chrome --user-data-dir for the game window ($"+EnvHelperChromeProfile+")")
	sshBin := fs.String("ssh", envOr(EnvHelperSSH, "ssh"), "ssh executable ($"+EnvHelperSSH+")")
	level := fs.String("log-level", envOr(EnvHelperLogLevel, "info"), "debug, info, warn or error ($"+EnvHelperLogLevel+")")
	format := fs.String("log-format", envOr(EnvHelperLogFormat, "text"), "text or json ($"+EnvHelperLogFormat+")")
	tokenFile := fs.String("token-file", envOr(EnvHelperTokenFile, DefaultTokenFile()), "where the helper token is kept between runs; delete it to rotate ($"+EnvHelperTokenFile+")")
	musicDir := fs.String("music-dir", envOr(EnvHelperMusicDir, DefaultMusicDir()), "radio tracks served under /music/ (music/<genre>/<id>.ogg); missing is fine, the radio is then silent ($"+EnvHelperMusicDir+")")
	printURL := fs.Bool("print-url", false, "print the game URL with the token and exit (open it once in Chrome to install the app)")
	showVersion := fs.Bool("version", false, "print version and exit")
	if err := fs.Parse(args); err != nil {
		return usageError(err)
	}
	if *showVersion {
		fmt.Fprintln(stdout, Banner(name))
		return nil
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("%s takes no arguments, got %q", name, fs.Args())
	}
	log, err := newLogger(stderr, *level, *format)
	if err != nil {
		return err
	}
	token, err := helper.LoadToken(*tokenFile)
	if err != nil {
		return fmt.Errorf("token file %s: %w", *tokenFile, err)
	}
	if *printURL {
		fmt.Fprintf(stdout, "http://%s/#token=%s\n", *listen, token)
		return nil
	}
	target, err := resolveHelperTarget(*host, *remote)
	if err != nil {
		return err
	}
	cfg := helper.Config{
		Token:    token,
		MusicDir: *musicDir,
		Listen:   *listen,
		Log:      log,
	}
	if *dev != "" {
		u, err := url.Parse(*dev)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return fmt.Errorf("-dev-upstream: want an http(s)://host:port URL, got %q", *dev)
		}
		cfg.Dev = u
	} else {
		embedded, hasEmbedded := webdist.FS()
		switch {
		case *bundle != "":
			cfg.Bundle = *bundle
		case hasEmbedded:
			cfg.BundleFS = embedded
		default:
			cfg.Bundle = DefaultBundle()
		}
		if cfg.BundleFS == nil {
			if err := helper.CheckBundle(cfg.Bundle); err != nil {
				return err
			}
		}
	}
	if !noOpen {
		if runtime.GOOS != "darwin" {
			return errors.New("opening the game window needs macOS; pass -no-open")
		}
		home, _ := os.UserHomeDir()
		if app, ok := helper.InstalledApp(home, GameAppName); ok {
			// The installed app starts on its own and reconnects (the token survives restarts).
			cfg.Open = func(context.Context, string) error {
				log.Info("game app installed: not opening a window, launch it from the Dock", "app", app)
				return nil
			}
		} else {
			cfg.Open = func(ctx context.Context, u string) error { return helper.OpenChrome(ctx, *chrome, u, *profile) }
		}
	}
	list, err := resolveBridgeList(*bridgesFile, target, log)
	if err != nil {
		return err
	}
	if len(list.Bridges) == 0 {
		log.Warn("no bridge configured: the game asks to add one in Settings → Bridges", "file", *bridgesFile)
	}
	sshPath := *sshBin
	cfg.Bridges, err = helper.NewBridgeSet(helper.BridgeSetConfig{
		File: *bridgesFile, SSH: sshPath, SocketDir: tunnelSocketDir(*local), Log: log,
		// An ssh bridge with no remote socket asks its host, in its own supervisor.
		Discover: func(ctx context.Context, host string) (string, error) {
			dctx, cancel := context.WithTimeout(ctx, discoverTimeout)
			defer cancel()
			return discoverRemoteSocket(dctx, sshPath, host)
		},
	}, list)
	if err != nil {
		return fmt.Errorf("bridge list %s: %w", *bridgesFile, err)
	}
	if _, err := os.Stat(*musicDir); err != nil {
		log.Info("no music folder: the radio is silent (h3d-update --music fills it)", "dir", *musicDir)
	}
	log.Info("h3d-helper starting", "version", Banner(name))
	return helper.Run(ctx, cfg)
}
