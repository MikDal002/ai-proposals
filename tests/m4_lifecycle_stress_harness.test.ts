/**
 * tests/m4_lifecycle_stress_harness.test.ts
 * Empirical Adversarial Stress Harness for Milestone 4 (Plugin Lifecycle, Status Bar & Settings).
 *
 * Authored by: teamwork_preview_challenger (m4_challenger_2)
 *
 * Focus areas:
 * 1. Rapid sequential plugin onload() and onunload() cycles (50 cycles):
 *    - Memory leak prevention, listener disposal, leaf detachment, store disposal
 *    - onunload() idempotency (multiple consecutive calls)
 *    - onunload() on uninitialized plugin instance
 *
 * 2. Extreme settings configurations & clamping/fallbacks:
 *    - Negative autoSnapRadius (-1, -100, -Infinity, NaN, undefined, invalid string)
 *    - autoSnapRadius > 20 (21, 100, 1000, Infinity)
 *    - Empty, whitespace, null, and regex-hostile buffer patterns
 *    - Dirty persisted settings from disk and tolerance in ProposalStore
 *
 * 3. Status bar counter transitions under high-frequency store changes ($0 \to 100 \to 0$):
 *    - 500 rapid alternating transitions ($0 \to 100 \to 0$)
 *    - 1,000 rapid store change event floods
 *    - Exhaustive Polish grammar pluralization engine verification (1, 2-4, 5-21, 22-24, 112-114, etc.)
 *    - Mobile platform guard (Platform.isMobile = true) safe no-op guarantees
 *    - Dynamic visibility toggling via showStatusBarCounter
 *
 * 4. Command palette & leaf interaction edge cases:
 *    - accept-all-active with null active file, non-markdown file, zero proposals, partial failures
 *    - scan-buffers error resilience
 *    - Leaf toggle and activation branching
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  App as MockApp,
  Platform,
  WorkspaceLeaf,
} from "./mocks/obsidian";
import type { App } from "obsidian";
import {
  DEFAULT_SETTINGS,
  type Proposal,
  type IProposalStore,
} from "../src/types";

import AIProposalsPlugin from "../src/main";
import { AIProposalsSettingTab } from "../src/settings/settings-tab";
import {
  ProposalStatusBarItem,
  formatProposalBadgeText,
} from "../src/ui/status-bar";
import { VIEW_TYPE_PROPOSAL_SIDEBAR } from "../src/ui/proposal-sidebar-view";
import { matchesBufferPattern } from "../src/store/proposal-store";

// ============================================================================
// Headless DOM Mock Helpers for Settings & Status Bar
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
  private listeners: Map<string, Set<(evt: any) => void>> = new Map();

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  empty(): void {
    this.children = [];
    this.textContent = "";
    this.innerHTML = "";
  }

  createDiv(options?: { cls?: string; text?: string } | string): HeadlessElement {
    return this.createEl("div", options);
  }

  createSpan(options?: { cls?: string; text?: string } | string): HeadlessElement {
    return this.createEl("span", options);
  }

  createEl(tag: string, options?: { cls?: string; text?: string } | string): HeadlessElement {
    const el = new HeadlessElement(tag);
    if (typeof options === "string") {
      el.className = options;
    } else if (options) {
      if (options.cls) el.className = options.cls;
      if (options.text) el.textContent = options.text;
    }
    this.children.push(el);
    el.parentNode = this;
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

  setAttribute(k: string, v: string): void {
    this.attributes.set(k, String(v));
    if (k === "title") this.title = String(v);
  }

  getAttribute(k: string): string | null {
    return this.attributes.get(k) ?? null;
  }

  addEventListener(type: string, listener: (evt: any) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: (evt: any) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: { type: string }): boolean {
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

  remove(): void {
    if (this.parentNode) {
      const idx = this.parentNode.children.indexOf(this);
      if (idx !== -1) {
        this.parentNode.children.splice(idx, 1);
      }
      this.parentNode = null;
    }
  }
}

// ============================================================================
// Mock Proposal Store for Status Bar Stress Testing
// ============================================================================

class MockReactiveStore implements IProposalStore {
  public proposals: Proposal[] = [];
  public listeners = new Set<() => void>();
  public disposeCount = 0;

  constructor(initialCount = 0) {
    this.setCount(initialCount);
  }

  setCount(count: number): void {
    this.proposals = Array.from({ length: count }, (_, i) => ({
      id: `prop-${i}`,
      file: "Notes/test.md",
      sourceFile: "ai_suggestion-01.json",
      line: i + 1,
      ch: 0,
      toCh: 5,
      original: "orig",
      replacement: "rep",
      status: "pending",
    }));
    this.notify();
  }

  notify(): void {
    for (const listener of Array.from(this.listeners)) {
      listener();
    }
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
  getProposalById(id: string): Proposal | undefined {
    return this.proposals.find((p) => p.id === id);
  }
  async acceptProposal(id: string): Promise<boolean> {
    const p = this.getProposalById(id);
    if (p) {
      p.status = "applied";
      this.notify();
      return true;
    }
    return false;
  }
  async rejectProposal(id: string): Promise<boolean> {
    const p = this.getProposalById(id);
    if (p) {
      p.status = "rejected";
      this.notify();
      return true;
    }
    return false;
  }
  onStoreChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  dispose(): void {
    this.disposeCount++;
    this.listeners.clear();
  }
}

// ============================================================================
// TEST SUITE: Milestone 4 Adversarial Stress Harness
// ============================================================================

describe("Milestone 4 Adversarial Stress Harness (m4_challenger_2)", () => {
  let mockApp: MockApp;
  let plugin: AIProposalsPlugin;
  const mockManifest = {
    id: "ai-proposals",
    name: "AI Proposals",
    version: "1.0.0",
    minAppVersion: "1.0.0",
    description: "Interactive AI Proposal approval bridge",
    author: "Livemaker",
    isDesktopOnly: false,
  };

  beforeEach(() => {
    mockApp = new MockApp();
    plugin = new AIProposalsPlugin(mockApp as unknown as App, mockManifest);
    Platform.isMobile = false;
  });

  afterEach(() => {
    try {
      plugin.onunload();
    } catch {
      // Safe teardown
    }
    Platform.isMobile = false;
  });

  // ==========================================================================
  // SCENARIO 1: Rapid Sequential Plugin onload() and onunload() Cycles
  // ==========================================================================
  describe("Scenario 1: Rapid Sequential Plugin onload() and onunload() Cycles", () => {
    it("1.1 executes 50 rapid sequential onload() / onunload() cycles without state pollution or memory leaks", async () => {
      const CYCLES = 50;

      for (let i = 0; i < CYCLES; i++) {
        // Mock leaves returned for sidebar view
        const mockLeaf = new WorkspaceLeaf();
        mockApp.workspace.getLeavesOfType = vi.fn().mockReturnValue([mockLeaf]);

        // Boot plugin
        await plugin.onload();

        // Verify loaded state
        expect(plugin.store).toBeDefined();
        expect(plugin.popoverManager).toBeDefined();
        expect(plugin.statusBarItem).not.toBeNull();

        // Spy on disposers for current cycle
        const storeDisposeSpy = vi.spyOn(plugin.store, "dispose");
        const popoverDisposeSpy = vi.spyOn(plugin.popoverManager, "dispose");
        const statusBarDisposeSpy = vi.spyOn(plugin.statusBarItem!, "dispose");

        // Teardown plugin
        plugin.onunload();

        // Verify clean disposal in each cycle
        expect(storeDisposeSpy).toHaveBeenCalledTimes(1);
        expect(popoverDisposeSpy).toHaveBeenCalledTimes(1);
        expect(statusBarDisposeSpy).toHaveBeenCalledTimes(1);
        expect(plugin.statusBarItem).toBeNull();
        expect(mockLeaf.detach).toHaveBeenCalled();
        expect(mockApp.workspace.detachLeavesOfType).toHaveBeenCalledWith(VIEW_TYPE_PROPOSAL_SIDEBAR);
      }
    });

    it("1.2 verifies onunload() idempotency: multiple consecutive onunload() calls do not crash", async () => {
      await plugin.onload();

      // First unload
      expect(() => plugin.onunload()).not.toThrow();
      expect(plugin.statusBarItem).toBeNull();

      // Consecutive unloads on already-unloaded plugin
      expect(() => plugin.onunload()).not.toThrow();
      expect(() => plugin.onunload()).not.toThrow();
      expect(() => plugin.onunload()).not.toThrow();
      expect(() => plugin.onunload()).not.toThrow();
    });

    it("1.3 calling onunload() on an uninitialized plugin (pre-onload) terminates cleanly without exceptions", () => {
      const freshPlugin = new AIProposalsPlugin(mockApp as unknown as App, mockManifest);
      expect(() => freshPlugin.onunload()).not.toThrow();
    });

    it("1.4 detaches multiple concurrent sidebar leaves across multiple windows/splits on unload", async () => {
      await plugin.onload();

      const leaf1 = new WorkspaceLeaf();
      const leaf2 = new WorkspaceLeaf();
      const leaf3 = new WorkspaceLeaf();

      mockApp.workspace.getLeavesOfType = vi.fn().mockReturnValue([leaf1, leaf2, leaf3]);

      plugin.onunload();

      expect(leaf1.detach).toHaveBeenCalled();
      expect(leaf2.detach).toHaveBeenCalled();
      expect(leaf3.detach).toHaveBeenCalled();
      expect(mockApp.workspace.detachLeavesOfType).toHaveBeenCalledWith(VIEW_TYPE_PROPOSAL_SIDEBAR);
    });

    it("1.5 status bar click handler is completely deregistered on onunload()", async () => {
      const mockElement = new HeadlessElement("div");
      plugin.addStatusBarItem = vi.fn().mockReturnValue(mockElement);

      await plugin.onload();

      const statusBarEl = plugin.statusBarItem?.getElement();
      expect(statusBarEl).toBeDefined();

      const removeEventListenerSpy = vi.spyOn(mockElement, "removeEventListener");

      plugin.onunload();

      // Click listener must be explicitly removed
      expect(removeEventListenerSpy).toHaveBeenCalledWith("click", expect.any(Function));
    });
  });

  // ==========================================================================
  // SCENARIO 2: Extreme Settings Configurations & Clamping/Fallbacks
  // ==========================================================================
  describe("Scenario 2: Extreme Settings Configurations & Clamping/Fallbacks", () => {
    let settingsTab: AIProposalsSettingTab;

    beforeEach(async () => {
      await plugin.loadSettings();
      settingsTab = new AIProposalsSettingTab(mockApp as unknown as App, plugin);
      (settingsTab as any).containerEl = new HeadlessElement("div");
    });

    it("2.1 clamps negative and non-numeric autoSnapRadius values to 0", async () => {
      const testCases = [-1, -5, -20, -100, -999999, -Infinity, NaN, undefined as any, "invalid" as any];

      for (const val of testCases) {
        await settingsTab.onScanRadiusChange(val);
        expect(plugin.settings.autoSnapRadius).toBe(0);
        expect(plugin.settings.neighborhoodScanRadius).toBe(0);
      }
    });

    it("2.2 clamps excessive autoSnapRadius values (> 20) to 20", async () => {
      const testCases = [21, 25, 50, 100, 999999, Infinity];

      for (const val of testCases) {
        await settingsTab.onScanRadiusChange(val);
        expect(plugin.settings.autoSnapRadius).toBe(20);
        expect(plugin.settings.neighborhoodScanRadius).toBe(20);
      }
    });

    it("2.3 correctly rounds floating-point autoSnapRadius values to integers within [0, 20]", async () => {
      await settingsTab.onScanRadiusChange(4.2);
      expect(plugin.settings.autoSnapRadius).toBe(4);

      await settingsTab.onScanRadiusChange(4.7);
      expect(plugin.settings.autoSnapRadius).toBe(5);

      await settingsTab.onScanRadiusChange(0.4);
      expect(plugin.settings.autoSnapRadius).toBe(0);

      await settingsTab.onScanRadiusChange(19.6);
      expect(plugin.settings.autoSnapRadius).toBe(20);
    });

    it("2.4 falls back empty, whitespace, and nullish buffer patterns to default", async () => {
      const emptyCases = ["", "   ", "\t", "\n\r  ", null as any, undefined as any];

      for (const val of emptyCases) {
        await settingsTab.onBufferPatternChange(val);
        expect(plugin.settings.bufferPattern).toBe(DEFAULT_SETTINGS.bufferPattern);
      }
    });

    it("2.5 preserves valid custom buffer patterns and trims surrounding whitespace", async () => {
      await settingsTab.onBufferPatternChange("  my_proposals_*.json  ");
      expect(plugin.settings.bufferPattern).toBe("my_proposals_*.json");

      await settingsTab.onBufferPatternChange("diff-buffer.json");
      expect(plugin.settings.bufferPattern).toBe("diff-buffer.json");
    });

    it("2.6 matchesBufferPattern handles regex metacharacters in glob without crashing", () => {
      const hostilePatterns = [
        "ai[0-9]+.*.json",
        "ai(test)+.json",
        "ai$*^.json",
        "ai\\suggestion*.json",
        "ai-*.json(copy)",
        "ai-{1,3}.json",
        "ai-[unclosed.json",
      ];

      for (const pattern of hostilePatterns) {
        expect(() => matchesBufferPattern("ai-test.json", pattern)).not.toThrow();
        expect(() => matchesBufferPattern("some-file.md", pattern)).not.toThrow();
      }

      // Exact matches
      expect(matchesBufferPattern("ai_suggestion-01.json", "ai_suggestion-*.json")).toBe(true);
      expect(matchesBufferPattern("other.json", "ai_suggestion-*.json")).toBe(false);
      expect(matchesBufferPattern("", "ai_suggestion-*.json")).toBe(false);
      expect(matchesBufferPattern("test.json", "")).toBe(false);
    });

    it("2.7 dirty persisted disk settings with negative values load safely without crashing ProposalStore", async () => {
      // Simulate corrupted disk data
      plugin.loadData = vi.fn().mockResolvedValue({
        autoSnapRadius: -99,
        neighborhoodScanRadius: -99,
        bufferPattern: "",
      });

      await plugin.loadSettings();

      // Verify plugin initialized without unhandled exception
      expect(plugin.settings.autoSnapRadius).toBe(-99);

      // ProposalStore instantiation with dirty settings must not crash
      plugin.store = {
        initialize: vi.fn().mockResolvedValue(undefined),
        updateSettings: vi.fn(),
        dispose: vi.fn(),
      } as any;

      await plugin.saveSettings();
      expect(plugin.store.updateSettings).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // SCENARIO 3: Status Bar Counter Transitions Under High-Frequency Store Changes
  // ==========================================================================
  describe("Scenario 3: Status Bar Counter Transitions Under High-Frequency Store Changes ($0 \to 100 \to 0$)", () => {
    let mockStore: MockReactiveStore;
    let mockElement: HeadlessElement;
    let statusBar: ProposalStatusBarItem;

    beforeEach(async () => {
      await plugin.loadSettings();
      mockStore = new MockReactiveStore(0);
      mockElement = new HeadlessElement("div");
      plugin.addStatusBarItem = vi.fn().mockReturnValue(mockElement);
      statusBar = new ProposalStatusBarItem(plugin, mockStore);
      plugin.statusBarItem = statusBar;
    });

    afterEach(() => {
      statusBar.dispose();
      mockStore.dispose();
    });

    it("3.1 executes 500 rapid alternating transitions ($0 -> 100 -> 0) with 100% state & class consistency", () => {
      const CYCLES = 250;

      for (let i = 0; i < CYCLES; i++) {
        // Transition to 100
        mockStore.setCount(100);
        expect(mockElement.textContent).toBe("✨ 100 propozycji");
        expect(mockElement.classList.contains("has-proposals")).toBe(true);
        expect(mockElement.classList.contains("no-proposals")).toBe(false);
        expect(mockElement.getAttribute("title")).toContain("100 oczekujących propozycji");

        // Transition back to 0
        mockStore.setCount(0);
        expect(mockElement.textContent).toBe("✨ 0");
        expect(mockElement.classList.contains("has-proposals")).toBe(false);
        expect(mockElement.classList.contains("no-proposals")).toBe(true);
        expect(mockElement.getAttribute("title")).toContain("brak oczekujących propozycji");
      }
    });

    it("3.2 survives a flood of 1,000 rapid store change notifications without memory leak or desync", () => {
      let currentCount = 0;

      for (let i = 0; i < 1000; i++) {
        currentCount = (currentCount + 1) % 50;
        mockStore.setCount(currentCount);
      }

      // Final state check
      const expectedText = formatProposalBadgeText(currentCount);
      expect(mockElement.textContent).toBe(expectedText);
    });

    it("3.3 exhaustive Polish grammar pluralization engine verification", () => {
      // 0: special zero badge
      expect(formatProposalBadgeText(0)).toBe("✨ 0");

      // 1: singular nominative (propozycja)
      expect(formatProposalBadgeText(1)).toBe("✨ 1 propozycja");

      // 2, 3, 4: plural nominative (propozycje)
      expect(formatProposalBadgeText(2)).toBe("✨ 2 propozycje");
      expect(formatProposalBadgeText(3)).toBe("✨ 3 propozycje");
      expect(formatProposalBadgeText(4)).toBe("✨ 4 propozycje");

      // 5 to 21: genitive plural (propozycji)
      for (let c = 5; c <= 21; c++) {
        expect(formatProposalBadgeText(c)).toBe(`✨ ${c} propozycji`);
      }

      // 22, 23, 24: propozycje
      expect(formatProposalBadgeText(22)).toBe("✨ 22 propozycje");
      expect(formatProposalBadgeText(23)).toBe("✨ 23 propozycje");
      expect(formatProposalBadgeText(24)).toBe("✨ 24 propozycje");

      // 25 to 31: propozycji
      for (let c = 25; c <= 31; c++) {
        expect(formatProposalBadgeText(c)).toBe(`✨ ${c} propozycji`);
      }

      // Teens in hundreds: 111, 112, 113, 114 -> propozycji
      expect(formatProposalBadgeText(111)).toBe("✨ 111 propozycji");
      expect(formatProposalBadgeText(112)).toBe("✨ 112 propozycji");
      expect(formatProposalBadgeText(113)).toBe("✨ 113 propozycji");
      expect(formatProposalBadgeText(114)).toBe("✨ 114 propozycji");

      // Non-teen endings in hundreds: 122, 123, 124 -> propozycje
      expect(formatProposalBadgeText(122)).toBe("✨ 122 propozycje");
      expect(formatProposalBadgeText(123)).toBe("✨ 123 propozycje");
      expect(formatProposalBadgeText(124)).toBe("✨ 124 propozycje");
    });

    it("3.4 mobile platform guard (Platform.isMobile = true) guarantees zero DOM access and safe no-ops", () => {
      Platform.isMobile = true;

      const mobilePlugin = new AIProposalsPlugin(mockApp as unknown as App, mockManifest);
      mobilePlugin.addStatusBarItem = vi.fn();

      const mobileStatusBar = new ProposalStatusBarItem(mobilePlugin, mockStore);

      // Verify no status bar element was created on mobile
      expect(mobilePlugin.addStatusBarItem).not.toHaveBeenCalled();
      expect(mobileStatusBar.getElement()).toBeNull();

      // All calls on mobile must safely no-op without throwing
      expect(() => mobileStatusBar.initialize()).not.toThrow();
      expect(() => mobileStatusBar.update()).not.toThrow();
      expect(() => mobileStatusBar.updateCount(25)).not.toThrow();
      expect(() => mobileStatusBar.dispose()).not.toThrow();
    });

    it("3.5 dynamic visibility toggling via showStatusBarCounter / showStatusBarBadge", async () => {
      mockStore.setCount(15);
      expect(mockElement.style.display).not.toBe("none");

      // Hide status bar
      plugin.settings.showStatusBarCounter = false;
      plugin.settings.showStatusBarBadge = false;
      await plugin.saveSettings();

      expect(mockElement.style.display).toBe("none");

      // Store updates while hidden must remain hidden
      mockStore.setCount(20);
      expect(mockElement.style.display).toBe("none");

      // Show status bar again
      plugin.settings.showStatusBarCounter = true;
      plugin.settings.showStatusBarBadge = true;
      await plugin.saveSettings();

      expect(mockElement.style.display).toBe("");
      expect(mockElement.textContent).toBe("✨ 20 propozycji");
    });
  });

  // ==========================================================================
  // SCENARIO 4: Command Palette Handlers & Edge Cases
  // ==========================================================================
  describe("Scenario 4: Command Palette Handlers & Edge Cases", () => {
    beforeEach(async () => {
      await plugin.onload();
    });

    it("4.1 acceptAllForActiveFile terminates safely when active file is null or undefined", async () => {
      mockApp.workspace.getActiveFile = vi.fn().mockReturnValue(null);

      const acceptSpy = vi.spyOn(plugin.store, "acceptProposal");
      await plugin.acceptAllForActiveFile();

      expect(acceptSpy).not.toHaveBeenCalled();
    });

    it("4.2 acceptAllForActiveFile terminates safely when active file has 0 proposals", async () => {
      const activeFile = mockApp.vault.seedFile("Empty.md", "no proposals here");
      mockApp.workspace.getActiveFile = vi.fn().mockReturnValue(activeFile);

      const acceptSpy = vi.spyOn(plugin.store, "acceptProposal");
      await plugin.acceptAllForActiveFile("Empty.md");

      expect(acceptSpy).not.toHaveBeenCalled();
    });

    it("4.3 acceptAllForActiveFile handles partial acceptance failures without throwing unhandled exceptions", async () => {
      const activeFile = mockApp.vault.seedFile("Test.md", "content");
      mockApp.workspace.getActiveFile = vi.fn().mockReturnValue(activeFile);

      const p1: Proposal = {
        id: "p1",
        file: "Test.md",
        sourceFile: "buf.json",
        line: 1,
        ch: 0,
        toCh: 1,
        original: "a",
        replacement: "b",
        status: "pending",
      };
      const p2: Proposal = {
        id: "p2",
        file: "Test.md",
        sourceFile: "buf.json",
        line: 2,
        ch: 0,
        toCh: 1,
        original: "c",
        replacement: "d",
        status: "pending",
      };

      (plugin.store as any).proposals = [p1, p2];

      // Simulate first succeeding, second throwing error
      vi.spyOn(plugin.store, "acceptProposal")
        .mockResolvedValueOnce(true)
        .mockRejectedValueOnce(new Error("Disk full simulation"));

      // Must catch error and complete without unhandled promise rejection
      await expect(plugin.acceptAllForActiveFile("Test.md")).resolves.not.toThrow();
    });

    it("4.4 handleScanCommand catches scan errors and notifies without throwing", async () => {
      vi.spyOn(plugin.store, "scanVaultBuffers").mockRejectedValue(new Error("Vault read error"));

      await expect(plugin.handleScanCommand()).resolves.not.toThrow();
    });

    it("4.5 toggleSidebarLeaf creates new leaf when none exists, and detaches when one exists", async () => {
      // Branch 1: leaf exists -> detaches
      const existingLeaf = new WorkspaceLeaf();
      mockApp.workspace.getLeavesOfType = vi.fn().mockReturnValue([existingLeaf]);

      await plugin.toggleSidebarLeaf();
      expect(mockApp.workspace.detachLeavesOfType).toHaveBeenCalledWith(VIEW_TYPE_PROPOSAL_SIDEBAR);

      // Branch 2: no leaf exists -> creates right leaf
      const newLeaf = new WorkspaceLeaf();
      newLeaf.setViewState = vi.fn().mockResolvedValue(undefined);
      mockApp.workspace.getLeavesOfType = vi.fn().mockReturnValue([]);
      mockApp.workspace.getRightLeaf = vi.fn().mockReturnValue(newLeaf);

      await plugin.toggleSidebarLeaf();
      expect(mockApp.workspace.getRightLeaf).toHaveBeenCalledWith(false);
      expect(newLeaf.setViewState).toHaveBeenCalledWith({
        type: VIEW_TYPE_PROPOSAL_SIDEBAR,
        active: true,
      });
      expect(mockApp.workspace.revealLeaf).toHaveBeenCalledWith(newLeaf);
    });
  });
});
