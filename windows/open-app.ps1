[CmdletBinding()]
param(
  [string]$TaskName = 'Schuetzen-App-Server',
  [ValidateRange(1, 65535)]
  [int]$Port = 3000,
  [ValidateRange(5, 120)]
  [int]$WaitSeconds = 40,
  [string]$LogDirectory
)

$ErrorActionPreference = 'Stop'
$appUrl = "http://localhost:$Port/"
# The server listens on IPv4. On Windows, localhost may try IPv6 first and
# exhaust the short readiness timeout before falling back to IPv4.
$healthUrl = "http://127.0.0.1:$Port/api/health"
if (-not $LogDirectory) {
  $LogDirectory = Join-Path (Split-Path -Parent $PSScriptRoot) 'data\logs'
}

function Write-LauncherLog([string]$Message) {
  try {
    New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
    Add-Content -LiteralPath (Join-Path $LogDirectory 'launcher.log') -Value ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message)
  } catch {
    # A logging failure must not prevent opening the app.
  }
}

function Test-AppReady {
  try {
    $response = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 2
    return $response.status -eq 'ok' -and $response.application -eq 'schuetzen-app'
  } catch {
    Write-LauncherLog ('Bereitschaftspruefung fehlgeschlagen: ' + $_.Exception.Message)
    return $false
  }
}

try {
  Write-LauncherLog "Launcher gestartet: $appUrl"
  if (-not (Test-AppReady)) {
    # Starting or querying a task can briefly fail while an elevated setup is
    # still finishing. Always wait for readiness before reporting that failure.
    $taskStartError = $null
    try {
      Start-ScheduledTask -TaskName $TaskName
    } catch {
      $taskStartError = $_.Exception.Message
    }

    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    while ((Get-Date) -lt $deadline -and -not (Test-AppReady)) {
      Start-Sleep -Milliseconds 500
    }
  }

  if (-not (Test-AppReady)) {
    $details = if ($taskStartError) { " Aufgabenplanung: $taskStartError" } else { '' }
    throw "Die App konnte nicht gestartet werden. Hinweise stehen unter $LogDirectory.$details"
  }

  # The shortcut runs this script hidden. Explicitly show the browser instead
  # of allowing it to inherit the launcher's hidden window state.
  Write-LauncherLog 'Server bereit. Browser wird geoeffnet.'
  Start-Process -FilePath $appUrl -WindowStyle Normal
  Write-LauncherLog 'Browser-Aufruf an Windows uebergeben.'
} catch {
  Write-LauncherLog ('FEHLER: ' + $_.Exception.Message)
  Add-Type -AssemblyName PresentationFramework
  $dialogTitle = 'Sch{0}tzen-App - Start fehlgeschlagen' -f ([char]0x00FC)
  [System.Windows.MessageBox]::Show(
    $_.Exception.Message,
    $dialogTitle,
    [System.Windows.MessageBoxButton]::OK,
    [System.Windows.MessageBoxImage]::Error
  ) | Out-Null
  exit 1
}
