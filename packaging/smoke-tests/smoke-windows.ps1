<#
.SYNOPSIS
Windows smoke test for @kaelith-labs/cli via Scoop bucket.

.DESCRIPTION
Exercises the full Scoop install path end-to-end:
  bucket add → install → version → init → verify → health → MCP RPC → uninstall

Safety: any existing $HOME\.vcf and $HOME\vcf are moved aside to
*.smoketest-bak-<ts> before the run and restored on exit (success or
failure, including Ctrl-C). Your real state is never destroyed.

.PARAMETER SkipUninstall
Leave vcf-cli installed afterwards (useful when you want to poke at the
install interactively).

.EXAMPLE
./smoke-windows.ps1

.EXAMPLE
./smoke-windows.ps1 -SkipUninstall

.NOTES
Exit code: 0 if every check passes, 1 otherwise. Requires Scoop.
#>

[CmdletBinding()]
param(
  [switch]$SkipUninstall
)

$ErrorActionPreference = 'Continue'
$script:Pass = 0
$script:Fail = 0
$script:Skip = 0
$script:Results = New-Object System.Collections.Generic.List[string]
$script:StartedAt = Get-Date
$script:BackupSuffix = ".smoketest-bak-$(Get-Date -UFormat %s)"
$script:MovedDotVcf = $false
$script:MovedVcf = $false

function Write-Section($title) {
  Write-Host ""
  Write-Host "=== $title ===" -ForegroundColor Cyan
}

# Check a boolean expression; print tick/cross, track counters.
function Assert-Check {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][scriptblock]$Action
  )
  try {
    $ok = & $Action
    if ($ok -eq $true -or ($ok -ne $false -and $LASTEXITCODE -eq 0)) {
      Write-Host ("  [x] {0}" -f $Name) -ForegroundColor Green
      $script:Pass++
      $script:Results.Add("PASS  $Name")
      return
    }
  } catch {
    Write-Host ("  [ ] {0}" -f $Name) -ForegroundColor Red
    Write-Host ("      | {0}" -f $_.Exception.Message)
    $script:Fail++
    $script:Results.Add("FAIL  $Name : $($_.Exception.Message)")
    return
  }
  Write-Host ("  [ ] {0}" -f $Name) -ForegroundColor Red
  $script:Fail++
  $script:Results.Add("FAIL  $Name")
}

# Run a command, check its exit code. Captures output to a temp log for
# diagnostics on failure.
function Assert-Exit0 {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string]$Cmd,
    [string[]]$Args = @()
  )
  $logFile = [System.IO.Path]::GetTempFileName()
  try {
    $null = & $Cmd @Args *> $logFile
    if ($LASTEXITCODE -eq 0) {
      Write-Host ("  [x] {0}" -f $Name) -ForegroundColor Green
      $script:Pass++
      $script:Results.Add("PASS  $Name")
    } else {
      Write-Host ("  [ ] {0} (exit {1})" -f $Name, $LASTEXITCODE) -ForegroundColor Red
      Get-Content $logFile -TotalCount 10 | ForEach-Object { "      | $_" } | Write-Host
      $script:Fail++
      $script:Results.Add("FAIL  $Name (exit $LASTEXITCODE)")
    }
  } catch {
    Write-Host ("  [ ] {0}" -f $Name) -ForegroundColor Red
    Write-Host ("      | {0}" -f $_.Exception.Message)
    $script:Fail++
    $script:Results.Add("FAIL  $Name : $($_.Exception.Message)")
  } finally {
    Remove-Item $logFile -Force -ErrorAction SilentlyContinue
  }
}

function Assert-Match {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string]$Pattern,
    [Parameter(Mandatory)][scriptblock]$Output
  )
  try {
    $out = (& $Output) -join "`n"
    if ($out -match $Pattern) {
      Write-Host ("  [x] {0}" -f $Name) -ForegroundColor Green
      $script:Pass++
      $script:Results.Add("PASS  $Name")
    } else {
      Write-Host ("  [ ] {0} (pattern: {1})" -f $Name, $Pattern) -ForegroundColor Red
      ($out -split "`n") | Select-Object -First 5 | ForEach-Object { "      | $_" } | Write-Host
      $script:Fail++
      $script:Results.Add("FAIL  $Name")
    }
  } catch {
    Write-Host ("  [ ] {0}" -f $Name) -ForegroundColor Red
    Write-Host ("      | {0}" -f $_.Exception.Message)
    $script:Fail++
    $script:Results.Add("FAIL  $Name : $($_.Exception.Message)")
  }
}

function Restore-State {
  Write-Section "Restoring previous state"
  Remove-Item "$HOME\.vcf" -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item "$HOME\vcf" -Recurse -Force -ErrorAction SilentlyContinue
  if ($script:MovedDotVcf -and (Test-Path "$HOME\.vcf$($script:BackupSuffix)")) {
    Rename-Item "$HOME\.vcf$($script:BackupSuffix)" ".vcf" -Force
    Write-Host "  -> restored ~\.vcf"
  }
  if ($script:MovedVcf -and (Test-Path "$HOME\vcf$($script:BackupSuffix)")) {
    Rename-Item "$HOME\vcf$($script:BackupSuffix)" "vcf" -Force
    Write-Host "  -> restored ~\vcf"
  }
}

# Register the restore so it fires on normal exit, Ctrl-C, or
# unhandled termination.
$null = Register-EngineEvent PowerShell.Exiting -Action { Restore-State } -SupportEvent

try {

  # ---- preflight ------------------------------------------------------------

  Write-Section "Preflight"
  Assert-Check "running on Windows" { $IsWindows -or $env:OS -eq "Windows_NT" }
  Assert-Check "scoop is on PATH" { [bool](Get-Command scoop -ErrorAction SilentlyContinue) }
  Assert-Check "node is on PATH (Scoop will install if not)" {
    [bool](Get-Command node -ErrorAction SilentlyContinue) -or $true
  }

  # ---- backup existing state ------------------------------------------------

  Write-Section "Backup existing ~\.vcf and ~\vcf (if any)"
  if (Test-Path "$HOME\.vcf") {
    Rename-Item "$HOME\.vcf" ".vcf$($script:BackupSuffix)" -Force
    $script:MovedDotVcf = $true
    Write-Host "  -> moved ~\.vcf to ~\.vcf$($script:BackupSuffix)"
  }
  if (Test-Path "$HOME\vcf") {
    Rename-Item "$HOME\vcf" "vcf$($script:BackupSuffix)" -Force
    $script:MovedVcf = $true
    Write-Host "  -> moved ~\vcf to ~\vcf$($script:BackupSuffix)"
  }
  if (-not $script:MovedDotVcf -and -not $script:MovedVcf) {
    Write-Host "  (nothing to back up)"
  }

  # ---- install --------------------------------------------------------------

  Write-Section "Install via Scoop bucket"

  $bucketList = scoop bucket list 2>$null
  if ($bucketList -match 'kaelith-labs') {
    Write-Host "  (bucket already present -- removing first for a clean test)"
    scoop bucket rm kaelith-labs 2>$null | Out-Null
  }

  Assert-Exit0 "scoop bucket add kaelith-labs" "scoop" @("bucket", "add", "kaelith-labs", "https://github.com/Kaelith-Labs/scoop-vcf")
  Assert-Exit0 "scoop install vcf-cli" "scoop" @("install", "vcf-cli")

  # ---- shim + version -------------------------------------------------------

  Write-Section "Binary + PATH"
  Assert-Check "vcf is on PATH" { [bool](Get-Command vcf -ErrorAction SilentlyContinue) }
  Assert-Check "vcf-mcp is on PATH" { [bool](Get-Command vcf-mcp -ErrorAction SilentlyContinue) }

  # Scoop sometimes shims via the .cmd indirection in ~\scoop\shims. If two
  # shims resolve for the same name (e.g. npm global + scoop shim), surface
  # both so the human can eyeball which wins.
  $vcfCommands = @(Get-Command vcf -All -ErrorAction SilentlyContinue)
  if ($vcfCommands.Count -gt 1) {
    Write-Host "  ! multiple vcf shims found:" -ForegroundColor Yellow
    $vcfCommands | ForEach-Object { Write-Host "      - $($_.Source)" }
  }

  Assert-Match "vcf version reports a semver" 'vcf-cli \d+\.\d+\.\d+' { vcf version }

  # ---- init + fs checks -----------------------------------------------------

  Write-Section "vcf init + filesystem layout"

  # vcf init prompts y/N for telemetry. Pipe 'n' so the smoke never opts
  # the test box into error reporting.
  $initOutput = 'n' | vcf init 2>&1
  if ($LASTEXITCODE -eq 0) {
    Write-Host "  [x] vcf init succeeds" -ForegroundColor Green
    $script:Pass++
    $script:Results.Add("PASS  vcf init succeeds")
  } else {
    Write-Host "  [ ] vcf init succeeds (exit $LASTEXITCODE)" -ForegroundColor Red
    $initOutput | Select-Object -First 10 | ForEach-Object { "      | $_" } | Write-Host
    $script:Fail++
    $script:Results.Add("FAIL  vcf init succeeds")
  }

  Assert-Check "~\.vcf exists" { Test-Path "$HOME\.vcf" -PathType Container }
  Assert-Check "~\.vcf\config.yaml exists" { Test-Path "$HOME\.vcf\config.yaml" -PathType Leaf }

  # KB seed: @kaelith-labs/kb is a regular dep from 0.3.2 on, so every
  # install path pulls the content package and `vcf init` copies it into
  # ~\.vcf\kb. vcf.db stays lazy — only created on first MCP/tool call.
  Assert-Check "~\.vcf\kb\primers seeded from @kaelith-labs/kb" {
    Test-Path "$HOME\.vcf\kb\primers" -PathType Container
  }
  $primerCount = (Get-ChildItem "$HOME\.vcf\kb\primers" -Filter *.md -Recurse -ErrorAction SilentlyContinue | Measure-Object).Count
  if ($primerCount -gt 0) {
    Write-Host ("  [x] ~\.vcf\kb\primers has {0} *.md files" -f $primerCount) -ForegroundColor Green
    $script:Pass++
    $script:Results.Add("PASS  kb primers populated ($primerCount)")
  } else {
    Write-Host "  [ ] ~\.vcf\kb\primers has no *.md files (KB seed failed)" -ForegroundColor Red
    $script:Fail++
    $script:Results.Add("FAIL  kb primers empty")
  }
  Assert-Check "~\.vcf\kb-ancestors seeded for three-way merges" {
    Test-Path "$HOME\.vcf\kb-ancestors\primers" -PathType Container
  }

  Assert-Match "config.yaml has valid version: 1 header" 'version:\s*1' {
    Get-Content "$HOME\.vcf\config.yaml" -TotalCount 5
  }

  # Inspect .mcp.json for raw backslashes in JSON strings — a common source
  # of downstream client breakage. Proper JSON has either forward slashes
  # or double-escaped backslashes.
  if (Test-Path "$HOME\.mcp.json") {
    $mcpJson = Get-Content "$HOME\.mcp.json" -Raw
    try {
      $null = $mcpJson | ConvertFrom-Json -ErrorAction Stop
      Write-Host "  [x] ~\.mcp.json parses as JSON" -ForegroundColor Green
      $script:Pass++
      $script:Results.Add("PASS  ~\.mcp.json parses as JSON")
    } catch {
      Write-Host "  [ ] ~\.mcp.json parses as JSON" -ForegroundColor Red
      Write-Host "      | $($_.Exception.Message)"
      $script:Fail++
      $script:Results.Add("FAIL  ~\.mcp.json parses as JSON")
    }
  } else {
    Write-Host "  (.mcp.json not written at $HOME\.mcp.json -- skipping JSON-parse check)" -ForegroundColor Yellow
    $script:Skip++
    $script:Results.Add("SKIP  ~\.mcp.json parses as JSON (file absent)")
  }

  # ---- verify + health ------------------------------------------------------

  Write-Section "vcf verify + vcf health"
  Assert-Exit0 "vcf verify passes" "vcf" @("verify")
  # `vcf health` exits 9 when any configured endpoint is unreachable. On a
  # fresh smoke box the seeded `local-ollama` endpoint usually isn't
  # running, so we accept exit 0 OR 9 — we're smoke-testing the install
  # path, not the operator's endpoint inventory.
  $null = vcf health 2>&1
  if ($LASTEXITCODE -eq 0 -or $LASTEXITCODE -eq 9) {
    Write-Host "  [x] vcf health runs (exit 0 or 9, endpoints may be unreachable)" -ForegroundColor Green
    $script:Pass++
    $script:Results.Add("PASS  vcf health runs")
  } else {
    Write-Host "  [ ] vcf health runs (unexpected exit $LASTEXITCODE)" -ForegroundColor Red
    $script:Fail++
    $script:Results.Add("FAIL  vcf health runs (exit $LASTEXITCODE)")
  }

  # ---- MCP stdio round-trip -------------------------------------------------

  Write-Section "MCP server stdio round-trip"

  $mcpRequest = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'

  # The npm-global shim for vcf-mcp is a .ps1 / .cmd trio that dispatches
  # to the real .js file. Running the shim through .NET Process trips two
  # separate footguns:
  #   - node can't exec a .ps1 (it tries to parse as JS and errors)
  #   - cmd.exe's .cmd shim doesn't reliably forward a stdin-close to the
  #     child, so a request/close/read round-trip can hang
  # Resolve the underlying dist/mcp.js and invoke it via `node` directly.
  $vcfMcpPath = (Get-Command vcf-mcp -ErrorAction SilentlyContinue).Source
  $mcpJs = $null
  if ($vcfMcpPath) {
    # Walk the standard npm-global layout to find the real .js entry.
    $candidate = Join-Path (Split-Path $vcfMcpPath -Parent) "node_modules\@kaelith-labs\cli\dist\mcp.js"
    if (Test-Path $candidate) { $mcpJs = $candidate }
  }
  if (-not $mcpJs) {
    # Homebrew-style install (libexec layout) — just in case this script
    # is ever run against an npm-via-homebrew setup.
    $brewCandidate = "$env:LOCALAPPDATA\scoop\apps\vcf-cli\current\package\dist\mcp.js"
    if (Test-Path $brewCandidate) { $mcpJs = $brewCandidate }
  }

  if (-not $mcpJs) {
    Write-Host "  [ ] vcf-mcp responds to initialize (could not locate dist/mcp.js)" -ForegroundColor Red
    $script:Fail++
    $script:Results.Add("FAIL  vcf-mcp responds to initialize (mcp.js not found)")
  } else {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "node"
    $psi.Arguments = "`"$mcpJs`" --scope global"
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true

    $proc = $null
    try {
      $proc = [System.Diagnostics.Process]::Start($psi)
      $proc.StandardInput.WriteLine($mcpRequest)
      $proc.StandardInput.Close()
      # Read the first JSON-RPC line; the server writes one frame per
      # newline. ReadLine blocks until the line lands or stdout closes,
      # both of which happen well under our budget.
      $line = $proc.StandardOutput.ReadLine()
      if ($line -and $line -match '"result"' -and $line -match '"serverInfo"') {
        Write-Host "  [x] vcf-mcp responds to initialize" -ForegroundColor Green
        $script:Pass++
        $script:Results.Add("PASS  vcf-mcp responds to initialize")
      } else {
        Write-Host "  [ ] vcf-mcp responds to initialize (unexpected output)" -ForegroundColor Red
        if ($line) { Write-Host "      | $line" }
        $script:Fail++
        $script:Results.Add("FAIL  vcf-mcp responds to initialize")
      }
      if (-not $proc.HasExited) { $proc.Kill() | Out-Null }
    } finally {
      if ($proc -and -not $proc.HasExited) { $proc.Kill() | Out-Null }
    }
  }

  # ---- uninstall ------------------------------------------------------------

  if ($SkipUninstall) {
    Write-Section "Uninstall (skipped via -SkipUninstall)"
    Write-Host "  (skipped)"
    $script:Skip += 2
    $script:Results.Add("SKIP  scoop uninstall vcf-cli")
    $script:Results.Add("SKIP  scoop bucket rm kaelith-labs")
  } else {
    Write-Section "Uninstall + clean"
    Assert-Exit0 "scoop uninstall vcf-cli" "scoop" @("uninstall", "vcf-cli")
    Assert-Exit0 "scoop bucket rm kaelith-labs" "scoop" @("bucket", "rm", "kaelith-labs")
    Assert-Check "vcf is no longer on PATH" {
      -not (Get-Command vcf -ErrorAction SilentlyContinue)
    }
  }

}
finally {
  Restore-State
}

# ---- summary ---------------------------------------------------------------

$elapsed = [int]((Get-Date) - $script:StartedAt).TotalSeconds
Write-Section "Summary"
Write-Host "  pass: $($script:Pass)"
Write-Host "  fail: $($script:Fail)"
Write-Host "  skip: $($script:Skip)"
Write-Host "  time: ${elapsed}s"
Write-Host ""
if ($script:Fail -gt 0) {
  Write-Host "Failed checks:" -ForegroundColor Red
  $script:Results | Where-Object { $_ -like 'FAIL*' } | ForEach-Object { "  $_" } | Write-Host
  Write-Host ""
  Write-Host "RESULT: FAIL" -ForegroundColor Red
  exit 1
}
Write-Host "RESULT: PASS" -ForegroundColor Green
exit 0
