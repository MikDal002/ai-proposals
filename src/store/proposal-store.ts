/**
 * src/store/proposal-store.ts
 * Reactive proposal store and atomic mutation engine for AI Proposals Obsidian Plugin.
 *
 * Guarantees:
 * - Mobile Safe: ZERO Node.js runtime imports (no fs, path, child_process). 100% Obsidian public API.
 * - Anti-Loop: 350ms write-lock debounce and event suppression mechanism.
 * - Anti-Crash: Fault-tolerant parsing of varied agent JSON envelopes and corrupted buffers.
 * - Atomic Multi-file Mutations: Note patching, coordinate shifting, and buffer updates.
 */

import {
  TFile,
  TAbstractFile,
  normalizePath,
  Notice,
  type App,
  type EventRef,
} from "obsidian";
import type {
  IProposalStore,
  Proposal,
  RawProposalItem,
  ProposalStoreState,
  StoreChangeListener,
  AIProposalsSettings,
} from "../types";
import { DEFAULT_SETTINGS } from "../types";
import {
  findClosestOccurrence,
  shiftProposalsAfterAcceptance,
  hasIntervalCollision,
} from "./coordinate-math";

/**
 * Checks if a filename matches a wildcard glob pattern (e.g. "ai_suggestion-*.json").
 */
export function matchesBufferPattern(fileName: string, pattern: string): boolean {
  if (!pattern || !fileName) return false;
  if (pattern === fileName) return true;

  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");

  return new RegExp(`^${escaped}$`, "i").test(fileName);
}

/**
 * Extracts raw proposal items from any JSON envelope structure.
 * Supports:
 * - Flat arrays: [ { ... } ]
 * - Object wrapper with proposals: { proposals: [ ... ] }
 * - Object wrapper with suggestions: { suggestions: [ ... ] }
 * - Single proposal object: { file: "...", original: "..." }
 * - File-keyed dictionary map: { "path/to/note.md": [ ... ] }
 */
export function extractRawItems(parsedJson: unknown): RawProposalItem[] {
  if (!parsedJson || typeof parsedJson !== "object") {
    return [];
  }

  // 1. Flat array
  if (Array.isArray(parsedJson)) {
    return parsedJson.filter(isRecord);
  }

  const obj = parsedJson as Record<string, unknown>;

  // 2. Object with proposals or suggestions key
  if (Array.isArray(obj.proposals)) {
    return obj.proposals.filter(isRecord);
  }
  if (Array.isArray(obj.suggestions)) {
    return obj.suggestions.filter(isRecord);
  }

  // 3. Single proposal object
  if (typeof obj.original === "string" || typeof obj.replacement === "string" || typeof obj.file === "string") {
    return [obj as RawProposalItem];
  }

  // 4. File-keyed map: { "path/to/note.md": [ proposals ] }
  const collected: RawProposalItem[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isRecord(item)) {
          collected.push({ file: key, ...item });
        }
      }
    }
  }

  return collected;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Normalizes a single raw item into a validated Proposal domain entity.
 */
export function normalizeProposalItem(
  raw: RawProposalItem,
  sourceFilePath: string,
  index: number
): Proposal | null {
  const targetFileRaw = raw.file ?? raw.filePath ?? raw.path;
  if (!targetFileRaw || typeof targetFileRaw !== "string") {
    return null;
  }

  const original = raw.original ?? raw.orig ?? raw.old ?? raw.text;
  if (typeof original !== "string") {
    return null;
  }

  const replacement = raw.replacement ?? raw.replace ?? raw.new ?? raw.suggested ?? "";

  // Normalize line: treat 0 or 1 as first line, clamp >= 1
  const lineRaw = raw.line ?? 1;
  const lineParsed = typeof lineRaw === "number" ? Math.floor(lineRaw) : parseInt(String(lineRaw), 10);
  const line = isNaN(lineParsed) || lineParsed <= 0 ? 1 : lineParsed;

  const fromChRaw = raw.ch ?? raw.from_ch ?? raw.fromCh ?? raw.ch_from ?? raw.from ?? 0;
  const fromChParsed = typeof fromChRaw === "number" ? Math.floor(fromChRaw) : parseInt(String(fromChRaw), 10);
  const fromCh = isNaN(fromChParsed) || fromChParsed < 0 ? 0 : fromChParsed;

  const toChRaw = raw.to_ch ?? raw.toCh ?? raw.ch_to ?? raw.to;
  let toCh: number;
  if (toChRaw !== undefined && toChRaw !== null) {
    const toChParsed = typeof toChRaw === "number" ? Math.floor(toChRaw) : parseInt(String(toChRaw), 10);
    toCh = isNaN(toChParsed) || toChParsed < fromCh ? fromCh + original.length : toChParsed;
  } else {
    toCh = fromCh + original.length;
  }

  const rule = String(raw.rule ?? raw.ruleId ?? raw.category ?? raw.title ?? "AI Proposal");
  const explanation = String(raw.explanation ?? raw.message ?? raw.reason ?? raw.description ?? "");
  const author = raw.author ? String(raw.author) : undefined;

  const normalizedFile = normalizePath(targetFileRaw);
  const normalizedSource = normalizePath(sourceFilePath);

  const rawId = raw.id && typeof raw.id === "string" && raw.id.trim().length > 0
    ? raw.id.trim()
    : undefined;

  const fallbackId = `${normalizedSource}:${normalizedFile}:${line}:${fromCh}:${toCh}:${simpleHash(original)}-${index}`;
  const id = rawId ?? fallbackId;
  const compoundId = `${normalizedSource}::${id}#${index}`;

  const timestamp = typeof raw.timestamp === "string"
    ? parseInt(raw.timestamp, 10)
    : (raw.timestamp ?? Date.now());

  return {
    id,
    compoundId,
    rawId,
    sourceFile: normalizedSource,
    file: normalizedFile,
    line,
    ch: fromCh,
    toCh,
    from_ch: fromCh,
    to_ch: toCh,
    original,
    replacement: String(replacement),
    rule,
    explanation,
    author,
    timestamp: isNaN(timestamp) ? Date.now() : timestamp,
    context: raw.context,
    status: "pending",
    _raw: raw,
  };
}

/**
 * Production ProposalStore implementation.
 */
export class ProposalStore implements IProposalStore {
  private proposals: Proposal[] = [];
  private listeners = new Set<StoreChangeListener>();
  private eventRefs: EventRef[] = [];
  private settings: AIProposalsSettings;

  // Write-lock and cooldown management (350ms window)
  private activeWriteLocks = new Set<string>();
  private writeCooldowns = new Map<string, number>();
  private readonly WRITE_COOLDOWN_MS = 350;
  private pendingRescans = new Set<string>();
  private lastSavedMtime = new Map<string, number>();
  private lastSavedSize = new Map<string, number>();
  private lastSavedContent = new Map<string, string>();

  // Race-condition guard for concurrent accept/reject invocations
  private mutatingProposals = new Set<string>();

  constructor(
    private readonly app: App,
    private readonly getSettings?: () => AIProposalsSettings
  ) {
    this.settings = { ...DEFAULT_SETTINGS };
  }

  private getActiveSettings(): AIProposalsSettings {
    if (this.getSettings) {
      return this.getSettings();
    }
    return this.settings;
  }

  public updateSettings(partial: Partial<AIProposalsSettings>): void {
    this.settings = { ...this.settings, ...partial };
  }

  public async initialize(): Promise<void> {
    this.registerVaultListeners();
    await this.scanVaultBuffers();
  }

  public dispose(): void {
    for (const ref of this.eventRefs) {
      this.app.vault.offref(ref);
    }
    this.eventRefs = [];
    this.listeners.clear();
    this.proposals = [];
    this.activeWriteLocks.clear();
    this.writeCooldowns.clear();
    this.pendingRescans.clear();
    this.lastSavedMtime.clear();
    this.lastSavedSize.clear();
    this.lastSavedContent.clear();
    this.mutatingProposals.clear();
  }

  public getProposalsForFile(filePath: string): Proposal[] {
    const norm = normalizePath(filePath);
    return this.proposals.filter(
      (p) => normalizePath(p.file) === norm && p.status === "pending"
    );
  }

  public getAllProposals(): Proposal[] {
    return this.proposals.filter((p) => p.status === "pending");
  }

  public getProposalById(proposalId: string): Proposal | undefined {
    return (
      this.proposals.find((p) => p.compoundId === proposalId) ??
      this.proposals.find((p) => p.compoundId !== undefined && p.compoundId.startsWith(proposalId + "#")) ??
      this.proposals.find((p) => p.id === proposalId)
    );
  }

  public onStoreChange(listener: StoreChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public getState(): ProposalStoreState {
    const bufferFiles = this.getBufferFiles().map((f) => f.path);
    return {
      proposals: [...this.proposals],
      activeFilePath: null,
      bufferFiles,
      isLoading: false,
      lastScanTimestamp: Date.now(),
      error: null,
    };
  }

  private notifyListeners(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch (err) {
        console.error("[AI Proposals] Error in store listener:", err);
      }
    }
  }

  // --- Write Lock & Cooldown Engine ---

  private async executeWithWriteLock<T>(filePath: string, op: () => Promise<T>): Promise<T> {
    const norm = normalizePath(filePath);
    this.activeWriteLocks.add(norm);
    this.writeCooldowns.set(norm, Date.now());

    try {
      const result = await op();
      const file = this.app.vault.getAbstractFileByPath(norm);
      if (file instanceof TFile) {
        this.lastSavedMtime.set(norm, file.stat.mtime);
        this.lastSavedSize.set(norm, file.stat.size);
      }
      return result;
    } finally {
      this.activeWriteLocks.delete(norm);
      this.writeCooldowns.set(norm, Date.now());
      setTimeout(() => {
        if (this.pendingRescans.size > 0) {
          this.pendingRescans.clear();
          void this.scanVaultBuffers();
        }
      }, this.WRITE_COOLDOWN_MS);
    }
  }

  private isEventSuppressed(filePath: string): boolean {
    const norm = normalizePath(filePath);
    if (this.activeWriteLocks.has(norm)) {
      return true;
    }
    const lastSaved = this.writeCooldowns.get(norm);
    if (lastSaved !== undefined && Date.now() - lastSaved < this.WRITE_COOLDOWN_MS) {
      return true;
    }
    return false;
  }

  // --- Wildcard Buffer Discovery & Ingestion ---

  public async scanVaultBuffers(): Promise<Proposal[]> {
    const bufferFiles = this.getBufferFiles();
    const loadedProposals: Proposal[] = [];

    for (const file of bufferFiles) {
      try {
        const content = await this.app.vault.read(file);
        if (!content || !content.trim()) {
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(content);
        } catch (parseErr) {
          console.warn(`[AI Proposals] Corrupt JSON in proposal buffer: ${file.path}`, parseErr);
          continue; // Skip corrupted file, do not crash
        }

        const rawItems = extractRawItems(parsed);
        rawItems.forEach((raw, idx) => {
          const proposal = normalizeProposalItem(raw, file.path, idx);
          if (proposal) {
            loadedProposals.push(proposal);
          }
        });
      } catch (readErr) {
        console.warn(`[AI Proposals] Failed to read buffer file: ${file.path}`, readErr);
      }
    }

    // Resolve in-memory collisions: reject overlapping intervals on same file & line
    this.proposals = this.filterCollisions(loadedProposals);
    this.notifyListeners();
    return this.proposals;
  }

  private getBufferFiles(): TFile[] {
    const settings = this.getActiveSettings();
    const pattern = settings.bufferPattern || "ai_suggestion-*.json";
    const legacyPath = settings.legacyBufferPath || "_agy_suggestions.json";
    const targetDir = settings.bufferDirectory ? normalizePath(settings.bufferDirectory) : "";

    return this.app.vault.getFiles().filter((file) => {
      if (file.extension !== "json") return false;

      if (targetDir) {
        const parentPath = file.parent ? normalizePath(file.parent.path) : "";
        if (parentPath !== targetDir && !parentPath.startsWith(targetDir + "/")) {
          return false;
        }
      }

      return matchesBufferPattern(file.name, pattern) || file.name === legacyPath;
    });
  }

  private filterCollisions(items: Proposal[]): Proposal[] {
    const valid: Proposal[] = [];
    const grouped = new Map<string, Proposal[]>();

    for (const item of items) {
      const key = `${normalizePath(item.file)}:${item.line}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(item);
    }

    for (const group of grouped.values()) {
      group.sort((a, b) => {
        const aFrom = a.ch ?? a.from_ch ?? 0;
        const bFrom = b.ch ?? b.from_ch ?? 0;
        const aTo = a.toCh ?? a.to_ch ?? (aFrom + a.original.length);
        const bTo = b.toCh ?? b.to_ch ?? (bFrom + b.original.length);
        return aFrom - bFrom || aTo - bTo;
      });

      const acceptedInGroup: Proposal[] = [];

      for (const candidate of group) {
        const candFrom = candidate.ch ?? candidate.from_ch ?? 0;
        const candTo = candidate.toCh ?? candidate.to_ch ?? (candFrom + candidate.original.length);

        const collides = acceptedInGroup.some((existing) => {
          const existFrom = existing.ch ?? existing.from_ch ?? 0;
          const existTo = existing.toCh ?? existing.to_ch ?? (existFrom + existing.original.length);
          return hasIntervalCollision(
            { from: existFrom, to: existTo },
            { from: candFrom, to: candTo }
          );
        });

        if (!collides) {
          acceptedInGroup.push(candidate);
          valid.push(candidate);
        } else {
          console.warn(`[AI Proposals] Rejected overlapping proposal: ${candidate.id}`);
        }
      }
    }

    return valid;
  }

  // --- Reactive Vault Events ---

  private registerVaultListeners(): void {
    this.eventRefs.push(
      this.app.vault.on("modify", async (file: TAbstractFile) => {
        if (!(file instanceof TFile)) return;
        const norm = normalizePath(file.path);
        if (this.activeWriteLocks.has(norm)) {
          // Self-induced write currently in flight: strictly ignore
          return;
        }

        if (this.isEventSuppressed(file.path)) {
          if (this.isBufferFile(file)) {
            const savedMtime = this.lastSavedMtime.get(norm);
            const savedSize = this.lastSavedSize.get(norm);
            // If mtime or size changed, it is an external modification
            if (savedMtime === undefined || file.stat.mtime > savedMtime || file.stat.size !== savedSize) {
              this.pendingRescans.add(norm);
            } else {
              try {
                const content = await this.app.vault.read(file);
                const savedContent = this.lastSavedContent.get(norm);
                if (savedContent !== undefined && content !== savedContent) {
                  this.pendingRescans.add(norm);
                }
              } catch {
                this.pendingRescans.add(norm);
              }
            }
          }
          return;
        }

        if (this.isBufferFile(file)) {
          void this.scanVaultBuffers();
        }
      })
    );

    this.eventRefs.push(
      this.app.vault.on("create", (file: TAbstractFile) => {
        if (!(file instanceof TFile)) return;
        if (this.isEventSuppressed(file.path)) return;

        if (this.isBufferFile(file)) {
          void this.scanVaultBuffers();
        }
      })
    );

    this.eventRefs.push(
      this.app.vault.on("delete", (file: TAbstractFile) => {
        if (!(file instanceof TFile)) return;
        if (this.isEventSuppressed(file.path)) return;

        const normPath = normalizePath(file.path);
        // If a buffer was deleted, purge its proposals
        const prevCount = this.proposals.length;
        this.proposals = this.proposals.filter((p) => p.sourceFile !== normPath);
        if (this.proposals.length !== prevCount) {
          this.notifyListeners();
        }
      })
    );

    this.eventRefs.push(
      this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
        if (!(file instanceof TFile)) return;
        const normOld = normalizePath(oldPath);
        const normNew = normalizePath(file.path);

        let changed = false;

        // If buffer file renamed, update sourceFile
        for (const p of this.proposals) {
          if (p.sourceFile === normOld) {
            p.sourceFile = normNew;
            changed = true;
          }
        }

        // If markdown target note renamed, update target file
        if (file.extension === "md") {
          for (const p of this.proposals) {
            if (p.file === normOld) {
              p.file = normNew;
              changed = true;
            }
          }
        }

        if (changed) {
          this.notifyListeners();
        }
      })
    );
  }

  private isBufferFile(file: TFile): boolean {
    if (file.extension !== "json") return false;
    const settings = this.getActiveSettings();
    const pattern = settings.bufferPattern || "ai_suggestion-*.json";
    const legacyPath = settings.legacyBufferPath || "_agy_suggestions.json";
    return matchesBufferPattern(file.name, pattern) || file.name === legacyPath;
  }

  // --- Atomic Acceptance Workflow ---

  public async acceptProposal(proposalId: string): Promise<boolean> {
    const proposal = this.getProposalById(proposalId);
    if (!proposal || proposal.status !== "pending") {
      console.warn(`[AI Proposals] Proposal ${proposalId} cannot be accepted (not found or not pending)`);
      return false;
    }

    const compoundId = proposal.compoundId ?? `${proposal.sourceFile}::${proposal.id}`;
    if (this.mutatingProposals.has(compoundId) || this.mutatingProposals.has(proposalId)) {
      return false; // Prevent concurrent re-entrant execution
    }

    this.mutatingProposals.add(compoundId);
    this.mutatingProposals.add(proposalId);

    try {
      const abstractTarget = this.app.vault.getAbstractFileByPath(proposal.file);
      if (!abstractTarget || !(abstractTarget instanceof TFile)) {
        new Notice(`Nie odnaleziono pliku ${proposal.file} w skarbcu.`);
        return false;
      }
      const targetFile = abstractTarget;

      // Read current note content
      const content = await this.app.vault.read(targetFile);
      const lines = content.split(/\r?\n/);
      const settings = this.getActiveSettings();

      // Auto-snap range resolution (target line -> closest occurrence -> ±5 lines)
      const resolved = this.resolveTargetRange(lines, proposal, settings.neighborhoodScanRadius || 5);
      if (!resolved) {
        new Notice("Nie można zastosować: oryginalny tekst nie został odnaleziony w pliku.");
        return false;
      }

      // Compute updated document content
      const patchedContent = this.patchContent(content, resolved, proposal.replacement);
      this.lastSavedContent.set(targetFile.path, patchedContent);
      this.lastSavedSize.set(targetFile.path, patchedContent.length);

      // Apply patch to note under write-lock
      await this.executeWithWriteLock(targetFile.path, async () => {
        if (typeof this.app.vault.process === "function") {
          await this.app.vault.process(targetFile, () => patchedContent);
        } else {
          await this.app.vault.modify(targetFile, patchedContent);
        }
      });

      // Shift coordinates of remaining pending proposals for this file
      const sameFileProposals = this.proposals.filter(
        (p) => p !== proposal && p.file === proposal.file && p.status === "pending"
      );

      // Create normalized applied representation matching actual resolved range
      const appliedSnapshot: Proposal = {
        ...proposal,
        id: `__applied_${proposal.compoundId ?? proposal.id}`,
        line: resolved.lineIndex + 1,
        ch: resolved.fromCh,
        toCh: resolved.toCh,
        from_ch: resolved.fromCh,
        to_ch: resolved.toCh,
      };

      const shiftedRemaining = shiftProposalsAfterAcceptance(sameFileProposals, appliedSnapshot);

      // Update in-memory state
      proposal.status = "applied";
      const otherProposals = this.proposals.filter(
        (p) => p !== proposal && (p.file !== proposal.file || p.status !== "pending")
      );
      this.proposals = [...otherProposals, ...shiftedRemaining];

      // Remove accepted proposal from originating JSON buffer
      await this.removeProposalFromSourceFile(proposal);

      this.notifyListeners();
      return true;
    } finally {
      this.mutatingProposals.delete(compoundId);
      this.mutatingProposals.delete(proposalId);
    }
  }

  // --- Atomic Rejection Workflow ---

  public async rejectProposal(proposalId: string): Promise<boolean> {
    const proposal = this.getProposalById(proposalId);
    if (!proposal || proposal.status !== "pending") {
      console.warn(`[AI Proposals] Cannot reject proposal ${proposalId}: not found or not pending`);
      return false;
    }

    const compoundId = proposal.compoundId ?? `${proposal.sourceFile}::${proposal.id}`;
    if (this.mutatingProposals.has(compoundId) || this.mutatingProposals.has(proposalId)) {
      return false;
    }

    this.mutatingProposals.add(compoundId);
    this.mutatingProposals.add(proposalId);

    try {
      proposal.status = "rejected";
      await this.removeProposalFromSourceFile(proposal);

      this.proposals = this.proposals.filter(
        (p) => (p.compoundId ?? `${p.sourceFile}::${p.id}`) !== compoundId && p !== proposal
      );
      this.notifyListeners();
      return true;
    } finally {
      this.mutatingProposals.delete(compoundId);
      this.mutatingProposals.delete(proposalId);
    }
  }

  // --- Source JSON Buffer Mutation & Deletion ---

  private async removeProposalFromSourceFile(proposal: Proposal): Promise<void> {
    const abstractSource = this.app.vault.getAbstractFileByPath(proposal.sourceFile);
    if (!abstractSource || !(abstractSource instanceof TFile)) {
      return; // Source buffer may have already been removed
    }
    const sourceFile = abstractSource;

    try {
      const content = await this.app.vault.read(sourceFile);
      if (!content.trim()) return;

      const parsed: unknown = JSON.parse(content);
      const settings = this.getActiveSettings();

      // Check if this source file now has 0 remaining proposals
      const compoundId = proposal.compoundId ?? `${proposal.sourceFile}::${proposal.id}`;
      const remainingForSource = this.proposals.filter(
        (p) =>
          p.sourceFile === proposal.sourceFile &&
          p !== proposal &&
          (p.compoundId ?? `${p.sourceFile}::${p.id}`) !== compoundId &&
          p.status === "pending"
      );

      if (remainingForSource.length === 0 && settings.deleteEmptyBufferFiles) {
        // Delete empty buffer file under write lock
        await this.executeWithWriteLock(sourceFile.path, async () => {
          await this.app.vault.delete(sourceFile);
        });
        return;
      }

      // Filter item from raw JSON structure
      const updatedJson = this.filterRawPayload(parsed, proposal);
      const serialized = JSON.stringify(updatedJson, null, 2);
      this.lastSavedContent.set(sourceFile.path, serialized);
      this.lastSavedSize.set(sourceFile.path, serialized.length);

      await this.executeWithWriteLock(sourceFile.path, async () => {
        await this.app.vault.modify(sourceFile, serialized);
      });
    } catch (err) {
      console.warn(`[AI Proposals] Failed to update source buffer file: ${proposal.sourceFile}`, err);
    }
  }

  private filterRawPayload(container: unknown, proposal: Proposal): unknown {
    let removed = false;
    const filterArray = (arr: unknown[]): unknown[] => {
      return arr.filter((item) => {
        if (!removed && this.isMatchingRawItem(item, proposal)) {
          removed = true;
          return false;
        }
        return true;
      });
    };

    if (Array.isArray(container)) {
      return filterArray(container);
    }

    if (isRecord(container)) {
      const copy = { ...container };
      if (Array.isArray(copy.proposals)) {
        copy.proposals = filterArray(copy.proposals);
      }
      if (Array.isArray(copy.suggestions)) {
        copy.suggestions = filterArray(copy.suggestions);
      }
      for (const [key, val] of Object.entries(copy)) {
        if (Array.isArray(val) && key !== "proposals" && key !== "suggestions") {
          copy[key] = filterArray(val);
        }
      }
      return copy;
    }

    return container;
  }

  private isMatchingRawItem(rawItem: unknown, proposal: Proposal): boolean {
    if (!isRecord(rawItem)) return false;
    if (proposal._raw && rawItem === proposal._raw) return true;

    const rawId = typeof rawItem.id === "string" ? rawItem.id.trim() : undefined;
    const rawFile = rawItem.file ?? rawItem.filePath ?? rawItem.path;
    const rawOrig = rawItem.original ?? rawItem.orig ?? rawItem.old ?? rawItem.text;
    const rawRep = rawItem.replacement ?? rawItem.replace ?? rawItem.new ?? rawItem.suggested ?? "";
    const rawLine = rawItem.line !== undefined ? Number(rawItem.line) : undefined;
    const normRawLine = rawLine === 0 ? 1 : rawLine;

    const idMatches =
      rawId !== undefined &&
      (rawId === proposal.id ||
       rawId === proposal.rawId ||
       proposal.compoundId === `${proposal.sourceFile}::${rawId}` ||
       (proposal.compoundId !== undefined && proposal.compoundId.startsWith(`${proposal.sourceFile}::${rawId}#`)));

    if (idMatches) {
      const origMatches = String(rawOrig) === proposal.original;
      const repMatches = String(rawRep) === proposal.replacement;
      const lineMatches = normRawLine === undefined || normRawLine === proposal.line;
      return origMatches && repMatches && lineMatches;
    }

    if (
      String(rawFile) === proposal.file &&
      String(rawOrig) === proposal.original &&
      String(rawRep) === proposal.replacement &&
      (normRawLine === undefined || normRawLine === proposal.line)
    ) {
      return true;
    }

    return false;
  }

  // --- Auto-Snap Range Locator & Patching Utilities ---

  private resolveTargetRange(
    lines: string[],
    proposal: Proposal,
    radius: number
  ): { lineIndex: number; fromCh: number; toCh: number } | null {
    const fromCh = proposal.ch ?? proposal.from_ch ?? 0;
    const toCh = proposal.toCh ?? proposal.to_ch ?? (fromCh + proposal.original.length);
    const lineIdx = proposal.line - 1;
    const original = proposal.original;

    if (lineIdx >= 0 && lineIdx < lines.length) {
      const lineText = lines[lineIdx];
      // 1. Exact match on target line
      if (lineText.substring(fromCh, toCh) === original) {
        return { lineIndex: lineIdx, fromCh, toCh };
      }

      // 2. Intra-line auto-snap
      const intraMatch = findClosestOccurrence(lineText, original, fromCh);
      if (intraMatch !== -1) {
        return { lineIndex: lineIdx, fromCh: intraMatch, toCh: intraMatch + original.length };
      }
    }

    // 3. Scan neighborhood +/- radius lines
    for (let offset = 1; offset <= radius; offset++) {
      for (const dir of [1, -1]) {
        const candidateIdx = lineIdx + offset * dir;
        if (candidateIdx >= 0 && candidateIdx < lines.length) {
          const matchCh = findClosestOccurrence(lines[candidateIdx], original, fromCh);
          if (matchCh !== -1) {
            return {
              lineIndex: candidateIdx,
              fromCh: matchCh,
              toCh: matchCh + original.length,
            };
          }
        }
      }
    }

    return null;
  }

  private patchContent(
    content: string,
    range: { lineIndex: number; fromCh: number; toCh: number },
    replacement: string
  ): string {
    const lines = content.split(/\r?\n/);
    const targetLine = lines[range.lineIndex] ?? "";
    const prefix = targetLine.slice(0, range.fromCh);
    const suffix = targetLine.slice(range.toCh);
    const spliced = prefix + replacement + suffix;
    const replacementLines = spliced.split(/\r?\n/);
    lines.splice(range.lineIndex, 1, ...replacementLines);
    return lines.join("\n");
  }
}
