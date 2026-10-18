// Research-only JSON-lines adapter to amortize default rule compilation.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/zricethezav/gitleaks/v8/detect"
	"github.com/zricethezav/gitleaks/v8/report"
)

func main() {
	start := time.Now()
	d, err := detect.NewDetectorDefaultConfig()
	if err != nil {
		panic(err)
	}
	loadMS := float64(time.Since(start).Microseconds()) / 1000
	input := bufio.NewScanner(os.Stdin)
	input.Buffer(make([]byte, 64*1024), 1024*1024)
	output := json.NewEncoder(os.Stdout)
	for input.Scan() {
		var request struct{ Text string }
		if err := json.Unmarshal(input.Bytes(), &request); err != nil {
			panic(err)
		}
		start := time.Now()
		findings := d.DetectString(request.Text)
		if err := output.Encode(struct {
			Findings []report.Finding `json:"findings"`
			ScanMS   float64          `json:"scan_ms"`
			LoadMS   float64          `json:"load_ms"`
		}{findings, float64(time.Since(start).Microseconds()) / 1000, loadMS}); err != nil {
			panic(err)
		}
	}
	if err := input.Err(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
