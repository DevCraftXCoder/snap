# /snap — Screenshot Vision + Visual Alias Manager

Analyze a Windows screenshot with native vision, correlate it to repo source files, and optionally persist it as a reusable `!Name` visual alias.

> **Capture prerequisite:** Win11 Snipping Tool must have **"Automatically save original screenshots"** enabled, OR use **`Win+PrtScn`** (always writes to disk). A plain `Win+Shift+S` clipboard-only snip does NOT save to disk and will not be found.
> Screenshots folder: `C:\Users\J\Pictures\Screenshots`

## Usage

```
/snap                          # analyze freshest snip, no persist
/snap <name>                   # analyze + persist as !<name>
/snap !name                    # recall existing alias, re-correlate against current repo
/snap list                     # list all named aliases (lastUsed, size, pinned, archived)
/snap clean                    # delete expired cache entries, enforce maxUnnamedSnaps
/snap cache status             # disk usage breakdown (cache / aliases / archive)
/snap pin !name                # mark alias as pinned (exempt from archiving)
/snap archive old              # move stale unpinned aliases (>90 days unused) to archive
/snap prune --dry              # preview all deletions/archives without executing
/snap <name> @Repo #Topic      # scope correlation to a repo/@alias and topic/#alias
/snap !name --force            # recall + re-analyze ignoring freshness window
```

## Implementation

### `/snap` and `/snap <name>`

**Step 1 — Initialize .snap/ tree (idempotent)**

```bash
node C:/Za/.claude/scripts/snap-helper.cjs init
```

Parse stdout JSON. If `ok:false`, surface the error and stop.

**Step 2 — Pick the newest screenshot**

```bash
node C:/Za/.claude/scripts/snap-helper.cjs pick [--force]
```

Include `--force` if the user passed `--force`. Parse stdout JSON:

- `ok:false, reason:"no-folder"` → Tell the user: "Enable 'Automatically save original screenshots' in Win11 Snipping Tool settings, or use Win+PrtScn. Screenshots folder must exist at `C:\Users\J\Pictures\Screenshots`."
- `ok:false, reason:"empty"` → "Take a screenshot first, then run /snap."
- `ok:false, reason:"stale"` → Surface `newestAgeMinutes`. Tell the user the newest snip is N minutes old (>10 min). Offer `/snap --force` to override the freshness window.
- `ok:true, deduped:true` → Check whether the prior analysis covers the current scope (`@Repo`/`#Topic`). Offer to reuse the prior analysis or re-analyze. If reusing, skip to Step 11.
- `ok:true` → `imagePath` is the absolute path to the cached image; `hash` is its 16-char SHA-256 prefix.

**Step 3 — Read the image (native vision)**

Use the Read tool on `imagePath` from the pick output. This is the only vision step — no external APIs.

**Step 4 — Produce structured UI description**

Write a structured description covering all six dimensions:

- **Layout**: regions (header / sidebar / main / footer), grid vs flex, column counts
- **Components**: visible elements with their labels/text strings (buttons, cards, inputs, nav, modals, charts)
- **Color palette**: dominant colors observed; flag matches to `#0a0a0a` (background), `#e94560` (accent)
- **Spacing**: gap rhythm, padding density (tight / comfortable), border radius style
- **Typography**: heading vs body contrast, serif/sans/mono hints; note candidates Syne (headings), DM Sans (body), JetBrains Mono (code/mono)
- **Interactive states**: hover/active/focus/disabled cues; note red focus rings → Underground design pattern

**Step 5 — Resolve correlation scope**

```bash
node C:/Za/.claude/scripts/snap-helper.cjs correlate-scope [--repo @X] [--topic #Y]
```

Pass any `@Repo` or `#Topic` tokens the user included. Parse `searchRoots`, `globPatterns`, `topicHints` from stdout JSON.

Default search roots (no `@Repo` given):
- `C:\Za\francois-landing\components\`
- `C:\Za\francois-landing\app\`
- `C:\Za\packages\finos\apps\web\`
- `C:\Za\EV Betta\ev-betta-ui\`

If `ok:false, reason:"unknown-repo"` → warn, fall back to default roots.

**Step 6 — Run Grep and Glob searches**

Using the resolved roots:

a. **Text-string match** — Grep visible UI text/labels (button copy, section titles, headings) in `.tsx` files across the search roots. High-confidence signal.

b. **Component-name match** — Grep component/class names suggested by the layout description (e.g. `Card`, `Sidebar`, `MetricCard`, `PrimaryButton`).

c. **Token match** — Glob `*.module.css` and `globals.css` across roots; Grep for observed design tokens (`#0a0a0a`, `#e94560`, `Syne`, `DM Sans`, `JetBrains Mono`, `--fin-cyan`, `--ug-*`).

Apply topic hints (from `correlate-scope`) as high-priority candidates (e.g. `#SystemsTab` → `C:\Za\francois-landing\components\admin\SystemsTab.tsx` added to top of ranking).

**Step 7 — Rank matches**

Build a ranked list: `{ file, confidence, reason }`.

Confidence bands:
- **High (0.7–0.95)**: text-string match — visible label found verbatim in the file
- **Medium (0.4–0.7)**: component-name match — layout-implied component name found in the file
- **Low (0.2–0.4)**: token-only match — design token or CSS variable confirmed but no text/component match

**Step 8 — Write analysis JSON to temp file**

Path: `C:\Za\.snap\cache\<hash>.analysis.json`

Format:
```json
{
  "uiDescription": "…structured prose…",
  "components": ["MetricCard", "Sidebar"],
  "cssFiles": ["C:\\Za\\francois-landing\\app\\globals.css"],
  "repoFiles": [
    { "file": "C:\\Za\\francois-landing\\components\\admin\\SystemsTab.tsx", "confidence": 0.86, "reason": "matched 'System Status' title + 8-card grid layout" },
    { "file": "C:\\Za\\francois-landing\\components\\StreamingLinks.tsx", "confidence": 0.41, "reason": "similar card grid but different copy" }
  ],
  "tokens": { "#0a0a0a": "background", "#e94560": "accent", "Syne": "headings" }
}
```

**Step 9 — Persist**

Unnamed (`/snap` with no name):

```bash
node C:/Za/.claude/scripts/snap-helper.cjs persist-unnamed --hash <hash> --summary "<one-line summary of what the snip shows>"
```

Named (`/snap <name>`):

> **Important**: When a name is provided, skip `persist-unnamed` entirely. Call `persist-alias` directly while the raw image is still in cache. `persist-alias` copies the image to the alias directory and deletes the raw automatically — the two commands must never both run for the same hash.

Check for alias name collision first — if `aliases\<name>\` already exists, ask the user to confirm overwrite before proceeding.

```bash
node C:/Za/.claude/scripts/snap-helper.cjs persist-alias --name <name> --hash <hash> --analysis C:/Za/.snap/cache/<hash>.analysis.json
```

If `oversized:true` in the response, warn: "Image stored at reduced quality — use a region snip for tighter file size."

**Step 10 — Present results**

Show:
1. UI description summary (layout, dominant components, color palette, notable patterns)
2. Top 3 correlated repo files with file path, confidence score, and reason
3. CSS token matches (design system confirmed)
4. For named aliases: confirm `!<name>` is now registered in `C:\Za\.claude\rules\project-aliases.md`

---

### `/snap !name`

**Step 1 — Recall alias**

```bash
node C:/Za/.claude/scripts/snap-helper.cjs recall --name <name>
```

If `ok:false, reason:"not-found"` → list `suggestions[]` from the response. Tell the user which aliases are available.
If the alias is in `archive\` → note it is archived; offer to restore via `/snap pin !name` then `/snap <name>`.

**Step 2 — Load prior analysis**

Read `imagePath` from recall response with the Read tool (fresh visual context).
Load `analysisPath` (the stored `analysis.json`) to retrieve the prior UI description and `repoFiles[]`.

**Step 3 — Re-correlate against current repo state**

Re-run the Grep/Glob searches from the prior `repoFiles[]` to detect drift:
- Files that no longer exist (moved or deleted)
- Files that have been renamed
- New files that now match better than stored ones

**Step 4 — Present drift report**

Show:
1. Prior analysis summary (from stored `uiDescription`)
2. Still-valid matches (file exists, still matches)
3. Gone files (no longer exist at stored path)
4. New matches (found in current state, not in prior `repoFiles`)
5. `lastUsed` updated to today

---

### Utility subcommands

For each of: `list`, `clean`, `cache status`, `pin`, `archive old`, `prune --dry`

Call the corresponding helper subcommand:

| User invocation | Helper subcommand | Key flag |
|-----------------|-------------------|----------|
| `/snap list` | `list` | — |
| `/snap clean` | `clean` | — |
| `/snap cache status` | `cache-status` | — |
| `/snap pin !name` | `pin --name <name>` | — |
| `/snap archive old` | `archive-old` | — |
| `/snap prune --dry` | `prune --dry` | `--dry` |

Parse stdout JSON and format as a readable summary:

- **list**: table of alias names, lastUsed date, size (KB/MB), pinned flag, archived flag
- **clean**: "Deleted N entries, freed X KB." List deleted hashes.
- **cache status**: section breakdown — cache: N items / X MB, aliases: N / X MB, archive: N / X MB, total: X MB
- **pin**: "!`<name>` is now pinned — exempt from archiving."
- **archive old**: "Archived N aliases: `<names>`. Skipped N pinned: `<names>`."
- **prune --dry**: "Would delete: `<hashes>`. Would archive: `<names>`. Would free: X KB. Nothing changed."

If any subcommand returns an empty action list, report "Nothing to clean / archive / delete."

---

## Error Handling

| Helper `reason` | User-facing message |
|-----------------|---------------------|
| `no-folder` | "Screenshots folder not found at `C:\Users\J\Pictures\Screenshots`. Enable 'Automatically save original screenshots' in Win11 Snipping Tool settings, or take a screenshot with Win+PrtScn." |
| `empty` | "No screenshots found. Take a screenshot first, then run /snap." |
| `stale` | "Newest screenshot is N minutes old (threshold: 10 min). Use `/snap --force` to analyze it anyway." |
| `invalid-name` | "Name must be camelCase with no spaces, slashes, or special characters (e.g. `/snap LoginPage`, `/snap FinosHero`). Path separators and `..` are rejected." |
| `not-found` (recall) | "Alias `!<name>` not found. Available aliases: `<suggestions>`. Run `/snap list` to see all." |
| `unknown-repo` (scope) | "Repo alias `@<X>` not found in project-aliases.md. Falling back to default search roots." |
| `oversized` | "Image stored but exceeds 1 MB after compression — use a region snip for tighter file size." |

---

## Visual Alias Resolution (automatic — no /snap needed)

When `!Name` appears in a normal prompt (outside `/snap`):

1. Check `C:\Za\.claude\rules\project-aliases.md` under `## ! Visual Snapshots` for the alias row.
2. Read `analysis.json` from the absolute path in that row.
3. Optionally re-read `image.png` for a fresh visual pass if the prompt requires it.

This is automatic on every session — the aliases file is auto-loaded via `@rules/project-aliases.md` in `C:\Za\.claude\CLAUDE.md`. No re-running `/snap` is needed.

---

## File Locations

| File | Purpose |
|------|---------|
| `C:\Za\.claude\commands\snap.md` | This skill file |
| `C:\Za\.claude\scripts\snap-helper.cjs` | Committed CommonJS helper — all filesystem, cache, and index operations |
| `C:\Za\.snap\` | Runtime cache tree — gitignored, never committed |
| `C:\Za\.snap\cache\` | Unnamed snip summaries + metadata |
| `C:\Za\.snap\aliases\<name>\` | Named visual alias (image, thumb, meta, analysis) |
| `C:\Za\.snap\archive\<name>\` | Stale aliases moved by `archive old` |
| `C:\Za\.claude\rules\project-aliases.md` | `## ! Visual Snapshots` index — committed, auto-loaded |
