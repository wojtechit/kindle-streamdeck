# Kindle Deck: panel produktywności na biurko ze starego Kindle Fire

Stary Kindle Fire jako dotykowy panel obok monitora: skróty do aplikacji na PC, Pomodoro, lista zadań, pogoda i kalendarz z przyciskiem „DOŁĄCZ”.

![Kindle Deck](docs/screenshot.png)

## Jak to działa

```
┌──────────── Kindle Fire (Fully Kiosk) ──────────┐        ┌──────────── PC (Windows) ─────────────┐
│  web/  – czysty HTML/CSS/ES5, bez budowania      │  HTTP  │  server/server.py (Flask + waitress)  │
│  • kafelki     → POST /api/action/<id>           │ ─────► │  • serwuje web/ i API                 │
│  • to-do       → /api/todos                      │  LAN   │  • otwiera programy / linki na PC     │
│  • pogoda      → /api/weather   (proxy)          │ ◄───── │  • proxy Open-Meteo i Google Calendar │
│  • kalendarz   → /api/events    (proxy)          │        │  • todos.json – zadania trzymane na PC│
└──────────────────────────────────────────────────┘        └────────────────────────────────────────┘
```

| Decyzja | Powód |
|---|---|
| **Strona serwowana z PC zamiast APK** | Nie trzeba niczego kompilować pod Fire OS. Zmieniasz plik na PC, dotykasz ↻ na tablecie i gotowe. |
| **Czysty ES5 + XHR, bez frameworków** | Stary WebView na Fire OS nie obsługuje `fetch`, `Promise`, CSS Grid ani zmiennych CSS. |
| **Pogoda i kalendarz idą przez PC** | Stary Android ma przestarzałe TLS i certyfikaty. Tablet rozmawia wyłącznie z PC, po zwykłym HTTP w sieci lokalnej. |
| **Tablet wysyła tylko ID kafelka** | To, co ma się stać, jest zapisane w `config.json` na PC. Z sieci nie da się odpalić dowolnej komendy. |

## Instalacja na PC (Windows)

1. Zainstaluj **Python 3.10+** i przy instalacji zaznacz *Add to PATH*.
2. Uruchom `server\start.bat`. Przy pierwszym starcie skrypt sam utworzy środowisko, zainstaluje paczki i skopiuje `config.example.json` do `config.json`.
3. W `server\config.json` ustaw lokalizację pogody i adres kalendarza (opis niżej). Po zmianach zrestartuj serwer.
4. **Zapora Windows:** przy pierwszym starcie zezwól na dostęp w **sieci prywatnej**. Możesz też dodać regułę ręcznie (PowerShell uruchomiony jako administrator):
   ```powershell
   netsh advfirewall firewall add rule name="KindleDeck" dir=in action=allow protocol=TCP localport=8765 profile=private
   ```
5. W konsoli pojawi się adres w rodzaju `http://192.168.1.50:8765/`. Ten adres otwierasz na Kindle.
6. **Stały adres IP:** w routerze zrób rezerwację DHCP dla PC i dla Kindle'a (po adresie MAC).

**Autostart bez okna konsoli:** naciśnij `Win+R`, wpisz `shell:startup` i wrzuć tam skrót do `server\start_hidden.vbs`. Logi lądują w `server\deck.log`.

## Kindle: pełny ekran bez paska Silk

Silk zawsze pokazuje pasek adresu. Da się go ukryć przyciskiem ⛶ w prawym górnym rogu dashboardu, ale po odświeżeniu strony pasek wraca. Na stałe najlepiej sprawdza się osobna przeglądarka „kioskowa”.

### Opcja 1 (polecana): Fully Kiosk Browser

Darmowa przeglądarka stworzona do paneli na ścianę i biurko. Nie ma jej w Amazon Appstore, więc instalujesz ją z pliku APK.

1. Sprawdź wersję systemu: **Ustawienia → Opcje urządzenia → Aktualizacje systemu**. Fire OS 5 lub nowszy (każdy Fire 7 od 2015 roku) obsługuje Fully bez problemu.
2. Na Kindle otwórz w Silk stronę **fully-kiosk.com**, przejdź do zakładki Download i pobierz APK.
3. Zezwól na instalację z nieznanych źródeł. Fire zapyta o to przy otwieraniu pobranego pliku. Na starszych wersjach systemu włączysz to w **Ustawienia → Zabezpieczenia → Aplikacje z nieznanych źródeł**.
4. Uruchom Fully. Wejdź w ustawienia (przesunięcie od lewej krawędzi → Settings) i ustaw:
   - **Web Content Settings → Start URL:** `http://IP-TWOJEGO-PC:8765/`
   - **Web Content Settings → Enable JavaScript Interface:** ON (dashboard pokaże baterię)
   - **Toolbars & Appearance:** wyłącz pasek adresu i paski, włącz **Fullscreen Mode**
   - **Device Management → Keep Screen On:** ON
   - **Advanced Web Settings / Device Management → Launch on Boot:** ON (po restarcie tabletu od razu włącza się dashboard)
5. Opcjonalnie: **Screen Saver** albo wygaszanie ekranu w nocy (Scheduled Sleep).

Wymienione wyżej funkcje działają w wersji darmowej. Płatna licencja PLUS dotyczy głównie blokady kiosku i zdalnego zarządzania, przy biurkowym panelu nie jest potrzebna. Aktualny podział funkcji sprawdź na stronie Fully, bo bywa zmieniany.

### Opcja 2: skrót na pulpicie z Silk

W Silk otwórz dashboard, potem menu → **Dodaj do ekranu głównego**. Strona ma manifest `display: fullscreen`, więc nowsze wersje Silk otwierają ją ze skrótu bez paska adresu. Na starym Fire OS bywa różnie i pasek może zostać. Wtedy zostaje przycisk ⛶ albo opcja 1.

### Opcja 3: WallPanel (open source)

Darmowa aplikacja open source do paneli ściennych (GitHub: *WallPanel*). Też wyświetla stronę na pełnym ekranie i trzyma ekran włączony. Ma mniej opcji niż Fully i nie przekazuje poziomu baterii do strony.

## Konfiguracja (`server/config.json`)

### Kafelki

```json
{ "id": "gmail", "label": "Gmail", "icon": "gmail.svg",
  "action": { "type": "url", "url": "https://mail.google.com" } }
```

Siatka dopasowuje się do liczby kafelków: 1–4 dają układ 2×2, 5–6 dają 2×3, 7–9 dają 3×3, a 10–12 dają 3×4.

- `icon`: plik z `web/icons/` albo nazwa wbudowanej ikony liniowej. Gotowe pliki to `chrome.svg`, `gmail.svg`, `youtube.svg` i `claude.svg`. Możesz dorzucić własny PNG albo SVG.
- Wbudowane ikony liniowe (pokazywane na kolorowym kafelku, kolor ustawiasz polem `color`): `mic`, `music`, `playpause`, `next`, `prev`, `volume`, `folder`, `globe`, `terminal`, `lock`, `mail`, `calendar`, `code`, `home`, `power`, `settings`.

| `type` | Parametry | Przykład |
|---|---|---|
| `url` | `url` | otwiera stronę w domyślnej przeglądarce |
| `open` | `target` | `chrome`, ścieżka do exe, folder, `%USERPROFILE%\\Downloads`, `C:\\...\\Claude.exe` |
| `hotkey` | `keys: [...]` | `["ctrl","shift","esc"]` |
| `media` | `key` | `playpause`, `next`, `prev`, `volup`, `voldown`, `mute` |
| `shell` | `cmd: [...]` | `["rundll32.exe","user32.dll,LockWorkStation"]` (blokada PC) |
| `type` | `text` | wpisuje tekst |
| `multi` | `steps: [...]` | kilka akcji po kolei, `{"type":"sleep","s":1}` daje pauzę |

### Pogoda

`"weather": { "name": "Lubochnia", "lat": 51.58, "lon": 20.05 }`. Dane pochodzą z Open-Meteo: bez klucza API i bez rejestracji.

### Kalendarz

Google Calendar → Ustawienia → wybierz kalendarz → **Tajny adres w formacie iCal** → wklej go do `calendar_ics_url`. Linki do Meet, Zoom, Teams i Discorda są wyciągane automatycznie z opisu lub lokalizacji wydarzenia. „DOŁĄCZ” otwiera spotkanie **na PC**.

### Pomodoro

Sekcja `pomodoro` ustawia czasy w minutach. Przerwa startuje sama, a następna sesja pracy czeka, aż ją uruchomisz. Z `auto_focus: true` licznik po starcie przechodzi na pełny ekran.

![Tryb skupienia](docs/focus.png)

## Dostęp i bezpieczeństwo

Strona otwiera się bez logowania i bez pytania o token. Jeśli chcesz, żeby kafelków nie dało się klikać z innych urządzeń w domu (telefony, telewizor), wpisz stałe IP Kindle'a:

```json
"allowed_ips": ["192.168.1.60"]
```

Wtedy dostęp ma tylko Kindle i sam PC. Pole `token` też zostało, ale jest puste i nieużywane. Port 8765 nie wychodzi poza sieć domową.

## Test bez tabletu

Uruchom serwer, otwórz `http://localhost:8765/` w Chrome, włącz w DevTools tryb urządzenia i ustaw rozdzielczość 1024×600.

## Pomysły na dalej

- Strony kafelków (np. „Praca” / „Rozrywka”) przełączane przesunięciem palca.
- Edytor kafelków w przeglądarce na PC zamiast edycji JSON.
- Prognoza godzinowa po dotknięciu karty pogody.
- Statystyki Pomodoro: liczba sesji dziennie i tygodniowo.
