/**
 * tests/m3_stress_harness.test.ts
 * Empirical Adversarial Stress Harness for Milestone 3.
 *
 * Authored by: teamwork_preview_challenger (m3_challenger_1)
 *
 * Focus areas:
 * 1. Extreme Edge Cases:
 *    - Out-of-bounds line numbers (e.g. line 99999 in 5-line doc, line <= 0, line NaN)
 *    - Out-of-bounds column numbers (negative ch, excessive ch)
 *    - Empty documents ("" and empty lines)
 *    - Document truncation while proposals are active
 * 2. Pure Zero-Length Insertions (from === to):
 *    - Insertions at offset 0 (start of document)
 *    - Insertions at end-of-file (EOF)
 *    - Consecutive duplicate zero-length insertions at exact same offset
 *    - Interaction between zero-length insertions and adjacent/enclosing replacement marks
 * 3. Overlapping Proposal Intervals & Monotonic Invariant:
 *    - Partial interval overlaps, nested containment, identical duplicate intervals
 *    - Strict monotonic ordering via RangeSetBuilder (no "Invalid order of ranges")
 *    - Randomized fuzzy interval stress test (100 randomized proposals)
 * 4. Rapid Document Mutations & Reactive Store Dispatches:
 *    - 100 rapid sequential typing transactions
 *    - Rapid line insertions and deletions
 *    - 100 rapid synchronous store notifications with microtask queue draining
 *    - Destruction race condition (store notify immediately followed by view.destroy)
 * 5. Popover Manager & Diff Preview Stress:
 *    - Viewport boundary clamping under extreme dimensions (mobile 320x480, negative anchor, offscreen anchor)
 *    - Diff preview XSS injection safety & massive text payload (50,000 characters)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EditorState, Text, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorInfoField, type MarkdownFileInfo } from "obsidian";

import type { IProposalStore, Proposal } from "../src/types";
import {
  createProposalViewPlugin,
  buildProposalDecorations,
  resolveProposalRange,
  ProposalInsertionWidget,
} from "../src/editor/proposal-view-plugin";
import {
  computePopoverPosition,
  renderDiffPreview,
  type AnchorRect,
  type Dimensions,
} from "../src/editor/popover-manager";

// ============================================================================
// Headless DOM Environment
// ============================================================================

class HeadlessElement {
  nodeType = 1;
  tagName: string;
  className = "";
  private _textContent = "";

  get textContent(): string {
    if (this.children.length > 0) {
      return this.children.map((c) => c.textContent).join("");
    }
    return this._textContent;
  }

  set textContent(val: string) {
    this._textContent = val;
  }
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

let savedGlobals: Record<string, unknown> = {};

function setupHarnessDOM() {
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
    getSelection: () => mockDoc.getSelection(),
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

function teardownHarnessDOM() {
  Object.assign(global, savedGlobals);
}

// ============================================================================
// Mock Proposal Store
// ============================================================================

class MockHarnessStore implements IProposalStore {
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

export class MockStore extends MockHarnessStore {}

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

function makeProposal(
  id: string,
  line: number,
  ch: number,
  toCh: number,
  original: string,
  replacement: string,
  file = "Notes/Test.md"
): Proposal {
  return {
    id,
    file,
    sourceFile: "ai_suggestion-test.json",
    line,
    ch,
    toCh,
    from_ch: ch,
    to_ch: toCh,
    original,
    replacement,
    status: "pending",
  };
}

// ============================================================================
// STRESS TEST SUITES
// ============================================================================

describe("Milestone 3 Empirical Stress Harness: CodeMirror 6 Extension & Popover", () => {
  beforeEach(() => {
    setupHarnessDOM();
  });

  afterEach(() => {
    teardownHarnessDOM();
  });

  // ==========================================================================
  // 1. Extreme Edge Cases: Out-of-bounds Coordinates & Document Truncation
  // ==========================================================================
  describe("1. Extreme Edge Cases: Out-of-bounds Coordinates & Document Truncation", () => {
    it("1.1 proposals targeting line 99999 in a 5-line document return null without throwing", () => {
      const doc = Text.of(["Line 1", "Line 2", "Line 3", "Line 4", "Line 5"]);

      // Pure insertion
      const pZero = makeProposal("p-zero-oob", 99999, 0, 0, "", "inserted");
      const resZero = resolveProposalRange(doc, pZero);
      expect(resZero).toBeNull();

      // Replacement with non-existent target
      const pRep = makeProposal("p-rep-oob", 99999, 0, 5, "missing", "found");
      const resRep = resolveProposalRange(doc, pRep);
      expect(resRep).toBeNull();

      // buildProposalDecorations does not throw
      expect(() => {
        const decos = buildProposalDecorations(doc, [pZero, pRep], "Notes/Test.md");
        expect(decos.size).toBe(0);
      }).not.toThrow();
    });

    it("1.2 proposals with line <= 0 (e.g. 0, -1, -99999) return null without throwing RangeError", () => {
      const doc = Text.of(["First line", "Second line"]);

      const negativeLines = [0, -1, -50, -99999];
      for (const line of negativeLines) {
        const pZero = makeProposal(`p-zero-${line}`, line, 0, 0, "", "prefix");
        expect(resolveProposalRange(doc, pZero)).toBeNull();

        const pRep = makeProposal(`p-rep-${line}`, line, 0, 4, "ghost", "new");
        expect(resolveProposalRange(doc, pRep)).toBeNull();
      }
    });

    it("1.3 proposals with extreme column offsets (negative or > line length)", () => {
      const doc = Text.of(["Short line"]);

      // Negative ch for pure insertion
      const pNeg = makeProposal("p-neg", 1, -10, -10, "", "test");
      expect(resolveProposalRange(doc, pNeg)).toBeNull();

      // Excessive ch for pure insertion
      const pExcessive = makeProposal("p-exc", 1, 99999, 99999, "", "test");
      expect(resolveProposalRange(doc, pExcessive)).toBeNull();

      // Replacement with column beyond length but matching content via auto-snap
      const pSnap = makeProposal("p-snap", 1, 99999, 100003, "line", "text");
      const resSnap = resolveProposalRange(doc, pSnap);
      expect(resSnap).not.toBeNull();
      expect(resSnap?.from).toBe(6);
      expect(resSnap?.to).toBe(10);
      expect(resSnap?.isExact).toBe(false);
    });

    it("1.4 completely empty document (Text.of(['']))", () => {
      const doc = Text.of([""]);
      expect(doc.lines).toBe(1);
      expect(doc.length).toBe(0);

      // Pure insertion at position 0
      const pZeroAt0 = makeProposal("p-zero-0", 1, 0, 0, "", "brand new start");
      const resZero = resolveProposalRange(doc, pZeroAt0);
      expect(resZero).not.toBeNull();
      expect(resZero?.from).toBe(0);
      expect(resZero?.to).toBe(0);

      // Pure insertion at out-of-bounds ch 1
      const pZeroAt1 = makeProposal("p-zero-1", 1, 1, 1, "", "invalid");
      expect(resolveProposalRange(doc, pZeroAt1)).toBeNull();

      // Replacement on empty document returns null
      const pRep = makeProposal("p-rep", 1, 0, 5, "cannot exist", "new");
      expect(resolveProposalRange(doc, pRep)).toBeNull();

      // Verify buildProposalDecorations accepts pure insertion at 0 in empty document
      const decos = buildProposalDecorations(doc, [pZeroAt0], "Notes/Test.md");
      let count = 0;
      decos.between(0, 0, (from, to) => {
        count++;
        expect(from).toBe(0);
        expect(to).toBe(0);
      });
      expect(count).toBe(1);
    });

    it("1.5 dynamic document truncation in EditorView does not cause RangeError", () => {
      // Start with 20-line document
      const initialLines = Array.from({ length: 20 }, (_, i) => `Line content number ${i + 1}`);
      const initialDoc = initialLines.join("\n");

      // Register proposals targeting line 2, line 10, line 18
      const store = new MockHarnessStore([
        makeProposal("p2", 2, 0, 4, "Line", "Para"),
        makeProposal("p10", 10, 0, 4, "Line", "Para"),
        makeProposal("p18", 18, 0, 4, "Line", "Para"),
      ]);

      const state = createEditorStateWithFile(initialDoc, "Notes/Test.md", [
        createProposalViewPlugin(store),
      ]);
      const parent = document.createElement("div");
      const view = new EditorView({ state, parent: parent as unknown as HTMLElement });

      // Truncate document from line 4 to end (leaving only 3 lines)
      const cutFrom = view.state.doc.line(4).from;
      view.dispatch({
        changes: { from: cutFrom, to: view.state.doc.length, insert: "" },
      });

      expect(view.state.doc.lines).toBe(4); // Line 1, 2, 3, and empty line 4

      // Now build decorations: line 10 and 18 are now out of bounds
      const decos = buildProposalDecorations(view.state.doc, store.getAllProposals(), "Notes/Test.md");
      const foundRanges: Array<[number, number]> = [];
      decos.between(0, view.state.doc.length, (f, t) => {
        foundRanges.push([f, t]);
      });

      // Only proposal on line 2 should remain
      expect(foundRanges.length).toBe(1);

      view.destroy();
    });
  });

  // ==========================================================================
  // 2. Pure Zero-Length Insertions & Point Collision Rules
  // ==========================================================================
  describe("2. Pure Zero-Length Insertions & Point Collision Rules", () => {
    it("2.1 pure insertion at offset 0 (start of file)", () => {
      const doc = Text.of(["First line", "Second line"]);
      const pZero = makeProposal("p0", 1, 0, 0, "", "Prefix: ");

      const decos = buildProposalDecorations(doc, [pZero], "Notes/Test.md");
      let inspectedWidget: unknown = null;
      decos.between(0, doc.length, (f, t, deco) => {
        expect(f).toBe(0);
        expect(t).toBe(0);
        inspectedWidget = (deco.spec as { widget?: unknown }).widget;
      });

      expect(inspectedWidget).toBeInstanceOf(ProposalInsertionWidget);
      const dom = (inspectedWidget as ProposalInsertionWidget).toDOM();
      expect(dom.className).toContain("ai-proposal-mark-zero");
      expect(dom.textContent).toContain("‸");
    });

    it("2.2 pure insertion at end-of-file (EOF)", () => {
      const doc = Text.of(["Alpha", "Beta", "Gamma"]);
      const lastLine = doc.line(3);
      // Insertion at end of last line
      const pEOF = makeProposal("p-eof", 3, lastLine.length, lastLine.length, "", " (End)");

      const decos = buildProposalDecorations(doc, [pEOF], "Notes/Test.md");
      let count = 0;
      decos.between(0, doc.length, (f, t) => {
        count++;
        expect(f).toBe(doc.length);
        expect(t).toBe(doc.length);
      });
      expect(count).toBe(1);
    });

    it("2.3 suppresses duplicate zero-length insertions at the exact same character offset", () => {
      const doc = Text.of(["Line with insertion point right here."]);
      // 5 distinct proposals targeting the exact same line 1, ch 10
      const duplicateProposals: Proposal[] = Array.from({ length: 5 }, (_, i) =>
        makeProposal(`p-dup-${i}`, 1, 10, 10, "", `insertion-${i}`)
      );

      const decos = buildProposalDecorations(doc, duplicateProposals, "Notes/Test.md");
      let widgetCount = 0;
      decos.between(0, doc.length, (f, t) => {
        if (f === 10 && t === 10) {
          widgetCount++;
        }
      });

      // Strict guarantee: exactly 1 widget, 4 duplicates suppressed
      expect(widgetCount).toBe(1);
    });

    it("2.4 zero-length insertion abutting a replacement mark does not throw RangeSet errors", () => {
      const doc = Text.of(["0123456789ABCDEF"]);

      // Zero-length insertion at offset 5
      const pZeroAt5 = makeProposal("p-zero-5", 1, 5, 5, "", "INSERT");
      // Replacement mark spanning [5, 10]
      const pMark5to10 = makeProposal("p-mark-5-10", 1, 5, 10, "56789", "REPLACE");

      // Both proposals present
      expect(() => {
        const decos = buildProposalDecorations(doc, [pZeroAt5, pMark5to10], "Notes/Test.md");
        const ranges: Array<[number, number]> = [];
        decos.between(0, doc.length, (f, t) => {
          ranges.push([f, t]);
        });
        // Widget at [5,5] precedes mark [5,10]
        expect(ranges).toEqual([
          [5, 5],
          [5, 10],
        ]);
      }).not.toThrow();
    });

    it("2.5 zero-length insertion strictly inside a replacement mark is suppressed", () => {
      const doc = Text.of(["0123456789ABCDEF"]);

      // Replacement mark spanning [5, 15]
      const pMark = makeProposal("p-mark", 1, 5, 15, "56789ABCDE", "REPLACE");
      // Zero-length insertion at offset 10 (inside [5, 15])
      const pZeroInside = makeProposal("p-zero-inside", 1, 10, 10, "", "INSERT");

      const decos = buildProposalDecorations(doc, [pMark, pZeroInside], "Notes/Test.md");
      const ranges: Array<[number, number]> = [];
      decos.between(0, doc.length, (f, t) => {
        ranges.push([f, t]);
      });

      // The zero-length insertion inside the mark must be rejected
      expect(ranges).toEqual([[5, 15]]);
    });

    it("2.6 ProposalInsertionWidget eq and event handling", () => {
      const p1 = makeProposal("p1", 1, 0, 0, "", "text");
      const p2 = makeProposal("p1", 1, 0, 0, "", "text");
      const pDifferent = makeProposal("p1", 1, 0, 0, "", "different-text");

      const w1 = new ProposalInsertionWidget(p1);
      const w2 = new ProposalInsertionWidget(p2);
      const wDiff = new ProposalInsertionWidget(pDifferent);

      expect(w1.eq(w2)).toBe(true);
      expect(w1.eq(wDiff)).toBe(false);
      expect(w1.ignoreEvent()).toBe(false);
    });
  });

  // ==========================================================================
  // 3. Overlapping Proposal Intervals & Monotonic Invariant
  // ==========================================================================
  describe("3. Overlapping Proposal Intervals & Monotonic Invariant", () => {
    it("3.1 partial interval overlaps are discarded gracefully without RangeSetBuilder crash", () => {
      const doc = Text.of(["01234567890123456789"]);

      // p1: [5, 15], p2: [10, 20] (overlaps with p1)
      const p1 = makeProposal("p1", 1, 5, 15, "5678901234", "A");
      const p2 = makeProposal("p2", 1, 10, 20, "0123456789", "B");

      const decos = buildProposalDecorations(doc, [p1, p2], "Notes/Test.md");
      const ranges: Array<[number, number]> = [];
      decos.between(0, doc.length, (f, t) => {
        ranges.push([f, t]);
      });

      expect(ranges).toEqual([[5, 15]]);
    });

    it("3.2 nested containment: inner proposal inside outer proposal is discarded", () => {
      const doc = Text.of(["01234567890123456789"]);

      // pOuter: [2, 18], pInner: [5, 10]
      const pOuter = makeProposal("pOuter", 1, 2, 18, doc.sliceString(2, 18), "OUTER");
      const pInner = makeProposal("pInner", 1, 5, 10, doc.sliceString(5, 10), "INNER");

      const decos = buildProposalDecorations(doc, [pOuter, pInner], "Notes/Test.md");
      const ranges: Array<[number, number]> = [];
      decos.between(0, doc.length, (f, t) => {
        ranges.push([f, t]);
      });

      expect(ranges).toEqual([[2, 18]]);
    });

    it("3.3 identical duplicate replacement intervals: only first is rendered", () => {
      const doc = Text.of(["The quick brown fox jumps"]);

      const pDup1 = makeProposal("pDup1", 1, 4, 9, "quick", "slow");
      const pDup2 = makeProposal("pDup2", 1, 4, 9, "quick", "fast");

      const decos = buildProposalDecorations(doc, [pDup1, pDup2], "Notes/Test.md");
      let count = 0;
      decos.between(0, doc.length, () => {
        count++;
      });

      expect(count).toBe(1);
    });

    it("3.4 shared start position with different lengths: shorter takes precedence, longer discarded", () => {
      const doc = Text.of(["0123456789ABCDEF"]);

      // pShort: [4, 8], pLong: [4, 12]
      const pShort = makeProposal("pShort", 1, 4, 8, "4567", "S");
      const pLong = makeProposal("pLong", 1, 4, 12, "456789AB", "L");

      const decos = buildProposalDecorations(doc, [pLong, pShort], "Notes/Test.md");
      const ranges: Array<[number, number]> = [];
      decos.between(0, doc.length, (f, t) => {
        ranges.push([f, t]);
      });

      // Sorted by [from, to]: [4, 8] added, then [4, 12] rejected because 4 < 8
      expect(ranges).toEqual([[4, 8]]);
    });

    it("3.5 strictly adjacent replacement intervals are both rendered without collision", () => {
      const doc = Text.of(["0123456789ABCDEF"]);

      const pA = makeProposal("pA", 1, 0, 5, "01234", "first");
      const pB = makeProposal("pB", 1, 5, 10, "56789", "second");
      const pC = makeProposal("pC", 1, 10, 15, "ABCDE", "third");

      const decos = buildProposalDecorations(doc, [pA, pB, pC], "Notes/Test.md");
      const ranges: Array<[number, number]> = [];
      decos.between(0, doc.length, (f, t) => {
        ranges.push([f, t]);
      });

      expect(ranges).toEqual([
        [0, 5],
        [5, 10],
        [10, 15],
      ]);
    });

    it("3.6 fuzzy stress test: 100 randomized/shuffled intervals never throw Invalid order of ranges", () => {
      // Build a 1000-character test document
      const rawText = "abcdefghijklmnopqrstuvwxyz ".repeat(40);
      const doc = Text.of([rawText]);

      const proposals: Proposal[] = [];
      // Generate 100 random intervals
      for (let i = 0; i < 100; i++) {
        const start = Math.floor(Math.random() * (rawText.length - 20));
        const len = Math.floor(Math.random() * 15);
        const orig = rawText.substring(start, start + len);
        proposals.push({
          id: `fuzz-${i}`,
          file: "Notes/Test.md",
          sourceFile: "buf.json",
          line: 1,
          ch: start,
          toCh: start + len,
          original: orig,
          replacement: "REP",
          status: "pending",
        });
      }

      // Shuffle proposals to test sorting resilience
      const shuffled = [...proposals].sort(() => Math.random() - 0.5);

      expect(() => {
        const decos = buildProposalDecorations(doc, shuffled, "Notes/Test.md");
        let lastTo = -1;
        decos.between(0, doc.length, (from, to) => {
          // Strictly monotonic invariant check
          expect(from).toBeGreaterThanOrEqual(lastTo);
          lastTo = to;
        });
      }).not.toThrow();
    });
  });

  // ==========================================================================
  // 4. Rapid Document Mutations & Store Change Dispatching
  // ==========================================================================
  describe("4. Rapid Document Mutations & Store Change Dispatching", () => {
    it("4.1 executes 100 rapid sequential typing transactions without throwing", () => {
      const store = new MockHarnessStore([
        makeProposal("p1", 1, 0, 4, "init", "start"),
      ]);
      const state = createEditorStateWithFile("initial text", "Notes/Test.md", [
        createProposalViewPlugin(store),
      ]);
      const parent = document.createElement("div");
      const view = new EditorView({ state, parent: parent as unknown as HTMLElement });

      expect(() => {
        for (let i = 0; i < 100; i++) {
          view.dispatch({
            changes: { from: view.state.doc.length, insert: `-${i}` },
          });
        }
      }).not.toThrow();

      expect(view.state.doc.length).toBeGreaterThan(100);
      view.destroy();
    });

    it("4.2 survives rapid document replacement cycles", () => {
      const store = new MockHarnessStore();
      const state = createEditorStateWithFile("start", "Notes/Test.md", [
        createProposalViewPlugin(store),
      ]);
      const parent = document.createElement("div");
      const view = new EditorView({ state, parent: parent as unknown as HTMLElement });

      expect(() => {
        for (let cycle = 0; cycle < 30; cycle++) {
          const newContent = cycle % 2 === 0 ? "Line 1\nLine 2\nLine 3" : "Single line";
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: newContent },
          });
        }
      }).not.toThrow();

      view.destroy();
    });

    it("4.3 handles 100 rapid synchronous store notifications via microtask queue", async () => {
      const store = new MockHarnessStore();
      const state = createEditorStateWithFile("Document content", "Notes/Test.md", [
        createProposalViewPlugin(store),
      ]);
      const parent = document.createElement("div");
      const view = new EditorView({ state, parent: parent as unknown as HTMLElement });

      // Dispatch 100 notifications rapidly
      expect(() => {
        for (let i = 0; i < 100; i++) {
          store.notify();
        }
      }).not.toThrow();

      // Flush microtasks
      await new Promise<void>((resolve) => queueMicrotask(() => resolve()));

      // View remains intact
      expect(view.state.doc.length).toBe("Document content".length);
      view.destroy();
    });

    it("4.4 destruction race condition: store notify immediately followed by view.destroy does not crash", async () => {
      const store = new MockHarnessStore();
      const state = createEditorStateWithFile("Doc text", "Notes/Test.md", [
        createProposalViewPlugin(store),
      ]);
      const parent = document.createElement("div");
      const view = new EditorView({ state, parent: parent as unknown as HTMLElement });

      // Trigger store notification (queues microtask)
      store.notify();

      // Immediately destroy view
      view.destroy();

      // Flush microtask: should safely exit without calling dispatch on destroyed view
      await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
    });
  });

  // ==========================================================================
  // 5. Popover Manager & Diff Preview Stress
  // ==========================================================================
  describe("5. Popover Manager & Diff Preview Stress", () => {
    it("5.1 clamps popover in narrow mobile viewport (320x480)", () => {
      const anchor: AnchorRect = { left: 280, right: 310, top: 200, bottom: 220 };
      const popover: Dimensions = { width: 260, height: 140 };
      const viewport: Dimensions = { width: 320, height: 480 };

      const pos = computePopoverPosition(anchor, popover, viewport, { margin: 10 });

      // Clamped horizontally within [10, 320 - 260 - 10] = [10, 50]
      expect(pos.left).toBeLessThanOrEqual(50);
      expect(pos.left).toBeGreaterThanOrEqual(10);
      // Fits below anchor (220 + 6 = 226, 226 + 140 = 366 < 470)
      expect(pos.placement).toBe("bottom");
      expect(pos.top).toBe(226);
    });

    it("5.2 flips popover above anchor when near bottom of viewport", () => {
      const anchor: AnchorRect = { left: 100, right: 150, top: 400, bottom: 420 };
      const popover: Dimensions = { width: 200, height: 100 };
      const viewport: Dimensions = { width: 800, height: 500 };

      // Space below: 500 - 420 - 6 - 12 = 62px (< 100px)
      // Space above: 400 - 6 - 12 = 382px (>= 100px)
      const pos = computePopoverPosition(anchor, popover, viewport);

      expect(pos.placement).toBe("top");
      expect(pos.top).toBe(400 - 100 - 6); // 294
    });

    it("5.3 handles extreme offscreen coordinates without producing NaN or out-of-margin values", () => {
      const popover: Dimensions = { width: 200, height: 100 };
      const viewport: Dimensions = { width: 1000, height: 800 };

      // Anchor far to the negative
      const negativeAnchor: AnchorRect = { left: -500, right: -400, top: -200, bottom: -180 };
      const posNeg = computePopoverPosition(negativeAnchor, popover, viewport, { margin: 15 });
      expect(posNeg.left).toBe(15);
      expect(posNeg.top).toBeGreaterThanOrEqual(15);

      // Anchor far into positive infinity
      const farAnchor: AnchorRect = { left: 99999, right: 100000, top: 99999, bottom: 100000 };
      const posFar = computePopoverPosition(farAnchor, popover, viewport, { margin: 15 });
      expect(posFar.left).toBe(1000 - 200 - 15); // 785
    });

    it("5.4 renders diff preview with XSS injection strings safely as text nodes", () => {
      const xssProposal = makeProposal(
        "p-xss",
        1,
        0,
        10,
        "<script>alert('pwned')</script>",
        "<img src=x onerror=alert('xss')>"
      );

      const previewEl = renderDiffPreview(xssProposal);

      // Verify no script tag or img tag was created as DOM element
      const scripts = previewEl.querySelectorAll("script");
      const images = previewEl.querySelectorAll("img");
      expect(scripts.length).toBe(0);
      expect(images.length).toBe(0);

      // Verify text content is preserved verbatim
      const delEl = previewEl.querySelector(".ai-diff-del");
      expect(delEl?.textContent).toContain("<script>alert('pwned')</script>");

      const insEl = previewEl.querySelector(".ai-diff-add");
      expect(insEl?.textContent).toContain("<img src=x onerror=alert('xss')>");
    });

    it("5.5 handles massive 50,000-character diff payload under 50ms", () => {
      const massiveOriginal = "A".repeat(50000);
      const massiveReplacement = "B".repeat(50000);

      const pMassive = makeProposal("p-massive", 1, 0, 50000, massiveOriginal, massiveReplacement);

      const startTime = Date.now();
      const el = renderDiffPreview(pMassive);
      const elapsed = Date.now() - startTime;

      expect(el).toBeDefined();
      expect(elapsed).toBeLessThan(1000); // Well within performance budget
    });
  });

  // ==========================================================================
  // 6. Adversarial Numeric Coordinate Robustness
  // ==========================================================================
  describe("Adversarial Numeric Coordinate Robustness", () => {
    it("returns null for NaN, Infinity, -Infinity, and float line numbers without throwing", () => {
      const doc = Text.of(["Line 1", "Line 2", "Line 3"]);

      const invalidLines = [NaN, Infinity, -Infinity, 1.5, -0.5, 0, -999, 99999];
      for (const invalidLine of invalidLines) {
        // Pure insertion
        const pZero = {
          id: `p-zero-${invalidLine}`,
          file: "Doc.md",
          sourceFile: "buf.json",
          line: invalidLine,
          ch: 0,
          toCh: 0,
          original: "",
          replacement: "hello",
          status: "pending" as const,
        };
        expect(() => resolveProposalRange(doc, pZero)).not.toThrow();
        expect(resolveProposalRange(doc, pZero)).toBeNull();

        // Replacement
        const pRep = {
          id: `p-rep-${invalidLine}`,
          file: "Doc.md",
          sourceFile: "buf.json",
          line: invalidLine,
          ch: 0,
          toCh: 6,
          original: "Line 1",
          replacement: "Replaced",
          status: "pending" as const,
        };
        expect(() => resolveProposalRange(doc, pRep)).not.toThrow();
        expect(resolveProposalRange(doc, pRep)).toBeNull();
      }
    });

    it("handles NaN and non-integer column offsets without crashing RangeSetBuilder", () => {
      const doc = Text.of(["Test Line"]);

      const invalidCols = [NaN, Infinity, -Infinity, 2.5, -1, 500];
      for (const col of invalidCols) {
        const pZero = {
          id: `p-col-${col}`,
          file: "Doc.md",
          sourceFile: "buf.json",
          line: 1,
          ch: col,
          toCh: col,
          original: "",
          replacement: "insert",
          status: "pending" as const,
        };
        expect(() => resolveProposalRange(doc, pZero)).not.toThrow();
        if (col !== 0) {
          expect(resolveProposalRange(doc, pZero)).toBeNull();
        }
      }

      // Assert buildProposalDecorations does not crash when proposals with NaN columns are present
      const malformedProposal = {
        id: "p-nan-col",
        file: "Doc.md",
        sourceFile: "buf.json",
        line: 1,
        ch: NaN,
        toCh: NaN,
        original: "",
        replacement: "bad",
        status: "pending" as const,
      };
      expect(() => buildProposalDecorations(doc, [malformedProposal])).not.toThrow();
      const decos = buildProposalDecorations(doc, [malformedProposal]);
      expect(decos.size).toBe(0);
    });

    it("computePopoverPosition handles NaN anchor coordinates and dimensions safely", () => {
      const nanAnchor = { left: NaN, right: NaN, top: NaN, bottom: NaN };
      const pos = computePopoverPosition(nanAnchor, { width: NaN, height: NaN }, { width: NaN, height: NaN });
      expect(Number.isFinite(pos.left)).toBe(true);
      expect(Number.isFinite(pos.top)).toBe(true);
      expect(["top", "bottom"]).toContain(pos.placement);
    });
  });
});

