# System Architecture & Technical Specifications
**AI Proposals Obsidian Plugin (`ai-proposals`)**

---

## 1. System Overview & Component Topology

The **AI Proposals** plugin acts as an asynchronous, non-destructive bridge between external AI agents and the user's Obsidian Markdown vault. External AI agents (such as Antigravity/Agy, Copilot, Claude, Droid, or autonomous scripts) emit atomic suggestion envelopes to JSON buffer files. The plugin monitors these buffers via vault events, calculates spatial coordinates and shifts in-memory, and provides rich in-editor and sidebar review interfaces.

### 1.1 ASCII Component Topology

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                           External AI Agents                                │
│           (Antigravity / Agy, Claude, Copilot, Droid, Custom Scripts)       │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ Generates atomic JSON buffers
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Obsidian Vault File System                          │
│               ai_suggestion-01.json, ai_suggestion-02.json, ...             │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ Vault Events (create, modify, delete, rename)
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                 ProposalStore (`src/store/proposal-store.ts`)               │
│  - Vault File Watcher & Glob Matcher (`matchesBufferPattern`)               │
│  - Envelope Extractor (`extractRawItems`) & Normalizer                      │
│  - Write-Lock Cooldown Engine (350ms Debounce & Event Suppression)          │
│  - Collision Filter & Reentrancy Mutex (`mutatingProposals`)                │
└───────┬──────────────────────────────┬───────────────────────────────┬──────┘
        │                              │                               │
        │ Coordinates                  │ Proposals                     │ Proposals
        ▼                              ▼                               ▼
┌────────────────────────┐  ┌─────────────────────────┐  ┌────────────────────────┐
│  Coordinate Math Engine│  │ CodeMirror 6 Extension  │  │  Two-Tier Sidebar View │
│(`store/coordinate-math`)│  │(`editor/proposal-view`) │  │(`ui/proposal-sidebar`) │
│ - DeltaShift Math      │  │ - Decoration.mark (wavy)│  │ - Tier 1: Active Note  │
│ - findClosestOccurrence│  │ - Decoration.widget (‸) │  │ - Tier 2: Vault Accord.│
│ - findInNeighborhood   │  │ - editorInfoField Guard │  │ - Quadruple Leaf Shield│
│ - Interval Collisions  │  │ - refreshProposalsEffect│  │ - 3-Tier Jump-to-Line  │
└────────────────────────┘  └────────────┬────────────┘  └────────────────────────┘
                                         │ Click Event
                                         ▼
                            ┌─────────────────────────┐
                            │     PopoverManager      │
                            │(`editor/popover-manager`)│
                            │ - Fixed Body Mount      │
                            │ - Viewport Clamping     │
                            │ - Inline Diff Rendering │
                            │ - Mobile Blur Trap      │
                            └─────────────────────────┘
```

### 1.2 Module Boundary Directory Map

```text
src/
├── types/
│   └── index.ts                 # Strict domain contracts, Proposal, Settings, Deltas
├── store/
│   ├── coordinate-math.ts       # Pure mathematical shift and collision functions
│   └── proposal-store.ts        # Reactive store, JSON ingestion, 350ms write-lock
├── editor/
│   ├── proposal-view-plugin.ts  # CodeMirror 6 ViewPlugin, DecorationSet builder, Widget
│   └── popover-manager.ts       # Viewport clamping, floating popover, diff generator
├── ui/
│   ├── proposal-sidebar-view.ts # ItemView sidebar, two-tier grouping, leaf-change shield
│   └── status-bar.ts            # Desktop status bar item, Polish grammar inflection
├── settings/
│   └── settings-tab.ts          # PluginSettingTab, slider/input validation
└── main.ts                      # 10-phase onload bootstrap & 4-phase teardown coordinator
```

---

## 2. Reactive Data Flow & State Management

### 2.1 Ingestion Pipeline
1. **Discovery**: On startup or on vault file events (`create`, `modify`, `delete`, `rename`), `scanVaultBuffers()` iterates over `vault.getFiles()`, filtering for files whose extension is `"json"` and whose paths match the buffer pattern (default: `ai_suggestion-*.json` or legacy `_agy_suggestions.json`).
2. **Envelope Extraction**: `extractRawItems(parsedJson)` flexibly extracts suggestions whether formatted as a flat array, wrapped in `{ proposals: [...] }` or `{ suggestions: [...] }`, provided as a single proposal object, or keyed by target file path in a dictionary.
3. **Normalization**: `normalizeProposalItem` validates paths via `normalizePath()`, parses 1-indexed lines and 0-indexed column bounds, assigns fallback timestamps and IDs if missing, and generates a globally unique namespaced compound ID:
   $$\text{compoundId} = \text{sourceFilePath} + \text{"::"} + \text{id} + \text{"#"} + \text{index}$$
4. **Collision Suppression**: In-memory candidates for each `file:line` are sorted by start column and passed through `hasIntervalCollision()`. Overlapping proposals are discarded to guarantee CodeMirror RangeSet monotonic invariants.
5. **Broadcast**: `notifyListeners()` emits an immutable state snapshot to registered listeners (`ProposalPluginValue`, `PopoverManager`, `ProposalSidebarView`, `ProposalStatusBarItem`).

### 2.2 The 350ms Write-Lock & Anti-Loop Cooldown Engine
**The Problem**: When the plugin accepts a proposal, it writes modified text to the target `.md` note and removes the entry from the source `.json` buffer. Without safeguards, Obsidian's vault watcher triggers `modify` events for both files, causing re-entrant rescan cycles, UI flickering, and cursor position loss.

**The Solution**:
- **Execution under Write-Lock** (`executeWithWriteLock(filePath, op)`):
  1. Add `normalizePath(filePath)` to `activeWriteLocks` Set.
  2. Record current timestamp in `writeCooldowns` Map.
  3. Execute disk mutation via `vault.process()` (or `vault.modify()`).
  4. Cache `lastSavedMtime`, `lastSavedSize`, and `lastSavedContent`.
  5. The `finally` block removes the lock from `activeWriteLocks` and schedules rescan suppression for 350ms (`WRITE_COOLDOWN_MS = 350`).
- **Event Suppression Matrix**:
  | Vault Event | Condition Checked | Action Taken |
  | :--- | :--- | :--- |
  | `modify` | `activeWriteLocks.has(path)` | **Strict Ignore**: Self-induced write in-flight. |
  | `modify` | `Date.now() - writeCooldowns.get(path) < 350ms` | Check `mtime`, `size`, and content. If identical to last saved, suppress. If externally changed, enqueue in `pendingRescans`. |
  | `delete` | Source buffer removed | Cleanly filter out proposals associated with `sourceFile` from in-memory state. |
  | `rename` | Buffer or note path changed | Seamlessly re-target in-memory `sourceFile` or `file` references and broadcast update. |

### 2.3 Atomic Note Mutation Workflow (`acceptProposal`)

```text
[User clicks "Zastosuj" in Popover or Sidebar]
                │
                ▼
  [Check mutatingProposals mutex guard] (prevents concurrent double-clicks)
                │
                ▼
  [Read note content via vault.read(targetFile)]
                │
                ▼
  [resolveTargetRange(lines, proposal, radius)]
   ├── Check exact coordinates on line (lineIndex, fromCh, toCh)
   ├── Fallback: intra-line search via findClosestOccurrence
   └── Fallback: neighborhood search ±radius lines (alternating +1, -1, +2, -2)
                │
                ▼
  [patchContent(content, range, replacement)]
   ├── Slice line prefix [0, fromCh)
   ├── Spliced replacement string
   └── Slice line suffix [toCh, len)
                │
                ▼
  [executeWithWriteLock(targetFile.path, async () => vault.process(...))]
                │
                ▼
  [shiftProposalsAfterAcceptance(remainingProposals, appliedSnapshot)]
   ├── Preceding lines: untouched
   ├── Intermediate lines (multi-line original): mark 'conflict'
   ├── Subsequent lines: line += deltaLines, resolvedFrom/To += deltaTotalChars
   └── Same line: deltaCh shift or tail push to targetLine + K
                │
                ▼
  [removeProposalFromSourceFile(proposal)]
   ├── Filter item from raw JSON structure
   ├── If 0 proposals remain and deleteEmptyBufferFiles is true -> vault.delete(sourceFile)
   └── Otherwise -> write updated serialized JSON under write-lock
                │
                ▼
  [notifyListeners()] (CM6 refreshes decorations, sidebar updates, popover hides)
```

---

## 3. Pure Coordinate Math Engine (`coordinate-math.ts`)

### 3.1 Mathematical Shift Formulae
Given an accepted proposal with original text $O$ and replacement text $R$:
- Let $O_{\text{lines}} = \text{split}(O, \text{newline})$ with count $M + 1$ (where $M$ is the number of newline characters removed).
- Let $R_{\text{lines}} = \text{split}(R, \text{newline})$ with count $K + 1$ (where $K$ is the number of newline characters added).
- **Vertical Line Shift**:
  $$\Delta_{\text{lines}} = K - M$$
- **Horizontal Column Shift** (on anchor line):
  $$\Delta_{\text{ch}} = \begin{cases} \text{len}(R) - \text{len}(O) & \text{if } M = 0 \text{ and } K = 0 \\ \text{len}(R_{\text{lines}}[0]) - \text{len}(O_{\text{lines}}[0]) & \text{if } K > 0 \text{ or } M > 0 \end{cases}$$

### 3.2 Proposal Relocation on Multi-Line Expansion
When a single-line text segment is replaced with $K > 0$ multiple lines:
- Any succeeding proposal on the anchor line ($p_{\text{from}} \ge \text{acc}_{\text{toCh}}$) with relative distances $d_{\text{from}} = p_{\text{from}} - \text{acc}_{\text{toCh}}$ and $d_{\text{to}} = p_{\text{to}} - \text{acc}_{\text{toCh}}$ is **pushed downward** to line:
  $$p'_{\text{line}} = p_{\text{line}} + K$$
- Its new character columns become:
  $$p'_{\text{from}} = \text{len}(R_{\text{lines}}[K]) + d_{\text{from}}, \quad p'_{\text{to}} = \text{len}(R_{\text{lines}}[K]) + d_{\text{to}}$$

### 3.3 Multi-Line Replacement Intermediate Invalidation
When an accepted proposal spans multiple original lines ($M > 0$):
- Any other proposal targeting lines strictly between the anchor line and the end of the replaced block ($L < p_{\text{line}} \le L + M$) has its target text destroyed.
- The engine marks these proposals with `status = 'conflict'` and `rejectionReason = "Overlapped with accepted multi-line proposal..."`.

### 3.4 Interval Collision Math (`hasIntervalCollision`)
For two half-open intervals $A = [a_1, a_2)$ and $B = [b_1, b_2)$:
- **Standard Range Overlap**:
  $$\text{Overlaps}(A, B) \iff \max(a_1, b_1) < \min(a_2, b_2)$$
- **Strictly Abutting Ranges** ($\min(a_2, b_2) = \max(a_1, b_1)$): **No collision** (e.g. $[0, 5)$ and $[5, 10)$ do not collide).
- **Pure Insertions** ($a_1 = a_2$ or $b_1 = b_2$):
  - Two zero-length insertions at the exact same column: **Collide** ($a_1 = b_1$).
  - Zero-length insertion strictly inside a range ($b_1 < a_1 < b_2$): **Collides**.
  - Zero-length insertion abutting the boundary of a range ($a_1 = b_1$ or $a_1 = b_2$): **Does NOT collide**.

### 3.5 Anchor Drift Compensation & Neighborhood Search (`findInNeighborhood`)
When a document is edited by the user prior to reviewing proposals, anchor positions drift:
1. **Tier 1 (Exact)**: Check `lineText.substring(fromCh, toCh) === original`.
2. **Tier 2 (Intra-line Auto-Snap)**: `findClosestOccurrence(lineText, original, expectedCh)` computes $d(idx) = |idx - expectedCh|$ and returns the index minimizing distance. Ties deterministically favor earlier indices.
3. **Tier 3 (Inter-line Neighborhood Search)**: Scans adjacent lines outward in alternating sequence ($+1, -1, +2, -2, \dots, \pm \text{radius}$). Returns `SnappedLocation` with `distance` and `matchType = 'snapped-neighbor'`.
4. **Visual Indicator**: Snapped proposals are assigned CSS class `.ai-proposal-mismatch` (amber dashed underline) alerting the author to drift.

---

## 4. UI Architecture & Interaction Design

### 4.1 CodeMirror 6 `ViewPlugin` (`src/editor/proposal-view-plugin.ts`)
- **Leaf Isolation via `editorInfoField`**:  
  `view.state.field(editorInfoField, false)` queries Obsidian's editor context. If the leaf is not editing a Markdown file (`.md`) matching `proposal.file`, `buildProposalDecorations()` returns `Decoration.none`. This prevents cross-file decoration leakage when multiple split panes are active.
- **Monotonic Range Ordering**:  
  CM6's `RangeSetBuilder` throws fatal errors if additions are not strictly ordered by ascending start offset (`from`) and non-overlapping. The plugin:
  1. Resolves all proposals to absolute document offsets.
  2. Sorts candidates by `a.from - b.from || a.to - b.to`.
  3. Skips any proposal where `candidate.from < lastTo`.
- **Pure Insertion Widget (`ProposalInsertionWidget`)**:  
  Zero-length marks ($from = to$) trigger CM6 RangeErrors. Instead, pure insertions instantiate a custom `WidgetType` rendered as an inline caret (`‸`, `.ai-proposal-insertion-caret`) with `side: 1`.

### 4.2 Floating Popover UI (`src/editor/popover-manager.ts`)
- **Fixed Mounting**: Mounted directly to `document.body` with `position: fixed` and `z-index: 1000`, bypassing editor container `overflow: hidden` and scrolling boundary clips.
- **Boundary Clamping Math (`computePopoverPosition`)**:
  - Horizontal: Clamped within $[margin, viewportWidth - popoverWidth - margin]$.
  - Vertical: Prefers placement below anchor ($anchor.bottom + gap$). If insufficient space, flips above ($anchor.top - popoverHeight - gap$). If constrained on both sides, picks the side with greatest clearance.
- **Virtual Keyboard & Focus Preservation (`preventMobileBlur`)**:  
  On mobile devices, tapping an action button causes virtual keyboards to collapse and shifts focus away from the editor. Popover action buttons intercept `pointerdown` and `mousedown` with `evt.preventDefault()`, preserving editor selection while allowing standard synthetic click execution.
- **Auto-Dismissal Triggers**:  
  The popover automatically unmounts on:
  1. Pointer click outside the popover card and highlights.
  2. Pressing the `Escape` key (refocuses editor).
  3. Scrolling in the editor viewport (`view.scrollDOM` listener).
  4. Document modifications (`update.docChanged`).
  5. Proposal status transition in the external store.

### 4.3 Two-Tier Sidebar ItemView (`src/ui/proposal-sidebar-view.ts`)
- **Quadruple Shield against `active-leaf-change` Bug**:  
  Obsidian triggers `active-leaf-change` whenever a user clicks into a sidebar leaf. Naive implementations re-render the view, causing focus loss, unmounted inputs, and double-click race conditions.
  - *Shield 1*: Ignore event if `leaf.view.getViewType() === "ai-proposals-sidebar"`.
  - *Shield 2*: Verify active file path strictly changed (`currentPath !== lastActiveFilePath`).
  - *Shield 3*: Coalesce rapid event bursts using `requestAnimationFrame`.
  - *Shield 4*: Capture and restore `contentEl.scrollTop` across renders.
- **Triple-Guard Concurrency Mutex**:  
  Prevents rapid double-clicks from firing duplicate mutations:
  - *Guard 1*: Card element tracks `is-processing` and button sets `disabled = true` with `is-loading`.
  - *Guard 2*: Component maintains in-flight `processingIds` Set.
  - *Guard 3*: Store maintains global `mutatingProposals` Set rejecting duplicate compound IDs.
- **3-Tier Editor Resolution for Jump-to-Line Navigation**:  
  When clicking "Pokaż" or a proposal card:
  - *Tier 1*: Search open workspace leaves (`workspace.getLeavesOfType("markdown")`) for an existing tab with `file.path === proposal.file`.
  - *Tier 2*: If not open, call `workspace.openLinkText(proposal.file, "", false)` to load the note.
  - *Tier 3*: Set active leaf focus, scroll cursor into view (`editor.scrollIntoView`), and highlight target characters (`editor.setSelection`).

---

## 5. Mobile Platform Safety & Zero Node Imports

### 5.1 Audit Findings & Portability
- **AST Audit**: The production codebase contains **zero** imports of Node.js runtime built-ins: no `fs`, `path`, `os`, `child_process`, `crypto`, `stream`, or `events`.
- **Vault Abstraction**: All filesystem operations are mediated exclusively through Obsidian's public `App.vault` API (`vault.read`, `vault.modify`, `vault.process`, `vault.delete`, `vault.getFiles`).
- **Path Portability**: Path normalization exclusively uses Obsidian's native `normalizePath()`.

### 5.2 Platform Guards (`Platform.isMobile`)
- `manifest.json` declares `"isDesktopOnly": false`.
- Status bar initialization in `src/main.ts` and `src/ui/status-bar.ts` is guarded with `if (Platform.isMobile) return;` since Obsidian Mobile does not provide a desktop status bar.
- CSS stylesheet defines minimum touch target sizes $\ge 44\text{px} \times 44\text{px}$ for all mobile action buttons and accordion headers under `.is-mobile` and `@media (max-width: 768px)`.

---

## 6. Architectural Decision Records (ADRs)

### ADR-001: External JSON Buffer Files vs In-Note Markdown Comments
- **Context**: AI proposals could either be stored as inline HTML comments / markers inside Markdown notes (e.g., `<!-- ai:proposal ... -->`) or as external JSON buffer files.
- **Decision**: Adopt external JSON buffer files (`ai_suggestion-*.json`).
- **Rationale**:
  1. *Note Integrity*: In-note markers pollute source documents, break Obsidian search indexers, and cause Git merge conflicts.
  2. *Safety*: If an author closes Obsidian without reviewing, the notes remain clean.
  3. *Multi-Agent Concurrency*: Different AI agents can emit independent buffer files (`ai_suggestion-agy.json`, `ai_suggestion-copilot.json`) without file lock contention.

### ADR-002: Pure In-Memory Coordinate Math Engine vs Persistent AST Spans
- **Context**: Text modifications alter text offsets. We could either re-parse markdown ASTs on every edit or compute algebraic character and line deltas.
- **Decision**: Implement a pure functional math engine (`src/store/coordinate-math.ts`).
- **Rationale**:
  1. *Performance*: String delta math runs in sub-millisecond time ($< 1\text{ms}$ across hundreds of proposals).
  2. *Zero Dependencies*: Avoids heavy parser libraries (like Remark/Unified) that increase bundle size and degrade mobile load times.
  3. *Determinism*: Pure mathematical functions with 100% unit test coverage guarantee predictable shifts.

### ADR-003: 350ms Write-Lock Cooldown vs Filesystem File Locks
- **Context**: Vault file operations trigger reactive events. We need to prevent self-induced event loops when the plugin accepts a proposal and writes to the note and buffer.
- **Decision**: Implement a 350ms cooldown write-lock mechanism with `mtime` and content caching.
- **Rationale**:
  1. *Cross-Platform Compatibility*: File system locks (e.g. `flock`) are unavailable in Obsidian Mobile's sandboxed environment.
  2. *OS File Event Delay*: Obsidian's internal cache reflection on Windows (NTFS) and mobile can take up to 200–300ms. A 350ms window reliably swallows self-induced echo events while immediately processing genuine external edits.

### ADR-004: CodeMirror 6 `Decoration.widget` for Zero-Length Insertions
- **Context**: CodeMirror 6 throws an uncaught `RangeError` if a `Decoration.mark` is registered with `from === to`. Pure insertions have `original === ""`.
- **Decision**: Dynamically branch in `buildProposalDecorations()`: use `Decoration.mark` for replacements ($from < to$) and `Decoration.widget` (`ProposalInsertionWidget`) for pure insertions.
- **Rationale**: Completely eliminates editor crash risks while giving users a clickable caret anchor (`‸`).

### ADR-005: Fixed Popover Mounting to `document.body` vs CM6 Tooltip Extension
- **Context**: Popovers can be rendered via CodeMirror 6's native tooltip extension or mounted to the DOM root.
- **Decision**: Mount fixed popover directly to `document.body` (`position: fixed`).
- **Rationale**:
  1. *Clipping Prevention*: CM6 tooltips are constrained by editor pane clipping contexts, scroll parents, and split view dividers.
  2. *Mobile Usability*: Fixed popovers allow full-width bottom sheet presentation on narrow phone viewports.
  3. *Z-Index Stacking*: Guarantees the popover floats above Obsidian ribbons, headers, and floating sidebars.

### ADR-006: Named Docker Volume Shadowing for Zero Host Pollution
- **Context**: Standard Docker container volume mounts (`-v .:/app`) map `node_modules` back to the host filesystem, littering the Obsidian vault with tens of thousands of files.
- **Decision**: Use Docker Compose with a named volume shadowing `/app/node_modules`.
- **Rationale**: The named volume mounts *over* the bind mount, keeping `node_modules` isolated inside Docker's Linux filesystem. The host project directory remains 100% clean, safeguarding cloud synchronization.
