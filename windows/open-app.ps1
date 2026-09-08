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
$healthUrl = "http://localhost:$Port/api/health"

function Test-AppReady {
  try {
    $response = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 2
    return $response.status -eq 'ok' -and $response.application -eq 'schuetzen-app'
  } catch {
    return $false
  }
}

try {
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
    if (-not $LogDirectory) {
      $appPath = Split-Path -Parent $PSScriptRoot
      $LogDirectory = Join-Path $appPath 'data\logs'
    }
    $details = if ($taskStartError) { " Aufgabenplanung: $taskStartError" } else { '' }
    throw "Die App konnte nicht gestartet werden. Hinweise stehen unter $LogDirectory.$details"
  }

  Start-Process $appUrl
} catch {
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
