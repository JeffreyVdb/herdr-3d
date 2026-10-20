// Run from the repository root: go run docs/research/transcript-screenshot-bench/thumbs.go /private/originals
// Inputs must be private local image files. Only aggregate measurements are printed.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/imgcache"
)

type result struct {
	Variant  string
	Images   int
	Bytes    int
	MedianMS float64
	P95MS    float64
}

func main() {
	if len(os.Args) != 2 {
		panic("usage: thumbs.go /private/originals")
	}
	paths, err := filepath.Glob(filepath.Join(os.Args[1], "*"))
	if err != nil {
		panic(err)
	}
	for _, variant := range []string{"production", "png-speed", "png-default", "png-best", "jpeg-q82"} {
		var times []float64
		total := 0
		count := 0
		for _, path := range paths {
			b, err := os.ReadFile(path)
			if err != nil {
				panic(err)
			}
			if imgcache.Sniff(b) != imgcache.PNG {
				continue
			} // compare the expensive PNG-derived previews only
			var data []byte
			// Prepare identical resized pixels outside encode-only timing.
			prepared, err := imgcache.MakeThumb(b)
			if err != nil {
				panic(err)
			}
			pixels, _, err := image.Decode(bytes.NewReader(prepared.Data))
			if err != nil {
				panic(err)
			}
			for rep := 0; rep < 4; rep++ {
				start := time.Now()
				if variant == "production" {
					thumb, err := imgcache.MakeThumb(b)
					if err != nil {
						panic(err)
					}
					data = thumb.Data
				} else {
					var buf bytes.Buffer
					switch variant {
					case "png-speed":
						enc := png.Encoder{CompressionLevel: png.BestSpeed}
						err = enc.Encode(&buf, pixels)
					case "png-default":
						err = png.Encode(&buf, pixels)
					case "png-best":
						enc := png.Encoder{CompressionLevel: png.BestCompression}
						err = enc.Encode(&buf, pixels)
					case "jpeg-q82":
						err = jpeg.Encode(&buf, pixels, &jpeg.Options{Quality: 82})
					}
					if err != nil {
						panic(err)
					}
					data = buf.Bytes()
				}
				if rep > 0 {
					times = append(times, float64(time.Since(start).Microseconds())/1000)
				}
			}
			total += len(data)
			count++
		}
		sort.Float64s(times)
		if len(times) == 0 {
			panic("no PNG inputs")
		}
		stage := variant + " (encode only)"
		if variant == "production" {
			stage = "production (decode+resize+encode)"
		}
		r := result{stage, count, total, times[len(times)/2], times[int(float64(len(times)-1)*.95)]}
		out, _ := json.Marshal(r)
		fmt.Println(string(out))
	}
}
