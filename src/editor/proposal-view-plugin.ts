/**
 * src/editor/proposal-view-plugin.ts
 * CodeMirror 6 ViewPlugin & Decoration Engine for AI Proposals Obsidian Plugin.
 *
 * Responsibilities:
 * - Render inline wavy highlights (.ai-proposal-mark) for replacement proposals
 * - Render zero-length insertion markers (.ai-proposal-mark-zero) using Decoration.widget
 * - Strict monotonic range ordering & overlap collision suppression
 * - Dynamic auto-snap & neighborhood anchor recovery
 * - Leaf isolation via Obsidian editorInfoField
 * - Reactive store updates via StateEffect dispatch
 *
 * Guarantees:
 * - Zero Node.js runtime imports (no fs, path, child_process).
 * - Full cross-platform compatibility (Desktop & Mobile).
 * - Strict TypeScript with zero any.
 */

import {
  EditorView,
  ViewPlugin,
  ViewUpdate,
  Decoration,
  DecorationSet,
  WidgetType,
  PluginValue,
  type PluginSpec,
} from "@codemirror/view";
import { RangeSetBuilder, StateEffect, Text, type Extension } from "@codemirror/state";
import { editorInfoField } from "obsidian";
import type { IProposalStore, Proposal } from "../types";
import { findClosestOccurrence, findInNeighborhood } from "../store/coordinate-math";
import type { PopoverManager } from "./popover-manager";

/**
 * StateEffect dispatched to force recalculation of proposal decorations
 * when the external IProposalStore triggers an onStoreChange event.
 */
export const refreshProposalsEffect = StateEffect.define<void>();
export const updateProposalsEffect = refreshProposalsEffect;

export interface ResolvedProposalRange {
  from: number;
  to: number;
  proposal: Proposal;
  isExact: boolean;
}

/**
 * Safely resolves proposal line and column coordinates into absolute CM6 document offsets.
 * Fallback chain:
 *   Tier 1: Exact coordinates on target line
 *   Tier 2: Intra-line auto-snap on target line
 *   Tier 3: Inter-line neighborhood scanning (+/- radius lines)
 *   Tier 4: Skip proposal if not found
 */
export function resolveProposalRange(
  doc: Text,
  proposal: Proposal,
  radius = 5
): ResolvedProposalRange | null {
  const totalLines = doc.lines;
  if (totalLines === 0) {
    return null;
  }

  // --- Strict Numeric Validation: Target Line ---
  // Guards against NaN, +/-Infinity, non-integers (e.g. 1.5), and out-of-bounds coordinates
  if (
    !Number.isInteger(proposal.line) ||
    proposal.line < 1 ||
    proposal.line > totalLines
  ) {
    return null;
  }

  const original = proposal.original ?? "";
  const isPureInsertion = original.length === 0;
  const rawFromCh = proposal.ch ?? proposal.from_ch ?? 0;
  const rawToCh = proposal.toCh ?? proposal.to_ch ?? (rawFromCh + original.length);

  // Normalize column offsets to safe integers or null if NaN
  const fromCh = typeof rawFromCh === "number" && Number.isInteger(rawFromCh) ? rawFromCh : NaN;
  const toCh = typeof rawToCh === "number" && Number.isInteger(rawToCh) ? rawToCh : NaN;

  // --- Case A: Pure Insertion (Zero-Length) ---
  if (isPureInsertion) {
    // Pure insertion requires a valid, finite integer column within [0, lineObj.length]
    if (Number.isNaN(fromCh)) {
      return null;
    }

    const lineObj = doc.line(proposal.line);
    if (fromCh < 0 || fromCh > lineObj.length) {
      return null;
    }

    const absOffset = lineObj.from + fromCh;
    return {
      from: absOffset,
      to: absOffset,
      proposal,
      isExact: true,
    };
  }

  // --- Case B: Replacement / Deletion (original.length > 0) ---
  const lineObj = doc.line(proposal.line);
  const lineText = lineObj.text;

  // Tier 1: Exact match at column bounds (requires valid integer fromCh and toCh)
  if (
    !Number.isNaN(fromCh) &&
    !Number.isNaN(toCh) &&
    fromCh >= 0 &&
    toCh <= lineText.length &&
    fromCh <= toCh &&
    lineText.substring(fromCh, toCh) === original
  ) {
    return {
      from: lineObj.from + fromCh,
      to: lineObj.from + toCh,
      proposal,
      isExact: true,
    };
  }

  // Tier 2: Intra-line auto-snap (fallback expectedCh to 0 if NaN)
  const safeIntraCh = Number.isNaN(fromCh) || fromCh < 0 ? 0 : fromCh;
  const intraMatch = findClosestOccurrence(lineText, original, safeIntraCh);
  if (intraMatch !== -1) {
    return {
      from: lineObj.from + intraMatch,
      to: lineObj.from + intraMatch + original.length,
      proposal,
      isExact: false,
    };
  }

  // Tier 3: Scan neighborhood (+/- radius lines)
  const safeRadius = Number.isInteger(radius) && radius >= 0 ? radius : 5;
  const docLines: string[] = [];
  for (let l = 1; l <= totalLines; l++) {
    docLines.push(doc.line(l).text);
  }

  const snapped = findInNeighborhood(
    docLines,
    original,
    proposal.line,
    safeIntraCh,
    safeRadius
  );

  if (
    snapped &&
    Number.isInteger(snapped.line) &&
    snapped.line >= 1 &&
    snapped.line <= totalLines
  ) {
    const matchedLineObj = doc.line(snapped.line);
    const matchedCh = Number.isInteger(snapped.ch) && snapped.ch >= 0 && snapped.ch <= matchedLineObj.length
      ? snapped.ch
      : 0;
    return {
      from: matchedLineObj.from + matchedCh,
      to: matchedLineObj.from + matchedCh + original.length,
      proposal,
      isExact: false,
    };
  }

  // Tier 4: Text could not be located -> skip decoration
  return null;
}

/**
 * Pure builder function: constructs a CodeMirror 6 DecorationSet for proposals.
 * Pre-sorts ranges monotonically and resolves interval/point collisions.
 */
export function buildProposalDecorations(
  doc: Text,
  proposals: Proposal[],
  targetFilePath?: string,
  radius = 5
): DecorationSet {
  if (!proposals || proposals.length === 0) {
    return Decoration.none;
  }

  // Filter proposals for active file if specified
  const filteredProposals = targetFilePath
    ? proposals.filter((p) => p.file === targetFilePath && p.status === "pending")
    : proposals.filter((p) => p.status === "pending");

  if (filteredProposals.length === 0) {
    return Decoration.none;
  }

  const resolvedList: ResolvedProposalRange[] = [];
  for (const proposal of filteredProposals) {
    const resolved = resolveProposalRange(doc, proposal, radius);
    if (resolved) {
      resolvedList.push(resolved);
    }
  }

  if (resolvedList.length === 0) {
    return Decoration.none;
  }

  // Strict monotonic sort: ascending by 'from', then ascending by 'to'
  resolvedList.sort((a, b) => {
    if (a.from !== b.from) {
      return a.from - b.from;
    }
    return a.to - b.to;
  });

  const builder = new RangeSetBuilder<Decoration>();
  let lastTo = -1;
  let lastZeroPos = -1;

  for (const item of resolvedList) {
    const isZero = item.from === item.to;

    // Interval collision: candidate starts before previous mark ends
    if (item.from < lastTo) {
      continue;
    }

    // Duplicate pure insertion collision: two widgets at exact same character offset
    if (isZero && item.from === lastZeroPos) {
      continue;
    }

    if (isZero) {
      // Zero-length pure insertion widget
      builder.add(
        item.from,
        item.to,
        Decoration.widget({
          widget: new ProposalInsertionWidget(item.proposal),
          side: 1,
        })
      );
      lastZeroPos = item.from;
    } else {
      // Replacement / deletion inline mark decoration
      const classNames = [
        "ai-proposal-mark",
        "ai-proposal-decoration",
        "ai-proposal-highlight",
      ];
      if (!item.isExact) {
        classNames.push("ai-proposal-mismatch", "ai-mismatch");
      }

      builder.add(
        item.from,
        item.to,
        Decoration.mark({
          class: classNames.join(" "),
          attributes: {
            "data-proposal-id": item.proposal.compoundId ?? item.proposal.id,
          },
        })
      );
      lastTo = item.to;
      lastZeroPos = -1;
    }
  }

  return builder.finish();
}

/**
 * Custom WidgetType for pure zero-length insertions (from === to).
 * Renders an inline insertion anchor without crashing CM6 with mark RangeErrors.
 */
export class ProposalInsertionWidget extends WidgetType {
  constructor(public readonly proposal: Proposal) {
    super();
  }

  public eq(other: ProposalInsertionWidget): boolean {
    return (
      (other.proposal.compoundId ?? other.proposal.id) === (this.proposal.compoundId ?? this.proposal.id) &&
      other.proposal.replacement === this.proposal.replacement &&
      other.proposal.status === this.proposal.status
    );
  }

  public toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className =
      "ai-proposal-insertion-marker ai-proposal-mark-zero ai-proposal-insertion-anchor";
    span.setAttribute(
      "data-proposal-id",
      this.proposal.compoundId ?? this.proposal.id
    );
    span.title = `AI Proposal: Insert "${this.proposal.replacement.slice(0, 30)}${
      this.proposal.replacement.length > 30 ? "..." : ""
    }"`;

    const caret = document.createElement("span");
    caret.className = "ai-proposal-insertion-caret";
    caret.textContent = "‸";
    span.appendChild(caret);

    return span;
  }

  public ignoreEvent(): boolean {
    return false;
  }
}

/**
 * Backward compatibility alias for ProposalInsertionWidget.
 */
export const InsertionPointWidget = ProposalInsertionWidget;

/**
 * PluginValue maintaining cached DecorationSet and reacting to document/store changes.
 */
export class ProposalPluginValue implements PluginValue {
  public decorations: DecorationSet = Decoration.none;
  private unsubscribeStore: (() => void) | null = null;
  private isDestroyed = false;

  constructor(
    private readonly view: EditorView,
    private readonly store: IProposalStore
  ) {
    this.decorations = this.buildDecorations(view);

    // Subscribe to external store changes
    this.unsubscribeStore = this.store.onStoreChange(() => {
      if (this.isDestroyed) return;

      // Defer to microtask to prevent re-entrant dispatch collision
      queueMicrotask(() => {
        if (this.isDestroyed) return;
        try {
          this.view.dispatch({
            effects: refreshProposalsEffect.of(),
          });
        } catch (err) {
          console.warn("[AI Proposals] Failed to dispatch refresh effect:", err);
        }
      });
    });
  }

  public update(update: ViewUpdate): void {
    const hasRefreshEffect = update.transactions.some((tr) =>
      tr.effects.some((e) => e.is(refreshProposalsEffect))
    );

    if (update.docChanged || update.viewportChanged || hasRefreshEffect) {
      this.decorations = this.buildDecorations(update.view);
    }
  }

  public destroy(): void {
    this.isDestroyed = true;
    if (this.unsubscribeStore) {
      this.unsubscribeStore();
      this.unsubscribeStore = null;
    }
    this.decorations = Decoration.none;
  }

  public buildDecorations(view: EditorView): DecorationSet {
    // Resolve active file from Obsidian editorInfoField
    const info = view.state.field(editorInfoField, false);
    if (!info || !info.file || (info.file.extension && info.file.extension !== "md")) {
      return Decoration.none;
    }

    const targetFilePath = info.file.path;
    const proposals = this.store.getProposalsForFile(targetFilePath);

    return buildProposalDecorations(view.state.doc, proposals, targetFilePath);
  }
}

/**
 * Creates the complete CodeMirror 6 extension for AI Proposals.
 */
export function createProposalViewPlugin(
  store: IProposalStore,
  popoverManager?: PopoverManager
): Extension {
  const pluginSpec: PluginSpec<ProposalPluginValue> = {
    decorations: (val) => val.decorations,
    eventHandlers: {
      click: (event: MouseEvent, view: EditorView) => {
        const target = event.target as HTMLElement | null;
        const decorationEl = target?.closest<HTMLElement>(
          ".ai-proposal-mark, .ai-proposal-decoration, .ai-proposal-highlight, .ai-proposal-insertion-marker, .ai-proposal-mark-zero, .ai-proposal-insertion-anchor"
        );
        if (!decorationEl) return;

        event.preventDefault();
        event.stopPropagation();

        const proposalId = decorationEl.getAttribute("data-proposal-id");
        if (!proposalId) return;

        const proposal =
          store.getProposalById(proposalId) ??
          store.getAllProposals().find((p) => (p.compoundId ?? p.id) === proposalId);

        if (!proposal) return;

        popoverManager?.show(proposal, decorationEl, view);
      },
    },
  };

  const proposalPlugin = ViewPlugin.fromClass(
    class extends ProposalPluginValue {
      constructor(view: EditorView) {
        super(view, store);
      }
    },
    pluginSpec
  );

  const updateListener = EditorView.updateListener.of((update) => {
    popoverManager?.onEditorUpdate(update);
  });

  return [proposalPlugin, updateListener];
}
