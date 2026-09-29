package logo

import (
	"errors"
	"fmt"
	"hash/crc32"
	"strings"
	"testing"
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
