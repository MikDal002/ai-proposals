/**
 * tests/m3_popover_stress_harness.test.ts
 * Empirical Adversarial Stress Harness for Milestone 3 PopoverManager.
 *
 * Authored by: teamwork_preview_challenger (m3_challenger_2)
 *
 * Focus areas:
 * 1. Extreme screen geometries in computePopoverPosition:
 *    - Micro-screens (240x200)
 *    - Huge popovers exceeding viewport dimensions (1200x900, 5000x5000)
 *    - Anchors outside viewport (top: -50, bottom: -30; right: 2000; bottom: -500; top: 10000; left: -200)
 *    - Invariant: Clamping never returns NaN or undefined for top, left, or placement
 *    - Fuzz test across 200 randomized extreme coordinate combinations
 *
 * 2. Concurrency & Rapid Clicks on Accept/Reject buttons:
 *    - Button locking during in-flight asynchronous store operations
 *    - Rapid double-clicks on Accept button: verify whether store.acceptProposal is invoked once or multiple times
 *    - Rapid double-clicks on Reject button: verify whether store.rejectProposal is invoked once or multiple times
 *    - Cross-button race conditions (clicking Accept then immediately clicking Reject)
 *    - Evaluation of whether promise locks protect against double-invocation
 *
 * 3. XSS attack payloads in proposal original, replacement, rule, author, and explanation:
 *    - Malicious script tags, onerror images, iframes, svg onload vectors
 *    - Verification that renderDiffPreview and PopoverManager escape all tags and prevent script injection
 *    - Verification of unicode, null bytes, and HTML entity payloads
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Proposal, IProposalStore } from "../src/types";
import {
  PopoverManager,
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
    this.children = [];
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

  dispatchEvent(event: { type: string; preventDefault?: () => void; stopPropagation?: () => void }): boolean {
    const set = this.listeners.get(event.type);
    if (set) {
      for (const l of Array.from(set)) {
        l(event as unknown as Event);
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
    el.nodeType = 3;
    el.textContent = text;
    return el;
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

  dispatchEvent(event: { type: string; preventDefault?: () => void; stopPropagation?: () => void }): boolean {
    const set = this.documentListeners.get(event.type);
    if (set) {
      for (const l of Array.from(set)) {
        l(event as unknown as Event);
      }
    }
    return true;
  }
}

let savedGlobals: Record<string, unknown> = {};

function setupHeadlessDOM() {
  const mockDoc = new HeadlessDocument();
  savedGlobals = {
    window: global.window,
    document: global.document,
    HTMLElement: global.HTMLElement,
    Element: global.Element,
    Node: global.Node,
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
  };

  mockDoc.defaultView = mockWindow;

  (global as unknown as { window: unknown }).window = mockWindow;
  (global as unknown as { document: unknown }).document = mockDoc;
  (global as unknown as { HTMLElement: unknown }).HTMLElement = HeadlessElement;
  (global as unknown as { Element: unknown }).Element = HeadlessElement;
  (global as unknown as { Node: unknown }).Node = HeadlessElement;
}

function teardownHeadlessDOM() {
  Object.assign(global, savedGlobals);
}

// ============================================================================
// Concurrency Tracking Mock Proposal Store
// ============================================================================

class ConcurrencyMockProposalStore implements IProposalStore {
  public proposals: Proposal[] = [];
  public listeners: Set<() => void> = new Set();
  public acceptInvocationCount = 0;
  public rejectInvocationCount = 0;
  public inFlightAccepts = 0;
  public inFlightRejects = 0;
  public maxConcurrentAccepts = 0;
  public maxConcurrentRejects = 0;

  public acceptDelayMs = 0;
  public rejectDelayMs = 0;

  constructor(initial: Proposal[] = []) {
    this.proposals = [...initial];
  }

  async initialize(): Promise<void> {}
  async scanVaultBuffers(): Promise<Proposal[]> {
    return this.proposals;
  }
  getProposalsForFile(filePath: string): Proposal[] {
    return this.proposals.filter((p) => p.file === filePath);
  }
  getAllProposals(): Proposal[] {
    return this.proposals;
  }
  getProposalById(proposalId: string): Proposal | undefined {
    return this.proposals.find((x) => x.id === proposalId || x.compoundId === proposalId);
  }

  async acceptProposal(proposalId: string): Promise<boolean> {
    this.acceptInvocationCount++;
    this.inFlightAccepts++;
    if (this.inFlightAccepts > this.maxConcurrentAccepts) {
      this.maxConcurrentAccepts = this.inFlightAccepts;
    }

    if (this.acceptDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.acceptDelayMs));
    }

    this.inFlightAccepts--;
    const p = this.proposals.find((x) => x.id === proposalId || x.compoundId === proposalId);
    if (p) {
      p.status = "applied";
      this.listeners.forEach((l) => l());
      return true;
    }
    return false;
  }

  async rejectProposal(proposalId: string): Promise<boolean> {
    this.rejectInvocationCount++;
    this.inFlightRejects++;
    if (this.inFlightRejects > this.maxConcurrentRejects) {
      this.maxConcurrentRejects = this.inFlightRejects;
    }

    if (this.rejectDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.rejectDelayMs));
    }

    this.inFlightRejects--;
    const p = this.proposals.find((x) => x.id === proposalId || x.compoundId === proposalId);
    if (p) {
      p.status = "rejected";
      this.listeners.forEach((l) => l());
      return true;
    }
    return false;
  }

  onStoreChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.listeners.clear();
  }
}

// ============================================================================
// TEST SUITE
// ============================================================================

describe("Milestone 3 PopoverManager Adversarial Stress Harness (m3_challenger_2)", () => {
  beforeEach(() => {
    setupHeadlessDOM();
  });

  afterEach(() => {
    teardownHeadlessDOM();
  });

  // ==========================================================================
  // SCENARIO 1: Extreme Screen Geometries in computePopoverPosition
  // ==========================================================================
  describe("Scenario 1: Extreme Screen Geometries in computePopoverPosition", () => {
    it("1.1 micro-screen (240x200): standard popover (320x160) never produces NaN or undefined", () => {
      const viewport: Dimensions = { width: 240, height: 200 };
      const popover: Dimensions = { width: 320, height: 160 };
      const anchor: AnchorRect = { top: 50, bottom: 70, left: 30, right: 80 };

      const pos = computePopoverPosition(anchor, popover, viewport);

      expect(typeof pos.top).toBe("number");
      expect(typeof pos.left).toBe("number");
      expect(Number.isNaN(pos.top)).toBe(false);
      expect(Number.isNaN(pos.left)).toBe(false);
      expect(pos.placement).toMatch(/^(top|bottom)$/);
      expect(pos.left).toBeGreaterThanOrEqual(12); // Clamped to minimum margin
      expect(pos.top).toBeGreaterThanOrEqual(12);  // Clamped to ceiling margin
    });

    it("1.2 huge popover (1200x900) exceeding small viewport (800x600): clamped without NaN", () => {
      const viewport: Dimensions = { width: 800, height: 600 };
      const hugePopover: Dimensions = { width: 1200, height: 900 };
      const anchor: AnchorRect = { top: 250, bottom: 270, left: 200, right: 300 };

      const pos = computePopoverPosition(anchor, hugePopover, viewport);

      expect(Number.isNaN(pos.top)).toBe(false);
      expect(Number.isNaN(pos.left)).toBe(false);
      expect(pos.left).toBe(12); // Popover wider than viewport clamped to left margin
      expect(pos.top).toBe(12);  // Popover taller than viewport clamped to top margin
    });

    it("1.3 anchor outside viewport above screen (top: -50, bottom: -30): clamped to ceiling margin", () => {
      const viewport: Dimensions = { width: 1024, height: 768 };
      const popover: Dimensions = { width: 300, height: 150 };
      const anchor: AnchorRect = { top: -50, bottom: -30, left: 100, right: 200 };

      const pos = computePopoverPosition(anchor, popover, viewport);

      expect(Number.isNaN(pos.top)).toBe(false);
      expect(Number.isNaN(pos.left)).toBe(false);
      expect(pos.top).toBeGreaterThanOrEqual(12);
      expect(pos.left).toBe(100);
    });

    it("1.4 anchor outside viewport to the right (right: 2000, left: 1950): clamped to right margin", () => {
      const viewport: Dimensions = { width: 1024, height: 768 };
      const popover: Dimensions = { width: 300, height: 150 };
      const anchor: AnchorRect = { top: 100, bottom: 120, left: 1950, right: 2000 };

      const pos = computePopoverPosition(anchor, popover, viewport, { margin: 16 });

      expect(Number.isNaN(pos.top)).toBe(false);
      expect(Number.isNaN(pos.left)).toBe(false);
      expect(pos.left).toBe(1024 - 300 - 16); // 708
      expect(pos.left + 300).toBeLessThanOrEqual(1024);
    });

    it("1.5 anchor outside viewport to the left (left: -200, right: -50): clamped to left margin", () => {
      const viewport: Dimensions = { width: 1024, height: 768 };
      const popover: Dimensions = { width: 300, height: 150 };
      const anchor: AnchorRect = { top: 100, bottom: 120, left: -200, right: -50 };

      const pos = computePopoverPosition(anchor, popover, viewport, { margin: 10 });

      expect(Number.isNaN(pos.top)).toBe(false);
      expect(Number.isNaN(pos.left)).toBe(false);
      expect(pos.left).toBe(10);
    });

    it("1.6 flat numeric dimension signature behaves identically to object signature", () => {
      const anchor: AnchorRect = { top: 100, bottom: 120, left: 150, right: 250 };
      const posObj = computePopoverPosition(anchor, { width: 300, height: 150 }, { width: 1024, height: 768 });
      const posNum = computePopoverPosition(anchor, 300, 150, 1024, 768);

      expect(posObj.top).toBe(posNum.top);
      expect(posObj.left).toBe(posNum.left);
      expect(posObj.placement).toBe(posNum.placement);
    });

    it("1.7 fuzzing: 200 randomized extreme geometry permutations never return NaN or undefined", () => {
      for (let i = 0; i < 200; i++) {
        const vpW = Math.floor(Math.random() * 2000) + 100;
        const vpH = Math.floor(Math.random() * 2000) + 100;
        const popW = Math.floor(Math.random() * 1500) + 50;
        const popH = Math.floor(Math.random() * 1500) + 50;
        const ancL = Math.floor(Math.random() * 3000) - 500;
        const ancT = Math.floor(Math.random() * 3000) - 500;
        const ancW = Math.floor(Math.random() * 200);
        const ancH = Math.floor(Math.random() * 50);
        const margin = Math.floor(Math.random() * 30);
        const gap = Math.floor(Math.random() * 20);

        const anchor: AnchorRect = {
          left: ancL,
          right: ancL + ancW,
          top: ancT,
          bottom: ancT + ancH,
        };

        const pos = computePopoverPosition(anchor, { width: popW, height: popH }, { width: vpW, height: vpH }, {
          margin,
          gap,
        });

        expect(typeof pos.top).toBe("number");
        expect(typeof pos.left).toBe("number");
        expect(Number.isNaN(pos.top)).toBe(false);
        expect(Number.isNaN(pos.left)).toBe(false);
        expect(pos.top).not.toBeUndefined();
        expect(pos.left).not.toBeUndefined();
        expect(pos.placement).toMatch(/^(top|bottom)$/);
        expect(pos.top).toBeGreaterThanOrEqual(margin);
        expect(pos.left).toBeGreaterThanOrEqual(margin);
      }
    });
  });

  // ==========================================================================
  // SCENARIO 2: Concurrency & Rapid Clicks on Accept/Reject Buttons
  // ==========================================================================
  describe("Scenario 2: Concurrency & Rapid Clicks on Accept/Reject Buttons", () => {
    const makeProposal = (id: string): Proposal => ({
      id,
      file: "note.md",
      sourceFile: "buf.json",
      line: 1,
      ch: 0,
      toCh: 5,
      original: "hello",
      replacement: "world",
      status: "pending",
    });

    it("2.1 locks accept and reject buttons synchronously upon invocation", async () => {
      const proposal = makeProposal("p-lock-test");
      const store = new ConcurrencyMockProposalStore([proposal]);
      store.acceptDelayMs = 50;

      const popoverManager = new PopoverManager(store);
      const anchorEl = document.createElement("span");
      popoverManager.show(proposal, anchorEl as unknown as HTMLElement);

      const activePopover = (document.body as unknown as HeadlessElement).children.find((c) =>
        c.className.includes("ai-proposal-popover")
      );
      expect(activePopover).toBeDefined();

      const acceptBtn = activePopover!.querySelector(".ai-proposal-btn-accept")!;
      const rejectBtn = activePopover!.querySelector(".ai-proposal-btn-reject")!;

      expect(acceptBtn.disabled).toBe(false);
      expect(rejectBtn.disabled).toBe(false);

      // Trigger accept click
      const clickEvent = {
        type: "click",
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      };
      acceptBtn.dispatchEvent(clickEvent);

      // Immediately after click, buttons must be disabled and loading state set synchronously
      expect(acceptBtn.disabled).toBe(true);
      expect(rejectBtn.disabled).toBe(true);
      expect(acceptBtn.classList.contains("is-loading")).toBe(true);

      // Wait for delayed store operation to finish
      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(store.acceptInvocationCount).toBe(1);
      popoverManager.dispose();
    });

    it("2.2 rapid double-clicks on Accept button: empirically measures double-invocation behavior", async () => {
      const proposal = makeProposal("p-rapid-accept");
      const store = new ConcurrencyMockProposalStore([proposal]);
      store.acceptDelayMs = 60; // 60ms async latency

      const popoverManager = new PopoverManager(store);
      const anchorEl = document.createElement("span");
      popoverManager.show(proposal, anchorEl as unknown as HTMLElement);

      const activePopover = (document.body as unknown as HeadlessElement).children.find((c) =>
        c.className.includes("ai-proposal-popover")
      );
      const acceptBtn = activePopover!.querySelector(".ai-proposal-btn-accept")!;

      const clickEvent1 = { type: "click", preventDefault: vi.fn(), stopPropagation: vi.fn() };
      const clickEvent2 = { type: "click", preventDefault: vi.fn(), stopPropagation: vi.fn() };

      // Dispatch two rapid clicks back-to-back while promise is in-flight
      acceptBtn.dispatchEvent(clickEvent1);
      acceptBtn.dispatchEvent(clickEvent2);

      // Await completion of all pending promises
      await new Promise((resolve) => setTimeout(resolve, 100));

      const invocationCount = store.acceptInvocationCount;
      console.log(`[STRESS_TEST] acceptInvocationCount: ${invocationCount}`);
      popoverManager.dispose();

      // Verify that promises lock buttons and prevent double-invocation of store.acceptProposal
      expect(invocationCount).toBe(1);
    });

    it("2.3 cross-button race condition: clicking Accept then immediately Reject", async () => {
      const proposal = makeProposal("p-cross-click");
      const store = new ConcurrencyMockProposalStore([proposal]);
      store.acceptDelayMs = 60;
      store.rejectDelayMs = 60;

      const popoverManager = new PopoverManager(store);
      const anchorEl = document.createElement("span");
      popoverManager.show(proposal, anchorEl as unknown as HTMLElement);

      const activePopover = (document.body as unknown as HeadlessElement).children.find((c) =>
        c.className.includes("ai-proposal-popover")
      );
      const acceptBtn = activePopover!.querySelector(".ai-proposal-btn-accept")!;
      const rejectBtn = activePopover!.querySelector(".ai-proposal-btn-reject")!;

      const clickEvent = { type: "click", preventDefault: vi.fn(), stopPropagation: vi.fn() };

      // Click Accept, then immediately click Reject while Accept is pending
      acceptBtn.dispatchEvent(clickEvent);
      rejectBtn.dispatchEvent(clickEvent);

      await new Promise((resolve) => setTimeout(resolve, 100));

      popoverManager.dispose();

      const totalInvocations = store.acceptInvocationCount + store.rejectInvocationCount;
      console.log(`[STRESS_TEST] cross-click totalInvocations: ${totalInvocations}`);
      expect(totalInvocations).toBe(1);
    });
  });

  // ==========================================================================
  // SCENARIO 3: XSS Attack Payloads in All Proposal Fields
  // ==========================================================================
  describe("Scenario 3: XSS Attack Payloads in All Proposal Fields", () => {
    it("3.1 escapes script tags and event handlers in original and replacement (renderDiffPreview)", () => {
      const xssProposal: Proposal = {
        id: "p-xss-diff",
        file: "test.md",
        sourceFile: "buf.json",
        line: 1,
        ch: 0,
        toCh: 10,
        original: "<script>alert('xss-orig')</script><img src=x onerror=alert(1)>",
        replacement: "<script>alert('xss-rep')</script><iframe src=\"javascript:alert(2)\"></iframe><svg onload=alert(3)>",
        status: "pending",
      };

      const preview = renderDiffPreview(xssProposal);

      // Verify that no executable tags exist in DOM
      const scripts = (preview as unknown as HeadlessElement).querySelectorAll("script");
      const images = (preview as unknown as HeadlessElement).querySelectorAll("img");
      const iframes = (preview as unknown as HeadlessElement).querySelectorAll("iframe");
      const svgs = (preview as unknown as HeadlessElement).querySelectorAll("svg");

      expect(scripts.length).toBe(0);
      expect(images.length).toBe(0);
      expect(iframes.length).toBe(0);
      expect(svgs.length).toBe(0);

      // Verify text nodes faithfully preserved verbatim text without executing
      const delEl = (preview as unknown as HeadlessElement).querySelector("del")!;
      const insEl = (preview as unknown as HeadlessElement).querySelector("ins")!;

      expect(delEl.textContent).toContain("<script>alert('xss-orig')</script>");
      expect(insEl.textContent).toContain("<iframe src=\"javascript:alert(2)\"></iframe>");
    });

    it("3.2 escapes HTML tags in rule, author, and explanation in PopoverManager header & body", () => {
      const store = new ConcurrencyMockProposalStore();
      const popoverManager = new PopoverManager(store);

      const xssProposal: Proposal = {
        id: "p-xss-meta",
        file: "test.md",
        sourceFile: "buf.json",
        line: 1,
        ch: 0,
        toCh: 5,
        original: "safe orig",
        replacement: "safe rep",
        rule: "<b onmouseover=alert(1)>Malicious Rule</b>",
        author: "<script>alert('evil-author')</script>",
        explanation: "<img src=x onerror=alert(5)><a href=\"javascript:void(0)\">Exploit</a>",
        status: "pending",
      };

      const anchorEl = document.createElement("span");
      popoverManager.show(xssProposal, anchorEl as unknown as HTMLElement);

      const activePopover = (document.body as unknown as HeadlessElement).children.find((c) =>
        c.className.includes("ai-proposal-popover")
      )!;
      expect(activePopover).toBeDefined();

      // Rule badge
      const ruleBadge = activePopover.querySelector(".ai-proposal-rule-badge")!;
      expect(ruleBadge.children.length).toBe(0); // Must be pure text, no <b> element
      expect(ruleBadge.textContent).toBe("<b onmouseover=alert(1)>Malicious Rule</b>");

      // Author badge
      const authorBadge = activePopover.querySelector(".ai-proposal-author-badge")!;
      expect(authorBadge.children.length).toBe(0); // Must be pure text, no <script> element
      expect(authorBadge.textContent).toBe("<script>alert('evil-author')</script>");

      // Explanation
      const explanationEl = activePopover.querySelector(".ai-proposal-explanation")!;
      expect(explanationEl.children.length).toBe(0); // Must be pure text, no <img> or <a> elements
      expect(explanationEl.textContent).toBe("<img src=x onerror=alert(5)><a href=\"javascript:void(0)\">Exploit</a>");

      // Ensure no script, img, or a elements exist anywhere in popover root
      const rootScripts = activePopover.querySelectorAll("script");
      const rootImages = activePopover.querySelectorAll("img");
      const rootLinks = activePopover.querySelectorAll("a");

      expect(rootScripts.length).toBe(0);
      expect(rootImages.length).toBe(0);
      expect(rootLinks.length).toBe(0);

      popoverManager.dispose();
    });

    it("3.3 sanitizes null bytes, unicode control chars, and nested angle brackets", () => {
      const proposal: Proposal = {
        id: "p-xss-unicode",
        file: "test.md",
        sourceFile: "buf.json",
        line: 1,
        ch: 0,
        toCh: 5,
        original: "\u0000<script>/*\u200B*/alert('unicode')</script>",
        replacement: "<<<SCRIPT>>>alert('nested')<<</SCRIPT>>",
        status: "pending",
      };

      const preview = renderDiffPreview(proposal);
      const scripts = (preview as unknown as HeadlessElement).querySelectorAll("script");
      expect(scripts.length).toBe(0);

      const delEl = (preview as unknown as HeadlessElement).querySelector("del")!;
      expect(delEl.textContent).toContain("\u0000<script>");
    });
  });
});
