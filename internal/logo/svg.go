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
	"time"

	"github.com/srwiley/oksvg"
	"github.com/srwiley/rasterx"
	"golang.org/x/net/html/charset"
)

// SVG policy. oksvg renders a small subset of SVG and is no safety
// boundary (StrictErrorMode swallows handler errors, <use> expands work, it
// dispatches on local names only and reads every attribute, style= included),
// so sanitizeSVG walks the whole document with encoding/xml first, refuses
// what the policy below does not allow, and returns a canonical re-serialised
// copy. oksvg only ever reads that copy: it has no namespaces, no text, no
// element outside svgElements and no attribute outside svgAttrs (and style=
// only carries svgStyleProps), so nothing reaches it that was not checked.
// The limits are design choices, not proven worst cases.
const (
	svgNS          = "http://www.w3.org/2000/svg"
	xlinkNS        = "http://www.w3.org/1999/xlink"
	svgMaxDepth    = 64
	svgMaxElements = 4096
	svgMaxAttrs    = 32
	svgMaxPathData = 128 << 10 // bytes of d="" and points="" together
	svgMaxPathOps  = 8192      // path commands (letters in d="")
	svgMaxCompiled = 1 << 18   // values in the compiled paths
	svgMaxCoord    = 1e6       // absolute value of any coordinate, length or extent
	svgMaxScale    = 1e3       // product of the scale factors down a branch
	svgMaxStops    = 64        // <stop>s in one gradient: rasterx walks them for every pixel
	svgMaxWork     = 1e8       // path values times device extent, all shapes together (see renderSVG)
)

// svgRenderBudget is how long the drawing of a document may take, checked
// between shapes. The source numbers do not say how slow drawing is (thousands
// of shapes over the whole canvas, wide strokes: cheap to write, slow to
// draw, and the group and viewBox scales change every number), so the drawing
// stops itself: a document not drawn in this time is refused. A single shape
// is not interrupted; svgMaxWork keeps that short. A var so a test can
// shorten it.
var svgRenderBudget = time.Second

// The SVG elements a logo may use: what oksvg draws, minus <use>, <style>,
// <image> and <text>, which it cannot render safely or at all. Elements of
// other namespaces (Inkscape, Sodipodi, RDF, or anything else) are dropped
// with their subtree, never passed on; so is all text.
var svgElements = map[string]bool{
	"svg": true, "g": true, "defs": true, "path": true, "rect": true, "circle": true, "ellipse": true,
	"line": true, "polyline": true, "polygon": true, "linearGradient": true, "radialGradient": true,
	"stop": true, "title": true, "desc": true, "metadata": true,
}

// The attributes oksvg reads (matched exactly: oksvg lower-cases some names
// and ignores the namespace, so anything else is dropped rather than
// forwarded). Attributes of other namespaces, class, href, all the attributes
// that oksvg ignores and the dash properties (stroke-dasharray,
// stroke-dashoffset: rasterx's dashing cost depends on numbers the preflight
// cannot bound) are dropped: strokes are always drawn solid.
var svgAttrs = map[string]bool{
	"id": true, "style": true, "d": true, "points": true, "viewBox": true, "x": true, "y": true,
	"width": true, "height": true, "cx": true, "cy": true, "r": true, "rx": true, "ry": true,
	"x1": true, "y1": true, "x2": true, "y2": true, "fx": true, "fy": true,
	"transform": true, "gradientTransform": true, "gradientUnits": true, "spreadMethod": true,
	"offset": true, "stop-color": true, "stop-opacity": true,
	"fill": true, "stroke": true, "stroke-width": true,
	"stroke-miterlimit": true, "stroke-linecap": true, "stroke-linejoin": true,
	"opacity": true, "fill-opacity": true, "stroke-opacity": true,
}

// The declarations a style="" attribute may carry: oksvg's presentation
// properties. They get the same checks as the attribute of the same name;
// other declarations are dropped.
var svgStyleProps = map[string]bool{
	"fill": true, "stroke": true, "stroke-width": true,
	"stroke-miterlimit": true, "stroke-linecap": true, "stroke-linejoin": true,
	"opacity": true, "fill-opacity": true, "stroke-opacity": true, "transform": true,
}

// svgState is what an open element passes down to its children.
type svgState struct {
	scale float64 // cumulative bound of the scale factors
}

// Properties whose values are lengths or coordinates: every number in them
// is bounded.
var svgNumeric = map[string]bool{
	"d": true, "points": true, "viewBox": true, "x": true, "y": true, "width": true, "height": true,
	"cx": true, "cy": true, "r": true, "rx": true, "ry": true, "x1": true, "y1": true, "x2": true, "y2": true,
	"fx": true, "fy": true, "stroke-width": true,
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

// sanitizeSVG reads the whole document, refuses what the policy above does
// not allow, and returns the canonical copy that oksvg is given.
func sanitizeSVG(data []byte) ([]byte, error) {
	clean, _, err := sanitize(data)
	return clean, err
}

// sanitize is sanitizeSVG that also returns the largest scale bound of any
// element (at least 1).
func sanitize(data []byte) ([]byte, float64, error) {
	d := newDecoder(data)
	var out bytes.Buffer
	var depth, elements, pathBytes, pathOps, skip, stops int
	roots := 0
	maxScale := 1.0
	stack := []svgState{{scale: 1}} // one per open element
	for {
		t, err := d.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, 0, invalid("the SVG is not well-formed XML: %v", err)
		}
		switch v := t.(type) {
		case xml.Directive:
			return nil, 0, unsupported("the SVG has an XML directive (DOCTYPE or ENTITY)")
		case xml.ProcInst:
			if v.Target != "xml" {
				return nil, 0, unsupported("the SVG has an XML processing instruction")
			}
		case xml.CharData:
			if depth == 0 && len(bytes.TrimSpace(v)) != 0 {
				return nil, 0, invalid("text outside the SVG root")
			}
		case xml.EndElement:
			depth--
			stack = stack[:len(stack)-1]
			if skip > 0 {
				skip--
				continue
			}
			out.WriteString("</" + v.Name.Local + ">")
		case xml.StartElement:
			depth++
			elements++
			if depth > svgMaxDepth {
				return nil, 0, unsupported("the SVG is nested over %d levels", svgMaxDepth)
			}
			if elements > svgMaxElements {
				return nil, 0, unsupported("the SVG has over %d elements", svgMaxElements)
			}
			if len(v.Attr) > svgMaxAttrs {
				return nil, 0, unsupported("<%s> has over %d attributes", v.Name.Local, svgMaxAttrs)
			}
			if skip > 0 { // inside a dropped foreign element
				skip++
				stack = append(stack, stack[len(stack)-1])
				continue
			}
			name := v.Name.Local
			inert := v.Name.Space != "" && v.Name.Space != svgNS
			if depth == 1 {
				roots++
				if roots > 1 || name != "svg" || inert {
					return nil, 0, unsupported("the SVG must have one <svg> root")
				}
			} else if inert {
				skip = 1
				stack = append(stack, stack[len(stack)-1])
				continue
			} else if name == "svg" {
				return nil, 0, unsupported("nested <svg> elements are not supported")
			}
			if !svgElements[name] {
				switch name {
				case "text", "tspan":
					return nil, 0, unsupported("<%s> is not supported: convert the text to outlines (paths) or upload a PNG", name)
				default:
					return nil, 0, unsupported("<%s> is not supported in a logo SVG: flatten it to plain shapes and paths, or upload a PNG", name)
				}
			}
			switch name {
			case "linearGradient", "radialGradient":
				stops = 0
			case "stop":
				if stops++; stops > svgMaxStops {
					return nil, 0, unsupported("a gradient has over %d stops", svgMaxStops)
				}
			}
			st := stack[len(stack)-1]
			attrs, err := sanitizeAttrs(name, v.Attr, &pathBytes, &pathOps, &st)
			if err != nil {
				return nil, 0, err
			}
			if pathBytes > svgMaxPathData {
				return nil, 0, unsupported("the SVG path data is over %d KiB", svgMaxPathData>>10)
			}
			if pathOps > svgMaxPathOps {
				return nil, 0, unsupported("the SVG has over %d path commands", svgMaxPathOps)
			}
			if st.scale > svgMaxScale {
				return nil, 0, unsupported("the SVG scales its shapes over %gx", svgMaxScale)
			}
			maxScale = math.Max(maxScale, st.scale)
			stack = append(stack, st)
			out.WriteString("<" + name)
			for _, a := range attrs {
				out.WriteString(" " + a[0] + `="`)
				_ = xml.EscapeText(&out, []byte(a[1]))
				out.WriteString(`"`)
			}
			out.WriteString(">")
		}
	}
	if roots != 1 || depth != 0 {
		return nil, 0, invalid("the SVG has no <svg> root")
	}
	return out.Bytes(), maxScale, nil
}

// sanitizeAttrs checks the attributes of one element in the SVG namespace and
// returns those to keep, as name/value pairs with plain names.
func sanitizeAttrs(elem string, attrs []xml.Attr, pathBytes, pathOps *int, st *svgState) ([][2]string, error) {
	var keep [][2]string
	seen := map[string]bool{}
	for _, a := range attrs {
		ns, local, val := a.Name.Space, a.Name.Local, a.Value
		if ns == "xmlns" || (ns == "" && local == "xmlns") {
			continue // namespace declaration: already applied by the decoder
		}
		if ns != "" && ns != svgNS && ns != xlinkNS {
			continue // private markup of editors (Inkscape's RDF metadata names licence URLs): dropped
		}
		lower := strings.ToLower(val)
		switch {
		case strings.HasPrefix(strings.ToLower(local), "on"):
			return nil, unsupported("<%s> has an event handler (%s)", elem, local)
		case local == "href":
			if (elem != "linearGradient" && elem != "radialGradient") || !strings.HasPrefix(strings.TrimSpace(val), "#") {
				return nil, unsupported("<%s> refers to another resource (href)", elem)
			}
		}
		for _, bad := range []string{"javascript:", "data:", "@import", "expression(", "http:", "https:", "file:"} {
			if strings.Contains(lower, bad) {
				return nil, unsupported("<%s> has %q in %s", elem, bad, local)
			}
		}
		for rest := lower; ; {
			i := strings.Index(rest, "url(")
			if i < 0 {
				break
			}
			rest = strings.TrimLeft(rest[i+4:], " \t\r\n'\"")
			if !strings.HasPrefix(rest, "#") {
				return nil, unsupported("<%s> refers to another resource (url() in %s)", elem, local)
			}
		}
		if ns == xlinkNS || !svgAttrs[local] {
			continue // xlink:href was checked above; the rest is not read by oksvg
		}
		if seen[local] {
			return nil, invalid("<%s> repeats the attribute %s", elem, local)
		}
		seen[local] = true
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
		if local == "style" {
			var err error
			if val, err = sanitizeStyle(elem, val, st); err != nil {
				return nil, err
			}
			if val == "" {
				continue
			}
		} else if err := checkProp(elem, local, val, st); err != nil {
			return nil, err
		}
		keep = append(keep, [2]string{local, val})
	}
	return keep, nil
}

// sanitizeStyle keeps the declarations of a style="" value that oksvg reads
// (svgStyleProps), each checked like the attribute of the same name, and
// splits them the way oksvg does: on ";", then at the first ":".
func sanitizeStyle(elem, val string, st *svgState) (string, error) {
	var keep []string
	for _, decl := range strings.Split(val, ";") {
		k, v, ok := strings.Cut(decl, ":")
		if !ok {
			continue
		}
		k, v = strings.ToLower(strings.TrimSpace(k)), strings.TrimSpace(v)
		if !svgStyleProps[k] {
			continue
		}
		if err := checkProp(elem, k, v, st); err != nil {
			return "", err
		}
		keep = append(keep, k+":"+v)
	}
	return strings.Join(keep, ";"), nil
}

// checkProp bounds the numbers of a length or coordinate property, given as
// an attribute or as a style declaration.
func checkProp(elem, local, val string, st *svgState) error {
	if !svgNumeric[local] {
		return nil
	}
	if err := eachNumber(val, func(f float64) error {
		if math.IsNaN(f) || math.IsInf(f, 0) || math.Abs(f) > svgMaxCoord {
			return unsupported("<%s> has a number out of range in %s", elem, local)
		}
		return nil
	}); err != nil {
		return err
	}
	switch local {
	case "transform", "gradientTransform":
		f, err := transformScale(val)
		if err != nil {
			return unsupported("<%s> has a transform that cannot be checked", elem)
		}
		st.scale *= f
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

// renderSVG rasterises a sanitised SVG straight at its stored size (long edge
// MaxEdge), on a transparent canvas.
func renderSVG(data []byte) (image.Image, error) {
	clean, maxScale, err := sanitize(data)
	if err != nil {
		return nil, err
	}
	icon, err := oksvg.ReadIconStream(bytes.NewReader(clean), oksvg.IgnoreErrorMode)
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
	// The cost of a shape grows with its values (segments) and with how far
	// they reach on the canvas, clipped or not, and the group and viewBox
	// scales enlarge every number after the sanitiser has seen it. So bound the
	// product, in output pixels, with the values oksvg compiled (which include
	// what relative commands added up to), the stroke width (times the miter
	// limit, which sets how far a join reaches) and the largest scale bound.
	work := 0.0
	for _, p := range icon.SVGPaths {
		reach := 0.0
		for _, v := range p.Path {
			reach = math.Max(reach, math.Abs(float64(v))/64)
		}
		reach = (reach + p.LineWidth*math.Max(1, p.MiterLimit)) * maxScale * s
		work += float64(len(p.Path)) * math.Max(reach, 1)
		if work > svgMaxWork {
			return nil, unsupported("the SVG is too complex: its shapes are too detailed for their size on the canvas")
		}
	}
	ox, oy := (float64(w)-vb.W*s)/2, (float64(h)-vb.H*s)/2
	// Not SetTarget: it translates by the unscaled viewBox origin before scaling.
	icon.Transform = rasterx.Identity.Translate(ox, oy).Scale(s, s).Translate(-vb.X, -vb.Y)
	r := rasterx.NewDasher(w, h, rasterx.NewScannerGV(w, h, dst, dst.Bounds()))
	deadline := time.Now().Add(svgRenderBudget)
	for i, p := range icon.SVGPaths { // icon.Draw, with a clock
		if i > 0 && time.Now().After(deadline) {
			return nil, unsupported("the SVG takes too long to draw: use fewer or simpler shapes")
		}
		p.DrawTransformed(r, 1, icon.Transform)
	}
	return dst, nil
}
