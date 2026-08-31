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

- **Schützen**: Neue Schützen mit Name und Geschlecht anlegen.
- **Disziplinen**: Disziplinen für den aktuellen Wettkampf anlegen (beliebig viele, jederzeit erweiterbar).
- **Ergebnisse erfassen**: Schütze + Disziplin auswählen, dann Durchgänge (Punktzahlen) nacheinander eintragen.
- **Ranglisten**: Disziplin auswählen → Rangliste wird automatisch berechnet (bester Durchgang zählt, bei Gleichstand entscheidet der nächstbeste Durchgang). Über "Drucken / Als PDF" lässt sich die Liste ausdrucken oder als PDF speichern (im Druckdialog des Browsers "Als PDF speichern" wählen).
- **Excel/CSV-Import**: Bestehende Excel-Tabellen (.xlsx) oder CSV-Dateien importieren.
  - **Vereins-Vorlage "Startmeldung"** (wie bisher verwendet, mit "Beste Serie"/"Folgeserien" je Disziplin): wird automatisch erkannt. Es erscheint eine Zusammenfassung (erkannte Disziplinen, Anzahl Schützen/Ergebnisse) – einfach auf "Import starten" klicken. Schützen ohne bisheriges Ergebnis werden dabei übersprungen und müssen danach manuell unter "Schützen" ergänzt werden.
  - **Andere/einfache Listen** (eine Zeile = ein Ergebnis): Nach Dateiauswahl erscheint stattdessen die Spalten-Zuordnung (Name, Geschlecht, Disziplin, Durchgang, Punkte).
  - *Hinweis: Für den Excel-Import (.xlsx/.xlsm) ist einmalig eine Internetverbindung nötig, um eine kleine Hilfsbibliothek zu laden. CSV-Dateien funktionieren immer komplett offline.*
- **Saison & Netzwerk**: Hier kann der Titel des aktuellen Events (z.B. „Vereinsschießen 2026“) gespeichert werden. Er erscheint auf gedruckten Ranglisten, ist im Export enthalten und wird als Export-/Archivdateiname verwendet. Außerdem zeigt die Ansicht die Netzwerkadresse und ermöglicht das Starten einer neuen Saison (siehe unten).

## Neue Saison starten

Da der Wettkampf jährlich neu stattfindet, kann über **"Saison & Netzwerk" → "Neue Saison starten"** die komplette Datenbasis zurückgesetzt werden. **Vor dem Zurücksetzen wird automatisch ein Archiv der bisherigen Saison gespeichert** (im Ordner `data/archive/`), sodass keine Daten verloren gehen. Diese Archive lassen sich in derselben Ansicht auch herunterladen.

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
→ Im Ordner `data/archive/` liegen die JSON-Archive vergangener Saisons. Diese dienen aktuell als Sicherung/Nachschlagewerk (kein automatischer Wiederherstellungs-Import in der Oberfläche).

## Vereinslogo einbinden (optional)

Eine Bilddatei `logo.png` in den Ordner `public/` legen (gleicher Ordner wie `index.html`). Sie erscheint dann automatisch im Kopfbereich der App und auf den ausgedruckten Ranglisten.
