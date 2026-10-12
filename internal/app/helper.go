package app

import (
	"bytes"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path"
	"path/filepath"
	"runtime"
	"slices"
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
	EnvHelperMusicDir      = "H3D_HELPER_MUSIC_DIR"
	EnvHelperSSH           = "H3D_HELPER_SSH"
	EnvHelperLogLevel      = "H3D_HELPER_LOG_LEVEL"
	EnvHelperLogFormat     = "H3D_HELPER_LOG_FORMAT"
	// EnvHelperConfig overrides where the deprecated private config file lives (HelperConfigPath).
	EnvHelperConfig = "H3D_HELPER_CONFIG"
)

// DefaultHelperListen is where the helper serves the game. There is no default
// bridge host: the helper never guesses a machine (see resolveHelperTarget).
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

// DefaultLocalSocket is the local end of the tunnel.
func DefaultLocalSocket() string {
	return filepath.Join(helperDir(os.UserCacheDir, ".cache"), "bridge.sock")
}

// DefaultBundle is where an installed game bundle lives.
func DefaultBundle() string { return filepath.Join(helperDir(os.UserConfigDir, ".config"), "dist") }

// DefaultTokenFile is where the helper keeps its token between runs.
func DefaultTokenFile() string { return filepath.Join(helperDir(os.UserConfigDir, ".config"), "token") }

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
	sourceFlag   = "flag"
	sourceEnv    = "env"
	sourceConfig = "config file"
)

// HelperConfigPath is the private helper config file: KEY=VALUE lines, # comments,
// at <UserConfigDir>/h3d-helper/helper.env (macOS: ~/Library/Application
// Support/h3d-helper/helper.env), or $H3D_HELPER_CONFIG.
//
// Deprecated: a fallback so a release does not depend on reconfiguring the
// installed Mac first; the flag, the environment (the LaunchAgent's
// EnvironmentVariables) win over it. Removed with the cutover, issue #253.
func HelperConfigPath() string {
	return envOr(EnvHelperConfig, filepath.Join(helperDir(os.UserConfigDir, ".config"), "helper.env"))
}

// helperConfigKeys are the settings read from the config file; every other line is ignored.
var helperConfigKeys = []string{EnvHelperHost, EnvHelperRemoteSocket}

// parseHelperConfig parses KEY=VALUE lines (an optional `export `, blank lines
// and # comments are skipped; a value may be single- or double-quoted, an
// unquoted one ends at " #"). Only helperConfigKeys are kept.
func parseHelperConfig(file string, data []byte) (map[string]string, error) {
	out := map[string]string{}
	for i, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "\ufeff"))
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimSpace(strings.TrimPrefix(line, "export "))
		key, val, ok := strings.Cut(line, "=")
		key = strings.TrimSpace(key)
		if !ok || key == "" {
			return nil, fmt.Errorf("%s:%d: want KEY=VALUE, got %q", file, i+1, line)
		}
		val = strings.TrimSpace(val)
		if n := len(val); n >= 2 && (val[0] == '"' || val[0] == '\'') && val[n-1] == val[0] {
			val = val[1 : n-1]
		} else if j := strings.Index(val, " #"); j >= 0 {
			val = strings.TrimSpace(val[:j])
		}
		if slices.Contains(helperConfigKeys, key) {
			out[key] = val
		}
	}
	return out, nil
}

// loadHelperConfig reads HelperConfigPath; a missing file is an empty config.
func loadHelperConfig() (map[string]string, string, error) {
	file := HelperConfigPath()
	data, err := os.ReadFile(file)
	if errors.Is(err, os.ErrNotExist) {
		return map[string]string{}, file, nil
	}
	if err != nil {
		return nil, file, fmt.Errorf("helper config file: %w", err)
	}
	cfg, err := parseHelperConfig(file, data)
	return cfg, file, err
}

// helperTarget is the bridge the helper tunnels to. Remote is empty when
// nothing named it: discoverRemoteSocket asks the host.
type helperTarget struct {
	Host, Remote             string
	HostSource, RemoteSource string
	ConfigPath               string
}

// resolveHelperTarget picks the host and the remote socket: flag, then the
// H3D_HELPER_* environment, then the deprecated private config file (#253).
// There is no built-in machine: a missing host is an error naming all three.
func resolveHelperTarget(flagHost, flagRemote string) (helperTarget, error) {
	cfg, file, err := loadHelperConfig()
	if err != nil {
		return helperTarget{}, err
	}
	pick := func(flagVal, key string) (val, source string) {
		switch {
		case flagVal != "":
			return flagVal, sourceFlag
		case os.Getenv(key) != "":
			return os.Getenv(key), sourceEnv
		case cfg[key] != "":
			return cfg[key], sourceConfig
		}
		return "", ""
	}
	t := helperTarget{ConfigPath: file}
	t.Host, t.HostSource = pick(flagHost, EnvHelperHost)
	t.Remote, t.RemoteSource = pick(flagRemote, EnvHelperRemoteSocket)
	if t.Host == "" {
		return t, fmt.Errorf("no bridge host: pass -host [user@]host, set $%s, or put %s=[user@]host in %s (deprecated fallback)",
			EnvHelperHost, EnvHelperHost, file)
	}
	if strings.HasPrefix(t.Host, "-") || strings.ContainsAny(t.Host, " \t\r\n") {
		return t, fmt.Errorf("bridge host %q (%s): want [user@]host", t.Host, t.HostSource)
	}
	return t, nil
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
	hint := "; pass -remote-socket or set $" + EnvHelperRemoteSocket
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
	host := fs.String("host", "", "ssh destination running the bridge, [user@]host; required ($"+EnvHelperHost+", else the deprecated config file "+HelperConfigPath()+")")
	remote := fs.String("remote-socket", "", "bridge socket on the host; default: $XDG_RUNTIME_DIR/herdr-world/bridge.sock as the host reports it over ssh ($"+EnvHelperRemoteSocket+", else the deprecated config file)")
	local := fs.String("local-socket", envOr(EnvHelperLocalSocket, DefaultLocalSocket()), "local end of the tunnel ($"+EnvHelperLocalSocket+")")
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
	cfg := helper.Config{
		Token:    token,
		MusicDir: *musicDir,
		Listen:   *listen,
		Tunnel:   &helper.Tunnel{SSH: *sshBin, Local: *local},
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
	target, err := resolveHelperTarget(*host, *remote)
	if err != nil {
		return err
	}
	for _, setting := range []struct{ key, source string }{{EnvHelperHost, target.HostSource}, {EnvHelperRemoteSocket, target.RemoteSource}} {
		if setting.source == sourceConfig {
			log.Warn("deprecated: "+setting.key+" read from the private helper config file; set it in the LaunchAgent's EnvironmentVariables or pass the flag (removed with the cutover, #253)", "file", target.ConfigPath)
		}
	}
	if target.Remote == "" {
		dctx, cancel := context.WithTimeout(ctx, discoverTimeout)
		target.Remote, err = discoverRemoteSocket(dctx, *sshBin, target.Host)
		cancel()
		if err != nil {
			return err
		}
		log.Info("bridge socket discovered on the host", "host", target.Host, "socket", target.Remote)
	}
	cfg.Tunnel.Host, cfg.Tunnel.Remote = target.Host, target.Remote
	if _, err := os.Stat(*musicDir); err != nil {
		log.Info("no music folder: the radio is silent (h3d-update --music fills it)", "dir", *musicDir)
	}
	log.Info("h3d-helper starting", "version", Banner(name))
	return helper.Run(ctx, cfg)
}
