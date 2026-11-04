[CmdletBinding()]
param(
  [string]$NodePath,

  [ValidateRange(1, 65535)]
  [int]$Port = 3000,

  [ValidateRange(0, 65535)]
  [int]$HttpsPort = 0,

  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
foreach ($ruleName in @('SchuetzenApp-Dashboard-TCP', 'SchuetzenApp-Management-TLS-TCP')) {
  $existing = Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue
  if ($existing) {
    $existing | Remove-NetFirewallRule
  }
}

if (-not $Remove) {
  if (-not $NodePath) {
    throw 'Der Pfad zu Node.js fehlt.'
  }
  $displayName = 'Sch{0}tzen-App Dashboard (TCP {1})' -f ([char]0x00FC), $Port
  New-NetFirewallRule `
    -Name 'SchuetzenApp-Dashboard-TCP' `
    -DisplayName $displayName `
    -Description 'Erlaubt Geraeten im privaten Veranstaltungsnetz den Zugriff auf das oeffentliche Live-Dashboard.' `
    -Enabled True `
    -Profile Private `
    -RemoteAddress LocalSubnet `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort $Port `
    -Program ([System.IO.Path]::GetFullPath($NodePath)) | Out-Null
  if ($HttpsPort) {
    New-NetFirewallRule `
      -Name 'SchuetzenApp-Management-TLS-TCP' `
      -DisplayName ('Sch{0}tzen-App Verwaltung HTTPS (TCP {1})' -f ([char]0x00FC), $HttpsPort) `
      -Description 'Erlaubt HTTPS-Verwaltung im privaten Veranstaltungsnetz.' `
      -Enabled True `
      -Profile Private `
      -RemoteAddress LocalSubnet `
      -Direction Inbound `
      -Action Allow `
      -Protocol TCP `
      -LocalPort $HttpsPort `
      -Program ([System.IO.Path]::GetFullPath($NodePath)) | Out-Null
  }
}
