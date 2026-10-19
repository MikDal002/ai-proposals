import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { App as MockApp, Vault as MockVault } from "./mocks/obsidian";
import type { App } from "obsidian";
import { ProposalStore } from "@/store/proposal-store";

describe("Milestone 2: Buffer Store & Atomic Mutation Engine", () => {
  let mockApp: MockApp;
  let vault: MockVault;
  let store: ProposalStore;

  beforeEach(async () => {
    vi.useFakeTimers();
    mockApp = new MockApp();
    vault = mockApp.vault;
    store = new ProposalStore(mockApp as unknown as App);
    await store.initialize();
  });

  afterEach(() => {
    store.dispose();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe("Vault Scan & Buffer Discovery", () => {
    it("returns empty array when no buffer files exist", async () => {
      const proposals = await store.scanVaultBuffers();
      expect(proposals).toEqual([]);
    });

    it("discovers and loads multiple ai_suggestion-*.json files", async () => {
      vault.seedFile(
        "ai_suggestion-01.json",
        JSON.stringify([
          { id: "p1", file: "Doc.md", line: 1, original: "old", replacement: "new" },
        ])
      );
      vault.seedFile(
        "ai_suggestion-02.json",
        JSON.stringify([
          { id: "p2", file: "Doc.md", line: 5, original: "foo", replacement: "bar" },
        ])
      );
      vault.seedFile("unrelated.json", JSON.stringify([{ id: "p3" }]));

      const proposals = await store.scanVaultBuffers();
      expect(proposals.length).toBe(2);
      expect(proposals.map((p) => p.id).sort()).toEqual(["p1", "p2"]);
    });

    it("supports legacy _agy_suggestions.json buffer", async () => {
      vault.seedFile(
        "_agy_suggestions.json",
        JSON.stringify([{ id: "p-legacy", file: "Doc.md", line: 1, original: "a", replacement: "b" }])
      );
      const proposals = await store.scanVaultBuffers();
      expect(proposals.some((p) => p.id === "p-legacy")).toBe(true);
    });

    it("normalizes Windows backslashes in proposal file paths", async () => {
      vault.seedFile(
        "ai_suggestion-win.json",
        JSON.stringify([{ id: "p-win", file: "Notes\\Sub\\Doc.md", line: 1, original: "a", replacement: "b" }])
      );
      const proposals = await store.scanVaultBuffers();
      expect(proposals[0].file).toBe("Notes/Sub/Doc.md");
    });

    it("handles both array and object-wrapped proposal schemas", async () => {
      vault.seedFile(
        "ai_suggestion-wrapped.json",
        JSON.stringify({
          proposals: [{ id: "p-wrapped", file: "Doc.md", line: 1, original: "a", replacement: "b" }],
        })
      );
      vault.seedFile(
        "ai_suggestion-sugg.json",
        JSON.stringify({
          suggestions: [{ id: "p-sugg", file: "Doc.md", line: 2, original: "x", replacement: "y" }],
        })
      );
      const proposals = await store.scanVaultBuffers();
      expect(proposals.some((p) => p.id === "p-wrapped")).toBe(true);
      expect(proposals.some((p) => p.id === "p-sugg")).toBe(true);
    });

    it("handles file-keyed map schemas", async () => {
      vault.seedFile(
        "ai_suggestion-map.json",
        JSON.stringify({
          "Notes/MapDoc.md": [
            { original: "mapped-orig", replacement: "mapped-rep", line: 1 },
          ],
        })
      );
      const proposals = await store.scanVaultBuffers();
      const mapped = proposals.find((p) => p.file === "Notes/MapDoc.md");
      expect(mapped).toBeDefined();
      expect(mapped?.original).toBe("mapped-orig");
    });

    it("handles 5,000 synthetic proposals fast and stably", async () => {
      const synthetic = Array.from({ length: 5000 }, (_, i) => ({
        id: `synth-${i}`,
        file: `Doc-${i % 10}.md`,
        line: Math.floor(i / 10) + 1,
        original: `word${i}`,
        replacement: `rep${i}`,
      }));
      vault.seedFile("ai_suggestion-bulk.json", JSON.stringify(synthetic));

      const startTime = Date.now();
      const proposals = await store.scanVaultBuffers();
      const duration = Date.now() - startTime;

      expect(proposals.length).toBe(5000);
      expect(duration).toBeLessThan(1000);
    });
  });

  describe("Resilience Against Corrupted Buffers", () => {
    it("safely ignores malformed JSON without crashing store", async () => {
      vault.seedFile("ai_suggestion-corrupt.json", '[ { "id": "broken",');
      vault.seedFile(
        "ai_suggestion-valid.json",
        JSON.stringify([{ id: "p-valid", file: "Doc.md", line: 1, original: "a", replacement: "b" }])
      );

      const proposals = await store.scanVaultBuffers();
      expect(proposals.length).toBe(1);
      expect(proposals[0].id).toBe("p-valid");
    });

    it("handles 0-byte buffer files safely", async () => {
      vault.seedFile("ai_suggestion-empty.json", "");
      const proposals = await store.scanVaultBuffers();
      expect(proposals).toEqual([]);
    });

    it("populates sensible defaults for minimal items missing non-essential fields", async () => {
      vault.seedFile(
        "ai_suggestion-min.json",
        JSON.stringify([
          { file: "Doc.md", line: 3, original: "target", replacement: "rep" },
        ])
      );
      const proposals = await store.scanVaultBuffers();
      expect(proposals.length).toBe(1);
      expect(proposals[0].id).toBeDefined();
      expect(proposals[0].ch).toBe(0);
      expect(proposals[0].toCh).toBe(6); // 0 + "target".length
      expect(proposals[0].status).toBe("pending");
    });
  });

  describe("Reactive Vault Event Watching", () => {
    it("updates store and fires listener when a new suggestion file is created", async () => {
      const listenerSpy = vi.fn();
      store.onStoreChange(listenerSpy);

      await vault.create(
        "ai_suggestion-live.json",
        JSON.stringify([{ id: "p-live", file: "Doc.md", line: 1, original: "a", replacement: "b" }])
      );

      expect(listenerSpy).toHaveBeenCalled();
      expect(store.getAllProposals().some((p) => p.id === "p-live")).toBe(true);
    });

    it("removes proposals and fires listener when suggestion file is deleted", async () => {
      const file = vault.seedFile(
        "ai_suggestion-temp.json",
        JSON.stringify([{ id: "p-temp", file: "Doc.md", line: 1, original: "a", replacement: "b" }])
      );
      await store.scanVaultBuffers();

      const listenerSpy = vi.fn();
      store.onStoreChange(listenerSpy);

      await vault.delete(file);
      expect(listenerSpy).toHaveBeenCalled();
      expect(store.getAllProposals().some((p) => p.id === "p-temp")).toBe(false);
    });

    it("updates proposals when buffer file is renamed", async () => {
      const file = vault.seedFile(
        "ai_suggestion-oldname.json",
        JSON.stringify([{ id: "p-ren", file: "Doc.md", line: 1, original: "a", replacement: "b" }])
      );
      await store.scanVaultBuffers();

      await vault.rename(file, "ai_suggestion-newname.json");
      const proposal = store.getProposalById("p-ren");
      expect(proposal?.sourceFile).toBe("ai_suggestion-newname.json");
    });

    it("updates proposals when target markdown file is renamed", async () => {
      vault.seedFile(
        "ai_suggestion-target.json",
        JSON.stringify([{ id: "p-target-ren", file: "DocOld.md", line: 1, original: "a", replacement: "b" }])
      );
      const noteFile = vault.seedFile("DocOld.md", "hello");
      await store.scanVaultBuffers();

      await vault.rename(noteFile, "DocNew.md");
      const proposal = store.getProposalById("p-target-ren");
      expect(proposal?.file).toBe("DocNew.md");
    });

    it("ignores modifications to unrelated non-buffer files", async () => {
      const noteFile = vault.seedFile("Notes/Daily.md", "Daily content");
      const rescanSpy = vi.spyOn(store, "scanVaultBuffers");

      await vault.modify(noteFile, "Updated daily content");
      expect(rescanSpy).not.toHaveBeenCalled();
    });
  });

  describe("Atomic Mutation: acceptProposal", () => {
    it("mutates target note, updates buffer JSON, shifts coordinates, and notifies listeners", async () => {
      const noteFile = vault.seedFile("Doc.md", "Hello old world\nSecond line");
      vault.seedFile(
        "ai_suggestion-test.json",
        JSON.stringify([
          { id: "p1", file: "Doc.md", line: 0, ch: 6, original: "old ", replacement: "bright " },
          { id: "p2", file: "Doc.md", line: 0, ch: 10, original: "world", replacement: "universe" },
        ])
      );
      await store.scanVaultBuffers();

      const listenerSpy = vi.fn();
      store.onStoreChange(listenerSpy);

      const success = await store.acceptProposal("p1");
      expect(success).toBe(true);

      // Verify Note Content Mutated
      const updatedNote = await vault.read(noteFile);
      expect(updatedNote).toBe("Hello bright world\nSecond line");

      // Verify Remaining Proposal Shifted: "old " (4) -> "bright " (7) deltaCh = +3 -> p2 ch moves 10 + 3 = 13
      const p2 = store.getAllProposals().find((p) => p.id === "p2");
      expect(p2).toBeDefined();
      expect(p2?.ch).toBe(13);

      // Verify Accepted Proposal Removed from Buffer File
      const bufferJson = JSON.parse(await vault.adapter.read("ai_suggestion-test.json"));
      expect(bufferJson.length).toBe(1);
      expect(bufferJson[0].id).toBe("p2");

      expect(listenerSpy).toHaveBeenCalled();
    });

    it("auto-snaps to target text with horizontal drift", async () => {
      const noteFile = vault.seedFile("Doc.md", "Prefix text with drifted word here");
      // Originally expected at ch: 0, but actually at index 17
      vault.seedFile(
        "ai_suggestion-drift.json",
        JSON.stringify([
          { id: "p-drift", file: "Doc.md", line: 1, ch: 0, original: "drifted", replacement: "aligned" },
        ])
      );
      await store.scanVaultBuffers();

      const success = await store.acceptProposal("p-drift");
      expect(success).toBe(true);
      expect(await vault.read(noteFile)).toBe("Prefix text with aligned word here");
    });

    it("auto-snaps to target text drifted vertically into neighborhood", async () => {
      const noteFile = vault.seedFile("Doc.md", "---\nfrontmatter: true\n---\nTarget text on line 4");
      // Expected on line 1, but drifted to line 4
      vault.seedFile(
        "ai_suggestion-vert.json",
        JSON.stringify([
          { id: "p-vert", file: "Doc.md", line: 1, ch: 0, original: "Target text", replacement: "Mutated text" },
        ])
      );
      await store.scanVaultBuffers();

      const success = await store.acceptProposal("p-vert");
      expect(success).toBe(true);
      expect(await vault.read(noteFile)).toBe("---\nfrontmatter: true\n---\nMutated text on line 4");
    });

    it("enforces idempotency against rapid double acceptance", async () => {
      vault.seedFile("Doc.md", "Single target");
      vault.seedFile(
        "ai_suggestion-race.json",
        JSON.stringify([{ id: "p-race", file: "Doc.md", line: 0, ch: 0, original: "Single", replacement: "Double" }])
      );
      await store.scanVaultBuffers();

      const [res1, res2] = await Promise.all([
        store.acceptProposal("p-race"),
        store.acceptProposal("p-race"),
      ]);

      expect(res1).toBe(true);
      expect(res2).toBe(false);
    });

    it("returns false when target file is missing from vault", async () => {
      vault.seedFile(
        "ai_suggestion-ghost.json",
        JSON.stringify([{ id: "p-ghost", file: "NonExistent.md", line: 1, original: "a", replacement: "b" }])
      );
      await store.scanVaultBuffers();

      const success = await store.acceptProposal("p-ghost");
      expect(success).toBe(false);
    });

    it("returns false when original text cannot be found within neighborhood", async () => {
      vault.seedFile("Doc.md", "Completely different text content");
      vault.seedFile(
        "ai_suggestion-missing.json",
        JSON.stringify([{ id: "p-missing", file: "Doc.md", line: 1, original: "Lost text needle", replacement: "b" }])
      );
      await store.scanVaultBuffers();

      const success = await store.acceptProposal("p-missing");
      expect(success).toBe(false);
    });

    it("deletes empty buffer file when all proposals are accepted and deleteEmptyBufferFiles is true", async () => {
      vault.seedFile("Doc.md", "One solitary proposal");
      vault.seedFile(
        "ai_suggestion-solo.json",
        JSON.stringify([{ id: "p-solo", file: "Doc.md", line: 1, ch: 4, original: "solitary", replacement: "single" }])
      );
      await store.scanVaultBuffers();

      const success = await store.acceptProposal("p-solo");
      expect(success).toBe(true);
      expect(vault.getAbstractFileByPath("ai_suggestion-solo.json")).toBeNull();
    });
  });

  describe("Proposal Rejection: rejectProposal", () => {
    it("removes proposal from buffer without modifying the target note", async () => {
      const noteFile = vault.seedFile("Doc.md", "Original text content");
      vault.seedFile(
        "ai_suggestion-rej.json",
        JSON.stringify([{ id: "p-rej", file: "Doc.md", line: 0, ch: 0, original: "Original", replacement: "Mutated" }])
      );
      await store.scanVaultBuffers();

      const modifySpy = vi.fn();
      vault.on("modify", modifySpy);

      const success = await store.rejectProposal("p-rej");
      expect(success).toBe(true);

      // Target note MUST NOT be touched
      expect(await vault.read(noteFile)).toBe("Original text content");
      expect(modifySpy).not.toHaveBeenCalledWith(noteFile);

      // Proposal removed from store
      expect(store.getAllProposals().length).toBe(0);
    });

    it("returns false when rejecting non-existent proposal", async () => {
      const success = await store.rejectProposal("non-existent-id");
      expect(success).toBe(false);
    });
  });

  describe("Write-Lock Debounce & Cooldown Timing", () => {
    it("suppresses self-induced vault events within 350ms window", async () => {
      vault.seedFile("Doc.md", "Hello world");
      // Use 2 proposals so the buffer is modified instead of deleted
      const bufferFile = vault.seedFile(
        "ai_suggestion-lock.json",
        JSON.stringify([
          { id: "p-lock", file: "Doc.md", line: 0, ch: 6, original: "world", replacement: "earth" },
          { id: "p-lock2", file: "Doc.md", line: 1, ch: 0, original: "other", replacement: "more" },
        ])
      );
      await store.scanVaultBuffers();

      const rescanSpy = vi.spyOn(store, "scanVaultBuffers");

      // Trigger accept which writes files and activates write-lock
      await store.acceptProposal("p-lock");
      rescanSpy.mockClear();

      // Trigger modify event within debounce window at t = 50ms
      vi.advanceTimersByTime(50);
      vault.trigger("modify", bufferFile);
      expect(rescanSpy).not.toHaveBeenCalled();

      // Trigger modify event at t = 340ms (still within 350ms window)
      vi.advanceTimersByTime(290);
      vault.trigger("modify", bufferFile);
      expect(rescanSpy).not.toHaveBeenCalled();

      // Advance past 350ms cooldown window to t = 360ms
      vi.advanceTimersByTime(20);

      // External modify at t = 370ms MUST now be processed
      vault.trigger("modify", bufferFile);
      expect(rescanSpy).toHaveBeenCalledTimes(1);
    });
  });
});
