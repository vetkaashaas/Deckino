<#
.SYNOPSIS
  Deploy the checked-out code to the Railway "Deckino Web" service (API + website).

.DESCRIPTION
  Uploads Code/ with the Railway CLI (railway up), which builds the Dockerfile on
  Railway, waits for the new deployment to go live, then checks /api/health.

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

    # --ci streams the build logs and returns once the build finishes; a failed build is a non-zero exit.
    railway up --service $service --ci -m $commit
    if ($LASTEXITCODE -ne 0) { throw "railway up failed (exit $LASTEXITCODE)." }

    # The old deployment keeps serving until the new one is live, so follow the newest deployment itself.
    Write-Host 'Build done; waiting for the deployment to go live...'
    $deadline = (Get-Date).AddMinutes(10)
    do {
        Start-Sleep -Seconds 10
        $deployment = (railway deployment list --service $service --json | ConvertFrom-Json)[0]
        Write-Host "  $($deployment.status)"
    } while ($deployment.status -notin 'SUCCESS', 'FAILED', 'CRASHED', 'REMOVED' -and (Get-Date) -lt $deadline)
    if ($deployment.status -ne 'SUCCESS') {
        throw "Deployment $($deployment.id) is $($deployment.status). Check: railway logs --service '$service'"
    }

    $health = Invoke-RestMethod $healthUrl -TimeoutSec 30
    if ($health.status -ne 'Healthy') { throw "$healthUrl reports $($health.status)." }
    Write-Host "Deployed $commit - $healthUrl is Healthy."
} finally {
    Pop-Location
}
