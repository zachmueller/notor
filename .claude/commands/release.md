# Release Obsidian Plugin

Push a new versioned release of the Notor Obsidian plugin. Bump the version, commit, tag, and push — triggering the GitHub Actions workflow that builds and creates a draft GitHub release.

## Prerequisites

- Working tree is clean (no uncommitted changes unrelated to this release)
- You are on the `main` branch
- The new version follows [SemVer](https://semver.org/) (`x.y.z`) — **no leading `v`**
- The GitHub Actions workflow at `.github/workflows/release.yaml` is present and working

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
git log --oneline {PREV_VERSION}..{NEW_VERSION}
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

## Troubleshooting

**Build fails in GitHub Actions:**
- Check the Actions tab for the full error log
- Common causes: TypeScript errors introduced since last release, missing `build/` output files

**Tag already exists:**
- If you need to re-tag: `git tag -d {NEW_VERSION}` then `git push origin :refs/tags/{NEW_VERSION}` to delete locally and remotely, then re-create

**Version mismatch between tag and manifest.json:**
- Obsidian's community plugin validator requires the tag to exactly match `manifest.json`'s `version` field — re-check Step 3 and 4 if there's a mismatch
