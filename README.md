# claude-snap

> **Screenshot Vision + Visual Alias Manager for Claude Code**

`/snap` is a Claude Code skill that analyzes Windows screenshots with native multimodal vision, correlates them to your repo's source files and CSS layers, and optionally persists them as reusable `!Name` visual aliases.

No external APIs. No cloud uploads. Pure local Node.js + Claude's built-in vision.

---

## What it does

1. **Finds your latest screenshot** — watches `%USERPROFILE%\Pictures\Screenshots`
2. **Analyzes with vision** — Claude reads the image natively, producing a structured UI description across layout, components, color palette, spacing, typography, and interactive states
3. **Correlates to source** — Grep searches your repo for visible text strings, component names, and design tokens to rank which files the screenshot depicts
4. **Persists as an alias** — `/snap LoginPage` registers `!LoginPage` globally; any future prompt can reference it without re-analyzing

---

## Requirements

- **Windows 11** with Snipping Tool
- Either:
  - Win11 Snipping Tool → Settings → **"Automatically save original screenshots"** enabled
  - Or use **`Win+PrtScn`** (always writes to disk)
  - `Win+Shift+S` (clipboard-only) does **not** work — it never writes to disk
- **Claude Code** CLI with multimodal vision (claude-opus-4-7 or any Claude 3+ model)
- **Node.js** ≥ 18 (no npm install needed — zero external dependencies)

---

## Installation

### 1. Copy the skill file

Place `snap.md` in your Claude Code project's commands directory:

```
your-project/
  .claude/
    commands/
      snap.md       ← skill file
    scripts/
      snap-helper.cjs  ← FS engine
```

Or globally at `~/.claude/commands/snap.md` to use across all projects.

### 2. Update paths in `snap.md`

The skill file references absolute paths. Find and replace:

| Placeholder | Replace with |
|-------------|-------------|
| `C:/Za/.claude/scripts/snap-helper.cjs` | Your absolute path to `snap-helper.cjs` |
| `C:\Za\.snap\` | Your desired cache root (e.g. `C:\MyProject\.snap\`) |
| `C:\Za\.claude\rules\project-aliases.md` | Your project aliases file path |

### 3. Add `.snap/` to your `.gitignore`

```gitignore
# snap cache — runtime only, not committed
.snap/
```

### 4. Update your aliases file

Add this section to your `project-aliases.md` (or equivalent):

```markdown
## ! Visual Snapshots

| Alias | Path | Description | Created |
|-------|------|-------------|---------|
```

And add `! = visual snapshot` to your symbol legend.

---

## Usage

```
/snap                          # analyze freshest screenshot, no persist
/snap LoginPage                # analyze + persist as !LoginPage
/snap !LoginPage               # recall existing alias, re-correlate against current repo
/snap list                     # list all named aliases (lastUsed, size, pinned, archived)
/snap clean                    # delete expired cache entries, enforce maxUnnamedSnaps
/snap cache status             # disk usage breakdown (cache / aliases / archive)
/snap pin !LoginPage           # mark alias as pinned (exempt from archiving)
/snap archive old              # move stale unpinned aliases (>90 days unused) to archive
/snap prune --dry              # preview all deletions/archives without executing
/snap LoginPage @MyRepo #Auth  # scope correlation to a repo/@alias and topic/#alias
/snap !LoginPage --force       # recall + re-analyze ignoring freshness window
```

After registering `!LoginPage`, reference it in any prompt:

```
Look at !LoginPage — the form labels are misaligned on mobile. Fix it.
```

---

## Cache Layout

```
.snap/
  cache/
    <hash16>.<ext>           # raw screenshot copy (deleted after analysis)
    <hash16>.analysis.json   # structured UI description + repo correlation
    <hash16>.meta.json       # unnamed snip metadata (lastUsed, summary)
  aliases/
    <Name>/
      image.png              # compressed screenshot
      thumb.png              # 200×150 thumbnail
      meta.json              # alias metadata (pinned, lastUsed, etc.)
      analysis.json          # stored analysis (uiDescription, repoFiles, tokens)
  archive/
    <Name>/                  # stale aliases moved here (never deleted)
  config.json                # cache policy settings
```

**Cache policy defaults:**

| Setting | Default |
|---------|---------|
| Cache TTL | 24 hours |
| Max unnamed snaps | 50 |
| Max image size | 1 MB |
| Archive after | 90 days unused |
| Delete raw after analysis | Yes |
| Keep thumbnail | Yes |

---

## Repo Correlation

The helper searches these roots by default (customize in `correlate-scope`):

- `francois-landing/components/`
- `francois-landing/app/`
- `packages/finos/apps/web/`
- `EV Betta/ev-betta-ui/`

**Update `cmdCorrelateScope` in `snap-helper.cjs`** to match your project structure.

Confidence bands:

| Band | Score | Signal |
|------|-------|--------|
| High | 0.7–0.95 | Visible text string found verbatim in file |
| Medium | 0.4–0.7 | Component name implied by layout |
| Low | 0.2–0.4 | Design token / CSS variable only |

---

## Design Token Detection

The skill recognizes these tokens out of the box:

| Token | Meaning |
|-------|---------|
| `#0a0a0a` | Dark background |
| `#e94560` | Red accent |
| `Syne` | Heading font |
| `DM Sans` | Body font |
| `JetBrains Mono` | Code/mono font |
| `--fin-cyan` | Finos design system |
| `--ug-*` | Underground design pattern |

Add your own in the `correlate` step of `snap.md`.

---

## Helper Subcommands

All subcommands output a single JSON object to stdout. Errors use `{ ok: false, reason: "..." }`.

| Subcommand | Description |
|-----------|-------------|
| `init` | Create `.snap/` tree (idempotent) |
| `pick [--force]` | Find newest screenshot, check freshness, compute hash |
| `persist-unnamed --hash --summary` | Save unnamed snip to cache |
| `persist-alias --name --hash --analysis` | Save named alias (copies image, updates aliases file) |
| `recall --name` | Load alias metadata + analysis path |
| `list` | List all aliases |
| `clean` | Delete expired cache entries |
| `cache-status` | Disk usage breakdown |
| `pin --name` | Pin alias (exempt from archiving) |
| `archive-old` | Archive stale unpinned aliases |
| `prune [--dry]` | Preview or execute all cleanup |
| `correlate-scope [--repo] [--topic]` | Resolve search roots for repo correlation |

---

## Architecture

```
/snap (Claude Code skill)
  │
  ├── snap-helper.cjs    Pure Node.js CJS, zero external deps
  │     ├── init         Create .snap/ tree
  │     ├── pick         Find screenshot, compute hash, copy to cache
  │     ├── persist-*    Save to cache or alias dir
  │     ├── recall       Load stored analysis
  │     └── clean/list/  Lifecycle management
  │
  └── Claude vision      Read tool on imagePath → structured UI description
        └── Grep/Glob    Repo correlation searches
```

**Named vs unnamed flow:**

- **Unnamed** (`/snap`): `pick → analyze → persist-unnamed` (raw deleted immediately)
- **Named** (`/snap <name>`): `pick → analyze → persist-alias` (raw deleted by persist-alias after copy — never call persist-unnamed first)

---

## Alias Resolution (automatic)

Once registered, `!LoginPage` resolves automatically in any prompt:

1. Claude checks `project-aliases.md` under `## ! Visual Snapshots`
2. Reads `analysis.json` from the stored path
3. Optionally re-reads `image.png` for fresh visual context

No need to re-run `/snap`. The alias is live for the session.

---

## License

MIT — see [LICENSE](LICENSE)
