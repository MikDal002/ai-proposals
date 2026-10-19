/**
 * src/store/coordinate-math.ts
 * Pure mathematical coordinate engine for AI Proposals Obsidian Plugin.
 *
 * Guarantees:
 * - Pure functions with zero side-effects.
 * - Zero Node.js runtime imports (no fs, path, os, child_process).
 * - Full cross-platform support (Desktop & Mobile).
 */

import type {
  Proposal,
  RawProposalItem,
  DeltaShift,
  SnappedLocation,
} from "../types";

/**
 * Calculates line count delta and character offset delta between original and replacement text.
 * Normalizes both CRLF and LF line endings.
 */
export function calculateDeltaShift(
  original: string,
  replacement: string
): DeltaShift {
  const origLines = original.split(/\r?\n/);
  const repLines = replacement.split(/\r?\n/);

  const deltaLines = repLines.length - origLines.length;

  // Single-line edit: delta is the direct difference in string length
  if (origLines.length === 1 && repLines.length === 1) {
    return {
      deltaCh: replacement.length - original.length,
      deltaLines: 0,
    };
  }

  // Multi-line edit: anchor line character change is the difference between the first segments
  const deltaCh = repLines[0].length - origLines[0].length;

  return {
    deltaCh,
    deltaLines,
  };
}

/**
 * Finds the index of `target` in `lineText` that minimizes absolute distance to `expectedCh`.
 *
 * - If target is empty, returns expectedCh clamped to [0, lineText.length].
 * - If target is not found or lineText is empty, returns -1.
 * - Deterministic tie-breaker: earlier occurrence is chosen if distances are equal.
 */
export function findClosestOccurrence(
  lineText: string,
  target: string,
  expectedCh: number
): number {
  if (target.length === 0) {
    if (lineText.length === 0) return 0;
    return Math.max(0, Math.min(expectedCh, lineText.length));
  }

  if (lineText.length === 0) {
    return -1;
  }

  // Fast path: exact match at expected column
  if (
    expectedCh >= 0 &&
    expectedCh + target.length <= lineText.length &&
    lineText.substring(expectedCh, expectedCh + target.length) === target
  ) {
    return expectedCh;
  }

  let bestIdx = -1;
  let bestDist = Infinity;
  let searchFrom = 0;

  while (searchFrom <= lineText.length - target.length) {
    const idx = lineText.indexOf(target, searchFrom);
    if (idx === -1) break;

    const dist = Math.abs(idx - expectedCh);
    // Strict inequality preserves earlier index on tie
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = idx;
    }
    searchFrom = idx + 1;
  }

  return bestIdx;
}

/**
 * Scans expected line and adjacent lines (+/- radius) to locate shifted anchor text.
 * Checks the expected line first, then scans outward in alternating order (+1, -1, +2, -2, ...).
 */
export function findInNeighborhood(
  lines: string[],
  target: string,
  expectedLine: number, // 1-indexed line
  expectedCh: number,   // 0-indexed column
  radius = 5
): SnappedLocation | null {
  if (!target || target.length === 0) {
    return null;
  }

  const totalLines = lines.length;
  const lineIdx = expectedLine - 1; // Convert to 0-indexed array

  // 1. Check exact expected line first
  if (lineIdx >= 0 && lineIdx < totalLines) {
    const currentLineText = lines[lineIdx];
    const matchCh = findClosestOccurrence(currentLineText, target, expectedCh);
    if (matchCh !== -1) {
      const isExact = matchCh === expectedCh;
      return {
        line: expectedLine,
        ch: matchCh,
        distance: 0,
        matchType: isExact ? 'exact' : 'snapped-line',
      };
    }
  }

  // 2. Scan outward in alternating neighborhood (+1, -1, +2, -2, ...)
  for (let offset = 1; offset <= radius; offset++) {
    for (const dir of [1, -1]) {
      const candidateLine = expectedLine + offset * dir;
      const candidateIdx = candidateLine - 1;

      if (candidateIdx >= 0 && candidateIdx < totalLines) {
        const candidateText = lines[candidateIdx];
        const matchCh = findClosestOccurrence(candidateText, target, expectedCh);
        if (matchCh !== -1) {
          return {
            line: candidateLine,
            ch: matchCh,
            distance: offset * dir,
            matchType: 'snapped-neighbor',
          };
        }
      }
    }
  }

  return null;
}

/**
 * Determines whether two half-open character intervals intersect.
 *
 * Rules:
 * - Strictly adjacent intervals (a.to === b.from or b.to === a.from) do NOT collide.
 * - Pure insertions (zero-length intervals) at the exact same point collide with each other.
 * - Pure insertion strictly inside an interval collides with that interval.
 * - Pure insertion abutting the boundary of an interval does NOT collide.
 */
export function hasIntervalCollision(
  a: { from: number; to: number },
  b: { from: number; to: number }
): boolean {
  const aFrom = Math.min(a.from, a.to);
  const aTo = Math.max(a.from, a.to);
  const bFrom = Math.min(b.from, b.to);
  const bTo = Math.max(b.from, b.to);

  const aIsZero = aFrom === aTo;
  const bIsZero = bFrom === bTo;

  // Case 1: Both are pure insertions (zero-length)
  if (aIsZero && bIsZero) {
    return aFrom === bFrom;
  }

  // Case 2: One pure insertion, one range
  if (aIsZero) {
    return aFrom > bFrom && aFrom < bTo;
  }
  if (bIsZero) {
    return bFrom > aFrom && bFrom < aTo;
  }

  // Case 3: Both are non-zero ranges
  return Math.max(aFrom, bFrom) < Math.min(aTo, bTo);
}

/**
 * Resolves overlapping proposals on the same line in the same file.
 * Preserves earlier proposals in order (first-come, first-served) and marks
 * subsequent overlapping candidates as 'conflict'.
 */
export function resolveProposalCollisions(
  proposals: Proposal[]
): { valid: Proposal[]; conflicts: Proposal[] } {
  const valid: Proposal[] = [];
  const conflicts: Proposal[] = [];

  for (const candidate of proposals) {
    const candFrom = candidate.ch ?? candidate.from_ch ?? 0;
    const candTo = candidate.toCh ?? candidate.to_ch ?? (candFrom + candidate.original.length);

    // Check against already validated proposals on the same file and line
    const collides = valid.some((existing) => {
      if (existing.file !== candidate.file || existing.line !== candidate.line) {
        return false;
      }
      const existFrom = existing.ch ?? existing.from_ch ?? 0;
      const existTo = existing.toCh ?? existing.to_ch ?? (existFrom + existing.original.length);
      return hasIntervalCollision(
        { from: existFrom, to: existTo },
        { from: candFrom, to: candTo }
      );
    });

    if (collides) {
      const conflictItem: Proposal = {
        ...candidate,
        status: 'conflict',
        rejectionReason: 'Overlaps with preceding proposal on the same line',
      };
      conflicts.push(conflictItem);
    } else {
      valid.push(candidate);
    }
  }

  return { valid, conflicts };
}

/**
 * Re-indexes all remaining proposals after a proposal has been accepted and applied.
 *
 * Handles:
 * - Line isolation (other files untouched).
 * - Preceding lines untouched.
 * - Intermediate lines overwritten by multi-line original marked as conflict.
 * - Subsequent lines shifted vertically by deltaLines.
 * - Anchor line intra-line horizontal column shifts by deltaCh.
 * - Multi-line replacement line split: tail proposals pushed to line (targetLine + K).
 * - Overlapping proposals on anchor line marked as conflict.
 * - Absolute document character offsets (resolvedFrom/resolvedTo) shifted by deltaTotalChars.
 */
export function shiftProposalsAfterAcceptance(
  proposals: Proposal[],
  acceptedProposal: Proposal
): Proposal[] {
  const repLines = acceptedProposal.replacement.split(/\r?\n/);
  const origLines = acceptedProposal.original.split(/\r?\n/);
  const K = repLines.length - 1; // newlines added
  const M = origLines.length - 1; // newlines removed
  const deltaLines = K - M;
  const deltaTotalChars = acceptedProposal.replacement.length - acceptedProposal.original.length;

  const targetLine = acceptedProposal.line;
  const accFromCh = acceptedProposal.ch ?? acceptedProposal.from_ch ?? 0;
  const accToCh = acceptedProposal.toCh ?? acceptedProposal.to_ch ?? (accFromCh + acceptedProposal.original.length);

  const updated: Proposal[] = [];

  for (const p of proposals) {
    // 1. Skip the accepted proposal itself
    if (p.id === acceptedProposal.id) {
      continue;
    }

    // 2. Proposals targeting other files are completely untouched
    if (p.file !== acceptedProposal.file) {
      updated.push(p);
      continue;
    }

    const clone: Proposal = { ...p };
    const pFrom = clone.ch ?? clone.from_ch ?? 0;
    const pTo = clone.toCh ?? clone.to_ch ?? (pFrom + clone.original.length);

    // Synchronize both coordinate alias formats
    clone.ch = pFrom;
    clone.toCh = pTo;
    clone.from_ch = pFrom;
    clone.to_ch = pTo;

    // 3. Preceding lines are unaffected
    if (clone.line < targetLine) {
      updated.push(clone);
      continue;
    }

    // 4. Intermediate lines overwritten by accepted multi-line original
    if (clone.line > targetLine && clone.line <= targetLine + M) {
      clone.status = 'conflict';
      clone.rejectionReason = `Overlapped with accepted multi-line proposal ${acceptedProposal.id}`;
      updated.push(clone);
      continue;
    }

    // 5. Subsequent lines strictly after the modified block
    if (clone.line > targetLine + M) {
      clone.line += deltaLines;
      if (clone.resolvedFrom !== undefined && clone.resolvedTo !== undefined) {
        clone.resolvedFrom += deltaTotalChars;
        clone.resolvedTo += deltaTotalChars;
      }
      updated.push(clone);
      continue;
    }

    // 6. Anchor line (clone.line === targetLine)
    if (clone.line === targetLine) {
      // 6a. Preceding on line
      if (pTo <= accFromCh) {
        updated.push(clone);
        continue;
      }

      // 6b. Overlap check
      if (hasIntervalCollision(
        { from: pFrom, to: pTo },
        { from: accFromCh, to: accToCh }
      )) {
        clone.status = 'conflict';
        clone.rejectionReason = `Overlapped with accepted proposal ${acceptedProposal.id}`;
        updated.push(clone);
        continue;
      }

      // 6c. Succeeding on line (pFrom >= accToCh)
      if (pFrom >= accToCh) {
        const distFrom = pFrom - accToCh;
        const distTo = pTo - accToCh;

        if (K === 0) {
          // Single-line replacement: shifts horizontally on the same line
          const deltaCh = acceptedProposal.replacement.length - (accToCh - accFromCh);
          const newFrom = pFrom + deltaCh;
          const newTo = pTo + deltaCh;
          clone.ch = newFrom;
          clone.toCh = newTo;
          clone.from_ch = newFrom;
          clone.to_ch = newTo;
        } else {
          // Multi-line replacement: tail pushes to line (targetLine + K)
          clone.line = targetLine + K;
          const lastLineLen = repLines[K].length;
          const newFrom = lastLineLen + distFrom;
          const newTo = lastLineLen + distTo;
          clone.ch = newFrom;
          clone.toCh = newTo;
          clone.from_ch = newFrom;
          clone.to_ch = newTo;
        }

        if (clone.resolvedFrom !== undefined && clone.resolvedTo !== undefined) {
          clone.resolvedFrom += deltaTotalChars;
          clone.resolvedTo += deltaTotalChars;
        }

        updated.push(clone);
        continue;
      }
    }

    updated.push(clone);
  }

  return updated;
}

/**
 * Normalizes a raw proposal item into a strict internal Proposal.
 * Generates missing IDs, normalizes paths, and sets default status.
 */
export function normalizeRawProposalItem(
  raw: RawProposalItem,
  sourceFile: string,
  fallbackIndex = 0
): Proposal | null {
  const filePath = raw.file ?? raw.filePath ?? raw.path;
  if (!filePath || typeof filePath !== 'string') {
    return null;
  }

  // Parse line number (1-indexed)
  const lineNum = typeof raw.line === 'string' ? parseInt(raw.line, 10) : (raw.line ?? 1);
  if (typeof lineNum !== 'number' || isNaN(lineNum) || lineNum < 1) {
    return null;
  }

  // Validate original and replacement text
  const original = raw.original ?? raw.orig ?? raw.old ?? raw.text;
  if (typeof original !== 'string') {
    return null;
  }
  const replacement = raw.replacement ?? raw.replace ?? raw.new ?? raw.suggested ?? '';

  // Parse start column (ch / from_ch / fromCh)
  const rawCh = raw.ch ?? raw.from_ch ?? raw.fromCh ?? raw.ch_from ?? raw.from;
  let ch = typeof rawCh === 'string' ? parseInt(rawCh, 10) : (rawCh ?? 0);
  if (isNaN(ch) || ch < 0) ch = 0;

  // Parse or compute end column (to_ch / toCh)
  const rawToCh = raw.to_ch ?? raw.toCh ?? raw.ch_to ?? raw.to;
  let toCh: number;
  if (rawToCh !== undefined && rawToCh !== null) {
    toCh = typeof rawToCh === 'string' ? parseInt(rawToCh, 10) : rawToCh;
    if (isNaN(toCh) || toCh < ch) toCh = ch + original.length;
  } else {
    toCh = ch + original.length;
  }

  const id = raw.id && typeof raw.id === 'string' && raw.id.trim().length > 0
    ? raw.id.trim()
    : `prop-${Date.now()}-${fallbackIndex}`;

  const timestamp = typeof raw.timestamp === 'string'
    ? parseInt(raw.timestamp, 10)
    : (raw.timestamp ?? Date.now());

  return {
    id,
    file: filePath.trim(),
    sourceFile,
    line: lineNum,
    ch,
    toCh,
    from_ch: ch,
    to_ch: toCh,
    original,
    replacement,
    status: 'pending',
    rule: raw.rule ?? raw.ruleId ?? raw.category ?? raw.title,
    explanation: raw.explanation ?? raw.message ?? raw.reason ?? raw.description,
    author: raw.author,
    timestamp: isNaN(timestamp) ? Date.now() : timestamp,
    context: raw.context,
    _raw: raw,
  };
}
