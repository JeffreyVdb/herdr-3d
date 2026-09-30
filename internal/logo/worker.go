package logo

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"runtime/debug"
	"strconv"
	"strings"
)

// The render worker: the child process that draws an SVG. The bridge
// re-executes its own binary as `<exe> logo-worker` with H3D_LOGO_WORKER=1
// (both are needed, so a stray variable in someone's environment does not turn
// the daemon into a worker), writes the sanitised SVG to its stdin and reads
// the PNG from its stdout (convert.go). The worker is entered from init, before
// main and before any bridge setup: it opens no store, no socket, no listener,
// reads no configuration and only ever talks over its three standard streams.
// That also makes it work in `go test`, whose binaries re-execute themselves
// the same way, with no TestMain in the packages that upload SVGs.
//
// A worker that exits 0 wrote a PNG. Exit codes 10-12 are typed refusals (the
// same three the parent would give), with a small JSON object on stderr
// carrying the message; anything else (a crash, a panic, a kill by the CPU
// limit or by the parent's deadline) is a failure the parent reports as an
// invalid image without looking at the child's words.
const (
	workerEnv = "H3D_LOGO_WORKER"     // "1" in the worker's environment
	workerArg = "logo-worker"         // its only argument
	cpuEnv    = "H3D_LOGO_WORKER_CPU" // whole seconds of CPU time it may use

	exitInvalid     = 10
	exitUnsupported = 11
	exitTooLarge    = 12

	workerMemoryLimit = 512 << 20 // bytes: the Go runtime's soft limit (it collects harder near it; the kill is the hard bound)
	maxWorkerMessage  = 300       // bytes of a typed refusal's message that reach the user
)

func init() {
	if os.Getenv(workerEnv) == "1" && len(os.Args) == 2 && os.Args[1] == workerArg {
		limitSelf(cpuSeconds(os.Getenv(cpuEnv)))
		debug.SetMemoryLimit(workerMemoryLimit)
		debug.SetGCPercent(50)
		os.Exit(runWorker(os.Stdin, os.Stdout, os.Stderr))
	}
}

// workerRefusal is the JSON a worker writes to stderr with a typed exit code.
type workerRefusal struct {
	Message string `json:"message"`
}

// runWorker is the worker: sanitised SVG from in, PNG to out, exit status back.
// It sanitises again (the copy it is given passes unchanged) so that oksvg
// never reads anything the allowlist has not checked, whoever wrote to its
// stdin, and to get the same scale bound the in-process path has.
func runWorker(in io.Reader, out, errw io.Writer) (code int) {
	defer func() {
		if r := recover(); r != nil {
			fmt.Fprintln(errw, "panic in the logo worker")
			code = 2
		}
	}()
	data, err := io.ReadAll(io.LimitReader(in, MaxInput+1))
	if err != nil {
		return 1
	}
	if len(data) > MaxInput {
		err = tooLarge("the file is over %d bytes", MaxInput)
	} else {
		var res Result
		if res, err = renderSVGPNG(data); err == nil {
			if _, err = out.Write(res.PNG); err == nil {
				return 0
			}
			return 1
		}
	}
	msg, _ := json.Marshal(workerRefusal{Message: refusalMessage(err)})
	_, _ = errw.Write(msg)
	switch {
	case errors.Is(err, ErrTooLarge):
		return exitTooLarge
	case errors.Is(err, ErrUnsupported):
		return exitUnsupported
	case errors.Is(err, ErrInvalid):
		return exitInvalid
	}
	return 1
}

// renderSVGPNG is the whole SVG step: sanitise, draw, encode. Only the worker
// (and tests, which call it in-process) runs it.
func renderSVGPNG(data []byte) (Result, error) {
	img, err := renderSVG(data)
	if err != nil {
		return Result{}, err
	}
	return encodeResult(img, "svg")
}

// refusalMessage is err's text without the sentinel's own words, which the
// parent adds again.
func refusalMessage(err error) string {
	msg := err.Error()
	for _, s := range []error{ErrTooLarge, ErrUnsupported, ErrInvalid} {
		msg = strings.TrimPrefix(msg, s.Error()+": ")
	}
	return msg
}

// cpuSeconds parses the CPU limit variable; 0 means none.
func cpuSeconds(s string) int {
	n, err := strconv.Atoi(s)
	if err != nil || n < 0 {
		return 0
	}
	return n
}
