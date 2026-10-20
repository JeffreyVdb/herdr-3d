package logo

import (
	"bytes"
	"errors"
	"fmt"
	"hash/crc32"
	"strings"
	"testing"
	"time"
)

func crc32IEEE(b []byte) uint32 { return crc32.ChecksumIEEE(b) }

const svgHead = `<svg xmlns="http://www.w3.org/2000/svg" `

func TestSVGRenders(t *testing.T) {
	tests := []struct {
		name string
		svg  string
		w, h int
	}{
		{"viewBox only, nonzero origin", svgHead + `viewBox="10 20 2048 1024"><rect x="522" y="276" width="1024" height="512" fill="red" opacity="0.5"/></svg>`, 1024, 512},
		{"width and height only", svgHead + `width="200" height="100"><rect width="200" height="100" fill="#123"/></svg>`, 1024, 512},
		{"tall viewBox", svgHead + `viewBox="0 0 100 400"><circle cx="50" cy="50" r="40" fill="blue"/></svg>`, 256, 1024},
		{"xml declaration, BOM, comment", "\xef\xbb\xbf<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!-- logo -->" + svgHead + `viewBox="0 0 10 10"><path d="M0 0 L10 0 L5 10 Z" fill="green"/></svg>`, 1024, 1024},
		{"no namespace", `<svg viewBox="0 0 50 50"><polygon points="0,0 50,0 25,50" fill="red"/></svg>`, 1024, 1024},
		{"gradient with fragment url", svgHead + `viewBox="0 0 20 20"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs><rect width="20" height="20" fill="url(#g)"/></svg>`, 1024, 1024},
		{"inkscape metadata", svgHead + `xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" viewBox="0 0 10 10"><metadata><rdf:RDF><rdf:Description rdf:about="http://example.com"/></rdf:RDF></metadata><g inkscape:label="x" transform="translate(1,1) scale(2)"><rect width="3" height="3"/></g></svg>`, 1024, 1024},
		{"long dashes on a long path", svgHead + `viewBox="0 0 1000 1000"><path d="M0 0 L1000 1000" stroke="black" stroke-width="20" stroke-dasharray="30 10" stroke-dashoffset="5"/></svg>`, 1024, 1024},
		{"dashes set in style", svgHead + `viewBox="0 0 10 10"><line x1="0" y1="5" x2="10" y2="5" style="stroke:black;stroke-width:2;stroke-dasharray:1 1"/></svg>`, 1024, 1024},
		{"stroke and dashes", svgHead + `viewBox="0 0 10 10"><line x1="0" y1="5" x2="10" y2="5" stroke="black" stroke-width="2" stroke-dasharray="1 1"/></svg>`, 1024, 1024},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r, err := normalizeInProcess([]byte(tc.svg))
			if err != nil {
				t.Fatal(err)
			}
			if r.Source != "svg" || r.W != tc.w || r.H != tc.h {
				t.Fatalf("got %s %dx%d, want svg %dx%d", r.Source, r.W, r.H, tc.w, tc.h)
			}
			if m := decode(t, r.PNG); m.Bounds().Dx() != tc.w || m.Bounds().Dy() != tc.h {
				t.Fatalf("PNG is %v", m.Bounds())
			}
		})
	}
}

// A vector is drawn at the full stored size, on a transparent background.
func TestSVGIsDrawnLargeAndTransparent(t *testing.T) {
	r, err := normalizeInProcess([]byte(svgHead + `viewBox="0 0 10 10"><path d="M0 0 L10 0 L5 10 Z" fill="green"/></svg>`))
	if err != nil {
		t.Fatal(err)
	}
	m := decode(t, r.PNG)
	if alphaAt(m, 0, 1023) != 0 || alphaAt(m, 1023, 1023) != 0 {
		t.Fatal("the corners below the triangle are not transparent")
	}
	if alphaAt(m, 512, 100) != 255 {
		t.Fatalf("inside the triangle: alpha %d", alphaAt(m, 512, 100))
	}
}

// The nonzero viewBox origin is the trap in oksvg's SetTarget: the shape must
// start at x = 256 of 1024, with its half opacity.
func TestSVGViewBoxOrigin(t *testing.T) {
	r, err := normalizeInProcess([]byte(svgHead + `viewBox="10 20 2048 1024"><rect x="522" y="276" width="1024" height="512" fill="red" opacity="0.5"/></svg>`))
	if err != nil {
		t.Fatal(err)
	}
	m := decode(t, r.PNG)
	if a := alphaAt(m, 256, 128); a < 126 || a > 129 {
		t.Fatalf("alpha inside the rect = %d, want 128", a)
	}
	if a := alphaAt(m, 255, 128); a != 0 {
		t.Fatalf("alpha left of the rect = %d, want 0", a)
	}
	if a := alphaAt(m, 700, 400); a != 0 {
		t.Fatalf("alpha under the rect = %d, want 0", a)
	}
}

func TestSVGRefusals(t *testing.T) {
	deep := strings.Repeat("<g>", 70) + strings.Repeat("</g>", 70)
	many := strings.Repeat("<rect width='1' height='1'/>", 4100)
	manyAttrs := "<rect " + func() string {
		var b strings.Builder
		for i := 0; i < 40; i++ {
			fmt.Fprintf(&b, "data-a%d='1' ", i)
		}
		return b.String()
	}() + "/>"
	bigPath := `<path d="M0 0 ` + strings.Repeat("L1 1 ", 30000) + `"/>`
	manyOps := `<path d="` + strings.Repeat("M0 0", 9000) + `"/>`
	wrap := func(body string) string { return svgHead + `viewBox="0 0 100 100">` + body + `</svg>` }
	tests := []struct {
		name string
		svg  string
		want error
	}{
		{"doctype", `<!DOCTYPE svg [<!ENTITY x "boom">]>` + wrap(`<title>&x;</title>`), ErrUnsupported},
		{"entity reference", wrap(`<title>&x;</title>`), ErrInvalid},
		{"processing instruction", `<?xml-stylesheet href="a.css"?>` + wrap(`<rect width="1" height="1"/>`), ErrUnsupported},
		{"use", wrap(`<defs><rect id="r" width="10" height="10"/></defs><use href="#r"/>`), ErrUnsupported},
		{"use of a file", wrap(`<use href="file:///etc/passwd#x"/>`), ErrUnsupported},
		{"image", wrap(`<image href="https://example.com/a.png"/>`), ErrUnsupported},
		{"text", wrap(`<text x="1" y="9">Hello</text>`), ErrUnsupported},
		{"script", wrap(`<script>alert(1)</script>`), ErrUnsupported},
		{"foreignObject", wrap(`<foreignObject><div/></foreignObject>`), ErrUnsupported},
		{"style element", wrap(`<style>rect{fill:red}</style><rect width="1" height="1"/>`), ErrUnsupported},
		{"nested svg", wrap(`<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>`), ErrUnsupported},
		{"onload", svgHead + `onload="alert(1)" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>`, ErrUnsupported},
		{"external href on a gradient", wrap(`<linearGradient id="g" href="http://x/y#z"/>`), ErrUnsupported},
		{"external url in fill", wrap(`<rect width="1" height="1" fill="url(http://x/y)"/>`), ErrUnsupported},
		{"external url in style", wrap(`<rect width="1" height="1" style="fill:url('https://x/y')"/>`), ErrUnsupported},
		{"javascript url", wrap(`<rect width="1" height="1" fill="javascript:x"/>`), ErrUnsupported},
		{"@import in style", wrap(`<rect width="1" height="1" style="@import 'x'"/>`), ErrUnsupported},
		{"too deep", wrap(deep), ErrUnsupported},
		{"too many elements", wrap(many), ErrUnsupported},
		{"too many attributes", wrap(manyAttrs), ErrUnsupported},
		{"path data over 128 KiB", wrap(bigPath), ErrUnsupported},
		{"too many path commands", wrap(manyOps), ErrUnsupported},
		{"coordinate over 1e6", wrap(`<rect width="2000000" height="1"/>`), ErrUnsupported},
		{"exponent coordinate", wrap(`<path d="M0 0 L1e9 1"/>`), ErrUnsupported},
		{"infinite number", wrap(`<rect width="1e999" height="1"/>`), ErrUnsupported},
		{"huge viewBox", svgHead + `viewBox="0 0 4000000 10"><rect width="1" height="1"/></svg>`, ErrUnsupported},
		{"runaway scale", wrap(`<g transform="scale(900)"><g transform="scale(900)"><rect width="1" height="1"/></g></g>`), ErrUnsupported},
		{"runaway matrix", wrap(`<g transform="matrix(5000 0 0 5000 0 0)"><rect width="1" height="1"/></g>`), ErrUnsupported},
		{"huge stroke width in style", wrap(`<path d="M0 0 L100 100" stroke="red" style="fill:red;stroke-width:2000000"/>`), ErrUnsupported},
		{"runaway scale in style", wrap(`<g style="transform:scale(900)"><g style="transform:scale(900)"><rect width="1" height="1"/></g></g>`), ErrUnsupported},
		{"gradient with over 64 stops", wrap(`<defs><linearGradient id="g">` + strings.Repeat(`<stop offset="0.5" stop-color="red"/>`, 65) + `</linearGradient></defs><rect width="1" height="1" fill="url(#g)"/>`), ErrUnsupported},
		{"tiny viewBox, huge scale, long strokes", svgHead + `viewBox="0 0 0.001 0.001"><g transform="scale(900)"><path d="M0 0 L1e6 1e6 L0 1e6 Z" fill="red" stroke="blue" stroke-width="1e6"/></g></svg>`, ErrUnsupported},
		{"curves far larger than the canvas", svgHead + `viewBox="0 0 10 10"><g transform="scale(1000)"><path d="M0 0 ` + strings.Repeat("C1e6 0 0 1e6 1e6 1e6 C0 1e6 1e6 0 0 0 ", 2000) + `" fill="red" stroke="blue" stroke-width="10"/></g></svg>`, ErrUnsupported},
		{"relative commands that add up to far more than any number", svgHead + `viewBox="0 0 10 10"><path d="M0 0 ` + strings.Repeat("l1e6 1e6 ", 4000) + `" fill="none" stroke="blue"/></svg>`, ErrUnsupported},
		{"stroke far wider than the canvas", wrap(`<path d="M0 0 L100 100" stroke="red" stroke-width="900000"/>`), ErrUnsupported},
		{"miter limit that pushes joins far out", wrap(`<path d="M0 0 ` + strings.Repeat("L100 1 L0 2 ", 2000) + `" fill="none" stroke="red" stroke-width="100" stroke-miterlimit="1e6"/>`), ErrUnsupported},
		{"unbounded transform in style", wrap(`<g style="transform:frob(1)"><rect width="1" height="1"/></g>`), ErrUnsupported},
		{"foreign url in style", wrap(`<rect width="1" height="1" style="fill:url(//x/y)"/>`), ErrUnsupported},
		{"prefixed svg element, huge coordinate", `<s:svg xmlns:s="` + svgNS + `" viewBox="0 0 9 9"><s:rect width="2000000" height="1"/></s:svg>`, ErrUnsupported},
		{"prefixed svg element, unknown", `<s:svg xmlns:s="` + svgNS + `" viewBox="0 0 9 9"><s:use href="#a"/></s:svg>`, ErrUnsupported},
		{"foreign root", `<x:svg xmlns:x="urn:evil" viewBox="0 0 9 9"><x:rect width="1" height="1"/></x:svg>`, ErrUnsupported},
		{"repeated attribute", wrap(`<rect width="1" s:width="2" xmlns:s="` + svgNS + `" height="1"/>`), ErrInvalid},
		{"xlink href on a rect", wrap(`<rect width="1" height="1" xmlns:xl="http://www.w3.org/1999/xlink" xl:href="http://x/y"/>`), ErrUnsupported},
		{"no size at all", `<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>`, ErrInvalid},
		{"draws nothing", wrap(`<title>empty</title>`), ErrInvalid},
		{"zero-size viewBox", svgHead + `viewBox="0 0 0 0"><rect width="1" height="1"/></svg>`, ErrInvalid},
		{"negative viewBox", svgHead + `viewBox="0 0 -5 10"><rect width="1" height="1"/></svg>`, ErrInvalid},
		{"truncated", svgHead + `viewBox="0 0 10 10"><rect width="1" height="1"/>`, ErrInvalid},
		{"mismatched tags", wrap(`<g><rect width="1" height="1"/></rect></g>`), ErrInvalid},
		{"two roots", wrap(`<rect width="1" height="1"/>`) + wrap(`<rect width="1" height="1"/>`), ErrUnsupported},
		{"text after the root", wrap(`<rect width="1" height="1"/>`) + `junk`, ErrInvalid},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := normalizeInProcess([]byte(tc.svg))
			if !errors.Is(err, tc.want) {
				t.Fatalf("err = %v, want %v", err, tc.want)
			}
		})
	}
}

func TestEachNumber(t *testing.T) {
	var got []float64
	err := eachNumber("M-1.5.5e2,+3 4e-1 .25-7 1e 9", func(f float64) error { got = append(got, f); return nil })
	if err != nil {
		t.Fatal(err)
	}
	want := []float64{-1.5, 0.5e2, 3, 0.4, 0.25, -7, 1, 9}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("numbers = %v, want %v", got, want)
	}
}

func TestLooksLikeSVG(t *testing.T) {
	for in, want := range map[string]bool{
		`<svg/>`: true,
		"  \n<?xml version='1.0'?><svg xmlns='" + svgNS + "'/>": true,
		`<svg xmlns="http://example.com/other"/>`:               false,
		`<html/>`:              false,
		`<!DOCTYPE svg><svg/>`: false,
		`text <svg/>`:          false,
		``:                     false,
	} {
		if got := looksLikeSVG([]byte(in)); got != want {
			t.Errorf("looksLikeSVG(%q) = %v, want %v", in, got, want)
		}
	}
}

// Everything oksvg reads is checked: foreign-namespace elements and attributes
// are dropped, not passed on, so they cannot shadow or replace what the
// allowlist checked (oksvg looks at local names only).
func TestSVGForeignMarkupIsDropped(t *testing.T) {
	const plain = `<rect width="5" height="5" fill="red"/>`
	wrap := func(body string) string {
		return `<svg xmlns="` + svgNS + `" xmlns:x="urn:evil" xmlns:s="` + svgNS + `" viewBox="0 0 10 10">` + body + `</svg>`
	}
	want, err := normalizeInProcess([]byte(wrap(plain)))
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct{ name, body string }{
		{"foreign element with huge coordinates", `<x:rect x="2000000" width="9" height="9"/>` + plain},
		{"foreign element with children", `<x:g><x:rect width="9" height="9"/><rect width="9" height="9" fill="blue"/><use href="http://x/y"/></x:g>` + plain},
		{"foreign default namespace on a group", `<g xmlns="urn:evil"><rect width="9" height="9" fill="blue"/></g>` + plain},
		{"foreign style element", `<defs><x:style>.red{fill:blue}</x:style></defs><rect class="red" width="5" height="5" fill="red"/>`},
		{"foreign attribute shadowing width", `<rect width="5" x:width="9" height="5" fill="red"/>`},
		{"foreign attribute with a huge value", `<rect width="5" height="5" fill="red" x:x="99999999" x:transform="scale(99999)"/>`},
		{"foreign attribute shadowing style", `<rect width="5" height="5" fill="blue" x:style="fill:red" style="fill:red"/>`},
		{"unbound prefix", `<u:rect x="2000000" width="9" height="9"/>` + plain},
		{"upper-case names oksvg would lower-case", `<rect width="5" height="5" fill="red" STROKE-DASHOFFSET="1e7" Style="stroke-width:9e9" CLASS="a"/>`},
		{"class and unknown attributes", `<rect class="red" data-a="1" width="5" height="5" fill="red" fill-rule="evenodd"/>`},
		{"text and comments", `<!-- c --><g>hello<rect width="5" height="5" fill="red"/></g>`},
		{"prefixed SVG-namespace elements and attributes", `<s:rect s:width="5" height="5" fill="red"/>`},
		{"unknown style declarations", `<rect width="5" height="5" style="fill:red;font-size:1e9;--x:y;junk;behavior:url(#x)"/>`},
		{"declarations of a style attribute", `<rect width="5" height="5" style="fill : #f00 ; stroke:none"/>`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := normalizeInProcess([]byte(wrap(tc.body)))
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got.PNG, want.PNG) {
				t.Fatal("the picture differs: foreign or ignored markup reached the renderer")
			}
		})
	}
}

// sanitizeSVG returns what oksvg reads: a plain, namespace-free document with
// allowlisted elements and attributes only.
func TestSanitizeSVGOutput(t *testing.T) {
	in := `<?xml version="1.0"?><svg xmlns="` + svgNS + `" xmlns:x="urn:evil" viewBox="0 0 9 9" x:foo="1" Style="a:b">` +
		`<x:junk><rect/></x:junk><g id="a&lt;b" style="Fill: red;font-size:9;stroke-width:2"><title>t</title>` +
		`<linearGradient id="g" href="#h"/></g></svg>`
	got, err := sanitizeSVG([]byte(in))
	if err != nil {
		t.Fatal(err)
	}
	want := `<svg viewBox="0 0 9 9"><g id="a&lt;b" style="fill:red;stroke-width:2"><title></title><linearGradient id="g"></linearGradient></g></svg>`
	if string(got) != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

// Dashing is not supported: rasterx's cost for it depends on numbers (dash
// lengths, offsets, the group and viewBox scales) that no check of the source
// can bound, so the dash properties are dropped and strokes are drawn solid.
func TestSVGDashesAreDropped(t *testing.T) {
	wrap := func(body string) string { return svgHead + `viewBox="0 0 100 100">` + body + `</svg>` }
	const line = `<path d="M0 50 L100 50" fill="none" stroke="black" stroke-width="10"%s/>`
	tests := []struct{ name, with, without string }{
		{"attribute", wrap(fmt.Sprintf(line, ` stroke-dasharray="10 5" stroke-dashoffset="3"`)), wrap(fmt.Sprintf(line, ``))},
		{"style", wrap(`<path d="M0 50 L100 50" fill="none" style="stroke:black;stroke-width:10;stroke-dasharray:10 5;stroke-dashoffset:3"/>`), wrap(`<path d="M0 50 L100 50" fill="none" style="stroke:black;stroke-width:10"/>`)},
		{"upper-case names", wrap(fmt.Sprintf(line, ` STROKE-DASHARRAY="10 5" Style="Stroke-DashOffset : 1e7"`)), wrap(fmt.Sprintf(line, ``))},
		{"inherited from a group", wrap(`<g stroke-dasharray="0.05" style="stroke-dashoffset:9e5"><path d="M0 50 L100 50" fill="none" stroke="black" stroke-width="10"/></g>`), wrap(`<g><path d="M0 50 L100 50" fill="none" stroke="black" stroke-width="10"/></g>`)},
		{"tiny dashes and huge offset", wrap(fmt.Sprintf(line, ` stroke-dasharray="0.0001" stroke-dashoffset="1e999"`)), wrap(fmt.Sprintf(line, ``))},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := normalizeInProcess([]byte(tc.with))
			if err != nil {
				t.Fatal(err)
			}
			want, err := normalizeInProcess([]byte(tc.without))
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got.PNG, want.PNG) {
				t.Fatal("the dashes changed the picture: they should be dropped, the stroke drawn solid")
			}
			clean, err := sanitizeSVG([]byte(tc.with))
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(strings.ToLower(string(clean)), "dash") {
				t.Fatalf("a dash property reaches the renderer: %s", clean)
			}
		})
	}
}

// Documents that took seconds to minutes with dashing (dash bombs: a small
// viewBox and group scale make rasterx quantise the dashes into millions of
// segments) render at once now.
func TestSVGFormerDashBombsRenderFast(t *testing.T) {
	var many strings.Builder
	for i := 0; i < 32; i++ {
		fmt.Fprintf(&many, `<path d="M0 0 L100 100 L0 %d" fill="none" stroke="red" style="stroke-dasharray:0.02;stroke-dashoffset:10000000"/>`, i)
	}
	docs := map[string]string{
		"small viewBox and group scale": svgHead + `viewBox="0 0 1 1"><g transform="scale(900)"><path d="M0 0 L1 1 L0 1 L1 0" fill="none" stroke="red" stroke-width="0.01" stroke-dasharray="0.02" stroke-dashoffset="900000"/></g></svg>`,
		"long path, short dashes":       svgHead + `viewBox="0 0 100 100"><path d="M0 0 L1000000 1000000" stroke="red" stroke-dasharray="0.02"/></svg>`,
		"32 paths with dashes in style": svgHead + `viewBox="0 0 100 100">` + many.String() + `</svg>`,
		"many dashed circles":           svgHead + `viewBox="0 0 100 100">` + strings.Repeat(`<circle r="100" stroke="red" stroke-dasharray="0.02"/>`, 3000) + `</svg>`,
	}
	for name, doc := range docs {
		t.Run(name, func(t *testing.T) {
			renderWithin(t, doc, 3*time.Second)
		})
	}
}

// renderWithin fails unless the in-process conversion returns within d, and returns its error.
func renderWithin(t *testing.T, doc string, d time.Duration) error {
	t.Helper()
	done := make(chan error, 1)
	go func() { _, err := normalizeInProcess([]byte(doc)); done <- err }()
	select {
	case err := <-done:
		return err
	case <-time.After(d):
		t.Fatalf("the conversion took over %v", d)
		return nil
	}
}

// Best-effort early refusals of the renderer, for what the sanitiser cannot see
// in the source: the work of a shape in output pixels, the stops of a gradient,
// and the time of the drawing as a whole. None of these is the safety bound
// (that is the killed worker process: worker_test.go); they keep the ordinary
// worst cases cheap and their messages clear.
func TestSVGCostBounds(t *testing.T) {
	grad := func(n int) string {
		var b strings.Builder
		b.WriteString(`<defs><linearGradient id="g">`)
		for i := 0; i < n; i++ {
			fmt.Fprintf(&b, `<stop offset="%g" stop-color="#%06x"/>`, float64(i)/float64(n), i*997)
		}
		b.WriteString(`</linearGradient></defs>`)
		return b.String()
	}
	vb100 := func(body string) string { return svgHead + `viewBox="0 0 100 100">` + body + `</svg>` }
	t.Run("thousands of shapes over the whole canvas run out of time", func(t *testing.T) {
		doc := vb100(strings.Repeat(`<rect width="100" height="100" fill="red" opacity="0.5"/>`, 4000))
		if err := renderWithin(t, doc, 5*time.Second); !errors.Is(err, ErrUnsupported) {
			t.Fatalf("err = %v, want %v", err, ErrUnsupported)
		}
	})
	t.Run("a gradient of 4000 stops", func(t *testing.T) {
		doc := vb100(grad(4000) + `<rect width="100" height="100" fill="url(#g)"/>`)
		if err := renderWithin(t, doc, time.Second); !errors.Is(err, ErrUnsupported) {
			t.Fatalf("err = %v, want %v", err, ErrUnsupported)
		}
	})
	t.Run("a gradient of 64 stops is fine", func(t *testing.T) {
		doc := vb100(grad(64) + `<rect width="100" height="100" fill="url(#g)"/>`)
		if err := renderWithin(t, doc, 2*time.Second); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("the drawing gives up when its time is over, and only between shapes", func(t *testing.T) {
		defer func(d time.Duration) { svgRenderBudget = d }(svgRenderBudget)
		svgRenderBudget = time.Nanosecond
		two := vb100(`<rect width="9" height="9" fill="red"/><rect width="9" height="9" fill="blue"/>`)
		if _, err := normalizeInProcess([]byte(two)); !errors.Is(err, ErrUnsupported) {
			t.Fatalf("two shapes: err = %v, want %v", err, ErrUnsupported)
		}
		one := vb100(`<rect width="9" height="9" fill="red"/>`)
		if _, err := normalizeInProcess([]byte(one)); err != nil {
			t.Fatalf("one shape: %v", err)
		}
	})
	// Keep the acceptance checks under parallel load; measure throughput with
	// BenchmarkSVGWorstAccepted instead of asserting a machine's wall time.
	for name, doc := range worstAcceptedSVGs() {
		t.Run("worst accepted: "+name, func(t *testing.T) {
			if err := renderWithin(t, doc, 5*time.Second); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func worstAcceptedSVGs() map[string]string {
	vb100 := func(body string) string { return svgHead + `viewBox="0 0 100 100">` + body + `</svg>` }
	curves := func(vb, coord string) string {
		return svgHead + `viewBox="` + vb + `"><path d="M0 0 ` + strings.Repeat(fmt.Sprintf("C%s 0 0 %s %s %s C0 %s %s 0 0 0 ", coord, coord, coord, coord, coord, coord), 2000) +
			`" fill="red" stroke="blue" stroke-width="1" stroke-linejoin="round" stroke-linecap="round"/></svg>`
	}
	return map[string]string{
		"4000 curves each spanning the canvas, round strokes": curves("0 0 10 10", "10"),
		"4000 curves reaching 3x past the canvas":             curves("0 0 10 10", "30"),
		"the same at scale 1000":                              svgHead + `viewBox="0 0 10 10"><g transform="scale(1000)"><path d="M0 0 ` + strings.Repeat("C.0156 0 0 .0156 .0156 .0156 C0 .0156 .0156 0 0 0 ", 900) + `" fill="red" stroke="blue" stroke-width="0.001" stroke-linejoin="round"/></g></svg>`,
		"8000 zigzag lines across the canvas":                 vb100(`<path d="M0 0 ` + strings.Repeat("L100 100 L0 100 L100 0 ", 2700) + `" fill="red" stroke="blue" stroke-width="20" stroke-linejoin="round"/>`),
	}
}

func BenchmarkSVGWorstAccepted(b *testing.B) {
	for name, doc := range worstAcceptedSVGs() {
		b.Run(name, func(b *testing.B) {
			src := []byte(doc)
			b.ResetTimer()
			for b.Loop() {
				if _, err := normalizeInProcess(src); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
