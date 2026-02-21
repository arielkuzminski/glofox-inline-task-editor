# Glofox Client Task Panel

Skrypt Tampermonkey rozszerzający istniejący widok `Interakcje & Zadania` na
profilu klienta w Glofox.

Dodaje szybkie akcje przy kartach tasków:

- `Edytuj` (notatka + termin + opcja wykonania),
- `Zamknij` (oznacz jako wykonane od razu),
- `Odśwież` danych tasków klienta.

Skrypt korzysta z endpointu ładowanego natywnie przez panel klienta:

- `GET /task-management-api/v1/locations/{locationId}/tasks?customer-id={customerOriginalUserId}`

oraz z zapisu:

- `PATCH /task-management-api/v1/locations/{locationId}/tasks/{taskId}`

## Instalacja

1. Otwórz Tampermonkey.
2. Kliknij `Create a new script`.
3. Wklej zawartość:
   - `Glofox Client Tasks - Inline Manager (Stable)-1.0.user.js`
4. Zapisz (`Ctrl+S`) i upewnij się, że skrypt jest włączony.

## Zakres

- Obsługa tylko na ekranie profilu klienta (sekcja `Interakcje & Zadania`).
- Szybka edycja pól: `notes`, `due_date`, `completion_date/completed_by`.
- Fallback na własny request, jeśli nie uda się przechwycić natywnego response.

## Uwagi

- Selektory są oparte o semantykę i teksty UI (nie tylko hashowane klasy CSS).
- Jeśli Glofox przebuduje strukturę kart, może być potrzebna aktualizacja selektorów.
