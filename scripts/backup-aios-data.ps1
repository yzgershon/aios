# AIOS data backup — copies ~/.aios (goals, pipeline, portfolio, metrics,
# leads, histories) to a dated folder under ~/.aios-backups, keeps 30 days.
# Registered as the "AIOS Data Backup" scheduled task (daily).
$ErrorActionPreference = 'Stop'

$src  = Join-Path $env:USERPROFILE '.aios'
$root = Join-Path $env:USERPROFILE '.aios-backups'
$dest = Join-Path $root ('aios-' + (Get-Date -Format 'yyyy-MM-dd'))

if (-not (Test-Path $src)) { exit 0 }
New-Item -ItemType Directory -Force $root | Out-Null

# /MIR into today's folder (re-runs same day just refresh it); skip the
# archives subfolder — it holds old zips, no need to re-copy daily.
robocopy $src $dest /MIR /XD (Join-Path $src 'archives') /R:2 /W:2 /NP /NFL /NDL | Out-Null
if ($LASTEXITCODE -ge 8) { exit 1 }  # robocopy: >=8 means real failure

# prune backups older than 30 days
Get-ChildItem $root -Directory -Filter 'aios-*' | Where-Object {
  $_.Name -match '^aios-(\d{4}-\d{2}-\d{2})$' -and
  ([datetime]$Matches[1]) -lt (Get-Date).AddDays(-30)
} | Remove-Item -Recurse -Force -Confirm:$false

exit 0
