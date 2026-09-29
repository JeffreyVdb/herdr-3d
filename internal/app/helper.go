package app

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"syscall"

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
)

// Helper defaults.
const (
	DefaultHelperHost   = "dev@devbox"
	DefaultRemoteSocket = "/run/user/1000/herdr-world/bridge.sock"
	DefaultHelperListen = "127.0.0.1:7777"
)

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
	host := fs.String("host", envOr(EnvHelperHost, DefaultHelperHost), "ssh destination running the bridge ($"+EnvHelperHost+")")
	remote := fs.String("remote-socket", envOr(EnvHelperRemoteSocket, DefaultRemoteSocket), "bridge socket on the host ($"+EnvHelperRemoteSocket+")")
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
		Tunnel:   &helper.Tunnel{SSH: *sshBin, Host: *host, Remote: *remote, Local: *local},
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
	if _, err := os.Stat(*musicDir); err != nil {
		log.Info("no music folder: the radio is silent (h3d-update --music fills it)", "dir", *musicDir)
	}
	log.Info("h3d-helper starting", "version", Banner(name))
	return helper.Run(ctx, cfg)
}
