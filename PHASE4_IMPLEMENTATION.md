# Phase 4 – Real Market Intelligence

## Umfang und Betriebsgrenzen

Phase 4 ersetzt simulierte Desk-Analysen durch API-gestützte Marktdaten und nachvollziehbare Berechnungen. Sämtliche Handelsfunktionen bleiben Paper Trading. Es werden keine echten Orders, Wallets oder Geldtransaktionen ausgeführt. Confidence ist ein Datenqualitätsindex und keine Erfolgswahrscheinlichkeit.

## Marktdaten und Datenstatus

- **CoinGecko API** liefert EUR- und USD-Kurse, Marktkapitalisierung, 24h-Volumen, 24h-/7d-Änderung und eine 7-Tage-Sparkline für BTC, ETH, SOL, BNB, XRP, ADA, DOGE, AVAX, LINK und LTC.
- **Binance öffentliche Spot-API** liefert 24h-Ticker einschließlich `closeTime` und Quote-Volumen, das EUR/USDT-Umrechnungs-Paar sowie abgeschlossene 1h- und 1d-OHLCV-Kerzen. Die Kerzenhistorie wird auf höchstens 300 Einträge begrenzt.
- Für Aktien, Indizes und Rohstoffe aus dem Asset-Katalog ist kein Provider angebunden. Diese Assets werden als `missing` geführt; ihre Werte werden nicht simuliert.
- Kurse werden nach 5 Minuten, Stundenkerzen nach 90 Minuten und Tageskerzen nach 36 Stunden als `stale` eingestuft. Kerzen werden auf Zeitstempel und OHLC-Konsistenz geprüft, sortiert und dedupliziert. Lücken in einer Serie machen diese Serie `missing`; Indikatoren werden dann nicht daraus berechnet.
- Providerfehler, Rate Limits und ungültige Antworten werden als `missing` samt Statusdetails ausgegeben. Ein vorhandener, aber veralteter Kurs kann als beobachteter Wert erscheinen, wird jedoch nicht als live gehandelt oder für eine aktuelle Richtungsbewertung verwendet.

Die öffentlichen Provider wurden in dieser Implementierung nicht als dauerhaft verfügbar garantiert. Laufzeitstatus und Quellzeitstempel sind in Radar und Analyse maßgeblich; ein erfolgreicher Build ersetzt keinen Live-Betriebstest.

## Indikatoren und Momentum

Alle technischen Indikatoren werden ausschließlich aus abgeschlossenen Binance-Tageskerzen berechnet. Nicht ausreichend lange oder nicht frische Candle-Serien ergeben fehlende Kennzahlen oder eine nicht auswertbare Richtungsbewertung.

- EMA 20/50/200 und SMA 20/50
- RSI 14 mit Wilder-Glättung
- MACD (EMA 12 minus EMA 26), Signallinie EMA 9 und Histogramm
- ATR 14 einschließlich ATR in Prozent des Schlusskurses
- 20-Tage-Volatilität aus der Stichproben-Standardabweichung täglicher logarithmischer Renditen
- Support und Resistance als Tief/Hoch der vorherigen 20 abgeschlossenen Tageskerzen; Breakout-Vergleich mit dem letzten Schlusskurs
- Trend anhand der Lage des Schlusskurses zu EMA 20 und EMA 20 zu EMA 50

Der Momentum Scanner nutzt abgeschlossene Stundenkerzen: Preisänderung über 6h und 24h, Quote-Volumenänderung der letzten 24h gegenüber den vorherigen 24h, EMA-Trend und annualisierte 24h-Stundenvolatilität. Ohne alle benötigten Größen oder bei nicht frischen Stundenkerzen gibt es kein Rating. Das dynamische Rating (0–100) kombiniert Preisbewegung (35%), Volumenänderung (25%), Trend (25%) und Volatilität (15%); die Einzelkomponenten und Gewichte sind im Code nachvollziehbar.

## Radar, Evidence und Confidence

Radar-Reports enthalten Stance, Zustand, Evidence, aktuelle Daten, Quellenstatus, Quellzeitstempel, Datenstatus, Gründe und Invalidierung. Die Zustände sind:

- `stand_aside` – kein belastbares Signal oder Short-Einordnung
- `observe` – Daten oder Bestätigung reichen nicht für eine attraktive Long-Einordnung
- `attractive_risk_reward` – bestätigtes Long-Signal mit mindestens 50 Qualitätsindex und Risiko-Score unter 60

Die angezeigte Invalidierung verwendet „Kauf-Idee stimmt nicht mehr unter …“. Fehlt eine belastbare EMA-50-Schwelle, wird diese Einschränkung explizit genannt.

Der Confidence-Wert wird deterministisch aus Live-Evidence-Abdeckung (25%), Frische (20%), Richtungsübereinstimmung (20%), Quellenkonsistenz (20%) und Rohdaten-Verifikation (15%) gebildet. Je gegensätzlichem Agentenpaar werden 10 Punkte abgezogen; das Ergebnis wird auf 0–100 begrenzt. Es handelt sich ausdrücklich nicht um eine Trefferquote. LLM-Interpretationen zählen nicht als Rohdaten-Evidence.

Der Verification Agent berechnet Indikatoren erneut aus dem gespeicherten Candle-Snapshot. Er vergleicht Evidence-Werte mit Toleranz entsprechend ihrer angezeigten Rundung, prüft Quellenzuordnung, Status und Zeitstempel und markiert nicht mechanisch prüfbare Aussagen sowie Richtungswidersprüche. Gemini-Ausgaben werden als Interpretation gekennzeichnet und nicht als verifizierte Marktfakten gezählt.

## Paper Trading und Outcome-Auswertung

Bestehende virtuelle Positionen behalten Entry, Exit, Stop/Take-Profit, P&L und Trade-Historie. Eine neue Position wird nur zugelassen, wenn ein passender Richtungsreport live ist, mindestens zwei live-evidenzbasierte Agents übereinstimmen und der Verifikationswert mindestens 70 beträgt. Preisstatus einer offenen Position unterscheidet live, stale und missing.

Radar-Signale werden mit Snapshot und eindeutiger Signal-ID gespeichert. Ausreichend alte Signale werden anhand frischer Binance-Kerzen nach 1h, 24h und 168h bewertet. Performance wird nach Asset, Signaltyp und Horizont gruppiert; Trefferzahlen, Trefferquote und mittlere Rendite beruhen nur auf gespeicherten Outcomes. Neutrale Signale haben keine gerichtete Trefferquote. Fehlerquellen zählen fehlende/veraltete Daten, Quellenabweichungen, Verifikationsmismatches und widersprüchliche Agentensignale.

Die Speicherung benötigt die PostgreSQL-Tabellen `radar_signals` und `radar_signal_outcomes`. Das Schema ist in Drizzle definiert, wurde hier aber nicht in einer Datenbank migriert. Bei DB-Ausfall bleibt das Radar verfügbar und meldet `learningStatus: unavailable`; die Performance-Abfrage meldet dann einen Fehler statt einer Erfolgssimulation.

## Tests und offene Punkte

Die automatisierten Tests decken unter anderem Candle-Validierung und -Lücken, Indikatorberechnung und unzureichende/konstante Daten, Momentum, Verifikation, Performance-Auswertung, Paper-P&L und stale Preisstatus ab. Der datenbankgestützte Integrationstest wird nur mit `PHASE2_DATABASE_TEST=1` ausgeführt und war in der lokalen Standardumgebung nicht aktiv.

Weiterhin nicht angebunden und deshalb ausdrücklich fehlend: News-Feeds, Social-Media-Sentiment, On-Chain-Daten, Makro-/Zinsdaten sowie Provider für Aktien, Indizes und Rohstoffe. Es gibt kein behauptetes KI-Lernen und keine garantierte Trefferquote.

**Für Phase 5 offen:**

- Radar-Tabellen in der Ziel-Datenbank migrieren und den Persistenz-/Outcome-Fluss mit einer konfigurierten Testdatenbank integrieren.
- Provider-Monitoring, Retry-/Rate-Limit-Strategie und Laufzeitbeobachtung für Datenqualität ergänzen.
- Langfristige Outcome-Auswertung auf ausreichend große Stichproben und weitere Zeitfenster erweitern.
- Optional weitere Datenanbieter anbinden, bevor News-, Social-, On-Chain-, Makro- oder Nicht-Krypto-Analysen aktiviert werden.
- Paper-Trading-Signale und tatsächliche virtuelle Ergebnisse systematisch vergleichen, ohne daraus ungeprüfte Performanceversprechen abzuleiten.
