[CmdletBinding()]
param(
  [ValidateRange(1, 65535)]
  [int]$Port = 3000,

  [string]$DataDirectory = $env:SCHUETZEN_DATA_DIR,
  [string]$BackupDirectory = $env:SCHUETZEN_BACKUP_DIR,

  [ValidateRange(1, 3650)]
  [int]$BackupRetentionDays = 30,

  [switch]$SkipFirewall,
  [switch]$CheckOnly,

  [switch]$Elevated,
  [string]$TargetUser,
  [string]$DesktopPath,
  [string]$NodePath,
  [string]$ResultPath
)

$ErrorActionPreference = 'Stop'
$taskName = 'Schuetzen-App-Server'
$shortcutLabel = 'Sch{0}tzen-App {1}ffnen' -f ([char]0x00FC), ([char]0x00F6)
$shortcutName = $shortcutLabel + '.lnk'
$appPath = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$runnerPath = Join-Path $PSScriptRoot 'run-server.ps1'
$openerPath = Join-Path $PSScriptRoot 'open-app.ps1'
$openerWrapperPath = Join-Path $PSScriptRoot 'open-app.vbs'
$firewallPath = Join-Path $PSScriptRoot 'configure-firewall.ps1'
$powerShellPath = Join-Path $PSHOME 'powershell.exe'
$wscriptPath = Join-Path $env:SystemRoot 'System32\wscript.exe'

function Quote-Argument([string]$Value) {
  if ($Value.Contains('"')) { throw 'Ein Installationspfad darf kein Anfuehrungszeichen enthalten.' }
  return '"' + $Value + '"'
}

function Save-Result([string]$Message) {
  if ($ResultPath) {
    Set-Content -LiteralPath $ResultPath -Value $Message -Encoding UTF8
  }
}

function Assert-InstallationPrerequisites {
  foreach ($requiredFile in @(
    (Join-Path $appPath 'server.js'),
    (Join-Path $appPath 'storage.js'),
    $runnerPath,
    $openerPath,
    $openerWrapperPath,
    $firewallPath
  )) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
      throw "Benoetigte Datei fehlt: $requiredFile"
    }
  }

  $resolvedNodePath = $NodePath
  if (-not $resolvedNodePath) {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($nodeCommand) { $resolvedNodePath = $nodeCommand.Source }
  }
  if (-not $resolvedNodePath -or -not (Test-Path -LiteralPath $resolvedNodePath -PathType Leaf)) {
    throw 'Node.js 24 oder neuer wurde nicht gefunden. Bitte zuerst die mitgelieferte Node.js-Installation ausfuehren.'
  }
  $nodeVersionText = (& $resolvedNodePath --version).Trim().TrimStart('v')
  $nodeVersion = [version]$nodeVersionText
  if ($nodeVersion.Major -lt 24) {
    throw "Node.js $nodeVersionText ist zu alt. Benoetigt wird Node.js 24 oder neuer."
  }
  return [System.IO.Path]::GetFullPath($resolvedNodePath)
}

try {
  $nodePath = Assert-InstallationPrerequisites
  if ($DataDirectory) { $DataDirectory = [System.IO.Path]::GetFullPath($DataDirectory) }
  if ($BackupDirectory) { $BackupDirectory = [System.IO.Path]::GetFullPath($BackupDirectory) }
  if ($CheckOnly) {
    Write-Host "Pruefung erfolgreich. Node.js: $nodePath"
    exit 0
  }

  $currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $isAdministrator = (New-Object System.Security.Principal.WindowsPrincipal($currentIdentity)).IsInRole(
    [System.Security.Principal.WindowsBuiltInRole]::Administrator
  )
  if (-not $Elevated -and -not $isAdministrator) {
    $originalUser = $currentIdentity.Name
    $originalDesktop = [Environment]::GetFolderPath('Desktop')
    $resultFile = Join-Path ([System.IO.Path]::GetTempPath()) ('schuetzen-app-setup-' + [guid]::NewGuid().ToString('N') + '.txt')
    $elevationArguments = '-NoProfile -ExecutionPolicy Bypass -File {0} -Elevated -TargetUser {1} -DesktopPath {2} -NodePath {3} -Port {4} -BackupRetentionDays {5} -ResultPath {6}' -f `
      (Quote-Argument $PSCommandPath), (Quote-Argument $originalUser), (Quote-Argument $originalDesktop), (Quote-Argument $nodePath), $Port, $BackupRetentionDays, (Quote-Argument $resultFile)
    if ($DataDirectory) { $elevationArguments += ' -DataDirectory ' + (Quote-Argument $DataDirectory) }
    if ($BackupDirectory) { $elevationArguments += ' -BackupDirectory ' + (Quote-Argument $BackupDirectory) }
    if ($SkipFirewall) { $elevationArguments += ' -SkipFirewall' }
    try {
      $elevatedProcess = Start-Process -FilePath $powerShellPath -Verb RunAs -ArgumentList $elevationArguments -Wait -PassThru
      if (Test-Path -LiteralPath $resultFile) {
        Get-Content -LiteralPath $resultFile | Write-Host
        Remove-Item -LiteralPath $resultFile -Force
      }
      exit $elevatedProcess.ExitCode
    } catch {
      if (Test-Path -LiteralPath $resultFile) { Remove-Item -LiteralPath $resultFile -Force }
      throw
    }
  }
  if ($Elevated -and -not $isAdministrator) {
    throw 'Die Administratorfreigabe wurde nicht erteilt.'
  }

  $identity = if ($TargetUser) { $TargetUser } else { $currentIdentity.Name }
  $desktop = if ($DesktopPath) { [System.IO.Path]::GetFullPath($DesktopPath) } else { [Environment]::GetFolderPath('Desktop') }
  $runnerArguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File {0} -NodePath {1} -AppPath {2} -Port {3}' -f `
    (Quote-Argument $runnerPath), (Quote-Argument $nodePath), (Quote-Argument $appPath), $Port
  $runnerArguments += ' -BackupRetentionDays ' + $BackupRetentionDays
  if ($DataDirectory) { $runnerArguments += ' -DataDirectory ' + (Quote-Argument $DataDirectory) }
  if ($BackupDirectory) { $runnerArguments += ' -BackupDirectory ' + (Quote-Argument $BackupDirectory) }
  $action = New-ScheduledTaskAction -Execute $powerShellPath -Argument $runnerArguments
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
  $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries

  Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description 'Startet den lokalen Server der Schuetzen-App beim Anmelden und nach Fehlern erneut.' `
    -Force | Out-Null
  $shortcutPath = Join-Path $desktop $shortcutName
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $wscriptPath
  $effectiveDataDirectory = if ($DataDirectory) { $DataDirectory } else { Join-Path $appPath 'data' }
  $shortcut.Arguments = '{0} -TaskName {1} -Port {2} -LogDirectory {3}' -f `
    (Quote-Argument $openerWrapperPath), (Quote-Argument $taskName), $Port, (Quote-Argument (Join-Path $effectiveDataDirectory 'logs'))
  $shortcut.WorkingDirectory = $appPath
  $shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,220"
  $shortcut.Description = $shortcutLabel
  $shortcut.WindowStyle = 7
  $shortcut.Save()

  $firewallWarning = $null
  if (-not $SkipFirewall) {
    try {
      & $firewallPath -NodePath $nodePath -Port $Port
    } catch {
      $firewallWarning = 'WARNUNG: Die Firewall-Regel konnte nicht eingerichtet werden. Die App funktioniert lokal; das TV-Dashboard im LAN muss separat freigegeben werden.'
      Write-Warning $firewallWarning
    }
  }

  Start-ScheduledTask -TaskName $taskName
  $resultMessage = "Die Schuetzen-App ist eingerichtet.`r`nDesktop-Symbol: $shortcutPath`r`nDer Server startet automatisch beim Anmelden und nach Fehlern erneut."
  if ($firewallWarning) { $resultMessage += "`r`n$firewallWarning" }
  Save-Result $resultMessage
  Write-Host ''
  Write-Host 'Die Schuetzen-App ist eingerichtet.' -ForegroundColor Green
  Write-Host "Desktop-Symbol: $shortcutPath"
  Write-Host 'Der Server startet ab jetzt automatisch beim Anmelden und nach Fehlern erneut.'
  Write-Host 'Oeffnen Sie die App ueber das neue Desktop-Symbol.'
} catch {
  Save-Result ('FEHLER: ' + $_.Exception.Message)
  Write-Error $_.Exception.Message
  exit 1
}
