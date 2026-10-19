/**
 * src/types/index.ts
 * Strict TypeScript data contracts for AI Proposals Obsidian Plugin.
 */

// ==========================================
// 1. Proposal Status & Identity Types
// ==========================================

export type ProposalStatus = 'pending' | 'applied' | 'rejected' | 'conflict';

// ==========================================
// 2. Raw Proposal Payload (Permissive Ingestion)
// ==========================================

/**
 * Raw proposal data ingested from external AI buffer files (ai_suggestion-*.json).
 * Permissive to accommodate agents with varying field naming conventions.
 */
export interface RawProposalItem {
  id?: string;
  file?: string;
  filePath?: string;
  path?: string;

  // Line coordinates (1-indexed display or string)
  line?: number | string;

  // Column coordinates
  ch?: number | string;
  from_ch?: number | string;
  fromCh?: number | string;
  ch_from?: number | string;
  from?: number | string;
  to_ch?: number | string;
  toCh?: number | string;
  ch_to?: number | string;
  to?: number | string;

  // Content
  original?: string;
  orig?: string;
  old?: string;
  text?: string;
  replacement?: string;
  replace?: string;
  new?: string;
  suggested?: string;

  // Metadata & Context
  rule?: string;
  ruleId?: string;
  category?: string;
  title?: string;
  explanation?: string;
  message?: string;
  reason?: string;
  description?: string;
  author?: string;
  timestamp?: number | string;
  context?: string;

  [key: string]: unknown;
}

// ==========================================
// 3. Internal Normalized Proposal Model
// ==========================================

/**
 * Normalized internal representation of an AI proposal.
 * Uses 1-indexed line numbers and 0-indexed column offsets.
 */
export interface Proposal {
  /** Unique deterministic identifier */
  id: string;

  /** Vault relative path of the target Markdown file (e.g. "Notes/Daily.md") */
  file: string;

  /** Vault relative path of the buffer file (e.g. "ai_suggestion-01.json") */
  sourceFile: string;

  /** Compound globally unique key namespaced by source buffer file (e.g. "ai_suggestion-01.json::p1") */
  compoundId?: string;

  /** Original raw ID from suggestion buffer before namespacing */
  rawId?: string;

  /** 1-indexed line number in the target document */
  line: number;

  /** 0-indexed character start column on the target line */
  ch: number;

  /** 0-indexed character end column on the target line */
  toCh: number;

  /** Alias for ch (start column) for backwards and multi-blueprint compatibility */
  from_ch?: number;

  /** Alias for toCh (end column) for backwards and multi-blueprint compatibility */
  to_ch?: number;

  /** Expected existing text in the document */
  original: string;

  /** Proposed replacement text */
  replacement: string;

  /** Current lifecycle state */
  status: ProposalStatus;

  /** Absolute 0-indexed character offset from document start (cached for CM6) */
  resolvedFrom?: number;

  /** Absolute 0-indexed character offset from document start (cached for CM6) */
  resolvedTo?: number;

  /** Rule category or lint identifier */
  rule?: string;

  /** AI rationale or user-facing explanation */
  explanation?: string;

  /** Identity of the AI agent/model that created the suggestion */
  author?: string;

  /** Creation epoch timestamp in milliseconds */
  timestamp?: number;

  /** Surrounding text snippet for contextual verification */
  context?: string;

  /** Detailed reason if status is 'conflict' or 'rejected' */
  rejectionReason?: string;

  /** Reference to original raw payload for JSON persistence filtering */
  _raw?: RawProposalItem;
}

// ==========================================
// 4. Coordinate Math & Shift Contracts
// ==========================================

/**
 * Net coordinate changes resulting from text replacement.
 */
export interface DeltaShift {
  readonly deltaCh: number;
  readonly deltaLines: number;
}

/**
 * Full coordinate shift record describing an applied edit.
 */
export interface CoordinateShift {
  readonly deltaCh: number;
  readonly deltaLines: number;
  readonly line: number;
  readonly fromCh: number;
}

/**
 * Result of auto-snap or neighborhood scan.
 */
export interface SnappedLocation {
  readonly line: number;
  readonly ch: number;
  readonly distance: number;
  readonly matchType: 'exact' | 'snapped-line' | 'snapped-neighbor' | 'not-found';
}

// ==========================================
// 5. Store & Ingestion Contracts
// ==========================================

export interface NormalizationResult {
  readonly validProposals: Proposal[];
  readonly rejectedItems: ReadonlyArray<{
    readonly item: RawProposalItem;
    readonly reason: string;
  }>;
}

export interface ProposalStoreState {
  readonly proposals: ReadonlyArray<Proposal>;
  readonly activeFilePath: string | null;
  readonly bufferFiles: ReadonlyArray<string>;
  readonly isLoading: boolean;
  readonly lastScanTimestamp: number;
  readonly error: string | null;
}

export type StoreChangeListener = (state?: ProposalStoreState) => void;

export interface IProposalStore {
  initialize(): Promise<void>;
  scanVaultBuffers(): Promise<Proposal[]>;
  getProposalsForFile(filePath: string): Proposal[];
  getAllProposals(): Proposal[];
  getProposalById(proposalId: string): Proposal | undefined;
  acceptProposal(proposalId: string): Promise<boolean>;
  rejectProposal(proposalId: string): Promise<boolean>;
  onStoreChange(listener: StoreChangeListener): () => void;
  dispose(): void;
}

// ==========================================
// 6. Plugin Settings Interface
// ==========================================

export interface PluginSettings {
  /** Glob pattern for discovery of suggestion buffer files */
  bufferPattern: string;
  /** Subdirectory path to limit buffer discovery, or empty string for all folders */
  bufferDirectory: string;
  /** Legacy single buffer path for backwards compatibility */
  legacyBufferPath: string;
  /** Whether to automatically reload proposals when buffer files change */
  autoWatch: boolean;
  /** Whether to render CodeMirror wavy highlights in editor */
  enableHighlights: boolean;
  /** Maximum number of lines to search above/below drifted anchors (0 to 20) */
  autoSnapRadius: number;
  /** Store compatibility alias synchronized with autoSnapRadius */
  neighborhoodScanRadius: number;
  /** Whether to automatically open the sidebar when proposals exist */
  autoOpenSidebar: boolean;
  /** Display proposal count badge in Obsidian status bar (Desktop only) */
  showStatusBarCounter: boolean;
  /** Store compatibility alias synchronized with showStatusBarCounter */
  showStatusBarBadge: boolean;
  /** Automatically delete empty buffer files after proposals are applied/rejected */
  deleteEmptyBufferFiles: boolean;
}

export type AIProposalsSettings = PluginSettings;

export const DEFAULT_SETTINGS: Readonly<PluginSettings> = {
  bufferPattern: "ai_suggestion-*.json",
  bufferDirectory: "",
  legacyBufferPath: "_agy_suggestions.json",
  autoWatch: true,
  enableHighlights: true,
  autoSnapRadius: 5,
  neighborhoodScanRadius: 5,
  autoOpenSidebar: false,
  showStatusBarCounter: true,
  showStatusBarBadge: true,
  deleteEmptyBufferFiles: true,
};
