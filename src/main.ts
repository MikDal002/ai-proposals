/**
 * src/main.ts
 * Main Plugin Entry Point & Lifecycle Coordinator for AI Proposals Obsidian Plugin.
 *
 * Guarantees:
 * - Mobile Safety: ZERO Node.js runtime imports (no fs, path, child_process). 100% Obsidian public API.
 * - 10-phase onload() bootstrapping sequence.
 * - 4-phase onunload() teardown sequence with safe leaf detachment.
 * - Full CM6 view plugin, floating popover, sidebar, status bar & settings tab integration.
 */

import { Plugin, Notice, Platform, WorkspaceLeaf, TFile } from "obsidian";
import { ProposalStore } from "./store/proposal-store";
import { PopoverManager } from "./editor/popover-manager";
import { createProposalViewPlugin } from "./editor/proposal-view-plugin";
import {
  ProposalSidebarView,
  VIEW_TYPE_PROPOSAL_SIDEBAR,
} from "./ui/proposal-sidebar-view";
import { ProposalStatusBarItem } from "./ui/status-bar";
import { AIProposalsSettingTab } from "./settings/settings-tab";
import {
  DEFAULT_SETTINGS,
  type PluginSettings,
} from "./types";

export default class AIProposalsPlugin extends Plugin {
  public settings: PluginSettings = { ...DEFAULT_SETTINGS };
  public store!: ProposalStore;
  public popoverManager!: PopoverManager;
  public statusBarItem: ProposalStatusBarItem | null = null;

  async onload(): Promise<void> {
    console.log("[AI Proposals] Initializing plugin...");

    // 1. Load settings
    await this.loadSettings();

    // 2. Core Proposal Store
    this.store = new ProposalStore(this.app, () => this.settings);
    await this.store.initialize();

    // 3. Floating Popover Manager
    this.popoverManager = new PopoverManager(this.app, this.store);

    // 4. Sidebar ItemView Registration
    this.registerView(
      VIEW_TYPE_PROPOSAL_SIDEBAR,
      (leaf: WorkspaceLeaf) => new ProposalSidebarView(leaf, this.store, this)
    );

    // 5. CodeMirror 6 ViewPlugin & Extension Registration
    const cm6Extension = createProposalViewPlugin(this.store, this.popoverManager);
    this.registerEditorExtension(cm6Extension);

    // 6. Ribbon Icon
    this.addRibbonIcon("sparkles", "AI Proposals", async () => {
      await this.toggleSidebarLeaf();
    });

    // 7. Commands
    this.registerPluginCommands();

    // 8. Settings Tab
    this.addSettingTab(new AIProposalsSettingTab(this.app, this));

    // 9. Status Bar Item (Desktop only)
    this.initStatusBar();

    // 10. Layout-ready Hook
    if (this.app?.workspace?.onLayoutReady) {
      this.app.workspace.onLayoutReady(async () => {
        if (this.settings?.autoOpenSidebar) {
          const proposals = this.store.getAllProposals();
          if (proposals.length > 0) {
            await this.activateSidebarLeaf();
          }
        }
      });
    }

    console.log("[AI Proposals] Plugin loaded successfully.");
  }

  onunload(): void {
    console.log("[AI Proposals] Unloading plugin...");

    // 1. Dispose Status Bar Item
    if (this.statusBarItem) {
      this.statusBarItem.dispose();
      this.statusBarItem = null;
    }

    // 2. Dispose Popover Manager
    if (this.popoverManager) {
      this.popoverManager.dispose();
    }

    // 3. Dispose Proposal Store
    if (this.store && typeof this.store.dispose === "function") {
      this.store.dispose();
    }

    // 4. Detach Sidebar Leaves
    if (this.app?.workspace?.getLeavesOfType) {
      const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_PROPOSAL_SIDEBAR);
      for (const leaf of leaves) {
        if (typeof (leaf as { detach?: () => void }).detach === "function") {
          (leaf as { detach: () => void }).detach();
        }
      }
    }
    if (typeof this.app?.workspace?.detachLeavesOfType === "function") {
      this.app.workspace.detachLeavesOfType(VIEW_TYPE_PROPOSAL_SIDEBAR);
    }

    console.log("[AI Proposals] Plugin unloaded.");
  }

  // ==========================================
  // Settings Management
  // ==========================================

  async loadSettings(): Promise<void> {
    const loadedData = (await this.loadData()) ?? {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);

    if (this.store) {
      this.store.updateSettings(this.settings);
    }

    if (this.statusBarItem) {
      this.statusBarItem.update();
    }
  }

  // ==========================================
  // Status Bar Management
  // ==========================================

  public initStatusBar(): void {
    if (Platform.isMobile) {
      return;
    }
    const show =
      this.settings?.showStatusBarCounter ??
      this.settings?.showStatusBarBadge ??
      true;
    if (show && !this.statusBarItem) {
      this.statusBarItem = new ProposalStatusBarItem(this, this.store);
    }
  }

  public updateStatusBarVisibility(): void {
    if (this.statusBarItem) {
      this.statusBarItem.update();
    } else if (!Platform.isMobile && (this.settings?.showStatusBarCounter ?? this.settings?.showStatusBarBadge ?? true)) {
      this.initStatusBar();
    }
  }

  // ==========================================
  // Workspace Leaf Navigation
  // ==========================================

  public async activateSidebarLeaf(): Promise<WorkspaceLeaf | null> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType?.(VIEW_TYPE_PROPOSAL_SIDEBAR) ?? [];

    if (leaves.length > 0) {
      leaf = leaves[0];
    } else if (workspace.getRightLeaf) {
      leaf = workspace.getRightLeaf(false);
      if (leaf && leaf.setViewState) {
        await leaf.setViewState({
          type: VIEW_TYPE_PROPOSAL_SIDEBAR,
          active: true,
        });
      }
    }

    if (leaf && workspace.revealLeaf) {
      workspace.revealLeaf(leaf);
    }
    return leaf;
  }

  public async toggleSidebarLeaf(): Promise<void> {
    const { workspace } = this.app;
    const leaves = workspace.getLeavesOfType?.(VIEW_TYPE_PROPOSAL_SIDEBAR) ?? [];

    if (leaves.length > 0) {
      if (typeof workspace.detachLeavesOfType === "function") {
        workspace.detachLeavesOfType(VIEW_TYPE_PROPOSAL_SIDEBAR);
      } else {
        for (const leaf of leaves) {
          if (typeof (leaf as { detach?: () => void }).detach === "function") {
            (leaf as { detach: () => void }).detach();
          }
        }
      }
    } else {
      await this.activateSidebarLeaf();
    }
  }

  // ==========================================
  // Command Registrations
  // ==========================================

  private registerPluginCommands(): void {
    // 1. Open Sidebar Command
    this.addCommand({
      id: "open-sidebar",
      name: "Otwórz panel propozycji AI",
      callback: async () => {
        await this.activateSidebarLeaf();
      },
    });

    // 2. Scan Buffers Command
    this.addCommand({
      id: "scan-buffers",
      name: "Skanuj bufory propozycji w skarbcu",
      callback: async () => {
        await this.handleScanCommand();
      },
    });

    // 3. Accept all active file proposals Command
    this.addCommand({
      id: "accept-all-active",
      name: "Zaakceptuj wszystkie propozycje dla aktywnego pliku",
      checkCallback: (checking: boolean) => {
        const activeFile = this.app?.workspace?.getActiveFile?.();
        if (!activeFile) {
          return false;
        }

        const ext = (activeFile as TFile).extension;
        if (ext && ext !== "md") {
          return false;
        }

        const proposals = this.store.getProposalsForFile(activeFile.path);
        const pendingCount = proposals.filter((p) => p.status === "pending").length;
        if (pendingCount === 0) {
          return false;
        }

        if (!checking) {
          void this.acceptAllForActiveFile(activeFile.path);
        }
        return true;
      },
    });
  }

  public async handleScanCommand(): Promise<void> {
    new Notice("AI Proposals: Skanowanie buforów w skarbcu...");
    try {
      const proposals = await this.store.scanVaultBuffers();
      new Notice(`AI Proposals: Znaleziono ${proposals.length} propozycji.`);
    } catch (err) {
      console.error("[AI Proposals] Error during buffer scan:", err);
      new Notice("AI Proposals: Błąd podczas skanowania buforów.");
    }
  }

  public async acceptAllForActiveFile(filePath?: string): Promise<void> {
    const targetPath = filePath || this.app?.workspace?.getActiveFile?.()?.path;
    if (!targetPath) return;

    const proposals = this.store.getProposalsForFile(targetPath);
    const pending = proposals.filter((p) => p.status === "pending");
    if (pending.length === 0) return;

    new Notice(`AI Proposals: Aplikowanie ${pending.length} propozycji...`);
    let accepted = 0;

    for (const proposal of pending) {
      const targetId = proposal.compoundId ?? proposal.id;
      const current = this.store.getProposalById(targetId);
      if (current && current.status === "pending") {
        try {
          const ok = await this.store.acceptProposal(targetId);
          if (ok) accepted++;
        } catch (err) {
          console.error(`[AI Proposals] Error applying proposal ${targetId}:`, err);
        }
      }
    }

    new Notice(`AI Proposals: Zastosowano ${accepted} z ${pending.length} propozycji.`);
  }
}
