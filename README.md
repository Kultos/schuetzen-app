# Schützen-Wettkampf Auswertung – Kurzanleitung

## Einmalige Einrichtung

1. **Node.js installieren** (einmalig, falls noch nicht vorhanden): https://nodejs.org – die Version "LTS" herunterladen und installieren (einfach "Weiter" klicken).
2. Diesen Ordner (`schuetzen-app`) auf den Laptop kopieren, der beim Wettkampf als "Server" dient.

Das war's – **kein weiterer Installationsschritt nötig**, da die App keine zusätzlichen Programmpakete braucht.

## App starten

Doppelklick auf **`start.bat`**.

Ein schwarzes Fenster öffnet sich und zeigt u.a.:

```
Lokal:   http://localhost:3000
Im LAN:  http://192.168.x.x:3000
```

- Am Laptop selbst: Browser öffnen und `http://localhost:3000` aufrufen.
- Von anderen Geräten (Smartphone, Tablet) im selben WLAN: die zweite Adresse (`Im LAN: ...`) im Browser eingeben. Diese Adresse wird auch in der App selbst unter **"Saison & Netzwerk"** angezeigt.

**Wichtig:** Das schwarze Fenster muss geöffnet bleiben, solange die App genutzt wird. Schließen beendet den Server.

## Bedienung

- **Schützen**: Neue Schützen mit Name, Geschlecht und einer eindeutigen Startnummer anlegen. Die nächste freie Nummer wird vorgeschlagen, kann aber vor dem Speichern geändert werden. Bei einer nachträglichen Korrektur auf eine bereits belegte Nummer können die Nummern direkt getauscht werden.
- **Disziplinen**: Disziplinen für den aktuellen Wettkampf anlegen (beliebig viele, jederzeit erweiterbar).
- **Ergebnisse erfassen**: Schütze + Disziplin auswählen, dann Durchgänge (Punktzahlen) nacheinander eintragen.
- **Ranglisten**: Disziplin auswählen → Rangliste wird automatisch berechnet (bester Durchgang zählt, bei Gleichstand entscheidet der nächstbeste Durchgang). Über "Drucken / Als PDF" lässt sich die Liste ausdrucken oder als PDF speichern (im Druckdialog des Browsers "Als PDF speichern" wählen).
- **Live-Dashboard**: Für einen TV im Schützenhaus zeigt die App automatisch aktualisierte Ranglisten und die neuesten Ergebnisse. In der App den Tab "Live-Dashboard" öffnen und auf **"Auf TV öffnen"** klicken – oder am TV direkt `http://SERVER-IP:3000/dashboard` aufrufen. Die Anzeige aktualisiert sich alle 5 Sekunden; die Disziplin wechselt standardmäßig alle 15 Sekunden.
- **Excel/CSV/JSON-Import**: Bestehende Excel-Tabellen (.xlsx), CSV-Dateien oder exportierte JSON-Saisonarchive importieren.
  - **JSON-Saisonarchive**: Ein zuvor exportiertes oder automatisch archiviertes Event wird mit Titel, allen Schützen, Disziplinen und Ergebnissen vollständig wiederhergestellt. Die aktuell geladene Saison wird ersetzt und vorher automatisch archiviert, sofern sie Daten enthält.
  - **Vereins-Vorlage "Startmeldung"** (wie bisher verwendet, mit "Beste Serie"/"Folgeserien" je Disziplin): wird automatisch erkannt. Es erscheint eine Zusammenfassung (erkannte Disziplinen, Anzahl Schützen/Ergebnisse) – einfach auf "Import starten" klicken. Schützen ohne bisheriges Ergebnis werden dabei übersprungen und müssen danach manuell unter "Schützen" ergänzt werden.
  - **Andere/einfache Listen** (eine Zeile = ein Ergebnis): Nach Dateiauswahl erscheint stattdessen die Spalten-Zuordnung (Name, Geschlecht, Disziplin, Durchgang, Punkte).
  - *Hinweis: Für den Excel-Import (.xlsx/.xlsm) ist einmalig eine Internetverbindung nötig, um eine kleine Hilfsbibliothek zu laden. CSV-Dateien funktionieren immer komplett offline.*
- **Saison & Netzwerk**: Hier kann der Titel des aktuellen Events (z.B. „Vereinsschießen 2026“) gespeichert werden. Er erscheint auf gedruckten Ranglisten, ist im Export enthalten und wird als Export-/Archivdateiname verwendet. Außerdem zeigt die Ansicht die Netzwerkadresse und ermöglicht das Starten einer neuen Saison (siehe unten).

## Neue Saison starten

Da der Wettkampf jährlich neu stattfindet, kann über **"Saison & Netzwerk" → "Neue Saison starten"** die komplette Datenbasis einschließlich der Startnummern zurückgesetzt werden. Die Nummerierung beginnt in der neuen Saison wieder bei 1. **Vor dem Zurücksetzen wird automatisch ein Archiv der bisherigen Saison gespeichert** (im Ordner `data/archive/`), sodass keine Daten verloren gehen. Diese Archive lassen sich in derselben Ansicht auch herunterladen.

## Troubleshooting

**Problem: Vom Smartphone aus ist die Seite nicht erreichbar.**
→ Meist liegt es an der Windows-Firewall. Beim ersten Start fragt Windows oft, ob der Zugriff erlaubt werden soll – hier "Zugriff zulassen" (privates Netzwerk) wählen. Falls diese Abfrage verpasst wurde:
1. Windows-Suche → "Windows Defender Firewall" öffnen.
2. "Eine App durch die Firewall zulassen" wählen.
3. "Node.js" suchen/hinzufügen und für **private Netzwerke** aktivieren.

**Problem: Smartphone und Laptop sehen sich trotzdem nicht.**
→ Beide Geräte müssen im **selben WLAN** sein (nicht z.B. eines im Gäste-WLAN).

**Problem: Server startet nicht / Fehlermeldung beim Doppelklick auf `start.bat`.**
→ Prüfen, ob Node.js korrekt installiert wurde (in der Eingabeaufforderung `node --version` eingeben – es sollte eine Versionsnummer erscheinen).

**Problem: Ich möchte alte Daten wiederherstellen.**
→ Im Ordner `data/archive/` liegen die JSON-Archive vergangener Saisons. Das gewünschte Archiv kann unter **Import** ausgewählt und vollständig wiederhergestellt werden.

## Vereinslogo einbinden (optional)

Eine Bilddatei `logo.png` in den Ordner `public/` legen (gleicher Ordner wie `index.html`). Sie erscheint dann automatisch im Kopfbereich der App und auf den ausgedruckten Ranglisten.

## Tests ausführen

Die automatisierten Tests verwenden ausschließlich temporäre Datenbanken und verändern `data/wettkampf.db` nicht.

```text
npm test
```

Alternativ können sie ohne npm direkt mit `node --test --test-concurrency=1` gestartet werden. Ein Coverage-Bericht lässt sich mit `npm run test:coverage` erzeugen. CSV- und Excel-Import sind als veraltet nicht Bestandteil der Testsuite.
