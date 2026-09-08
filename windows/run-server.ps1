[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$NodePath,

  [string]$AppPath = (Split-Path -Parent $PSScriptRoot),

  [ValidateRange(1, 65535)]
  [int]$Port = 3000,

  [string]$DataDirectory,
  [string]$BackupDirectory,

  [ValidateRange(1, 3650)]
  [int]$BackupRetentionDays = 30
)

$ErrorActionPreference = 'Stop'
$AppPath = [System.IO.Path]::GetFullPath($AppPath)
$serverFile = Join-Path $AppPath 'server.js'
if ($DataDirectory) { $env:SCHUETZEN_DATA_DIR = [System.IO.Path]::GetFullPath($DataDirectory) }
if ($BackupDirectory) { $env:SCHUETZEN_BACKUP_DIR = [System.IO.Path]::GetFullPath($BackupDirectory) }
$env:SCHUETZEN_BACKUP_RETENTION_DAYS = [string]$BackupRetentionDays
$dataDirectory = if ($env:SCHUETZEN_DATA_DIR) {
  [System.IO.Path]::GetFullPath($env:SCHUETZEN_DATA_DIR)
} else {
  Join-Path $AppPath 'data'
}
$logDirectory = Join-Path $dataDirectory 'logs'

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$logFile = Join-Path $logDirectory ((Get-Date -Format 'yyyy-MM-dd') + '-runner.log')
$runStamp = Get-Date -Format 'yyyy-MM-dd-HHmmss'
$standardOutputLog = Join-Path $logDirectory ($runStamp + '-server-output.log')
$standardErrorLog = Join-Path $logDirectory ($runStamp + '-server-error.log')

function Write-ServerLog([string]$Message) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class EventPowerState {
  [DllImport("kernel32.dll")]
  public static extern uint SetThreadExecutionState(uint flags);
}
'@
$executionContinuous = [Convert]::ToUInt32('80000000', 16)
$executionSystemRequired = [uint32]0x00000001

if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
  Write-ServerLog "FEHLER: Node.js wurde nicht gefunden: $NodePath"
  exit 2
}
if (-not (Test-Path -LiteralPath $serverFile -PathType Leaf)) {
  Write-ServerLog "FEHLER: server.js wurde nicht gefunden: $serverFile"
  exit 3
}

Get-ChildItem -LiteralPath $logDirectory -Filter '*.log' -File -ErrorAction SilentlyContinue |
  Where-Object LastWriteTime -lt (Get-Date).AddDays(-30) |
  Remove-Item -Force -ErrorAction SilentlyContinue

$env:NODE_ENV = 'production'
$env:PORT = [string]$Port
Set-Location -LiteralPath $AppPath
Write-ServerLog 'Serverprozess wird gestartet.'

try {
  # Keep Windows awake while the event server is running. The display may still
  # turn off; closing the lid or manually choosing Sleep keeps its normal effect.
  [void][EventPowerState]::SetThreadExecutionState($executionContinuous -bor $executionSystemRequired)
  $serverArgument = '"' + $serverFile + '"'
  $serverProcess = Start-Process `
    -FilePath $NodePath `
    -ArgumentList $serverArgument `
    -WorkingDirectory $AppPath `
    -NoNewWindow `
    -RedirectStandardOutput $standardOutputLog `
    -RedirectStandardError $standardErrorLog `
    -Wait `
    -PassThru
  $nodeExitCode = $serverProcess.ExitCode
  Write-ServerLog "Serverprozess wurde mit Code $nodeExitCode beendet."
} catch {
  Write-ServerLog "FEHLER beim Serverstart: $($_.Exception.Message)"
  $nodeExitCode = 1
} finally {
  [void][EventPowerState]::SetThreadExecutionState($executionContinuous)
}

# Treat an unexpected regular exit as a failure as well, so Task Scheduler
# restarts the server that is required throughout the event.
if ($nodeExitCode -eq 0) { exit 1 }
exit $nodeExitCode
