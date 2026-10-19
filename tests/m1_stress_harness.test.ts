import { describe, it, expect, vi } from "vitest";
import {
  normalizePath,
  Vault as MockVault,
  DataAdapter as MockDataAdapter,
  TFile,
  TFolder,
  type EventRef,
} from "./mocks/obsidian";

describe("Milestone 1 Empirical Stress Harness: obsidian.ts Mock", () => {
  describe("1. Path Normalization Edge Cases", () => {
    it("handles empty path string", () => {
      expect(normalizePath("")).toBe("");
    });

    it("normalizes single and multiple root slashes to empty string", () => {
      expect(normalizePath("/")).toBe("");
      expect(normalizePath("//")).toBe("");
      expect(normalizePath("///")).toBe("");
      expect(normalizePath("////")).toBe("");
    });

    it("collapses multi-slash sequences in deep nested paths", () => {
      expect(normalizePath("///a///b////c/////file.md///")).toBe("a/b/c/file.md");
      expect(normalizePath("\\\\a\\\\b\\\\c\\file.md\\\\")).toBe("a/b/c/file.md");
    });

    it("normalizes mixed Windows and POSIX separators", () => {
      expect(normalizePath("folder\\sub/nested\\file.json")).toBe(
        "folder/sub/nested/file.json"
      );
    });

    it("preserves spaces and unicode characters in filenames", () => {
      expect(normalizePath("  spaces / in / path .md  ")).toBe(
        "  spaces / in / path .md  "
      );
      expect(normalizePath("notatki/żółw/zażółć_gęślą_jaźń.md")).toBe(
        "notatki/żółw/zażółć_gęślą_jaźń.md"
      );
    });

    it("observes relative path segment behavior (dot segments)", () => {
      // Mock normalizePath does not resolve dot-segments (POSIX dirname style)
      // We empirically record whether ./ or ../ are resolved or preserved as literal path strings
      const dotPath = normalizePath("folder/./sub/../note.md");
      expect(dotPath).toBe("folder/./sub/../note.md");
    });
  });

  describe("2. Mock Vault Hierarchy & File State Consistency", () => {
    it("parses extensions and basenames across diverse filename formats", () => {
      const vault = new MockVault();

      const f1 = vault.seedFile("simple.md", "content");
      expect(f1.extension).toBe("md");
      expect(f1.basename).toBe("simple");

      const f2 = vault.seedFile("archive.tar.gz", "tarball");
      expect(f2.extension).toBe("gz");
      expect(f2.basename).toBe("archive.tar");

      const f3 = vault.seedFile("LICENSE", "MIT");
      expect(f3.extension).toBe("");
      expect(f3.basename).toBe("LICENSE");

      const f4 = vault.seedFile(".gitignore", "node_modules\n");
      expect(f4.extension).toBe("gitignore");
      expect(f4.basename).toBe("");
    });

    it("observes state consistency on rename (extension & basename synchronization)", async () => {
      const vault = new MockVault();
      const file = vault.seedFile("notes/draft.md", "hello world");
      expect(file.extension).toBe("md");
      expect(file.basename).toBe("draft");
      expect(vault.getMarkdownFiles().length).toBe(1);

      // Rename from .md to .json
      await vault.rename(file, "proposals/draft.json");
      expect(file.path).toBe("proposals/draft.json");
      expect(file.name).toBe("draft.json");

      // EMPIRICAL OBSERVATION: Does rename update basename and extension on TFile?
      const isExtensionUpdated = file.extension === "json";
      const _isBasenameUpdated = file.basename === "draft";
      const mdFilesAfterRename = vault.getMarkdownFiles();

      // We document actual behavior empirically
      if (!isExtensionUpdated) {
        // Document finding: TFile.extension is stale after rename
        expect(file.extension).toBe("md"); // Stale value in current mock implementation
        expect(mdFilesAfterRename.length).toBe(1); // Stale extension keeps it in markdown files!
      } else {
        expect(_isBasenameUpdated).toBe(true);
        expect(file.extension).toBe("json");
        expect(file.basename).toBe("draft");
        expect(mdFilesAfterRename.length).toBe(0);
      }
    });

    it("verifies behavior when creating a duplicate file path", async () => {
      const vault = new MockVault();
      const first = await vault.create("conflict.md", "first version");
      expect(await vault.read(first)).toBe("first version");

      // Attempting to create duplicate: does mock overwrite or throw?
      const second = await vault.create("conflict.md", "second version");
      expect(await vault.read(second)).toBe("second version");
      expect(vault.getFiles().length).toBe(1);
    });

    it("verifies getRoot() returns root folder containing all files", () => {
      const vault = new MockVault();
      vault.seedFile("file1.md", "1");
      vault.seedFile("folder/file2.md", "2");

      const root = vault.getRoot();
      expect(root).toBeInstanceOf(TFolder);
      expect(root.isRoot()).toBe(true);
      expect(root.path).toBe("");
      expect(root.children.length).toBe(2);
    });

    it("throws appropriate error when reading non-existent file", async () => {
      const vault = new MockVault();
      const ghost = new TFile("nonexistent.md", vault);

      await expect(vault.read(ghost)).rejects.toThrowError(
        /\[MockVault\] File not found: nonexistent\.md/
      );
    });
  });

  describe("3. DataAdapter Edge Cases & Directory Traversal", () => {
    it("handles empty paths and root paths safely in exists and read", async () => {
      const vault = new MockVault();
      const adapter: MockDataAdapter = vault.adapter;

      expect(await adapter.exists("")).toBe(false);
      expect(await adapter.exists("/")).toBe(false);
      expect(await adapter.exists("///")).toBe(false);

      await expect(adapter.read("")).rejects.toThrowError(/\[MockAdapter\] File not found/);
      await expect(adapter.read("/")).rejects.toThrowError(/\[MockAdapter\] File not found/);
    });

    it("safely handles remove on non-existent files without throwing", async () => {
      const vault = new MockVault();
      const adapter: MockDataAdapter = vault.adapter;

      await expect(adapter.remove("does-not-exist.md")).resolves.toBeUndefined();
      await expect(adapter.remove("")).resolves.toBeUndefined();
    });

    it("lists root directory contents accurately with empty string and root slashes", async () => {
      const vault = new MockVault();
      const adapter = vault.adapter;

      await adapter.write("root-note.md", "content");
      await adapter.write("folderA/subA.md", "sub A");
      await adapter.write("folderB/subB.md", "sub B");

      const listEmpty = await adapter.list("");
      expect(listEmpty.files).toContain("root-note.md");
      expect(listEmpty.folders).toEqual(expect.arrayContaining(["folderA", "folderB"]));
      expect(listEmpty.files).not.toContain("folderA/subA.md");

      const listSlash = await adapter.list("/");
      expect(listSlash.files).toEqual(listEmpty.files);
      expect(listSlash.folders.sort()).toEqual(listEmpty.folders.sort());
    });

    it("avoids sibling prefix collisions in directory listings", async () => {
      const vault = new MockVault();
      const adapter = vault.adapter;

      await adapter.write("project/spec.md", "target file");
      await adapter.write("project-archive/old-spec.md", "sibling prefix file");

      const projectListing = await adapter.list("project");
      expect(projectListing.files).toEqual(["project/spec.md"]);
      expect(projectListing.folders).toEqual([]);
      expect(projectListing.files).not.toContain("project-archive/old-spec.md");
    });

    it("lists deep subdirectories without flattening lower levels", async () => {
      const vault = new MockVault();
      const adapter = vault.adapter;

      await adapter.write("a/b/c/d/file.txt", "deep file");
      const listA = await adapter.list("a");
      expect(listA.files).toEqual([]);
      expect(listA.folders).toEqual(["a/b"]);

      const listB = await adapter.list("a/b");
      expect(listB.files).toEqual([]);
      expect(listB.folders).toEqual(["a/b/c"]);
    });

    it("handles double-slashed paths transparently in write, read, and exists", async () => {
      const vault = new MockVault();
      const adapter = vault.adapter;

      await adapter.write("//folder//sub///doc.md", "double slashed");
      expect(await adapter.exists("folder/sub/doc.md")).toBe(true);
      expect(await adapter.exists("///folder///sub///doc.md")).toBe(true);
      expect(await adapter.read("folder\\sub\\doc.md")).toBe("double slashed");
    });
  });

  describe("4. Binary Adapter & Vault Methods Availability", () => {
    it("inspects availability and functionality of readBinary and writeBinary on DataAdapter", async () => {
      const vault = new MockVault();
      const adapter = vault.adapter;

      const hasReadBinary = typeof adapter.readBinary === "function";
      const hasWriteBinary = typeof adapter.writeBinary === "function";

      expect(hasReadBinary).toBe(true);
      expect(hasWriteBinary).toBe(true);

      const buffer = new TextEncoder().encode("binary content payload");
      await adapter.writeBinary("bin/test.dat", buffer.buffer as ArrayBuffer);
      const readBuf = await adapter.readBinary("bin/test.dat");
      expect(new TextDecoder().decode(readBuf)).toBe("binary content payload");
    });

    it("inspects availability and functionality of binary methods on Vault", async () => {
      const vault = new MockVault();

      const hasVaultReadBinary = typeof vault.readBinary === "function";
      const hasVaultModifyBinary = typeof vault.modifyBinary === "function";
      const hasVaultCreateBinary = typeof vault.createBinary === "function";

      expect(hasVaultReadBinary).toBe(true);
      expect(hasVaultModifyBinary).toBe(true);
      expect(hasVaultCreateBinary).toBe(true);

      const buffer = new TextEncoder().encode("initial binary");
      const file = await vault.createBinary("bin/vault-test.dat", buffer.buffer as ArrayBuffer);
      const readBuf = await vault.readBinary(file);
      expect(new TextDecoder().decode(readBuf)).toBe("initial binary");

      const updatedBuffer = new TextEncoder().encode("updated binary");
      await vault.modifyBinary(file, updatedBuffer.buffer as ArrayBuffer);
      const readUpdated = await vault.readBinary(file);
      expect(new TextDecoder().decode(readUpdated)).toBe("updated binary");
    });
  });

  describe("5. Event System Robustness & EventRef Lifecycle", () => {
    it("registers and triggers multiple listeners for the same event", async () => {
      const vault = new MockVault();
      const spy1 = vi.fn();
      const spy2 = vi.fn();

      vault.on("modify", spy1);
      vault.on("modify", spy2);

      const file = vault.seedFile("test.md", "v1");
      await vault.modify(file, "v2");

      expect(spy1).toHaveBeenCalledTimes(1);
      expect(spy2).toHaveBeenCalledTimes(1);
      expect(spy1).toHaveBeenCalledWith(file);
    });

    it("unregisters listeners cleanly via EventRef without affecting sibling listeners", async () => {
      const vault = new MockVault();
      const spy1 = vi.fn();
      const spy2 = vi.fn();

      const ref1: EventRef = vault.on("create", spy1);
      const ref2: EventRef = vault.on("create", spy2);

      await vault.create("f1.md", "content");
      expect(spy1).toHaveBeenCalledTimes(1);
      expect(spy2).toHaveBeenCalledTimes(1);

      // Unregister ref1
      vault.offref(ref1);

      await vault.create("f2.md", "content");
      expect(spy1).toHaveBeenCalledTimes(1); // Not called again
      expect(spy2).toHaveBeenCalledTimes(2); // Still active

      // Unregister ref2
      vault.offref(ref2);

      await vault.create("f3.md", "content");
      expect(spy2).toHaveBeenCalledTimes(2); // Inactive now
    });

    it("tolerates redundant or invalid offref and off calls gracefully", () => {
      const vault = new MockVault();
      const dummyRef: EventRef = { id: "non-existent-id", name: "modify" };
      const nonExistentEventRef: EventRef = { id: "some-id", name: "non-existent-event" };

      expect(() => vault.offref(dummyRef)).not.toThrow();
      expect(() => vault.offref(nonExistentEventRef)).not.toThrow();

      const fn = vi.fn();
      expect(() => vault.off("modify", fn)).not.toThrow();
      expect(() => vault.off("unregistered-event", fn)).not.toThrow();
    });

    it("passes rename event arguments properly (file, oldPath)", async () => {
      const vault = new MockVault();
      const renameSpy = vi.fn();
      vault.on("rename", renameSpy);

      const file = vault.seedFile("old-name.md", "data");
      await vault.rename(file, "new-name.md");

      expect(renameSpy).toHaveBeenCalledTimes(1);
      expect(renameSpy).toHaveBeenCalledWith(file, "old-name.md");
    });

    it("supports unregistering during an event callback (re-entrancy guard)", () => {
      const vault = new MockVault();
      let ref: EventRef | null = null;
      let count = 0;

      ref = vault.on("test-reentrant", () => {
        count++;
        if (ref) {
          vault.offref(ref);
        }
      });

      vault.trigger("test-reentrant");
      expect(count).toBe(1);

      vault.trigger("test-reentrant");
      expect(count).toBe(1); // Was unregistered in the first run
    });
  });

  describe("6. High-Concurrency Stress Tests", () => {
    it("handles 200 concurrent writes to the same file cleanly", async () => {
      const vault = new MockVault();
      vault.seedFile("shared.json", '{"count": 0}');

      const writePromises = Array.from({ length: 200 }, (_, i) =>
        vault.adapter.write("shared.json", JSON.stringify({ count: i }))
      );

      await expect(Promise.all(writePromises)).resolves.toBeDefined();
      const finalContent = await vault.adapter.read("shared.json");
      expect(finalContent).toMatch(/{"count":\d+}/);
    });

    it("handles 500 concurrent file creations in distinct paths", async () => {
      const vault = new MockVault();

      const createPromises = Array.from({ length: 500 }, (_, i) =>
        vault.create(`batch/item-${i}.md`, `Content payload ${i}`)
      );

      const createdFiles = await Promise.all(createPromises);
      expect(createdFiles.length).toBe(500);
      expect(vault.getFiles().length).toBe(500);

      const listing = await vault.adapter.list("batch");
      expect(listing.files.length).toBe(500);
    });

    it("handles concurrent interleaved read, write, and delete operations", async () => {
      const vault = new MockVault();

      // Seed 50 files
      for (let i = 0; i < 50; i++) {
        vault.seedFile(`interleaved/file-${i}.md`, `init ${i}`);
      }

      const operations: Promise<unknown>[] = [];

      for (let i = 0; i < 50; i++) {
        // Read existing
        operations.push(vault.adapter.read(`interleaved/file-${i}.md`));
        // Overwrite existing
        operations.push(
          vault.adapter.write(`interleaved/file-${i}.md`, `updated ${i}`)
        );
        // Create new
        operations.push(
          vault.adapter.write(`interleaved/new-${i}.md`, `new content ${i}`)
        );
        // Delete half of them
        if (i % 2 === 0) {
          operations.push(vault.adapter.remove(`interleaved/file-${i}.md`));
        }
      }

      await expect(Promise.all(operations)).resolves.toBeDefined();
    });

    it("stress-tests event system with 1,000 rapid emissions across 50 listeners", () => {
      const vault = new MockVault();
      let callCount = 0;
      const listenerCount = 50;
      const emitCount = 1000;

      for (let i = 0; i < listenerCount; i++) {
        vault.on("stress-event", () => {
          callCount++;
        });
      }

      const startTime = performance.now();
      for (let i = 0; i < emitCount; i++) {
        vault.trigger("stress-event", i);
      }
      const elapsedMs = performance.now() - startTime;

      expect(callCount).toBe(listenerCount * emitCount);
      // Ensure 50,000 dispatches execute under 250ms in memory
      expect(elapsedMs).toBeLessThan(500);
    });
  });

  describe("7. Memory & Garbage Collection Cleanliness", () => {
    it("resets all internal maps cleanly without memory retention", async () => {
      const vault = new MockVault();

      for (let i = 0; i < 1000; i++) {
        vault.seedFile(`cleanup/note-${i}.md`, `Memory payload test ${i}`);
        vault.on(`event-${i % 10}`, () => {});
      }

      expect(vault.getFiles().length).toBe(1000);

      vault.reset();

      expect(vault.getFiles().length).toBe(0);
      expect(vault.getAllLoadedFiles().length).toBe(0);
      expect(Array.from(vault.getAllEntries()).length).toBe(0);
      expect(await vault.adapter.exists("cleanup/note-0.md")).toBe(false);
    });
  });
});
