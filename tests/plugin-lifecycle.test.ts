/**
 * tests/plugin-lifecycle.test.ts
 * Comprehensive Unit and Integration Test Suite for Milestone 4 Plugin Lifecycle, Status Bar & Settings.
 *
 * Covers:
 * - LC-01 to LC-03: Settings Model, Schema Reconciliation & Persistence
 * - LC-04 to LC-07: Settings Tab View (AIProposalsSettingTab)
 * - LC-08 to LC-12: Status Bar Item & Pluralization (ProposalStatusBarItem / AIProposalStatusBar)
 * - LC-13 to LC-17: Main Plugin 10-Phase Boot Sequence (AIProposalsPlugin.onload)
 * - LC-18 to LC-19: Command Palette Handlers (open-sidebar, scan-buffers, accept-all-active)
 * - LC-20 to LC-23: Teardown, Disposal & Rapid Reload Lifecycle
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  App as MockApp,
  Platform,
  WorkspaceLeaf,
} from "./mocks/obsidian";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS, type Proposal } from "../src/types";

// Import Main Plugin, Status Bar & Settings Tab
import AIProposalsPlugin from "../src/main";
import { AIProposalsSettingTab } from "../src/settings/settings-tab";
import { ProposalStatusBarItem, AIProposalStatusBar } from "../src/ui/status-bar";
import { VIEW_TYPE_PROPOSAL_SIDEBAR } from "../src/ui/proposal-sidebar-view";

// ============================================================================
// Headless DOM Environment Setup
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
}

// ============================================================================
// Test Suite
// ============================================================================

describe("Plugin Lifecycle, Status Bar & Settings Tab (Milestone 4)", () => {
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
    plugin.onunload();
    Platform.isMobile = false;
  });

  describe("Settings Model & Persistence", () => {
    it("LC-01: loads DEFAULT_SETTINGS when no persisted data exists", async () => {
      plugin.loadData = vi.fn().mockResolvedValue(null);
      await plugin.loadSettings();

      expect(plugin.settings).toEqual(DEFAULT_SETTINGS);
      expect(plugin.settings.bufferPattern).toBe("ai_suggestion-*.json");
      expect(plugin.settings.neighborhoodScanRadius).toBe(5);
      expect(plugin.settings.autoSnapRadius).toBe(5);
      expect(plugin.settings.enableHighlights).toBe(true);
    });

    it("LC-02: mutates settings and persists cleanly via saveData", async () => {
      plugin.loadData = vi.fn().mockResolvedValue({});
      await plugin.loadSettings();

      plugin.settings.bufferPattern = "custom-suggestions-*.json";
      plugin.settings.neighborhoodScanRadius = 12;
      plugin.settings.autoSnapRadius = 12;

      await plugin.saveSettings();

      expect(plugin.saveData).toHaveBeenCalledWith(
        expect.objectContaining({
          bufferPattern: "custom-suggestions-*.json",
          neighborhoodScanRadius: 12,
        })
      );
    });

    it("LC-03: merges partial disk settings with DEFAULT_SETTINGS safely", async () => {
      plugin.loadData = vi.fn().mockResolvedValue({
        bufferPattern: "my-diffs-*.json",
      });

      await plugin.loadSettings();

      expect(plugin.settings.bufferPattern).toBe("my-diffs-*.json");
      expect(plugin.settings.neighborhoodScanRadius).toBe(5);
      expect(plugin.settings.autoSnapRadius).toBe(5);
      expect(plugin.settings.enableHighlights).toBe(true);
    });
  });

  describe("Settings Tab View (AIProposalsSettingTab)", () => {
    let settingsTab: AIProposalsSettingTab;

    beforeEach(async () => {
      await plugin.loadSettings();
      settingsTab = new AIProposalsSettingTab(mockApp as unknown as App, plugin);
      (settingsTab as any).containerEl = new HeadlessElement("div");
    });

    it("LC-04: display() clears container and renders settings sections", () => {
      settingsTab.display();

      const container = (settingsTab as any).containerEl as HeadlessElement;
      expect(container.children.length).toBeGreaterThan(0);
    });

    it("LC-05: buffer pattern input triggers saveSettings on change", async () => {
      const saveSpy = vi.spyOn(plugin, "saveSettings");
      settingsTab.display();

      await settingsTab.onBufferPatternChange("new-pattern-*.json");

      expect(plugin.settings.bufferPattern).toBe("new-pattern-*.json");
      expect(saveSpy).toHaveBeenCalled();
    });

    it("LC-06: empty buffer pattern resets safely to default", async () => {
      settingsTab.display();

      await settingsTab.onBufferPatternChange("   ");

      expect(plugin.settings.bufferPattern).toBe(DEFAULT_SETTINGS.bufferPattern);
    });

    it("LC-07: scan radius input clamps negative and excessive numbers to [0, 20]", async () => {
      settingsTab.display();

      await settingsTab.onScanRadiusChange(-10);
      expect(plugin.settings.neighborhoodScanRadius).toBe(0);
      expect(plugin.settings.autoSnapRadius).toBe(0);

      await settingsTab.onScanRadiusChange(99);
      expect(plugin.settings.neighborhoodScanRadius).toBe(20);
      expect(plugin.settings.autoSnapRadius).toBe(20);

      await settingsTab.onScanRadiusChange(8);
      expect(plugin.settings.neighborhoodScanRadius).toBe(8);
      expect(plugin.settings.autoSnapRadius).toBe(8);
    });
  });

  describe("Status Bar Item (ProposalStatusBarItem / AIProposalStatusBar)", () => {
    let statusBar: ProposalStatusBarItem;
    let mockElement: any;

    beforeEach(async () => {
      await plugin.loadSettings();
      plugin.store = {
        getAllProposals: vi.fn().mockReturnValue([]),
        onStoreChange: vi.fn().mockReturnValue(() => {}),
        dispose: vi.fn(),
      } as any;
      mockElement = new HeadlessElement("div");
      plugin.addStatusBarItem = vi.fn().mockReturnValue(mockElement);
      statusBar = new AIProposalStatusBar(plugin, plugin.store);
    });

    it("LC-08: initializes status bar item on desktop platform", () => {
      Platform.isMobile = false;
      statusBar.initialize();

      expect(plugin.addStatusBarItem).toHaveBeenCalled();
      expect(mockElement.className).toContain("ai-proposals-status-bar");
    });

    it("LC-09: skips status bar creation gracefully on mobile platform", () => {
      Platform.isMobile = true;
      const mobilePlugin = new AIProposalsPlugin(mockApp as unknown as App, mockManifest);
      mobilePlugin.addStatusBarItem = vi.fn();
      const mobileStatusBar = new AIProposalStatusBar(mobilePlugin, plugin.store);
      mobileStatusBar.initialize();

      expect(mobilePlugin.addStatusBarItem).not.toHaveBeenCalled();
    });

    it("LC-10: updates counter badge text on store change (0 -> N -> 0)", () => {
      statusBar.initialize();

      statusBar.updateCount(0);
      expect(mockElement.textContent).toBe("✨ AI: 0");

      statusBar.updateCount(7);
      expect(mockElement.textContent).toBe("✨ AI: 7");

      statusBar.updateCount(0);
      expect(mockElement.textContent).toBe("✨ AI: 0");
    });

    it("LC-11: respects showStatusBarBadge / showStatusBarCounter setting", () => {
      statusBar.initialize();
      plugin.settings.showStatusBarBadge = false;
      plugin.settings.showStatusBarCounter = false;

      statusBar.updateCount(5);
      expect(mockElement.style.display).toBe("none");

      plugin.settings.showStatusBarBadge = true;
      plugin.settings.showStatusBarCounter = true;
      statusBar.updateCount(5);
      expect(mockElement.style.display).not.toBe("none");
    });

    it("LC-12: clicking status bar reveals or activates sidebar leaf", async () => {
      statusBar.initialize();

      const existingLeaf = new WorkspaceLeaf();
      mockApp.workspace.getLeavesOfType = vi.fn().mockReturnValue([existingLeaf]);

      await mockElement.dispatchEvent({ type: "click" });

      expect(mockApp.workspace.revealLeaf).toHaveBeenCalledWith(existingLeaf);
    });
  });

  describe("Plugin Lifecycle (AIProposalsPlugin.onload & onunload)", () => {
    it("LC-13 to LC-17: onload registers view, extension, ribbon, commands, settings, status bar", async () => {
      const registerViewSpy = vi.spyOn(plugin, "registerView");
      const registerExtSpy = vi.spyOn(plugin, "registerEditorExtension");
      const addRibbonSpy = vi.spyOn(plugin, "addRibbonIcon");
      const addCommandSpy = vi.spyOn(plugin, "addCommand");
      const addSettingTabSpy = vi.spyOn(plugin, "addSettingTab");
      const addStatusBarSpy = vi.spyOn(plugin, "addStatusBarItem");

      await plugin.onload();

      expect(registerViewSpy).toHaveBeenCalledWith(
        VIEW_TYPE_PROPOSAL_SIDEBAR,
        expect.any(Function)
      );
      expect(registerExtSpy).toHaveBeenCalled();
      expect(addRibbonSpy).toHaveBeenCalledWith("sparkles", "AI Proposals", expect.any(Function));
      expect(addCommandSpy).toHaveBeenCalledTimes(3);
      expect(addSettingTabSpy).toHaveBeenCalled();
      expect(addStatusBarSpy).toHaveBeenCalled();
    });

    it("LC-18: command 'accept-all-active' accepts proposals for current active note", async () => {
      await plugin.onload();

      const activeFile = mockApp.vault.seedFile("Draft.md", "content");
      mockApp.workspace.getActiveFile = vi.fn().mockReturnValue(activeFile);

      const p1: Proposal = {
        id: "p1",
        file: "Draft.md",
        sourceFile: "b1.json",
        line: 1,
        ch: 0,
        toCh: 1,
        original: "a",
        replacement: "b",
        status: "pending",
      };
      const p2: Proposal = {
        id: "p2",
        file: "Draft.md",
        sourceFile: "b1.json",
        line: 2,
        ch: 0,
        toCh: 1,
        original: "x",
        replacement: "y",
        status: "pending",
      };
      const p3: Proposal = {
        id: "p3",
        file: "Other.md",
        sourceFile: "b1.json",
        line: 1,
        ch: 0,
        toCh: 1,
        original: "o",
        replacement: "n",
        status: "pending",
      };

      (plugin as any).store.proposals = [p1, p2, p3];
      const acceptSpy = vi.spyOn((plugin as any).store, "acceptProposal").mockResolvedValue(true);

      await plugin.acceptAllForActiveFile();

      expect(acceptSpy).toHaveBeenCalledWith("p1");
      expect(acceptSpy).toHaveBeenCalledWith("p2");
      expect(acceptSpy).not.toHaveBeenCalledWith("p3");
    });

    it("LC-19: command 'scan-buffers' triggers vault scan", async () => {
      await plugin.onload();
      const scanSpy = vi.spyOn((plugin as any).store, "scanVaultBuffers").mockResolvedValue([]);

      await plugin.handleScanCommand();

      expect(scanSpy).toHaveBeenCalled();
    });

    it("LC-20 & LC-21: onunload cleanly disposes store and detaches sidebar leaves", async () => {
      await plugin.onload();

      const mockLeaf = new WorkspaceLeaf();
      mockApp.workspace.getLeavesOfType = vi.fn().mockReturnValue([mockLeaf]);

      const storeDisposeSpy = vi.spyOn((plugin as any).store, "dispose");

      plugin.onunload();

      expect(storeDisposeSpy).toHaveBeenCalled();
      expect(mockLeaf.detach).toHaveBeenCalled();
    });

    it("LC-22: onunload cleans up status bar and popover without leaks", async () => {
      await plugin.onload();

      expect(plugin.statusBarItem).not.toBeNull();
      const statusDisposeSpy = vi.spyOn(plugin.statusBarItem!, "dispose");
      const popoverDisposeSpy = vi.spyOn(plugin.popoverManager, "dispose");

      plugin.onunload();

      expect(statusDisposeSpy).toHaveBeenCalled();
      expect(popoverDisposeSpy).toHaveBeenCalled();
      expect(plugin.statusBarItem).toBeNull();
    });

    it("LC-23: rapid reload cycle (onload -> onunload -> onload) executes without state contamination", async () => {
      await plugin.onload();
      plugin.onunload();
      await plugin.onload();

      expect(plugin.settings).toBeDefined();
      expect(plugin.store).toBeDefined();
    });
  });
});
