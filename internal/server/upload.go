package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/upload"
)

// Images for the agents' prompts (#51, #13). One image in, one Drop Zone path
// out: POST /upload, like the logos over HTTP and not a WebSocket command
// (a message is capped at 256 KiB, an image at 25 MiB). The route sits on the
// bridge's socket; h3d-helper proxies it behind its token check.
// docs/protocol.md "Image upload".

const (
	uploadReadTimeout = upload.DefaultTimeout + 5*time.Second // a body that stalls is cut off, so its reader lets go
	uploadClient      = "http"
	maxUploadLabel    = 256 // bytes of the label hint that are looked at; the rest is not an error
)

// Uploader stores one image and says where (upload.Service).
type Uploader interface {
	Upload(ctx context.Context, m upload.Meta, src io.Reader) (upload.Result, error)
}

// SetUploader gives the server the door to Drop Zone (nil: POST /upload
// answers dropzone_unavailable). Call it before Serve.
func (s *Server) SetUploader(u Uploader) { s.up = u }

func (s *Server) uploadRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /upload", s.postUpload)
}

// uploadStatus is the HTTP status of an upload's error code.
func uploadStatus(code string) int {
	switch code {
	case upload.CodeBadRequest:
		return http.StatusBadRequest
	case upload.CodeTooLarge:
		return http.StatusRequestEntityTooLarge
	case upload.CodeUnsupported:
		return http.StatusUnsupportedMediaType
	case upload.CodeBusy:
		return http.StatusTooManyRequests
	case upload.CodeTimeout:
		return http.StatusGatewayTimeout
	case upload.CodeUnavailable, upload.CodeBadResponse:
		return http.StatusBadGateway
	}
	return http.StatusInternalServerError
}

func (s *Server) postUpload(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	label := q.Get("label")
	if len(label) > maxUploadLabel {
		label = label[:maxUploadLabel]
	}
	n, err := strconv.Atoi(q.Get("n"))
	m := upload.Meta{Label: label, N: n}
	if err != nil || n < 1 {
		s.uploadDone(w, r, m, upload.Result{}, upload.ErrBadRequest)
		return
	}
	if s.up == nil {
		s.uploadDone(w, r, m, upload.Result{}, &upload.Error{Code: upload.CodeUnavailable, Message: "image upload is not set up on this bridge"})
		return
	}
	if r.ContentLength > upload.MaxBytes {
		s.uploadDone(w, r, m, upload.Result{}, upload.ErrTooLarge)
		return
	}
	// A body that stalls is cut off by its read deadline: that is what frees
	// the goroutine that is reading it.
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(uploadReadTimeout))
	// The cap is on the bytes that arrive, never on Content-Length (which may
	// be absent or wrong): a byte over is an error, never a cut-off image.
	res, err := s.up.Upload(r.Context(), m, http.MaxBytesReader(w, r.Body, upload.MaxBytes))
	s.uploadDone(w, r, m, res, err)
}

// uploadDone answers, audits and logs. Only the label, the number, the size,
// the type and the outcome are recorded: never the image, and not the path.
func (s *Server) uploadDone(w http.ResponseWriter, r *http.Request, m upload.Meta, res upload.Result, err error) {
	if err == nil {
		s.uploadAudit(r, m, res, nil)
		s.log.Info("image uploaded", "label", m.Label, "n", m.N, "size", res.Size, "mime", res.Mime)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(proto.Ack{T: proto.TAck, Data: map[string]any{"path": res.Path, "mime": res.Mime, "size": res.Size}})
		return
	}
	var ue *upload.Error
	if cerr := r.Context().Err(); cerr != nil && errors.Is(err, cerr) {
		// The client went away (or shut its side): the answer may reach nobody.
		s.log.Info("image upload abandoned", "label", m.Label, "n", m.N)
		err = &upload.Error{Code: upload.CodeBadRequest, Message: "the upload was cut off"}
	}
	if !errors.As(err, &ue) {
		s.log.Error("image upload failed", "label", m.Label, "n", m.N, "err", err)
		ue = &upload.Error{Code: proto.ErrInternal, Message: "internal error"}
	} else if ue.Code == upload.CodeUnavailable || ue.Code == upload.CodeBadResponse || ue.Code == upload.CodeTimeout {
		s.log.Warn("image upload failed", "label", m.Label, "n", m.N, "code", ue.Code, "cause", ue.Unwrap()) // for the operator: never in the answer
	} else {
		s.log.Info("image upload refused", "label", m.Label, "n", m.N, "code", ue.Code)
	}
	s.uploadAudit(r, m, res, ue)
	if ue.Code == upload.CodeBusy {
		w.Header().Set("Retry-After", "5")
	}
	logoError(w, uploadStatus(ue.Code), ue.Code, ue.Message)
}

func (s *Server) uploadAudit(r *http.Request, m upload.Meta, res upload.Result, err error) {
	args, _ := json.Marshal(map[string]any{"label": m.Label, "n": m.N, "size": res.Size, "mime": res.Mime})
	// The request may be the reason we are here: audit on its own clock.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Second)
	defer cancel()
	if aerr := s.hub.st.Audit(ctx, uploadClient, "image.upload", args, err); aerr != nil {
		s.log.Error("audit log write failed", "err", aerr)
	}
}
