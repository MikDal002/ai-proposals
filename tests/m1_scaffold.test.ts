import { describe, it, expect, vi } from "vitest";
import {
  normalizePath as mockNormalizePath,
  Vault as MockVault,
  DataAdapter as MockDataAdapter,
  App as MockApp,
  Notice as MockNotice,
  TFile as MockTFile,
} from "./mocks/obsidian";
import { normalizePath } from "obsidian";
import type { App, PluginManifest } from "obsidian";
import AIProposalsPlugin from "@/main";

describe("Milestone 1: Headless Environment & Mock Obsidian Harness", () => {
  describe("Path Normalization Engine", () => {
    it("converts Windows backslashes to standard forward slashes", () => {
      expect(mockNormalizePath("folder\\subfolder\\note.md")).toBe(
        "folder/subfolder/note.md"
      );
      expect(normalizePath("folder\\subfolder\\note.md")).toBe(
        "folder/subfolder/note.md"
      );
    });

    it("collapses repeated multiple slashes into a single slash", () => {
      expect(mockNormalizePath("root///sub////folder//file.json")).toBe(
        "root/sub/folder/file.json"
      );
      expect(normalizePath("root///sub////folder//file.json")).toBe(
        "root/sub/folder/file.json"
      );
    });

    it("trims leading and trailing slashes cleanly", () => {
      expect(mockNormalizePath("/deep/nested/path/")).toBe("deep/nested/path");
      expect(normalizePath("/deep/nested/path/")).toBe("deep/nested/path");
    });
  });

  describe("In-Memory Vault Operations", () => {
    it("seeds, checks, and reads file content accurately", async () => {
      const vault = new MockVault();
      const testContent = JSON.stringify({
        id: "prop-1",
        file: "Notes/Inbox.md",
        original: "old text",
        replacement: "new text",
      });

      const file = vault.seedFile("ai_suggestion-1.json", testContent);
      expect(file).toBeInstanceOf(MockTFile);
      expect(file.path).toBe("ai_suggestion-1.json");
      expect(file.basename).toBe("ai_suggestion-1");
      expect(file.extension).toBe("json");

      const readBack = await vault.read(file);
      expect(readBack).toBe(testContent);
    });

    it("modifies file content and updates stat metadata", async () => {
      const vault = new MockVault();
      const file = vault.seedFile("test.md", "version 1");
      expect(file.stat.size).toBe(9);

      await vault.modify(file, "version 2 updated");
      const updatedContent = await vault.read(file);
      expect(updatedContent).toBe("version 2 updated");
      expect(file.stat.size).toBe(17);
    });

    it("supports file creation, rename, and deletion lifecycle", async () => {
      const vault = new MockVault();
      const created = await vault.create("drafts/note.md", "initial text");
      expect(vault.getFileByPath("drafts/note.md")).toBe(created);

      await vault.rename(created, "published/note.md");
      expect(vault.getFileByPath("drafts/note.md")).toBeNull();
      expect(vault.getFileByPath("published/note.md")).toBe(created);
      expect(created.path).toBe("published/note.md");

      await vault.delete(created);
      expect(vault.getFileByPath("published/note.md")).toBeNull();
    });

    it("filters markdown files accurately", async () => {
      const vault = new MockVault();
      vault.seedFile("note1.md", "content 1");
      vault.seedFile("note2.markdown", "content 2");
      vault.seedFile("ai_suggestion-alpha.json", "{}");
      vault.seedFile("image.png", "");

      const mdFiles = vault.getMarkdownFiles();
      expect(mdFiles.map((f) => f.path)).toEqual(["note1.md"]);
    });

    it("triggers and unsubscribes event listeners", async () => {
      const vault = new MockVault();
      const modifySpy = vi.fn();
      const ref = vault.on("modify", modifySpy);

      const file = vault.seedFile("watched.md", "init");
      await vault.modify(file, "updated");
      expect(modifySpy).toHaveBeenCalledTimes(1);
      expect(modifySpy).toHaveBeenCalledWith(file);

      vault.offref(ref);
      await vault.modify(file, "updated again");
      expect(modifySpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("DataAdapter File System Abstraction", () => {
    it("handles adapter write, read, exists, list, and remove", async () => {
      const vault = new MockVault();
      const adapter: MockDataAdapter = vault.adapter;

      expect(await adapter.exists("data/config.json")).toBe(false);
      await adapter.write("data/config.json", '{"theme":"dark"}');
      expect(await adapter.exists("data/config.json")).toBe(true);

      const readData = await adapter.read("data/config.json");
      expect(readData).toBe('{"theme":"dark"}');

      await adapter.write("data/items/item1.json", "{}");
      const listing = await adapter.list("data");
      expect(listing.files).toContain("data/config.json");
      expect(listing.folders).toContain("data/items");

      await adapter.remove("data/config.json");
      expect(await adapter.exists("data/config.json")).toBe(false);
    });
  });

  describe("AI Proposals Plugin Scaffold", () => {
    it("instantiates Notice without error", () => {
      const notice = new MockNotice("Testing notification");
      expect(notice.message).toBe("Testing notification");
    });

    it("loads and unloads cleanly, registering commands and ribbon icons", async () => {
      const mockApp = new MockApp();
      const manifest: PluginManifest = {
        id: "ai-proposals",
        name: "AI Proposals",
        version: "1.0.0",
        minAppVersion: "1.5.0",
        description: "Safe bridge and interactive approval hub for AI proposals in Obsidian",
        author: "Mikołaj",
        isDesktopOnly: false,
      };

      const plugin = new AIProposalsPlugin(mockApp as unknown as App, manifest);
      await plugin.onload();

      expect(plugin.addCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "open-sidebar",
          name: "Otwórz panel propozycji AI",
        })
      );
      expect(plugin.addRibbonIcon).toHaveBeenCalledWith(
        "sparkles",
        "AI Proposals",
        expect.any(Function)
      );

      // Verify command callback executes without error
      const commandCall = (plugin.addCommand as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls[0][0];
      const callback = commandCall.callback as () => void;
      expect(() => callback()).not.toThrow();

      // Verify unload executes cleanly
      expect(() => plugin.onunload()).not.toThrow();
    });
  });
});
