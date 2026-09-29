package logo

import (
	"bytes"
	"encoding/xml"
	"errors"
	"image"
	"io"
	"math"
	"strconv"
	"strings"

	"github.com/srwiley/oksvg"
	"github.com/srwiley/rasterx"
	"golang.org/x/net/html/charset"
)

// SVG policy. oksvg renders a small subset of SVG and is no safety
// boundary (StrictErrorMode swallows handler errors, <use> expands work), so
// checkSVG walks the whole document with encoding/xml first and refuses
// anything outside a flat, path-based logo. The limits are design choices,
// not proven worst cases.
const (
	svgNS          = "http://www.w3.org/2000/svg"
	svgMaxDepth    = 64
	svgMaxElements = 4096
	svgMaxAttrs    = 32
	svgMaxPathData = 128 << 10 // bytes of d="" and points="" together
	svgMaxPathOps  = 8192      // path commands (letters in d="")
	svgMaxCompiled = 1 << 18   // values in the compiled paths
	svgMaxCoord    = 1e6       // absolute value of any coordinate, length or extent
	svgMaxScale    = 1e3       // product of the scale factors down a branch
)

// The SVG elements a logo may use: what oksvg draws, minus <use>, <style>,
// <image> and <text>, which it cannot render safely or at all. metadata and
// elements of foreign namespaces (Inkscape, Sodipodi, RDF) are inert.
var svgElements = map[string]bool{
	"svg": true, "g": true, "defs": true, "path": true, "rect": true, "circle": true, "ellipse": true,
	"line": true, "polyline": true, "polygon": true, "linearGradient": true, "radialGradient": true,
	"stop": true, "title": true, "desc": true, "metadata": true,
}

// Attributes whose values are lengths or coordinates: every number in them
// is bounded.
var svgNumeric = map[string]bool{
	"d": true, "points": true, "viewBox": true, "x": true, "y": true, "width": true, "height": true,
	"cx": true, "cy": true, "r": true, "rx": true, "ry": true, "x1": true, "y1": true, "x2": true, "y2": true,
	"fx": true, "fy": true, "stroke-width": true, "stroke-dashoffset": true, "stroke-dasharray": true,
	"stroke-miterlimit": true, "transform": true, "gradientTransform": true, "offset": true,
}

// looksLikeSVG reports whether the first element of an XML document is <svg>.
// It reads tokens up to the root only; checkSVG then reads all of it.
func looksLikeSVG(data []byte) bool {
	d := newDecoder(data)
	for {
		t, err := d.Token()
		if err != nil {
			return false
		}
		switch v := t.(type) {
		case xml.StartElement:
			return v.Name.Local == "svg" && (v.Name.Space == "" || v.Name.Space == svgNS)
		case xml.CharData:
			if len(bytes.TrimSpace(v)) != 0 {
				return false
			}
		case xml.Directive:
			return false
		}
	}
}

func newDecoder(data []byte) *xml.Decoder {
	d := xml.NewDecoder(bytes.NewReader(bytes.TrimPrefix(data, []byte{0xef, 0xbb, 0xbf})))
	d.CharsetReader = charset.NewReaderLabel // as oksvg does, so both see the same document
	return d
}

// checkSVG reads the whole document and refuses what the policy above does
// not allow.
func checkSVG(data []byte) error {
	d := newDecoder(data)
	var depth, elements, pathBytes, pathOps int
	roots := 0
	amp := []float64{1} // cumulative scale bound per open element
	for {
		t, err := d.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return invalid("the SVG is not well-formed XML: %v", err)
		}
		switch v := t.(type) {
		case xml.Directive:
			return unsupported("the SVG has an XML directive (DOCTYPE or ENTITY)")
		case xml.ProcInst:
			if v.Target != "xml" {
				return unsupported("the SVG has an XML processing instruction")
			}
		case xml.CharData:
			if depth == 0 && len(bytes.TrimSpace(v)) != 0 {
				return invalid("text outside the SVG root")
			}
		case xml.EndElement:
			depth--
			amp = amp[:len(amp)-1]
		case xml.StartElement:
			depth++
			elements++
			if depth > svgMaxDepth {
				return unsupported("the SVG is nested over %d levels", svgMaxDepth)
			}
			if elements > svgMaxElements {
				return unsupported("the SVG has over %d elements", svgMaxElements)
			}
			name := v.Name.Local
			inert := v.Name.Space != "" && v.Name.Space != svgNS
			if depth == 1 {
				roots++
				if roots > 1 || name != "svg" || inert {
					return unsupported("the SVG must have one <svg> root")
				}
			} else if name == "svg" && !inert {
				return unsupported("nested <svg> elements are not supported")
			}
			if !inert && !svgElements[name] {
				switch name {
				case "text", "tspan":
					return unsupported("<%s> is not supported: convert the text to outlines (paths) or upload a PNG", name)
				default:
					return unsupported("<%s> is not supported in a logo SVG: flatten it to plain shapes and paths, or upload a PNG", name)
				}
			}
			if len(v.Attr) > svgMaxAttrs {
				return unsupported("<%s> has over %d attributes", name, svgMaxAttrs)
			}
			scale := amp[len(amp)-1]
			for _, a := range v.Attr {
				if err := checkAttr(name, inert, a, &pathBytes, &pathOps, &scale); err != nil {
					return err
				}
			}
			if pathBytes > svgMaxPathData {
				return unsupported("the SVG path data is over %d KiB", svgMaxPathData>>10)
			}
			if pathOps > svgMaxPathOps {
				return unsupported("the SVG has over %d path commands", svgMaxPathOps)
			}
			if scale > svgMaxScale {
				return unsupported("the SVG scales its shapes over %gx", svgMaxScale)
			}
			amp = append(amp, scale)
		}
	}
	if roots != 1 || depth != 0 {
		return invalid("the SVG has no <svg> root")
	}
	return nil
}

func checkAttr(elem string, inert bool, a xml.Attr, pathBytes, pathOps *int, scale *float64) error {
	local := a.Name.Local
	val := a.Value
	lower := strings.ToLower(val)
	switch {
	case strings.HasPrefix(strings.ToLower(local), "on"):
		return unsupported("<%s> has an event handler (%s)", elem, local)
	case local == "href":
		if (elem != "linearGradient" && elem != "radialGradient") || !strings.HasPrefix(strings.TrimSpace(val), "#") {
			return unsupported("<%s> refers to another resource (href)", elem)
		}
	}
	// Namespace declarations and the private markup of editors (Inkscape's
	// RDF metadata names licence URLs) are inert: oksvg never reads them.
	if inert || a.Name.Space == "xmlns" || local == "xmlns" || (a.Name.Space != "" && a.Name.Space != svgNS && !svgNumeric[local]) {
		return nil
	}
	for _, bad := range []string{"javascript:", "data:", "@import", "expression(", "http:", "https:", "file:"} {
		if strings.Contains(lower, bad) {
			return unsupported("<%s> has %q in %s", elem, bad, local)
		}
	}
	for rest := lower; ; {
		i := strings.Index(rest, "url(")
		if i < 0 {
			break
		}
		rest = strings.TrimLeft(rest[i+4:], " \t\r\n'\"")
		if !strings.HasPrefix(rest, "#") {
			return unsupported("<%s> refers to another resource (url() in %s)", elem, local)
		}
	}
	if local == "d" || local == "points" {
		*pathBytes += len(val)
	}
	if local == "d" {
		for _, r := range val {
			switch r {
			case 'M', 'm', 'L', 'l', 'H', 'h', 'V', 'v', 'C', 'c', 'S', 's', 'Q', 'q', 'T', 't', 'A', 'a', 'Z', 'z':
				*pathOps++
			}
		}
	}
	if svgNumeric[local] {
		var nums []float64
		if err := eachNumber(val, func(f float64) error {
			if math.IsNaN(f) || math.IsInf(f, 0) || math.Abs(f) > svgMaxCoord {
				return unsupported("<%s> has a number out of range in %s", elem, local)
			}
			nums = append(nums, f)
			return nil
		}); err != nil {
			return err
		}
		switch local {
		case "stroke-dasharray":
			if len(nums) > 16 {
				return unsupported("<%s> has a long stroke-dasharray", elem)
			}
			for _, f := range nums {
				if f != 0 && math.Abs(f) < 0.01 {
					return unsupported("<%s> has a stroke-dasharray with tiny dashes", elem)
				}
			}
		case "transform", "gradientTransform":
			f, err := transformScale(val)
			if err != nil {
				return unsupported("<%s> has a transform that cannot be checked", elem)
			}
			*scale *= f
		}
	}
	return nil
}

// transformScale bounds how much a transform list can enlarge a shape: the
// product of its scale factors, matrix columns and skew tangents (at least 1).
func transformScale(s string) (float64, error) {
	total := 1.0
	for s = strings.TrimSpace(s); s != ""; s = strings.TrimLeft(s, " \t\r\n,") {
		open := strings.IndexByte(s, '(')
		closeAt := strings.IndexByte(s, ')')
		if open < 1 || closeAt < open {
			return 0, errors.New("bad transform")
		}
		fn := strings.TrimSpace(s[:open])
		var args []float64
		_ = eachNumber(s[open+1:closeAt], func(f float64) error { args = append(args, f); return nil })
		s = s[closeAt+1:]
		f := 1.0
		switch strings.ToLower(fn) {
		case "scale":
			for _, a := range args {
				f = math.Max(f, math.Abs(a))
			}
		case "matrix":
			if len(args) != 6 {
				return 0, errors.New("bad matrix")
			}
			f = math.Max(f, math.Hypot(args[0], args[1]))
			f = math.Max(f, math.Hypot(args[2], args[3]))
		case "skewx", "skewy":
			if len(args) != 1 || math.Abs(args[0]) >= 89 {
				return 0, errors.New("bad skew")
			}
			f = math.Max(f, 1/math.Cos(args[0]*math.Pi/180))
		case "translate", "rotate":
		default:
			return 0, errors.New("unknown transform")
		}
		total *= f
	}
	return total, nil
}

// eachNumber calls fn with every number in s (as SVG writes them: optional
// sign, digits with an optional point, optional exponent) and stops at fn's
// first error.
func eachNumber(s string, fn func(float64) error) error {
	for i := 0; i < len(s); {
		c := s[i]
		if !(c >= '0' && c <= '9' || c == '.' || c == '-' || c == '+') {
			i++
			continue
		}
		j := i
		if s[j] == '-' || s[j] == '+' {
			j++
		}
		digits := 0
		for j < len(s) && s[j] >= '0' && s[j] <= '9' {
			j++
			digits++
		}
		if j < len(s) && s[j] == '.' {
			j++
			for j < len(s) && s[j] >= '0' && s[j] <= '9' {
				j++
				digits++
			}
		}
		if digits == 0 {
			i = max(j, i+1)
			continue
		}
		if j < len(s) && (s[j] == 'e' || s[j] == 'E') {
			k := j + 1
			if k < len(s) && (s[k] == '-' || s[k] == '+') {
				k++
			}
			if k < len(s) && s[k] >= '0' && s[k] <= '9' {
				for k < len(s) && s[k] >= '0' && s[k] <= '9' {
					k++
				}
				j = k
			}
		}
		f, err := strconv.ParseFloat(s[i:j], 64)
		if err != nil && !errors.Is(err, strconv.ErrRange) {
			return unsupported("unreadable number %q", s[i:j])
		}
		if errors.Is(err, strconv.ErrRange) && !math.IsInf(f, 0) { // underflow to 0: harmless
			f = 0
		}
		if err := fn(f); err != nil {
			return err
		}
		i = j
	}
	return nil
}

// renderSVG rasterises a checked SVG straight at its stored size (long edge
// MaxEdge), on a transparent canvas.
func renderSVG(data []byte) (image.Image, error) {
	if err := checkSVG(data); err != nil {
		return nil, err
	}
	icon, err := oksvg.ReadIconStream(bytes.NewReader(bytes.TrimPrefix(data, []byte{0xef, 0xbb, 0xbf})), oksvg.IgnoreErrorMode)
	if err != nil {
		return nil, invalid("cannot read the SVG: %v", err)
	}
	vb := icon.ViewBox
	for _, f := range []float64{vb.X, vb.Y, vb.W, vb.H} {
		if math.IsNaN(f) || math.IsInf(f, 0) || math.Abs(f) > svgMaxCoord {
			return nil, invalid("the SVG viewBox is out of range")
		}
	}
	if !(vb.W > 0 && vb.H > 0) {
		return nil, invalid("the SVG has no viewBox and no width and height")
	}
	compiled := 0
	for _, p := range icon.SVGPaths {
		compiled += len(p.Path)
	}
	if len(icon.SVGPaths) == 0 || compiled == 0 {
		return nil, invalid("the SVG draws nothing this app can render")
	}
	if compiled > svgMaxCompiled {
		return nil, unsupported("the SVG is too complex")
	}
	w, h, err := fitSize(vb.W, vb.H, true)
	if err != nil {
		return nil, err
	}
	dst := image.NewRGBA(image.Rect(0, 0, w, h)) // zeroed: transparent
	s := math.Min(float64(w)/vb.W, float64(h)/vb.H)
	ox, oy := (float64(w)-vb.W*s)/2, (float64(h)-vb.H*s)/2
	// Not SetTarget: it translates by the unscaled viewBox origin before scaling.
	icon.Transform = rasterx.Identity.Translate(ox, oy).Scale(s, s).Translate(-vb.X, -vb.Y)
	icon.Draw(rasterx.NewDasher(w, h, rasterx.NewScannerGV(w, h, dst, dst.Bounds())), 1)
	return dst, nil
}
