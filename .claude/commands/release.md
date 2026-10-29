# Release Obsidian Plugin

Push a new versioned release of the Notor Obsidian plugin. Bump the version, commit, tag, and push — triggering the GitHub Actions workflow that builds and creates a draft GitHub release.

## Prerequisites

- Working tree is clean (no uncommitted changes unrelated to this release)
- You are on the `main` branch
- The new version follows [SemVer](https://semver.org/) (`x.y.z`) — **no leading `v`**
- The GitHub Actions workflow at `.github/workflows/release.yaml` is present and working

---

## Step 0: Run the community review guard

Obsidian's automated review scans every release and pulls a failing one from the community directory within 24 hours (0.12.0 was delisted this way). Before changing any versions, run the guard on the commit you intend to release:

```bash
npm run review:guard
```

It lints with the scanner's latest rules and scope, checks restricted `eslint-disable` directives, release metadata, the built `main.js` and `npm audit`, and compares warnings with the last release's baseline. See `.claude/skills/community-review-guard/SKILL.md`.

- **`BLOCKED`**: stop. Fix each blocking finding in the code (never by adding an `eslint-disable`, since disabling restricted rules is itself an error), commit, and rerun.
- **Warnings marked ▲**: this release added them. Fix the new ones where reasonable, or tell the user which ones remain.
- **`NEEDS PREVIEW-SCAN CONFIRMATION`**: push the branch, then ask the user to run the **dashboard preview scan** on the printed SHA (community.obsidian.md → **Plugins** → **Notor** → **Review branch** → **Run preview scan**). Continue only once they confirm it reports no errors.

The release workflow also runs `npm run review:guard -- --ci` on the tag, so a blocking problem stops the draft release from being created.

---

## Step 1: Confirm the target version

Ask the user (or confirm from context) what the new version number should be. It must be a SemVer string like `0.2.0` or `1.0.0`.

> **Important:** Per Obsidian's release requirements, the tag pushed to GitHub must exactly match the `version` field in `manifest.json`. Never use a leading `v`.

---

## Step 2: Check the working tree is clean

```bash
git status --porcelain
```

If any unexpected modified or untracked files appear, stop and ask the user how to proceed before making any version changes.

---

## Step 3: Bump the version

Use the npm version script, which runs `version-bump.mjs` to update `manifest.json` and `versions.json` automatically, and also updates `package.json` and `package-lock.json`:

```bash
npm version {NEW_VERSION} --no-git-tag-version
```

Replace `{NEW_VERSION}` with the target version string (e.g. `0.2.0`).

This single command updates all four files:
- `package.json` — npm package version
- `package-lock.json` — lockfile version
- `manifest.json` — Obsidian plugin version (via `version-bump.mjs`)
- `versions.json` — maps plugin version → minimum Obsidian app version (via `version-bump.mjs`)

---

## Step 4: Verify the version updates

Confirm all four files now contain the new version:

```bash
node -e "const p=require('./package.json'),m=require('./manifest.json'),v=require('./versions.json');console.log('package.json:',p.version,'manifest.json:',m.version,'versions.json key:',Object.keys(v).slice(-1)[0])"
```

All should reflect the new version. If any mismatch exists, fix it manually before continuing.

---

## Step 5: Commit the version bump

Stage only the four version files:

```bash
git add manifest.json versions.json package.json package-lock.json
```

Then commit (as a standalone command):

```bash
git commit -m "[Claude] Version bump: {PREV_VERSION} → {NEW_VERSION}

- Updated manifest.json version to {NEW_VERSION}
- Updated versions.json with {NEW_VERSION} → minAppVersion mapping
- Updated package.json version to {NEW_VERSION}
- Updated package-lock.json version to {NEW_VERSION}

---

Release {NEW_VERSION}"
```

---

## Step 6: Push the commit to main

```bash
git push origin main
```

---

## Step 7: Create and push the release tag

Create an annotated tag matching the version exactly:

```bash
git tag -a {NEW_VERSION} -m "Release {NEW_VERSION}"
```

Then push the tag:

```bash
git push origin {NEW_VERSION}
```

Pushing the tag triggers the GitHub Actions release workflow (`.github/workflows/release.yaml`), which will:
1. Build the plugin (`npm install && npm run build`)
2. Create a **draft** GitHub release titled `{NEW_VERSION}`
3. Attach `build/main.js`, `build/manifest.json`, and `build/styles.css` as release assets

---

## Step 8: Draft the CHANGELOG summary

Review all commits since the previous release tag and draft a CHANGELOG entry summarizing what was implemented. Get the commit list with:

```bash
git log {PREV_VERSION}..{NEW_VERSION}
```

Read the commit messages carefully and group related changes into meaningful categories (e.g. **New Features**, **Bug Fixes**, **Settings**, **UI Polish**). Omit spec/docs-only commits unless they represent user-visible changes.

Present the full CHANGELOG entry to the user in the chat **inside a Markdown code fence block** so it can be easily copied and pasted into the GitHub release notes.

---

## Step 9: Publish the release (manual step)

The release is created as a draft to allow review before publishing. **This step is intentionally left for the human to complete in the GitHub UI** — do NOT use the `gh` CLI tool for this.

1. Go to `https://github.com/zachmueller/notor/releases`
2. Find the draft release for `{NEW_VERSION}`
3. Paste the CHANGELOG summary drafted in Step 8 into the release notes
4. Select **Publish release**

> The release must be published (not just draft) before it can be submitted to the Obsidian community plugin catalog.

---

## Step 10: After publishing

1. **Trigger the review.** Ask the user to open Notor in the developer dashboard and select **…** → **Request review** (or **Check for new releases** if the new version isn't shown yet). Results usually arrive within minutes.
2. **Calibrate the guard** once the public scorecard shows the new version:
   ```bash
   npx tsx .claude/skills/community-review-guard/calibrate.ts
   ```
   Any "Scorecard Risks the guard doesn't BLOCK" means the guard missed something. Fix the guard before the next release.
3. **Record the baseline** so the next release's warnings are compared with this one:
   ```bash
   npm run review:guard -- --ref {NEW_VERSION} --write-baseline
   ```
   Commit `.claude/skills/community-review-guard/baseline.json` on its own ("Record community review baseline for {NEW_VERSION}").
4. **Listing watch.** `.github/workflows/listing-watch.yml` checks the directory hourly and opens a `delisted` issue if Notor disappears more than 2 hours after a release. Treat that issue as an incident: read the dashboard errors, fix, and ship a patch release.

---

## Troubleshooting

**Build fails in GitHub Actions:**
- Check the Actions tab for the full error log
- Common causes: TypeScript errors introduced since last release, missing `build/` output files

**"Community review guard" step fails in GitHub Actions:**
- The log has the same report as `npm run review:guard`. Fix the blocking findings, delete and re-push the tag (see below), and rerun Step 0 locally first.

**Tag already exists:**
- If you need to re-tag: `git tag -d {NEW_VERSION}` then `git push origin :refs/tags/{NEW_VERSION}` to delete locally and remotely, then re-create

**Version mismatch between tag and manifest.json:**
- Obsidian's community plugin validator requires the tag to exactly match `manifest.json`'s `version` field — re-check Step 3 and 4 if there's a mismatch
