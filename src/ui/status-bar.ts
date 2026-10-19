/**
 * src/ui/status-bar.ts
 * Status Bar Item and Reactive Proposal Counter for AI Proposals Obsidian Plugin.
 *
 * Guarantees:
 * - Mobile Safety: ZERO Node.js runtime imports (no fs, path, child_process).
 * - Safe no-op on mobile devices (Platform.isMobile).
 * - Polish grammar pluralization engine for proposal count badge.
 * - Reactive update on store mutations.
 * - Clean disposal on unmount.
 */

import { Platform } from "obsidian";
import type { IProposalStore } from "../types";
import type AIProposalsPlugin from "../main";

export interface IStatusBarController {
  update(): void;
  updateCount?(count: number): void;
  dispose(): void;
  getElement(): HTMLElement | null;
}

/**
 * Returns grammatically correct Polish proposal count badge text.
 */
export function formatProposalBadgeText(count: number): string {
  if (count === 0) {
    return "✨ 0";
  }
  if (count === 1) {
    return "✨ 1 propozycja";
  }

  const mod10 = count % 10;
  const mod100 = count % 100;

  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) {
    return `✨ ${count} propozycje`;
  }
  return `✨ ${count} propozycji`;
}

export class ProposalStatusBarItem implements IStatusBarController {
  private statusBarEl: HTMLElement | null = null;
  private unsubscribeStore: (() => void) | null = null;
  private clickHandler: ((evt: MouseEvent) => void) | null = null;

  constructor(
    private readonly plugin: AIProposalsPlugin,
    private readonly store?: IProposalStore
  ) {
    if (Platform.isMobile) {
      return;
    }
    this.initialize();
  }

  public initialize(): void {
    if (Platform.isMobile) {
      return;
    }
    if (this.statusBarEl) {
      return;
    }

    try {
      this.statusBarEl = this.plugin?.addStatusBarItem?.();
    } catch (err) {
      console.warn("[AI Proposals] Failed to create status bar item:", err);
      return;
    }

    if (!this.statusBarEl) {
      return;
    }

    this.initDOM();
    this.subscribe();
    this.update();
  }

  private initDOM(): void {
    if (!this.statusBarEl) return;

    if (typeof this.statusBarEl.addClass === "function") {
      this.statusBarEl.addClass("ai-proposals-status-bar", "mod-clickable");
    } else if (this.statusBarEl.classList) {
      this.statusBarEl.classList.add("ai-proposals-status-bar", "mod-clickable");
    }

    if (typeof this.statusBarEl.setAttribute === "function") {
      this.statusBarEl.setAttribute("role", "button");
      this.statusBarEl.setAttribute("tabindex", "0");
      this.statusBarEl.setAttribute("aria-label", "Propozycje AI: kliknij, aby otworzyć panel");
    }

    this.clickHandler = async (evt: MouseEvent) => {
      evt.preventDefault();
      evt.stopPropagation();
      if (this.plugin?.activateSidebarLeaf) {
        await this.plugin.activateSidebarLeaf();
      }
    };

    if (typeof this.statusBarEl.addEventListener === "function") {
      this.statusBarEl.addEventListener("click", this.clickHandler);
    }
  }

  private subscribe(): void {
    if (this.store?.onStoreChange) {
      this.unsubscribeStore = this.store.onStoreChange(() => {
        this.update();
      });
    }
  }

  public update(): void {
    if (!this.statusBarEl) return;

    const isVisible =
      this.plugin?.settings?.showStatusBarCounter ??
      this.plugin?.settings?.showStatusBarBadge ??
      true;

    if (!isVisible) {
      if (this.statusBarEl.style) {
        this.statusBarEl.style.display = "none";
      }
      return;
    }

    if (this.statusBarEl.style) {
      this.statusBarEl.style.display = "";
    }

    const proposals = this.store?.getAllProposals?.() ?? [];
    const pendingProposals = proposals.filter((p) => p.status === "pending");
    const count = pendingProposals.length;
    const text = formatProposalBadgeText(count);

    if (typeof this.statusBarEl.setText === "function") {
      this.statusBarEl.setText(text);
    } else {
      this.statusBarEl.textContent = text;
    }

    this.toggleClasses(count > 0);

    if (count > 0) {
      this.setTooltip(`AI Proposals: ${count} oczekujących propozycji (kliknij, aby otworzyć panel)`);
    } else {
      this.setTooltip("AI Proposals: brak oczekujących propozycji");
    }
  }

  public updateCount(count: number): void {
    if (!this.statusBarEl) return;

    const isVisible =
      this.plugin?.settings?.showStatusBarCounter ??
      this.plugin?.settings?.showStatusBarBadge ??
      true;

    if (!isVisible) {
      if (this.statusBarEl.style) {
        this.statusBarEl.style.display = "none";
      }
      return;
    }

    if (this.statusBarEl.style) {
      this.statusBarEl.style.display = "";
    }

    const text = `✨ AI: ${count}`;
    if (typeof this.statusBarEl.setText === "function") {
      this.statusBarEl.setText(text);
    } else {
      this.statusBarEl.textContent = text;
    }

    this.toggleClasses(count > 0);
  }

  private toggleClasses(hasProposals: boolean): void {
    if (!this.statusBarEl) return;

    if (typeof this.statusBarEl.addClass === "function") {
      if (hasProposals) {
        this.statusBarEl.addClass("has-proposals");
        this.statusBarEl.removeClass("no-proposals");
      } else {
        this.statusBarEl.removeClass("has-proposals");
        this.statusBarEl.addClass("no-proposals");
      }
    } else if (this.statusBarEl.classList) {
      if (hasProposals) {
        this.statusBarEl.classList.add("has-proposals");
        this.statusBarEl.classList.remove("no-proposals");
      } else {
        this.statusBarEl.classList.remove("has-proposals");
        this.statusBarEl.classList.add("no-proposals");
      }
    }
  }

  private setTooltip(titleText: string): void {
    if (!this.statusBarEl) return;
    if (typeof this.statusBarEl.setAttribute === "function") {
      this.statusBarEl.setAttribute("title", titleText);
    }
  }

  public getElement(): HTMLElement | null {
    return this.statusBarEl;
  }

  public dispose(): void {
    if (this.unsubscribeStore) {
      this.unsubscribeStore();
      this.unsubscribeStore = null;
    }

    if (this.statusBarEl && this.clickHandler) {
      if (typeof this.statusBarEl.removeEventListener === "function") {
        this.statusBarEl.removeEventListener("click", this.clickHandler);
      }
      this.clickHandler = null;
    }

    if (this.statusBarEl) {
      if (typeof this.statusBarEl.remove === "function") {
        this.statusBarEl.remove();
      }
      this.statusBarEl = null;
    }
  }
}

export { ProposalStatusBarItem as AIProposalStatusBar };
