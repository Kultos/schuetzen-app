# Schützen-Wettkampf Auswertung

Lokale Wettkampfverwaltung mit dauerhaftem Schützenstamm, freiwilligen E-Mail-Kontakten, eventbezogenen Startnummern und Teilnahmehistorie. Node.js 24 oder neuer, keine npm-Installation erforderlich.

## Start und Umstellung

1. Vor einem Update bisherigen Server beenden und Datenordner separat sichern.
2. `start.bat` starten und am Server `http://localhost:3000` öffnen.
3. Einmalig ein Verwaltungskennwort mit mindestens 12 Zeichen festlegen. Einrichtung ist nur über localhost möglich.
4. Unter „Saison & Netzwerk“ Titel und tatsächliches Veranstaltungsjahr des übernommenen Events speichern.

Beim ersten Start mit alter Datenbank entsteht vor Änderungen eine geprüfte Kopie in `data/backups/`. Die Migration übernimmt Personen, Nummern, Disziplinen und Ergebnisse in ein aktives Event. Sie läuft vollständig in einer Transaktion und wird bei Fehlern zurückgerollt. Das Jahr wird nicht aus Dateidaten geraten. Das Vorabbackup hat noch das alte Schema: zur Rückkehr mit der vorherigen App-Version öffnen, nicht über den neuen Systemrestore.

Das Serverfenster bleibt während des Betriebs geöffnet. Mehrere Helfer benutzen dieselbe Serverinstanz. Keine zweite Instanz auf denselben Datenordner starten.

## Stamm, Teilnahmen und Historie

- **Schützen:** Teilnehmer des aktiven Events. Neue Personen werden im Stamm angelegt und angemeldet. Nummern sind pro Event eindeutig und können bei Konflikten getauscht werden.
- **Schützenstamm & Historie:** Vorhandene Person suchen und ausdrücklich anmelden, dabei eine neue Startnummer vergeben. Gleiche Namen dürfen unterschiedliche Personen bezeichnen. Personen lassen sich auch ohne Anmeldung anlegen.
- **Stammdaten bearbeiten:** Historische Namen bleiben erhalten. Bearbeiten eines aktiven Teilnehmers aktualisiert dessen aktuelle Teilnahme und Stamm.
- **Aus Event entfernen:** Entfernt aktuelle Teilnahme und deren Ergebnisse; Stamm und frühere Events bleiben erhalten.
- **Archivieren:** Verhindert neue Anmeldungen und Einladungsexporte bis zur Reaktivierung. Die Historie bleibt bestehen.
- **Historie:** Jahr, Event, damalige Startnummer und Abschlussplätze je Disziplin. Ohne Ergebnis: „Angemeldet, ohne Ergebnis“.

„Bisheriges Event abschließen und neues starten“ erstellt ein Vorabbackup, speichert Abschlussplätze und öffnet ein leeres Event. Der Stamm bleibt erhalten. Disziplinen werden für das neue Event neu angelegt. Wiederholte Anfragen mit dem alten Event werden abgewiesen; Helfer mit einer veralteten Ansicht müssen neu laden.

Wertung: beste Serie, danach alle Folgeserien; bei vollständig gleichen Serien entscheidet der Name alphabetisch (`series-name-v1`). Abgeschlossene Plätze werden gespeichert. Unter „Events und Abschlusswertungen“ können vorhandene Punktwerte mit Begründung korrigiert werden. Ein erneuter Abschluss erzeugt eine neue Wertungsversion; vorherige Wertungen bleiben in der Datenbank erhalten.

Das Live-Dashboard unter `/dashboard` bleibt ohne Anmeldung erreichbar. Es zeigt ausschließlich das aktive Event und niemals E-Mail-Adressen oder Einwilligungen. Ranglisten lassen sich weiterhin im Browser drucken beziehungsweise als PDF speichern.

## E-Mail und Datenschutz

„E-Mail / Einwilligung“ verlangt Adresse, tatsächlich verwendeten Einwilligungstext, Nachweis/Belegnummer und ausdrückliche Bestätigung. Keine vorangekreuzte Einwilligung, keine Pflichtadresse. Der Verein stellt einen Text mit Verantwortlichem, Zweck und Widerrufskontakt bereit und verwahrt den zugehörigen Nachweis. Für eine andere Adresse wird erneut ein Nachweis dokumentiert.

Einladungsexporte enthalten Name und Adresse nicht archivierter Personen mit freigegebener Einwilligung und mindestens einer Eventanmeldung, optional nach Event gefiltert. Gleiche Adressen werden zusammengefasst. Kein automatischer Versand. Vor jedem Versand aktuell exportieren, BCC oder ein geeignetes Versandsystem verwenden und alte Empfängerdateien löschen.

Widerruf entfernt den nutzbaren Kontakt sofort. Text, Belegverweis und Widerrufsdokumentation bleiben separat zur Nachweisführung erhalten. „Personendaten löschen“ entfernt Name und Kontakt aus Stamm und Teilnahmen. Ergebnisse, Geschlechtsangabe und Eventzusammenhang bleiben mit dem Namen „Gelöschter Teilnehmer“ bestehen; das garantiert bei kleinen Gruppen keine vollständige Anonymität. Betroffene verwaltete Eventdateien werden entfernt und können bereinigt neu exportiert werden. Bei alten Dateien ohne UUID können alle Dateien mit demselben Namen betroffen sein. Extern weitergegebene Kopien müssen organisatorisch berücksichtigt werden.

Rechtsgrundlagen, Informationen an Betroffene und Fristen für Stamm, Ergebnisgeschichte und Nachweise legt der Verein getrennt fest. Die Einladungseinwilligung deckt nicht automatisch jede Verarbeitung ab. Vor jedem Event alte Kontakte/Stammdaten prüfen und Nachweise nach dem festgelegten Löschkonzept bereinigen. Die App zertifiziert keine DSGVO-Konformität.

## LAN und HTTPS

HTTP erlaubt Verwaltung nur direkt am Server über localhost. Im LAN ist bei HTTP nur das öffentliche Dashboard verfügbar. Private API-Aufrufe benötigen eine Sitzung; Berechtigungen werden serverseitig geprüft. Sitzungen gelten acht Stunden, Kennwörter werden mit Salt und scrypt gehasht. Nach fünf fehlgeschlagenen Anmeldungen je Adresse gilt eine Wartezeit von 15 Minuten.

Für Verwaltung über andere Geräte ein dort vertrauenswürdiges Zertifikat einrichten und beispielsweise in PowerShell starten:

```powershell
$env:SCHUETZEN_TLS_CERT = 'D:\Verein\tls\server-cert.pem'
$env:SCHUETZEN_TLS_KEY = 'D:\Verein\tls\server-key.pem'
node server.js
```

Danach `https://SERVERNAME:3000` verwenden. Zertifikat und Name müssen übereinstimmen. TLS wird direkt von Node bereitgestellt; Proxy-Header werden nicht als sichere Verbindung akzeptiert. Firewall nur im privaten Vereinsnetz freigeben, keine Internet-Portweiterleitung. Datenordner durch Windows-Berechtigungen und Laufwerksverschlüsselung schützen. SQLite-Dateien und Downloads sind selbst nicht verschlüsselt.

`data/admin.json` enthält die Kennwortkonfiguration und wird durch Datenrestore nicht ersetzt. Auf einem Ersatzgerät ein neues Kennwort lokal einrichten. Bei vergessenem Kennwort kann ein berechtigter Windows-Administrator bei beendetem Server diese Datei außerhalb des Datenordners umbenennen und lokal neu einrichten.

## Eventexport und Import

Ein Eventexport ist JSON, Version 2, mit stabilen Personen-/Event-UUIDs, damaligen Namen, Nummern, Ergebnissen und letzter Abschlusswertung. Keine Kontakte oder Einwilligungen; dennoch personenbezogene Daten.

Unter „Import“ die Datei auswählen. Die Vorschau verlangt Jahr und für jede Person Zuordnung oder Neuanlage. Übereinstimmende UUIDs werden vorgegeben; Namen allein führen niemals automatisch zusammen. Bestätigte Zuordnungen abweichender UUIDs werden für weitere Importe gespeichert. Das Event ergänzt die Historie, aktives Event und Kontakte bleiben erhalten. Vorhandene Events und wiederholte gleiche Imports werden abgewiesen.

Alte Saisonarchive bleiben lesbar. Numerische IDs gelten nur innerhalb der Datei. Fehlende Nummern werden deterministisch ergänzt. Berechnete Plätze aus alten oder noch nicht abgeschlossenen Events werden als rekonstruiert gekennzeichnet.

CSV/Excel ergänzt das aktive Event. Bekannte Personen vorher anmelden; vorhandene Stammnamen werden nicht automatisch neu angelegt. Bei Namensgleichheit Startnummer verwenden. Excel lädt SheetJS 0.18.5 von cdnjs mit fest hinterlegter SHA-512-Integritätsprüfung und ohne Referrer; CSV und JSON funktionieren vollständig offline und sind aus Datenschutzsicht vorzuziehen.

## Vollbackups

Vollbackups enthalten Stamm, Kontakte, Nachweise, alle Events und Wertungsversionen. Sie werden als konsistente SQLite-Kopie mit `VACUUM INTO` erzeugt, auf Integrität und Fremdschlüssel geprüft und mit SHA-256-Prüfsumme versehen. Gelöschte freie SQLite-Seiten werden nicht kopiert.

Sicherung beim regulären Start und danach spätestens alle fünf Minuten nach Änderungen. Zusätzlich vor Migration, Eventwechsel, Korrekturmodus, Eventimport und Vollrestore sowie nach Eventwechsel. Manuell über „Vollbackup erstellen“. Änderungen seit dem letzten erfolgreichen Backup können bei abruptem Ausfall verloren gehen.

Ein zweites, bereits vorhandenes Verzeichnis auf einem verschlüsselten externen Medium konfigurieren:

```powershell
$env:SCHUETZEN_BACKUP_DIR = 'E:\Schuetzen-Backups'
$env:SCHUETZEN_BACKUP_RETENTION_DAYS = '30'
node server.js
```

Ein unerreichbares Ziel wird angezeigt und beim nächsten Lauf erneut versucht. Das separate Datenschutzprotokoll wird ebenfalls kopiert. Die Anzeige unterscheidet lokale Sicherung und externe Bestätigung im laufenden Server. Bei beendetem Server oder abgestecktem Medium erfolgt keine externe Sicherung. Eine Kopie auf derselben Festplatte schützt nicht vor deren Verlust; regelmäßig zusätzlich eine getrennt verwahrte Kopie anlegen.

Automatische Läufe bereinigen lokale und externe, anhand ihrer Begleitdatei erkannte Backups nach der konfigurierten Frist (Standard 30 Tage). Das jeweils neueste Backup bleibt als letzte Rückfallmöglichkeit auch bei höherem Alter erhalten. Downloads/manuelle Kopien werden nicht automatisch bereinigt. Die Frist muss zum Löschkonzept passen. Eventarchive haben eine eigene Aufbewahrungsregel.

## Vollrestore und Datenschutzabgleich

Backup-Links liefern portables JSON mit eingebetteter SQLite-Kopie und Prüfsumme. Unter „Vollbackup wiederherstellen“ auswählen. Vorschau prüfen und bestätigen. Vorher wird der aktuelle Bestand gesichert. Schema, Prüfsumme, Integrität und Referenzen werden geprüft. Alle Tabellen werden in einer einzigen SQLite-Transaktion übernommen. Kein Umbenennen einer geöffneten Windows-Datenbank; bei Fehlern bleibt der vorige Stand erhalten.

Danach werden Sitzungen beendet und Dashboard sowie normaler Eventbetrieb gesperrt. Neu anmelden, im Schützenstamm nötige Bereinigungen ausführen und unter „Saison & Netzwerk“ den Datenschutzabgleich dokumentieren. Kontaktfreigaben aus dem Backup bleiben auf „Prüfung“ und benötigen pro Person erneut einen belegten Nachweis.

`data/privacy-journal.json` enthält UUID, Zeitpunkt und Aktion von Widerrufen/Namenslöschungen. Es wird vor der Änderung dauerhaft geschrieben, bei jedem Start erneut angewendet und beim Restore nicht zurückgesetzt. Es enthält selbst schutzbedürftige pseudonyme Daten. Fehlt es auf einer bestehenden Installation oder ist es beschädigt, stoppt der Start. Bei beendetem Server das aktuelle separat gesicherte Protokoll wiederherstellen. Auf Ersatzgeräten die neueste Protokollkopie vor dem Restore in den Datenordner legen. Ein Backup kann spätere Widerrufe nicht ausschließen: fehlende Änderungen vor Freigabe anhand der Vereinsunterlagen abgleichen.

Externe Kopien bestehen aus `.sqlite`, `.sqlite.json` und `.sqlite.privacy.json`; zusätzlich wird die neueste Journaldatei als `privacy-journal.json` abgelegt. Zum Verpacken für den Upload:

```text
node backup-tool.js pack E:\Schuetzen-Backups\DATEINAME.sqlite D:\Verein\restore.json
```

Vor jedem Wettkampf einen Restore in einem separaten Testdatenordner proben (`SCHUETZEN_DATA_DIR`); Personen, Jahre, Plätze und Widerrufe stichprobenartig prüfen. Dabei niemals den laufenden Wettkampf überschreiben.

## Datenablage und Tests

- `data/wettkampf.db`: relationale Datenbank, Schema 3.
- `data/backups/`: geprüfte Vollbackups und Begleitdateien.
- `data/archive/`: verwaltete Eventexports.
- `data/privacy-journal.json`: separates Datenschutzprotokoll.
- `data/admin.json`: lokale Kennwortkonfiguration außerhalb des Datenrestores.

Der gesamte Datenordner ist von Git ausgeschlossen. `SCHUETZEN_DATA_DIR` wählt einen anderen lokalen Datenordner. SQLite nicht auf einem gemeinsam beschriebenen Netzlaufwerk betreiben.

```text
node --test --test-concurrency=1
```

Die Tests verwenden ausschließlich temporäre Datenbanken. Sie prüfen Migration/Rückabwicklung, Wiederanmeldung, Startnummern, Historie, Zugriffsschutz, beschädigte Backups und Widerrufe/Löschungen nach Restore. `npm test` ruft denselben Befehl auf, sofern npm korrekt installiert ist.
