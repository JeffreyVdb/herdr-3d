// Package upload forwards one image to Drop Zone and returns the path Drop
// Zone stored it at (#51, #13). It is pure Go with no globals: the caller
// hands it a reader, it streams the bytes as one multipart request and never
// holds the image in memory.
//
// Policy lives here, not in Drop Zone (which authenticates nothing, caps
// nothing and does not look at the bytes): the type is decided from the
// sniffed bytes (png, jpeg, gif, webp), at most MaxBytes are taken, and an
// image over the cap is aborted mid-request so that no valid multipart body
// ever reaches Drop Zone and nothing is stored. The path Drop Zone answers is
// used exactly as it came (Drop Zone picks the date folder and the collision
// suffix), or refused; it is never repaired.
package upload

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net"
	"net/http"
	"net/textproto"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// MaxBytes is the most one image may be (25 MiB), counted on the bytes read.
const MaxBytes = 25 << 20

// Defaults of a Service (Config's zero values).
const (
	DefaultTimeout       = 120 * time.Second // the whole upload, Drop Zone's answer included
	DefaultMaxConcurrent = 4
	dialTimeout          = 5 * time.Second
	headerTimeout        = 30 * time.Second // Drop Zone's answer after the last byte was sent
	abortGrace           = time.Second      // how long a failed upload waits for its reader to let go
	sniffLen             = 512              // what http.DetectContentType looks at
	maxAnswer            = 8 << 10          // Drop Zone's answer is a path: anything longer is not
	maxPath              = 4096
	maxLabel             = 24
	maxN                 = 9999
	fallbackLabel        = "hire"    // the stem's label when the hint leaves nothing
	uploadPath           = "/upload" // Drop Zone's endpoint
)

// The codes of the errors an upload can end in (docs/protocol.md "Image
// upload"). The server maps them to an HTTP status.
const (
	CodeBadRequest  = "bad_request"
	CodeTooLarge    = "upload_too_large"
	CodeUnsupported = "upload_unsupported"
	CodeBusy        = "upload_busy"
	CodeTimeout     = "upload_timeout"
	CodeUnavailable = "dropzone_unavailable"
	CodeBadResponse = "dropzone_bad_response"
)

// Error is a failed upload: a code of the contract and a friendly message for
// the person at the keyboard. errors.Is(err, ErrTooLarge) (and the others)
// matches by code; the message carries no image bytes and nothing of Drop
// Zone's own words.
type Error struct {
	Code    string
	Message string
	cause   error
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }
func (e *Error) Unwrap() error { return e.cause }

// Is matches another *Error of the same code, so the sentinels below work
// with errors.Is whatever message or cause the error carries.
func (e *Error) Is(target error) bool {
	t, ok := target.(*Error)
	return ok && t.Code == e.Code
}

// Sentinels for errors.Is; each carries the default friendly message of its code.
var (
	ErrBadRequest       = &Error{Code: CodeBadRequest, Message: "the request is not a valid image upload"}
	ErrTooLarge         = &Error{Code: CodeTooLarge, Message: fmt.Sprintf("the image is over %d MiB", MaxBytes>>20)}
	ErrUnsupported      = &Error{Code: CodeUnsupported, Message: "only PNG, JPEG, GIF and WebP images can be uploaded"}
	ErrBusy             = &Error{Code: CodeBusy, Message: "too many images are uploading, try again in a moment"}
	ErrTimeout          = &Error{Code: CodeTimeout, Message: "the upload took too long"}
	ErrDropZoneDown     = &Error{Code: CodeUnavailable, Message: "Drop Zone could not be reached"}
	ErrDropZoneResponse = &Error{Code: CodeBadResponse, Message: "Drop Zone answered with something unexpected"}
)

func newErr(code, msg string, cause error) *Error {
	return &Error{Code: code, Message: msg, cause: cause}
}

// Meta names the upload: Drop Zone stores it as h3d-<label>-<n>.<ext>.
type Meta struct {
	Label string // a hint, sanitised to [a-z0-9-] (see Stem); "" is "hire"
	N     int    // the image's number in the draft or desk, 1..9999
}

// Result is what Drop Zone stored.
type Result struct {
	Path string // absolute, exactly as Drop Zone answered (its framing LF stripped)
	Mime string // image/png, image/jpeg, image/gif or image/webp, from the bytes
	Size int64  // bytes stored
}

// Config configures a Service.
type Config struct {
	// URL is Drop Zone's base URL (http://127.0.0.1:8080); /upload is added.
	URL string
	// Client is the HTTP client (nil: a dedicated one with dial and header
	// timeouts). Its redirects are always off: an image is never replayed to
	// another place.
	Client *http.Client
	// Timeout bounds one whole upload (0: DefaultTimeout).
	Timeout time.Duration
	// MaxConcurrent is how many uploads may run at once (0:
	// DefaultMaxConcurrent); one more is refused as ErrBusy.
	MaxConcurrent int
}

// Service uploads images to Drop Zone. Its methods are safe for concurrent use.
type Service struct {
	endpoint string
	client   *http.Client
	timeout  time.Duration
	slots    chan struct{}
}

// New returns a Service for cfg. The URL must be an http(s) URL with a host.
func New(cfg Config) (*Service, error) {
	u, err := url.Parse(cfg.URL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, fmt.Errorf("drop zone URL %q: want http://host:port", cfg.URL)
	}
	s := &Service{endpoint: strings.TrimRight(u.String(), "/") + uploadPath, timeout: cfg.Timeout}
	if s.timeout <= 0 {
		s.timeout = DefaultTimeout
	}
	n := cfg.MaxConcurrent
	if n <= 0 {
		n = DefaultMaxConcurrent
	}
	s.slots = make(chan struct{}, n)
	var c http.Client
	if cfg.Client != nil {
		c = *cfg.Client
	} else {
		c.Transport = &http.Transport{
			DialContext:           (&net.Dialer{Timeout: dialTimeout}).DialContext,
			ResponseHeaderTimeout: headerTimeout,
			DisableCompression:    true,
		}
	}
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	s.client = &c
	return s, nil
}

// Stem is the file stem Drop Zone is asked for: h3d-<label>-<n>. The label is
// lower-cased and cut down to [a-z0-9-] (anything else becomes a dash, runs of
// dashes collapse), at most 24 characters, "hire" when nothing is left.
func Stem(label string, n int) string {
	var b strings.Builder
	dash := true // no leading dash
	for _, r := range strings.ToLower(label) {
		if b.Len() >= maxLabel {
			break
		}
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			dash = false
		} else if !dash {
			b.WriteByte('-')
			dash = true
		}
	}
	l := strings.Trim(b.String(), "-")
	if l == "" {
		l = fallbackLabel
	}
	return "h3d-" + l + "-" + strconv.Itoa(n)
}

// kinds are the images accepted, by what http.DetectContentType says.
var kinds = map[string]string{
	"image/png":  ".png",
	"image/jpeg": ".jpg",
	"image/gif":  ".gif",
	"image/webp": ".webp",
}

// Upload stores src as one image in Drop Zone. It reads the first 512 bytes to
// decide the type, then streams the rest; it takes at most MaxBytes and fails
// with ErrTooLarge (nothing stored) on one byte more. ctx cancels it (the
// returned error is ctx's); Config.Timeout ends it with ErrTimeout.
//
// A src that blocks in Read past the deadline holds its goroutine until it
// returns: the caller owns src (an HTTP body has a read deadline for that). The
// upload gives up on it after abortGrace and returns.
func (s *Service) Upload(ctx context.Context, m Meta, src io.Reader) (Result, error) {
	if m.N < 1 || m.N > maxN {
		return Result{}, newErr(CodeBadRequest, "the image number must be between 1 and "+strconv.Itoa(maxN), nil)
	}
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	default:
		return Result{}, ErrBusy
	}
	ctx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()

	prefix, err := readPrefix(ctx, src)
	if err != nil {
		return Result{}, s.failure(ctx, readFailure(err))
	}
	if len(prefix) == 0 {
		return Result{}, newErr(CodeBadRequest, "the image is empty", nil)
	}
	mimeType := strings.SplitN(http.DetectContentType(prefix), ";", 2)[0]
	ext, ok := kinds[mimeType]
	if !ok {
		return Result{}, ErrUnsupported
	}
	stem := Stem(m.Label, m.N)

	pr, pw := io.Pipe()
	mw := multipart.NewWriter(pw)
	var size int64
	prodDone := make(chan error, 1)
	go func() {
		var err error
		size, err = writeMultipart(mw, stem, ext, mimeType, prefix, src)
		pw.CloseWithError(err) // nil: EOF, the request is complete
		prodDone <- err
	}()
	// The transport waits for its own writer, which waits on the pipe: when
	// ctx ends (cancelled, or the deadline), the pipe is what has to give.
	defer context.AfterFunc(ctx, func() { pr.CloseWithError(ctx.Err()) })()
	// join ends the producer and returns how it ended: closing the read end
	// unblocks its Write; a producer stuck in src.Read is given abortGrace,
	// then left to its reader (errStuck).
	join := func(cause error) error {
		pr.CloseWithError(cause)
		t := time.NewTimer(abortGrace)
		defer t.Stop()
		select {
		case err := <-prodDone:
			return err
		case <-t.C:
			return errStuck
		}
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.endpoint, pr)
	if err != nil {
		join(err)
		return Result{}, newErr(CodeUnavailable, "Drop Zone could not be reached", err)
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	resp, err := s.client.Do(req)
	if err != nil {
		perr := join(err)
		if ctx.Err() != nil { // the clock or the caller broke the transport
			return Result{}, s.failure(ctx, nil)
		}
		// The producer's own failure (over the cap, the client cut off) is the
		// cause of the transport's error; else it is Drop Zone.
		var te *Error
		if errors.As(perr, &te) {
			return Result{}, te
		}
		return Result{}, newErr(CodeUnavailable, "Drop Zone could not be reached", err)
	}
	defer resp.Body.Close()
	answer, rerr := io.ReadAll(io.LimitReader(resp.Body, maxAnswer+1))
	// Drop Zone may answer before it has read the whole body. Whatever it
	// says then, this image did not arrive as a whole.
	perr := join(errEarlyAnswer)
	if ctx.Err() != nil {
		return Result{}, s.failure(ctx, nil)
	}
	var te *Error
	if errors.As(perr, &te) {
		return Result{}, te
	}
	if rerr != nil {
		return Result{}, newErr(CodeUnavailable, "Drop Zone stopped answering", rerr)
	}
	if resp.StatusCode != http.StatusOK {
		return Result{}, newErr(CodeUnavailable, fmt.Sprintf("Drop Zone answered %d", resp.StatusCode), nil)
	}
	if perr != nil { // 200, but before the end of the image
		return Result{}, newErr(CodeBadResponse, "Drop Zone answered before it had the whole image", nil)
	}
	p, err := parsePath(answer)
	if err != nil {
		return Result{}, err
	}
	return Result{Path: p, Mime: mimeType, Size: size}, nil
}

var (
	errEarlyAnswer = errors.New("drop zone answered before the end of the body")
	errStuck       = errors.New("the image reader did not let go")
)

// failure decides what a failed step is: the caller's cancellation and the
// deadline win over what they broke (a closed connection, a dead pipe).
func (s *Service) failure(ctx context.Context, err *Error) error {
	if err == nil { // no fallback: only for a ctx that has ended
		err = newErr(CodeUnavailable, "the upload was interrupted", nil)
	}
	switch cerr := ctx.Err(); {
	case errors.Is(cerr, context.DeadlineExceeded):
		return newErr(CodeTimeout, "the upload took too long", cerr)
	case cerr != nil:
		return cerr
	}
	return err
}

// readPrefix reads the first sniffLen bytes (fewer at the end of src). It
// gives up when ctx ends, leaving the read to finish on its own; the read
// goes into its own buffer, so nothing is shared with the caller.
func readPrefix(ctx context.Context, src io.Reader) ([]byte, error) {
	type res struct {
		b   []byte
		err error
	}
	c := make(chan res, 1)
	go func() {
		b := make([]byte, sniffLen)
		n, err := io.ReadFull(src, b)
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			err = nil
		}
		c <- res{b[:n], err}
	}()
	select {
	case r := <-c:
		return r.b, r.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// errReader remembers an error of the reader it wraps, to tell it from an
// error of the write side of the pipe.
type errReader struct {
	r   io.Reader
	err error
}

func (e *errReader) Read(p []byte) (int, error) {
	n, err := e.r.Read(p)
	if err != nil && err != io.EOF {
		e.err = err
	}
	return n, err
}

// readFailure classifies an error of the caller's reader.
func readFailure(err error) *Error {
	var big *http.MaxBytesError
	if errors.As(err, &big) {
		return ErrTooLarge
	}
	return newErr(CodeBadRequest, "the upload was cut off", err)
}

// writeMultipart writes the request body: the name field first (Drop Zone
// ignores it after the file), then exactly one file part, then the footer.
// The footer is written only when src ended by itself within the cap; on
// every other end it returns the error without one, so the body Drop Zone
// sees is incomplete and it stores nothing. It returns the bytes written.
func writeMultipart(mw *multipart.Writer, stem, ext, mimeType string, prefix []byte, src io.Reader) (int64, error) {
	if err := mw.WriteField("name", stem); err != nil {
		return 0, err
	}
	h := textproto.MIMEHeader{}
	h.Set("Content-Disposition", mime.FormatMediaType("form-data", map[string]string{"name": "file", "filename": stem + ext}))
	h.Set("Content-Type", mimeType)
	part, err := mw.CreatePart(h)
	if err != nil {
		return 0, err
	}
	if _, err := part.Write(prefix); err != nil {
		return 0, err
	}
	total := int64(len(prefix))
	// One byte past the cap is read as the sentinel: a LimitReader alone would
	// cut the image off and still finish the body.
	er := &errReader{r: src}
	n, err := io.Copy(part, io.LimitReader(er, MaxBytes-total+1))
	total += n
	switch {
	case total > MaxBytes:
		return total, ErrTooLarge
	case er.err != nil:
		return total, readFailure(er.err)
	case err != nil: // the write side: Drop Zone let go
		return total, err
	}
	return total, mw.Close()
}

// parsePath checks Drop Zone's answer: one absolute path and its framing LF.
func parsePath(answer []byte) (string, error) {
	bad := func(why string) error {
		return newErr(CodeBadResponse, "Drop Zone answered with something that is not a path ("+why+")", nil)
	}
	if len(answer) > maxAnswer {
		return "", bad("too long")
	}
	p := strings.TrimSuffix(string(answer), "\n")
	switch {
	case p == "":
		return "", bad("empty")
	case len(p) > maxPath:
		return "", bad("too long")
	case !utf8.ValidString(p):
		return "", bad("not text")
	case p[0] != '/':
		return "", bad("not absolute")
	case strings.ContainsRune(p, ']'):
		return "", bad("it contains a ]")
	case strings.IndexFunc(p, unicode.IsControl) >= 0:
		return "", bad("control characters")
	}
	return p, nil
}
