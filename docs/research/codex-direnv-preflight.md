# Codex server preflight: why `direnv` fails under mise

Date 2026-10-19. Follow-up: [issue #116](https://github.com/JeffreyVdb/herdr-3d/issues/116). Scope: research only. No application code, host config, global mise/direnv setting, or repo `mise.toml` was changed.

**Labels.** **[R-live]** is a read-only observation on this machine, on 2026-10-19. **[H]** is a run of the compiled `codexapp.Preflight.Check` harness, run by the investigating parent agent. **[D]** is a primary doc page, cited by URL. **[S]** is a changelog line.

## 1. Local facts [R-live]

- `type -a direnv` lists only `/home/jeff/.local/share/mise/shims/direnv`. No system `direnv` exists. The shim is a symlink to `/usr/bin/mise`.
- Config loaded for this worktree (`mise config ls`): `/etc/mise/conf.d/omarchy.toml` (no tools) and the global `~/.config/mise/config.toml` (`codex`, `gh`, `node`, `rust`). Nothing declares `direnv`. The worktree has no `mise.toml`, `.mise.toml` or `.tool-versions`.
- The install is at `~/.local/share/mise/installs/direnv/2.38.2/direnv`. Run directly, it reports `2.38.2`. `status --json` exits 0 in the worktree and prints `config` (`ConfigDir`, `SelfPath`) and `state` (`foundRC`, `loadedRC`, both `null` with no `.envrc`).
- The shim exits 1 here. `mise which direnv` prints `direnv is a mise bin however it is not currently active`. The "No version is set for shim" wording from the reproduction matches the case in [D] errors (§2).
- `not_found_auto_install` and `not_found_system_fallback` are both `true` (default).
- `mise trust --show` reports `No trusted config files found`, before and after the checks in §3.

## 2. Why an installed shim has no active version

- **Shims exist per install, not per selection.** Installation creates executable shims; each invocation resolves a version from the current directory's configuration. [D] https://mise.jdx.dev/dev-tools/shims.html
- **The error is the no-selection case.** The documented remedy is explicit project selection or a global default. [D] https://mise.jdx.dev/errors.html
- The shim link and the `installs/direnv/2.38.2` directory share a 10:03 timestamp [R-live]. That fits the install creating the shim, but I did not trace it. Nothing in the config chain selects `direnv` for this directory, so the shim errors.

## 3. How mise picks a version by cwd

- Load order: `/etc/mise`, then global `~/.config/mise`, then every directory from the filesystem root down to the cwd. Deeper files override shallower ones; tool entries merge per tool. [D] https://mise.jdx.dev/configuration.html
- Global config "applies in every directory", so a `[tools]` entry there reaches this worktree unless a nearer file overrides it. [D] https://mise.jdx.dev/configuration.html
- `mise use` writes to the lowest-precedence file in the nearest directory that already has config. [D] https://mise.jdx.dev/configuration.html
- Trust gate: a project file needs trust only when it has `[env]`, hooks, templates, tool options, or settings. A plain `[tools]` entry is not on that list. [D] https://mise.jdx.dev/errors.html
- Versioned exec selects a version for one command without writing a tool selection to config. This alone does not establish its effect on trust or other mise state in another project. [D] https://mise.jdx.dev/getting-started.html

## 4. Evidence from the harness and local runs

- **[H] Fresh empty temp cwd, no `.envrc`:** `codexapp.Preflight.Check` fails with the exact shim error.
- **[H] Process-only `MISE_DIRENV_VERSION=2.38.2`:** passes.
- **[H] Installed binary supplied directly** (`.../installs/direnv/2.38.2/bin/direnv`): passes.
- **[H] `MISE_DIRENV_VERSION=2.38.2` plus a new, unapproved temp `.envrc`:** refuses with `.envrc is blocked`. The approval check still runs.
- **[R-live] `mise exec direnv@2.38.2 -- direnv status --json`** in the worktree: exit 0, same output as the direct binary. `mise trust --show` shows no change before or after.
- **[R-live] `MISE_DIRENV_VERSION=2.38.2 shims/direnv status --json`:** exit 0.

## 5. Remedies, narrowest first (none applied)

1. **Process-scoped diagnostic pin.** `MISE_DIRENV_VERSION=2.38.2` for the probe process demonstrates that selection is the immediate cause (§4). This is not a proposal to hard-code the host's version in the application. Versioned `mise exec` also worked in this checkout without an observed trust change; this does not establish its behavior in an untrusted project with executable configuration.
2. **Per-worktree `mise.local.toml`** containing `[tools]` `direnv = "2.38.2"`. This is scoped to one checkout and kept out of version control. [D] https://mise.jdx.dev/configuration.html says `mise.local.toml` is for personal overrides and should stay out of version control. A `[tools]`-only file needs no trust under §3. **Not run here.** Verify in a throwaway worktree before relying on it.
3. **Committed `mise.toml` pin.** It works for every checkout, but it hard-codes one host's direnv choice into the repo. Not recommended for this repo.
4. **Global pin** (`mise use -g direnv@2.38.2`). It writes `~/.config/mise/config.toml`, fixes every directory, and is a host-wide change. This needs the user's decision.
5. **Bare `mise exec -- direnv`.** With no config selecting direnv, it should fail the same way the shim does. **Not run here.** Use the versioned form in item 1.
6. **Hard-coded binary path** works [R-live] but breaks on upgrade. Not recommended.
7. **Do not change `not_found_*` or `shims.exclude`.** Turning the fallbacks off makes the shim fail the same way. Excluding `direnv` only changes the message. [D] https://mise.jdx.dev/dev-tools/shims.html
8. **Do not auto-run `direnv allow` or `mise trust`.** `direnv allow` grants permission to load an `.envrc`. The man page calls the check "the security mechanism to avoid loading new files automatically." [D] https://direnv.net/man/direnv.1.html

## 6. App behavior that keeps the `.envrc` approval check

- **Keep "unavailable" and "blocked" distinct.** "Unavailable" means mise cannot select a direnv. "Blocked" means direnv refused the `.envrc`. An unavailable direnv must never be read as "nothing to validate".
- **Existing behavior:** `Preflight` skips a genuinely missing direnv but refuses a present executable that fails. Do not turn the inactive-shim failure into the missing-tool case and skip environment validation. Choosing an application-wide executable/version policy needs a separate design decision; this investigation establishes the dependency cause and the need for actionable recovery guidance.
- **`mise which` as a probe only.** It "exits non-zero unless the tool resolves in the current directory." [D] https://mise.jdx.dev/dev-tools/shims.html. Use it to choose a path, not to skip validation.
- **Never write `direnv.toml`.** It can implicitly allow exact `.envrc` paths "regardless of contents or past usage of direnv allow or direnv deny." [D, search snippet] https://direnv.net/man/direnv.toml.1.html

## 7. Not verified

- `DIRENV_EXE_PATH` (added in 2.37.1 [S] https://direnv.net/CHANGELOG.html) may point the hook or status at a fixed binary. Its semantics were not read.
- The research agent did not independently check the allowed-state JSON schema. The parent agent did exercise the actual Go preflight with a new unapproved temporary `.envrc`, confirming refusal after selecting a working direnv (§4).
- The ide-integration page says a tool no global config selects "has no link", yet a `latest` symlink exists for `direnv` here. The `global` symlink that page describes is absent, which fits the doc. The `latest` discrepancy is not reconciled, and it does not change the failure.
- Items 2 and 5 of §5 were not run.

## Sources

- https://mise.jdx.dev/dev-tools/shims.html
- https://mise.jdx.dev/errors.html
- https://mise.jdx.dev/configuration.html
- https://mise.jdx.dev/getting-started.html
- https://direnv.net/man/direnv.1.html
- https://direnv.net/man/direnv.toml.1.html (search snippet)
- https://direnv.net/CHANGELOG.html
