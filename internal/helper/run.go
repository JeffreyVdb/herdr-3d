package helper

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"sync"
	"time"
)

// Config is one helper run.
type Config struct {
	Listen string // loopback ip:port for the game
	Tunnel *Tunnel
	Bundle string   // built game directory (ignored when Dev is set)
	Dev    *url.URL // Vite dev server to proxy instead of serving Bundle
	// Open, if set, opens the game URL (with its token) once serving.
	Open  func(ctx context.Context, url string) error
	Token string // default NewToken()
	Log   *slog.Logger
	// Ready, if set, is called with the game URL once serving.
	Ready func(url string)
}

// ListenLoopback listens on addr, which must be a loopback IP and port.
func ListenLoopback(addr string) (net.Listener, error) {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, fmt.Errorf("listen address %q: %w", addr, err)
	}
	ip, err := netip.ParseAddr(host)
	if err != nil || !ip.IsLoopback() {
		return nil, fmt.Errorf("refusing to listen on %q: the helper only binds a loopback IP such as 127.0.0.1", addr)
	}
	return net.Listen("tcp", addr)
}

// Run serves the game and supervises the tunnel until ctx is done; on the
// way out it stops serving and kills ssh.
func Run(ctx context.Context, cfg Config) error {
	log := cfg.Log
	if log == nil {
		log = slog.Default()
	}
	ln, err := ListenLoopback(cfg.Listen)
	if err != nil {
		return err
	}
	addr := ln.Addr().(*net.TCPAddr)
	token := cfg.Token
	if token == "" {
		token = NewToken()
	}
	cfg.Tunnel.Log = log
	srv := NewServer(ServerConfig{
		Port: addr.Port, ListenHost: addr.IP.String(), Token: token, Bridge: cfg.Tunnel,
		Bundle: cfg.Bundle, Dev: cfg.Dev, Log: log,
	})
	hs := &http.Server{Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	wg.Add(2)
	go func() {
		defer wg.Done()
		if err := cfg.Tunnel.Run(ctx); err != nil {
			errs <- fmt.Errorf("tunnel: %w", err)
		}
		cancel()
	}()
	go func() {
		defer wg.Done()
		if err := hs.Serve(ln); !errors.Is(err, http.ErrServerClosed) {
			errs <- fmt.Errorf("http: %w", err)
		}
		cancel()
	}()

	base := "http://" + addr.String()
	game := base + "/#token=" + token
	src := cfg.Bundle
	if cfg.Dev != nil {
		src = "dev " + cfg.Dev.String()
	}
	log.Info("h3d-helper serving", "url", base, "game", src, "bridge", cfg.Tunnel.Host+":"+cfg.Tunnel.Remote)
	if cfg.Ready != nil {
		cfg.Ready(game)
	}
	if cfg.Open != nil {
		if err := cfg.Open(ctx, game); err != nil {
			log.Error("opening the game window failed", "err", err)
		}
	} else {
		log.Info("open the game in a browser on this machine", "url", game)
	}

	<-ctx.Done()
	log.Info("h3d-helper shutting down")
	sctx, scancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer scancel()
	_ = hs.Shutdown(sctx) // WebSockets are hijacked: they end with the tunnel
	wg.Wait()
	close(errs)
	var all []error
	for err := range errs {
		all = append(all, err)
	}
	return errors.Join(all...)
}
