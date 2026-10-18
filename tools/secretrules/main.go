// Command secretrules writes internal/promptsecret's Gitleaks rule data
// (#108): the default configuration embedded in Gitleaks v8.30.1, loaded the
// way Gitleaks loads it (Viper, then config.Translate), as Go tables the
// bridge runs with the standard library's regexp. It is a development tool
// in its own module, so the bridge's go.mod never requires Gitleaks.
//
// It fails, instead of dropping anything silently, on what the runtime does
// not implement: composite rules (required), skipReport, an extended
// configuration, a path rule that would match the empty path of a prompt,
// and any field the schema below does not know. Path rules are left out
// (a prompt has no path) and listed in the generated header.
//
//	go run . -o ../../internal/promptsecret/gitleaks_rules.go
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"go/format"
	"os"
	"runtime/debug"
	"slices"
	"strconv"
	"strings"

	toml "github.com/pelletier/go-toml/v2"
	"github.com/spf13/viper"
	"github.com/zricethezav/gitleaks/v8/config"
)

// Pinned upstream.
const (
	gitleaksModule  = "github.com/zricethezav/gitleaks/v8"
	gitleaksVersion = "v8.30.1"
)

func main() {
	out := flag.String("o", "", "file to write (stdout when empty)")
	flag.Parse()
	src, err := generate(config.DefaultConfig)
	if err != nil {
		fmt.Fprintln(os.Stderr, "secretrules:", err)
		os.Exit(1)
	}
	if *out == "" {
		os.Stdout.Write(src)
		return
	}
	if err := os.WriteFile(*out, src, 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "secretrules:", err)
		os.Exit(1)
	}
}

// Rule and Allowlist are the generated data, as the runtime declares them
// (internal/promptsecret/gitleaks.go: glRule, glAllowlist).
type Rule struct {
	ID          string
	Regex       string
	SecretGroup int
	Entropy     float64
	Keywords    []string
	Allowlists  []Allowlist
}

type Allowlist struct {
	And          bool
	PathOrCommit bool
	Target       string
	Regexes      []string
	StopWords    []string
}

// Data is everything generate writes.
type Data struct {
	TOMLSHA256 string
	Global     []Allowlist
	Rules      []Rule
	Dropped    []string // path rules
}

// Load reads raw (the TOML) into the generated data, refusing what the
// runtime does not implement.
func Load(raw string) (Data, error) {
	if err := checkSchema(raw); err != nil {
		return Data{}, err
	}
	v := viper.New()
	v.SetConfigType("toml")
	if err := v.ReadConfig(strings.NewReader(raw)); err != nil {
		return Data{}, err
	}
	var vc config.ViperConfig
	if err := v.Unmarshal(&vc); err != nil {
		return Data{}, err
	}
	cfg, err := vc.Translate()
	if err != nil {
		return Data{}, err
	}
	sum := sha256.Sum256([]byte(raw))
	d := Data{TOMLSHA256: hex.EncodeToString(sum[:])}
	if cfg.Extend.Path != "" || cfg.Extend.URL != "" || cfg.Extend.UseDefault || len(cfg.Extend.DisabledRules) > 0 {
		return Data{}, errors.New("extend is not implemented")
	}
	for _, a := range cfg.Allowlists {
		al, err := allowlist(a)
		if err != nil {
			return Data{}, fmt.Errorf("global allowlist: %w", err)
		}
		d.Global = append(d.Global, al)
	}
	for _, id := range cfg.OrderedRules {
		r, ok := cfg.Rules[id]
		if !ok {
			continue
		}
		if len(r.RequiredRules) > 0 {
			return Data{}, fmt.Errorf("%s: composite rules (required) are not implemented", id)
		}
		if r.SkipReport {
			return Data{}, fmt.Errorf("%s: skipReport is not implemented", id)
		}
		if r.Path != nil {
			// DetectString scans with an empty path: a path rule only stays out
			// of a prompt while its path pattern cannot match "".
			if r.Path.MatchString("") {
				return Data{}, fmt.Errorf("%s: its path pattern matches an empty path", id)
			}
			d.Dropped = append(d.Dropped, id)
			continue
		}
		if r.Regex == nil {
			return Data{}, fmt.Errorf("%s: a rule with neither regex nor path", id)
		}
		rule := Rule{ID: id, Regex: r.Regex.String(), SecretGroup: r.SecretGroup, Entropy: r.Entropy,
			Keywords: slices.Clone(r.Keywords)}
		for _, a := range r.Allowlists {
			al, err := allowlist(a)
			if err != nil {
				return Data{}, fmt.Errorf("%s: %w", id, err)
			}
			rule.Allowlists = append(rule.Allowlists, al)
		}
		d.Rules = append(d.Rules, rule)
	}
	return d, nil
}

// allowlist is a translated allowlist as data: its stopwords sorted (Gitleaks
// keeps them as map keys), its regexes in order (the runtime joins them as
// Gitleaks' joinRegexOr does).
func allowlist(a *config.Allowlist) (Allowlist, error) {
	if a == nil {
		return Allowlist{}, errors.New("nil allowlist")
	}
	switch a.RegexTarget {
	case "", "match", "line":
	default:
		return Allowlist{}, fmt.Errorf("unknown regexTarget %q", a.RegexTarget)
	}
	al := Allowlist{And: a.MatchCondition == config.AllowlistMatchAnd, PathOrCommit: len(a.Paths)+len(a.Commits) > 0,
		Target: a.RegexTarget, StopWords: slices.Sorted(slices.Values(a.StopWords))}
	for _, re := range a.Regexes {
		al.Regexes = append(al.Regexes, re.String())
	}
	return al, nil
}

// The TOML schema this generator knows. Decoding with unknown fields
// disallowed makes an upstream schema change fail generation.
type (
	tomlConfig struct {
		Title       string                `toml:"title"`
		Description string                `toml:"description"`
		MinVersion  string                `toml:"minVersion"`
		Extend      *tomlExtend           `toml:"extend"`
		Rules       []tomlRule            `toml:"rules"`
		AllowList   *tomlAllowlist        `toml:"allowlist"`
		Allowlists  []tomlGlobalAllowlist `toml:"allowlists"`
	}
	tomlExtend struct {
		Path          string   `toml:"path"`
		URL           string   `toml:"url"`
		UseDefault    bool     `toml:"useDefault"`
		DisabledRules []string `toml:"disabledRules"`
	}
	tomlRule struct {
		ID          string          `toml:"id"`
		Description string          `toml:"description"`
		Regex       string          `toml:"regex"`
		Path        string          `toml:"path"`
		SecretGroup int             `toml:"secretGroup"`
		Entropy     float64         `toml:"entropy"`
		Keywords    []string        `toml:"keywords"`
		Tags        []string        `toml:"tags"`
		AllowList   *tomlAllowlist  `toml:"allowlist"`
		Allowlists  []tomlAllowlist `toml:"allowlists"`
		Required    []tomlRequired  `toml:"required"`
		SkipReport  bool            `toml:"skipReport"`
	}
	tomlRequired struct {
		ID            string `toml:"id"`
		WithinLines   *int   `toml:"withinLines"`
		WithinColumns *int   `toml:"withinColumns"`
	}
	tomlAllowlist struct {
		Description string   `toml:"description"`
		Condition   string   `toml:"condition"`
		Commits     []string `toml:"commits"`
		Paths       []string `toml:"paths"`
		RegexTarget string   `toml:"regexTarget"`
		Regexes     []string `toml:"regexes"`
		StopWords   []string `toml:"stopwords"`
	}
	tomlGlobalAllowlist struct {
		TargetRules []string `toml:"targetRules"`
		tomlAllowlist
	}
)

func checkSchema(raw string) error {
	dec := toml.NewDecoder(strings.NewReader(raw))
	dec.DisallowUnknownFields()
	var c tomlConfig
	if err := dec.Decode(&c); err != nil {
		return fmt.Errorf("the configuration's schema changed: %w", err)
	}
	if c.Extend != nil {
		return errors.New("extend is not implemented")
	}
	for _, r := range c.Rules {
		if len(r.Required) > 0 {
			return fmt.Errorf("%s: composite rules (required) are not implemented", r.ID)
		}
		if r.SkipReport {
			return fmt.Errorf("%s: skipReport is not implemented", r.ID)
		}
	}
	return nil
}

// checkVersion makes sure the Gitleaks linked in is the pinned one.
func checkVersion() error {
	bi, ok := debug.ReadBuildInfo()
	if !ok {
		return errors.New("no build info")
	}
	for _, m := range bi.Deps {
		if m.Path == gitleaksModule {
			if m.Version != gitleaksVersion {
				return fmt.Errorf("gitleaks %s, want %s", m.Version, gitleaksVersion)
			}
			return nil
		}
	}
	return errors.New("gitleaks is not linked in")
}

func generate(raw string) ([]byte, error) {
	if err := checkVersion(); err != nil {
		return nil, err
	}
	d, err := Load(raw)
	if err != nil {
		return nil, err
	}
	var b bytes.Buffer
	fmt.Fprintf(&b, `// Code generated by tools/secretrules from Gitleaks %s; DO NOT EDIT.

// Source: %s@%s config/gitleaks.toml (the default configuration),
// SHA-256 %s.
// Copyright (c) 2019 Zachary Rice. SPDX-License-Identifier: MIT.
// The full licence is LICENSE-gitleaks.txt, next to this file.
//
// %d rules. Left out, as a prompt has no path: %s.

package promptsecret

// The pinned upstream (RulesVersion).
const (
	gitleaksVersion    = %q
	gitleaksTOMLSHA256 = %q
)

`, gitleaksVersion, gitleaksModule, gitleaksVersion, d.TOMLSHA256, len(d.Rules), strings.Join(d.Dropped, ", "),
		gitleaksVersion, d.TOMLSHA256)
	b.WriteString("var gitleaksGlobal = []glAllowlist{\n")
	for _, a := range d.Global {
		writeAllowlist(&b, a)
	}
	b.WriteString("}\n\nvar gitleaksRules = []glRule{\n")
	for _, r := range d.Rules {
		fmt.Fprintf(&b, "{ID: %q, Regex: %s, SecretGroup: %d, Entropy: %s,\n", r.ID, strconv.Quote(r.Regex), r.SecretGroup,
			strconv.FormatFloat(r.Entropy, 'g', -1, 64))
		fmt.Fprintf(&b, "Keywords: %s,\n", strs(r.Keywords))
		if len(r.Allowlists) > 0 {
			b.WriteString("Allowlists: []glAllowlist{\n")
			for _, a := range r.Allowlists {
				writeAllowlist(&b, a)
			}
			b.WriteString("},\n")
		}
		b.WriteString("},\n")
	}
	b.WriteString("}\n")
	return format.Source(b.Bytes())
}

func writeAllowlist(b *bytes.Buffer, a Allowlist) {
	fmt.Fprintf(b, "{And: %t, PathOrCommit: %t, Target: %q,\n", a.And, a.PathOrCommit, a.Target)
	fmt.Fprintf(b, "Regexes: %s,\n", strs(a.Regexes))
	fmt.Fprintf(b, "StopWords: %s},\n", strs(a.StopWords))
}

func strs(ss []string) string {
	if len(ss) == 0 {
		return "nil"
	}
	q := make([]string, len(ss))
	for i, s := range ss {
		q[i] = strconv.Quote(s)
	}
	return "[]string{" + strings.Join(q, ", ") + "}"
}
