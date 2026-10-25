# NEXUS R1 research: one bounded run (DRAFT wrapper for the Windows task draft; not scheduled). Started from the research
# checkout (C:\NEXUS\research, a reviewed release tag, built beforehand). It never builds, migrates or updates code.
# Output goes to a daily log file under logs\ (counts and codes only; the process prints no secret).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root
if (-not (Test-Path 'dist\research\research-main.js')) { Write-Error 'research build missing (dist\research\research-main.js)'; exit 1 }
if (-not (Test-Path '.env.research')) { Write-Error '.env.research missing'; exit 1 }

$env:NEXUS_RESEARCH_CODE_VERSION = (git rev-parse HEAD).Trim()
New-Item -ItemType Directory -Force 'logs' | Out-Null
$day = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')
$log = Join-Path 'logs' ('research-' + $day + '.log')
$out = [System.IO.Path]::GetTempFileName()
$err = [System.IO.Path]::GetTempFileName()
try {
  # A bounded heap; below-normal priority so development work and other applications keep precedence.
  $p = Start-Process -FilePath 'node' -ArgumentList '--max-old-space-size=512', 'dist\research\research-main.js' -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
  try { $p.PriorityClass = 'BelowNormal' } catch { }
  # The task limit (PT6M) is the outer bound; the process ends itself after its deadline (default 240 s + 20 s).
  if (-not $p.WaitForExit(330000)) { $p.Kill(); Add-Content $log ((Get-Date).ToUniversalTime().ToString('o') + ' killed after 330 s'); exit 3 }
  $stamp = (Get-Date).ToUniversalTime().ToString('o')
  Add-Content $log ($stamp + ' exit=' + $p.ExitCode + ' ' + ((Get-Content $out -Raw) -replace '\s+$', ''))
  $e = (Get-Content $err -Raw)
  if ($e) { Add-Content $log ($stamp + ' stderr: ' + ($e -replace '\s+$', '')) }
  exit $p.ExitCode
} finally {
  Remove-Item $out, $err -ErrorAction SilentlyContinue
}
