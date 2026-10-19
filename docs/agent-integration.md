# Przewodnik Integracji Agentów AI (`docs/agent-integration.md`)

Dokument ten opisuje, jak dowolny model lub agent sztucznej inteligencji (Antigravity/Agy CLI, GitHub Copilot, Claude Code, Cursor, Droid, skrypty Python/Node czy lokalne modele Ollama) może generować i przekazywać propozycje zmian do wtyczki **AI Proposals** w Obsidianie.

---

## 1. Architektura: Read-Only Proposer & Single Sink

Tradycyjne próby automatyzacji edycji notatek przez modele AI kończą się często uszkodzonymi plikami, utratą formatowania lub koniecznością żmudnego sprawdzania diffów w Git.

**Wtyczka AI Proposals odwraca ten model:**
```
┌─────────────────────────────────┐
│     Agent AI (Claude / LLM)     │
│  - Pełne prawo odczytu notatek  │
│  - Zakaz edycji plików .md      │
└───────────────┬─────────────────┘
                │ Zapisuje propozycje w JSON
                ▼
┌─────────────────────────────────┐
│  Bufor: ai_suggestion-*.json    │
└───────────────┬─────────────────┘
                │ Obserwator zmian (Watcher)
                ▼
┌─────────────────────────────────┐
│   Wtyczka AI Proposals w GUI    │
│  - Podkreślenia w tekście       │
│  - Pływający popover (Przed/Po) │
│  - Panel boczny z listą         │
└───────────────┬─────────────────┘
                │ Kliknięcie [Zastosuj] przez użytkownika
                ▼
┌─────────────────────────────────┐
│    Bezpieczna modyfikacja .md   │
└─────────────────────────────────┘
```

---

## 2. Gdzie zapisać plik z propozycjami?

Wtyczka monitoruje skarbiec pod kątem plików spełniających wzorzec bufora:
- **Domyślny wzorzec:** `ai_suggestion-*.json` w dowolnym miejscu w skarbcu (najlepiej w katalogu głównym, np. `ai_suggestion-daily.json`, `ai_suggestion-2026-10-19.json`).
- **Plik uniwersalny / legacy:** `_ai_suggestions.json` lub `_agy_suggestions.json`.

*(W ustawieniach wtyczki w Obsidianie możesz także wskazać dedykowany podkatalog buforów, np. `.buffers/`).*

---

## 3. Schemat JSON i Obsługiwane Formaty

Wtyczka wspiera **trzy formaty zapisu**:

### Format A: Płaska tablica (Zalecany)
```json
[
  {
    "id": "prop-01",
    "file": "00. Notatki codzienne/2026/10/2026-10-19.md",
    "line": 12,
    "from_ch": 16,
    "to_ch": 20,
    "original": "Tata",
    "replacement": "[[Mariusz Kowalski|Tata]]",
    "rule": "Wikilink",
    "explanation": "Wplecenie w sieć powiązań: dowiązanie wzmianki o tacie do kartoteki osobowej."
  }
]
```

### Format B: Obiekt z kluczem `proposals`
```json
{
  "proposals": [
    {
      "filePath": "03. Projekty/Strona.md",
      "line": 45,
      "from_ch": 0,
      "to_ch": 10,
      "original": "Stary Tytuł",
      "replacement": "# Nowy Lepszy Tytuł",
      "rule": "Nagłówek",
      "explanation": "Zwiększenie czytelności sekcji."
    }
  ]
}
```

### Format C: Słownik kluczowany ścieżkami plików
```json
{
  "Notatki/WażnaNotatka.md": [
    {
      "line": 5,
      "ch": 10,
      "original": "błąd",
      "replacement": "poprawna forma",
      "explanation": "Korekta literówki."
    }
  ]
}
```

---

## 4. Zasady Koordynatów i Odporność Silnika

1. **Numeracja linii (`line`)**: Zawsze liczona **od 1** (ludzka numeracja edytora tekstu).
2. **Indeksy znaków (`from_ch`, `to_ch`)**: Zawsze liczone **od 0** w obrębie linii.
3. **Auto-Snap ($\pm 5$ linii)**: Jeśli model pomyli się w wyliczeniu numeru linii lub indeksu znaku (częsty błąd tokenizacji LLM), wbudowany w wtyczkę silnik `coordinate-math.ts`:
   - Automatycznie dopasowuje najbliższe wystąpienie `original` w promieniu $\pm 5$ linii.
   - Jeśli tekst pod koordynatami nie pasuje do `original`, wtyczka chroni edytor przed błędnym podmienieniem.
4. **Wstawki o zerowej długości (`from_ch == to_ch`)**: Wtyczka renderuje specjalny interaktywny znacznik (`‸`), który nie psuje edytora CodeMirror 6.

---

## 5. Jak podać prompt modelowi AI?

W katalogu `prompts/` w tym repozytorium znajduje się gotowy szablon:
👉 [`prompts/agent-prompt.md`](../prompts/agent-prompt.md)

### Przykład wywołania w konsoli (CLI / Antigravity / Claude Code / Cursor):

```text
Spójrz na instrukcję w pliku: prompts/agent-prompt.md
Przeanalizuj moją notatkę: "03. Projekty/PlanDziałania.md"
Wskaż miejsca do poprawy stylu, dodaj brakujące wikilinki i zapisz propozycje do:
ai_suggestion-plan.json
```

Agent wykona analizę, utworzy plik `ai_suggestion-plan.json` w Twoim skarbcu, a wtyczka **AI Proposals** w tym samym ułamku sekundy podświetli propozycje w Obsidianie.
