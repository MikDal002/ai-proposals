# TypeScript Guide & Architecture Masterclass
**AI Proposals Obsidian Plugin (`ai-proposals`)**

Welcome to the technical TypeScript guide for **AI Proposals**. This guide is written for software engineers who want to master modern, strict TypeScript in the context of complex Obsidian plugins and CodeMirror 6 extensions.

---

## 1. Strict TypeScript Configuration (`tsconfig.json`)

Developing enterprise-grade Obsidian plugins requires eliminating runtime errors at compile time. In AI Proposals, TypeScript is configured in ultra-strict mode.

### 1.1 The Compiler Configuration
Here is the production `tsconfig.json` used by the project:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "node",
    "lib": ["DOM", "ES2022"],
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "exactOptionalPropertyTypes": false,
    "allowSyntheticDefaultImports": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    },
    "types": [
      "node",
      "vitest/globals"
    ]
  },
  "include": [
    "src/**/*.ts",
    "tests/**/*.ts",
    "esbuild.config.mjs",
    "vitest.config.ts"
  ],
  "exclude": [
    "node_modules",
    "dist"
  ]
}
```

### 1.2 Anatomy of Key Compiler Flags
- `"strict": true`: Enables a broad suite of type-checking behaviors:
  - `noImplicitAny`: Disallows expressions and declarations with an implied `any` type.
  - `strictNullChecks`: `null` and `undefined` are treated as distinct types. A variable of type `string` cannot hold `null`. This eradicates the infamous `TypeError: Cannot read properties of undefined`.
  - `strictFunctionTypes`: Disallows bivariant parameter checking for function signatures.
  - `strictBindCallApply`: Verifies that `bind`, `call`, and `apply` invocations match the underlying function parameters.
  - `strictPropertyInitialization`: Ensures class member variables are either initialized inline or in the `constructor`. (When initializing inside Obsidian's async `onload()`, use the definite assignment assertion operator `!:`, e.g., `public store!: ProposalStore;`).
- `"noEmit": true`: Transpilation and bundling are handled entirely by `esbuild`. TypeScript is invoked strictly as a static type analyzer (`npm run typecheck` runs `tsc --noEmit`). This separation ensures blazing-fast builds while retaining 100% type safety.
- `"baseUrl": "."` and `"paths": { "@/*": ["src/*"] }`: Configures clean path aliases, preventing messy relative imports like `../../store/proposal-store`.

### 1.3 The Zero `any` Rule and Type Narrowing
In this codebase, `any` is strictly prohibited. When data shapes are unknown (such as parsing external JSON buffers), use `unknown` combined with custom Type Guards:

```typescript
// Type guard for dictionary objects
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Ingesting dynamic JSON without any
export function extractRawItems(parsedJson: unknown): RawProposalItem[] {
  if (!parsedJson || typeof parsedJson !== "object") {
    return [];
  }
  if (Array.isArray(parsedJson)) {
    return parsedJson.filter(isRecord);
  }
  const obj = parsedJson as Record<string, unknown>;
  if (Array.isArray(obj.proposals)) {
    return obj.proposals.filter(isRecord);
  }
  return [];
}
```

---

## 2. Typing Obsidian APIs

Obsidian exposes a rich, object-oriented API via the `obsidian` package. Navigating its class hierarchies and lifecycle patterns requires precise typing.

### 2.1 The Obsidian Object Hierarchy
```text
App (Root Application Instance)
├── vault (Vault: Filesystem abstraction, CRUD, events)
└── workspace (Workspace: UI layout, leaves, views, active file)
    ├── leftSplit, rightSplit, rootSplit
    └── WorkspaceLeaf (Individual tab/pane container)
        └── view (View / ItemView / MarkdownView)
```

### 2.2 Typing Vault Operations (`Vault`, `TFile`, `TAbstractFile`)
Obsidian differentiates between files (`TFile`) and folders (`TFolder`) using polymorphic inheritance from `TAbstractFile`. Always narrow before performing file operations:

```typescript
import { App, TFile, TAbstractFile, normalizePath } from "obsidian";

async function readNoteSafely(app: App, pathStr: string): Promise<string | null> {
  const normPath = normalizePath(pathStr);
  const abstractFile: TAbstractFile | null = app.vault.getAbstractFileByPath(normPath);

  // Type narrowing: ensure abstract file is an actual Markdown note
  if (!abstractFile || !(abstractFile instanceof TFile)) {
    return null;
  }

  if (abstractFile.extension !== "md") {
    return null;
  }

  // abstractFile is strictly typed as TFile here
  return await app.vault.read(abstractFile);
}
```

### 2.3 Managing Leaves and Sidebar Views (`WorkspaceLeaf`, `ItemView`)
The proposals sidebar extends Obsidian's `ItemView`. To register and activate custom views:

```typescript
import { ItemView, WorkspaceLeaf, App } from "obsidian";

export const VIEW_TYPE_PROPOSAL_SIDEBAR = "ai-proposals-sidebar";

export class ProposalSidebarView extends ItemView {
  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_PROPOSAL_SIDEBAR;
  }

  getDisplayText(): string {
    return "AI Proposals";
  }

  getIcon(): string {
    return "sparkles";
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createDiv({ cls: "ai-sidebar-container", text: "Proposals panel loaded." });
  }

  async onClose(): Promise<void> {
    // Teardown DOM and store listeners
  }
}
```

Activating the leaf safely:
```typescript
async function activateSidebar(app: App): Promise<WorkspaceLeaf | null> {
  const { workspace } = app;
  let leaf: WorkspaceLeaf | null = null;
  const existing = workspace.getLeavesOfType(VIEW_TYPE_PROPOSAL_SIDEBAR);

  if (existing.length > 0) {
    leaf = existing[0];
  } else {
    leaf = workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({
        type: VIEW_TYPE_PROPOSAL_SIDEBAR,
        active: true,
      });
    }
  }

  if (leaf) {
    workspace.revealLeaf(leaf);
  }
  return leaf;
}
```

### 2.4 Event Lifecycle & Leak Prevention (`EventRef`, `offref`)
Obsidian uses the `EventRef` token pattern for event listener management. Failing to clean up event listeners results in memory leaks and stale closure bugs when plugins are disabled or reloaded.

```typescript
import { EventRef, Plugin, WorkspaceLeaf } from "obsidian";

export default class LifecycleExamplePlugin extends Plugin {
  private eventRefs: EventRef[] = [];

  async onload(): Promise<void> {
    // Method 1: Using Plugin.registerEvent (Automated teardown on plugin unload)
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        console.log("File modified:", file.path);
      })
    );

    // Method 2: Manual tracking (When fine-grained manual unbinding is needed)
    const ref = this.app.workspace.on("active-leaf-change", (leaf: WorkspaceLeaf | null) => {
      this.handleLeafChange(leaf);
    });
    this.eventRefs.push(ref);
  }

  private handleLeafChange(leaf: WorkspaceLeaf | null): void {
    // Process leaf change
  }

  onunload(): void {
    // Explicitly unbind all manually registered EventRefs
    for (const ref of this.eventRefs) {
      this.app.workspace.offref(ref);
    }
    this.eventRefs = [];
  }
}
```

### 2.5 Settings Tab & Fluent Builders (`PluginSettingTab`, `Setting`)
Obsidian settings tabs use a fluent builder pattern via the `Setting` class:

```typescript
import { App, PluginSettingTab, Setting } from "obsidian";
import type AIProposalsPlugin from "./main";

export class AIProposalsSettingTab extends PluginSettingTab {
  constructor(app: App, public readonly plugin: AIProposalsPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "AI Proposals Settings" });

    new Setting(containerEl)
      .setName("Buffer Pattern")
      .setDesc("Glob pattern for AI suggestion buffer files")
      .addText((text) => {
        text
          .setPlaceholder("ai_suggestion-*.json")
          .setValue(this.plugin.settings.bufferPattern)
          .onChange(async (value) => {
            this.plugin.settings.bufferPattern = value.trim();
            await this.plugin.saveSettings();
          });
      });
  }
}
```

---

## 3. CodeMirror 6 Architecture & Types

Obsidian v1.0+ utilizes CodeMirror 6 (CM6) for both Live Preview and Source Mode. CM6 is built on functional, immutable architecture: the document state (`EditorState`) is never mutated in place; updates produce a new state via `Transaction`.

### 3.1 Core CM6 Primitives
| Type | Purpose |
|---|---|
| `EditorView` | Top-level visual component managing the editor DOM and dispatch cycle. |
| `EditorState` | Immutable snapshot of document content, selection, and extensions. |
| `ViewPlugin` | Stateful extension tied to an `EditorView` instance. Receives `update(update: ViewUpdate)`. |
| `Decoration` | Visual styling applied to the document (marks, widgets, replace, line). |
| `RangeSetBuilder` | High-performance generator used to construct a `DecorationSet`. |
| `StateEffect` | Typed communication channel for dispatching custom events into CM6. |
| `StateField` | Extension that stores and persists custom state within `EditorState`. |

### 3.2 The Decoration System: Marks vs. Widgets
CM6 provides two critical decoration types for inline modifications:

1. **`Decoration.mark`**: Wraps a range of text `[from, to]` in an HTML tag (such as `<span class="ai-proposal-mark">`).
   - **CRITICAL CONSTRAINT**: Marks require `from < to`. If `from === to`, CM6 throws an uncatchable `RangeError: RangeSet error: Invalid range`.
2. **`Decoration.widget`**: Embeds a custom DOM element at a zero-length position `from === to`.
   - Used for **Pure Insertions** (when an AI suggests adding new text at a cursor point where `original.length === 0`).

```typescript
import { Decoration, WidgetType } from "@codemirror/view";
import type { Proposal } from "../types";

// Custom Widget for pure insertions
export class ProposalInsertionWidget extends WidgetType {
  constructor(public readonly proposal: Proposal) {
    super();
  }

  // CM6 uses eq() to avoid re-rendering DOM if widget data hasn't changed
  eq(other: ProposalInsertionWidget): boolean {
    return other.proposal.id === this.proposal.id &&
           other.proposal.replacement === this.proposal.replacement;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "ai-proposal-insertion-marker ai-proposal-mark-zero";
    span.setAttribute("data-proposal-id", this.proposal.id);
    span.textContent = "‸";
    span.title = `Insert: ${this.proposal.replacement}`;
    return span;
  }
}
```

### 3.3 Constructing `DecorationSet` with `RangeSetBuilder`
`RangeSetBuilder` builds decorations in $O(N)$ time, but enforces strict mathematical invariants:
1. Every range `from` offset must be $\ge$ the previous range's `from` offset (monotonic ordering).
2. If `from` offsets are equal, `to` offsets must be in ascending order.
3. Mark ranges cannot overlap in contradictory ways.

```typescript
import { RangeSetBuilder, Text } from "@codemirror/state";
import { Decoration, DecorationSet } from "@codemirror/view";
import type { Proposal } from "../types";

interface ResolvedRange {
  from: number;
  to: number;
  proposal: Proposal;
}

export function buildProposalDecorations(
  doc: Text,
  proposals: Proposal[],
  resolveCoordinates: (doc: Text, p: Proposal) => ResolvedRange | null
): DecorationSet {
  if (proposals.length === 0) return Decoration.none;

  // 1. Resolve proposals to absolute character offsets
  const resolvedList = proposals
    .map((p) => resolveCoordinates(doc, p))
    .filter((r): r is ResolvedRange => r !== null);

  // 2. Monotonic sort: ascending by 'from', then by 'to'
  resolvedList.sort((a, b) => a.from - b.from || a.to - b.to);

  // 3. Build RangeSet with collision filtering
  const builder = new RangeSetBuilder<Decoration>();
  let lastTo = -1;
  let lastZeroPos = -1;

  for (const item of resolvedList) {
    const isZero = item.from === item.to;

    // Filter interval collision: starts before previous range ends
    if (item.from < lastTo) continue;

    // Filter duplicate zero-length widgets at exact same position
    if (isZero && item.from === lastZeroPos) continue;

    if (isZero) {
      builder.add(
        item.from,
        item.to,
        Decoration.widget({
          widget: new ProposalInsertionWidget(item.proposal),
          side: 1,
        })
      );
      lastZeroPos = item.from;
    } else {
      builder.add(
        item.from,
        item.to,
        Decoration.mark({
          class: "ai-proposal-mark",
          attributes: { "data-proposal-id": item.proposal.id },
        })
      );
      lastTo = item.to;
      lastZeroPos = -1;
    }
  }

  return builder.finish();
}
```

### 3.4 Disagreeing with Re-entrant Loops: StateEffect & microtask
When external stores (e.g. `ProposalStore`) update, the editor view must be signaled to recompute its decorations. Direct synchronous dispatches during another dispatch phase cause CM6 errors. Solution: dispatch a custom `StateEffect` deferred to a microtask.

```typescript
import { StateEffect } from "@codemirror/state";
import { PluginValue, ViewUpdate, EditorView } from "@codemirror/view";
import type { IProposalStore } from "../types";

export const refreshProposalsEffect = StateEffect.define<void>();

export class ProposalPluginValue implements PluginValue {
  constructor(private view: EditorView, private store: IProposalStore) {
    this.store.onStoreChange(() => {
      // Defer to microtask to prevent re-entrant dispatch collisions
      queueMicrotask(() => {
        try {
          this.view.dispatch({
            effects: refreshProposalsEffect.of(),
          });
        } catch (err) {
          console.warn("View destroyed or unmounted", err);
        }
      });
    });
  }

  update(update: ViewUpdate): void {
    const hasRefreshEffect = update.transactions.some((tr) =>
      tr.effects.some((e) => e.is(refreshProposalsEffect))
    );

    if (update.docChanged || update.viewportChanged || hasRefreshEffect) {
      this.recomputeDecorations(update.view);
    }
  }

  private recomputeDecorations(view: EditorView): void {
    // Rebuild decorations and update editor view state
  }

  destroy(): void {
    // Unbind listeners
  }
}
```

---

## 4. Headless Testing Architecture

Obsidian plugins typically require Electron or JSDOM to test. However, spinning up Electron is slow, fragile, and impossible in lightweight CI containers.

In `ai-proposals`, we employ a **Headless Mock Architecture** running on pure Node.js in Vitest.

### 4.1 Vitest Alias Configuration (`vitest.config.ts`)
```typescript
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node", // Pure Node.js! No jsdom overhead.
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
  },
  resolve: {
    alias: {
      obsidian: path.resolve(__dirname, "tests/mocks/obsidian.ts"),
      "@": path.resolve(__dirname, "src"),
    },
  },
});
```

### 4.2 In-Memory Mock Vault Pattern
The mock vault in `tests/mocks/obsidian.ts` implements the public `Vault` contract backed by an in-memory `Map<string, string>`:

```typescript
import { normalizePath, TFile, Vault } from "obsidian";

export class MockVault {
  private fileContents = new Map<string, string>();
  private fileObjects = new Map<string, TFile>();

  seedFile(pathStr: string, content: string): TFile {
    const norm = normalizePath(pathStr);
    const file = new TFile(norm, this as unknown as Vault);
    this.fileContents.set(norm, content);
    this.fileObjects.set(norm, file);
    return file;
  }

  async read(file: TFile): Promise<string> {
    const content = this.fileContents.get(file.path);
    if (content === undefined) throw new Error("File not found");
    return content;
  }

  async modify(file: TFile, data: string): Promise<void> {
    this.fileContents.set(file.path, data);
  }
}
```

### 4.3 Lightweight Headless DOM Shim
For testing DOM-dependent logic (popover layout, coordinate bounding rect math, diff preview generation), we utilize a custom headless element tree (`HeadlessElement`) that executes synchronously in Node without the 50MB overhead of jsdom:

```typescript
export class HeadlessElement {
  nodeType = 1;
  tagName: string;
  className = "";
  children: HeadlessElement[] = [];
  parentNode: HeadlessElement | null = null;
  attributes = new Map<string, string>();

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  appendChild<T extends HeadlessElement>(child: T): T {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  getBoundingClientRect() {
    return { top: 100, bottom: 120, left: 200, right: 300, width: 100, height: 20 };
  }
}
```

---

## 5. Mobile Compatibility Constraints (`isDesktopOnly: false`)

Obsidian plugins can run on iOS and Android. However, mobile devices do **not** run in a Node.js process; they run inside mobile web views (WebKit on iOS, Chromium WebView on Android).

### 5.1 The Golden Rule: Zero Node.js Runtime Imports
**Never** import Node.js built-ins in runtime plugin code:
- ❌ `import fs from "fs";`
- ❌ `import path from "path";`
- ❌ `import os from "os";`
- ❌ `import { exec } from "child_process";`

If any Node.js module is imported, the plugin will crash immediately on mobile with `Uncaught ReferenceError: process is not defined` or `Cannot find module 'fs'`.

### 5.2 Obsidian Substitutes for Node.js APIs
| Node.js Built-in | Obsidian Public API Replacement |
|---|---|
| `path.normalize(p)` | `normalizePath(p)` from `obsidian` |
| `path.join(a, b)` | Template literals + `normalizePath(`${a}/${b}`)` |
| `fs.readFile(p)` | `app.vault.read(file)` |
| `fs.writeFile(p, d)` | `app.vault.modify(file, d)` or `app.vault.create(p, d)` |
| `fs.unlink(p)` | `app.vault.delete(file)` |
| `fs.watch(p)` | `app.vault.on("modify" | "create" | "delete", cb)` |

### 5.3 Safe Feature Detection (`Platform`)
Use Obsidian's `Platform` helper to conditionally mount platform-dependent features:

```typescript
import { Platform } from "obsidian";
import type AIProposalsPlugin from "./main";

export function setupStatusBar(plugin: AIProposalsPlugin): void {
  // Mobile Obsidian does not possess a desktop-style status bar!
  if (Platform.isMobile) {
    return;
  }

  const statusBarEl = plugin.addStatusBarItem();
  statusBarEl.setText("✨ AI Proposals");
}
```

### 5.4 Touch Event Safety and Virtual Keyboards
On mobile touchscreens, tapping floating buttons can cause the on-screen keyboard to blur and collapse, disrupting user flow. In `PopoverManager`, we intercept pointer events to maintain focus:

```typescript
export function preventMobileKeyboardBlur(button: HTMLElement): void {
  button.addEventListener("pointerdown", (evt) => {
    // Prevents soft keyboard collapse without canceling synthetic click events
    evt.preventDefault();
  });
  button.addEventListener("mousedown", (evt) => {
    evt.preventDefault();
  });
}
```
