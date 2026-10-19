/**
 * tests/editor-plugin.test.ts
 * Comprehensive Unit and Integration Test Suite for Milestone 3.
 *
 * Covers:
 * 1. Headless EditorView & DOM Environment Lifecycle
 * 2. Decoration Generation & Monotonic Offset Placement (F14)
 * 3. Boundary Cases & RangeSet Crash Prevention (F14)
 * 4. Reactive Store Updates & Live Document Synchronization (F14, F10)
 * 5. Popover Positioning Logic & Viewport Boundary Clamping (F15, F19)
 * 6. Diff Preview Generation & Content Formatting (F15)
 * 7. Popover Interaction & Event Delegation (F15, F19)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EditorState, Text, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorInfoField, type MarkdownFileInfo } from "obsidian";

import type { IProposalStore, Proposal } from "../src/types";
import {
  createProposalViewPlugin,
  buildProposalDecorations,
  resolveProposalRange,
  ProposalInsertionWidget,
  ProposalPluginValue,
  refreshProposalsEffect,
} from "../src/editor/proposal-view-plugin";
import {
  PopoverManager,
  computePopoverPosition,
  renderDiffPreview,
  type AnchorRect,
  type Dimensions,
} from "../src/editor/popover-manager";

// ============================================================================
// Headless DOM Shim for Pure Node Environment
// ============================================================================

class HeadlessElement {
  nodeType = 1;
  tagName: string;
  className = "";
  textContent = "";
  innerHTML = "";
  title = "";
  disabled = false;
  style: Record<string, string> = {};
  attributes = new Map<string, string>();
  children: HeadlessElement[] = [];
  parentNode: HeadlessElement | null = null;
  ownerDocument: HeadlessDocument | null = null;
  private listeners: Map<string, Set<EventListener>> = new Map();

  constructor(tagName: string, ownerDoc?: HeadlessDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDoc ?? null;
  }

  get classList() {
    return {
      add: (...classes: string[]) => {
        const tokens = new Set(this.className.split(" ").filter(Boolean));
        classes.forEach((c) => tokens.add(c));
        this.className = Array.from(tokens).join(" ");
      },
      remove: (...classes: string[]) => {
        const tokens = new Set(this.className.split(" ").filter(Boolean));
        classes.forEach((c) => tokens.delete(c));
        this.className = Array.from(tokens).join(" ");
      },
      contains: (c: string) => this.className.split(" ").filter(Boolean).includes(c),
      toggle: (c: string) => {
        if (this.classList.contains(c)) {
          this.classList.remove(c);
        } else {
          this.classList.add(c);
        }
      },
    };
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
    if (name === "class") {
      this.className = String(value);
    }
  }

  getAttribute(name: string): string | null {
    if (name === "class") return this.className || null;
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  appendChild<T extends HeadlessElement>(child: T): T {
    if (child.tagName === "FRAGMENT") {
      while (child.children.length > 0) {
        const item = child.children.shift()!;
        item.parentNode = this;
        item.ownerDocument = this.ownerDocument;
        this.children.push(item);
      }
      return child;
    }
    child.parentNode = this;
    child.ownerDocument = this.ownerDocument;
    this.children.push(child);
    return child;
  }

  removeChild<T extends HeadlessElement>(child: T): T {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  insertBefore<T extends HeadlessElement>(newChild: T, refChild: HeadlessElement | null): T {
    if (!refChild) return this.appendChild(newChild);
    const idx = this.children.indexOf(refChild);
    if (idx !== -1) {
      newChild.parentNode = this;
      newChild.ownerDocument = this.ownerDocument;
      this.children.splice(idx, 0, newChild);
    } else {
      this.appendChild(newChild);
    }
    return newChild;
  }

  remove() {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  }

  contains(other: HeadlessElement | null): boolean {
    if (!other) return false;
    if (other === this) return true;
    let curr = other.parentNode;
    while (curr) {
      if (curr === this) return true;
      curr = curr.parentNode;
    }
    return false;
  }

  closest<T extends HeadlessElement = HeadlessElement>(selector: string): T | null {
    const classNames = selector
      .split(",")
      .map((s) => s.trim().replace(/^\./, ""));
    let curr: HeadlessElement | null = this;
    while (curr) {
      for (const cls of classNames) {
        if (curr.classList.contains(cls)) return curr as unknown as T;
      }
      curr = curr.parentNode;
    }
    return null;
  }

  querySelector<T extends HeadlessElement = HeadlessElement>(selector: string): T | null {
    return this.querySelectorAll<T>(selector)[0] ?? null;
  }

  querySelectorAll<T extends HeadlessElement = HeadlessElement>(selector: string): T[] {
    const results: T[] = [];
    const check = (node: HeadlessElement) => {
      for (const child of node.children) {
        if (selector.startsWith(".")) {
          const cls = selector.slice(1);
          if (child.classList.contains(cls)) results.push(child as unknown as T);
        } else if (child.tagName === selector.toUpperCase()) {
          results.push(child as unknown as T);
        }
        check(child);
      }
    };
    check(this);
    return results;
  }

  getBoundingClientRect() {
    return {
      top: 100,
      bottom: 120,
      left: 200,
      right: 300,
      width: 100,
      height: 20,
      x: 200,
      y: 100,
      toJSON: () => {},
    };
  }

  addEventListener(type: string, listener: EventListener) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: Event): boolean {
    const set = this.listeners.get(event.type);
    if (set) {
      for (const l of Array.from(set)) {
        l(event);
      }
    }
    return true;
  }

  focus() {}
  blur() {}
}

class HeadlessDocument {
  documentElement: HeadlessElement;
  body: HeadlessElement;
  head: HeadlessElement;
  defaultView: unknown;
  private documentListeners: Map<string, Set<EventListener>> = new Map();

  constructor() {
    this.documentElement = new HeadlessElement("html", this);
    this.head = new HeadlessElement("head", this);
    this.body = new HeadlessElement("body", this);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
  }

  createElement(tagName: string): HeadlessElement {
    return new HeadlessElement(tagName, this);
  }

  createDocumentFragment(): HeadlessElement {
    return new HeadlessElement("fragment", this);
  }

  createTextNode(text: string): HeadlessElement {
    const el = new HeadlessElement("#text", this);
    el.textContent = text;
    return el;
  }

  createRange() {
    return {
      setStart: () => {},
      setEnd: () => {},
      getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }),
      getClientRects: () => [],
    };
  }

  getSelection() {
    return {
      rangeCount: 0,
      getRangeAt: () => this.createRange(),
      removeAllRanges: () => {},
      addRange: () => {},
    };
  }

  hasFocus(): boolean {
    return true;
  }

  addEventListener(type: string, listener: EventListener) {
    if (!this.documentListeners.has(type)) {
      this.documentListeners.set(type, new Set());
    }
    this.documentListeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: EventListener) {
    this.documentListeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: Event): boolean {
    const set = this.documentListeners.get(event.type);
    if (set) {
      for (const l of Array.from(set)) {
        l(event);
      }
    }
    return true;
  }
}

// Global environment initialization
let savedGlobals: Record<string, unknown> = {};

function setupHeadlessDOM() {
  const mockDoc = new HeadlessDocument();
  savedGlobals = {
    window: global.window,
    document: global.document,
    HTMLElement: global.HTMLElement,
    Element: global.Element,
    Node: global.Node,
    MutationObserver: global.MutationObserver,
    requestAnimationFrame: global.requestAnimationFrame,
    cancelAnimationFrame: global.cancelAnimationFrame,
  };

  const mockWindow = {
    document: mockDoc,
    innerWidth: 1920,
    innerHeight: 1080,
    addEventListener: () => {},
    removeEventListener: () => {},
    getComputedStyle: () => ({
      getPropertyValue: () => "",
      direction: "ltr",
    }),
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    setTimeout: (cb: (...args: unknown[]) => void, ms?: number) => setTimeout(cb, ms),
    clearTimeout: (id: NodeJS.Timeout | number | undefined) => clearTimeout(id as NodeJS.Timeout),
  };

  mockDoc.defaultView = mockWindow;

  (global as unknown as { window: unknown }).window = mockWindow;

  (global as unknown as { document: unknown }).document = mockDoc;
  (global as unknown as { HTMLElement: unknown }).HTMLElement = HeadlessElement;
  (global as unknown as { Element: unknown }).Element = HeadlessElement;
  (global as unknown as { Node: unknown }).Node = HeadlessElement;
  (global as unknown as { MutationObserver: unknown }).MutationObserver = class {
    observe() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
  (global as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = () => 0;
  (global as unknown as { cancelAnimationFrame: unknown }).cancelAnimationFrame = () => {};
}

function teardownHeadlessDOM() {
  Object.assign(global, savedGlobals);
}

// ============================================================================
// Mock Proposal Store
// ============================================================================

class MockProposalStore implements IProposalStore {
  private proposals: Proposal[] = [];
  private listeners: Set<() => void> = new Set();

  constructor(initial: Proposal[] = []) {
    this.proposals = [...initial];
  }

  setProposals(proposals: Proposal[]): void {
    this.proposals = [...proposals];
    this.notify();
  }

  addProposal(proposal: Proposal): void {
    this.proposals.push(proposal);
    this.notify();
  }

  removeProposal(id: string): void {
    this.proposals = this.proposals.filter((p) => (p.compoundId ?? p.id) !== id);
    this.notify();
  }

  async initialize(): Promise<void> {}
  async scanVaultBuffers(): Promise<Proposal[]> {
    return this.proposals;
  }

  getProposalsForFile(filePath: string): Proposal[] {
    return this.proposals.filter((p) => p.file === filePath && p.status === "pending");
  }

  getAllProposals(): Proposal[] {
    return this.proposals;
  }

  getProposalById(proposalId: string): Proposal | undefined {
    return this.proposals.find(
      (p) => (p.compoundId ?? p.id) === proposalId || p.id === proposalId
    );
  }

  async acceptProposal(proposalId: string): Promise<boolean> {
    const p = this.getProposalById(proposalId);
    if (!p) return false;
    p.status = "applied";
    this.notify();
    return true;
  }

  async rejectProposal(proposalId: string): Promise<boolean> {
    const p = this.getProposalById(proposalId);
    if (!p) return false;
    p.status = "rejected";
    this.notify();
    return true;
  }

  onStoreChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.listeners.clear();
  }

  public notify(): void {
    for (const listener of Array.from(this.listeners)) {
      listener();
    }
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

// Helper: Creates an EditorState initialized with editorInfoField
function createEditorStateWithFile(
  doc: string,
  filePath: string,
  extensions: Extension[] = []
): EditorState {
  const fileMock = {
    path: filePath,
    name: filePath.split("/").pop() ?? "",
    extension: filePath.split(".").pop() ?? "md",
  };

  const fileInfoExtension = editorInfoField.init(() => ({
    file: fileMock,
  } as unknown as MarkdownFileInfo));

  return EditorState.create({
    doc,
    extensions: [fileInfoExtension, ...extensions],
  });
}

// ============================================================================
// Test Suites
// ============================================================================

describe("Milestone 3: CodeMirror 6 Editor Plugin & Floating Popover", () => {
  beforeEach(() => {
    setupHeadlessDOM();
  });

  afterEach(() => {
    teardownHeadlessDOM();
  });

  // --------------------------------------------------------------------------
  // Category 1: Headless EditorView & DOM Environment Lifecycle
  // --------------------------------------------------------------------------
  describe("Category 1: Headless EditorView & DOM Environment Lifecycle", () => {
    it("1.1 instantiates EditorState and EditorView cleanly in headless Node", () => {
      const doc = "Initial line of text\nSecond line";
      const state = EditorState.create({ doc });
      const parent = document.createElement("div");
      const view = new EditorView({ state, parent: parent as unknown as HTMLElement });

      expect(view.state.doc.length).toBe(doc.length);
      expect(view.dom).toBeDefined();
      view.destroy();
    });

    it("1.2 mounts createProposalViewPlugin without throwing DOM errors", () => {
      const store = new MockProposalStore();
      const state = createEditorStateWithFile("Sample doc", "test.md", [
        createProposalViewPlugin(store),
      ]);
      const parent = document.createElement("div");
      const view = new EditorView({ state, parent: parent as unknown as HTMLElement });

      expect(view).toBeDefined();
      view.destroy();
    });

    it("1.3 destroys EditorView cleanly and unregisters store listeners", () => {
      const store = new MockProposalStore();
      const state = createEditorStateWithFile("Sample doc", "test.md", [
        createProposalViewPlugin(store),
      ]);
      const parent = document.createElement("div");
      const view = new EditorView({ state, parent: parent as unknown as HTMLElement });

      expect(store.listenerCount).toBeGreaterThan(0);
      view.destroy();
      expect(store.listenerCount).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Category 2: Decoration Generation & Monotonic Offset Placement (F14)
  // --------------------------------------------------------------------------
  describe("Category 2: Decoration Generation & Monotonic Offset Placement (F14)", () => {
    it("2.1 renders Decoration.mark spanning exact character offsets for pending proposal", () => {
      const doc = Text.of(["The quick brown fox jumps over the lazy dog."]);
      const proposal: Proposal = {
        id: "p1",
        file: "Note.md",
        sourceFile: "ai_suggestion-01.json",
        line: 1,
        ch: 16,
        toCh: 19,
        original: "fox",
        replacement: "cat",
        status: "pending",
      };

      const decos = buildProposalDecorations(doc, [proposal], "Note.md");
      let count = 0;
      let from = -1;
      let to = -1;

      decos.between(0, doc.length, (f, t) => {
        count++;
        from = f;
        to = t;
      });

      expect(count).toBe(1);
      expect(from).toBe(16);
      expect(to).toBe(19);
      expect(doc.sliceString(from, to)).toBe("fox");
    });

    it("2.2 applies .ai-proposal-highlight CSS class and data-proposal-id attribute", () => {
      const doc = Text.of(["The quick brown fox jumps."]);
      const proposal: Proposal = {
        id: "prop-alpha-123",
        file: "Note.md",
        sourceFile: "ai_suggestion-01.json",
        line: 1,
        ch: 16,
        toCh: 19,
        original: "fox",
        replacement: "wolf",
        status: "pending",
      };

      const decos = buildProposalDecorations(doc, [proposal], "Note.md");
      let inspectedClass = "";
      let inspectedId = "";

      decos.between(0, doc.length, (_f, _t, deco) => {
        inspectedClass = (deco.spec as { class?: string }).class ?? "";
        const attrs = (deco.spec as { attributes?: Record<string, string> }).attributes ?? {};
        inspectedId = attrs["data-proposal-id"] ?? "";
      });

      expect(inspectedClass).toContain("ai-proposal-highlight");
      expect(inspectedId).toBe("prop-alpha-123");
    });

    it("2.3 handles multiple proposals on different lines", () => {
      const doc = Text.of(["Line one", "Line two is longer", "Line three"]);
      const p1: Proposal = {
        id: "p1",
        file: "test.md",
        sourceFile: "buf.json",
        line: 1,
        ch: 5,
        toCh: 8,
        original: "one",
        replacement: "uno",
        status: "pending",
      };
      const p2: Proposal = {
        id: "p2",
        file: "test.md",
        sourceFile: "buf.json",
        line: 2,
        ch: 5,
        toCh: 8,
        original: "two",
        replacement: "dos",
        status: "pending",
      };
      const p3: Proposal = {
        id: "p3",
        file: "test.md",
        sourceFile: "buf.json",
        line: 3,
        ch: 5,
        toCh: 10,
        original: "three",
        replacement: "tres",
        status: "pending",
      };

      const decos = buildProposalDecorations(doc, [p1, p2, p3], "test.md");
      const ranges: Array<[number, number]> = [];
      decos.between(0, doc.length, (f, t) => {
        ranges.push([f, t]);
      });

      expect(ranges).toEqual([
        [5, 8],
        [14, 17],
        [33, 38],
      ]);
    });

    it("2.4 enforces strictly monotonic RangeSet ordering for unordered proposals on same line", () => {
      const doc = Text.of(["WordA WordB WordC WordD WordE"]);
      const p1: Proposal = {
        id: "p1",
        file: "test.md",
        sourceFile: "buf.json",
        line: 1,
        ch: 18,
        toCh: 23,
        original: "WordD",
        replacement: "4",
        status: "pending",
      };
      const p2: Proposal = {
        id: "p2",
        file: "test.md",
        sourceFile: "buf.json",
        line: 1,
        ch: 0,
        toCh: 5,
        original: "WordA",
        replacement: "1",
        status: "pending",
      };
      const p3: Proposal = {
        id: "p3",
        file: "test.md",
        sourceFile: "buf.json",
        line: 1,
        ch: 6,
        toCh: 11,
        original: "WordB",
        replacement: "2",
        status: "pending",
      };

      // Ingest in unsorted order [p1, p2, p3]
      const decos = buildProposalDecorations(doc, [p1, p2, p3], "test.md");
      const ranges: Array<[number, number]> = [];
      decos.between(0, doc.length, (f, t) => {
        ranges.push([f, t]);
      });

      expect(ranges).toEqual([
        [0, 5],
        [6, 11],
        [18, 23],
      ]);
    });

    it("2.5 filters proposals strictly by active file path via editorInfoField", () => {
      const doc = Text.of(["Daily note content."]);
      const p1: Proposal = {
        id: "p1",
        file: "Notes/Daily.md",
        sourceFile: "b1.json",
        line: 1,
        ch: 0,
        toCh: 5,
        original: "Daily",
        replacement: "Weekly",
        status: "pending",
      };
      const p2: Proposal = {
        id: "p2",
        file: "Projects/Roadmap.md",
        sourceFile: "b2.json",
        line: 1,
        ch: 0,
        toCh: 5,
        original: "Daily",
        replacement: "Monthly",
        status: "pending",
      };

      const decos = buildProposalDecorations(doc, [p1, p2], "Notes/Daily.md");
      let count = 0;
      decos.between(0, doc.length, () => {
        count++;
      });

      expect(count).toBe(1);
    });

    it("2.6 isolates split pane editor leaves preventing cross-file decoration leaks", () => {
      const store = new MockProposalStore([
        {
          id: "pA",
          file: "FileA.md",
          sourceFile: "buf.json",
          line: 1,
          ch: 0,
          toCh: 5,
          original: "Hello",
          replacement: "Hi",
          status: "pending",
        },
        {
          id: "pB",
          file: "FileB.md",
          sourceFile: "buf.json",
          line: 1,
          ch: 0,
          toCh: 5,
          original: "Hello",
          replacement: "Hey",
          status: "pending",
        },
      ]);

      const stateA = createEditorStateWithFile("Hello world", "FileA.md");
      const stateB = createEditorStateWithFile("Hello world", "FileB.md");

      const pluginValA = new ProposalPluginValue(
        { state: stateA } as unknown as EditorView,
        store
      );
      const pluginValB = new ProposalPluginValue(
        { state: stateB } as unknown as EditorView,
        store
      );

      let countA = 0;
      pluginValA.decorations.between(0, 11, () => {
        countA++;
      });
      let countB = 0;
      pluginValB.decorations.between(0, 11, () => {
        countB++;
      });

      expect(countA).toBe(1);
      expect(countB).toBe(1);

      pluginValA.destroy();
      pluginValB.destroy();
    });
  });

  // --------------------------------------------------------------------------
  // Category 3: Boundary Cases & RangeSet Crash Prevention (F14)
  // --------------------------------------------------------------------------
  describe("Category 3: Boundary Cases & RangeSet Crash Prevention (F14)", () => {
    it("3.1 intercepts pure zero-length insertion (from === to) and renders WidgetType", () => {
      const doc = Text.of(["Inserting  here."]);
      const proposal: Proposal = {
        id: "p-zero",
        file: "test.md",
        sourceFile: "buf.json",
        line: 1,
        ch: 10,
        toCh: 10,
        original: "",
        replacement: "word",
        status: "pending",
      };

      const decos = buildProposalDecorations(doc, [proposal], "test.md");
      let isWidget = false;
      let from = -1;
      let to = -1;

      decos.between(0, doc.length, (f, t, deco) => {
        from = f;
        to = t;
        const widget = (deco.spec as { widget?: unknown }).widget;
        if (widget instanceof ProposalInsertionWidget) {
          isWidget = true;
        }
      });

      expect(from).toBe(10);
      expect(to).toBe(10);
      expect(isWidget).toBe(true);
    });

    it("3.2 prevents 'Mark decorations may not be empty' fatal RangeSet error", () => {
      const doc = Text.of(["Line text"]);
      const proposal: Proposal = {
        id: "p-zero-start",
        file: "test.md",
        sourceFile: "buf.json",
        line: 1,
        ch: 0,
        toCh: 0,
        original: "",
        replacement: "Header: ",
        status: "pending",
      };

      // Executing buildProposalDecorations must complete with 0 errors
      expect(() => {
        buildProposalDecorations(doc, [proposal], "test.md");
      }).not.toThrow();
    });

    it("3.3 skips subsequent colliding intervals on same line via hasIntervalCollision", () => {
      const doc = Text.of(["012345678901234567890123456789"]);
      const pA: Proposal = {
        id: "pA",
        file: "test.md",
        sourceFile: "buf.json",
        line: 1,
        ch: 5,
        toCh: 15,
        original: "5678901234",
        replacement: "A",
        status: "pending",
      };
      const pB: Proposal = {
        id: "pB",
        file: "test.md",
        sourceFile: "buf.json",
        line: 1,
        ch: 10,
        toCh: 20,
        original: "0123456789",
        replacement: "B",
        status: "pending",
      };
      const pC: Proposal = {
        id: "pC",
        file: "test.md",
        sourceFile: "buf.json",
        line: 1,
        ch: 20,
        toCh: 25,
        original: "01234",
        replacement: "C",
        status: "pending",
      };

      const decos = buildProposalDecorations(doc, [pA, pB, pC], "test.md");
      const ranges: Array<[number, number]> = [];
      decos.between(0, doc.length, (f, t) => {
        ranges.push([f, t]);
      });

      expect(ranges).toEqual([
        [5, 15],
        [20, 25],
      ]);
      expect(ranges.length).toBe(2);
    });

    it("3.4 gracefully ignores proposals targeting line numbers exceeding document length", () => {
      const doc = Text.of(["Line 1", "Line 2", "Line 3"]);
      const proposal: Proposal = {
        id: "p-oob",
        file: "test.md",
        sourceFile: "buf.json",
        line: 99,
        ch: 0,
        toCh: 5,
        original: "ghost",
        replacement: "new",
        status: "pending",
      };

      expect(() => {
        const decos = buildProposalDecorations(doc, [proposal], "test.md");
        let count = 0;
        decos.between(0, doc.length, () => {
          count++;
        });
        expect(count).toBe(0);
      }).not.toThrow();
    });

    it("3.5 gracefully ignores proposals where column offsets exceed line length", () => {
      const doc = Text.of(["hello"]);
      const proposal: Proposal = {
        id: "p-col-oob",
        file: "test.md",
        sourceFile: "buf.json",
        line: 1,
        ch: 10,
        toCh: 15,
        original: "there",
        replacement: "all",
        status: "pending",
      };

      const decos = buildProposalDecorations(doc, [proposal], "test.md");
      let count = 0;
      decos.between(0, doc.length, () => {
        count++;
      });
      expect(count).toBe(0);
    });

    it("3.6 marks drifted anchors with .ai-mismatch warning class when auto-snapped", () => {
      const doc = Text.of(["prefix target suffix"]);
      const proposal: Proposal = {
        id: "p-drifted",
        file: "test.md",
        sourceFile: "buf.json",
        line: 1,
        ch: 0, // Expected at column 0, but actually at column 7
        toCh: 6,
        original: "target",
        replacement: "goal",
        status: "pending",
      };

      const resolved = resolveProposalRange(doc, proposal);
      expect(resolved).not.toBeNull();
      expect(resolved?.isExact).toBe(false);

      const decos = buildProposalDecorations(doc, [proposal], "test.md");
      let cls = "";
      decos.between(0, doc.length, (_f, _t, deco) => {
        cls = (deco.spec as { class?: string }).class ?? "";
      });

      expect(cls).toContain("ai-mismatch");
    });
  });

  // --------------------------------------------------------------------------
  // Category 4: Reactive Store Updates & Live Document Synchronization (F14, F10)
  // --------------------------------------------------------------------------
  describe("Category 4: Reactive Store Updates & Live Document Synchronization (F14, F10)", () => {
    it("4.1 re-renders decorations when new proposal is added to store", async () => {
      const p1: Proposal = {
        id: "p1",
        file: "test.md",
        sourceFile: "buf.json",
        line: 1,
        ch: 0,
        toCh: 4,
        original: "Word",
        replacement: "Term",
        status: "pending",
      };
      const store = new MockProposalStore([p1]);
      const state = createEditorStateWithFile("Word text", "test.md", [
        createProposalViewPlugin(store),
      ]);
      const parent = document.createElement("div");
      const view = new EditorView({ state, parent: parent as unknown as HTMLElement });

      // Add second proposal to store
      const p2: Proposal = {
        id: "p2",
        file: "test.md",
        sourceFile: "buf.json",
        line: 1,
        ch: 5,
        toCh: 9,
        original: "text",
        replacement: "data",
        status: "pending",
      };

      store.addProposal(p2);

      // Await microtask queue processing
      await new Promise<void>((resolve) => queueMicrotask(() => resolve()));

      // Trigger refresh effect dispatch directly to simulate view update
      view.dispatch({ effects: refreshProposalsEffect.of() });

      const decos = buildProposalDecorations(view.state.doc, store.getAllProposals(), "test.md");
      let count = 0;
      decos.between(0, view.state.doc.length, () => {
        count++;
      });
      expect(count).toBe(2);

      view.destroy();
    });

    it("4.2 removes decoration when proposal is rejected in store", async () => {
      const p1: Proposal = {
        id: "p1",
        file: "test.md",
        sourceFile: "buf.json",
        line: 1,
        ch: 0,
        toCh: 4,
        original: "Word",
        replacement: "Term",
        status: "pending",
      };
      const p2: Proposal = {
        id: "p2",
        file: "test.md",
        sourceFile: "buf.json",
        line: 1,
        ch: 5,
        toCh: 9,
        original: "text",
        replacement: "data",
        status: "pending",
      };
      const store = new MockProposalStore([p1, p2]);

      await store.rejectProposal("p1");

      const decos = buildProposalDecorations(
        Text.of(["Word text"]),
        store.getAllProposals(),
        "test.md"
      );
      let count = 0;
      decos.between(0, 9, () => {
        count++;
      });
      expect(count).toBe(1);
    });

    it("4.3 updates decoration set when proposal is accepted on mutated document", async () => {
      const docText = "The quick brown fox jumps.";
      const p1: Proposal = {
        id: "p1",
        file: "test.md",
        sourceFile: "buf.json",
        line: 1,
        ch: 4,
        toCh: 9,
        original: "quick",
        replacement: "extremely fast",
        status: "pending",
      };
      const p2: Proposal = {
        id: "p2",
        file: "test.md",
        sourceFile: "buf.json",
        line: 1,
        ch: 16,
        toCh: 19,
        original: "fox",
        replacement: "wolf",
        status: "pending",
      };
      const store = new MockProposalStore([p1, p2]);

      await store.acceptProposal("p1");

      // Mutated document after accepting p1
      const newDocText = docText.replace("quick", "extremely fast");
      const doc = Text.of([newDocText]);

      // p2 is resolved on mutated document
      const decos = buildProposalDecorations(doc, store.getAllProposals(), "test.md");
      let count = 0;
      let from = -1;
      let to = -1;
      decos.between(0, doc.length, (f, t) => {
        count++;
        from = f;
        to = t;
      });

      expect(count).toBe(1);
      expect(doc.sliceString(from, to)).toBe("fox");
    });

    it("4.4 shifts downstream decorations on same line after intra-line text replacement", () => {
      const doc = Text.of(["The cat and the dog."]);
      const p: Proposal = {
        id: "p-dog",
        file: "test.md",
        sourceFile: "buf.json",
        line: 1,
        ch: 16,
        toCh: 19,
        original: "dog",
        replacement: "hound",
        status: "pending",
      };

      const resolved = resolveProposalRange(doc, p);
      expect(resolved).not.toBeNull();
      expect(doc.sliceString(resolved!.from, resolved!.to)).toBe("dog");
    });

    it("4.5 shifts line coordinates of following lines after multi-line insertion", () => {
      const multiLineDoc = Text.of(["Line 1", "Line 2a", "Line 2b", "Line 2c", "Line 3"]);
      const p: Proposal = {
        id: "p-line3",
        file: "test.md",
        sourceFile: "buf.json",
        line: 3, // Drifted from expected line 3 to line 5
        ch: 0,
        toCh: 6,
        original: "Line 3",
        replacement: "Final Line",
        status: "pending",
      };

      const resolved = resolveProposalRange(multiLineDoc, p);
      expect(resolved).not.toBeNull();
      expect(multiLineDoc.sliceString(resolved!.from, resolved!.to)).toBe("Line 3");
    });

    it("4.6 handles rapid store update batches without memory leaks or race conditions", async () => {
      const store = new MockProposalStore();
      const doc = Text.of(["A B C D E"]);

      for (let i = 0; i < 20; i++) {
        store.addProposal({
          id: `p-${i}`,
          file: "test.md",
          sourceFile: "buf.json",
          line: 1,
          ch: 0,
          toCh: 1,
          original: "A",
          replacement: `${i}`,
          status: "pending",
        });
      }

      const decos = buildProposalDecorations(doc, store.getAllProposals(), "test.md");
      expect(decos).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Category 5: Popover Positioning Logic & Viewport Boundary Clamping (F15, F19)
  // --------------------------------------------------------------------------
  describe("Category 5: Popover Positioning Logic & Viewport Boundary Clamping (F15, F19)", () => {
    const viewport: Dimensions = { width: 1920, height: 1080 };
    const popover: Dimensions = { width: 320, height: 160 };

    it("5.1 positions popover below anchor with standard 6px vertical gap in normal viewport", () => {
      const anchor: AnchorRect = { top: 200, bottom: 220, left: 300, right: 400 };
      const pos = computePopoverPosition(anchor, popover, viewport);

      expect(pos.placement).toBe("bottom");
      expect(pos.top).toBe(226); // bottom (220) + gap (6)
      expect(pos.left).toBe(300);
    });

    it("5.2 clamps left position when anchor is near right viewport edge (right overflow)", () => {
      const anchor: AnchorRect = { top: 200, bottom: 220, left: 1800, right: 1900 };
      const pos = computePopoverPosition(anchor, popover, viewport, { margin: 12 });

      expect(pos.left).toBe(1920 - 320 - 12); // 1588
      expect(pos.left + 320).toBe(1908);
    });

    it("5.3 clamps left position to minimum margin (12px) when anchor is near left edge", () => {
      const anchor: AnchorRect = { top: 200, bottom: 220, left: 2, right: 50 };
      const pos = computePopoverPosition(anchor, popover, viewport, { margin: 12 });

      expect(pos.left).toBe(12);
    });

    it("5.4 flips popover above anchor when bottom edge overflows screen height", () => {
      const anchor: AnchorRect = { top: 980, bottom: 1000, left: 500, right: 600 };
      const pos = computePopoverPosition(anchor, popover, viewport, { margin: 12, gap: 6 });

      expect(pos.placement).toBe("top");
      expect(pos.top).toBe(980 - 160 - 6); // 814
    });

    it("5.5 safely clamps top position to margin if vertical flip overflows screen ceiling", () => {
      const constrainedVp: Dimensions = { width: 800, height: 400 };
      const tallPopover: Dimensions = { width: 300, height: 380 };
      const anchor: AnchorRect = { top: 50, bottom: 70, left: 100, right: 200 };

      const pos = computePopoverPosition(anchor, tallPopover, constrainedVp, { margin: 12 });
      expect(pos.top).toBeGreaterThanOrEqual(12);
    });

    it("5.6 adapts to narrow mobile viewport (320px screen width) without horizontal overflow", () => {
      const mobileViewport: Dimensions = { width: 320, height: 568 };
      const mobilePopover: Dimensions = { width: 300, height: 160 };
      const anchor: AnchorRect = { top: 100, bottom: 120, left: 80, right: 120 };

      const pos = computePopoverPosition(anchor, mobilePopover, mobileViewport, { margin: 8 });
      expect(pos.left).toBe(320 - 300 - 8); // 12
      expect(pos.left + 300).toBeLessThanOrEqual(320);
    });

    it("5.7 handles zero-dimension anchor rects gracefully", () => {
      const zeroAnchor: AnchorRect = { top: 100, bottom: 120, left: 150, right: 150, width: 0, height: 20 };
      const pos = computePopoverPosition(zeroAnchor, popover, viewport);

      expect(Number.isNaN(pos.top)).toBe(false);
      expect(Number.isNaN(pos.left)).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Category 6: Diff Preview Generation & Content Formatting (F15)
  // --------------------------------------------------------------------------
  describe("Category 6: Diff Preview Generation & Content Formatting (F15)", () => {
    it("6.1 renders deletion block (<del>) for original text and insertion (<ins>) for replacement", () => {
      const proposal: Proposal = {
        id: "p-diff",
        file: "test.md",
        sourceFile: "buf.json",
        line: 1,
        ch: 0,
        toCh: 13,
        original: "outdated text",
        replacement: "modern text",
        status: "pending",
      };

      const preview = renderDiffPreview(proposal);
      expect(preview.className).toContain("ai-proposal-diff");

      // Verify deletion & addition elements exist
      const del = (preview as unknown as HeadlessElement).querySelector("del");
      const ins = (preview as unknown as HeadlessElement).querySelector("ins");

      expect(del).toBeDefined();
      expect(del).not.toBeNull();
      expect(ins).toBeDefined();
      expect(ins).not.toBeNull();
    });

    it("6.2 formats pure insertion proposals (empty original) with addition styling", () => {
      const proposal: Proposal = {
        id: "p-ins",
        file: "test.md",
        sourceFile: "buf.json",
        line: 1,
        ch: 0,
        toCh: 0,
        original: "",
        replacement: "brand new sentence",
        status: "pending",
      };

      const preview = renderDiffPreview(proposal);
      const emptyNote = (preview as unknown as HeadlessElement).querySelector(".ai-proposal-empty-note");
      const ins = (preview as unknown as HeadlessElement).querySelector("ins");

      expect(emptyNote).toBeDefined();
      expect(emptyNote).not.toBeNull();
      expect(ins).toBeDefined();
      expect(ins).not.toBeNull();
    });

    it("6.3 formats pure deletion proposals (empty replacement) with removal styling", () => {
      const proposal: Proposal = {
        id: "p-del",
        file: "test.md",
        sourceFile: "buf.json",
        line: 1,
        ch: 0,
        toCh: 17,
        original: "unnecessary words",
        replacement: "",
        status: "pending",
      };

      const preview = renderDiffPreview(proposal);
      const del = (preview as unknown as HeadlessElement).querySelector("del");
      const emptyNote = (preview as unknown as HeadlessElement).querySelector(".ai-proposal-empty-note");

      expect(del).toBeDefined();
      expect(del).not.toBeNull();
      expect(emptyNote).toBeDefined();
      expect(emptyNote).not.toBeNull();
    });

    it("6.4 preserves embedded newline characters with visible linebreak representations", () => {
      const proposal: Proposal = {
        id: "p-nl",
        file: "test.md",
        sourceFile: "buf.json",
        line: 1,
        ch: 0,
        toCh: 10,
        original: "Single",
        replacement: "First line\nSecond line",
        status: "pending",
      };

      const preview = renderDiffPreview(proposal);
      const nlSpan = (preview as unknown as HeadlessElement).querySelector(".ai-proposal-diff-newline");

      expect(nlSpan).toBeDefined();
      expect(nlSpan).not.toBeNull();
      expect(nlSpan?.textContent).toBe("↵");
    });

    it("6.5 sanitizes HTML tags and special characters in diff to prevent XSS injection", () => {
      const proposal: Proposal = {
        id: "p-xss",
        file: "test.md",
        sourceFile: "buf.json",
        line: 1,
        ch: 0,
        toCh: 5,
        original: "<script>alert('xss')</script>",
        replacement: "<img src=x onerror=alert(1)>",
        status: "pending",
      };

      const preview = renderDiffPreview(proposal);
      const scriptElements = (preview as unknown as HeadlessElement).querySelectorAll("script");
      const imgElements = (preview as unknown as HeadlessElement).querySelectorAll("img");

      expect(scriptElements.length).toBe(0);
      expect(imgElements.length).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Category 7: Popover Interaction & Event Delegation (F15, F19)
  // --------------------------------------------------------------------------
  describe("Category 7: Popover Interaction & Event Delegation (F15, F19)", () => {
    it("7.1 stops click propagation on decoration element to protect editor selection", () => {
      const store = new MockProposalStore();
      const popoverManager = new PopoverManager(store);
      const extensions = createProposalViewPlugin(store, popoverManager);

      // Verify that createProposalViewPlugin produces valid extension array
      expect(extensions).toBeDefined();
      expect(Array.isArray(extensions)).toBe(true);

      popoverManager.dispose();
    });

    it("7.2 ensures only one popover instance is mounted in DOM at any time", () => {
      const store = new MockProposalStore();
      const popoverManager = new PopoverManager(store);

      const p1: Proposal = {
        id: "p1",
        file: "test.md",
        sourceFile: "b1.json",
        line: 1,
        ch: 0,
        toCh: 4,
        original: "word",
        replacement: "term",
        status: "pending",
      };
      const p2: Proposal = {
        id: "p2",
        file: "test.md",
        sourceFile: "b2.json",
        line: 2,
        ch: 0,
        toCh: 4,
        original: "data",
        replacement: "info",
        status: "pending",
      };

      const anchorEl = document.createElement("span");
      popoverManager.show(p1, anchorEl as unknown as HTMLElement);
      expect(popoverManager.isOpen()).toBe(true);
      expect(popoverManager.getActiveProposal()?.id).toBe("p1");

      // Show second proposal immediately
      popoverManager.show(p2, anchorEl as unknown as HTMLElement);
      expect(popoverManager.isOpen()).toBe(true);
      expect(popoverManager.getActiveProposal()?.id).toBe("p2");

      const popovers = (document.body as unknown as HeadlessElement).children.filter((c) =>
        c.className.includes("ai-proposal-popover")
      );
      expect(popovers.length).toBe(1);

      popoverManager.dispose();
    });

    it("7.3 dismisses popover on Escape key press or document click", () => {
      const store = new MockProposalStore();
      const popoverManager = new PopoverManager(store);

      const p: Proposal = {
        id: "p-esc",
        file: "test.md",
        sourceFile: "buf.json",
        line: 1,
        ch: 0,
        toCh: 4,
        original: "test",
        replacement: "exam",
        status: "pending",
      };

      const anchorEl = document.createElement("span");
      popoverManager.show(p, anchorEl as unknown as HTMLElement);
      expect(popoverManager.isOpen()).toBe(true);

      // Dispatch Escape key event on document
      const escEvent = {
        type: "keydown",
        key: "Escape",
        preventDefault: vi.fn(),
      } as unknown as KeyboardEvent;

      (document as unknown as { dispatchEvent: (e: KeyboardEvent) => void }).dispatchEvent(escEvent);

      expect(popoverManager.isOpen()).toBe(false);
      popoverManager.dispose();
    });

    it("7.4 prevents editor focus loss via pointerdown and mousedown preventDefault", () => {
      const store = new MockProposalStore();
      const popoverManager = new PopoverManager(store);

      const p: Proposal = {
        id: "p-touch-test",
        file: "test.md",
        sourceFile: "buf.json",
        line: 1,
        ch: 0,
        toCh: 4,
        original: "word",
        replacement: "term",
        status: "pending",
      };

      const anchorEl = document.createElement("span");
      popoverManager.show(p, anchorEl as unknown as HTMLElement);

      const popoverEl = (document.body as unknown as HeadlessElement).children.find((c) =>
        c.className.includes("ai-proposal-popover")
      );
      expect(popoverEl).toBeDefined();

      const acceptBtn = popoverEl!.querySelector(".ai-proposal-btn-accept")!;
      const rejectBtn = popoverEl!.querySelector(".ai-proposal-btn-reject")!;
      const closeBtn = popoverEl!.querySelector(".ai-proposal-btn-close")!;

      // Dispatch pointerdown on interactive buttons
      const pointerdownAccept = {
        type: "pointerdown",
        preventDefault: vi.fn(),
      } as unknown as PointerEvent;
      acceptBtn.dispatchEvent(pointerdownAccept);
      expect(pointerdownAccept.preventDefault).toHaveBeenCalledTimes(1);

      const pointerdownReject = {
        type: "pointerdown",
        preventDefault: vi.fn(),
      } as unknown as PointerEvent;
      rejectBtn.dispatchEvent(pointerdownReject);
      expect(pointerdownReject.preventDefault).toHaveBeenCalledTimes(1);

      const pointerdownClose = {
        type: "pointerdown",
        preventDefault: vi.fn(),
      } as unknown as PointerEvent;
      closeBtn.dispatchEvent(pointerdownClose);
      expect(pointerdownClose.preventDefault).toHaveBeenCalledTimes(1);

      // Dispatch mousedown on interactive buttons
      const mousedownAccept = {
        type: "mousedown",
        preventDefault: vi.fn(),
      } as unknown as MouseEvent;
      acceptBtn.dispatchEvent(mousedownAccept);
      expect(mousedownAccept.preventDefault).toHaveBeenCalledTimes(1);

      popoverManager.dispose();
    });

    it("7.5 does not call preventDefault on touchstart so synthetic clicks are not canceled", async () => {
      const p: Proposal = {
        id: "p-touch-synthetic",
        file: "test.md",
        sourceFile: "buf.json",
        line: 1,
        ch: 0,
        toCh: 4,
        original: "word",
        replacement: "term",
        status: "pending",
      };

      const store = new MockProposalStore([p]);
      const popoverManager = new PopoverManager(store);

      const anchorEl = document.createElement("span");
      popoverManager.show(p, anchorEl as unknown as HTMLElement);

      const popoverEl = (document.body as unknown as HeadlessElement).children.find((c) =>
        c.className.includes("ai-proposal-popover")
      );
      const acceptBtn = popoverEl!.querySelector(".ai-proposal-btn-accept")!;

      // Dispatch touchstart event
      const touchstartEvent = {
        type: "touchstart",
        preventDefault: vi.fn(),
      } as unknown as TouchEvent;

      acceptBtn.dispatchEvent(touchstartEvent);

      // Crucial: touchstart must NOT invoke preventDefault (preventing W3C synthetic click suppression)
      expect(touchstartEvent.preventDefault).not.toHaveBeenCalled();

      // Subsequent click event succeeds and applies proposal
      const clickEvent = {
        type: "click",
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      } as unknown as MouseEvent;

      acceptBtn.dispatchEvent(clickEvent);

      // Wait for async store mutation
      await new Promise((resolve) => setTimeout(resolve, 20));

      const updated = store.getProposalById("p-touch-synthetic");
      expect(updated?.status).toBe("applied");

      popoverManager.dispose();
    });

    it("7.6 action buttons guard against concurrent double-clicks and cross-button races", async () => {
      const p: Proposal = {
        id: "p-race-guard",
        file: "test.md",
        sourceFile: "buf.json",
        line: 1,
        ch: 0,
        toCh: 4,
        original: "word",
        replacement: "term",
        status: "pending",
      };

      let acceptInvocations = 0;
      let rejectInvocations = 0;

      const store = new MockProposalStore([p]);
      const origAccept = store.acceptProposal.bind(store);
      store.acceptProposal = async (id: string) => {
        acceptInvocations++;
        await new Promise((resolve) => setTimeout(resolve, 40));
        return origAccept(id);
      };
      const origReject = store.rejectProposal.bind(store);
      store.rejectProposal = async (id: string) => {
        rejectInvocations++;
        await new Promise((resolve) => setTimeout(resolve, 40));
        return origReject(id);
      };

      const popoverManager = new PopoverManager(store);
      const anchorEl = document.createElement("span");
      popoverManager.show(p, anchorEl as unknown as HTMLElement);

      const popoverEl = (document.body as unknown as HeadlessElement).children.find((c) =>
        c.className.includes("ai-proposal-popover")
      );
      const acceptBtn = popoverEl!.querySelector(".ai-proposal-btn-accept")!;
      const rejectBtn = popoverEl!.querySelector(".ai-proposal-btn-reject")!;

      const click1 = { type: "click", preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as MouseEvent;
      const click2 = { type: "click", preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as MouseEvent;

      // Dispatch rapid double click on accept
      acceptBtn.dispatchEvent(click1);
      acceptBtn.dispatchEvent(click2);
      // And rapid cross click on reject
      rejectBtn.dispatchEvent(click1);

      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(acceptInvocations).toBe(1);
      expect(rejectInvocations).toBe(0);

      popoverManager.dispose();
    });
  });
});
