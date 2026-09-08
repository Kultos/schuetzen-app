[CmdletBinding()]
param(
  [string]$NodePath,

  [ValidateRange(1, 65535)]
  [int]$Port = 3000,

  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$ruleName = 'SchuetzenApp-Dashboard-TCP'
$existing = Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue
if ($existing) {
  $existing | Remove-NetFirewallRule
}

if (-not $Remove) {
  if (-not $NodePath) {
    throw 'Der Pfad zu Node.js fehlt.'
  }
  $displayName = 'Sch{0}tzen-App Dashboard (TCP {1})' -f ([char]0x00FC), $Port
  New-NetFirewallRule `
    -Name $ruleName `
    -DisplayName $displayName `
    -Description 'Erlaubt Geraeten im privaten Veranstaltungsnetz den Zugriff auf das oeffentliche Live-Dashboard.' `
    -Enabled True `
    -Profile Private `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort $Port `
    -Program ([System.IO.Path]::GetFullPath($NodePath)) | Out-Null
}
