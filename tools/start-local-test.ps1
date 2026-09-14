#requires -Version 5.1
<#
Fresh local application build and browser session. Run from any directory:
  powershell -NoProfile -ExecutionPolicy Bypass -File tools/start-local-test.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File tools/start-local-test.ps1 -DryRun

Preserves .env.deploy, PostgreSQL, Redis queues/sessions and MinIO volumes.
Docker layers are bypassed, not globally pruned; dependency download caches remain.
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$NoBrowser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$composeArgs = @(
    'compose',
    '-f', 'infrastructure/docker-compose.yml',
    '-f', 'deploy/mvp-apps.yml',
    '-f', 'deploy/local-proxy.yml',
    '--env-file', '.env.deploy'
)
$applications = @('api', 'web', 'generation-worker', 'render-worker', 'retention-worker')
$testUrl = 'http://localhost:8080'
$runLock = $null
$phase = 'preflight'

function Invoke-Checked {
    param([string]$Executable, [string[]]$Arguments)
    Write-Host ('=> ' + $Executable + ' ' + ($Arguments -join ' '))
    if ($DryRun) { return }
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Executable failed (exit $LASTEXITCODE). Resolve the error before retrying."
    }
}

function Build-Application {
    param([string]$Service)
    # One Compose target per invocation also works with Compose versions using Bake.
    $arguments = $composeArgs + @('build', '--no-cache', $Service)
    if ($DryRun) { Invoke-Checked 'docker' $arguments; return }
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        Write-Host "Build $Service (attempt $attempt/3)"
        $metadataError = $false
        $sharingViolation = $false
        $previousPreference = $ErrorActionPreference
        try {
            # Native stderr is build progress too; PowerShell 5.1 must not turn it
            # into an exception before we can inspect the exit code and lock error.
            $ErrorActionPreference = 'Continue'
            & docker @arguments 2>&1 | ForEach-Object {
                $line = $_.ToString()
                Write-Host $line
                if ($line -match 'failed to read metadata') { $metadataError = $true }
                if ($line -match 'being used by another process') { $sharingViolation = $true }
            }
            $buildExitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousPreference
        }
        if ($buildExitCode -eq 0) { return }
        if (!$metadataError -or !$sharingViolation) {
            throw "Build $Service failed (exit $buildExitCode). See the build output above."
        }
        if ($attempt -eq 3) {
            throw "Docker metadata is still locked after 3 attempts. Close other Docker builds, then retry. If the lock persists, restart Docker Desktop when other work has stopped. Do not delete Docker context metadata."
        }
        $delay = 2 * $attempt
        Write-Warning "Docker metadata is temporarily locked; retrying $Service in $delay seconds."
        Start-Sleep -Seconds $delay
    }
}

function Assert-WorkspacePath {
    param([string]$Path)
    $absolute = [IO.Path]::GetFullPath($Path)
    $prefix = $repoRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (!$absolute.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing a path outside the repository: $absolute"
    }
    # Reject junctions/symlinks in the target and its ancestors, including the root.
    $cursor = $absolute
    while ($cursor.Length -ge $repoRoot.Length) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -Force -LiteralPath $cursor
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Refusing a linked path: $cursor"
            }
        }
        $cursor = Split-Path -Parent $cursor
    }
    return $absolute
}

function Remove-BuildCache {
    param([string]$Path)
    $absolute = Assert-WorkspacePath $Path
    if (!(Test-Path -LiteralPath $absolute)) { return }
    # Do not recursively remove a tree containing junctions or symlinks.
    $links = @(Get-ChildItem -LiteralPath $absolute -Force -Recurse |
        Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })
    if ($links.Count -gt 0) { throw "Refusing cache tree containing links: $absolute" }
    Write-Host "Clear build cache: $absolute"
    if (!$DryRun) { Remove-Item -LiteralPath $absolute -Recurse -Force }
}

function Assert-HttpReady {
    param([string]$Url, [int[]]$Expected)
    if ($DryRun) { Write-Host "Check HTTP: $Url"; return }
    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 15
        $status = [int]$response.StatusCode
    } catch {
        if ($null -eq $_.Exception.Response) { throw }
        $status = [int]$_.Exception.Response.StatusCode
    }
    if ($status -notin $Expected) { throw "Readiness check failed: $Url returned HTTP $status" }
    Write-Host "Ready: $Url (HTTP $status)"
}

function Assert-InitSucceeded {
    param([string]$Container)
    if ($DryRun) { Write-Host "Check initialization exit code: $Container"; return }
    $deadline = [DateTime]::UtcNow.AddSeconds(180)
    do {
        $rawState = & docker inspect --format '{{json .State}}' $Container
        if ($LASTEXITCODE -ne 0) { throw "Cannot inspect initialization container: $Container" }
        $state = $rawState | ConvertFrom-Json
        if ($state.Status -eq 'exited') {
            if ($state.ExitCode -ne 0) { throw "$Container initialization failed (exit $($state.ExitCode))." }
            Write-Host "Initialization succeeded: $Container (exit 0)"
            return
        }
        if ($state.Status -eq 'dead') { throw "Initialization container is dead: $Container" }
        Start-Sleep -Seconds 2
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Timed out waiting for initialization container: $Container"
}

Push-Location $repoRoot
try {
    Write-Host 'Fresh local test: rebuild application images and recreate containers.'
    Write-Host 'Database, Redis and uploaded files are preserved. Builds may take several minutes.'

    if (!$DryRun) {
        $lockPath = Assert-WorkspacePath (Join-Path $repoRoot 'tmp/start-local-test.lock')
        New-Item -ItemType Directory -Path (Split-Path -Parent $lockPath) -Force | Out-Null
        try {
            $runLock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        } catch [IO.IOException] {
            throw 'Cannot acquire the local test lock. Another start-local-test script may be running; wait for it to finish before retrying.'
        }
        $dockerOS = & docker info --format '{{.OSType}}'
        if ($LASTEXITCODE -ne 0) { throw 'Docker is unavailable. Start Docker Desktop and retry.' }
        if ($dockerOS -ne 'linux') { throw 'Switch Docker Desktop to Linux containers first.' }
    }

    # Keep existing credentials and provider configuration.
    if (!(Test-Path -LiteralPath (Join-Path $repoRoot '.env.deploy'))) {
        Invoke-Checked 'node' @('tools/gen-local-env.mjs')
    }
    Invoke-Checked 'docker' ($composeArgs + @('config', '--quiet'))

    Write-Host '[1/4] Clear local build caches'
    Remove-BuildCache (Join-Path $repoRoot '.turbo')
    Remove-BuildCache (Join-Path $repoRoot 'apps/web/.next')
    foreach ($group in @('apps', 'packages')) {
        foreach ($project in Get-ChildItem -LiteralPath (Join-Path $repoRoot $group) -Directory) {
            Remove-BuildCache (Join-Path $project.FullName '.turbo')
        }
    }

    # Build before stopping the old application so a build failure leaves it available.
    # .dockerignore excludes host .next/dist/.turbo and node_modules from the build.
    $phase = 'build'
    Write-Host '[2/4] Build fresh images sequentially (no Docker layer cache)'
    foreach ($application in $applications) { Build-Application $application }

    $phase = 'startup'
    Write-Host '[3/4] Stop applications, recreate the stack and wait for health checks'
    Invoke-Checked 'docker' ($composeArgs + @('stop', 'local-proxy') + $applications)
    Invoke-Checked 'docker' ($composeArgs + @(
        'up', '-d', '--no-build', '--force-recreate'
    ))
    # Compose --wait treats unreferenced one-shot services as long-running services
    # and may report minio-init's successful exit as a failure. Wait only for the
    # runtime services without restarting dependencies, then verify init exit codes.
    $runtimeServices = $applications + @('local-proxy', 'postgres', 'redis', 'minio')
    Invoke-Checked 'docker' ($composeArgs + @(
        'up', '-d', '--no-build', '--no-recreate', '--no-deps', '--wait', '--wait-timeout', '180'
    ) + $runtimeServices)
    Assert-InitSucceeded 'tps-db-migrate'
    Assert-InitSucceeded 'tps-minio-init'

    Write-Host '[4/4] Verify frontend, API and proxy'
    Assert-HttpReady "$testUrl/" @(200)
    Assert-HttpReady 'http://localhost:3001/readyz' @(200)
    Assert-HttpReady "$testUrl/api/v1/auth/session" @(200, 401)

    if (!$NoBrowser) {
        # A new profile per run isolates HTTP cache, local storage and login cookies.
        # Do not delete or terminate any existing browser profile/session.
        $browser = $null
        foreach ($base in @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:LOCALAPPDATA)) {
            if (!$base) { continue }
            foreach ($relative in @('Microsoft/Edge/Application/msedge.exe', 'Google/Chrome/Application/chrome.exe')) {
                $candidate = Join-Path $base $relative
                if (Test-Path -LiteralPath $candidate) { $browser = $candidate; break }
            }
            if ($browser) { break }
        }
        if ($DryRun) {
            Write-Host "Open Edge/Chrome with a new temporary profile: $testUrl"
        } elseif ($browser) {
            $profile = Assert-WorkspacePath (Join-Path $repoRoot ('tmp/local-test-browser/' + [guid]::NewGuid().ToString('N')))
            New-Item -ItemType Directory -Path $profile -Force | Out-Null
            Start-Process -FilePath $browser -ArgumentList @(
                ('--user-data-dir="' + $profile + '"'), '--no-first-run', '--no-default-browser-check', '--new-window', $testUrl
            ) | Out-Null
            Write-Host "Browser profile: $profile (can be removed after closing this browser)"
        } else {
            Write-Warning "Edge/Chrome not found. Open $testUrl in a fresh browser profile manually."
        }
    }
    if ($DryRun) { Write-Host 'Dry run finished; no files, containers or browser sessions were changed.' }
    else { Write-Host "Local test ready: $testUrl" }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    if ($phase -eq 'build') {
        Write-Host 'Build failed; existing services have not been stopped by this script.'
        Write-Host 'For Docker builder errors, inspect: docker buildx ls'
    } elseif ($phase -eq 'startup') {
        Write-Host 'Inspect service logs with:'
        Write-Host ('docker ' + (($composeArgs + @('logs', '--tail', '80')) -join ' '))
    }
    exit 1
} finally {
    if ($null -ne $runLock) { $runLock.Dispose() }
    Pop-Location
}
