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
			r, err := Normalize([]byte(tc.svg))
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
	r, err := Normalize([]byte(svgHead + `viewBox="0 0 10 10"><path d="M0 0 L10 0 L5 10 Z" fill="green"/></svg>`))
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
	r, err := Normalize([]byte(svgHead + `viewBox="10 20 2048 1024"><rect x="522" y="276" width="1024" height="512" fill="red" opacity="0.5"/></svg>`))
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
		{"tiny dashes", wrap(`<path d="M0 0 L100 100" stroke="red" stroke-dasharray="0.0001"/>`), ErrUnsupported},
		{"tiny dashes in style", wrap(`<path d="M0 0 L100 100" stroke="red" style="stroke-dasharray:0.0001"/>`), ErrUnsupported},
		{"huge dash offset in style", wrap(`<path d="M0 0 L100 100" stroke="red" style="stroke-dasharray:0.02;stroke-dashoffset:10000000"/>`), ErrUnsupported},
		{"huge dash offset in style, upper case key", wrap(`<path d="M0 0 L100 100" stroke="red" style="Stroke-DashOffset : 1e7"/>`), ErrUnsupported},
		{"huge stroke width in style", wrap(`<path d="M0 0 L100 100" stroke="red" style="fill:red;stroke-width:2000000"/>`), ErrUnsupported},
		{"runaway scale in style", wrap(`<g style="transform:scale(900)"><g style="transform:scale(900)"><rect width="1" height="1"/></g></g>`), ErrUnsupported},
		{"unbounded transform in style", wrap(`<g style="transform:frob(1)"><rect width="1" height="1"/></g>`), ErrUnsupported},
		{"dash bomb: long path, short dashes", wrap(`<path d="M0 0 L1000000 1000000" stroke="red" stroke-dasharray="0.02"/>`), ErrUnsupported},
		{"dash bomb: inherited from a group", wrap(`<g stroke-dasharray="0.05" style="stroke:red"><path d="M0 0 L100000 100000"/></g>`), ErrUnsupported},
		{"dash bomb: dash offset", wrap(`<path d="M0 0 L1 1" stroke="red" stroke-dasharray="0.02" stroke-dashoffset="900000"/>`), ErrUnsupported},
		{"dash bomb: many shapes", wrap(strings.Repeat(`<circle r="100" stroke="red" stroke-dasharray="0.02"/>`, 3000)), ErrUnsupported},
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
			_, err := Normalize([]byte(tc.svg))
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
	want, err := Normalize([]byte(wrap(plain)))
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
			got, err := Normalize([]byte(wrap(tc.body)))
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

// The style="" bypass: dash values that the attribute path refuses must be
// refused there too, before the renderer sees them (it ran for over 12 s).
func TestSVGStyleDashBombIsRefusedFast(t *testing.T) {
	var b strings.Builder
	b.WriteString(svgHead + `viewBox="0 0 100 100">`)
	for i := 0; i < 32; i++ {
		fmt.Fprintf(&b, `<path d="M0 0 L100 100 L0 %d" fill="none" stroke="red" style="stroke-dasharray:0.02;stroke-dashoffset:10000000"/>`, i)
	}
	b.WriteString(`</svg>`)
	done := make(chan error, 1)
	go func() { _, err := Normalize([]byte(b.String())); done <- err }()
	select {
	case err := <-done:
		if !errors.Is(err, ErrUnsupported) {
			t.Fatalf("err = %v, want %v", err, ErrUnsupported)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the dash bomb was rendered instead of refused")
	}
}
