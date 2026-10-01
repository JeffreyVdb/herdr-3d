// Package server is herdr-world's hub (the world model and event log) and
// its WebSocket front end. The only transport is a private unix socket; it
// never listens on TCP.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"slices"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/JeffreyVdb/herdr-3d/internal/logo"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/version"
)

// Timeouts for one connection.
const (
	helloTimeout = 10 * time.Second
	writeTimeout = 10 * time.Second
	// A comment or pull request body is up to 64 KiB of text, escaped in JSON.
	maxClientMsg = 256 << 10
)

var errShutdown = errors.New("server shutting down")

// Server serves the protocol over WebSocket.
type Server struct {
	hub  *Hub
	log  *slog.Logger
	conv *logo.Converter // M3d: logo uploads
	up   Uploader        // #51: images for prompts (nil: none)
	// M13: drops' thumbnails are decoded two at a time.
	dropThumbs chan struct{}

	mu    sync.Mutex
	conns map[*websocket.Conn]context.CancelFunc // cancelling a conn's reads closes it at once
	wg    sync.WaitGroup
}

// NewServer returns a server for hub.
func NewServer(hub *Hub, log *slog.Logger) *Server {
	return &Server{hub: hub, log: log, conv: logo.NewConverter(0, 0), dropThumbs: make(chan struct{}, 2), conns: map[*websocket.Conn]context.CancelFunc{}}
}

// SetLogoRenderTimeout sets how long an SVG upload may take to draw before the
// render worker is killed (default logo.DefaultRenderTimeout). Call it before
// Serve.
func (s *Server) SetLogoRenderTimeout(d time.Duration) { s.conv.SetRenderTimeout(d) }

// Handler serves /ws (the protocol), /logo/{building} (M3d), POST /upload (#51),
// POST /screen/frame/{req_id}, /whiteboard/{floor}/… and /drops/file (M13) and
// /healthz.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /ws", s.serveWS)
	s.logoRoutes(mux)
	s.uploadRoutes(mux)
	s.screenRoutes(mux)     // M13 screen
	s.whiteboardRoutes(mux) // M13 whiteboard
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set(proto.VersionHeader, version.Version)
		_, _ = w.Write([]byte("ok\n"))
	})
	return mux
}

// Serve serves on ln until ctx is done, then closes every client with
// "going away" and returns. Closing the listener removes the socket file.
func (s *Server) Serve(ctx context.Context, ln *net.UnixListener) error {
	srv := &http.Server{Handler: s.Handler(), ReadHeaderTimeout: 10 * time.Second}
	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(ln) }()
	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	s.eachConn(func(c *websocket.Conn, _ context.CancelFunc) {
		go c.Close(websocket.StatusGoingAway, errShutdown.Error())
	})
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := srv.Shutdown(shutdownCtx) // closes ln (removing the socket); hijacked conns are ours
	done := make(chan struct{})
	go func() { s.wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		// Peers that do not answer the close handshake are cut off.
		s.log.Warn("websocket clients did not close in time")
		s.eachConn(func(_ *websocket.Conn, cancel context.CancelFunc) { cancel() })
		<-done
	}
	if errors.Is(err, http.ErrServerClosed) {
		err = nil
	}
	return err
}

func (s *Server) eachConn(fn func(*websocket.Conn, context.CancelFunc)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for c, cancel := range s.conns {
		fn(c, cancel)
	}
}

func (s *Server) serveWS(w http.ResponseWriter, r *http.Request) {
	ws, err := websocket.Accept(w, r, nil)
	if err != nil {
		s.log.Debug("websocket accept failed", "err", err)
		return
	}
	ws.SetReadLimit(maxClientMsg)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	s.wg.Add(1)
	defer s.wg.Done()
	s.mu.Lock()
	s.conns[ws] = cancel
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.conns, ws)
		s.mu.Unlock()
		ws.CloseNow()
	}()
	hello, ok := s.readHello(ctx, ws)
	if !ok {
		return
	}
	var kickOnce sync.Once
	c := s.hub.NewClient(hello.Client, func(reason error) {
		kickOnce.Do(func() {
			// Close concurrently with a blocked writer; the status reaches
			// the peer if it reads at all.
			go ws.Close(websocket.StatusPolicyViolation, reason.Error())
		})
	})
	if err := s.hub.Join(ctx, c, hello); err != nil {
		ws.Close(websocket.StatusGoingAway, err.Error())
		return
	}
	defer s.hub.Leave(c)
	s.log.Info("client connected", "client", hello.Client)
	defer s.log.Info("client disconnected", "client", hello.Client)

	go func() {
		defer cancel()
		for {
			select {
			case <-ctx.Done():
				return
			case msg := <-c.Send():
				wctx, wcancel := context.WithTimeout(ctx, writeTimeout)
				err := ws.Write(wctx, websocket.MessageText, msg)
				wcancel()
				if err != nil {
					return
				}
			}
		}
	}()
	s.readLoop(ctx, ws, c)
}

func (s *Server) readHello(ctx context.Context, ws *websocket.Conn) (proto.Hello, bool) {
	hctx, cancel := context.WithTimeout(ctx, helloTimeout)
	defer cancel()
	_, data, err := ws.Read(hctx)
	if err != nil {
		return proto.Hello{}, false
	}
	var hello proto.Hello
	if json.Unmarshal(data, &hello) != nil || hello.T != proto.THello {
		s.reject(ctx, ws, "", proto.ErrHelloRequired, "the first message must be hello")
		return proto.Hello{}, false
	}
	if hello.Proto != proto.Version {
		s.reject(ctx, ws, "", proto.ErrUnsupportedProto, "this bridge speaks proto 1")
		return proto.Hello{}, false
	}
	if hello.Client == "" {
		hello.Client = "anonymous"
	}
	return hello, true
}

// reject sends one error and closes the connection.
func (s *Server) reject(ctx context.Context, ws *websocket.Conn, reqID, code, msg string) {
	wctx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	_ = ws.Write(wctx, websocket.MessageText, mustJSON(proto.Error{T: proto.TError, ReqID: reqID, Code: code, Message: msg}))
	ws.Close(websocket.StatusPolicyViolation, code)
}

func (s *Server) readLoop(ctx context.Context, ws *websocket.Conn, c *Client) {
	for {
		_, data, err := ws.Read(ctx)
		if err != nil {
			return
		}
		var cmd proto.Command
		if err := json.Unmarshal(data, &cmd); err != nil {
			s.replyErr(c, "", proto.ErrBadRequest, "message is not a JSON object with a t field")
			continue
		}
		switch {
		case cmd.T == proto.THello:
			s.replyErr(c, cmd.ReqID, proto.ErrBadRequest, "hello was already sent")
		case !slices.Contains(proto.Commands, cmd.T):
			s.log.Info("unknown command rejected", "client", c.name, "cmd", cmd.T)
			s.replyErr(c, cmd.ReqID, proto.ErrUnknownCommand, "unknown command "+`"`+cmd.T+`"`)
		default: // the hub audits it, also when it has no req_id
			if err := s.hub.Command(ctx, c, cmd); err != nil {
				return
			}
		}
	}
}

// replyErr queues an error to c, kicking it if its queue is full.
func (s *Server) replyErr(c *Client, reqID, code, msg string) {
	select {
	case c.send <- mustJSON(proto.Error{T: proto.TError, ReqID: reqID, Code: code, Message: msg}):
	default:
		c.kick(ErrSlowConsumer)
	}
}
