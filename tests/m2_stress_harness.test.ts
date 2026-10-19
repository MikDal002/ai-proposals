import { describe, it, expect, vi } from "vitest";
import { App as MockApp } from "./mocks/obsidian";
import type { App } from "obsidian";
import { ProposalStore } from "@/store/proposal-store";
import {
  calculateDeltaShift,
  findClosestOccurrence,
  findInNeighborhood,
  hasIntervalCollision,
  resolveProposalCollisions,
  shiftProposalsAfterAcceptance,
  normalizeRawProposalItem,
} from "@/store/coordinate-math";
import type { Proposal } from "@/types";

describe("Milestone 2 Adversarial Stress Harness: Coordinate Math Engine", () => {
  // Helper to construct test proposals
  const makeProposal = (
    id: string,
    line: number,
    ch: number,
    toCh: number,
    original = "text",
    replacement = "replacement",
    file = "Notes/Document.md"
  ): Proposal => ({
    id,
    file,
    sourceFile: "ai_suggestion-test.json",
    line,
    ch,
    toCh,
    from_ch: ch,
    to_ch: toCh,
    original,
    replacement,
    status: "pending",
  });

  // =========================================================================
  // CATEGORY 1: Multi-line replacements (splitting & collapsing)
  // =========================================================================
  describe("Category 1: Multi-line replacements (splitting & collapsing)", () => {
    it("1.1 calculateDeltaShift: 1 line splitting into 50 lines", () => {
      const repLines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
      const shift = calculateDeltaShift("single line", repLines);
      expect(shift.deltaLines).toBe(49);
      expect(shift.deltaCh).toBe("line 1".length - "single line".length);
    });

    it("1.2 calculateDeltaShift: 50 lines collapsing into 1 line", () => {
      const origLines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
      const shift = calculateDeltaShift(origLines, "collapsed");
      expect(shift.deltaLines).toBe(-49);
      expect(shift.deltaCh).toBe("collapsed".length - "line 1".length);
    });

    it("1.3 calculateDeltaShift: multi-line to multi-line with asymmetric lines", () => {
      const orig = "alpha\nbeta\ngamma"; // 3 lines
      const rep = "one\ntwo\nthree\nfour\nfive"; // 5 lines
      const shift = calculateDeltaShift(orig, rep);
      expect(shift.deltaLines).toBe(2);
      expect(shift.deltaCh).toBe("one".length - "alpha".length); // 3 - 5 = -2
    });

    it("1.4 shiftProposalsAfterAcceptance: single-line splitting pushes anchor line tail", () => {
      // Line 5: "hello beautiful world"
      // Replace "beautiful" (ch: 6, toCh: 15) with 3 lines: "gorgeous\nand\nstunning"
      const accepted = makeProposal(
        "p-acc",
        5,
        6,
        15,
        "beautiful",
        "gorgeous\nand\nstunning" // K = 2 newlines added
      );

      // Proposal on preceding part of line 5 ("hello", ch: 0..5)
      const pPreceding = makeProposal("p-prec", 5, 0, 5, "hello", "hi");

      // Proposal on succeeding part of line 5 ("world", ch: 16..21)
      const pSucceeding = makeProposal("p-succ", 5, 16, 21, "world", "planet");

      // Proposal on subsequent line 6
      const pNextLine = makeProposal("p-next", 6, 0, 10, "next line", "new next");

      const shifted = shiftProposalsAfterAcceptance(
        [pPreceding, pSucceeding, pNextLine],
        accepted
      );

      const precResult = shifted.find((p) => p.id === "p-prec");
      expect(precResult).toBeDefined();
      expect(precResult?.line).toBe(5);
      expect(precResult?.ch).toBe(0);
      expect(precResult?.toCh).toBe(5);

      const succResult = shifted.find((p) => p.id === "p-succ");
      expect(succResult).toBeDefined();
      // Line pushed from 5 to 5 + 2 = 7
      expect(succResult?.line).toBe(7);
      // "stunning".length is 8, distFrom is 16 - 15 = 1 -> newFrom = 8 + 1 = 9
      // distTo is 21 - 15 = 6 -> newTo = 8 + 6 = 14
      expect(succResult?.ch).toBe(9);
      expect(succResult?.toCh).toBe(14);

      const nextResult = shifted.find((p) => p.id === "p-next");
      expect(nextResult).toBeDefined();
      // Pushed by deltaLines (+2): line 6 -> line 8
      expect(nextResult?.line).toBe(8);
      expect(nextResult?.ch).toBe(0);
    });

    it("1.5 shiftProposalsAfterAcceptance: collapsing 5 lines into 1 line invalidates intermediate proposals", () => {
      // Lines 5..9 replaced by single line on line 5
      const accepted = makeProposal(
        "p-collapse",
        5,
        0,
        20,
        "l5\nl6\nl7\nl8\nl9", // M = 4 newlines removed
        "single_line"        // K = 0
      );

      const pLine4 = makeProposal("p-4", 4, 0, 5);
      const pLine6 = makeProposal("p-6", 6, 0, 5);
      const pLine7 = makeProposal("p-7", 7, 2, 8);
      const pLine9 = makeProposal("p-9", 9, 0, 3);
      const pLine10 = makeProposal("p-10", 10, 0, 5);
      const pLine15 = makeProposal("p-15", 15, 0, 5);

      const shifted = shiftProposalsAfterAcceptance(
        [pLine4, pLine6, pLine7, pLine9, pLine10, pLine15],
        accepted
      );

      // Line 4 untouched
      expect(shifted.find((p) => p.id === "p-4")?.line).toBe(4);
      expect(shifted.find((p) => p.id === "p-4")?.status).toBe("pending");

      // Intermediate lines 6, 7, 9 marked conflict
      expect(shifted.find((p) => p.id === "p-6")?.status).toBe("conflict");
      expect(shifted.find((p) => p.id === "p-7")?.status).toBe("conflict");
      expect(shifted.find((p) => p.id === "p-9")?.status).toBe("conflict");

      // Subsequent lines shifted up by deltaLines (-4):
      // line 10 -> 6, line 15 -> 11
      const res10 = shifted.find((p) => p.id === "p-10");
      expect(res10?.status).toBe("pending");
      expect(res10?.line).toBe(6);

      const res15 = shifted.find((p) => p.id === "p-15");
      expect(res15?.status).toBe("pending");
      expect(res15?.line).toBe(11);
    });
  });

  // =========================================================================
  // CATEGORY 2: CRLF vs LF and mixed line endings
  // =========================================================================
  describe("Category 2: CRLF vs LF line endings and mixed line endings", () => {
    it("2.1 calculateDeltaShift normalizes CRLF and LF symmetrically", () => {
      const crlfText = "alpha\r\nbeta\r\ngamma";
      const lfText = "alpha\nbeta\ngamma";

      const shiftCrlfToLf = calculateDeltaShift(crlfText, lfText);
      expect(shiftCrlfToLf.deltaLines).toBe(0);
      expect(shiftCrlfToLf.deltaCh).toBe(0);

      const shiftLfToCrlf = calculateDeltaShift(lfText, crlfText);
      expect(shiftLfToCrlf.deltaLines).toBe(0);
      expect(shiftLfToCrlf.deltaCh).toBe(0);
    });

    it("2.2 calculateDeltaShift handles mixed line endings within single string", () => {
      const mixed = "line1\r\nline2\nline3\r\nline4"; // 4 lines
      const single = "collapsed"; // 1 line

      const shiftCollapse = calculateDeltaShift(mixed, single);
      expect(shiftCollapse.deltaLines).toBe(-3);
      expect(shiftCollapse.deltaCh).toBe("collapsed".length - "line1".length);
    });

    it("2.3 calculateDeltaShift handles trailing CRLF correctly", () => {
      const shiftTrailing = calculateDeltaShift("word\r\n", "word");
      expect(shiftTrailing.deltaLines).toBe(-1);

      const shiftAddTrailing = calculateDeltaShift("word", "word\r\n");
      expect(shiftAddTrailing.deltaLines).toBe(1);
    });

    it("2.4 shiftProposalsAfterAcceptance splits CRLF replacement into correct lines", () => {
      const accepted = makeProposal(
        "p-crlf",
        2,
        0,
        5,
        "first",
        "part1\r\npart2\r\npart3" // CRLF newlines
      );

      const subsequent = makeProposal("p-sub", 5, 0, 5);
      const shifted = shiftProposalsAfterAcceptance([subsequent], accepted);

      // 2 CRLF newlines added -> line 5 shifts to 7
      expect(shifted[0].line).toBe(7);
    });

    it("2.5 findClosestOccurrence handles lineText with carriage return cleanly", () => {
      // In Windows, a line might retain trailing \r
      const lineWithCR = "The quick brown fox jumps\r";
      const pos = findClosestOccurrence(lineWithCR, "fox", 10);
      expect(pos).toBe(16);
    });

    it("2.6 findInNeighborhood handles array of lines with CRLF carriage returns", () => {
      const lines = [
        "Line one\r",
        "Line two\r",
        "Target needle here\r",
        "Line four\r",
      ];
      const match = findInNeighborhood(lines, "Target needle", 1, 0, 5);
      expect(match).not.toBeNull();
      expect(match?.line).toBe(3);
      expect(match?.distance).toBe(2);
    });
  });

  // =========================================================================
  // CATEGORY 3: Complex chained overlapping proposals in resolveProposalCollisions
  // =========================================================================
  describe("Category 3: Complex chained overlapping proposals in resolveProposalCollisions", () => {
    it("3.1 alternating overlapping chain (domino cascade)", () => {
      // P1: [0, 10], P2: [5, 15], P3: [12, 20], P4: [18, 25], P5: [22, 30], P6: [35, 45]
      const props = [
        makeProposal("p1", 1, 0, 10),
        makeProposal("p2", 1, 5, 15),
        makeProposal("p3", 1, 12, 20),
        makeProposal("p4", 1, 18, 25),
        makeProposal("p5", 1, 22, 30),
        makeProposal("p6", 1, 35, 45),
      ];

      const { valid, conflicts } = resolveProposalCollisions(props);

      // P1 is valid: [0, 10]
      // P2 collides with P1: conflict
      // P3 [12, 20] does NOT collide with P1: valid
      // P4 [18, 25] collides with P3 [12, 20]: conflict
      // P5 [22, 30] does NOT collide with P3: valid
      // P6 [35, 45] does NOT collide with P5: valid
      expect(valid.map((p) => p.id)).toEqual(["p1", "p3", "p5", "p6"]);
      expect(conflicts.map((p) => p.id)).toEqual(["p2", "p4"]);
    });

    it("3.2 matryoshka enclosure: giant proposal containing multiple nested sub-proposals", () => {
      const props = [
        makeProposal("giant", 2, 0, 100),
        makeProposal("sub1", 2, 10, 20),
        makeProposal("sub2", 2, 30, 40),
        makeProposal("sub3", 2, 70, 90),
        makeProposal("abutting", 2, 100, 120), // strictly abutting at 100
        makeProposal("distant", 2, 150, 160),
      ];

      const { valid, conflicts } = resolveProposalCollisions(props);
      expect(valid.map((p) => p.id)).toEqual(["giant", "abutting", "distant"]);
      expect(conflicts.map((p) => p.id)).toEqual(["sub1", "sub2", "sub3"]);
    });

    it("3.3 unsorted input ordering: later earlier-column candidate collides with earlier proposal", () => {
      // P1 is at [50, 60]
      // P2 arrives at [10, 20]
      // P3 arrives at [15, 25] (collides with P2)
      // P4 arrives at [0, 5] (clean)
      const props = [
        makeProposal("p1", 1, 50, 60),
        makeProposal("p2", 1, 10, 20),
        makeProposal("p3", 1, 15, 25),
        makeProposal("p4", 1, 0, 5),
      ];

      const { valid, conflicts } = resolveProposalCollisions(props);
      expect(valid.map((p) => p.id)).toEqual(["p1", "p2", "p4"]);
      expect(conflicts.map((p) => p.id)).toEqual(["p3"]);
    });

    it("3.4 multi-file and multi-line isolation in complex chain", () => {
      const props = [
        makeProposal("f1-l1", 1, 0, 10, "text", "rep", "Doc1.md"),
        makeProposal("f1-l1-dup", 1, 5, 15, "text", "rep", "Doc1.md"), // collides
        makeProposal("f2-l1", 1, 5, 15, "text", "rep", "Doc2.md"),     // different file: valid!
        makeProposal("f1-l2", 2, 5, 15, "text", "rep", "Doc1.md"),     // different line: valid!
      ];

      const { valid, conflicts } = resolveProposalCollisions(props);
      expect(valid.map((p) => p.id)).toEqual(["f1-l1", "f2-l1", "f1-l2"]);
      expect(conflicts.map((p) => p.id)).toEqual(["f1-l1-dup"]);
    });
  });

  // =========================================================================
  // CATEGORY 4: Pure zero-length insertions
  // =========================================================================
  describe("Category 4: Pure zero-length insertions", () => {
    it("4.1 two pure insertions at exact same point collide", () => {
      expect(hasIntervalCollision({ from: 10, to: 10 }, { from: 10, to: 10 })).toBe(true);
      expect(hasIntervalCollision({ from: 0, to: 0 }, { from: 0, to: 0 })).toBe(true);
    });

    it("4.2 two pure insertions at different points do not collide", () => {
      expect(hasIntervalCollision({ from: 10, to: 10 }, { from: 11, to: 11 })).toBe(false);
      expect(hasIntervalCollision({ from: 0, to: 0 }, { from: 1, to: 1 })).toBe(false);
    });

    it("4.3 pure insertion strictly inside interval collides", () => {
      expect(hasIntervalCollision({ from: 10, to: 20 }, { from: 15, to: 15 })).toBe(true);
      expect(hasIntervalCollision({ from: 15, to: 15 }, { from: 10, to: 20 })).toBe(true);
    });

    it("4.4 pure insertion abutting interval boundary does NOT collide", () => {
      // Abutting start
      expect(hasIntervalCollision({ from: 10, to: 20 }, { from: 10, to: 10 })).toBe(false);
      expect(hasIntervalCollision({ from: 10, to: 10 }, { from: 10, to: 20 })).toBe(false);

      // Abutting end
      expect(hasIntervalCollision({ from: 10, to: 20 }, { from: 20, to: 20 })).toBe(false);
      expect(hasIntervalCollision({ from: 20, to: 20 }, { from: 10, to: 20 })).toBe(false);
    });

    it("4.5 resolveProposalCollisions handles multiple pure insertions and ranges", () => {
      const props = [
        makeProposal("p-range", 1, 10, 20),
        makeProposal("p-ins-inside", 1, 15, 15, "", "insert"), // collides with range
        makeProposal("p-ins-start", 1, 10, 10, "", "insert"),  // abuts start: valid
        makeProposal("p-ins-end", 1, 20, 20, "", "insert"),    // abuts end: valid
        makeProposal("p-ins-start-dup", 1, 10, 10, "", "dup"), // collides with p-ins-start!
      ];

      const { valid, conflicts } = resolveProposalCollisions(props);
      expect(valid.map((p) => p.id)).toEqual(["p-range", "p-ins-start", "p-ins-end"]);
      expect(conflicts.map((p) => p.id)).toEqual(["p-ins-inside", "p-ins-start-dup"]);
    });

    it("4.6 shiftProposalsAfterAcceptance: shifts proposals after accepted pure insertion", () => {
      // Pure insertion at line 3, column 5 of "HELLO" (len 5)
      const accepted = makeProposal("acc-ins", 3, 5, 5, "", "HELLO");

      const pBefore = makeProposal("p-before", 3, 0, 4);
      const pAfter = makeProposal("p-after", 3, 5, 10);
      const pNextLine = makeProposal("p-next", 4, 0, 5);

      const shifted = shiftProposalsAfterAcceptance([pBefore, pAfter, pNextLine], accepted);

      // pBefore untouched
      expect(shifted.find((p) => p.id === "p-before")?.ch).toBe(0);

      // pAfter shifted horizontally by +5
      const resAfter = shifted.find((p) => p.id === "p-after");
      expect(resAfter?.ch).toBe(10);
      expect(resAfter?.toCh).toBe(15);

      // pNextLine line unchanged (K=0)
      expect(shifted.find((p) => p.id === "p-next")?.line).toBe(4);
    });

    it("4.7 shiftProposalsAfterAcceptance: handles competing pure insertion at the exact same point", () => {
      const accepted = makeProposal("acc-ins", 3, 5, 5, "", "HELLO");
      const competing = makeProposal("competing-ins", 3, 5, 5, "", "WORLD");
      const shifted = shiftProposalsAfterAcceptance([competing], accepted);
      // We empirically verify whether competing insertion at same point was marked conflict or treated as preceding
      // Observation: line 316 (pTo <= accFromCh) treats 5 <= 5 as true, so it is pushed as pending at ch: 5
      expect(shifted[0].status).toBe("pending");
      expect(shifted[0].ch).toBe(5);
    });
  });

  // =========================================================================
  // CATEGORY 5: Abutting intervals
  // =========================================================================
  describe("Category 5: Abutting intervals", () => {
    it("5.1 strictly abutting intervals do not collide in hasIntervalCollision", () => {
      expect(hasIntervalCollision({ from: 0, to: 10 }, { from: 10, to: 20 })).toBe(false);
      expect(hasIntervalCollision({ from: 10, to: 20 }, { from: 0, to: 10 })).toBe(false);
      expect(hasIntervalCollision({ from: 5, to: 6 }, { from: 6, to: 7 })).toBe(false);
    });

    it("5.2 chained contiguous abutting intervals all remain valid", () => {
      const props = [
        makeProposal("p1", 1, 0, 5),
        makeProposal("p2", 1, 5, 10),
        makeProposal("p3", 1, 10, 15),
        makeProposal("p4", 1, 15, 20),
        makeProposal("p5", 1, 20, 25),
      ];

      const { valid, conflicts } = resolveProposalCollisions(props);
      expect(valid.length).toBe(5);
      expect(conflicts.length).toBe(0);
      expect(valid.map((p) => p.id)).toEqual(["p1", "p2", "p3", "p4", "p5"]);
    });

    it("5.3 shiftProposalsAfterAcceptance correctly handles abutting preceding and succeeding proposals", () => {
      // Accepted: line 2, [10, 20], original len 10, replacement len 15 (deltaCh = +5)
      const accepted = makeProposal(
        "p-acc",
        2,
        10,
        20,
        "0123456789",
        "0123456789ABCDE"
      );

      // Preceding proposal strictly abutting: [0, 10]
      const pAbutPreceding = makeProposal("p-abut-prec", 2, 0, 10);

      // Succeeding proposal strictly abutting: [20, 30]
      const pAbutSucceeding = makeProposal("p-abut-succ", 2, 20, 30);

      const shifted = shiftProposalsAfterAcceptance(
        [pAbutPreceding, pAbutSucceeding],
        accepted
      );

      const precRes = shifted.find((p) => p.id === "p-abut-prec");
      expect(precRes).toBeDefined();
      expect(precRes?.status).toBe("pending");
      expect(precRes?.ch).toBe(0);
      expect(precRes?.toCh).toBe(10); // Untouched

      const succRes = shifted.find((p) => p.id === "p-abut-succ");
      expect(succRes).toBeDefined();
      expect(succRes?.status).toBe("pending");
      // [20, 30] + deltaCh (+5) -> [25, 35]
      expect(succRes?.ch).toBe(25);
      expect(succRes?.toCh).toBe(35);
    });
  });

  // =========================================================================
  // CATEGORY 6: findClosestOccurrence & Neighborhood Scan (+/- 5 lines)
  // =========================================================================
  describe("Category 6: findClosestOccurrence and findInNeighborhood", () => {
    const documentLines = [
      "# Title",                       // Line 1
      "",                               // Line 2
      "This is line three.",            // Line 3
      "A quick brown fox jumped.",      // Line 4
      "Middle line anchor target.",     // Line 5
      "Below the middle line.",         // Line 6
      "Another paragraph here.",        // Line 7
      "Seventh line drifted text.",     // Line 8
      "Ninth line marker.",             // Line 9
      "Tenth line boundary.",           // Line 10
      "Far line eleven outside radius", // Line 11
    ];

    it("6.1 findClosestOccurrence returns -1 when target is absent from line", () => {
      const idx = findClosestOccurrence("Hello world", "missing_needle", 0);
      expect(idx).toBe(-1);
    });

    it("6.2 findInNeighborhood locates target on line +1 and -1 (radius 1)", () => {
      // Expected line 5, but text is on line 6 ("Below the middle line.")
      const matchPlus1 = findInNeighborhood(documentLines, "Below the middle", 5, 0, 5);
      expect(matchPlus1).not.toBeNull();
      expect(matchPlus1?.line).toBe(6);
      expect(matchPlus1?.distance).toBe(1);
      expect(matchPlus1?.matchType).toBe("snapped-neighbor");

      // Expected line 5, but text is on line 4 ("A quick brown fox")
      const matchMinus1 = findInNeighborhood(documentLines, "A quick brown fox", 5, 0, 5);
      expect(matchMinus1).not.toBeNull();
      expect(matchMinus1?.line).toBe(4);
      expect(matchMinus1?.distance).toBe(-1);
      expect(matchMinus1?.matchType).toBe("snapped-neighbor");
    });

    it("6.3 findInNeighborhood walks all the way up to +/- 5 lines boundary", () => {
      // Expected line 5:
      // Line 5 + 5 = Line 10 ("Tenth line boundary.")
      const matchPlus5 = findInNeighborhood(documentLines, "Tenth line", 5, 0, 5);
      expect(matchPlus5).not.toBeNull();
      expect(matchPlus5?.line).toBe(10);
      expect(matchPlus5?.distance).toBe(5);

      // Line 5 - 4 = Line 1 ("# Title")
      const matchMinus4 = findInNeighborhood(documentLines, "# Title", 5, 0, 5);
      expect(matchMinus4).not.toBeNull();
      expect(matchMinus4?.line).toBe(1);
      expect(matchMinus4?.distance).toBe(-4);
    });

    it("6.4 findInNeighborhood fails safely when target is at +/- 6 lines (beyond radius 5)", () => {
      // Expected line 5, target on line 11 (distance +6)
      const matchBeyond = findInNeighborhood(
        documentLines,
        "Far line eleven outside radius",
        5,
        0,
        5
      );
      expect(matchBeyond).toBeNull();

      // With custom radius 6, it should be found
      const matchWithExpandedRadius = findInNeighborhood(
        documentLines,
        "Far line eleven outside radius",
        5,
        0,
        6
      );
      expect(matchWithExpandedRadius).not.toBeNull();
      expect(matchWithExpandedRadius?.line).toBe(11);
      expect(matchWithExpandedRadius?.distance).toBe(6);
    });

    it("6.5 findInNeighborhood handles boundary expectedLine (line 1 and past end)", () => {
      // Expected line 1, searches upwards (line <= 0) which are out of bounds
      const matchFromTop = findInNeighborhood(documentLines, "This is line three.", 1, 0, 5);
      expect(matchFromTop).not.toBeNull();
      expect(matchFromTop?.line).toBe(3);
      expect(matchFromTop?.distance).toBe(2);

      // Expected line 15 (beyond documentLines.length = 11), searches downwards
      const matchFromPastEnd = findInNeighborhood(documentLines, "Tenth line", 15, 0, 5);
      expect(matchFromPastEnd).not.toBeNull();
      expect(matchFromPastEnd?.line).toBe(10);
      expect(matchFromPastEnd?.distance).toBe(-5);
    });

    it("6.6 findClosestOccurrence handles regex metacharacters in target cleanly", () => {
      const lineWithSpecial = "Look at pattern: (a+b)* [test]? ^hello$ \\path";
      expect(findClosestOccurrence(lineWithSpecial, "(a+b)*", 0)).toBe(17);
      expect(findClosestOccurrence(lineWithSpecial, "[test]?", 0)).toBe(24);
      expect(findClosestOccurrence(lineWithSpecial, "^hello$", 0)).toBe(32);
      expect(findClosestOccurrence(lineWithSpecial, "\\path", 0)).toBe(40);
    });

    it("6.7 findInNeighborhood tie-breaking: prefers downward (+dir) when equidistant", () => {
      // Suppose same text appears on line 4 and line 6, expectedLine is 5
      const linesWithDuplicate = [
        "other",
        "other",
        "other",
        "duplicate target", // Line 4 (-1)
        "anchor",           // Line 5 (0)
        "duplicate target", // Line 6 (+1)
        "other",
      ];
      const match = findInNeighborhood(linesWithDuplicate, "duplicate target", 5, 0, 5);
      // Because outward scan loops: dir in [1, -1], line 6 (+1) is checked before line 4 (-1)
      expect(match).not.toBeNull();
      expect(match?.line).toBe(6);
      expect(match?.distance).toBe(1);
    });
  });

  // =========================================================================
  // ADDITIONAL ADVERSARIAL STRESS CASES
  // =========================================================================
  describe("Additional Edge & Invariant Stress Tests", () => {
    it("normalizeRawProposalItem defaults to valid interval when toCh < ch", () => {
      const normalized = normalizeRawProposalItem(
        {
          id: "prop-invalid-coords",
          file: "note.md",
          line: 3,
          ch: 10,
          toCh: 5, // inverted: toCh < ch
          original: "hello",
        },
        "source.json"
      );

      expect(normalized).not.toBeNull();
      // Should self-heal to ch + original.length = 10 + 5 = 15
      expect(normalized?.ch).toBe(10);
      expect(normalized?.toCh).toBe(15);
    });

    it("hasIntervalCollision normalizes inverted bounds gracefully", () => {
      // a: from=20, to=10 (inverted) should behave identical to [10, 20]
      expect(hasIntervalCollision({ from: 20, to: 10 }, { from: 15, to: 25 })).toBe(true);
      expect(hasIntervalCollision({ from: 20, to: 10 }, { from: 0, to: 5 })).toBe(false);
      expect(hasIntervalCollision({ from: 20, to: 10 }, { from: 10, to: 10 })).toBe(false); // abutting
    });
  });

  // =========================================================================
  // CATEGORY 7: Adversarial Reactive Store Concurrency & Multi-Buffer Edge Cases
  // =========================================================================
  describe("Category 7: Adversarial Reactive Store Concurrency & Multi-Buffer Edge Cases", () => {
    it("7.1 Trailing-edge debounce: captures external modifications written during 350ms cooldown window", async () => {
      vi.useFakeTimers();
      const mockApp = new MockApp();
      const vault = mockApp.vault;
      const store = new ProposalStore(mockApp as unknown as App);
      await store.initialize();

      try {
        const noteFile = vault.seedFile("Notes/DebounceDoc.md", "Original text\ncontent on line 2");
        const bufferFile = vault.seedFile(
          "ai_suggestion-cooldown.json",
          JSON.stringify([
            { id: "p-first", file: "Notes/DebounceDoc.md", line: 1, ch: 0, toCh: 8, original: "Original", replacement: "Updated" },
            { id: "p-second", file: "Notes/DebounceDoc.md", line: 2, ch: 0, toCh: 7, original: "content", replacement: "material" },
          ])
        );

        await store.scanVaultBuffers();
        expect(store.getAllProposals().length).toBe(2);

        // Accept first proposal, activating write-lock on note and buffer
        const acceptOk = await store.acceptProposal("p-first");
        expect(acceptOk).toBe(true);
        expect(await vault.read(noteFile)).toBe("Updated text\ncontent on line 2");

        // Simulate an external AI process writing an additional proposal at t = 100ms (during 350ms cooldown)
        vi.advanceTimersByTime(100);
        const externalUpdatedPayload = [
          { id: "p-second", file: "Notes/DebounceDoc.md", line: 2, ch: 0, toCh: 7, original: "content", replacement: "material" },
          { id: "p-external", file: "Notes/DebounceDoc.md", line: 2, ch: 11, toCh: 15, original: "line", replacement: "row" },
        ];
        await vault.modify(bufferFile, JSON.stringify(externalUpdatedPayload, null, 2));

        // Prior to t = 350ms, the modification should be debounced
        await vi.advanceTimersByTimeAsync(200); // Now t = 300ms, still in cooldown
        expect(store.getAllProposals().some((p) => p.id === "p-external")).toBe(false);

        // Advance past 350ms cooldown to t = 360ms: trailing-edge debounce must trigger scanVaultBuffers
        await vi.advanceTimersByTimeAsync(60); // Now t = 360ms
        const allProposalsAfter = store.getAllProposals();
        expect(allProposalsAfter.some((p) => p.id === "p-external")).toBe(true);
      } finally {
        store.dispose();
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    });

    it("7.2 Cross-buffer duplicate IDs: rejecting a proposal does not purge matching IDs in other buffer files", async () => {
      const mockApp = new MockApp();
      const vault = mockApp.vault;
      const store = new ProposalStore(mockApp as unknown as App);
      await store.initialize();

      try {
        vault.seedFile("Notes/NoteA.md", "Target A content");
        vault.seedFile("Notes/NoteB.md", "Target B content");

        vault.seedFile(
          "ai_suggestion-dup1.json",
          JSON.stringify([
            { id: "duplicate-id", file: "Notes/NoteA.md", line: 1, original: "Target A", replacement: "New A" },
          ])
        );
        const buf2 = vault.seedFile(
          "ai_suggestion-dup2.json",
          JSON.stringify([
            { id: "duplicate-id", file: "Notes/NoteB.md", line: 1, original: "Target B", replacement: "New B" },
          ])
        );

        const loaded = await store.scanVaultBuffers();
        expect(loaded.length).toBe(2);

        // Find compound IDs
        const propA = loaded.find((p) => p.file === "Notes/NoteA.md");
        const propB = loaded.find((p) => p.file === "Notes/NoteB.md");
        expect(propA).toBeDefined();
        expect(propB).toBeDefined();
        expect(propA?.compoundId).toMatch(/^ai_suggestion-dup1\.json::duplicate-id/);
        expect(propB?.compoundId).toMatch(/^ai_suggestion-dup2\.json::duplicate-id/);

        // Reject proposal from buffer 1 using compoundId
        const rejectOk = await store.rejectProposal(propA!.compoundId!);
        expect(rejectOk).toBe(true);

        // Buffer 1 proposal removed from store
        expect(store.getProposalById(propA!.compoundId!)).toBeUndefined();

        // Buffer 2 proposal MUST remain in store in-memory state
        const remainingB = store.getProposalById(propB!.compoundId!);
        expect(remainingB).toBeDefined();
        expect(remainingB?.file).toBe("Notes/NoteB.md");
        expect(remainingB?.status).toBe("pending");

        // Buffer 2 file on disk MUST still exist and contain the proposal
        const buf2Content = await vault.read(buf2);
        expect(buf2Content).toContain("duplicate-id");
        expect(buf2Content).toContain("Target B");

        // Buffer 1 file was emptied and deleted (deleteEmptyBufferFiles: true)
        expect(vault.getAbstractFileByPath("ai_suggestion-dup1.json")).toBeNull();
      } finally {
        store.dispose();
      }
    });

    it("7.3 Sibling proposals in same buffer: accepting one does not delete siblings sharing an ID", async () => {
      const mockApp = new MockApp();
      const vault = mockApp.vault;
      const store = new ProposalStore(mockApp as unknown as App);
      await store.initialize();

      try {
        const note = vault.seedFile(
          "Notes/SiblingDoc.md",
          "First target on line 1\nSecond neutral line\nThird target on line 3"
        );

        const siblingBuffer = vault.seedFile(
          "ai_suggestion-siblings.json",
          JSON.stringify([
            { id: "same-id", file: "Notes/SiblingDoc.md", line: 1, ch: 0, original: "First target", replacement: "First applied" },
            { id: "same-id", file: "Notes/SiblingDoc.md", line: 3, ch: 0, original: "Third target", replacement: "Third applied" },
          ])
        );

        const loaded = await store.scanVaultBuffers();
        expect(loaded.length).toBe(2);

        // Both proposals are loaded
        const [firstProp, secondProp] = loaded;
        expect(firstProp.line).toBe(1);
        expect(secondProp.line).toBe(3);

        // Accept first proposal
        const accept1Ok = await store.acceptProposal(firstProp.compoundId ?? firstProp.id);
        expect(accept1Ok).toBe(true);

        // Note content on line 1 mutated
        expect(await vault.read(note)).toBe(
          "First applied on line 1\nSecond neutral line\nThird target on line 3"
        );

        // Buffer file on disk MUST NOT be deleted and MUST still contain second proposal
        const remainingDiskContent = await vault.read(siblingBuffer);
        const parsedDisk = JSON.parse(remainingDiskContent);
        expect(parsedDisk.length).toBe(1);
        expect(parsedDisk[0].line).toBe(3);
        expect(parsedDisk[0].original).toBe("Third target");

        // Second proposal is still pending in-memory
        const pendingProps = store.getAllProposals();
        expect(pendingProps.length).toBe(1);
        expect(pendingProps[0].original).toBe("Third target");

        // Now accept the second proposal
        const accept2Ok = await store.acceptProposal(pendingProps[0].compoundId ?? pendingProps[0].id);
        expect(accept2Ok).toBe(true);

        // Note completely updated
        expect(await vault.read(note)).toBe(
          "First applied on line 1\nSecond neutral line\nThird applied on line 3"
        );

        // Buffer file emptied and deleted
        expect(vault.getAbstractFileByPath("ai_suggestion-siblings.json")).toBeNull();
      } finally {
        store.dispose();
      }
    });
  });
});
