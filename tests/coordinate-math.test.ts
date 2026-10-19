import { describe, it, expect } from "vitest";
import {
  calculateDeltaShift,
  findClosestOccurrence,
  findInNeighborhood,
  shiftProposalsAfterAcceptance,
} from "@/store/coordinate-math";
import type { Proposal } from "@/types";

describe("Milestone 2: Coordinate Math Engine", () => {
  describe("calculateDeltaShift", () => {
    it("calculates single-line intra-line insertion delta", () => {
      const shift = calculateDeltaShift("cat", "kitten");
      expect(shift.deltaLines).toBe(0);
      expect(shift.deltaCh).toBe(3);
    });

    it("calculates single-line intra-line deletion delta", () => {
      const shift = calculateDeltaShift("supercalifragilistic", "short");
      expect(shift.deltaLines).toBe(0);
      expect(shift.deltaCh).toBe(-15);
    });

    it("handles zero-delta identity replacement", () => {
      const shift = calculateDeltaShift("identical", "identical");
      expect(shift.deltaLines).toBe(0);
      expect(shift.deltaCh).toBe(0);
    });

    it("handles pure insertion (empty original)", () => {
      const shift = calculateDeltaShift("", "inserted");
      expect(shift.deltaLines).toBe(0);
      expect(shift.deltaCh).toBe(8);
    });

    it("handles pure deletion (empty replacement)", () => {
      const shift = calculateDeltaShift("deleted", "");
      expect(shift.deltaLines).toBe(0);
      expect(shift.deltaCh).toBe(-7);
    });

    it("handles double empty boundary", () => {
      const shift = calculateDeltaShift("", "");
      expect(shift.deltaLines).toBe(0);
      expect(shift.deltaCh).toBe(0);
    });

    it("calculates multi-line replacement expansion (1 line to 5 lines)", () => {
      const shift = calculateDeltaShift("single", "line1\nline2\nline3\nline4\nline5");
      expect(shift.deltaLines).toBe(4);
    });

    it("calculates multi-line replacement shrinkage (5 lines to 1 line)", () => {
      const shift = calculateDeltaShift("line1\nline2\nline3\nline4\nline5", "single");
      expect(shift.deltaLines).toBe(-4);
    });

    it("calculates multi-line to multi-line expansion", () => {
      const shift = calculateDeltaShift("a\nb\nc", "1\n2\n3\n4\n5");
      expect(shift.deltaLines).toBe(2);
    });

    it("handles trailing newline variations cleanly", () => {
      const shiftWithTrailing = calculateDeltaShift("foo", "foo\n");
      expect(shiftWithTrailing.deltaLines).toBe(1);

      const shiftFromTrailing = calculateDeltaShift("foo\n", "foo");
      expect(shiftFromTrailing.deltaLines).toBe(-1);
    });

    it("correctly counts surrogate pairs for multi-byte emoji", () => {
      // "😀" (surrogate pair) length is 2, "🔥🚀" (two surrogate pairs) length is 4
      const shift = calculateDeltaShift("😀", "🔥🚀");
      expect(shift.deltaLines).toBe(0);
      expect(shift.deltaCh).toBe(2);
    });
  });

  describe("findClosestOccurrence", () => {
    it("locates exact match at expectedCh", () => {
      const pos = findClosestOccurrence("The quick brown fox", "quick", 4);
      expect(pos).toBe(4);
    });

    it("snaps to match with leading whitespace drift", () => {
      const pos = findClosestOccurrence("   The quick brown fox", "quick", 4);
      expect(pos).toBe(7);
    });

    it("snaps to match with leftward drift", () => {
      const pos = findClosestOccurrence("quick brown fox", "quick", 4);
      expect(pos).toBe(0);
    });

    it("disambiguates multiple identical occurrences by selecting closest", () => {
      const line = "cat dog cat fish cat";
      expect(findClosestOccurrence(line, "cat", 0)).toBe(0);
      expect(findClosestOccurrence(line, "cat", 7)).toBe(8);
      expect(findClosestOccurrence(line, "cat", 16)).toBe(17);
    });

    it("breaks ties deterministically when equidistant (prefers earlier index)", () => {
      const line = "cat and cat"; // occurrences at 0 and 8, distance to 4 is 4
      expect(findClosestOccurrence(line, "cat", 4)).toBe(0);
    });

    it("safely matches needles with regex/markdown metacharacters", () => {
      expect(findClosestOccurrence("See **bold** text", "**bold**", 4)).toBe(4);
      expect(findClosestOccurrence("Link [[Wiki Link]]", "[[Wiki Link]]", 5)).toBe(5);
      expect(findClosestOccurrence("- [x] done", "[x]", 2)).toBe(2);
    });

    it("returns -1 when needle does not exist", () => {
      expect(findClosestOccurrence("Hello world", "missing", 0)).toBe(-1);
      expect(findClosestOccurrence("", "needle", 0)).toBe(-1);
    });

    it("handles empty target clamped to expectedCh", () => {
      expect(findClosestOccurrence("some text", "", 5)).toBe(5);
    });

    it("clamps negative expectedCh when searching", () => {
      expect(findClosestOccurrence("target here", "target", -10)).toBe(0);
    });

    it("handles oversized expectedCh when searching", () => {
      expect(findClosestOccurrence("target here", "target", 999)).toBe(0);
    });
  });

  describe("findInNeighborhood", () => {
    const lines = [
      "---",
      "title: Test Note",
      "author: Mikolaj",
      "---",
      "",
      "# Header",
      "The quick brown fox jumps over the lazy dog.",
      "Another paragraph follows.",
    ];

    it("matches exact expected line when text is present", () => {
      const match = findInNeighborhood(lines, "The quick brown fox", 7, 0);
      expect(match).not.toBeNull();
      expect(match?.line).toBe(7);
      expect(match?.ch).toBe(0);
      expect(match?.matchType).toBe("exact");
    });

    it("recovers anchor drifted by frontmatter insertion", () => {
      // Suppose original expected line was 4 before frontmatter was added
      const match = findInNeighborhood(lines, "The quick brown fox", 4, 0, 5);
      expect(match).not.toBeNull();
      expect(match?.line).toBe(7);
      expect(match?.matchType).toBe("snapped-neighbor");
      expect(match?.distance).toBe(3);
    });

    it("returns null if target is not found within scan radius", () => {
      const match = findInNeighborhood(lines, "nonexistent text", 5, 0, 5);
      expect(match).toBeNull();
    });

    it("returns null for empty target", () => {
      const match = findInNeighborhood(lines, "", 1, 0, 5);
      expect(match).toBeNull();
    });
  });

  describe("shiftProposalsAfterAcceptance", () => {
    const baseProposal: Proposal = {
      id: "p-target",
      file: "Notes/Doc.md",
      sourceFile: "ai_suggestion-1.json",
      line: 5,
      ch: 10,
      toCh: 16,
      original: "middle",
      replacement: "expanded_middle",
      status: "pending",
    };

    it("leaves proposals on earlier lines unaltered", () => {
      const pEarlier: Proposal = {
        ...baseProposal,
        id: "p-earlier",
        line: 2,
        ch: 5,
        toCh: 10,
      };
      const shifted = shiftProposalsAfterAcceptance([pEarlier], baseProposal);
      expect(shifted[0].line).toBe(2);
      expect(shifted[0].ch).toBe(5);
    });

    it("leaves proposals on same line preceding replacement unaltered", () => {
      const pPreceding: Proposal = {
        ...baseProposal,
        id: "p-preceding",
        line: 5,
        ch: 0,
        toCh: 5,
        original: "start",
        replacement: "start",
      };
      const shifted = shiftProposalsAfterAcceptance([pPreceding], baseProposal);
      expect(shifted[0].line).toBe(5);
      expect(shifted[0].ch).toBe(0);
    });

    it("shifts proposals on same line following single-line replacement horizontally", () => {
      // baseProposal: line 5, ch: 10, toCh: 16, original: "middle" (len 6), replacement: "expanded_middle" (len 15) -> deltaCh = +9
      const pSubsequent: Proposal = {
        ...baseProposal,
        id: "p-subsequent",
        line: 5,
        ch: 25,
        toCh: 30,
      };
      const shifted = shiftProposalsAfterAcceptance([pSubsequent], baseProposal);
      expect(shifted[0].line).toBe(5);
      expect(shifted[0].ch).toBe(34); // 25 + 9
      expect(shifted[0].toCh).toBe(39); // 30 + 9
    });

    it("shifts proposals on same line following shrinkage horizontally", () => {
      const shrinkProposal: Proposal = {
        ...baseProposal,
        original: "super_long_text", // len 15
        replacement: "short",          // len 5 -> deltaCh = -10
        ch: 5,
        toCh: 20,
      };
      const pSubsequent: Proposal = {
        ...baseProposal,
        id: "p-subsequent-shrink",
        line: 5,
        ch: 30,
        toCh: 35,
      };
      const shifted = shiftProposalsAfterAcceptance([pSubsequent], shrinkProposal);
      expect(shifted[0].line).toBe(5);
      expect(shifted[0].ch).toBe(20); // 30 - 10
      expect(shifted[0].toCh).toBe(25);
    });

    it("shifts proposals on subsequent lines down when replacement adds newlines", () => {
      const multiLineProposal: Proposal = {
        ...baseProposal,
        replacement: "line1\nline2\nline3", // deltaLines = 2
      };
      const pSubsequentLine: Proposal = {
        ...baseProposal,
        id: "p-subsequent-line",
        line: 10,
        ch: 4,
        toCh: 9,
      };
      const shifted = shiftProposalsAfterAcceptance([pSubsequentLine], multiLineProposal);
      expect(shifted[0].line).toBe(12);
      expect(shifted[0].ch).toBe(4);
    });

    it("shifts proposals on subsequent lines up when replacement removes lines", () => {
      const shrinkLineProposal: Proposal = {
        ...baseProposal,
        original: "l1\nl2\nl3\nl4\nl5", // 5 lines
        replacement: "single",           // 1 line -> deltaLines = -4
      };
      const pSubsequentLine: Proposal = {
        ...baseProposal,
        id: "p-subsequent-line-up",
        line: 10,
        ch: 4,
        toCh: 9,
      };
      const shifted = shiftProposalsAfterAcceptance([pSubsequentLine], shrinkLineProposal);
      expect(shifted[0].line).toBe(6); // 10 - 4
      expect(shifted[0].ch).toBe(4);
    });

    it("correctly shifts subsequent proposal on same line after multi-line split", () => {
      const splitProposal: Proposal = {
        ...baseProposal,
        ch: 0,
        toCh: 5,
        original: "part0", // len 5
        replacement: "part1\npart2", // deltaLines = 1, lastLine = "part2" (len 5)
      };
      const pOnSameLine: Proposal = {
        ...baseProposal,
        id: "p-split-target",
        line: 5,
        ch: 10, // 5 chars after part0
        toCh: 15,
      };
      const shifted = shiftProposalsAfterAcceptance([pOnSameLine], splitProposal);
      expect(shifted[0].line).toBe(6);
      expect(shifted[0].ch).toBe(10); // "part2".length + (10 - 5) = 5 + 5 = 10
    });

    it("marks overlapping proposals on anchor line as conflict", () => {
      const pOverlap: Proposal = {
        ...baseProposal,
        id: "p-overlap",
        line: 5,
        ch: 12, // overlaps baseProposal [10, 16]
        toCh: 20,
      };
      const shifted = shiftProposalsAfterAcceptance([pOverlap], baseProposal);
      expect(shifted[0].status).toBe("conflict");
      expect(shifted[0].rejectionReason).toContain("Overlapped");
    });

    it("marks intermediate proposals inside multi-line original as conflict", () => {
      const multiLineOriginalProposal: Proposal = {
        ...baseProposal,
        line: 5,
        original: "l1\nl2\nl3", // lines 5, 6, 7
        replacement: "replaced",
      };
      const pIntermediate: Proposal = {
        ...baseProposal,
        id: "p-intermediate",
        line: 6,
        ch: 0,
        toCh: 5,
      };
      const shifted = shiftProposalsAfterAcceptance([pIntermediate], multiLineOriginalProposal);
      expect(shifted[0].status).toBe("conflict");
    });

    it("synchronizes absolute document offsets (resolvedFrom/resolvedTo)", () => {
      const pWithOffsets: Proposal = {
        ...baseProposal,
        id: "p-offsets",
        line: 8,
        ch: 0,
        toCh: 5,
        resolvedFrom: 100,
        resolvedTo: 105,
      };
      // baseProposal replacement: "expanded_middle" (15) - "middle" (6) = +9 chars
      const shifted = shiftProposalsAfterAcceptance([pWithOffsets], baseProposal);
      expect(shifted[0].resolvedFrom).toBe(109);
      expect(shifted[0].resolvedTo).toBe(114);
    });

    it("leaves proposals for other files untouched", () => {
      const otherFileProposal: Proposal = {
        ...baseProposal,
        id: "p-other-file",
        file: "Notes/Other.md",
        line: 5,
        ch: 25,
        toCh: 30,
      };
      const shifted = shiftProposalsAfterAcceptance([otherFileProposal], baseProposal);
      expect(shifted[0].ch).toBe(25);
    });

    it("omits the accepted proposal itself from the output", () => {
      const remaining = shiftProposalsAfterAcceptance([baseProposal], baseProposal);
      expect(remaining.length).toBe(0);
    });
  });
});
