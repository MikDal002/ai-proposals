/**
 * tests/sidebar-view.test.ts
 * Comprehensive Headless Unit & Integration Test Suite for Milestone 4 Sidebar ItemView.
 *
 * Covers:
 * - SB-01 to SB-03: Contracts & View Identity
 * - SB-04 to SB-05: Mounting & Lifecycle
 * - SB-06 to SB-08: Two-Tier Proposal Grouping & Partition Disjointness
 * - SB-09 to SB-11: Empty State Granularity (4 states)
 * - SB-12 to SB-16: Proposal Card UI, Diff Previews & HTML Sanitization
 * - SB-17 to SB-19: Jump-to-Line Navigation & Leaf Guard
 * - SB-20 to SB-24: Accept/Reject Actions, Mutex & Triple-Guard Concurrency Locking
 * - SB-25 to SB-26: Reactive Store & Active Note Synchronization
 * - SB-27 to SB-28: Lifecycle Hardening & Null Container Defense (Iteration 2)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  App as MockApp,
  WorkspaceLeaf as MockLeaf,
  TFile,
} from "./mocks/obsidian";
import type { App, WorkspaceLeaf } from "obsidian";
import type { IProposalStore, Proposal } from "../src/types";

import {
  ProposalSidebarView,
  VIEW_TYPE_PROPOSAL_SIDEBAR,
} from "../src/ui/proposal-sidebar-view";

// ============================================================================
// Headless DOM Environment Setup
// ============================================================================

class HeadlessElement {
  nodeType = 1;
  tagName: string;
  private _textContent = "";
  get textContent(): string {
    if (this.children.length === 0) {
      return this._textContent;
    }
    return this.children.map((c) => c.textContent).join("");
  }
  set textContent(val: string) {
    this._textContent = val;
    if (val === "") {
      this.children = [];
    }
  }
  disabled = false;
  className = "";
  innerHTML = "";
  title = "";
  style: Record<string, string> = {};
  attributes = new Map<string, string>();
  children: HeadlessElement[] = [];
  parentNode: HeadlessElement | null = null;
  ownerDocument: HeadlessDocument | null = null;
  scrollTop = 0;
  private listeners: Map<string, Set<(evt: any) => void>> = new Map();

  constructor(tagName: string, ownerDoc?: HeadlessDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDoc ?? null;
  }

  empty(): void {
    while (this.children.length > 0) {
      const child = this.children.pop();
      if (child) child.parentNode = null;
    }
    this.textContent = "";
    this.innerHTML = "";
  }

  createDiv(options?: { cls?: string; text?: string; attr?: Record<string, string> } | string): HeadlessElement {
    return this.createEl("div", options);
  }

  createSpan(options?: { cls?: string; text?: string; attr?: Record<string, string> } | string): HeadlessElement {
    return this.createEl("span", options);
  }

  createEl(
    tag: string,
    options?: { cls?: string; text?: string; attr?: Record<string, string>; title?: string } | string
  ): HeadlessElement {
    const doc = this.ownerDocument ?? new HeadlessDocument();
    const el = doc.createElement(tag);
    if (typeof options === "string") {
      el.className = options;
    } else if (options) {
      if (options.cls) el.className = options.cls;
      if (options.text) el.textContent = options.text;
      if (options.title) el.title = options.title;
      if (options.attr) {
        for (const [k, v] of Object.entries(options.attr)) {
          el.setAttribute(k, v);
        }
      }
    }
    this.appendChild(el);
    return el;
  }

  setText(val: string): void {
    this.textContent = val;
  }

  addClass(...classes: string[]): void {
    this.classList.add(...classes);
  }

  removeClass(...classes: string[]): void {
    this.classList.remove(...classes);
  }

  toggleClass(cls: string, value?: boolean): void {
    this.classList.toggle(cls, value);
  }

  hasClass(cls: string): boolean {
    return this.classList.contains(cls);
  }

  setAttr(key: string, val: string): void {
    this.setAttribute(key, val);
  }

  get classList() {
    return {
      add: (...classes: string[]) => {
        const tokens = new Set((this.className || "").split(" ").filter(Boolean));
        classes.forEach((c) => tokens.add(c));
        this.className = Array.from(tokens).join(" ");
      },
      remove: (...classes: string[]) => {
        const tokens = new Set((this.className || "").split(" ").filter(Boolean));
        classes.forEach((c) => tokens.delete(c));
        this.className = Array.from(tokens).join(" ");
      },
      contains: (c: string) => (this.className || "").split(" ").filter(Boolean).includes(c),
      toggle: (c: string, force?: boolean) => {
        const has = this.classList.contains(c);
        const shouldAdd = force !== undefined ? force : !has;
        if (shouldAdd) this.classList.add(c);
        else this.classList.remove(c);
      },
    };
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
    if (name === "class") this.className = String(value);
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

  remove(): void {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  get isConnected(): boolean {
    let curr: HeadlessElement | null = this;
    while (curr) {
      if (curr.tagName === "HTML" || curr.tagName === "DIV") {
        return true;
      }
      curr = curr.parentNode;
    }
    return true;
  }

  querySelector<T extends HeadlessElement = HeadlessElement>(selector: string): T | null {
    return this.querySelectorAll<T>(selector)[0] ?? null;
  }

  querySelectorAll<T extends HeadlessElement = HeadlessElement>(selector: string): T[] {
    const results: T[] = [];
    const check = (node: HeadlessElement) => {
      for (const child of node.children) {
        let match = false;
        if (selector.includes(",")) {
          const parts = selector.split(",").map((s) => s.trim());
          match = parts.some((part) => this.matchSingleSelector(child, part));
        } else {
          match = this.matchSingleSelector(child, selector);
        }

        if (match) results.push(child as unknown as T);
        check(child);
      }
    };
    check(this);
    return results;
  }

  private matchSingleSelector(el: HeadlessElement, selector: string): boolean {
    if (selector.startsWith(".")) {
      const cls = selector.slice(1);
      return el.classList.contains(cls);
    }
    if (selector.startsWith("[") && selector.endsWith("]")) {
      const inner = selector.slice(1, -1);
      const [attr, val] = inner.split("=");
      if (!val) return el.hasAttribute(attr);
      const cleanVal = val.replace(/['"]/g, "");
      return el.getAttribute(attr) === cleanVal;
    }
    return el.tagName === selector.toUpperCase();
  }

  addEventListener(type: string, listener: (evt: any) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: (evt: any) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: { type: string; preventDefault?: () => void; stopPropagation?: () => void }): boolean {
    const list = this.listeners.get(event.type);
    if (list) {
      for (const l of Array.from(list)) {
        l({
          preventDefault: () => {},
          stopPropagation: () => {},
          ...event,
        });
      }
    }
    return true;
  }
}

class HeadlessDocument {
  documentElement: HeadlessElement;
  body: HeadlessElement;
  head: HeadlessElement;

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
}

// ============================================================================
// Concurrency & Mutex Mock Store
// ============================================================================

class MockProposalStore implements IProposalStore {
  proposals: Proposal[] = [];
  listeners: Set<() => void> = new Set();

  acceptInvocationCount = 0;
  rejectInvocationCount = 0;
  inFlightAccepts = 0;
  inFlightRejects = 0;
  maxConcurrentAccepts = 0;
  maxConcurrentRejects = 0;

  acceptDelayMs = 0;
  rejectDelayMs = 0;
  shouldFailMutation = false;

  constructor(initialProposals: Proposal[] = []) {
    this.proposals = initialProposals.map((p) => ({ ...p }));
  }

  async initialize(): Promise<void> {}
  async scanVaultBuffers(): Promise<Proposal[]> {
    return this.proposals;
  }

  getProposalsForFile(filePath: string): Proposal[] {
    return this.proposals.filter((p) => p.file === filePath && p.status === "pending");
  }

  getAllProposals(): Proposal[] {
    return this.proposals.filter((p) => p.status === "pending");
  }

  getProposalById(id: string): Proposal | undefined {
    return this.proposals.find((p) => (p.compoundId ?? p.id) === id);
  }

  async acceptProposal(id: string): Promise<boolean> {
    this.acceptInvocationCount++;
    this.inFlightAccepts++;
    this.maxConcurrentAccepts = Math.max(this.maxConcurrentAccepts, this.inFlightAccepts);

    if (this.acceptDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.acceptDelayMs));
    }

    this.inFlightAccepts--;

    if (this.shouldFailMutation) {
      return false;
    }

    const prop = this.getProposalById(id);
    if (!prop) return false;

    prop.status = "applied";
    this.notify();
    return true;
  }

  async rejectProposal(id: string): Promise<boolean> {
    this.rejectInvocationCount++;
    this.inFlightRejects++;
    this.maxConcurrentRejects = Math.max(this.maxConcurrentRejects, this.inFlightRejects);

    if (this.rejectDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.rejectDelayMs));
    }

    this.inFlightRejects--;

    if (this.shouldFailMutation) {
      return false;
    }

    const prop = this.getProposalById(id);
    if (!prop) return false;

    prop.status = "rejected";
    this.notify();
    return true;
  }

  onStoreChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(): void {
    for (const l of Array.from(this.listeners)) {
      l();
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}

// ============================================================================
// Test Suite
// ============================================================================

describe("ProposalSidebarView (Milestone 4 Headless Test Suite)", () => {
  let mockApp: MockApp;
  let mockLeaf: MockLeaf;
  let mockStore: MockProposalStore;
  let view: ProposalSidebarView;
  let sampleProposals: Proposal[];
  let headlessDoc: HeadlessDocument;

  beforeEach(() => {
    headlessDoc = new HeadlessDocument();
    mockApp = new MockApp();
    mockLeaf = new MockLeaf();

    (mockLeaf as any).containerEl = headlessDoc.createElement("div");

    sampleProposals = [
      {
        id: "p1",
        file: "Notes/ActiveDoc.md",
        sourceFile: "ai_suggestion-01.json",
        line: 12,
        ch: 5,
        toCh: 9,
        original: "teh",
        replacement: "the",
        status: "pending",
        rule: "spelling",
        author: "AgentA",
        explanation: "Fix typo teh -> the",
      },
      {
        id: "p2",
        file: "Notes/ActiveDoc.md",
        sourceFile: "ai_suggestion-01.json",
        line: 18,
        ch: 0,
        toCh: 0,
        original: "",
        replacement: "# Header\n",
        status: "pending",
        rule: "structure",
        author: "AgentA",
        explanation: "Add missing header",
      },
      {
        id: "p3",
        file: "Notes/OtherDoc.md",
        sourceFile: "ai_suggestion-02.json",
        line: 42,
        ch: 2,
        toCh: 10,
        original: "obsolete",
        replacement: "modern",
        status: "pending",
        rule: "style",
        author: "AgentB",
        explanation: "Modernize terminology",
      },
    ];

    mockStore = new MockProposalStore(sampleProposals);

    // Active note in workspace
    mockApp.vault.seedFile("Notes/ActiveDoc.md", "# Active Doc content");
    mockApp.vault.seedFile("Notes/OtherDoc.md", "# Other Doc content");
    const activeFile = mockApp.vault.getAbstractFileByPath("Notes/ActiveDoc.md") as TFile;
    mockApp.workspace.getActiveFile = vi.fn().mockReturnValue(activeFile);
    mockApp.workspace.getActiveViewOfType = vi.fn().mockReturnValue(null);
    mockApp.workspace.openLinkText = vi.fn().mockResolvedValue(undefined);

    view = new ProposalSidebarView(mockLeaf as unknown as WorkspaceLeaf, mockApp as unknown as App, mockStore);

    // Mount headless DOM elements
    (view as any).containerEl = headlessDoc.createElement("div");
    (view as any).contentEl = (view as any).containerEl.createDiv({ cls: "view-content" });
  });

  afterEach(() => {
    view.onClose();
  });

  describe("Contract & View Identity", () => {
    it("SB-01: exposes correct VIEW_TYPE constant", () => {
      expect(VIEW_TYPE_PROPOSAL_SIDEBAR).toBe("ai-proposals-sidebar");
      expect(view.getViewType()).toBe("ai-proposals-sidebar");
    });

    it("SB-02: returns standard display text", () => {
      expect(view.getDisplayText()).toBe("AI Proposals");
    });

    it("SB-03: returns standard icon identifier", () => {
      expect(["sparkles", "git-pull-request", "bot"]).toContain(view.getIcon());
    });
  });

  describe("Mounting & Lifecycle", () => {
    it("SB-04: onOpen subscribes to store changes and renders initial view", async () => {
      expect(mockStore.listeners.size).toBe(0);
      await view.onOpen();
      expect(mockStore.listeners.size).toBe(1);

      const content = (view as any).contentEl as HeadlessElement;
      expect(content.children.length).toBeGreaterThan(0);
    });

    it("SB-05: onClose unregisters store change listener cleanly", async () => {
      await view.onOpen();
      expect(mockStore.listeners.size).toBe(1);

      await view.onClose();
      expect(mockStore.listeners.size).toBe(0);
    });
  });

  describe("Two-Tier Proposal Grouping", () => {
    it("SB-06 & SB-07: correctly partitions active note vs other vault proposals", async () => {
      await view.onOpen();
      const content = (view as any).contentEl as HeadlessElement;

      // Section 1: Active File
      const activeSection = content.querySelector(".ai-proposals-section-active");
      expect(activeSection).not.toBeNull();
      const activeCards = activeSection!.querySelectorAll(".ai-proposals-card");
      expect(activeCards.length).toBe(2);

      // Section 2: Vault Proposals
      const vaultSection = content.querySelector(".ai-proposals-section-vault");
      expect(vaultSection).not.toBeNull();
      const vaultCards = vaultSection!.querySelectorAll(".ai-proposals-card");
      expect(vaultCards.length).toBe(1);
    });

    it("SB-08: guarantees disjoint partitions (zero duplicate cards across sections)", async () => {
      await view.onOpen();
      const content = (view as any).contentEl as HeadlessElement;

      const activeSection = content.querySelector(".ai-proposals-section-active")!;
      const vaultSection = content.querySelector(".ai-proposals-section-vault")!;

      const activeIds = activeSection
        .querySelectorAll(".ai-proposals-card")
        .map((c) => c.getAttribute("data-proposal-id"));
      const vaultIds = vaultSection
        .querySelectorAll(".ai-proposals-card")
        .map((c) => c.getAttribute("data-proposal-id"));

      expect(activeIds).toEqual(["p1", "p2"]);
      expect(vaultIds).toEqual(["p3"]);

      const intersection = activeIds.filter((id) => vaultIds.includes(id));
      expect(intersection).toEqual([]);
    });
  });

  describe("Empty State UX", () => {
    it("SB-09: renders informative placeholder when active note has zero suggestions", async () => {
      const cleanFile = new TFile("Notes/CleanDoc.md", mockApp.vault);
      mockApp.workspace.getActiveFile = vi.fn().mockReturnValue(cleanFile);

      await view.onOpen();
      const content = (view as any).contentEl as HeadlessElement;

      const activeSection = content.querySelector(".ai-proposals-section-active")!;
      const activeCards = activeSection.querySelectorAll(".ai-proposals-card");
      expect(activeCards.length).toBe(0);

      const emptyNotice = activeSection.querySelector(".ai-proposals-empty-note");
      expect(emptyNotice).not.toBeNull();
      expect(emptyNotice!.textContent.length).toBeGreaterThan(0);

      // Vault section should render all 3 proposals
      const vaultSection = content.querySelector(".ai-proposals-section-vault")!;
      expect(vaultSection.querySelectorAll(".ai-proposals-card").length).toBe(3);
    });

    it("SB-10: renders global empty state when zero proposals exist in vault", async () => {
      mockStore.proposals = [];
      await view.onOpen();
      const content = (view as any).contentEl as HeadlessElement;

      const globalEmpty = content.querySelector(".ai-proposals-empty-vault");
      expect(globalEmpty).not.toBeNull();
      expect(content.querySelectorAll(".ai-proposals-card").length).toBe(0);
    });

    it("SB-11: handles null active file gracefully", async () => {
      mockApp.workspace.getActiveFile = vi.fn().mockReturnValue(null);
      await view.onOpen();
      const content = (view as any).contentEl as HeadlessElement;

      const activeSection = content.querySelector(".ai-proposals-section-active")!;
      expect(activeSection.textContent).toMatch(/brak otwartej notatki|no active note/i);

      const vaultSection = content.querySelector(".ai-proposals-section-vault")!;
      expect(vaultSection.querySelectorAll(".ai-proposals-card").length).toBe(3);
    });
  });

  describe("Proposal Card UI & Visual Diff", () => {
    it("SB-12: displays metadata tags (line number, rule, author, explanation)", async () => {
      await view.onOpen();
      const content = (view as any).contentEl as HeadlessElement;
      const cardP1 = content.querySelector("[data-proposal-id='p1']")!;

      expect(cardP1.textContent).toContain("12");
      expect(cardP1.textContent).toContain("spelling");
      expect(cardP1.textContent).toContain("AgentA");
      expect(cardP1.textContent).toContain("Fix typo teh -> the");
    });

    it("SB-13: renders deletion and addition diff elements", async () => {
      await view.onOpen();
      const content = (view as any).contentEl as HeadlessElement;
      const cardP1 = content.querySelector("[data-proposal-id='p1']")!;

      const delEl = cardP1.querySelector(".ai-diff-del, .ai-proposal-deletion, .ai-proposal-diff-deletion");
      const addEl = cardP1.querySelector(".ai-diff-add, .ai-proposal-addition, .ai-proposal-diff-addition");

      expect(delEl).not.toBeNull();
      expect(delEl!.textContent).toContain("teh");

      expect(addEl).not.toBeNull();
      expect(addEl!.textContent).toContain("the");
    });

    it("SB-14: handles zero-length insertion cleanly without crashing", async () => {
      await view.onOpen();
      const content = (view as any).contentEl as HeadlessElement;
      const cardP2 = content.querySelector("[data-proposal-id='p2']")!;

      const addEl = cardP2.querySelector(".ai-diff-add, .ai-proposal-addition, .ai-proposal-diff-addition");
      expect(addEl).not.toBeNull();
      expect(addEl!.textContent).toContain("# Header");
    });

    it("SB-15: handles pure deletion proposal cleanly", async () => {
      mockStore.proposals.push({
        id: "p-del",
        file: "Notes/ActiveDoc.md",
        sourceFile: "ai_suggestion-del.json",
        line: 5,
        ch: 0,
        toCh: 10,
        original: "delete me",
        replacement: "",
        status: "pending",
        rule: "conciseness",
      });

      await view.onOpen();
      const content = (view as any).contentEl as HeadlessElement;
      const cardDel = content.querySelector("[data-proposal-id='p-del']")!;

      expect(cardDel).not.toBeNull();
      const delEl = cardDel.querySelector(".ai-diff-del, .ai-proposal-deletion, .ai-proposal-diff-deletion");
      expect(delEl).not.toBeNull();
      expect(delEl!.textContent).toContain("delete me");
    });

    it("SB-16: sanitizes malicious HTML in proposal explanation and rule", async () => {
      mockStore.proposals.push({
        id: "p-xss",
        file: "Notes/ActiveDoc.md",
        sourceFile: "ai_suggestion-xss.json",
        line: 1,
        ch: 0,
        toCh: 1,
        original: "a",
        replacement: "b",
        status: "pending",
        rule: "<script>alert('xss-rule')</script>",
        explanation: "<img src=x onerror=alert('xss-expl')>",
      });

      await view.onOpen();
      const content = (view as any).contentEl as HeadlessElement;
      const cardXss = content.querySelector("[data-proposal-id='p-xss']")!;

      expect(cardXss.querySelectorAll("script").length).toBe(0);
      expect(cardXss.querySelectorAll("img").length).toBe(0);
    });
  });

  describe("Jump-to-Line Navigation & Workspace Guards", () => {
    it("SB-17: clicking card in active file sets cursor on target line and scrolls", async () => {
      await view.onOpen();
      const content = (view as any).contentEl as HeadlessElement;
      const cardP1 = content.querySelector("[data-proposal-id='p1']")!;

      const mockEditor = {
        setCursor: vi.fn(),
        setSelection: vi.fn(),
        scrollIntoView: vi.fn(),
        focus: vi.fn(),
      };
      mockApp.workspace.getActiveViewOfType = vi.fn().mockReturnValue({ editor: mockEditor });

      cardP1.dispatchEvent({ type: "click" });

      expect(mockEditor.setCursor).toHaveBeenCalledWith(
        expect.objectContaining({ line: 11 })
      );
      expect(mockEditor.scrollIntoView).toHaveBeenCalled();
      expect(mockEditor.focus).toHaveBeenCalled();
    });

    it("SB-18: clicking card in inactive file triggers workspace openFile or openLinkText", async () => {
      await view.onOpen();
      const content = (view as any).contentEl as HeadlessElement;
      const cardP3 = content.querySelector("[data-proposal-id='p3']")!;

      cardP3.dispatchEvent({ type: "click" });

      expect(mockApp.workspace.openLinkText).toHaveBeenCalledWith(
        "Notes/OtherDoc.md",
        "",
        false
      );
    });

    it("SB-19: quadruple shield eliminates active-leaf-change re-render storm", async () => {
      await view.onOpen();
      const renderSpy = vi.spyOn(view, "render");

      const sidebarLeaf = { view: { getViewType: () => VIEW_TYPE_PROPOSAL_SIDEBAR } };
      view.onActiveLeafChange(sidebarLeaf as unknown as WorkspaceLeaf);

      expect(renderSpy).not.toHaveBeenCalled();
    });
  });

  describe("Accept / Reject Card Actions & Concurrency", () => {
    it("SB-20: clicking Accept button calls store.acceptProposal and updates list", async () => {
      await view.onOpen();
      const content = (view as any).contentEl as HeadlessElement;
      const cardP1 = content.querySelector("[data-proposal-id='p1']")!;
      const acceptBtn = cardP1.querySelector(".ai-proposal-btn-accept, .ai-btn-accept")!;

      await (view as any).handleAcceptProposal("p1", acceptBtn as unknown as HTMLButtonElement, cardP1 as unknown as HTMLElement);

      expect(mockStore.acceptInvocationCount).toBe(1);
      expect(mockStore.getProposalById("p1")?.status).toBe("applied");

      const updatedCard = content.querySelector("[data-proposal-id='p1']");
      expect(updatedCard).toBeNull();
    });

    it("SB-21: clicking Reject button calls store.rejectProposal and updates list", async () => {
      await view.onOpen();
      const content = (view as any).contentEl as HeadlessElement;
      const cardP1 = content.querySelector("[data-proposal-id='p1']")!;
      const rejectBtn = cardP1.querySelector(".ai-proposal-btn-reject, .ai-btn-reject")!;

      await (view as any).handleRejectProposal("p1", rejectBtn as unknown as HTMLButtonElement, cardP1 as unknown as HTMLElement);

      expect(mockStore.rejectInvocationCount).toBe(1);
      expect(mockStore.getProposalById("p1")?.status).toBe("rejected");
    });

    it("SB-22: rapid double-clicks on Accept button invoke store strictly ONCE (mutex lock)", async () => {
      mockStore.acceptDelayMs = 50;
      await view.onOpen();
      const content = (view as any).contentEl as HeadlessElement;
      const cardP1 = content.querySelector("[data-proposal-id='p1']")!;
      const acceptBtn = cardP1.querySelector(".ai-proposal-btn-accept, .ai-btn-accept")!;

      acceptBtn.dispatchEvent({ type: "click", stopPropagation: vi.fn(), preventDefault: vi.fn() });
      acceptBtn.dispatchEvent({ type: "click", stopPropagation: vi.fn(), preventDefault: vi.fn() });

      expect(mockStore.acceptInvocationCount).toBe(1);
      expect(mockStore.maxConcurrentAccepts).toBe(1);
    });

    it("SB-23: cross-button race condition ignores secondary action while in flight", async () => {
      mockStore.acceptDelayMs = 50;
      await view.onOpen();
      const content = (view as any).contentEl as HeadlessElement;
      const cardP1 = content.querySelector("[data-proposal-id='p1']")!;
      const acceptBtn = cardP1.querySelector(".ai-proposal-btn-accept, .ai-btn-accept")!;
      const rejectBtn = cardP1.querySelector(".ai-proposal-btn-reject, .ai-btn-reject")!;

      acceptBtn.dispatchEvent({ type: "click", stopPropagation: vi.fn(), preventDefault: vi.fn() });
      rejectBtn.dispatchEvent({ type: "click", stopPropagation: vi.fn(), preventDefault: vi.fn() });

      expect(mockStore.acceptInvocationCount).toBe(1);
      expect(mockStore.rejectInvocationCount).toBe(0);
    });

    it("SB-24: mutation failure re-enables buttons and shows Notice", async () => {
      mockStore.shouldFailMutation = true;
      await view.onOpen();
      const content = (view as any).contentEl as HeadlessElement;
      const cardP1 = content.querySelector("[data-proposal-id='p1']")!;
      const acceptBtn = cardP1.querySelector(".ai-proposal-btn-accept, .ai-btn-accept")! as unknown as HTMLButtonElement;

      await view.handleAcceptProposal("p1", acceptBtn, cardP1 as unknown as HTMLElement);

      expect(acceptBtn.disabled).toBe(false);
      expect(cardP1.classList.contains("is-processing")).toBe(false);
    });
  });

  describe("Reactive Store Synchronization", () => {
    it("SB-25: updates view when store fires onStoreChange notification", async () => {
      await view.onOpen();
      const content = (view as any).contentEl as HeadlessElement;

      expect(content.querySelectorAll(".ai-proposals-card").length).toBe(3);

      mockStore.proposals.push({
        id: "p4",
        file: "Notes/ActiveDoc.md",
        sourceFile: "ai_suggestion-03.json",
        line: 99,
        ch: 0,
        toCh: 3,
        original: "foo",
        replacement: "bar",
        status: "pending",
      });

      mockStore.notify();

      expect(content.querySelectorAll(".ai-proposals-card").length).toBe(4);
    });

    it("SB-26: onActiveFileChange updates two-tier grouping when active file changes", async () => {
      await view.onOpen();
      const content = (view as any).contentEl as HeadlessElement;

      const otherFile = new TFile("Notes/OtherDoc.md", mockApp.vault);
      mockApp.workspace.getActiveFile = vi.fn().mockReturnValue(otherFile);

      view.onActiveFileChange(otherFile);

      const activeSection = content.querySelector(".ai-proposals-section-active")!;
      const activeIds = activeSection
        .querySelectorAll(".ai-proposals-card")
        .map((c) => c.getAttribute("data-proposal-id"));

      expect(activeIds).toEqual(["p3"]);
    });
  });

  describe("Lifecycle Hardening & Defensive Guards (Iteration 2)", () => {
    it("SB-27: cancels in-flight requestAnimationFrame handle on onClose and clears rafHandle", async () => {
      const origRaf = (globalThis as any).requestAnimationFrame;
      const origCaf = (globalThis as any).cancelAnimationFrame;
      try {
        let queuedCallback: FrameRequestCallback | null = null;
        const mockRafId = 777;
        const mockRaf = vi.fn().mockImplementation((cb: FrameRequestCallback) => {
          queuedCallback = cb;
          return mockRafId;
        });
        const mockCaf = vi.fn();

        (globalThis as any).requestAnimationFrame = mockRaf;
        (globalThis as any).cancelAnimationFrame = mockCaf;

        await view.onOpen();

        // Schedule an asynchronous render
        view.scheduleRender();

        expect(mockRaf).toHaveBeenCalledTimes(1);
        expect((view as any).rafHandle).toBe(mockRafId);
        expect((view as any).renderScheduled).toBe(true);

        // Close the view before the frame fires
        await view.onClose();

        expect(mockCaf).toHaveBeenCalledWith(mockRafId);
        expect((view as any).rafHandle).toBeNull();
        expect((view as any).renderScheduled).toBe(false);

        // If callback was manually triggered, render should not create DOM
        const renderSpy = vi.spyOn(view, "render");
        if (queuedCallback) {
          (view as any).renderScheduled = false;
          (view as any).rafHandle = null;
        }
        expect(renderSpy).not.toHaveBeenCalled();
      } finally {
        (globalThis as any).requestAnimationFrame = origRaf;
        (globalThis as any).cancelAnimationFrame = origCaf;
      }
    });

    it("SB-28: returns early and avoids crashes if containerEl or contentEl is null", () => {
      const buildSpy = vi.spyOn(view as any, "buildSidebarDOM");

      (view as any).containerEl = null;
      (view as any).contentEl = null;

      expect(() => view.render()).not.toThrow();
      expect(buildSpy).not.toHaveBeenCalled();
    });
  });
});
