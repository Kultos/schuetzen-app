# HTTPS-Zertifikat einrichten – Windows

Diese Anleitung trennt die einmalige Einrichtung auf dem Host vom Hinzufügen der Clients. Sie geht von Windows 10/11 und Edge oder Chrome aus.

- **Host:** Das Gerät, auf dem der Server läuft, hier `192.168.2.73`.
- **Client:** Dein Laptop oder ein weiteres Gerät, auf dem du die Verwaltung öffnest.
- **Anzeigegerät:** Ein Gerät, das ausschließlich das öffentliche Dashboard per HTTP zeigt.

Die App unterstützt HTTP und HTTPS gleichzeitig. Ohne Zertifikat läuft zunächst nur HTTP. Nach der folgenden Einrichtung bleibt die HTTP-Ansicht bestehen und die HTTPS-Verwaltung kommt hinzu.

Nach der Einrichtung verwendest du diese Adressen:

| Zweck | Adresse |
| --- | --- |
| Öffentliche Ansicht | `http://192.168.2.73:3000/dashboard` |
| Verwaltung | `https://192.168.2.73:3443/` |

## A. Ersteinrichtung auf dem Host

Alle Schritte dieses Abschnitts **auf dem Hostgerät** ausführen.

### 1. Adresse und App-Ordner prüfen

Reserviere im Router die IP-Adresse `192.168.2.73` für den Host. So passt die Adresse auch nach einem Neustart zum Zertifikat.

Die Befehle verwenden `C:\git\schuetzen-app` als App-Ordner. Liegt die App auf dem Host woanders, passe den Pfad im nächsten Schritt an.

### 2. Zertifikatwerkzeug installieren

Öffne über das Startmenü **PowerShell** und füge ein:

```powershell
winget install --exact --id FiloSottile.mkcert
```

Bestätige eventuelle Rückfragen. Schließe PowerShell anschließend und öffne sie erneut, damit der neue Befehl gefunden wird.

Falls `winget` fehlt, installiere beziehungsweise aktualisiere den **App-Installer** aus dem Microsoft Store.

### 3. Lokalen Zertifikatsaussteller einrichten

Verwende den Windows-Benutzer, mit dem du die Host-Einrichtung begonnen hast. Führe aus:

```powershell
mkcert -install
```

Bestätige die Windows-Rückfragen. Das Werkzeug erstellt einen lokalen Zertifikatsaussteller und richtet das Vertrauen auf dem Host ein. Bei einer Berechtigungsfehlermeldung PowerShell als Administrator mit demselben Benutzer öffnen und den Befehl wiederholen.

**Bereits nach der früheren Anleitung erledigt?** Dann kannst du das vorhandene Werkzeug und denselben Aussteller weiterverwenden.

### 4. Serverzertifikat erstellen

Führe in PowerShell aus:

```powershell
Set-Location 'C:\git\schuetzen-app'
New-Item -ItemType Directory -Force '.\data\tls' | Out-Null
mkcert -cert-file '.\data\tls\server-cert.pem' -key-file '.\data\tls\server-key.pem' 192.168.2.73 localhost 127.0.0.1 ::1
```

Ergebnis im Ordner `data\tls`:

- `server-cert.pem`: Zertifikat für den Server.
- `server-key.pem`: Privater Schlüssel; bleibt auf dem Host.

Falls die beiden Dateien bereits nach der früheren Anleitung für diese Adresse erstellt wurden, überspringe diesen Schritt. Ein zusätzliches Zertifikat für Port 3443 ist nicht nötig: Zertifikate sind nicht an einen Port gebunden.

### 5. Datei für Clients vorbereiten

Führe im selben PowerShell-Fenster aus:

```powershell
$caDirectory = (mkcert -CAROOT).Trim()
certutil -decode "$caDirectory\rootCA.pem" '.\data\tls\schuetzen-root.cer'
```

Im Ordner `C:\git\schuetzen-app\data\tls` liegt jetzt zusätzlich **`schuetzen-root.cer`**. Das ist das öffentliche Zertifikat des Ausstellers, in einem für den Windows-Import geeigneten Format.

**Nur `schuetzen-root.cer` an Clients weitergeben**, beispielsweise per eigenem USB-Stick. Die privaten Schlüssel `rootCA-key.pem` und `server-key.pem` bleiben auf dem Host. Keine vollständigen Zertifikatsordner kopieren.

Ist `schuetzen-root.cer` bereits vorhanden und stammt sie vom selben Aussteller, kannst du diese Datei wiederverwenden.

### 6. HTTPS und Autostart aktivieren

Führe im App-Ordner auf dem Host aus:

```powershell
.\setup-windows.bat
```

Bestätige die Administratorabfrage und warte auf die Erfolgsmeldung. Die Einrichtung erkennt die Dateien in `data\tls`, prüft sie und richtet beide Zugänge samt Firewall-Freigabe im privaten Netzwerk ein. Eine vorhandene Serveraufgabe wird neu gestartet. Vorhandene Port-, Daten- und Backupeinstellungen werden übernommen. Das Desktop-Symbol „Schützen-App öffnen“ funktioniert weiterhin.

Falls bisher ein manuelles Serverfenster geöffnet ist, beende diesen Server zuerst mit **Strg+C**, bevor du die automatische Einrichtung startest.

Bei einem abweichenden Datenordner gehören die Zertifikate in dessen Unterordner `tls`. Dieser Datenordner wird bei erneuter Einrichtung aus der vorhandenen Serveraufgabe übernommen; bei der Ersteinrichtung kannst du ihn mit `-DataDirectory` angeben.

Nur bei bewusst manuellem Betrieb: Statt der Einrichtung den bisherigen Server mit **Strg+C** beenden und im App-Ordner `node server.js` starten. Die Zertifikate werden ebenfalls automatisch erkannt; die private Firewall-Freigabe für Port 3443 muss dann separat eingerichtet werden.

### 7. Am Host prüfen

Öffne am Host in Edge oder Chrome beide Adressen:

- `http://localhost:3000/dashboard` – öffentliche Ansicht.
- `https://localhost:3443/` – Verwaltung über HTTPS.

Beide Seiten müssen erreichbar sein. Falls noch kein Verwaltungskennwort besteht, kannst du es direkt am Host über `http://localhost:3000/` einrichten. Ein vorhandenes Kennwort bleibt gültig.

## B. Ersteinrichtung auf deinem Client-Laptop

Alle Schritte dieses Abschnitts **auf deinem Laptop** ausführen. Dort muss `mkcert` nicht installiert werden.

### 1. Öffentliches Zertifikat übernehmen

Kopiere die vom Host vorbereitete Datei **`schuetzen-root.cer`** auf den Laptop. Verwende die Datei von deinem eigenen Host.

### 2. Zertifikat installieren

1. Doppelklicke `schuetzen-root.cer`.
2. Klicke auf **Zertifikat installieren**.
3. Wähle **Aktueller Benutzer** und klicke **Weiter**.
4. Wähle **Alle Zertifikate in folgendem Speicher speichern**.
5. Klicke **Durchsuchen**.
6. Wähle **Vertrauenswürdige Stammzertifizierungsstellen** und bestätige mit **OK**.
7. Klicke **Weiter**, dann **Fertig stellen**.
8. Bestätige die Sicherheitsabfrage für deinen eigenen Zertifikatsaussteller.

Das Vertrauen gilt für diesen Windows-Benutzer. Nutzt jemand auf demselben Laptop ein anderes Windows-Konto, muss das Zertifikat auch in diesem Konto importiert werden.

### 3. Verbindung prüfen

Schließe alle Fenster von Edge beziehungsweise Chrome und öffne den Browser erneut.

Öffne:

```text
https://192.168.2.73:3443/
```

Die Seite soll ohne Zertifikatswarnung erscheinen. Melde dich mit dem bestehenden Verwaltungskennwort an. Ein noch fehlendes Verwaltungskennwort muss zuerst direkt am Host über localhost eingerichtet werden.

## C. Weitere Geräte hinzufügen

### Weiterer Client für die Verwaltung

**Auf dem Host:** Die bereits vorhandene Datei `data\tls\schuetzen-root.cer` bereitstellen. Es muss kein neues Zertifikat erstellt und der Server dafür nicht neu gestartet werden.

**Auf dem neuen Windows-Client:** Abschnitt B durchführen: Datei übernehmen, als vertrauenswürdigen Aussteller installieren, Browser neu öffnen und die HTTPS-Adresse aufrufen.

Für jeden weiteren Client dieselbe öffentliche Datei verwenden. Auf Clients keinen eigenen Aussteller mit `mkcert -install` erstellen.

### Weiteres Gerät nur für die Anzeige

Auf dem Anzeigegerät im selben lokalen Netzwerk direkt öffnen:

```text
http://192.168.2.73:3000/dashboard
```

Für diese HTTP-Ansicht ist keine Zertifikatsinstallation erforderlich. Die Verwaltung über HTTP bleibt im LAN gesperrt.

## Wenn etwas nicht funktioniert

| Beobachtung | Nächster Schritt |
| --- | --- |
| HTTP funktioniert, HTTPS auf 3443 nicht | Am Host Schritt A.6 ausführen. Prüfen, ob das Windows-Netzwerk als privat eingestellt ist. Bei manueller Einrichtung außerdem die Firewall-Freigabe für TCP-Port 3443 prüfen. |
| Der Browser vertraut dem Aussteller nicht | Prüfen, ob `schuetzen-root.cer` vom richtigen Host im Speicher „Vertrauenswürdige Stammzertifizierungsstellen“ des aktuellen Benutzers liegt. Browser vollständig neu starten. |
| Der Browser meldet einen falschen Namen | Genau die im Zertifikat enthaltene Adresse verwenden, hier `192.168.2.73`. Bei anderer Host-IP ist ein neues Serverzertifikat erforderlich. |
| Der Browser meldet ein abgelaufenes Zertifikat | Auf dem Host Schritt A.4 mit demselben Aussteller wiederholen und den Server neu starten. Solange der Aussteller gültig und unverändert bleibt, ist auf Clients kein erneuter Import nötig. |
| Auf dem Host wurde Windows neu installiert | Ein neuer Aussteller erfordert auch einen neuen Import auf allen Verwaltungsclients. |

## Quellen

- [mkcert: Einrichtung, Zertifikatserstellung und Umgang mit privaten Schlüsseln](https://github.com/FiloSottile/mkcert)
- [Microsoft-WinGet-Katalog: mkcert](https://github.com/microsoft/winget-pkgs/tree/master/manifests/f/FiloSottile/mkcert)
- [Microsoft: certutil, Base64-Dateien mit -decode umwandeln](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/certutil#-decode)
- [Microsoft: Zertifikate im Stammzertifikatsspeicher des aktuellen Benutzers installieren](https://learn.microsoft.com/en-us/powershell/module/pki/import-certificate)
