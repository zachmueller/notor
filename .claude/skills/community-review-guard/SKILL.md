---
name: community-review-guard
description: Before releasing, check whether Obsidian's automated community review would fail (and delist) the release. Lints with the scanner's latest eslint-plugin-obsidianmd/typescript-eslint and its file scope, blocks on restricted eslint-disable directives and release-metadata mismatches, checks the built main.js (size, WASM, ES5 helpers, reproducible build), runs npm audit, reports warnings as deltas against the last release's baseline, and calibrates itself against the live public scorecard. Use before any release or version bump, when asked "will this pass Obsidian review / the scorecard", after a delisting, when the listing-watch workflow opens a `delisted` issue, or when bumping eslint-plugin-obsidianmd.
---

# Community review guard

Since May 2026 Obsidian scans **every release** (manifest, release assets, source, build
verification) and pulls a version that fails from the community directory within
24 hours. **0.12.0 was delisted** for a single line,
`/* eslint-disable @typescript-eslint/no-deprecated */`, which produced the only two
dashboard errors. We missed it because our pinned lint plugin was behind the scanner's
and the release pipeline never linted.

This skill answers one question before tagging: *would the scanner fail this commit, and
what got worse since the last release?*

> **The dashboard preview scan is authoritative.** The guard gets as close as it can
> locally (calibrated to match the 0.12.0 scorecard location for location), then asks
> the user to confirm a preview scan. Don't skip that step.

## Run it

From the repo root:

| Command | When | Time |
|---|---|---|
| `npm run review:guard` | Before every release (the `release` command's Step 0) | ~30 s |
| `npm run review:guard -- --quick` | While editing; restricted disables + metadata only, no network | ~3 s |
| `npm run review:guard -- --ci --tag X` | The release workflow, on the tag | ~1 min |
| `npm run review:guard -- --ref 0.12.0` | Check a committed ref (temporary worktree + `npm ci`) | ~1 min |
| `npm run review:guard -- --ref X --write-baseline` | After publishing X: the next release is compared with it | ~1 min |
| `npx tsx .claude/skills/community-review-guard/calibrate.ts` | After a release's scorecard appears | ~1 min |

Other flags:
- `--offline` lints with the repo's pinned plugin and skips npm and gh.
- `--skip-build` reuses `build/main.js`. Working tree only: a `--ref` worktree has no build yet.
- `--no-repro` skips the clean-checkout rebuild.
- `--json` prints machine-readable output.

Exit status is 1 when anything BLOCKs.

## What it checks

| # | Check | BLOCK when | Otherwise |
|---|---|---|---|
| 1 | **Freshness** (`lib/lint.ts`) | — | WARN if the repo pins an older `eslint-plugin-obsidianmd`/`typescript-eslint` than the latest. Lint always runs with the latest, from a cached toolchain in `$TMPDIR/notor-review-guard/`. |
| 2 | **Scanner-equivalent lint** (`scanner.eslint.config.mjs`, `lib/scope.ts`) | `eslint-comments/*` (confirmed); parse errors; presumed: `no-unsanitized/*`, `no-eval`, `no-implied-eval`, obsidianmd error-level rules | WARN for everything the scorecard shows as a warning; INFO for rules it never shows (`ui/sentence-case`, `no-deprecated`) |
| 3 | **Restricted directives** (`lib/restricted-disables.ts`) | Disabling a rule on the plugin's restricted list, a bare disable, a whole-file disable with no matching enable, a disable without `-- reason` | WARN for the same outside the scanner's scope |
| 4 | **Built artifact** (`lib/artifact.ts`) | A clean checkout doesn't rebuild `main.js` byte-for-byte; a published release's `main.js` digest differs from the build | WARN: over 5 MB (Sync Standard limit), unlisted WASM, ES5 helpers / `eval` / `new Function` / `atob` / `btoa` counts that rose, new hosts. INFO otherwise |
| 5 | **Advisories** (`lib/audit.ts`) | — (the scorecard treats them as warnings) | WARN for advisories new since the baseline, high/critical first |
| 6 | **Release metadata** (`lib/metadata.ts`) | Manifest fields missing; `manifest.json` / `package.json` / `versions.json` / tag disagree; not semver; `isDesktopOnly` false while `src` imports Node modules; a published release missing `main.js` or `manifest.json` | — |
| — | **CSS** (`lib/css.ts`) | — | WARN for `!important` in `styles.css` |

### Why these severities

They come from the 0.12.0 evidence, not guesswork:

- **Dashboard.** It listed exactly two **Errors**, both `eslint-comments/*` violations on `audio-capture.ts:11`.
- **Warnings.** The scanner showed `no-console`, `@typescript-eslint/no-unsafe-*` and friends as warnings, though they're *errors* in the plugin's `recommended` config. So a lint error isn't automatically a review failure.
- **Precedent.** 0.11.1 had the same classes of warnings (`--ci --ref 0.11.1` → `CI CHECKS PASSED`) and stayed listed.
- **Install-breakers.** Metadata mismatches and build-verification failures make a release uninstallable or untrusted. The directory hides plugins that "can't be downloaded".

"Presumed blocking" rules haven't been observed either way. If a scorecard ever shows one as a mere warning, move it out of `PRESUMED_BLOCK` in `lib/lint.ts`.

### Scanner scope

`lib/scope.ts` holds the inferred scope:
- **Linted:** TypeScript under `src/` and `e2e/`.
- **Skipped:** `*.test.ts` / `*-test.ts`, `__tests__/`, `__mocks__/` and any `scripts/` directory.
- **Ignored repo config:** the scanner disregards `eslint.config.mts`. It linted `e2e/lib/`, which our config ignores.

The 0.12.0 calibration matched 334 of the scorecard's 335 source locations under this scope. The miss is the CSS `text-decoration` compatibility finding.

## Reading the report and fixing findings

The report lists **Blocking**, then **Warnings** with the ones this release *added* (▲)
first, then **Info**, then the preview-scan prompt.

- **Restricted or unpaired `eslint-disable`:** change the code so the rule no longer
  fires. Every restricted rule is also restricted per-line, and casting around it
  (`as any`) trades it for another restricted rule (`no-explicit-any`). Example: the 0.12.0
  fix replaced `ScriptProcessorNode` with an `AudioWorkletNode` loaded from a blob URL.
- **Metadata:** rerun `npm version X --no-git-tag-version` (it updates all four files),
  or fix `versions.json` by hand.
- **Reproducible build failed:** commit everything, `npm ci`, and rerun. A lockfile and
  `node_modules` out of sync is the usual cause.
- **Rising warnings (▲):** fix the new instances from this release (e.g. `window.setTimeout`
  instead of `setTimeout`; never store the bare function, see the renderer timer memory).
- **Unlisted WASM / new hosts:** document them in the README's network/permissions
  disclosure, then add WASM to `allowlist.json` with a one-line reason.
- **Freshness WARN:** bump the pin in `package.json` and get `npm run lint` green. The
  scanner already uses the newer rules.

## Baseline

`baseline.json` records per-rule lint counts, artifact metrics and advisory IDs **at the
last released tag**. Warnings are reported as deltas against it. After each release,
`--ref <version> --write-baseline` resets it, and the result is committed on its own.
The current baseline was measured at **0.12.0** (the last release before this skill
existed).

## Calibration

`calibrate.ts` fetches the public scorecard (or `--html saved.html`), finds the commit it
scanned from its source links, lints that commit with the guard, and matches findings by
`file:line`. Act on its sections:

| Section | Meaning | Action |
|---|---|---|
| **Risks the guard doesn't BLOCK** | The guard would let a delisting through | Fix the guard (severity map, scope, or a new check) before the next release. |
| **Guard BLOCKs that aren't Risks** | Over-strict | Move the rule to WARN once a scorecard confirms it's only a warning. |
| **Guard rules with no scorecard location** | Candidates for `NOT_ON_SCORECARD` | Add a rule only when it has many hits and zero on the scorecard. The public page may cap long location lists. |
| **Non-lint findings → uncovered** | A new scanner check | Add a check if it can fail a release. |

The 0.12.0 result was 0 missed Risks, 0 over-strict BLOCKs, and 334 of 335 locations
matched. Only the CSS `text-decoration` compatibility check isn't mirrored.

## Keeping it current

- When eslint-plugin-obsidianmd changes its `eslint-comments/no-restricted-disable` list,
  Check 3 picks it up from the installed plugin. The hard-coded copy is only a fallback
  and WARNs when used.
- After every release, run calibrate. A missed Risk is a bug in this skill.
- Unit tests: `npx vitest run .claude/skills` (directive parser and scope).

## Files

```
preflight.ts              CLI: runs the checks, prints the report, writes the baseline
calibrate.ts              guard vs the live scorecard
scanner.eslint.config.mjs plugin's plain `recommended` + type info (copied into the toolchain)
baseline.json             metrics at the last released tag
allowlist.json            documented WASM (name → reason)
lib/                      one module per check, plus exec/scope/report/scorecard helpers
```

Related: `.claude/commands/release.md` (Step 0 / Step 10), `.github/workflows/release.yaml`
(`--ci` gate), `.github/workflows/listing-watch.yml` (hourly delisting alarm).
