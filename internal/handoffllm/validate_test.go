package handoffllm_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/handoffllm"
)

func TestValidate(t *testing.T) {
	ok := []struct{ name, in, want string }{
		{"as asked", goodDoc, goodDoc},
		{"wrapped in a markdown fence", "```markdown\n" + goodDoc + "```\n", goodDoc},
		{"headings with trailing colons and closing marks", strings.ReplaceAll(strings.ReplaceAll(goodDoc, "## Decisions", "## Decisions:"), "## Next steps", "## Next steps ##"), ""},
		{"a code block with a # line inside", strings.Replace(goodDoc, "Run CI.", "Run:\n```sh\n# not a title\nmake ci\n```", 1), ""},
	}
	for _, c := range ok {
		t.Run(c.name, func(t *testing.T) {
			got, err := handoffllm.Validate(c.in, 0)
			if err != nil {
				t.Fatal(err)
			}
			if c.want != "" && got != c.want {
				t.Fatalf("%q", got)
			}
		})
	}
	bad := []struct{ name, in, why string }{
		{"empty", "  \n", "empty"},
		{"no title", strings.TrimPrefix(goodDoc, "# Fix the flaky login test\n"), "title"},
		{"prose first", "Here is the handoff:\n" + goodDoc, "title"},
		{"two titles", goodDoc + "\n# Another\n", "more than one"},
		{"title too long", "# " + strings.Repeat("é", handoffllm.MaxTitle+1) + strings.TrimPrefix(goodDoc, "# Fix the flaky login test"), "title"},
		{"a section missing", strings.Replace(goodDoc, "## Verification", "## Checks", 1), "Verification"},
		{"only headings", "# T\n## Goal and current state\n## Decisions\n## Verification\n## Open questions\n## Next steps\n## Suggested skills\n", "empty"},
		{"not UTF-8", goodDoc + "\xff", "UTF-8"},
	}
	for _, c := range bad {
		t.Run(c.name, func(t *testing.T) {
			_, err := handoffllm.Validate(c.in, 0)
			if !errors.Is(err, handoffllm.ErrInvalid) || !strings.Contains(err.Error(), c.why) {
				t.Fatalf("%v", err)
			}
		})
	}
	if _, err := handoffllm.Validate(goodDoc, 40); !errors.Is(err, handoffllm.ErrInvalid) {
		t.Fatalf("over the byte bound: %v", err)
	}
}
