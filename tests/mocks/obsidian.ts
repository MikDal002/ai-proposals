import { vi } from "vitest";
import { StateField } from "@codemirror/state";

/**
 * Normalizes vault paths to POSIX format:
 * - Replaces backslashes with forward slashes.
 * - Collapses repeated slashes.
 * - Trims leading and trailing slashes.
 */
export function normalizePath(rawPath: string): string {
  return rawPath
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

/**
 * Base abstract file representing either a note or a folder.
 */
export class TAbstractFile {
  path: string = "";
  name: string = "";
  parent: TFolder | null = null;
  vault: Vault;

  constructor(pathStr: string, vault: Vault) {
    this.path = normalizePath(pathStr);
    this.name = this.path.split("/").pop() ?? "";
    this.vault = vault;
  }
}

/**
 * Concrete file representation with metadata.
 */
export class TFile extends TAbstractFile {
  stat = {
    ctime: Date.now(),
    mtime: Date.now(),
    size: 0,
  };
  basename: string = "";
  extension: string = "md";

  constructor(pathStr: string, vault: Vault) {
    super(pathStr, vault);
    const parts = this.name.split(".");
    this.extension = parts.length > 1 ? (parts.pop() ?? "") : "";
    this.basename = parts.join(".");
  }
}

/**
 * Folder representation in the mock hierarchy.
 */
export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];

  isRoot(): boolean {
    return this.path === "" || this.path === "/";
  }
}

export interface EventRef {
  id: string;
  name: string;
}

/**
 * In-memory filesystem adapter matching Obsidian vault.adapter interface.
 */
export class DataAdapter {
  constructor(private vault: Vault) {}

  async read(pathStr: string): Promise<string> {
    const norm = normalizePath(pathStr);
    const content = this.vault.getRawContent(norm);
    if (content === undefined) {
      throw new Error(`[MockAdapter] File not found: ${norm}`);
    }
    return content;
  }

  async readBinary(pathStr: string): Promise<ArrayBuffer> {
    const content = await this.read(pathStr);
    const encoded = new TextEncoder().encode(content);
    return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer;
  }

  async writeBinary(pathStr: string, data: ArrayBuffer): Promise<void> {
    const decoded = new TextDecoder().decode(data);
    await this.write(pathStr, decoded);
  }

  async write(pathStr: string, data: string): Promise<void> {
    const norm = normalizePath(pathStr);
    const file = this.vault.getAbstractFileByPath(norm);
    if (!file || !(file instanceof TFile)) {
      this.vault.seedFile(norm, data);
    } else {
      await this.vault.modify(file, data);
    }
  }

  async exists(pathStr: string): Promise<boolean> {
    const norm = normalizePath(pathStr);
    return this.vault.getRawContent(norm) !== undefined;
  }

  async list(folderPath: string): Promise<{ files: string[]; folders: string[] }> {
    const normFolder = normalizePath(folderPath);
    const prefix = normFolder ? normFolder + "/" : "";
    const files: string[] = [];
    const folders = new Set<string>();

    for (const [p] of this.vault.getAllEntries()) {
      if (p.startsWith(prefix) && p !== normFolder) {
        const relative = p.slice(prefix.length);
        const slashIdx = relative.indexOf("/");
        if (slashIdx === -1) {
          files.push(p);
        } else {
          folders.add(prefix + relative.slice(0, slashIdx));
        }
      }
    }

    return {
      files,
      folders: Array.from(folders),
    };
  }

  async remove(pathStr: string): Promise<void> {
    const norm = normalizePath(pathStr);
    const file = this.vault.getAbstractFileByPath(norm);
    if (file) {
      await this.vault.delete(file);
    }
  }
}

/**
 * In-memory Mock Vault for headless unit tests.
 */
export class Vault {
  private fileContents = new Map<string, string>();
  private fileObjects = new Map<string, TAbstractFile>();
  private listeners = new Map<string, Array<{ id: string; cb: (...args: unknown[]) => void }>>();
  public adapter: DataAdapter;

  constructor() {
    this.adapter = new DataAdapter(this);
    this.reset();
  }

  reset(): void {
    this.fileContents.clear();
    this.fileObjects.clear();
    this.listeners.clear();
  }

  // --- Test Fixture Helpers ---

  seedFile(pathStr: string, content: string): TFile {
    const norm = normalizePath(pathStr);
    const file = new TFile(norm, this);
    file.stat.size = content.length;
    file.stat.mtime = Date.now();
    this.fileContents.set(norm, content);
    this.fileObjects.set(norm, file);
    return file;
  }

  getRawContent(pathStr: string): string | undefined {
    return this.fileContents.get(normalizePath(pathStr));
  }

  getAllEntries(): IterableIterator<[string, string]> {
    return this.fileContents.entries();
  }

  // --- Obsidian Vault Public API ---

  async read(file: TFile): Promise<string> {
    const content = this.fileContents.get(file.path);
    if (content === undefined) {
      throw new Error(`[MockVault] File not found: ${file.path}`);
    }
    return content;
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    const content = await this.read(file);
    const encoded = new TextEncoder().encode(content);
    return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer;
  }

  async cachedRead(file: TFile): Promise<string> {
    return this.read(file);
  }

  async modify(file: TFile, data: string): Promise<void> {
    this.fileContents.set(file.path, data);
    file.stat.mtime = Date.now();
    file.stat.size = data.length;
    this.trigger("modify", file);
  }

  async modifyBinary(file: TFile, data: ArrayBuffer): Promise<void> {
    const decoded = new TextDecoder().decode(data);
    await this.modify(file, decoded);
  }

  async process(file: TFile, fn: (data: string) => string): Promise<string> {
    const current = await this.read(file);
    const updated = fn(current);
    await this.modify(file, updated);
    return updated;
  }

  async create(pathStr: string, data: string): Promise<TFile> {
    const norm = normalizePath(pathStr);
    const file = this.seedFile(norm, data);
    this.trigger("create", file);
    return file;
  }

  async createBinary(pathStr: string, data: ArrayBuffer): Promise<TFile> {
    const decoded = new TextDecoder().decode(data);
    return this.create(pathStr, decoded);
  }

  async delete(file: TAbstractFile): Promise<void> {
    this.fileContents.delete(file.path);
    this.fileObjects.delete(file.path);
    this.trigger("delete", file);
  }

  async rename(file: TAbstractFile, newPath: string): Promise<void> {
    const oldPath = file.path;
    const normNew = normalizePath(newPath);
    const content = this.fileContents.get(oldPath) ?? "";
    this.fileContents.delete(oldPath);
    this.fileObjects.delete(oldPath);

    file.path = normNew;
    file.name = normNew.split("/").pop() ?? "";
    if (file instanceof TFile) {
      const parts = file.name.split(".");
      file.extension = parts.length > 1 ? (parts.pop() ?? "") : "";
      file.basename = parts.join(".");
    }
    this.fileContents.set(normNew, content);
    this.fileObjects.set(normNew, file);

    this.trigger("rename", file, oldPath);
  }

  getAbstractFileByPath(pathStr: string): TAbstractFile | null {
    const norm = normalizePath(pathStr);
    return this.fileObjects.get(norm) ?? null;
  }

  getFileByPath(pathStr: string): TFile | null {
    const file = this.getAbstractFileByPath(pathStr);
    return file instanceof TFile ? file : null;
  }

  getFiles(): TFile[] {
    return Array.from(this.fileObjects.values()).filter(
      (f): f is TFile => f instanceof TFile
    );
  }

  getMarkdownFiles(): TFile[] {
    return this.getFiles().filter((f) => f.extension === "md");
  }

  getAllLoadedFiles(): TAbstractFile[] {
    return Array.from(this.fileObjects.values());
  }

  getRoot(): TFolder {
    const root = new TFolder("", this);
    root.children = Array.from(this.fileObjects.values());
    return root;
  }

  // --- Event Handling ---

  on(name: string, callback: (...args: unknown[]) => void): EventRef {
    if (!this.listeners.has(name)) {
      this.listeners.set(name, []);
    }
    const id = `${name}-${Date.now()}-${Math.random()}`;
    this.listeners.get(name)!.push({ id, cb: callback });
    return { id, name };
  }

  off(name: string, callback: (...args: unknown[]) => void): void {
    const list = this.listeners.get(name);
    if (!list) return;
    this.listeners.set(
      name,
      list.filter((item) => item.cb !== callback)
    );
  }

  offref(ref: EventRef): void {
    const list = this.listeners.get(ref.name);
    if (!list) return;
    this.listeners.set(
      ref.name,
      list.filter((item) => item.id !== ref.id)
    );
  }

  trigger(name: string, ...args: unknown[]): void {
    const callbacks = this.listeners.get(name) ?? [];
    for (const item of callbacks) {
      item.cb(...args);
    }
  }
}

/**
 * Mock Notification Popup
 */
export class Notice {
  message: string;
  duration?: number;
  constructor(message: string | DocumentFragment, duration?: number) {
    this.message = typeof message === "string" ? message : "document-fragment";
    this.duration = duration;
  }
  setMessage = vi.fn().mockReturnThis();
  hide = vi.fn();
}

/**
 * Mock Workspace Leaf & Workspace
 */
export class WorkspaceLeaf {
  view: unknown = null;
  openFile = vi.fn().mockResolvedValue(undefined);
  setViewState = vi.fn().mockResolvedValue(undefined);
  getViewState = vi.fn().mockReturnValue({});
  getDisplayText = vi.fn().mockReturnValue("Mock Leaf");
  detach = vi.fn();
}

export class Workspace {
  activeLeaf: WorkspaceLeaf | null = null;
  getActiveViewOfType = vi.fn();
  getActiveFile = vi.fn().mockReturnValue(null);
  getLeavesOfType = vi.fn().mockReturnValue([]);
  getLeaf = vi.fn().mockReturnValue(new WorkspaceLeaf());
  getRightLeaf = vi.fn().mockReturnValue(new WorkspaceLeaf());
  revealLeaf = vi.fn();
  openLinkText = vi.fn().mockResolvedValue(undefined);
  detachLeavesOfType = vi.fn();
  onLayoutReady = vi.fn((cb: () => void) => {
    cb?.();
    return { id: "mock-layout-ref", name: "layout-ready" };
  });
  on = vi.fn().mockReturnValue({ id: "mock-event-ref", name: "mock" });
  off = vi.fn();
  offref = vi.fn();
  trigger = vi.fn();
}

export class MarkdownView {
  editor: any = {
    setCursor: vi.fn(),
    setSelection: vi.fn(),
    scrollIntoView: vi.fn(),
    focus: vi.fn(),
  };
  file: TFile | null = null;
}

/**
 * Mock ItemView (for Sidebar)
 */
export class ItemView {
  leaf: WorkspaceLeaf;
  containerEl: any = {
    createDiv: vi.fn().mockReturnValue({}),
    createEl: vi.fn().mockReturnValue({}),
    empty: vi.fn(),
  };
  contentEl: any = {
    createDiv: vi.fn().mockReturnValue({}),
    createSpan: vi.fn().mockReturnValue({}),
    createEl: vi.fn().mockReturnValue({}),
    empty: vi.fn(),
    addClass: vi.fn(),
    removeClass: vi.fn(),
    scrollTop: 0,
  };

  constructor(leaf: WorkspaceLeaf) {
    this.leaf = leaf;
  }

  getViewType(): string {
    return "mock-item-view";
  }

  getDisplayText(): string {
    return "Mock View";
  }

  getIcon(): string {
    return "document";
  }

  addAction = vi.fn();
  registerEvent = vi.fn();

  async onOpen(): Promise<void> {}
  async onClose(): Promise<void> {}
}

/**
 * Mock App Container
 */
export class App {
  vault: Vault;
  workspace: Workspace;

  constructor() {
    this.vault = new Vault();
    this.workspace = new Workspace();
  }
}

/**
 * Mock Base Plugin Class
 */
export class Plugin {
  app: App;
  manifest: unknown;

  constructor(app: App, manifest: unknown) {
    this.app = app;
    this.manifest = manifest;
  }

  loadData = vi.fn().mockResolvedValue({});
  saveData = vi.fn().mockResolvedValue(undefined);
  addRibbonIcon = vi.fn().mockReturnValue({});
  addStatusBarItem = vi.fn().mockImplementation(() => {
    const classes = new Set<string>();
    const attrs = new Map<string, string>();
    const listeners = new Map<string, Function>();

    const element: any = {
      nodeType: 1,
      tagName: "DIV",
      textContent: "",
      style: {},
      attributes: attrs,
      classList: {
        add: (...c: string[]) => c.forEach((cls) => classes.add(cls)),
        remove: (...c: string[]) => c.forEach((cls) => classes.delete(cls)),
        contains: (c: string) => classes.has(c),
      },
      addClass: vi.fn((...c: string[]) => c.forEach((cls) => classes.add(cls))),
      removeClass: vi.fn((...c: string[]) => c.forEach((cls) => classes.delete(cls))),
      setText: vi.fn(function (this: any, text: string) {
        this.textContent = text;
        return this;
      }),
      setAttribute: vi.fn((k: string, v: string) => attrs.set(k, v)),
      getAttribute: vi.fn((k: string) => attrs.get(k) ?? null),
      addEventListener: vi.fn((evt: string, cb: Function) => listeners.set(evt, cb)),
      removeEventListener: vi.fn((evt: string) => listeners.delete(evt)),
      remove: vi.fn(),
      dispatchEvent: vi.fn((e: { type: string }) => {
        listeners.get(e.type)?.(e);
        return true;
      }),
    };

    Object.defineProperty(element, "className", {
      get: () => Array.from(classes).join(" "),
      set: (val: string) => {
        classes.clear();
        val.split(" ").filter(Boolean).forEach((c) => classes.add(c));
      },
    });

    return element;
  });
  addCommand = vi.fn();
  addSettingTab = vi.fn();
  registerView = vi.fn();
  registerEditorExtension = vi.fn();
  registerEvent = vi.fn();
  registerInterval = vi.fn();
}

/**
 * Mock Settings Tab
 */
export class PluginSettingTab {
  app: App;
  plugin: Plugin;
  containerEl: unknown = {};

  constructor(app: App, plugin: Plugin) {
    this.app = app;
    this.plugin = plugin;
  }

  display(): void {}
  hide(): void {}
}

/**
 * Fluent Setting builder mock
 */
export class Setting {
  constructor(public containerEl: unknown) {}
  setName = vi.fn().mockReturnThis();
  setDesc = vi.fn().mockReturnThis();
  setHeading = vi.fn().mockReturnThis();
  addText = vi.fn((cb?: (text: any) => any) => {
    if (cb) {
      const mockText = {
        setPlaceholder: vi.fn().mockReturnThis(),
        setValue: vi.fn().mockReturnThis(),
        onChange: vi.fn((handler: (val: string) => any) => {
          (mockText as any)._changeHandler = handler;
          (this as any)._onChangeText = handler;
          return mockText;
        }),
        inputEl: { addEventListener: vi.fn(), value: "" },
      };
      cb(mockText);
    }
    return this;
  });
  addToggle = vi.fn((cb?: (toggle: any) => any) => {
    if (cb) {
      const mockToggle = {
        setValue: vi.fn().mockReturnThis(),
        onChange: vi.fn((handler: (val: boolean) => any) => {
          (mockToggle as any)._changeHandler = handler;
          (this as any)._onChangeToggle = handler;
          return mockToggle;
        }),
        toggleEl: { addEventListener: vi.fn(), checked: false },
      };
      cb(mockToggle);
    }
    return this;
  });
  addSlider = vi.fn((cb?: (slider: any) => any) => {
    if (cb) {
      const mockSlider = {
        setLimits: vi.fn().mockReturnThis(),
        setValue: vi.fn().mockReturnThis(),
        setDynamicTooltip: vi.fn().mockReturnThis(),
        onChange: vi.fn((handler: (val: number) => any) => {
          (mockSlider as any)._changeHandler = handler;
          (this as any)._onChangeSlider = handler;
          return mockSlider;
        }),
        sliderEl: { addEventListener: vi.fn(), value: "0" },
      };
      cb(mockSlider);
    }
    return this;
  });
  addButton = vi.fn((cb?: (btn: any) => any) => {
    if (cb) {
      const mockBtn = {
        setButtonText: vi.fn().mockReturnThis(),
        setCta: vi.fn().mockReturnThis(),
        setWarning: vi.fn().mockReturnThis(),
        setDisabled: vi.fn().mockReturnThis(),
        onClick: vi.fn((handler: () => any) => {
          (mockBtn as any)._clickHandler = handler;
          (this as any)._onClickBtn = handler;
          return mockBtn;
        }),
      };
      cb(mockBtn);
    }
    return this;
  });
  addDropdown = vi.fn().mockReturnThis();
}

/**
 * Context Menu mock
 */
export class Menu {
  addItem = vi.fn().mockReturnThis();
  showAtPosition = vi.fn().mockReturnThis();
  showAtMouseEvent = vi.fn().mockReturnThis();
}

/**
 * Modal dialog mock
 */
export class Modal {
  app: App;
  contentEl: unknown = {};
  constructor(app: App) {
    this.app = app;
  }
  open = vi.fn();
  close = vi.fn();
}

export interface EditorInfo {
  file?: TFile | null;
  [key: string]: unknown;
}

/**
 * CodeMirror 6 Editor Context Field exported by Obsidian
 */
export const editorInfoField = StateField.define<EditorInfo | null>({
  create() {
    return null;
  },
  update(value) {
    return value;
  },
});

/**
 * Common Obsidian Utilities
 */
export const parseYaml = vi.fn((yaml: string) => JSON.parse(yaml));
export const stringifyYaml = vi.fn((obj: unknown) => JSON.stringify(obj));

export function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  delay: number
): T {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return ((...args: unknown[]) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  }) as unknown as T;
}

export const Platform = {
  isDesktop: true,
  isMobile: false,
  isIos: false,
  isAndroid: false,
  isMacOS: false,
  isWin: true,
  isLinux: false,
};
