# AI Proposals Obsidian Plugin (`ai-proposals`)

![Build Status](https://img.shields.io/badge/build-passing-brightgreen)
![Tests](https://img.shields.io/badge/tests-317%2F317%20passing-brightgreen)
![TypeScript](https://img.shields.io/badge/typescript-strict%205.6-blue)
![Platform](https://img.shields.io/badge/platform-Desktop%20%7C%20Mobile-purple)
![Zero Node Imports](https://img.shields.io/badge/runtime-pure%20obsidian%20API-orange)
![License](https://img.shields.io/badge/license-MIT-green)

> **Safe bridge and interactive approval hub for AI proposals in Obsidian.**  
> Turn autonomous AI suggestions from external agents into non-destructive, reviewable inline diffs and sidebar proposals that you control with a single click.

---

## 1. Overview & Core Philosophy

### The Problem
Allowing autonomous AI agents (Antigravity/Agy, Claude, Copilot, Droid, or custom LLM scripts) to directly edit Markdown files in an Obsidian vault introduces severe operational risks:
- Destructive file overwrites and unintended content loss.
- Broken frontmatter, formatting corruption, or unclosed Markdown syntax.
- Tedious Git diff auditing and context switching out of the editor.

### The Solution: AI Proposals
**AI Proposals** decouples AI generation from file modification. Autonomous agents write atomic proposal envelopes to designated buffer files (such as `ai_suggestion-*.json` or `_agy_suggestions.json`). The plugin detects these changes in real-time and renders them as:
1. **Interactive In-Editor Highlights**: CodeMirror 6 inline marks with wavy underlines and clickable insertion glyphs.
2. **Floating Diff Popovers**: Interactive cards showing deletions (`<del>`) and insertions (`<ins>`) with instant "Zastosuj" (Accept) and "Odrzuć" (Reject) actions.
3. **Two-Tier Sidebar Panel**: A native `ItemView` grouping suggestions for the active note (Tier 1) and all other vault notes (Tier 2), complete with one-click line jumping.
4. **Status Bar Counter**: Real-time counter badge with grammatically correct Polish pluralization.

### Core Architectural Philosophies
1. **Zero Host Pollution Guarantee**: Built, tested, and bundled exclusively inside Docker with named volume shadowing (`ai-proposals-node-modules`). `node_modules` is never created on the host disk, eliminating cloud sync degradation on iCloud Drive and OneDrive.
2. **Non-Destructive Ingestion**: Notes remain pristine until you explicitly accept a suggestion. Buffer files are modified atomically under a 350ms write-lock debounce.
3. **Dual Review Workflows**: In-editor micro-review at the cursor position and vault-wide macro-review in the sidebar.
4. **Universal Mobile & Desktop Safety**: 100% public Obsidian API (`isDesktopOnly: false`). Zero Node.js runtime built-in imports (`fs`, `path`, `os`, `child_process`). Seamlessly works on iOS, Android, macOS, Windows, and Linux.

---

## 2. Interactive Feature Matrix

| Feature | Architectural Component | Description & Visual Presentation |
| :--- | :--- | :--- |
| **Inline Replacement Highlights** | `src/editor/proposal-view-plugin.ts` | Wavy dashed accent underlines (`.ai-proposal-mark`) rendered via CodeMirror 6 `Decoration.mark` across target character intervals in Source and Live Preview modes. Hovering deepens background highlight (`.ai-proposal-mark:hover`). |
| **Zero-Length Insertion Carets** | `src/editor/proposal-view-plugin.ts` | Inline glyph widget (`‸`, `.ai-proposal-mark-zero`) rendered via CM6 `Decoration.widget({ side: 1 })`. Prevents CM6 `RangeError` on zero-length ranges while providing a distinct visual insertion anchor. |
| **Floating Popover Card** | `src/editor/popover-manager.ts` | Fixed-position modal card mounted to `document.body` with boundary-clamped positioning (`computePopoverPosition`). Renders rule badge, author, explanatory markdown text, syntax-colored diff (`<del>` deletion in red, `<ins>` addition in green), and "Zastosuj" / "Odrzuć" actions. Prevents mobile soft-keyboard blur via `pointerdown` default-prevention. |
| **Two-Tier Sidebar Panel** | `src/ui/proposal-sidebar-view.ts` | Native `ItemView` registered under ID `ai-proposals-sidebar` with ribbon sparkles icon. Displays: **Tier 1 (Bieżąca notatka)** for open editor file; **Tier 2 (Pozostałe w skarbcu)** grouped into collapsible accordions per file. Features jump-to-line navigation with cursor placement and automatic active leaf detection. |
| **Polish Pluralization Counter** | `src/ui/status-bar.ts` | Interactive status bar item on desktop platforms displaying reactive proposal counts with accurate Polish grammar inflection (`1 propozycja`, `2..4 propozycje`, `5..21 propozycji`, `22..24 propozycje`, `100 propozycji`, `102 propozycje`). Clicking activates the sidebar leaf. |
| **Delta Math Engine** | `src/store/coordinate-math.ts` | Pure functional coordinate engine calculating $\Delta_{\text{ch}}$ and $\Delta_{\text{lines}}$, auto-snapping drifted anchors across $\pm 5$ lines, resolving horizontal split pushes for multi-line replacements, and eliminating overlapping interval collisions. |
| **Anti-Loop 350ms Write-Lock** | `src/store/proposal-store.ts` | Mutex debounce engine preventing self-induced file watcher echo loops when modifying notes and deleting/updating JSON buffers. |
| **Settings Tab** | `src/settings/settings-tab.ts` | Full configuration tab in Obsidian settings: buffer glob patterns, auto-snap line search tolerance slider (0–20), sidebar auto-open toggle, status bar badge toggle, and manual vault scan trigger. |

---

## 3. Getting Started & Installation

### Option A: Manual Installation (For End Users)
1. Download the latest release asset archive (`ai-proposals.zip`) containing `main.js`, `manifest.json`, and `styles.css`.
2. Open your Obsidian Vault and navigate to `.obsidian/plugins/`.
3. Create a folder named `ai-proposals/` and extract the three files into it:
   ```text
   <Vault>/.obsidian/plugins/ai-proposals/
   ├── main.js
   ├── manifest.json
   └── styles.css
   ```
4. In Obsidian, open **Settings -> Community plugins**, reload installed plugins, and toggle **AI Proposals** to **Enabled**.

### Option B: Developer Setup via Docker (Zero Host Pollution)
The project is containerized using Docker (Node 20 Bookworm LTS) with named volume shadowing. Running commands will **never** generate a `node_modules` folder on the host machine.

**Prerequisites**:
- Docker Desktop installed and running.
- PowerShell 7+ on Windows (or bash on Linux/macOS).

**Quickstart**:
```powershell
# Clone the repository
git clone https://github.com/dalec/ai-proposals.git
cd ai-proposals

# Build the production bundle into ./dist/
.\dev.ps1 build

# Run the 317 Vitest unit tests in headless container
.\dev.ps1 test

# Start incremental watch mode for real-time development
.\dev.ps1 watch

# Deploy directly to your Obsidian vault plugins directory
.\dev.ps1 deploy
```

---

## 4. Developer CLI Workflow (`dev.ps1`)

The `dev.ps1` PowerShell automation script provides a unified developer CLI wrapping Docker Compose operations, propagating exit codes, and managing vault deployment:

| Command | Syntax | Underlying Docker/System Operation | Description |
| :--- | :--- | :--- | :--- |
| `build` | `.\dev.ps1 build` | `docker compose run --rm build` | Runs TypeScript type checking (`tsc --noEmit`) and builds the production bundle into `./dist/` (`main.js`, `manifest.json`, `styles.css`). |
| `test` | `.\dev.ps1 test` | `docker compose run --rm test` | Runs 317 Vitest unit tests in headless environment with Node mock harness across all 13 test suites. |
| `watch` | `.\dev.ps1 watch` | `docker compose up watch` | Starts live incremental esbuild compiler monitoring `src/` and static assets. |
| `deploy` | `.\dev.ps1 deploy` | File copy + `.hotreload` touch | Copies `./dist/` artifacts to `.obsidian/plugins/ai-proposals/` and updates `.hotreload` marker for instant Obsidian live reload. |
| `clean` | `.\dev.ps1 clean [-All]` | Directory cleanup / volume down | Cleans `./dist/`. With `-All`, runs `docker compose down -v` to reset named volume `ai-proposals-node-modules`. |
| `rebuild` | `.\dev.ps1 rebuild` | `docker compose build --no-cache` | Rebuilds the Docker image from scratch without cache. |
| `shell` | `.\dev.ps1 shell` | `docker compose run --rm build /bin/sh` | Opens an interactive Linux container shell inside `/app`. |

### Command Options:
- `-DeployAfterBuild`: When specified with `build`, automatically syncs artifacts to the vault upon successful compilation (`.\dev.ps1 build -DeployAfterBuild`).
- `-PluginDir <Path>`: Overrides destination directory for `deploy` (defaults to `OBSIDIAN_PLUGIN_DIR` env variable or `../../.obsidian/plugins/ai-proposals`).
- `-All`: Switches `clean` to also destroy Docker volumes and network attachments (`.\dev.ps1 clean -All`).

---

## 5. AI Agent Integration & Buffer Specification

> 💡 **Quick Prompt & Integration Guide:**  
> - Ready-to-use Prompt Template: **[`prompts/agent-prompt.md`](prompts/agent-prompt.md)**  
> - Step-by-Step Agent Integration Guide: **[`docs/agent-integration.md`](docs/agent-integration.md)**

### Buffer Discovery
The plugin automatically scans and monitors the vault for files matching the configured glob pattern (default: `ai_suggestion-*.json`) and legacy files (`_agy_suggestions.json`).

### Permissive JSON Schema
Agents can emit suggestions using flat arrays, wrapped objects, or file-keyed dictionaries. The parser (`src/store/proposal-store.ts:extractRawItems`) automatically normalizes all of the following:

#### Format 1: Flat Array
```json
[
  {
    "id": "refactor-01",
    "file": "Notes/Architecture.md",
    "line": 42,
    "ch": 10,
    "original": "const oldPattern = 1;",
    "replacement": "const modernPattern = 2;",
    "rule": "Clean Code",
    "explanation": "Modernize variable naming and semantic value.",
    "author": "Antigravity Agent"
  }
]
```

#### Format 2: Wrapped Object
```json
{
  "proposals": [
    {
      "filePath": "Notes/Draft.md",
      "line": 15,
      "from_ch": 4,
      "to_ch": 12,
      "orig": "błędny",
      "replace": "poprawny",
      "category": "Pisownia",
      "reason": "Poprawa błędu ortograficznego."
    }
  ]
}
```

#### Format 3: File-Keyed Dictionary
```json
{
  "Notes/Daily.md": [
    {
      "line": 5,
      "text": "zadanie do zrobienia",
      "suggested": "- [ ] zadanie do zrobienia",
      "message": "Formatowanie listy zadań Markdown."
    }
  ]
}
```

### Supported Field Aliases:
- **Target file**: `file`, `filePath`, `path`
- **Line (1-indexed)**: `line` (parsed as positive integer)
- **Character start column (0-indexed)**: `ch`, `from_ch`, `fromCh`, `ch_from`, `from`
- **Character end column (0-indexed)**: `to_ch`, `toCh`, `ch_to`, `to` (if omitted, defaults to `ch + original.length`)
- **Original text**: `original`, `orig`, `old`, `text`
- **Replacement text**: `replacement`, `replace`, `new`, `suggested` (empty string indicates text deletion)
- **Rule/Category**: `rule`, `ruleId`, `category`, `title`
- **Rationale/Explanation**: `explanation`, `message`, `reason`, `description`

---

## 6. Obsidian Commands & Keybindings

The plugin registers three commands in the Obsidian Command Palette (`Ctrl/Cmd + P`):

1. **Otwórz panel propozycji AI** (`ai-proposals:open-sidebar`):  
   Reveals and focuses the two-tier proposals panel in the right sidebar.
2. **Skanuj bufory propozycji w skarbcu** (`ai-proposals:scan-buffers`):  
   Forces an immediate manual scan across the vault for new or modified suggestion files.
3. **Zaakceptuj wszystkie propozycje dla aktywnego pliku** (`ai-proposals:accept-all-active`):  
   Atomically batch-applies all pending proposals targeting the active Markdown document sequentially, recalculating offsets after each acceptance.

---

## 7. Settings Reference

Accessible via **Settings -> Community plugins -> AI Proposals**:

| Setting Name | Key | Type | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| **Wzorzec plików bufora** | `bufferPattern` | `string` | `"ai_suggestion-*.json"` | Wildcard pattern identifying suggestion buffer files anywhere in the vault. |
| **Katalog buforów** | `bufferDirectory` | `string` | `""` (all vault) | Restricts buffer search to a designated folder (e.g. `.buffers/`). |
| **Tolerancja auto-snap** | `autoSnapRadius` | `number` | `5` | Maximum lines scanned above and below target line ($\pm 5$) when searching for drifted anchor text. |
| **Automatyczne otwieranie panelu** | `autoOpenSidebar` | `boolean` | `false` | Automatically opens right sidebar upon plugin load if pending proposals exist. |
| **Licznik w pasku stanu** | `showStatusBarCounter` | `boolean` | `true` | Displays proposal badge in the desktop Obsidian status bar. |
| **Automatyczne usuwanie buforów** | `deleteEmptyBufferFiles` | `boolean` | `true` | Safely removes suggestion JSON files from vault once all contained proposals have been applied or rejected. |

---

## 8. In-Depth Technical Documentation

For developers, architects, and engineers learning TypeScript and the Obsidian API, the repository includes a comprehensive documentation suite in the `docs/` folder:

- **[AI Agent Integration & Prompt Guide (`docs/agent-integration.md`)](docs/agent-integration.md)**:  
  Step-by-step tutorial on how external AI models (Agy, Claude, Copilot, Droid, scripts) can generate valid proposal buffers without directly modifying Markdown files. Ready-to-use prompt template in [`prompts/agent-prompt.md`](prompts/agent-prompt.md).

- **[System Architecture Guide (`docs/architecture.md`)](docs/architecture.md)**:  
  Detailed ASCII component topology, reactive data flows, 350ms write-lock debounce engine, pure coordinate math ($\Delta_{\text{ch}}$, $\Delta_{\text{lines}}$, auto-snap search $\pm 5$ lines, interval collision resolution), UI architecture, and Architectural Decision Records (ADR-001 through ADR-006).

- **[TypeScript & CodeMirror 6 Masterclass (`docs/typescript-guide.md`)](docs/typescript-guide.md)**:  
  Educational guide covering strict TypeScript (`strict: true`, zero `any`), typing Obsidian APIs (`App`, `Vault`, `WorkspaceLeaf`, `ItemView`, `EventRef`), CodeMirror 6 extension architecture (`ViewPlugin`, `Decoration.mark` vs `widget`, `RangeSetBuilder` ordering, microtask state effects), headless Vitest testing with custom DOM shim, and mobile sandbox safety.

- **[Docker Development & Container Workflow (`docs/docker-workflow.md`)](docs/docker-workflow.md)**:  
  Containerization guide detailing cloud sync protection on iCloud Drive / OneDrive, named volume shadowing mechanics, full `dev.ps1` CLI reference, CI/CD GitHub Actions workflows (`build.yml`, `release.yml`), and container debugging strategies.

---

## License

MIT License. Copyright (c) 2026 Mikołaj. Built for the Obsidian community and AI autonomous workflows.
