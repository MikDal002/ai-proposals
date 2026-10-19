/**
 * src/ui/proposal-sidebar-view.ts
 * Two-Tier Interactive Proposals Sidebar ItemView for AI Proposals Obsidian Plugin.
 *
 * Guarantees:
 * - Mobile Safety: ZERO Node.js runtime imports (no fs, path, child_process). 100% Obsidian public API.
 * - Quadruple Shield: immune to active-leaf-change unmounting bug.
 * - Triple-Guard Concurrency Locking: prevents double-clicks and race conditions.
 * - Two-Tier Grouping: Tier 1 (Active Note) and Tier 2 (Vault Accordions).
 */

import {
  ItemView,
  WorkspaceLeaf,
  TFile,
  Notice,
  normalizePath,
  MarkdownView,
  type App,
  type EventRef,
} from "obsidian";
import type { IProposalStore, Proposal } from "../types";
import { renderDiffPreview } from "../editor/popover-manager";

export const VIEW_TYPE_PROPOSAL_SIDEBAR = "ai-proposals-sidebar";
export const SIDEBAR_ICON = "sparkles";
export const SIDEBAR_TITLE = "AI Proposals";

export interface FileProposalGroup {
  readonly filePath: string;
  readonly fileName: string;
  readonly proposals: Proposal[];
}

export interface SidebarViewState {
  readonly activeFilePath: string | null;
  readonly activeFileProposals: Proposal[];
  readonly vaultGroups: FileProposalGroup[];
  readonly totalProposalsCount: number;
}

export function formatRelativeTime(timestamp?: number): string {
  if (!timestamp || isNaN(timestamp)) return "";
  const diffSec = Math.floor((Date.now() - timestamp) / 1000);
  if (diffSec < 60) return "przed chwilą";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min temu`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours} godz. temu`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} dni temu`;
}

export class ProposalSidebarView extends ItemView {
  private readonly store: IProposalStore;
  private lastActiveFilePath: string | null = null;
  private renderScheduled = false;
  private rafHandle: number | null = null;
  private readonly processingIds = new Set<string>();
  private readonly collapsedFiles = new Set<string>();
  private eventRefs: EventRef[] = [];
  private unsubscribeStore: (() => void) | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    storeOrApp: IProposalStore | App,
    pluginOrStore?: unknown
  ) {
    super(leaf);
    if (pluginOrStore && typeof (pluginOrStore as IProposalStore).getAllProposals === "function") {
      this.store = pluginOrStore as IProposalStore;
    } else if (storeOrApp && typeof (storeOrApp as IProposalStore).getAllProposals === "function") {
      this.store = storeOrApp as IProposalStore;
    } else {
      this.store = pluginOrStore as IProposalStore;
    }

    interface AppHolder {
      app?: App;
    }

    if (storeOrApp && "vault" in storeOrApp) {
      (this as unknown as { app: App }).app = storeOrApp as App;
    } else if (pluginOrStore && typeof pluginOrStore === "object" && "app" in pluginOrStore) {
      const holder = pluginOrStore as AppHolder;
      if (holder.app) {
        (this as unknown as { app: App }).app = holder.app;
      }
    } else if (leaf) {
      const leafHolder = leaf as unknown as AppHolder;
      if (leafHolder.app) {
        (this as unknown as { app: App }).app = leafHolder.app;
      }
    }
  }

  public getViewType(): string {
    return VIEW_TYPE_PROPOSAL_SIDEBAR;
  }

  public getDisplayText(): string {
    return SIDEBAR_TITLE;
  }

  public getIcon(): string {
    return SIDEBAR_ICON;
  }

  public async onOpen(): Promise<void> {
    if (typeof this.contentEl.empty === "function") {
      this.contentEl.empty();
    }
    if (typeof this.contentEl.addClass === "function") {
      this.contentEl.addClass("ai-proposals-sidebar-view");
    } else if (this.contentEl.classList) {
      this.contentEl.classList.add("ai-proposals-sidebar-view");
    }

    if (typeof this.addAction === "function") {
      this.addAction("refresh-cw", "Odśwież propozycje ze skarbca", async () => {
        new Notice("AI Proposals: Skanowanie buforów...");
        await this.store.scanVaultBuffers();
      });

      this.addAction("chevrons-up-down", "Zwiń / Rozwiń wszystkie", () => {
        this.toggleCollapseAll();
      });
    }

    this.unsubscribeStore = this.store.onStoreChange(() => {
      this.scheduleRender();
    });

    if (this.app?.workspace?.on) {
      this.registerWorkspaceEvent(
        this.app.workspace.on("file-open", (file: unknown) => {
          this.onActiveFileChange(file as TFile | null);
        })
      );

      this.registerWorkspaceEvent(
        this.app.workspace.on("active-leaf-change", (leaf: unknown) => {
          this.onActiveLeafChange(leaf as WorkspaceLeaf | null);
        })
      );
    }

    if (this.app?.vault?.on) {
      this.registerWorkspaceEvent(
        this.app.vault.on("rename", (file: unknown, oldPath: string) => {
          const normOld = normalizePath(oldPath);
          if (this.lastActiveFilePath === normOld && file instanceof TFile) {
            this.lastActiveFilePath = normalizePath(file.path);
          }
          this.scheduleRender();
        })
      );
    }

    const activeFile = this.app?.workspace?.getActiveFile?.();
    this.lastActiveFilePath = activeFile ? normalizePath(activeFile.path) : null;
    this.render();
  }

  public async onClose(): Promise<void> {
    if (this.unsubscribeStore) {
      this.unsubscribeStore();
      this.unsubscribeStore = null;
    }

    if (this.app?.workspace?.offref) {
      for (const ref of this.eventRefs) {
        this.app.workspace.offref(ref);
      }
    }
    this.eventRefs = [];

    if (this.rafHandle !== null) {
      if (typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(this.rafHandle);
      }
      this.rafHandle = null;
    }
    this.renderScheduled = false;
    this.processingIds.clear();

    if (typeof this.contentEl?.empty === "function") {
      this.contentEl.empty();
    }
  }

  private registerWorkspaceEvent(ref: EventRef): void {
    if (ref) {
      this.eventRefs.push(ref);
    }
  }

  public onActiveLeafChange(leaf: WorkspaceLeaf | null): void {
    if (!leaf) return;

    // Shield 1: Strictly ignore when this sidebar leaf becomes active
    if (leaf.view?.getViewType?.() === VIEW_TYPE_PROPOSAL_SIDEBAR) {
      return;
    }

    // Shield 2: Check if active file path actually changed
    const currentActiveFile = this.app?.workspace?.getActiveFile?.();
    const currentPath = currentActiveFile ? normalizePath(currentActiveFile.path) : null;

    if (currentPath !== this.lastActiveFilePath) {
      this.lastActiveFilePath = currentPath;
      this.scheduleRender();
    }
  }

  public onActiveFileChange(file: TFile | null | { path: string }): void {
    const currentPath = file && "path" in file ? normalizePath(file.path) : null;
    if (currentPath !== this.lastActiveFilePath) {
      this.lastActiveFilePath = currentPath;
      this.scheduleRender();
    }
  }

  public scheduleRender(): void {
    if (typeof requestAnimationFrame === "function") {
      if (this.renderScheduled) return;
      this.renderScheduled = true;
      this.rafHandle = requestAnimationFrame(() => {
        this.renderScheduled = false;
        this.rafHandle = null;
        this.render();
      });
    } else {
      this.render();
    }
  }

  public render(): void {
    if (!this.containerEl || !this.contentEl) return;

    const prevScroll = this.contentEl.scrollTop ?? 0;
    if (typeof this.contentEl.empty === "function") {
      this.contentEl.empty();
    } else {
      (this.contentEl as HTMLElement).innerHTML = "";
    }

    this.buildSidebarDOM();
    if (this.contentEl) {
      this.contentEl.scrollTop = prevScroll;
    }
  }

  private getSidebarViewState(): SidebarViewState {
    const activeFile = this.app?.workspace?.getActiveFile?.();
    const activeFilePath = activeFile ? normalizePath(activeFile.path) : null;

    const allProposals = this.store.getAllProposals().filter((p) => p.status === "pending");

    const activeFileProposals: Proposal[] = [];
    const otherProposals: Proposal[] = [];

    for (const p of allProposals) {
      const normTarget = normalizePath(p.file);
      if (activeFilePath !== null && normTarget === activeFilePath) {
        activeFileProposals.push(p);
      } else {
        otherProposals.push(p);
      }
    }

    activeFileProposals.sort((a, b) => a.line - b.line || a.ch - b.ch);

    const fileGroupMap = new Map<string, Proposal[]>();
    for (const p of otherProposals) {
      const norm = normalizePath(p.file);
      if (!fileGroupMap.has(norm)) {
        fileGroupMap.set(norm, []);
      }
      fileGroupMap.get(norm)!.push(p);
    }

    const vaultGroups: FileProposalGroup[] = [];
    for (const [filePath, proposals] of fileGroupMap.entries()) {
      proposals.sort((a, b) => a.line - b.line || a.ch - b.ch);
      const fileName = filePath.split("/").pop() ?? filePath;
      vaultGroups.push({ filePath, fileName, proposals });
    }

    vaultGroups.sort((a, b) => a.fileName.localeCompare(b.fileName));

    return {
      activeFilePath,
      activeFileProposals,
      vaultGroups,
      totalProposalsCount: allProposals.length,
    };
  }

  private buildSidebarDOM(): void {
    const state = this.getSidebarViewState();

    // 1. Global Empty State (0 proposals anywhere in vault)
    if (state.totalProposalsCount === 0) {
      const emptyContainer = this.contentEl.createDiv({
        cls: "ai-empty-state ai-proposals-empty-vault",
      });
      emptyContainer.createDiv({ cls: "ai-empty-icon", text: "✨" });
      emptyContainer.createDiv({
        cls: "ai-empty-title",
        text: "Wszystkie propozycje przejrzane",
      });
      emptyContainer.createDiv({
        cls: "ai-empty-subtitle",
        text: "Brak oczekujących sugestii AI w skarbcu. Nowe propozycje pojawią się tutaj automatycznie.",
      });

      const rescanBtn = emptyContainer.createEl("button", {
        cls: "ai-sidebar-btn ai-btn-navigate",
        text: "Skanuj ponownie",
      });
      rescanBtn.addEventListener("click", async () => {
        new Notice("AI Proposals: Skanowanie buforów...");
        await this.store.scanVaultBuffers();
      });
      return;
    }

    // 2. Summary Header Bar
    const summary = this.contentEl.createDiv({ cls: "ai-sidebar-summary" });
    const summaryTitle = summary.createDiv({ cls: "ai-sidebar-title" });
    summaryTitle.createSpan({ text: "✨ AI Proposals" });

    const totalBadge = summary.createSpan({
      cls: "ai-badge mod-active",
      text: String(state.totalProposalsCount),
    });
    totalBadge.title = `${state.totalProposalsCount} oczekujących propozycji`;

    // 3. Tier 1: Active File Section
    const activeSection = this.contentEl.createDiv({
      cls: "ai-tier-section ai-proposals-section-active",
    });

    const activeHeader = activeSection.createDiv({ cls: "ai-tier-header" });
    const activeTitleGroup = activeHeader.createDiv({ cls: "ai-tier-title-group" });
    activeTitleGroup.createSpan({ text: "📄 Bieżąca notatka" });

    activeHeader.createSpan({
      cls: `ai-badge ${state.activeFileProposals.length > 0 ? "mod-active" : ""}`,
      text: String(state.activeFileProposals.length),
    });

    if (state.activeFilePath === null) {
      const notePlaceholder = activeSection.createDiv({
        cls: "ai-empty-state ai-proposals-empty-note",
      });
      notePlaceholder.createDiv({ cls: "ai-empty-icon", text: "📝" });
      notePlaceholder.createDiv({
        cls: "ai-empty-title",
        text: "Brak otwartej notatki. Otwórz plik Markdown w edytorze, aby zobaczyć powiązane propozycje.",
      });
    } else if (state.activeFileProposals.length === 0) {
      const cleanPlaceholder = activeSection.createDiv({
        cls: "ai-empty-state ai-proposals-empty-note",
      });
      cleanPlaceholder.createDiv({ cls: "ai-empty-icon", text: "✅" });
      const activeFileName = state.activeFilePath.split("/").pop() ?? state.activeFilePath;
      cleanPlaceholder.createDiv({
        cls: "ai-empty-title",
        text: `Brak oczekujących propozycji dla tego pliku (${activeFileName}).`,
      });
    } else {
      for (const proposal of state.activeFileProposals) {
        this.renderProposalCard(proposal, activeSection, false);
      }
    }

    // 4. Tier 2: Remaining Vault Files Section
    const vaultSection = this.contentEl.createDiv({
      cls: "ai-tier-section ai-proposals-section-vault",
    });

    const vaultHeader = vaultSection.createDiv({ cls: "ai-tier-header" });
    const vaultTitleGroup = vaultHeader.createDiv({ cls: "ai-tier-title-group" });
    vaultTitleGroup.createSpan({ text: "🗄️ Pozostałe w skarbcu" });

    const remainingCount = state.vaultGroups.reduce(
      (sum, g) => sum + g.proposals.length,
      0
    );
    vaultHeader.createSpan({
      cls: "ai-badge",
      text: String(remainingCount),
    });

    if (state.vaultGroups.length === 0) {
      const emptyVaultRest = vaultSection.createDiv({ cls: "ai-empty-state" });
      emptyVaultRest.createDiv({
        cls: "ai-empty-title",
        text: "Brak propozycji w pozostałych plikach skarbca.",
      });
    } else {
      for (const group of state.vaultGroups) {
        this.renderFileAccordion(group, vaultSection);
      }
    }
  }

  private renderFileAccordion(
    group: FileProposalGroup,
    container: HTMLElement
  ): void {
    const isCollapsed = this.collapsedFiles.has(group.filePath);

    const accordion = container.createDiv({
      cls: `ai-file-accordion ${isCollapsed ? "is-collapsed" : ""}`,
    });

    const header = accordion.createDiv({ cls: "ai-file-header" });
    const chevron = header.createSpan({ cls: "ai-accordion-chevron" });
    chevron.textContent = isCollapsed ? "▶" : "▼";

    const titleContainer = header.createDiv({ cls: "ai-file-title" });
    titleContainer.createSpan({ cls: "ai-file-icon", text: "📄" });
    const nameSpan = titleContainer.createSpan({
      cls: "ai-file-name",
      text: group.fileName,
    });
    nameSpan.title = group.filePath;

    header.createSpan({
      cls: "ai-badge",
      text: String(group.proposals.length),
    });

    header.addEventListener("click", () => {
      if (this.collapsedFiles.has(group.filePath)) {
        this.collapsedFiles.delete(group.filePath);
        if (typeof accordion.removeClass === "function") {
          accordion.removeClass("is-collapsed");
        } else if (accordion.classList) {
          accordion.classList.remove("is-collapsed");
        }
        chevron.textContent = "▼";
      } else {
        this.collapsedFiles.add(group.filePath);
        if (typeof accordion.addClass === "function") {
          accordion.addClass("is-collapsed");
        } else if (accordion.classList) {
          accordion.classList.add("is-collapsed");
        }
        chevron.textContent = "▶";
      }
    });

    const cardsContainer = accordion.createDiv({ cls: "ai-file-cards" });
    for (const proposal of group.proposals) {
      this.renderProposalCard(proposal, cardsContainer, false);
    }
  }

  private toggleCollapseAll(): void {
    const state = this.getSidebarViewState();
    if (this.collapsedFiles.size >= state.vaultGroups.length) {
      this.collapsedFiles.clear();
    } else {
      for (const group of state.vaultGroups) {
        this.collapsedFiles.add(group.filePath);
      }
    }
    this.render();
  }

  private renderProposalCard(
    proposal: Proposal,
    container: HTMLElement,
    showFilePath: boolean
  ): HTMLElement {
    const card = container.createDiv({
      cls: "ai-proposal-card ai-proposals-card",
    });
    const targetId = proposal.compoundId ?? proposal.id;
    card.setAttribute("data-proposal-id", targetId);

    // Card click navigates to line
    card.addEventListener("click", () => {
      void this.jumpToProposal(proposal);
    });

    // 1. Header with Metadata
    const header = card.createDiv({ cls: "ai-card-header" });
    const metaLeft = header.createDiv({ cls: "ai-card-meta" });

    const ruleBadge = metaLeft.createSpan({ cls: "ai-proposal-rule-badge" });
    ruleBadge.textContent = proposal.rule || "Propozycja AI";

    const coordsBadge = metaLeft.createSpan({ cls: "ai-card-coords" });
    coordsBadge.textContent = `L${proposal.line}:${proposal.ch}`;

    if (proposal.author) {
      const authorBadge = metaLeft.createSpan({ cls: "ai-proposal-author-badge" });
      authorBadge.textContent = proposal.author;
    }

    if (proposal.timestamp) {
      const timeSpan = header.createSpan({ cls: "ai-card-time" });
      timeSpan.textContent = formatRelativeTime(proposal.timestamp);
      timeSpan.title = new Date(proposal.timestamp).toLocaleString();
    }

    // 2. File Path display
    if (showFilePath) {
      const pathEl = card.createDiv({ cls: "ai-card-filepath" });
      pathEl.title = proposal.file;
      pathEl.textContent = `📄 ${proposal.file}`;
    }

    // 3. Explanation text (safe textContent sanitization)
    if (proposal.explanation) {
      const expEl = card.createDiv({ cls: "ai-proposal-explanation" });
      expEl.textContent = proposal.explanation;
    }

    // 4. Inline Visual Diff
    try {
      const doc = this.contentEl.ownerDocument ?? (typeof document !== "undefined" ? document : null);
      if (doc) {
        const diffEl = renderDiffPreview(proposal, undefined, doc as Document);
        card.appendChild(diffEl);
      }
    } catch (err) {
      console.warn("[AI Proposals] Error rendering diff preview in card:", err);
    }

    // 5. Actions Footer
    const actions = card.createDiv({ cls: "ai-card-actions" });

    const showBtn = actions.createEl("button", {
      cls: "ai-sidebar-btn ai-btn-navigate",
      text: "Pokaż",
    }) as HTMLButtonElement;
    showBtn.title = "Przejdź do linii w dokumencie";
    showBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.jumpToProposal(proposal);
    });

    const rightActions = actions.createDiv({ cls: "ai-action-buttons-right" });

    const rejectBtn = rightActions.createEl("button", {
      cls: "ai-sidebar-btn ai-btn-reject ai-proposal-btn-reject mod-warning",
      text: "Odrzuć",
    }) as HTMLButtonElement;
    rejectBtn.title = "Odrzuć i usuń z bufora";

    const acceptBtn = rightActions.createEl("button", {
      cls: "ai-sidebar-btn ai-btn-accept ai-proposal-btn-accept mod-cta",
      text: "Zastosuj",
    }) as HTMLButtonElement;
    acceptBtn.title = "Zastosuj zmianę do pliku Markdown";

    rejectBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.handleRejectProposal(targetId, rejectBtn, card, acceptBtn, showBtn);
    });

    acceptBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.handleAcceptProposal(targetId, acceptBtn, card, rejectBtn, showBtn);
    });

    return card;
  }

  public async jumpToProposal(proposal: Proposal): Promise<void> {
    const normPath = normalizePath(proposal.file);

    let targetLeaf: WorkspaceLeaf | null = null;
    const leaves = this.app?.workspace?.getLeavesOfType?.("markdown") ?? [];

    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file && normalizePath(view.file.path) === normPath) {
        targetLeaf = leaf;
        break;
      }
    }

    const activeView = this.app?.workspace?.getActiveViewOfType?.(MarkdownView);
    const activeFile = (activeView && "file" in activeView && activeView.file)
      ? activeView.file
      : this.app?.workspace?.getActiveFile?.();
    const activePath = activeFile ? normalizePath(activeFile.path) : null;
    const isAlreadyActive = activePath === normPath;

    if (!targetLeaf && !isAlreadyActive) {
      if (this.app?.workspace?.openLinkText) {
        await this.app.workspace.openLinkText(proposal.file, "", false);
      } else {
        const targetAbstract = this.app?.vault?.getAbstractFileByPath?.(normPath);
        if (targetAbstract && targetAbstract instanceof TFile && this.app?.workspace?.getLeaf) {
          targetLeaf = this.app.workspace.getLeaf(false);
          if (targetLeaf?.openFile) {
            await targetLeaf.openFile(targetAbstract);
          }
        }
      }
    }

    if (targetLeaf && this.app?.workspace?.setActiveLeaf) {
      this.app.workspace.setActiveLeaf(targetLeaf, { focus: true });
    }

    // Prioritize targetLeaf editor, re-query active view after openLinkText, fall back to activeView
    const currentEditor =
      (targetLeaf?.view as MarkdownView | undefined)?.editor ??
      this.app?.workspace?.getActiveViewOfType?.(MarkdownView)?.editor ??
      activeView?.editor;

    if (currentEditor) {
      const targetLine = Math.max(0, proposal.line - 1);
      const fromCh = Math.max(0, proposal.ch ?? 0);
      const toCh = Math.max(fromCh, proposal.toCh ?? (fromCh + (proposal.original?.length || 0)));

      if (typeof currentEditor.setCursor === "function") {
        currentEditor.setCursor({ line: targetLine, ch: fromCh });
      }
      if (typeof currentEditor.setSelection === "function") {
        currentEditor.setSelection(
          { line: targetLine, ch: fromCh },
          { line: targetLine, ch: toCh }
        );
      }
      if (typeof currentEditor.scrollIntoView === "function") {
        currentEditor.scrollIntoView(
          {
            from: { line: targetLine, ch: fromCh },
            to: { line: targetLine, ch: toCh },
          },
          true
        );
      }
      if (typeof currentEditor.focus === "function") {
        currentEditor.focus();
      }
    }
  }

  public async handleAcceptProposal(
    targetId: string,
    acceptBtn: HTMLButtonElement,
    cardEl: HTMLElement,
    rejectBtn?: HTMLButtonElement,
    showBtn?: HTMLButtonElement
  ): Promise<void> {
    if (this.processingIds.has(targetId) || acceptBtn.disabled) {
      return;
    }
    this.processingIds.add(targetId);

    acceptBtn.disabled = true;
    if (rejectBtn) rejectBtn.disabled = true;
    if (showBtn) showBtn.disabled = true;

    if (typeof cardEl.addClass === "function") {
      cardEl.addClass("is-processing");
    } else if (cardEl.classList) {
      cardEl.classList.add("is-processing");
    }

    if (typeof acceptBtn.addClass === "function") {
      acceptBtn.addClass("is-loading");
    } else if (acceptBtn.classList) {
      acceptBtn.classList.add("is-loading");
    }

    const originalText = acceptBtn.textContent;
    acceptBtn.textContent = "Stosowanie...";
    acceptBtn.setAttribute("aria-busy", "true");

    try {
      const success = await this.store.acceptProposal(targetId);
      if (success) {
        new Notice("Zastosowano propozycję AI.");
      } else {
        new Notice("Nie udało się zastosować propozycji (tekst nie został znaleziony).");
      }
    } catch (err) {
      console.error("[AI Proposals] Błąd podczas akceptacji propozycji:", err);
      new Notice("Wystąpił nieoczekiwany błąd podczas zapisywania zmian.");
    } finally {
      this.processingIds.delete(targetId);
      const isConnected = (cardEl as unknown as { isConnected?: boolean }).isConnected ?? true;
      if (isConnected) {
        acceptBtn.disabled = false;
        if (rejectBtn) rejectBtn.disabled = false;
        if (showBtn) showBtn.disabled = false;

        if (typeof cardEl.removeClass === "function") {
          cardEl.removeClass("is-processing");
        } else if (cardEl.classList) {
          cardEl.classList.remove("is-processing");
        }

        if (typeof acceptBtn.removeClass === "function") {
          acceptBtn.removeClass("is-loading");
        } else if (acceptBtn.classList) {
          acceptBtn.classList.remove("is-loading");
        }

        acceptBtn.textContent = originalText;
        acceptBtn.removeAttribute("aria-busy");
      }
    }
  }

  public async handleRejectProposal(
    targetId: string,
    rejectBtn: HTMLButtonElement,
    cardEl: HTMLElement,
    acceptBtn?: HTMLButtonElement,
    showBtn?: HTMLButtonElement
  ): Promise<void> {
    if (this.processingIds.has(targetId) || rejectBtn.disabled) {
      return;
    }
    this.processingIds.add(targetId);

    rejectBtn.disabled = true;
    if (acceptBtn) acceptBtn.disabled = true;
    if (showBtn) showBtn.disabled = true;

    if (typeof cardEl.addClass === "function") {
      cardEl.addClass("is-processing");
    } else if (cardEl.classList) {
      cardEl.classList.add("is-processing");
    }

    if (typeof rejectBtn.addClass === "function") {
      rejectBtn.addClass("is-loading");
    } else if (rejectBtn.classList) {
      rejectBtn.classList.add("is-loading");
    }

    const originalText = rejectBtn.textContent;
    rejectBtn.textContent = "Odrzucanie...";
    rejectBtn.setAttribute("aria-busy", "true");

    try {
      const success = await this.store.rejectProposal(targetId);
      if (success) {
        new Notice("Odrzucono propozycję AI.");
      }
    } catch (err) {
      console.error("[AI Proposals] Błąd podczas odrzucania propozycji:", err);
      new Notice("Wystąpił błąd podczas odrzucania propozycji.");
    } finally {
      this.processingIds.delete(targetId);
      const isConnected = (cardEl as unknown as { isConnected?: boolean }).isConnected ?? true;
      if (isConnected) {
        rejectBtn.disabled = false;
        if (acceptBtn) acceptBtn.disabled = false;
        if (showBtn) showBtn.disabled = false;

        if (typeof cardEl.removeClass === "function") {
          cardEl.removeClass("is-processing");
        } else if (cardEl.classList) {
          cardEl.classList.remove("is-processing");
        }

        if (typeof rejectBtn.removeClass === "function") {
          rejectBtn.removeClass("is-loading");
        } else if (rejectBtn.classList) {
          rejectBtn.classList.remove("is-loading");
        }

        rejectBtn.textContent = originalText;
        rejectBtn.removeAttribute("aria-busy");
      }
    }
  }
}
