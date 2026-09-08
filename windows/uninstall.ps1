[CmdletBinding()]
param(
  [switch]$SkipFirewall,
  [switch]$Elevated,
  [string]$DesktopPath
)

$ErrorActionPreference = 'Stop'
$taskName = 'Schuetzen-App-Server'
$firewallPath = Join-Path $PSScriptRoot 'configure-firewall.ps1'
$powerShellPath = Join-Path $PSHOME 'powershell.exe'

function Quote-Argument([string]$Value) {
  if ($Value.Contains('"')) { throw 'Ein Installationspfad darf kein Anfuehrungszeichen enthalten.' }
  return '"' + $Value + '"'
}

$currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$isAdministrator = (New-Object System.Security.Principal.WindowsPrincipal($currentIdentity)).IsInRole(
  [System.Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $Elevated -and -not $isAdministrator) {
  $originalDesktop = [Environment]::GetFolderPath('Desktop')
  $arguments = '-NoProfile -ExecutionPolicy Bypass -File {0} -Elevated -DesktopPath {1}' -f `
    (Quote-Argument $PSCommandPath), (Quote-Argument $originalDesktop)
  if ($SkipFirewall) { $arguments += ' -SkipFirewall' }
  try {
    $process = Start-Process -FilePath $powerShellPath -Verb RunAs -ArgumentList $arguments -Wait -PassThru
    exit $process.ExitCode
  } catch {
    Write-Error 'Die Administratorfreigabe wurde nicht erteilt.'
    exit 1
  }
}
if ($Elevated -and -not $isAdministrator) {
  Write-Error 'Die Administratorfreigabe wurde nicht erteilt.'
  exit 1
}

$desktop = if ($DesktopPath) { [System.IO.Path]::GetFullPath($DesktopPath) } else { [Environment]::GetFolderPath('Desktop') }
$shortcutName = ('Sch{0}tzen-App {1}ffnen.lnk' -f ([char]0x00FC), ([char]0x00F6))
$shortcutPath = Join-Path $desktop $shortcutName

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
if (Test-Path -LiteralPath $shortcutPath) {
  Remove-Item -LiteralPath $shortcutPath -Force
}

if (-not $SkipFirewall) {
  try {
    & $firewallPath -Remove
  } catch {
    Write-Warning 'Die Firewall-Regel konnte nicht entfernt werden.'
  }
}

Write-Host 'Die automatische Windows-Einrichtung wurde entfernt.' -ForegroundColor Green
Write-Host 'Anwendungsdaten und Backups wurden nicht geloescht.'
