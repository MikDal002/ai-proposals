/**
 * src/editor/popover-manager.ts
 * Floating Popover UI Manager for AI Proposals Obsidian Plugin.
 *
 * Responsibilities:
 * - Render floating popover card mounted to document.body (position: fixed)
 * - Pure viewport boundary clamping math (computePopoverPosition)
 * - Diff preview with strikethrough/deletion and green additions
 * - Dispatches acceptProposal / rejectProposal mutations to IProposalStore
 * - Prevents mobile virtual keyboard collapse by preventing default pointerdown
 * - Auto-dismissal on scroll, Escape key, or outside click
 *
 * Guarantees:
 * - Zero Node.js runtime imports (no fs, path, child_process).
 * - Full cross-platform compatibility (Desktop & Mobile).
 * - Strict TypeScript with zero any.
 */

import { Notice, type App } from "obsidian";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import type { Proposal, IProposalStore } from "../types";

export interface AnchorRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width?: number;
  height?: number;
}

export interface Dimensions {
  width: number;
  height: number;
}

export interface PopoverPosition {
  top: number;
  left: number;
  placement: "top" | "bottom";
}

export interface PopoverPositionOptions {
  margin?: number;
  gap?: number;
  verticalGap?: number;
}

/**
 * Pure function: calculates clamped coordinates for a floating popover
 * relative to an anchor rectangle and viewport boundaries.
 *
 * Overload 1: Dimension objects
 * Overload 2: Flat numeric dimensions
 */
export function computePopoverPosition(
  anchor: AnchorRect,
  popover: Dimensions,
  viewport: Dimensions,
  options?: PopoverPositionOptions
): PopoverPosition;
export function computePopoverPosition(
  anchor: AnchorRect,
  popoverWidth: number,
  popoverHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  options?: PopoverPositionOptions
): PopoverPosition;
export function computePopoverPosition(
  anchor: AnchorRect,
  popoverOrWidth: Dimensions | number,
  viewportOrHeight: Dimensions | number,
  optionsOrVpWidth?: PopoverPositionOptions | number,
  rawVpHeight?: number,
  rawOptions?: PopoverPositionOptions
): PopoverPosition {
  let rawPopWidth: number;
  let rawPopHeight: number;
  let rawVpWidth: number;
  let rawVpHeightVal: number;
  let options: PopoverPositionOptions | undefined;

  if (typeof popoverOrWidth === "number") {
    rawPopWidth = popoverOrWidth;
    rawPopHeight = viewportOrHeight as number;
    rawVpWidth = optionsOrVpWidth as number;
    rawVpHeightVal = rawVpHeight as number;
    options = rawOptions;
  } else {
    rawPopWidth = popoverOrWidth.width;
    rawPopHeight = popoverOrWidth.height;
    rawVpWidth = (viewportOrHeight as Dimensions).width;
    rawVpHeightVal = (viewportOrHeight as Dimensions).height;
    options = optionsOrVpWidth as PopoverPositionOptions | undefined;
  }

  // Defensive numeric coercion: guarantee finite positive dimensions
  const popoverWidth = Number.isFinite(rawPopWidth) && rawPopWidth > 0 ? rawPopWidth : 360;
  const popoverHeight = Number.isFinite(rawPopHeight) && rawPopHeight > 0 ? rawPopHeight : 180;
  const viewportWidth = Number.isFinite(rawVpWidth) && rawVpWidth > 0 ? rawVpWidth : 1024;
  const viewportHeight = Number.isFinite(rawVpHeightVal) && rawVpHeightVal > 0 ? rawVpHeightVal : 768;

  const rawMargin = options?.margin;
  const margin = Number.isFinite(rawMargin) && rawMargin! >= 0 ? rawMargin! : 12;

  const rawGap = options?.gap ?? options?.verticalGap;
  const gap = Number.isFinite(rawGap) && rawGap! >= 0 ? rawGap! : 6;

  // Defensive anchor coercion: guarantee finite anchor coordinates
  const safeAnchor = anchor ?? { left: 0, top: 0, right: 0, bottom: 0 };
  const anchorLeft = Number.isFinite(safeAnchor.left) ? safeAnchor.left : margin;
  const anchorTop = Number.isFinite(safeAnchor.top) ? safeAnchor.top : margin;
  const anchorBottom = Number.isFinite(safeAnchor.bottom) ? safeAnchor.bottom : anchorTop;

  // 1. Horizontal Positioning & Clamping
  let left = anchorLeft;

  // Clamp right edge overflow
  if (left + popoverWidth > viewportWidth - margin) {
    left = viewportWidth - popoverWidth - margin;
  }

  // Clamp left edge underflow
  if (left < margin) {
    left = margin;
  }

  // 2. Vertical Placement & Flipping
  const spaceBelow = viewportHeight - anchorBottom - gap - margin;
  const spaceAbove = anchorTop - gap - margin;

  let top: number;
  let placement: "top" | "bottom";

  if (spaceBelow >= popoverHeight) {
    top = anchorBottom + gap;
    placement = "bottom";
  } else if (spaceAbove >= popoverHeight) {
    top = anchorTop - popoverHeight - gap;
    placement = "top";
  } else {
    // Constrained space on both sides: pick side with greater clearance
    if (spaceBelow >= spaceAbove) {
      top = Math.max(margin, Math.min(anchorBottom + gap, viewportHeight - popoverHeight - margin));
      placement = "bottom";
    } else {
      top = Math.max(margin, anchorTop - popoverHeight - gap);
      placement = "top";
    }
  }

  // Ceil top coordinate to margin to guarantee no ceiling overflow
  top = Math.max(margin, top);

  return { top, left, placement };
}

/**
 * Formats multi-line text by inserting visible newline glyphs.
 * Uses doc.createTextNode to guarantee 100% XSS sanitization.
 */
export function formatDiffFragment(text: string, doc: Document): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    fragment.appendChild(doc.createTextNode(lines[i]));
    if (i < lines.length - 1) {
      const nlSpan = doc.createElement("span");
      nlSpan.className = "ai-proposal-diff-newline";
      nlSpan.textContent = "↵";
      fragment.appendChild(nlSpan);
      fragment.appendChild(doc.createTextNode("\n"));
    }
  }

  return fragment;
}

/**
 * Pure diff preview generator.
 * Creates deletion (<del>) and addition (<ins>) visual elements.
 */
export function renderDiffPreview(
  proposal: Proposal,
  containerEl?: HTMLElement,
  doc?: Document
): HTMLElement {
  const documentContext = doc ?? (containerEl?.ownerDocument ?? (typeof document !== "undefined" ? document : null));
  if (!documentContext) {
    throw new Error("[AI Proposals] DOM Document not available for diff preview rendering.");
  }

  const container = containerEl ?? documentContext.createElement("div");
  container.className = "ai-proposal-diff ai-popover-diff";

  // 1. Deletion / Original row
  const delRow = documentContext.createElement("div");
  delRow.className = "ai-proposal-diff-row ai-proposal-diff-deletion";

  const delLabel = documentContext.createElement("span");
  delLabel.className = "ai-proposal-diff-label";
  delLabel.textContent = "Przed:";
  delRow.appendChild(delLabel);

  if (proposal.original.length > 0) {
    const delEl = documentContext.createElement("del");
    delEl.className = "ai-diff-del ai-proposal-deletion ai-proposal-diff-deletion";
    delEl.appendChild(formatDiffFragment(proposal.original, documentContext));
    delRow.appendChild(delEl);
  } else {
    const emptyNote = documentContext.createElement("span");
    emptyNote.className = "ai-proposal-empty-note";
    emptyNote.textContent = "(puste / dodanie)";
    delRow.appendChild(emptyNote);
  }
  container.appendChild(delRow);

  // 2. Addition / Replacement row
  const addRow = documentContext.createElement("div");
  addRow.className = "ai-proposal-diff-row ai-proposal-diff-addition";

  const addLabel = documentContext.createElement("span");
  addLabel.className = "ai-proposal-diff-label";
  addLabel.textContent = "Po:";
  addRow.appendChild(addLabel);

  if (proposal.replacement.length > 0) {
    const addEl = documentContext.createElement("ins");
    addEl.className = "ai-diff-add ai-diff-ins ai-proposal-addition ai-proposal-diff-addition";
    addEl.appendChild(formatDiffFragment(proposal.replacement, documentContext));
    addRow.appendChild(addEl);
  } else {
    const emptyNote = documentContext.createElement("span");
    emptyNote.className = "ai-proposal-empty-note";
    emptyNote.textContent = "(usunięcie tekstu)";
    addRow.appendChild(emptyNote);
  }
  container.appendChild(addRow);

  return container;
}

/**
 * Singleton Popover Manager.
 * Controls mounting, positioning, and lifecycle of the floating proposal action card.
 */
export class PopoverManager {
  private activePopoverEl: HTMLElement | null = null;
  private activeProposal: Proposal | null = null;
  private activeAnchorEl: HTMLElement | null = null;
  private activeView: EditorView | null = null;
  private cleanupListeners: Array<() => void> = [];
  private unsubscribeStore: (() => void) | null = null;
  private store: IProposalStore;
  private app?: App;
  private isMutating = false;

  constructor(storeOrApp: IProposalStore | App, storeOrNothing?: IProposalStore) {
    if (storeOrNothing) {
      this.app = storeOrApp as App;
      this.store = storeOrNothing;
    } else {
      this.store = storeOrApp as IProposalStore;
    }

    // Auto-dismiss if currently viewed proposal changes status externally
    this.unsubscribeStore = this.store.onStoreChange(() => {
      if (this.activeProposal) {
        const targetId = this.activeProposal.compoundId ?? this.activeProposal.id;
        const allPending = this.store.getAllProposals();
        const stillPending = allPending.some(
          (p) => (p.compoundId ?? p.id) === targetId && p.status === "pending"
        );
        if (!stillPending) {
          this.hide();
        }
      }
    });
  }

  public isOpen(): boolean {
    return this.activePopoverEl !== null;
  }

  public getActiveProposal(): Proposal | null {
    return this.activeProposal;
  }

  public getApp(): App | undefined {
    return this.app;
  }

  /**
   * Shows floating popover anchored to an element or bounding rectangle.
   */
  public show(proposal: Proposal, anchor: AnchorRect | HTMLElement, view?: EditorView): void {
    const targetId = proposal.compoundId ?? proposal.id;
    const currentId = this.activeProposal ? (this.activeProposal.compoundId ?? this.activeProposal.id) : null;

    if (currentId === targetId && this.activePopoverEl) {
      // Re-position if same proposal clicked
      this.reposition(anchor);
      return;
    }

    // Dismiss any previously open popover
    this.hide();

    this.activeProposal = proposal;
    this.activeView = view ?? null;
    if (anchor instanceof HTMLElement) {
      this.activeAnchorEl = anchor;
    } else {
      this.activeAnchorEl = null;
    }

    const doc = typeof document !== "undefined" ? document : null;
    if (!doc) return;

    const popoverEl = this.buildPopoverDOM(proposal, doc);
    this.activePopoverEl = popoverEl;

    doc.body.appendChild(popoverEl);

    // Calculate clamped coordinates after insertion
    this.reposition(anchor);

    // Register click-outside, Escape, and scroll listeners
    this.registerEventListeners(popoverEl, view, doc);
  }

  /**
   * Repositions active popover relative to current or specified anchor.
   */
  public reposition(anchor?: AnchorRect | HTMLElement): void {
    if (!this.activePopoverEl) return;

    let anchorRect: AnchorRect;
    if (anchor instanceof HTMLElement) {
      anchorRect = anchor.getBoundingClientRect();
    } else if (anchor) {
      anchorRect = anchor;
    } else if (this.activeAnchorEl) {
      anchorRect = this.activeAnchorEl.getBoundingClientRect();
    } else {
      return;
    }

    const popoverRect = this.activePopoverEl.getBoundingClientRect();
    const viewport: Dimensions = {
      width: typeof window !== "undefined" ? window.innerWidth : 1024,
      height: typeof window !== "undefined" ? window.innerHeight : 768,
    };

    const pos = computePopoverPosition(
      anchorRect,
      {
        width: popoverRect.width || 360,
        height: popoverRect.height || 180,
      },
      viewport
    );

    this.activePopoverEl.style.top = `${pos.top}px`;
    this.activePopoverEl.style.left = `${pos.left}px`;
  }

  /**
   * Responds to CodeMirror viewport scrolling and document edits.
   */
  public onEditorUpdate(update: ViewUpdate): void {
    if (this.activePopoverEl && (update.viewportChanged || update.docChanged)) {
      this.hide();
    }
  }

  /**
   * Hides and destroys the active floating popover.
   */
  public hide(): void {
    for (const cleanup of this.cleanupListeners) {
      cleanup();
    }
    this.cleanupListeners = [];

    if (this.activePopoverEl) {
      this.activePopoverEl.remove();
      this.activePopoverEl = null;
    }

    this.activeProposal = null;
    this.activeAnchorEl = null;
    this.activeView = null;
    this.isMutating = false;
  }

  /**
   * Alias for hide().
   */
  public close(): void {
    this.hide();
  }

  /**
   * Unregisters listeners and cleans up on plugin unload.
   */
  public dispose(): void {
    this.hide();
    if (this.unsubscribeStore) {
      this.unsubscribeStore();
      this.unsubscribeStore = null;
    }
  }

  /**
   * Alias for dispose().
   */
  public destroy(): void {
    this.dispose();
  }

  // --- Internal DOM Construction & Event Handling ---

  private buildPopoverDOM(proposal: Proposal, doc: Document): HTMLElement {
    const root = doc.createElement("div");
    root.className = "ai-proposal-popover";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "AI Proposal Details");

    // Prevent popover pointer events from stealing editor focus on desktop/mobile
    root.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
    });

    // 1. Header row
    const header = doc.createElement("div");
    header.className = "ai-proposal-popover-header ai-popover-header";

    const meta = doc.createElement("div");
    meta.className = "ai-proposal-meta";

    const ruleBadge = doc.createElement("span");
    ruleBadge.className = "ai-proposal-rule-badge ai-popover-title";
    ruleBadge.textContent = proposal.rule || "Propozycja AI";
    meta.appendChild(ruleBadge);

    if (proposal.author) {
      const authorBadge = doc.createElement("span");
      authorBadge.className = "ai-proposal-author-badge";
      authorBadge.textContent = proposal.author;
      meta.appendChild(authorBadge);
    }
    header.appendChild(meta);

    const closeBtn = doc.createElement("button");
    closeBtn.className = "ai-proposal-btn-close";
    closeBtn.setAttribute("aria-label", "Zamknij");
    closeBtn.setAttribute("title", "Zamknij");
    closeBtn.innerHTML = `<svg class="ai-proposal-icon" viewBox="0 0 24 24" width="14" height="14"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
    this.preventMobileBlur(closeBtn);
    closeBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.hide();
      this.activeView?.focus();
    });
    header.appendChild(closeBtn);
    root.appendChild(header);

    // 2. Explanation / Rationale
    if (proposal.explanation) {
      const explanationEl = doc.createElement("div");
      explanationEl.className = "ai-proposal-explanation ai-popover-explanation";
      explanationEl.textContent = proposal.explanation;
      root.appendChild(explanationEl);
    }

    // 3. Diff Container
    const diffContainer = renderDiffPreview(proposal, undefined, doc);
    root.appendChild(diffContainer);

    // 4. Action Buttons Footer
    const actions = doc.createElement("div");
    actions.className = "ai-proposal-actions ai-popover-actions";

    const rejectBtn = doc.createElement("button");
    rejectBtn.className = "ai-proposal-btn-reject ai-btn-reject mod-warning";
    rejectBtn.textContent = "Odrzuć";
    this.preventMobileBlur(rejectBtn);

    const acceptBtn = doc.createElement("button");
    acceptBtn.className = "ai-proposal-btn-accept ai-btn-accept mod-cta";
    acceptBtn.textContent = "Zastosuj";
    this.preventMobileBlur(acceptBtn);

    rejectBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await this.handleReject(proposal, rejectBtn, acceptBtn);
    });

    acceptBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await this.handleAccept(proposal, acceptBtn, rejectBtn);
    });

    actions.appendChild(rejectBtn);
    actions.appendChild(acceptBtn);
    root.appendChild(actions);

    return root;
  }

  /**
   * Prevents soft keyboard collapse and focus stealing from the editor
   * without canceling synthetic click events under W3C Touch Events specification.
   */
  private preventMobileBlur(buttonEl: HTMLElement): void {
    buttonEl.addEventListener("pointerdown", (evt) => {
      evt.preventDefault();
    });
    buttonEl.addEventListener("mousedown", (evt) => {
      evt.preventDefault();
    });
  }

  private async handleAccept(
    proposal: Proposal,
    acceptBtn: HTMLButtonElement,
    rejectBtn: HTMLButtonElement
  ): Promise<void> {
    if (this.isMutating || acceptBtn.disabled || rejectBtn.disabled) {
      return;
    }
    this.isMutating = true;
    acceptBtn.disabled = true;
    rejectBtn.disabled = true;
    acceptBtn.classList.add("is-loading");
    acceptBtn.textContent = "Stosowanie...";

    const targetId = proposal.compoundId ?? proposal.id;
    try {
      const success = await this.store.acceptProposal(targetId);
      if (success) {
        new Notice("Zastosowano propozycję.");
      } else {
        new Notice("Nie udało się zastosować propozycji.");
      }
    } catch (err) {
      console.error("[AI Proposals] Error accepting proposal:", err);
      new Notice("Błąd podczas akceptowania propozycji.");
    } finally {
      this.isMutating = false;
      this.hide();
      this.activeView?.focus();
    }
  }

  private async handleReject(
    proposal: Proposal,
    rejectBtn: HTMLButtonElement,
    acceptBtn: HTMLButtonElement
  ): Promise<void> {
    if (this.isMutating || acceptBtn.disabled || rejectBtn.disabled) {
      return;
    }
    this.isMutating = true;
    acceptBtn.disabled = true;
    rejectBtn.disabled = true;
    rejectBtn.classList.add("is-loading");

    const targetId = proposal.compoundId ?? proposal.id;
    try {
      const success = await this.store.rejectProposal(targetId);
      if (success) {
        new Notice("Odrzucono propozycję.");
      }
    } catch (err) {
      console.error("[AI Proposals] Error rejecting proposal:", err);
      new Notice("Błąd podczas odrzucania propozycji.");
    } finally {
      this.isMutating = false;
      this.hide();
      this.activeView?.focus();
    }
  }

  private registerEventListeners(
    popoverEl: HTMLElement,
    view: EditorView | undefined,
    doc: Document
  ): void {
    // 1. Outside pointerdown click listener
    const onOutsidePointerDown = (evt: PointerEvent): void => {
      const target = evt.target as HTMLElement | null;
      if (!target) return;
      if (
        !popoverEl.contains(target) &&
        !target.closest(".ai-proposal-mark") &&
        !target.closest(".ai-proposal-decoration") &&
        !target.closest(".ai-proposal-highlight") &&
        !target.closest(".ai-proposal-mark-zero") &&
        !target.closest(".ai-proposal-insertion-marker") &&
        !target.closest(".ai-proposal-insertion-anchor")
      ) {
        this.hide();
      }
    };
    doc.addEventListener("pointerdown", onOutsidePointerDown, true);
    this.cleanupListeners.push(() => doc.removeEventListener("pointerdown", onOutsidePointerDown, true));

    // 2. Escape key listener
    const onKeyDown = (evt: KeyboardEvent): void => {
      if (evt.key === "Escape") {
        evt.preventDefault();
        this.hide();
        this.activeView?.focus();
      }
    };
    doc.addEventListener("keydown", onKeyDown);
    this.cleanupListeners.push(() => doc.removeEventListener("keydown", onKeyDown));

    // 3. Scroll listener on editor
    if (view && view.scrollDOM) {
      const onScroll = (): void => {
        this.hide();
      };
      view.scrollDOM.addEventListener("scroll", onScroll, { passive: true, once: true });
      this.cleanupListeners.push(() => view.scrollDOM.removeEventListener("scroll", onScroll));
    }
  }
}
