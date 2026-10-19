/**
 * tests/m4_sidebar_stress_harness.test.ts
 * Empirical Stress Harness & Adversarial Validation for Milestone 4 (Sidebar ItemView, Status Bar, Lifecycle).
 *
 * Stress Scenarios:
 * 1. Rapid Active Note File Transitions (burst storms, state retention, disjoint partitioning)
 * 2. Rapid Double-Clicks & Mutex Lock Stress (concurrency race conditions, error recovery, unmounted DOM)
 * 3. Jump-to-Line Navigation Under Edge Conditions (missing files, invalid line numbers, closed/non-markdown leaves)
 * 4. Status Bar Counter & Grammar Pluralization Boundary Stress
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  App as MockApp,
  WorkspaceLeaf as MockLeaf,
  TFile,
  MarkdownView,
} from "./mocks/obsidian";
import type { App, WorkspaceLeaf } from "obsidian";
import type { IProposalStore, Proposal } from "../src/types";

import {
  ProposalSidebarView,
  VIEW_TYPE_PROPOSAL_SIDEBAR,
} from "../src/ui/proposal-sidebar-view";
import { formatProposalBadgeText } from "../src/ui/status-bar";

// ============================================================================
// Headless DOM Environment
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
  mockIsConnected = true;
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
    if (!this.mockIsConnected) return false;
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
      const classes = selector.split(".").filter(Boolean);
      return classes.every((c) => el.classList.contains(c));
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
// Stress Mock Proposal Store
// ============================================================================

class StressProposalStore implements IProposalStore {
  proposals: Proposal[] = [];
  listeners: Set<() => void> = new Set();

  acceptCalls: string[] = [];
  rejectCalls: string[] = [];
  inFlightAccepts = 0;
  inFlightRejects = 0;
  maxConcurrentAccepts = 0;
  maxConcurrentRejects = 0;

  delayMs = 0;
  throwOnAccept = false;
  throwOnReject = false;

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
    this.acceptCalls.push(id);
    this.inFlightAccepts++;
    this.maxConcurrentAccepts = Math.max(this.maxConcurrentAccepts, this.inFlightAccepts);

    if (this.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayMs));
    }

    this.inFlightAccepts--;

    if (this.throwOnAccept) {
      throw new Error(`Simulated I/O failure on acceptProposal(${id})`);
    }

    const prop = this.getProposalById(id);
    if (!prop) return false;

    prop.status = "applied";
    this.notify();
    return true;
  }

  async rejectProposal(id: string): Promise<boolean> {
    this.rejectCalls.push(id);
    this.inFlightRejects++;
    this.maxConcurrentRejects = Math.max(this.maxConcurrentRejects, this.inFlightRejects);

    if (this.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayMs));
    }

    this.inFlightRejects--;

    if (this.throwOnReject) {
      throw new Error(`Simulated I/O failure on rejectProposal(${id})`);
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
// Stress Harness Test Suite
// ============================================================================

describe("Milestone 4 Adversarial Stress Harness (ProposalSidebarView)", () => {
  let mockApp: MockApp;
  let mockLeaf: MockLeaf;
  let store: StressProposalStore;
  let view: ProposalSidebarView;
  let headlessDoc: HeadlessDocument;

  beforeEach(() => {
    headlessDoc = new HeadlessDocument();
    mockApp = new MockApp();
    mockLeaf = new MockLeaf();
    (mockLeaf as any).containerEl = headlessDoc.createElement("div");

    // Populate vault files
    mockApp.vault.seedFile("DocA.md", "Content of doc A");
    mockApp.vault.seedFile("DocB.md", "Content of doc B");
    mockApp.vault.seedFile("DocC.md", "Content of doc C");

    const activeFile = mockApp.vault.getAbstractFileByPath("DocA.md") as TFile;
    mockApp.workspace.getActiveFile = vi.fn().mockReturnValue(activeFile);
    mockApp.workspace.getActiveViewOfType = vi.fn().mockReturnValue(null);
    mockApp.workspace.openLinkText = vi.fn().mockResolvedValue(undefined);

    const initialProposals: Proposal[] = [
      {
        id: "pA1",
        file: "DocA.md",
        sourceFile: "buf.json",
        line: 1,
        ch: 0,
        toCh: 7,
        original: "Content",
        replacement: "Header",
        status: "pending",
      },
      {
        id: "pA2",
        file: "DocA.md",
        sourceFile: "buf.json",
        line: 2,
        ch: 0,
        toCh: 2,
        original: "of",
        replacement: "for",
        status: "pending",
      },
      {
        id: "pB1",
        file: "DocB.md",
        sourceFile: "buf.json",
        line: 10,
        ch: 5,
        toCh: 10,
        original: "doc B",
        replacement: "Document B",
        status: "pending",
      },
      {
        id: "pC1",
        file: "DocC.md",
        sourceFile: "buf.json",
        line: 20,
        ch: 1,
        toCh: 2,
        original: "C",
        replacement: "Charlie",
        status: "pending",
      },
    ];

    store = new StressProposalStore(initialProposals);
    view = new ProposalSidebarView(mockLeaf as unknown as WorkspaceLeaf, mockApp as unknown as App, store);

    (view as any).containerEl = headlessDoc.createElement("div");
    (view as any).contentEl = (view as any).containerEl.createDiv({ cls: "view-content" });
  });

  afterEach(() => {
    view.onClose();
  });

  describe("1. Rapid Active Note File Transitions", () => {
    it("survives a 100-burst rapid active file transition storm without crashing or losing proposals", async () => {
      await view.onOpen();

      const files = [
        new TFile("DocA.md", mockApp.vault),
        new TFile("DocB.md", mockApp.vault),
        new TFile("DocC.md", mockApp.vault),
        null,
      ];

      // Fire 100 rapid file change events
      for (let i = 0; i < 100; i++) {
        const file = files[i % files.length];
        mockApp.workspace.getActiveFile = vi.fn().mockReturnValue(file);
        view.onActiveFileChange(file);
      }

      // Settle on DocB.md
      const targetB = new TFile("DocB.md", mockApp.vault);
      mockApp.workspace.getActiveFile = vi.fn().mockReturnValue(targetB);
      view.onActiveFileChange(targetB);

      const content = (view as any).contentEl as HeadlessElement;
      const activeSection = content.querySelector(".ai-proposals-section-active")!;
      const vaultSection = content.querySelector(".ai-proposals-section-vault")!;

      const activeCards = activeSection.querySelectorAll(".ai-proposals-card");
      expect(activeCards.length).toBe(1);
      expect(activeCards[0].getAttribute("data-proposal-id")).toBe("pB1");

      const vaultCards = vaultSection.querySelectorAll(".ai-proposals-card");
      expect(vaultCards.length).toBe(3); // pA1, pA2, pC1
      const vaultIds = vaultCards.map((c) => c.getAttribute("data-proposal-id"));
      expect(vaultIds).toContain("pA1");
      expect(vaultIds).toContain("pA2");
      expect(vaultIds).toContain("pC1");
    });

    it("quadruple shield absorbs rapid active-leaf-change storm from sidebar without triggering re-renders", async () => {
      await view.onOpen();
      const renderSpy = vi.spyOn(view, "render");

      const sidebarLeaf = { view: { getViewType: () => VIEW_TYPE_PROPOSAL_SIDEBAR } };

      for (let i = 0; i < 50; i++) {
        view.onActiveLeafChange(sidebarLeaf as unknown as WorkspaceLeaf);
      }

      expect(renderSpy).not.toHaveBeenCalled();
    });

    it("preserves collapsed accordion states across active file re-renders", async () => {
      await view.onOpen();
      const content = (view as any).contentEl as HeadlessElement;

      // Click accordion for DocC to collapse it
      const docCHeader = content.querySelectorAll(".ai-file-header").find((h) => h.textContent.includes("DocC.md"));
      expect(docCHeader).toBeDefined();
      docCHeader!.dispatchEvent({ type: "click" });

      expect((view as any).collapsedFiles.has("DocC.md")).toBe(true);

      // Trigger file change to DocB.md
      const targetB = new TFile("DocB.md", mockApp.vault);
      mockApp.workspace.getActiveFile = vi.fn().mockReturnValue(targetB);
      view.onActiveFileChange(targetB);

      // DocC.md should remain collapsed in collapsedFiles Set
      expect((view as any).collapsedFiles.has("DocC.md")).toBe(true);
      const newDocCAccordion = (view as any).contentEl.querySelector(".ai-file-accordion.is-collapsed");
      expect(newDocCAccordion).not.toBeNull();
    });
  });

  describe("2. Mutex & Concurrency Lock Stress", () => {
    it("strictly serializes 50 concurrent rapid clicks on Accept button (invokes store ONCE)", async () => {
      store.delayMs = 40;
      await view.onOpen();
      const content = (view as any).contentEl as HeadlessElement;

      const card = content.querySelector("[data-proposal-id='pA1']")!;
      const acceptBtn = card.querySelector(".ai-proposal-btn-accept, .ai-btn-accept")! as unknown as HTMLButtonElement;

      // Dispatch 50 click events in the same synchronous tick
      const clickPromises: Promise<void>[] = [];
      for (let i = 0; i < 50; i++) {
        clickPromises.push(view.handleAcceptProposal("pA1", acceptBtn, card as unknown as HTMLElement));
      }

      await Promise.all(clickPromises);

      expect(store.acceptCalls.length).toBe(1);
      expect(store.maxConcurrentAccepts).toBe(1);
    });

    it("strictly serializes 50 concurrent rapid clicks on Reject button (invokes store ONCE)", async () => {
      store.delayMs = 40;
      await view.onOpen();
      const content = (view as any).contentEl as HeadlessElement;

      const card = content.querySelector("[data-proposal-id='pA1']")!;
      const rejectBtn = card.querySelector(".ai-proposal-btn-reject, .ai-btn-reject")! as unknown as HTMLButtonElement;

      const clickPromises: Promise<void>[] = [];
      for (let i = 0; i < 50; i++) {
        clickPromises.push(view.handleRejectProposal("pA1", rejectBtn, card as unknown as HTMLElement));
      }

      await Promise.all(clickPromises);

      expect(store.rejectCalls.length).toBe(1);
      expect(store.maxConcurrentRejects).toBe(1);
    });

    it("cross-button race: concurrent Accept and Reject invocations resolve safely without double execution", async () => {
      store.delayMs = 40;
      await view.onOpen();
      const content = (view as any).contentEl as HeadlessElement;

      const card = content.querySelector("[data-proposal-id='pA1']")!;
      const acceptBtn = card.querySelector(".ai-proposal-btn-accept, .ai-btn-accept")! as unknown as HTMLButtonElement;
      const rejectBtn = card.querySelector(".ai-proposal-btn-reject, .ai-btn-reject")! as unknown as HTMLButtonElement;

      const pAccept = view.handleAcceptProposal("pA1", acceptBtn, card as unknown as HTMLElement, rejectBtn);
      const pReject = view.handleRejectProposal("pA1", rejectBtn, card as unknown as HTMLElement, acceptBtn);

      await Promise.all([pAccept, pReject]);

      // Exactly one operation should have reached the store
      const totalCalls = store.acceptCalls.length + store.rejectCalls.length;
      expect(totalCalls).toBe(1);
    });

    it("recovers gracefully and unlocks mutex if store.acceptProposal throws an unhandled exception", async () => {
      store.throwOnAccept = true;
      await view.onOpen();
      const content = (view as any).contentEl as HeadlessElement;

      const card = content.querySelector("[data-proposal-id='pA1']")!;
      const acceptBtn = card.querySelector(".ai-proposal-btn-accept, .ai-btn-accept")! as unknown as HTMLButtonElement;

      // Handle invocation which encounters simulated store error
      await view.handleAcceptProposal("pA1", acceptBtn, card as unknown as HTMLElement);

      // Mutex should be released in finally block
      expect((view as any).processingIds.has("pA1")).toBe(false);
      expect(acceptBtn.disabled).toBe(false);
      expect(card.classList.contains("is-processing")).toBe(false);

      // Subsequent click should be accepted (not permanently locked)
      store.throwOnAccept = false;
      await view.handleAcceptProposal("pA1", acceptBtn, card as unknown as HTMLElement);
      expect(store.acceptCalls.length).toBe(2);
    });

    it("does not crash in finally block if card DOM is unmounted/detached during async mutation", async () => {
      store.delayMs = 30;
      await view.onOpen();
      const content = (view as any).contentEl as HeadlessElement;

      const card = content.querySelector("[data-proposal-id='pA1']")!;
      const acceptBtn = card.querySelector(".ai-proposal-btn-accept, .ai-btn-accept")! as unknown as HTMLButtonElement;

      const acceptPromise = view.handleAcceptProposal("pA1", acceptBtn, card as unknown as HTMLElement);

      // Simulate DOM element detachment mid-flight
      card.mockIsConnected = false;
      card.remove();

      // Await mutation completion — must not throw TypeError
      await expect(acceptPromise).resolves.not.toThrow();
      expect((view as any).processingIds.has("pA1")).toBe(false);
    });
  });

  describe("3. Jump-to-Line Navigation Under Edge Conditions", () => {
    it("handles non-existent vault target file gracefully without throwing an unhandled rejection", async () => {
      await view.onOpen();
      const nonExistentProposal: Proposal = {
        id: "p-ghost",
        file: "Ghosts/NonExistent.md",
        sourceFile: "buf.json",
        line: 42,
        ch: 0,
        toCh: 4,
        original: "lost",
        replacement: "found",
        status: "pending",
      };

      await expect(view.jumpToProposal(nonExistentProposal)).resolves.not.toThrow();
    });

    it("clamps negative, zero, and boundary line numbers safely to line index >= 0", async () => {
      await view.onOpen();
      const mockEditor = {
        setCursor: vi.fn(),
        setSelection: vi.fn(),
        scrollIntoView: vi.fn(),
        focus: vi.fn(),
      };
      mockApp.workspace.getActiveViewOfType = vi.fn().mockReturnValue({ editor: mockEditor });

      const edgeCases = [
        { line: -10, expectedLine: 0 },
        { line: 0, expectedLine: 0 },
        { line: 1, expectedLine: 0 },
        { line: 50, expectedLine: 49 },
      ];

      for (const ec of edgeCases) {
        mockEditor.setCursor.mockClear();
        const testProp: Proposal = {
          id: `p-edge-${ec.line}`,
          file: "DocA.md",
          sourceFile: "buf.json",
          line: ec.line,
          ch: 0,
          toCh: 3,
          original: "foo",
          replacement: "bar",
          status: "pending",
        };

        await view.jumpToProposal(testProp);
        expect(mockEditor.setCursor).toHaveBeenCalledWith(
          expect.objectContaining({ line: ec.expectedLine })
        );
      }
    });

    it("handles leaves without editor instances (e.g. Canvas or PDF view) without crashing", async () => {
      await view.onOpen();
      // Active view without editor
      mockApp.workspace.getActiveViewOfType = vi.fn().mockReturnValue({ editor: undefined });

      const testProp: Proposal = {
        id: "p-no-editor",
        file: "DocA.md",
        sourceFile: "buf.json",
        line: 5,
        ch: 0,
        toCh: 1,
        original: "a",
        replacement: "b",
        status: "pending",
      };

      await expect(view.jumpToProposal(testProp)).resolves.not.toThrow();
    });

    it("directs cursor to target leaf editor when jumping to an open inactive note", async () => {
      await view.onOpen();

      const editorA = {
        setCursor: vi.fn(),
        setSelection: vi.fn(),
        scrollIntoView: vi.fn(),
        focus: vi.fn(),
      };
      const editorB = {
        setCursor: vi.fn(),
        setSelection: vi.fn(),
        scrollIntoView: vi.fn(),
        focus: vi.fn(),
      };

      // DocA is active
      const viewA = new (MarkdownView as any)(mockLeaf);
      (viewA as any).file = new TFile("DocA.md", mockApp.vault);
      (viewA as any).editor = editorA;
      mockApp.workspace.getActiveViewOfType = vi.fn().mockReturnValue(viewA);

      // DocB is in another leaf
      const leafB = new MockLeaf();
      const viewB = new (MarkdownView as any)(leafB);
      (viewB as any).file = new TFile("DocB.md", mockApp.vault);
      (viewB as any).editor = editorB;
      (leafB as any).view = viewB;

      mockApp.workspace.getLeavesOfType = vi.fn().mockReturnValue([
        { view: viewA },
        leafB,
      ]);

      const testPropB: Proposal = {
        id: "pB1",
        file: "DocB.md",
        sourceFile: "buf.json",
        line: 10,
        ch: 5,
        toCh: 10,
        original: "doc B",
        replacement: "Document B",
        status: "pending",
      };

      await view.jumpToProposal(testPropB);

      // Verify that editorB receives the cursor and selection, NOT editorA
      expect(editorB.setCursor).toHaveBeenCalledWith(
        expect.objectContaining({ line: 9, ch: 5 })
      );
      expect(editorA.setCursor).not.toHaveBeenCalled();
    });

    it("directs cursor to newly opened note editor when jumping to an unopened note", async () => {
      await view.onOpen();

      const editorA = {
        setCursor: vi.fn(),
        setSelection: vi.fn(),
        scrollIntoView: vi.fn(),
        focus: vi.fn(),
      };
      const editorB = {
        setCursor: vi.fn(),
        setSelection: vi.fn(),
        scrollIntoView: vi.fn(),
        focus: vi.fn(),
      };

      const viewA = new (MarkdownView as any)(mockLeaf);
      (viewA as any).file = new TFile("DocA.md", mockApp.vault);
      (viewA as any).editor = editorA;

      const viewB = new (MarkdownView as any)(new MockLeaf());
      (viewB as any).file = new TFile("DocB.md", mockApp.vault);
      (viewB as any).editor = editorB;

      // Initially DocA is active
      let currentActiveView: any = viewA;
      mockApp.workspace.getActiveViewOfType = vi.fn().mockImplementation(() => currentActiveView);
      mockApp.workspace.getLeavesOfType = vi.fn().mockReturnValue([{ view: viewA }]);

      // When openLinkText is called, Obsidian switches active view to viewB
      mockApp.workspace.openLinkText = vi.fn().mockImplementation(async () => {
        currentActiveView = viewB;
      });

      const testPropB: Proposal = {
        id: "pB1",
        file: "DocB.md",
        sourceFile: "buf.json",
        line: 10,
        ch: 5,
        toCh: 10,
        original: "doc B",
        replacement: "Document B",
        status: "pending",
      };

      await view.jumpToProposal(testPropB);

      // Verify that editorB receives the cursor and selection, NOT editorA
      expect(editorB.setCursor).toHaveBeenCalledWith(
        expect.objectContaining({ line: 9, ch: 5 })
      );
      expect(editorA.setCursor).not.toHaveBeenCalled();
    });
  });

  describe("4. Status Bar & Polish Grammar Pluralization Boundary Stress", () => {
    it("accurately applies Polish grammar pluralization rules across 100+ numeric cases", () => {
      // 0
      expect(formatProposalBadgeText(0)).toBe("✨ 0");

      // 1: propozycja
      expect(formatProposalBadgeText(1)).toBe("✨ 1 propozycja");

      // 2..4: propozycje
      expect(formatProposalBadgeText(2)).toBe("✨ 2 propozycje");
      expect(formatProposalBadgeText(3)).toBe("✨ 3 propozycje");
      expect(formatProposalBadgeText(4)).toBe("✨ 4 propozycje");

      // 5..21: propozycji (including 11, 12, 13, 14, 21)
      expect(formatProposalBadgeText(5)).toBe("✨ 5 propozycji");
      expect(formatProposalBadgeText(10)).toBe("✨ 10 propozycji");
      expect(formatProposalBadgeText(11)).toBe("✨ 11 propozycji");
      expect(formatProposalBadgeText(12)).toBe("✨ 12 propozycji");
      expect(formatProposalBadgeText(13)).toBe("✨ 13 propozycji");
      expect(formatProposalBadgeText(14)).toBe("✨ 14 propozycji");
      expect(formatProposalBadgeText(20)).toBe("✨ 20 propozycji");
      expect(formatProposalBadgeText(21)).toBe("✨ 21 propozycji");

      // 22..24: propozycje
      expect(formatProposalBadgeText(22)).toBe("✨ 22 propozycje");
      expect(formatProposalBadgeText(23)).toBe("✨ 23 propozycje");
      expect(formatProposalBadgeText(24)).toBe("✨ 24 propozycje");

      // 25..31: propozycji
      expect(formatProposalBadgeText(25)).toBe("✨ 25 propozycji");
      expect(formatProposalBadgeText(31)).toBe("✨ 31 propozycji");

      // Hundreds boundaries:
      expect(formatProposalBadgeText(100)).toBe("✨ 100 propozycji");
      expect(formatProposalBadgeText(101)).toBe("✨ 101 propozycji");
      expect(formatProposalBadgeText(102)).toBe("✨ 102 propozycje");
      expect(formatProposalBadgeText(111)).toBe("✨ 111 propozycji");
      expect(formatProposalBadgeText(112)).toBe("✨ 112 propozycji");
      expect(formatProposalBadgeText(114)).toBe("✨ 114 propozycji");
      expect(formatProposalBadgeText(122)).toBe("✨ 122 propozycje");
      expect(formatProposalBadgeText(124)).toBe("✨ 124 propozycje");
    });
  });
});
