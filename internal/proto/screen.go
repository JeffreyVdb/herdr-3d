package proto

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"sync/atomic"
)

// M13 (#15) screen share: the TV shows the Mac's shared screen locally in the
// game; the bridge only knows whether a game is sharing, and fetches one
// frame when an agent asks (screen.grab). screen.state is an ordinary event
// (seq, replay ring) with the fields of ScreenState flat in it, and the
// snapshot carries the current one in World.Screen. docs/protocol.md
// "Screen share".

// EvScreenState carries whether a game is sharing its screen (the fields of
// ScreenState).
const EvScreenState = "screen.state"

// Connection messages (no seq, never replayed) to one game.
const (
	// TScreenFrameRequest asks the sharing game for the current frame
	// (ScreenFrameRequest). It answers with the JPEG on POST
	// /screen/frame/{req_id}, or with the screen.frame command when it
	// cannot.
	TScreenFrameRequest = "screen.frame_request"
	// TScreenGrabbed tells the sharing game that someone was given a frame
	// (ScreenGrabbed): it shows a toast.
	TScreenGrabbed = "screen.grabbed"
)

// Commands.
const (
	// CmdScreenShare is the game reporting that it shares (or stopped). A
	// game sends it after every (re)connect, sharing or not: that is what
	// makes it a client screen.grab can ask.
	CmdScreenShare = "screen.share"
	// CmdScreenFrame is the game's answer to a frame request it cannot
	// fulfil (ScreenFrameArgs.Error); the JPEG itself goes over HTTP.
	CmdScreenFrame = "screen.frame"
	// CmdScreenGrab asks for one frame of the shared screen (M14's
	// "look at my screen"); the ack carries the stored file's path.
	CmdScreenGrab = "screen.grab"
)

func init() { Commands = append(Commands, CmdScreenShare, CmdScreenFrame, CmdScreenGrab) }

// Error codes of screen.grab.
const (
	ErrNotSharing       = "not_sharing"       // a game is connected but shares nothing
	ErrNoClient         = "no_client"         // no game is connected (or the sharing one went away)
	ErrFrameTimeout     = "frame_timeout"     // the game sent no frame in time
	ErrFrameInvalid     = "frame_invalid"     // what it sent is not a valid JPEG
	ErrFrameTooLarge    = "frame_too_large"   // over the byte cap, or wider or taller than allowed
	ErrFrameUnavailable = "frame_unavailable" // the game could not take one (the source is paused, stopped meanwhile)
)

// Display surfaces a game shares (getDisplayMedia's displaySurface).
const (
	SurfaceBrowser = "browser" // a tab
	SurfaceWindow  = "window"
	SurfaceMonitor = "monitor" // a whole screen
)

// ScreenState is whether a connected game shares its screen, and what kind
// of surface (absent when not sharing, or unknown).
type ScreenState struct {
	Sharing bool   `json:"sharing"`
	Surface string `json:"surface,omitempty"`
}

// ScreenShareArgs are the args of screen.share.
type ScreenShareArgs struct {
	Sharing bool   `json:"sharing"`
	Surface string `json:"surface,omitempty"`
}

// ScreenFrameRequest asks the sharing game for one frame.
type ScreenFrameRequest struct {
	T     string `json:"t"`
	ReqID string `json:"req_id"`
}

// ScreenFrameArgs are the args of screen.frame: the frame request it answers
// and why there is no frame (a short code and a message for the log).
type ScreenFrameArgs struct {
	ReqID   string `json:"req_id"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

// ScreenGrabArgs are the args of screen.grab: the floor (session) and the
// name of the worker asking, as the toast and the audit log show them.
type ScreenGrabArgs struct {
	Floor     string `json:"floor"`
	Requester string `json:"requester"`
}

// ScreenGrabResult is the ack data of screen.grab: where the JPEG is (a
// 0600 file under the bridge's screen directory, removed TTL later), its
// size, and when it was taken.
type ScreenGrabResult struct {
	Path    string `json:"path"`
	Bytes   int    `json:"bytes"`
	W       int    `json:"w"`
	H       int    `json:"h"`
	Surface string `json:"surface,omitempty"`
	// At is when the frame arrived, unix ms; Expires when it is removed.
	At      int64 `json:"at"`
	Expires int64 `json:"expires"`
}

// ScreenGrabbed tells the sharing game who looked.
type ScreenGrabbed struct {
	T         string `json:"t"`
	Requester string `json:"requester"`
	Floor     string `json:"floor"`
	At        int64  `json:"at"`
}

// ScreenGrabError is a refused screen.grab: the protocol's error code (one
// of the Err… codes above, or bad_request, unknown_session, busy, internal)
// and its message.
type ScreenGrabError struct{ Code, Message string }

func (e *ScreenGrabError) Error() string { return e.Code + ": " + e.Message }

var grabSeq atomic.Uint64

// ScreenGrab sends screen.grab on a connection that said hello and waits for
// its answer, skipping the snapshot and events in between: what M14's
// office CLI calls (over the bridge socket, like herdr-world cmd). A refusal
// is a *ScreenGrabError.
func (c *Conn) ScreenGrab(ctx context.Context, a ScreenGrabArgs) (ScreenGrabResult, error) {
	args, err := json.Marshal(a)
	if err != nil {
		return ScreenGrabResult{}, err
	}
	id := "grab-" + strconv.FormatUint(grabSeq.Add(1), 10)
	if err := c.Send(ctx, Command{T: CmdScreenGrab, ReqID: id, Args: args}); err != nil {
		return ScreenGrabResult{}, err
	}
	for {
		env, b, err := c.Read(ctx)
		if err != nil {
			return ScreenGrabResult{}, err
		}
		if env.ReqID != id {
			continue
		}
		switch env.T {
		case TAck:
			var ack struct {
				Data ScreenGrabResult `json:"data"`
			}
			if err := json.Unmarshal(b, &ack); err != nil {
				return ScreenGrabResult{}, fmt.Errorf("bad screen.grab ack: %w", err)
			}
			return ack.Data, nil
		case TError:
			var e Error
			_ = json.Unmarshal(b, &e)
			return ScreenGrabResult{}, &ScreenGrabError{Code: e.Code, Message: e.Message}
		}
	}
}
