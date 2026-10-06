<#
.SYNOPSIS
  Deploy the checked-out code to the Railway "Deckino Web" service (API + website).

.DESCRIPTION
  Uploads Code/ with the Railway CLI (railway up --detach), which builds the Dockerfile
  on Railway, then waits for that deployment to go live and checks /api/health.

  railway up uploads the working tree as it is on disk, uncommitted changes included,
  so the script warns when the tree is dirty. Needs the Railway CLI, signed in
  (railway login) and linked to the "Deckino" project (railway link).

.EXAMPLE
  .\scripts\deploy-railway.ps1
#>
$ErrorActionPreference = 'Stop'

$service = 'Deckino Web'
$healthUrl = 'https://deckino-production.up.railway.app/api/health'
$root = Split-Path $PSScriptRoot -Parent

Push-Location $root
try {
    if (git status --porcelain) {
        Write-Warning 'Uncommitted changes will be deployed too.'
    }
    $commit = git log -1 --format='%h %s'

    # Upload and return straight away; streaming build logs (--ci) can time out on long builds.
    $output = railway up --service $service --detach -m $commit 2>&1 | Out-String
    Write-Host $output.Trim()
    if ($LASTEXITCODE -ne 0) { throw "railway up failed (exit $LASTEXITCODE)." }
    if ($output -notmatch '[?&]id=([0-9a-f-]{36})') { throw 'Could not find the deployment id in the railway up output.' }
    $deploymentId = $Matches[1]

    # The old deployment keeps serving until this one is live, so follow this deployment's own status.
    Write-Host "Waiting for deployment $deploymentId to go live..."
    $deadline = (Get-Date).AddMinutes(15)
    $status = $null
    do {
        Start-Sleep -Seconds 10
        try {
            $deployments = railway deployment list --service $service --json | ConvertFrom-Json
            $newStatus = ($deployments | Where-Object id -eq $deploymentId).status
            if ($newStatus -ne $status) { Write-Host "  $newStatus"; $status = $newStatus }
        } catch {
            Write-Host '  (could not read status, retrying)'
        }
    } while (($status -notin 'SUCCESS', 'FAILED', 'CRASHED', 'REMOVED') -and (Get-Date) -lt $deadline)
    if ($status -ne 'SUCCESS') {
        throw "Deployment $deploymentId is $status. Check: railway logs --service '$service'"
    }

    $health = Invoke-RestMethod $healthUrl -TimeoutSec 30
    if ($health.status -ne 'Healthy') { throw "$healthUrl reports $($health.status)." }
    Write-Host "Deployed $commit - $healthUrl is Healthy."
} finally {
    Pop-Location
}
