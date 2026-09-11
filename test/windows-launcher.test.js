'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');

for (const initiallyReady of [true, false]) {
  test(`Desktop launcher opens a visible browser with server ${initiallyReady ? 'running' : 'stopped'}`, {
    skip: process.platform !== 'win32',
  }, () => {
    const script = `
      $ErrorActionPreference = 'Stop'
      $global:ready = $${initiallyReady}
      $global:taskStarts = 0
      $global:browserStarts = 0
      function Invoke-RestMethod {
        param($Uri, $Method, $TimeoutSec)
        if ($Uri -ne 'http://127.0.0.1:3001/api/health') { throw 'Readiness must use IPv4 without localhost fallback delays' }
        if (-not $global:ready) { throw 'Server not ready' }
        return @{status='ok'; application='schuetzen-app'}
      }
      function Start-ScheduledTask {
        param($TaskName)
        if ($TaskName -ne 'Schuetzen-App-Server') { throw 'Wrong task' }
        $global:taskStarts++
        $global:ready = $true
      }
      function Start-Process {
        param($FilePath, $WindowStyle)
        if (-not $global:ready) { throw 'Browser opened before readiness' }
        if ($FilePath -ne 'http://localhost:3001/') { throw 'Wrong browser URL' }
        if ($WindowStyle -ne 'Normal') { throw 'Browser must open visibly from hidden launcher' }
        $global:browserStarts++
      }
      # Prevent a modal error dialog if the launcher regresses.
      function Add-Type { throw 'Unexpected launcher error' }
      # Keep launcher logs isolated from event data.
      function New-Item { }
      function Add-Content { }
      & './windows/open-app.ps1' -Port 3001
      if ($global:browserStarts -ne 1) { throw 'Expected one browser launch' }
      if ($global:taskStarts -ne ${initiallyReady ? 0 : 1}) { throw 'Unexpected task starts' }
    `;
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
    ], {cwd: path.join(__dirname, '..'), encoding: 'utf8', windowsHide: true, timeout: 15000});
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  });
}
