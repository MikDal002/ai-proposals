/**
 * src/settings/settings-tab.ts
 * Settings Tab View for AI Proposals Obsidian Plugin.
 *
 * Guarantees:
 * - Mobile Safety: ZERO Node.js runtime imports (no fs, path, child_process).
 * - Instant persistence via plugin.saveSettings().
 * - Real-time propagation to ProposalStore and ProposalStatusBarItem.
 */

import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type AIProposalsPlugin from "../main";
import { DEFAULT_SETTINGS } from "../types";

export class AIProposalsSettingTab extends PluginSettingTab {
  constructor(app: App, public readonly plugin: AIProposalsPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    if (typeof containerEl.empty === "function") {
      containerEl.empty();
    } else {
      (containerEl as HTMLElement).innerHTML = "";
    }

    // Header & Description
    containerEl.createEl("h2", { text: "AI Proposals – Ustawienia" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Bezpieczny most i centrum interaktywnego zatwierdzania propozycji zmian generowanych przez agentów AI.",
    });

    // 1. Buffer Pattern Setting
    new Setting(containerEl)
      .setName("Wzorzec plików bufora")
      .setDesc("Wzorzec glob określający pliki buforów z propozycjami AI w skarbcu (domyślnie: ai_suggestion-*.json).")
      .addText((text) => {
        text
          .setPlaceholder("ai_suggestion-*.json")
          .setValue(this.plugin.settings?.bufferPattern ?? DEFAULT_SETTINGS.bufferPattern)
          .onChange(async (value: string) => {
            await this.onBufferPatternChange(value);
          });
      });

    // 2. Auto-Snap Radius Setting
    new Setting(containerEl)
      .setName("Tolerancja auto-snap (linie)")
      .setDesc("Maksymalna liczba linii powyżej i poniżej pierwotnej pozycji, przeszukiwana w celu odnalezienia przesuniętego tekstu (od 0 do 20 linii).")
      .addSlider((slider) => {
        slider
          .setLimits(0, 20, 1)
          .setValue(this.plugin.settings?.autoSnapRadius ?? DEFAULT_SETTINGS.autoSnapRadius)
          .setDynamicTooltip()
          .onChange(async (value: number) => {
            await this.onScanRadiusChange(value);
          });
      });

    // 3. Auto-Open Sidebar Setting
    new Setting(containerEl)
      .setName("Automatyczne otwieranie panelu bocznego")
      .setDesc("Automatycznie otwórz panel boczny propozycji AI po załadowaniu wtyczki, jeśli w skarbcu istnieją oczekujące propozycje.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings?.autoOpenSidebar ?? DEFAULT_SETTINGS.autoOpenSidebar)
          .onChange(async (value: boolean) => {
            this.plugin.settings.autoOpenSidebar = value;
            await this.plugin.saveSettings();
          });
      });

    // 4. Status Bar Counter Setting
    new Setting(containerEl)
      .setName("Licznik w pasku stanu")
      .setDesc("Wyświetlaj plakietkę z liczbą oczekujących propozycji w pasku stanu Obsidian (dostępne na komputerach).")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings?.showStatusBarCounter ?? DEFAULT_SETTINGS.showStatusBarCounter)
          .onChange(async (value: boolean) => {
            this.plugin.settings.showStatusBarCounter = value;
            this.plugin.settings.showStatusBarBadge = value;
            await this.plugin.saveSettings();
            this.plugin.updateStatusBarVisibility();
          });
      });

    // Section: Diagnostic Tools
    containerEl.createEl("h3", { text: "Narzędzia diagnostyczne i bufory" });

    // 5. Manual Scan Button
    new Setting(containerEl)
      .setName("Skanuj bufory w skarbcu")
      .setDesc("Wymuś natychmiastowe przeszukanie skarbca pod kątem plików buforów i odśwież stan propozycji.")
      .addButton((btn) => {
        btn
          .setButtonText("Skanuj teraz")
          .setCta()
          .onClick(async () => {
            if (typeof btn.setDisabled === "function") {
              btn.setDisabled(true);
            }
            btn.setButtonText("Skanowanie...");
            try {
              const proposals = await this.plugin.store.scanVaultBuffers();
              new Notice(`AI Proposals: Przeskanowano skarbiec. Znaleziono ${proposals.length} propozycji.`);
            } catch (err) {
              console.error("[AI Proposals] Error during manual scan:", err);
              new Notice("AI Proposals: Błąd podczas skanowania buforów.");
            } finally {
              if (typeof btn.setDisabled === "function") {
                btn.setDisabled(false);
              }
              btn.setButtonText("Skanuj teraz");
            }
          });
      });

    // 6. Reset to Defaults Button
    new Setting(containerEl)
      .setName("Przywróć ustawienia domyślne")
      .setDesc("Zresetuj wszystkie ustawienia wtyczki do ich fabrycznych wartości początkowych.")
      .addButton((btn) => {
        btn
          .setButtonText("Przywróć domyślne")
          .setWarning()
          .onClick(async () => {
            this.plugin.settings = { ...DEFAULT_SETTINGS };
            await this.plugin.saveSettings();
            this.display();
            new Notice("AI Proposals: Przywrócono ustawienia domyślne.");
          });
      });
  }

  public async onBufferPatternChange(value: string): Promise<void> {
    const trimmed = typeof value === "string" ? value.trim() : "";
    this.plugin.settings.bufferPattern = trimmed || DEFAULT_SETTINGS.bufferPattern;
    await this.plugin.saveSettings();
  }

  public async onScanRadiusChange(value: number): Promise<void> {
    const clamped = Math.max(0, Math.min(20, Math.round(Number(value) || 0)));
    this.plugin.settings.autoSnapRadius = clamped;
    this.plugin.settings.neighborhoodScanRadius = clamped;
    await this.plugin.saveSettings();
  }
}
