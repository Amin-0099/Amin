# Phase 3 – Live-Verifizierung

Stand: 28. Oktober 2026, UTC
Basis: Commit `3c532887f866a2bc4dbe8cef551d2fcacdee3dc8` (`main`)

## Laufzeitumgebung

Die lokalen Prozessvariablen wurden nur auf Vorhandensein geprüft; es wurden
keine Werte ausgegeben. `DATABASE_URL`, `GEMINI_API_KEY`, `GEMINI_MODEL`,
`PORT` und `BASE_PATH` waren nicht gesetzt. Es war keine `.env`-Datei
vorhanden.

- `DATABASE_URL` ist für Datenbank und API erforderlich und fehlt.
- `PORT` ist für API und Vite erforderlich und fehlt.
- `BASE_PATH` ist für beide Vite-Frontends erforderlich und fehlt.
- `GEMINI_API_KEY` fehlt; deshalb wurde kein Gemini-Aufruf ausgeführt.
- `GEMINI_MODEL` ist optional; ohne Wert verwendet die Integration ihr
  konfiguriertes Standardmodell.
- `.env.example` enthält ausschließlich die fünf Variablennamen mit leeren
  Werten. `.gitignore` ignoriert `.env`-Dateien und nimmt `.env.example` aus.

## Echte öffentliche Marktdaten

Die vorhandenen Datenadapter wurden am 28. Oktober 2026 gegen Binance und
CoinGecko ausgeführt. Es wurden keine Mock-Daten für diese Live-Prüfung
verwendet.

| Prüfung | Beobachtung |
|---|---|
| Binance BTC-Ticker | HTTP 200; echter Preis, 24h-Änderung, Quote-Volumen und Börsen-Zeitstempel zurückgegeben |
| CoinGecko BTC-Markt | HTTP 200; echter EUR-/USD-Preis, 24h-Volumen und `last_updated` zurückgegeben |
| BTC-Adapter-Snapshot | 28.10.2026 10:59:00 UTC; EUR-Kurs 73.153,23; EUR-Volumen 899.504.191,58; Quellabweichung 0,07 % |
| Binance 1h-Kerzen | 299 abgeschlossene Kerzen; jüngster Zeitstempel 09:59:59 UTC, Alter 59 Minuten (Frischegrenze 90 Minuten) |
| Binance 1d-Kerzen | 299 abgeschlossene Kerzen; jüngster Zeitstempel 27.10.2026 23:59:59 UTC, Alter 659 Minuten (Frischegrenze 36 Stunden) |
| Radar-Asset-Abdeckung | 11:00:39 UTC: 10 live, 0 veraltet, 10 fehlend |

Live verfügbare Radar-Assets: BTC, ETH, SOL, BNB, XRP, ADA, DOGE, AVAX, LINK
und LTC. Als nicht verfügbar ausgewiesen: COIN, MSTR, NVDA, ASML, TSM, AAPL,
MSFT, DAX, XAU und OIL. Für diese Assetklassen ist in der aktuellen
Implementierung keine öffentliche Datenquelle verbunden.

Ein echter HTTP-429 trat während der Live-Abfragen nicht auf. Das
deterministische Testszenario für Rate-Limits bestätigt separat, dass ein
429 als fehlende Quelle ausgewiesen wird, ohne den Radar-Aufruf abzubrechen.
Preis-Fallback, ungültige/veraltete Werte, leere Provider-Antworten und
Kerzenvalidierung wurden ebenfalls durch deterministische Tests geprüft.

## Analyse und Radar mit Live-Daten

Die Radar-HTTP-Route wurde lokal mit öffentlichen Live-Daten aufgerufen und
lieferte HTTP 200 mit 20 Assets. Für BTC führte die Analyse zu:

- Signal/Entscheidung: `no_clear_signal`
- Confidence: 42/100, aus der dokumentierten Abdeckung, Übereinstimmung und
  Quellenkonsistenz berechnet; kein Trefferquotenversprechen
- Risiko: 39/100
- Ergebnis: kein handelbares Richtungssignal; es wurde kein Paper-Trade
  erzeugt

Die Radar-Route verwendet dieselbe datenbasierte Snapshot-Analyse, ersetzt
aber keinen persistenten `/analysis/run`-Lauf. Ein vollständiger gespeicherter
Analyse-Run samt Paper Trade, P&L und History konnte mangels `DATABASE_URL`
nicht ausgeführt werden. Es wurden keine Datenbankzugangsdaten erfunden oder
verwendet.

## Gemini

Status: **SKIPPED – API-Key fehlt.** Die Integration wurde lokal auf den
fehlenden-Key-Pfad geprüft (`GEMINI_NOT_CONFIGURED`); es wurde kein Request an
Gemini gesendet. Request-/Response-, Timeout- und Quotenverhalten konnten
ohne API-Key nicht Ende-zu-Ende gegen Gemini verifiziert werden.

## Deterministische Tests (getrennt von Live-Daten)

`pnpm run typecheck`: PASS
`pnpm test`: PASS – 17 bestanden, 0 fehlgeschlagen, 1
datenbankgestützter Integrationstest übersprungen.

Die bestandenen deterministischen Tests prüfen unter anderem Radar-Routen,
frische und stale Quellen, Fallbacks, ungültige Werte, Rate-Limits,
Analysis-Engine, Paper-P&L und History-Berechnung. Diese Testergebnisse sind
keine Aussage über persistente Live-Trades oder eine garantierte Trefferquote.
