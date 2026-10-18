package promptsecret_test

import (
	"errors"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf16"

	"github.com/JeffreyVdb/herdr-3d/internal/promptsecret"
)

var key = []byte("0123456789abcdef0123456789abcdef")

// UTF-16 offsets: astral characters are two code units, a combining mark
// one, CRLF two; a range may not split a surrogate pair.
func TestOffsets(t *testing.T) {
	t.Parallel()
	text := "a🌧️é́\r\nb𝄞"
	o := promptsecret.NewOffsets(text)
	if want := len(utf16.Encode([]rune(text))); o.Len() != want {
		t.Fatalf("len %d, want %d", o.Len(), want)
	}
	u := 0
	for b, r := range text {
		if got := o.UTF16(b); got != u {
			t.Errorf("byte %d: utf16 %d, want %d", b, got, u)
		}
		if got, ok := o.Byte(u); !ok || got != b {
			t.Errorf("utf16 %d: byte %d %t, want %d", u, got, ok, b)
		}
		if r >= 0x10000 {
			if _, ok := o.Byte(u + 1); ok {
				t.Errorf("utf16 %d splits a surrogate pair", u+1)
			}
			u += 2
		} else {
			u++
		}
	}
	if o.UTF16(len(text)) != o.Len() || o.UTF16(2) != -1 {
		t.Errorf("end %d, inside a code point %d", o.UTF16(len(text)), o.UTF16(2))
	}
	if _, ok := o.Byte(o.Len() + 1); ok {
		t.Error("past the end")
	}
}

func TestRevision(t *testing.T) {
	t.Parallel()
	r := promptsecret.NewReviewer(key, own)
	text := "PASSWORD=Hunter2! and the token is ghp_GT2MQVTdhGOubkn5tfdOv4eYnhJvEkcAI167"
	a, b := r.Scan(text), r.Scan(text)
	if a.Revision != b.Revision || len(a.Found) != 2 || a.Found[0].ID != "c1" || a.Found[1].ID != "c2" {
		t.Fatalf("scans differ or ids: %+v %+v", a, b)
	}
	if strings.Contains(a.Revision, "Hunter2") || len(a.Revision) < 40 {
		t.Fatalf("revision %q", a.Revision)
	}
	other := promptsecret.NewReviewer([]byte("another key, 32 bytes long......"), own)
	if other.Scan(text).Revision == a.Revision {
		t.Fatal("the revision does not depend on the key")
	}
	if r.Scan(text+" ").Revision == a.Revision {
		t.Fatal("the revision does not depend on the text")
	}
	if r.Scan("no secrets").Revision == r.Scan("no secrets!").Revision {
		t.Fatal("a scan without candidates binds no text")
	}
	// UTF-16 offsets on the found candidates.
	u := "é🙂 password: Zeven9!"
	f := r.Scan(u).Found
	if len(f) != 1 || string(utf16.Decode(utf16.Encode([]rune(u))[f[0].Start16:f[0].End16])) != "Zeven9!" {
		t.Fatalf("found %+v", f)
	}
}

func check(t *testing.T, r *promptsecret.Reviewer, text, rev string, ds ...promptsecret.Decision) (promptsecret.Plan, error) {
	t.Helper()
	return r.Check(text, rev, ds)
}

func protect(id string) promptsecret.Decision {
	return promptsecret.Decision{Candidate: id, Protect: true}
}
func ignore(id string) promptsecret.Decision { return promptsecret.Decision{Candidate: id} }
func mark(s, e int) promptsecret.Decision {
	return promptsecret.Decision{Protect: true, Range: &promptsecret.Range{Start: s, End: e}}
}

func TestCheck(t *testing.T) {
	t.Parallel()
	r := promptsecret.NewReviewer(key, own)
	text := "A_TOKEN=same-value-1 B_TOKEN=same-value-1 🌧 note"
	rev := r.Scan(text)
	if len(rev.Found) != 2 {
		t.Fatalf("found %+v", rev.Found)
	}
	o := promptsecret.NewOffsets(text)

	// The same value, protected once and ignored once: only the first.
	p, err := check(t, r, text, rev.Revision, ignore("c2"), protect("c1"))
	if err != nil || len(p.Protect) != 1 || p.Protect[0] != (promptsecret.Range{Start: rev.Found[0].Start, End: rev.Found[0].End}) || p.Ignored != 1 {
		t.Fatalf("plan %+v %v", p, err)
	}
	// Order does not change the plan's key; another choice does.
	p2, _ := check(t, r, text, rev.Revision, protect("c1"), ignore("c2"))
	p3, _ := check(t, r, text, rev.Revision, protect("c1"), protect("c2"))
	if p.Key != p2.Key || p.Key == p3.Key {
		t.Fatalf("keys %s %s %s", p.Key, p2.Key, p3.Key)
	}
	// A corrected range and a manual mark (UTF-16, after the astral char).
	n := o.Len()
	p, err = check(t, r, text, rev.Revision, promptsecret.Decision{Candidate: "c1", Protect: true,
		Range: &promptsecret.Range{Start: rev.Found[0].Start16, End: rev.Found[0].End16 - 2}}, ignore("c2"), mark(n-4, n))
	if err != nil || len(p.Protect) != 2 || text[p.Protect[0].Start:p.Protect[0].End] != "same-value" ||
		text[p.Protect[1].Start:p.Protect[1].End] != "note" {
		t.Fatalf("corrected %+v %v", p, err)
	}

	for name, ds := range map[string][]promptsecret.Decision{
		"missing":            {protect("c1")},
		"twice":              {protect("c1"), ignore("c1"), ignore("c2")},
		"unknown":            {protect("c1"), ignore("c2"), protect("c9")},
		"manual ignore":      {protect("c1"), ignore("c2"), {Range: &promptsecret.Range{Start: 0, End: 1}}},
		"manual no range":    {protect("c1"), ignore("c2"), {Protect: true}},
		"ignore with range":  {{Candidate: "c1", Range: &promptsecret.Range{Start: 0, End: 1}}, ignore("c2")},
		"empty range":        {protect("c1"), ignore("c2"), mark(3, 3)},
		"out of range":       {protect("c1"), ignore("c2"), mark(n-1, n+1)},
		"negative":           {protect("c1"), ignore("c2"), mark(-1, 2)},
		"splits a pair":      {protect("c1"), ignore("c2"), mark(n-6, n-5)},
		"overlap protected":  {protect("c1"), ignore("c2"), mark(rev.Found[0].Start16+1, rev.Found[0].End16+1)},
		"overlap ignored":    {protect("c1"), ignore("c2"), mark(rev.Found[1].Start16, rev.Found[1].End16)},
		"corrected overlaps": {{Candidate: "c1", Protect: true, Range: &promptsecret.Range{Start: 0, End: rev.Found[1].Start16 + 1}}, ignore("c2")},
	} {
		_, err := check(t, r, text, rev.Revision, ds...)
		var re *promptsecret.ReviewError
		if !errors.As(err, &re) || re.Stale {
			t.Errorf("%s: %v", name, err)
		} else if strings.Contains(re.Error(), "same-value") {
			t.Errorf("%s: the error quotes the text: %v", name, err)
		}
	}
	// Stale: another text, another key, a made-up revision.
	for name, c := range map[string]struct {
		r         *promptsecret.Reviewer
		text, rev string
	}{
		"edited":  {r, text + "!", rev.Revision},
		"restart": {promptsecret.NewReviewer([]byte("another key, 32 bytes long......"), own), text, rev.Revision},
		"made up": {r, text, "x"},
		"no scan": {r, text, ""},
	} {
		_, err := c.r.Check(c.text, c.rev, []promptsecret.Decision{protect("c1"), ignore("c2")})
		var re *promptsecret.ReviewError
		if !errors.As(err, &re) || !re.Stale {
			t.Errorf("%s: %v", name, err)
		}
	}
	// No candidates: manual marks with that scan's revision.
	clean := "deploy with my usual secret phrase"
	p, err = check(t, r, clean, r.Scan(clean).Revision, mark(28, 34))
	if err != nil || len(p.Protect) != 1 || clean[p.Protect[0].Start:p.Protect[0].End] != "phrase" {
		t.Fatalf("manual only: %+v %v", p, err)
	}
	if p, err := check(t, r, clean, r.Scan(clean).Revision); err != nil || len(p.Protect) != 0 {
		t.Fatalf("nothing: %+v %v", p, err)
	}
}

func TestReplace(t *testing.T) {
	t.Parallel()
	text := "a=XX b=YYY c"
	got := promptsecret.Replace(text, []promptsecret.Range{{2, 4}, {7, 10}}, []string{promptsecret.Reference("/p/1"), promptsecret.Reference("/p/2")})
	if want := "a=[secret in file /p/1] b=[secret in file /p/2] c"; got != want {
		t.Fatalf("got %q", got)
	}
	// What the bridge wrote is never proposed again.
	if v := values("password=" + ownRef("GXWCYAQQ2YUJGSWNCUK2JAZZ57")); len(v) != 0 {
		t.Fatalf("reference proposed: %q", v)
	}
}

// Warm scan time of a 16 KiB prompt (reported with -v; the rules compile
// on the first scan, before the timer).
func TestScanTime16KiB(t *testing.T) {
	text := strings.Repeat("Review the module and keep its behavior. ", (16<<10)/41) + "\nThe password is LongTail8!Secret."
	text = text[len(text)-(16<<10):]
	promptsecret.Scan(text, own)
	var ds []time.Duration
	for range 20 {
		start := time.Now()
		promptsecret.Scan(text, own)
		ds = append(ds, time.Since(start))
	}
	slices.Sort(ds)
	t.Logf("16 KiB warm scan: median %v, max %v", ds[len(ds)/2], ds[len(ds)-1])
	if ds[len(ds)/2] > 2*time.Second {
		t.Fatalf("median %v", ds[len(ds)/2])
	}
}

func BenchmarkScan16KiB(b *testing.B) {
	text := strings.Repeat("Use API_KEY=abc and the password is x7! then review. ", (16<<10)/53)
	promptsecret.Scan(text, own)
	b.ResetTimer()
	for b.Loop() {
		promptsecret.Scan(text, own)
	}
}

// A sent prompt's text edited and scanned again: the bridge's references in
// several syntaxes (the masked pass runs too).
func BenchmarkScan16KiBReferences(b *testing.B) {
	r := ownRef("GXWCYAQQ2YUJGSWNCUK2JAZZ57")
	part := "Deploy with PASSWORD=" + r + " and Authorization: Bearer " + r + ". The token is " + r + ", see https://h.test/x?token=" +
		r + "&x=1 (" + r + "). Review the module, keep its behavior.\n"
	text := strings.Repeat(part, (16<<10)/len(part)+1)[:16<<10]
	promptsecret.Scan(text, own)
	b.ResetTimer()
	for b.Loop() {
		promptsecret.Scan(text, own)
	}
}
