import { describe, it, expect } from "vitest";
import {
  hasIntervalCollision,
  resolveProposalCollisions,
} from "@/store/coordinate-math";
import type { Proposal } from "@/types";

describe("Milestone 2: Interval Collision Engine", () => {
  describe("hasIntervalCollision", () => {
    it("returns false for non-overlapping intervals (A before B)", () => {
      expect(hasIntervalCollision({ from: 0, to: 5 }, { from: 10, to: 15 })).toBe(false);
    });

    it("returns false for non-overlapping intervals (B before A)", () => {
      expect(hasIntervalCollision({ from: 10, to: 15 }, { from: 0, to: 5 })).toBe(false);
    });

    it("returns false for abutting/adjacent intervals (touching boundaries)", () => {
      expect(hasIntervalCollision({ from: 5, to: 10 }, { from: 10, to: 15 })).toBe(false);
      expect(hasIntervalCollision({ from: 10, to: 15 }, { from: 5, to: 10 })).toBe(false);
    });

    it("returns true for strictly overlapping intervals", () => {
      expect(hasIntervalCollision({ from: 5, to: 12 }, { from: 10, to: 18 })).toBe(true);
      expect(hasIntervalCollision({ from: 10, to: 18 }, { from: 5, to: 12 })).toBe(true);
    });

    it("returns true for identical intervals", () => {
      expect(hasIntervalCollision({ from: 5, to: 15 }, { from: 5, to: 15 })).toBe(true);
    });

    it("returns true for nested intervals (enclosure)", () => {
      expect(hasIntervalCollision({ from: 0, to: 20 }, { from: 5, to: 10 })).toBe(true);
      expect(hasIntervalCollision({ from: 5, to: 10 }, { from: 0, to: 20 })).toBe(true);
    });

    it("returns true for single-character boundary overlap", () => {
      expect(hasIntervalCollision({ from: 0, to: 5 }, { from: 4, to: 10 })).toBe(true);
    });

    it("detects collision for competing zero-length pure insertions at same offset", () => {
      expect(hasIntervalCollision({ from: 5, to: 5 }, { from: 5, to: 5 })).toBe(true);
    });

    it("detects collision when zero-length insertion is strictly inside an interval", () => {
      expect(hasIntervalCollision({ from: 0, to: 10 }, { from: 5, to: 5 })).toBe(true);
    });

    it("allows zero-length insertion abutting the start or end of an interval", () => {
      expect(hasIntervalCollision({ from: 0, to: 5 }, { from: 5, to: 5 })).toBe(false);
      expect(hasIntervalCollision({ from: 5, to: 5 }, { from: 5, to: 10 })).toBe(false);
    });

    it("handles inverted bounds safely via normalization", () => {
      expect(hasIntervalCollision({ from: 15, to: 10 }, { from: 12, to: 20 })).toBe(true);
      expect(hasIntervalCollision({ from: 15, to: 10 }, { from: 0, to: 5 })).toBe(false);
    });
  });

  describe("resolveProposalCollisions", () => {
    const makeProp = (id: string, line: number, from: number, to: number, file = "Notes/Doc.md"): Proposal => ({
      id,
      file,
      sourceFile: "ai_suggestion-1.json",
      line,
      ch: from,
      toCh: to,
      from_ch: from,
      to_ch: to,
      original: "x".repeat(to - from),
      replacement: "y",
      status: "pending",
    });

    it("keeps all proposals valid when on different lines", () => {
      const props = [makeProp("p1", 1, 0, 5), makeProp("p2", 2, 0, 5)];
      const { valid, conflicts } = resolveProposalCollisions(props);
      expect(valid.length).toBe(2);
      expect(conflicts.length).toBe(0);
    });

    it("keeps all proposals valid when disjoint on same line", () => {
      const props = [
        makeProp("p1", 1, 0, 5),
        makeProp("p2", 1, 10, 15),
        makeProp("p3", 1, 20, 25),
      ];
      const { valid, conflicts } = resolveProposalCollisions(props);
      expect(valid.length).toBe(3);
      expect(conflicts.length).toBe(0);
    });

    it("discards second overlapping proposal on same line as conflict", () => {
      const props = [makeProp("p1", 1, 5, 15), makeProp("p2", 1, 10, 20)];
      const { valid, conflicts } = resolveProposalCollisions(props);
      expect(valid.map((p) => p.id)).toEqual(["p1"]);
      expect(conflicts.map((p) => p.id)).toEqual(["p2"]);
      expect(conflicts[0].status).toBe("conflict");
    });

    it("resolves multi-proposal cascade chain (alternating resolution)", () => {
      const props = [
        makeProp("p1", 1, 0, 10),
        makeProp("p2", 1, 5, 15),
        makeProp("p3", 1, 12, 20),
        makeProp("p4", 1, 18, 25),
        makeProp("p5", 1, 30, 40),
      ];
      const { valid, conflicts } = resolveProposalCollisions(props);
      expect(valid.map((p) => p.id)).toEqual(["p1", "p3", "p5"]);
      expect(conflicts.map((p) => p.id)).toEqual(["p2", "p4"]);
    });

    it("isolates proposals across different files so they do not conflict", () => {
      const props = [
        makeProp("p1", 1, 5, 15, "Notes/DocA.md"),
        makeProp("p2", 1, 10, 20, "Notes/DocB.md"),
      ];
      const { valid, conflicts } = resolveProposalCollisions(props);
      expect(valid.length).toBe(2);
      expect(conflicts.length).toBe(0);
    });
  });
});
