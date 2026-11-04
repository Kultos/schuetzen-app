'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {test} = require('node:test');
const {certificateFor} = require('./helpers/tls-certificate');

function run(script) {
  const env = {...process.env};
  for (const name of ['SCHUETZEN_TLS_CERT', 'SCHUETZEN_TLS_KEY', 'SCHUETZEN_HTTPS_PORT', 'SCHUETZEN_DATA_DIR', 'SCHUETZEN_BACKUP_DIR']) delete env[name];
  return spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], {cwd: path.join(__dirname, '..'), env, encoding: 'utf8', windowsHide: true, timeout: 20000});
}

const quote = value => `'${value.replace(/'/g, "''")}'`;

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'schuetzen windows tls '));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  fs.mkdirSync(path.join(directory, 'tls'));
  const {cert, key} = certificateFor();
  fs.writeFileSync(path.join(directory, 'tls', 'server-cert.pem'), cert);
  fs.writeFileSync(path.join(directory, 'tls', 'server-key.pem'), key);
  return directory;
}

test('Windows setup validates discovered TLS files and port conflicts without changing the host', {skip: process.platform !== 'win32'}, t => {
  const directory = fixture(t);
  const command = `function Get-ScheduledTask { param($TaskName, $ErrorAction) }; & './windows/install.ps1' -CheckOnly -DataDirectory ${quote(directory)} -NodePath ${quote(process.execPath)}`;
  const valid = run(command);
  assert.equal(valid.status, 0, valid.stderr || valid.error?.message);
  assert.match(valid.stdout, /HTTPS-Port: 3443; HTTP-Port: 3000/);
  const conflict = run(command + ' -HttpsPort 3000');
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /unterschiedliche Ports/);
  fs.writeFileSync(path.join(directory, 'tls', 'server-key.pem'), certificateFor().key);
  const mismatch = run(command);
  assert.equal(mismatch.status, 1);
});

test('Windows setup persists HTTPS settings, restarts its task and scopes both firewall rules to the private LAN', {skip: process.platform !== 'win32'}, t => {
  const directory = fixture(t);
  const result = run(`
    $ErrorActionPreference = 'Stop'
    $global:order = @()
    $global:rules = @()
    $global:removed = @()
    $global:registeredArguments = ''
    $global:shortcut = $null
    function New-Object {
      param($TypeName, $ArgumentList, $ComObject)
      if ($ComObject -eq 'WScript.Shell') {
        return (New-Module -AsCustomObject {
          function CreateShortcut($path) {
            $global:shortcut = [pscustomobject]@{TargetPath='';Arguments='';WorkingDirectory='';IconLocation='';Description='';WindowStyle=0}
            $global:shortcut | Add-Member -MemberType ScriptMethod -Name Save -Value {}
            return $global:shortcut
          }
          Export-ModuleMember -Function CreateShortcut
        })
      }
      if ($TypeName -eq 'System.Security.Principal.WindowsPrincipal') {
        return (New-Module -AsCustomObject {
          function IsInRole($role) { return $true }
          Export-ModuleMember -Function IsInRole
        })
      }
      throw "Unexpected New-Object: $TypeName $ComObject"
    }
    function New-ScheduledTaskAction { param($Execute, $Argument) return @{Execute=$Execute;Argument=$Argument} }
    function New-ScheduledTaskTrigger { param([switch]$AtLogOn, $User) return @{} }
    function New-ScheduledTaskPrincipal { param($UserId, $LogonType, $RunLevel) return @{} }
    function New-ScheduledTaskSettingsSet {
      param($MultipleInstances, $RestartCount, $RestartInterval, $ExecutionTimeLimit, [switch]$StartWhenAvailable, [switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries)
      return @{}
    }
    function Get-ScheduledTask {
      param($TaskName, $ErrorAction)
      return @{TaskName=$TaskName;Actions=@(@{Arguments='-Port 3002 -BackupRetentionDays 45 -BackupDirectory "${directory.replace(/'/g, "''")}"'})}
    }
    function Stop-ScheduledTask { param($TaskName) $global:order += 'stop' }
    function Register-ScheduledTask {
      param($TaskName, $Action, $Trigger, $Principal, $Settings, $Description, [switch]$Force)
      $global:registeredArguments = $Action.Argument
      $global:order += 'register'
    }
    function Start-ScheduledTask { param($TaskName) $global:order += 'start' }
    function Get-NetFirewallRule { param($Name, $ErrorAction) return $Name }
    function Remove-NetFirewallRule { param([Parameter(ValueFromPipeline=$true)]$InputObject) process { $global:removed += $InputObject } }
    function New-NetFirewallRule {
      param($Name, $DisplayName, $Description, $Enabled, $Profile, $RemoteAddress, $Direction, $Action, $Protocol, $LocalPort, $Program)
      if ($Profile -ne 'Private' -or $RemoteAddress -ne 'LocalSubnet' -or $Program -ne ${quote(process.execPath)}) { throw 'Wrong firewall scope' }
      $global:rules += $LocalPort
    }
    & './windows/install.ps1' -Elevated -DataDirectory ${quote(directory)} -DesktopPath ${quote(directory)} -NodePath ${quote(process.execPath)} -Port 3001 -HttpsPort 3444
    if (($global:order -join ',') -ne 'register,stop,start') { throw 'Register settings successfully before restarting the task' }
    foreach ($expected in @('-Port 3001', '-HttpsPort 3444', '-BackupRetentionDays 45', '-BackupDirectory', '-TlsCert', '-TlsKey', ${quote(directory)})) {
      if (-not $global:registeredArguments.Contains($expected)) { throw "Missing persisted argument: $expected" }
    }
    if (($global:rules -join ',') -ne '3001,3444') { throw 'Both ports must be opened' }
    if (-not $global:shortcut.Arguments.Contains('-Port 3001')) { throw 'Desktop launcher must keep its HTTP port' }
    & './windows/configure-firewall.ps1' -Remove
    if ($global:removed.Count -ne 4) { throw 'Both firewall rules must also be removed on uninstall' }
    $global:rules = @()
    & './windows/configure-firewall.ps1' -NodePath ${quote(process.execPath)} -Port 3001
    if (($global:rules -join ',') -ne '3001') { throw 'No TLS firewall rule without configured TLS' }
  `);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
