---
data utworzenia: 2026-10-16 23:58
status: specyfikacja
tags:
  - projekt/obsidian-plugin
  - agy-reviewer
  - architektura
---

# Specyfikacja Wymagań Projektowych: Wtyczka `Agy Reviewer` (v1.0)

Dokument ten stanowi kompletną bazę wiedzy, wymagań funkcjonalnych oraz odkrytych lekcji architektonicznych ("pułapek"), zebranych podczas budowy i testowania prototypu wtyczki **Agy Reviewer**. Służy jako bezpośredni blueprint do napisania docelowej, czystej wersji wtyczki w **TypeScript + esbuild**.

---

## 1. Wizja i Założenia Architektoniczne (Etap 1)

Głównym celem **Etapu 1** jest asynchroniczna współpraca na linii **Użytkownik ➔ Agent (Model AI) ➔ Obsidian** w modelu **Read-Only Proposer (Single Sink)**:

1. **Wyzwalanie na żądanie**: Użytkownik prosi model w konsoli (np. Gemini Flash / Antigravity) o przeanalizowanie wybranej notatki na podstawie skillów oznaczonych w YAML frontmatterze flagą `agy_suggestion: true`.
2. **Bezpieczeństwo danych (Read-Only + Single Sink)**:
   - Agent ma prawo odczytu całego skarbca (notatek, powiązań, dokumentacji wtyczek, skillów).
   - Agent ma **kategoryczny zakaz** bezpośredniej edycji plików `.md`.
   - Jedynym miejscem, do którego agent zapisuje swoje propozycje, jest pojedynczy plik bufora: `_agy_suggestions.json`.
3. **Pełna kontrola użytkownika**: Użytkownik w dowolnym momencie przegląda propozycje w Obsidianie (bezpośrednio w tekście jak w LanguageTool lub w panelu bocznym) i jednym kliknięciem je akceptuje lub odrzuca.
4. **Izolacja Desktop-Only**:
   - Wtyczka działa w 100% lokalnie na komputerze (`"isDesktopOnly": true` w `manifest.json`), bez zapytań sieciowych z poziomu Obsidiana i bez uruchamiania na urządzeniach mobilnych.

---

## 2. Kontrakt Danych (`_agy_suggestions.json`)

Plik bufora przechowuje tablicę obiektów reprezentujących atomowe propozycje zmian:

```json
[
  {
    "id": "2026-10-16-12-tata",
    "file": "00. Notatki codzienne/2026/10/2026-10-16.md",
    "line": 25,
    "from_ch": 16,
    "to_ch": 20,
    "original": "Tata",
    "replacement": "[[Mariusz Achwat|Tata]]",
    "rule": "Refinement Obsydianowania (Wikilink)",
    "explanation": "Wplecenie w sieć: dowiązanie wzmianki o tacie do kartoteki [[Mariusz Achwat]]."
  }
]
```

### Zasady kontraktu:
* **`file`**: Ścieżka względna od korzenia skarbca (lub nazwa pliku). Wtyczka musi normalizować ukośniki (`\` ➔ `/`) oraz wielkość liter.
* **`line`**: Numer linii liczony po ludzku **od 1** (`1-indexed`). W API Obsidiana (`Editor`) konwertowany na `line - 1` (`0-indexed`), natomiast w CodeMirror 6 `state.doc.line(line)` przyjmuje bezpośrednio wartość `1-indexed`.
* **`from_ch` / `to_ch`**: Indeksy znaków w obrębie danej linii liczone **od 0** (`0-indexed`, zgodnie z `String.prototype.substring(from_ch, to_ch)`).
* **`original`**: Dokładny podciąg znaków, który ma zostać zastąpiony. Pełni rolę kotwicy weryfikacyjnej.
* **`replacement`**: Nowy tekst, który ma wejść w miejsce `original` (może zawierać znaki nowej linii `\n`, np. przy rozbudowie frontmattera).

---

## 3. Silnik Pozycjonowania, Kolizji i Korekty Offsetów (Core Logic)

To najważniejsza część techniczna, która decyduje o tym, czy wtyczka działa niezawodnie w prawdziwych notatkach.

### 3.1. Korekta błędów liczenia znaków przez LLM (Auto-Snap w linii)
Modele językowe często mylą się o 1–3 znaki przy wyliczaniu `from_ch` i `to_ch` w długich akapitach (tzw. *off-by-one error*).
* **Wymaganie**: Zanim wtyczka podświetli lub podmieni tekst w linii `L`, sprawdza czy `lineText.substring(from_ch, to_ch) === original`.
* Jeśli tekst się nie zgadza, wtyczka wyszukuje wszystkie wystąpienia `original` w linii `L` i wybiera to, którego indeks startowy jest **najbliższy** zadeklarowanemu `from_ch` (`findClosestOccurrence`).

### 3.2. Wiele poprawek w tej samej linii (Przeliczanie $\Delta$ znaków)
W jednej linii akapitu może znajdować się kilka niezależnych poprawek (np. w linii 25 aż 8 różnych wikilinków i literówek).
* **Wymaganie**: Po zastosowaniu poprawki w linii `L` na przedziale `[appliedFrom, appliedTo]`, wtyczka wylicza zmianę długości tekstu:
  $$\Delta_{\text{ch}} = \text{replacement.length} - (\text{appliedTo} - \text{appliedFrom})$$
* Dla każdej innej oczekującej propozycji `p` w tym samym pliku i tej samej linii, która znajduje się **za** zaaplikowaną zmianą (`p.from_ch >= appliedTo`):
  - `p.from_ch += deltaCh`
  - `p.to_ch += deltaCh`
* Zaktualizowane współrzędne muszą zostać natychmiast zapisane z powrotem do pliku `_agy_suggestions.json`.

### 3.3. Detekcja i eliminacja kolizji (Intersekcja przedziałów)
Dwie propozycje w tej samej linii kolidują ze sobą, jeśli ich przedziały nachodzą na siebie:
$$\max(\text{from}_1, \text{from}_2) < \min(\text{to}_1, \text{to}_2)$$
* **Wymaganie 1 (Na wejściu)**: Podczas wczytywania `_agy_suggestions.json`, jeśli dwie propozycje w tej samej linii mają intersekcję, pierwsza jest zachowywana, a druga automatycznie odrzucana (i usuwana z pliku JSON).
* **Wymaganie 2 (Przy aplikacji)**: Jeśli po realnym dopasowaniu (*Auto-Snap*) zastosowana poprawka weszła w intersekcję z inną propozycją w tej samej linii, ta druga propozycja jest automatycznie usuwana.

### 3.4. Kompensacja przesunięcia linii (Line-Shift Compensation / Frontmatter Bug)
Edycja frontmattera YAML (lub wstawienie wieloliniowego bloku) zmienia liczbę linii w dokumencie, przesuwając wszystkie kolejne sekcje o $\pm N$ linii.
* **Wymaganie 1 (Dynamiczna korekta $\Delta$ linii przy aplikacji)**:
  Gdy aplikowana jest poprawka, wtyczka liczy różnicę znaków nowej linii:
  $$\Delta_{\text{lines}} = \text{replacement.split('\n').length} - \text{original.split('\n').length}$$
  Jeśli $\Delta_{\text{lines}} \neq 0$, wszystkie propozycje w tym pliku mające `p.line > appliedLine` otrzymują korektę `p.line += deltaLines` (w pamięci oraz w pliku JSON).
* **Wymaganie 2 (Skanowanie sąsiedztwa $\pm 5$ linii)**:
  Jeśli w zadeklarowanej linii `proposal.line` nie ma tekstu `proposal.original` (bo np. użytkownik dopisał linię ręcznie lub zadziałała inna wtyczka), silnik pozycjonowania przeszukuje sąsiednie linie w promieniu $\pm 5$ linii ($L+1, L-1, L+2, L-2, \dots$), zaczynając od najbliższych.
* **Wymaganie 3 (Ochrona przed pustymi dekoracjami)**:
  Jeśli po przesunięciu linia jest pusta lub tekst pod współrzędnymi nie pasuje do `original`, CodeMirror nie może rysować "ślepych" podkreśleń na przypadkowych słowach.

---

## 4. Interfejs Użytkownika (UI / UX)

### 4.1. Podkreślenia w edytorze (CodeMirror 6 `ViewPlugin`)
* Dekoracja `Decoration.mark` z klasą `.agy-suggestion-highlight` (falowane podkreślenie `underline wavy var(--interactive-accent)`).
* `RangeSetBuilder` w CM6 **wymaga bezwzględnie posortowanych i nienachodzących na siebie zakresów** (`ranges.sort((a, b) => a.from - b.from || a.to - b.to)` oraz filtr `item.from >= lastTo`). Brak sortowania rzuca wyjątek i psuje edytor.
* Kliknięcie w podkreślony tekst otwiera pływający **Popover (Dymek)** z:
  - nazwą reguły/skilla (`.agy-rule-badge`),
  - wyjaśnieniem (`explanation`),
  - podglądem `Przed` (skreślony czerwony) vs `Po` (zielony),
  - przyciskami **[Zastosuj]** i **[Odrzuć]**.

### 4.2. Panel Boczny (`ItemView` w prawym doku)
* Otwierany ikoną gwiazdek `sparkles` na wstążce (Ribbon), kliknięciem w pasek stanu lub komendą z palety.
* Podzielony na **2 grupy**:
  1. **📄 Bieżący plik**: lista kart propozycji dla aktualnie otwartej notatki (z przyciskami *Pokaż*, *Odrzuć*, *Zastosuj*).
  2. **🗄️ Pozostałe w sejfie**: propozycje dla innych plików w skarbcu, pogrupowane w podsekcje według nazw plików (z przyciskiem *Otwórz i pokaż*, który sam otwiera plik i przewija edytor do właściwej linii).

### 4.3. Dolny Pasek Stanu (Status Bar)
* Pokazuje zwięzły licznik w formacie: `✨ Agy: <aktywny_plik>/<cały_sejf>` (np. `✨ Agy: 5/21`).

---

## 5. Krytyczne Pułapki Techniczne Obsidiana (Lessons Learned)

Przy pisaniu docelowej wersji w TypeScript należy bezwzględnie uwzględnić poniższe zjawiska, które odkryliśmy podczas testów:

1. **Pułapka "Podwójnego Kliknięcia" w Panelu Bocznym (`active-leaf-change`)**:
   - **Zjawisko**: Gdy użytkownik ma fokus w edytorze i klika przycisk `[Zastosuj]` w panelu bocznym, na zdarzeniu `mousedown` Obsidian najpierw przenosi fokus na panel boczny i odpala event `active-leaf-change`. Jeśli wtyczka na każdy `active-leaf-change` wykonuje pełny `render()` panelu (`containerEl.empty()`), niszczy przycisk w DOM zanim nastąpi `mouseup`/`click`. W efekcie pierwsze kliknięcie przepada.
   - **Rozwiązanie**: Nasłuchiwacz `active-leaf-change` musi ignorować sytuację, gdy nowym aktywnym liściem jest sam panel boczny Agy (`leaf.view.getViewType() === AGY_VIEW_TYPE`), oraz przerysowywać panel tylko wtedy, gdy faktycznie zmieniła się ścieżka aktywnego pliku (`newPath !== this._lastTrackedFilePath`).

2. **Pułapka Utraty Referencji do Edytora (`getActiveViewOfType(MarkdownView)`)**:
   - **Zjawisko**: Kiedy użytkownik klika przycisk w panelu bocznym, `workspace.getActiveViewOfType(MarkdownView)` zwraca `null`, ponieważ aktywnym widokiem w tym ułamku sekundy jest panel boczny (`AgySidebarView`), a nie edytor notatki!
   - **Rozwiązanie**: Zamiast polegać wyłącznie na `getActiveViewOfType`, należy używać metody pomocniczej `findMarkdownViewForFile(filePath)`, która przeszukuje otwarte karty (`workspace.iterateAllLeaves`) i znajduje właściwy `MarkdownView` powiązany z plikiem propozycji.

3. **Pułapka Pętli Zapisu przy `autoWatch` (`vault.on('modify')`)**:
   - **Zjawisko**: Gdy wtyczka sama usuwa zastosowaną propozycję i zapisuje `_agy_suggestions.json`, Obsidian wyzwala zdarzenie `vault.on('modify')`, co może wywołać wyścig (race condition) z ponownym odczytem pliku.
   - **Rozwiązanie**: Flaga blokująca `_isSavingProposals = true` na czas zapisu własnego + krótki debounce (`300ms`).

---

## 6. Docelowa Architektura Projektu (TypeScript + esbuild)

Podczas przepisywania wtyczki z prototypu do czystego kodu zalecany jest podział na moduły:

```text
agy-suggestions/
├── src/
│   ├── main.ts                # Główna klasa wtyczki, rejestracja widoków i zdarzeń
│   ├── types.ts               # Interfejsy: Proposal, AgySettings, ResolvedRange
│   ├── store/
│   │   └── ProposalStore.ts   # Odczyt/zapis JSON, usuwanie kolizji, przeliczanie deltaCh i deltaLines
│   ├── editor/
│   │   ├── PositionResolver.ts# Auto-snap w linii, szukanie w sąsiedztwie ±5 linii
│   │   ├── CmExtension.ts     # CodeMirror 6 ViewPlugin i Decoration.mark
│   │   └── PopoverWidget.ts   # Pływający dymek nad tekstem w edytorze
│   └── ui/
│       ├── SidebarView.ts     # Panel boczny (Grupa 1: Bieżący plik, Grupa 2: Sejf)
│       ├── ProposalsModal.ts  # Modal podglądu (opcjonalny)
│       └── SettingTab.ts      # Karta ustawień wtyczki
├── styles.css
├── manifest.json
├── package.json
├── tsconfig.json
└── esbuild.config.mjs
```

---

## 7. Powiązane Pliki Operacyjne w Skarbcu
* **Kod prototypu wtyczki**: `.obsidian/plugins/agy-suggestions/main.js`
* **Arkusz stylów**: `.obsidian/plugins/agy-suggestions/styles.css`
* **Prompt dla modelu (Generator)**: `.agents/prompts/agy-suggest.md`
* **Bufor wymiany danych**: `_agy_suggestions.json`
