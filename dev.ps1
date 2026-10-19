<#
.SYNOPSIS
    Developer automation CLI for the AI Proposals Obsidian Plugin.

.DESCRIPTION
    Wraps Docker container operations (build, test, watch, shell, clean, rebuild)
    and manages deployment to the active Obsidian vault's plugins folder.
    Enforces strict mode and propagates container exit codes.

.PARAMETER Command
    The action to execute: build, test, watch, deploy, clean, rebuild, shell, or help.
    Default: 'help'.

.PARAMETER PluginDir
    Custom destination path for deploying the plugin to an Obsidian vault.
    Default: '../../.obsidian/plugins/ai-proposals'.

.PARAMETER DeployAfterBuild
    Switch. If specified with 'build', automatically triggers 'deploy' on success.

.PARAMETER All
    Switch. When specified with 'clean', removes the Docker named volume (node_modules).

.EXAMPLE
    .\dev.ps1 build
    .\dev.ps1 build -DeployAfterBuild
    .\dev.ps1 test
    .\dev.ps1 watch
    .\dev.ps1 deploy
    .\dev.ps1 deploy -PluginDir "D:\CustomVault\.obsidian\plugins\ai-proposals"
    .\dev.ps1 clean -All
    .\dev.ps1 shell
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0, Mandatory = $false)]
    [ValidateSet('build', 'test', 'watch', 'deploy', 'clean', 'rebuild', 'shell', 'help')]
    [string]$Command = 'help',

    [Parameter(Mandatory = $false)]
    [string]$PluginDir = '',

    [Parameter(Mandatory = $false)]
    [switch]$DeployAfterBuild,

    [Parameter(Mandatory = $false)]
    [switch]$All
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Project paths
$ProjectRoot = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$DistDir = Join-Path $ProjectRoot "dist"

# Resolve target Obsidian plugin directory
if ($PluginDir -ne '') {
    $TargetPluginDir = [System.IO.Path]::GetFullPath($PluginDir)
} else {
    $envDir = [Environment]::GetEnvironmentVariable('OBSIDIAN_PLUGIN_DIR')
    if (-not [string]::IsNullOrEmpty($envDir)) {
        $TargetPluginDir = [System.IO.Path]::GetFullPath($envDir)
    } else {
        $TargetPluginDir = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot "..\..\.obsidian\plugins\ai-proposals"))
    }
}

# Terminal UI helpers
function Write-Header([string]$Message) {
    Write-Host "`n=== [AI Proposals] $Message ===" -ForegroundColor Cyan
}

function Write-Success([string]$Message) {
    Write-Host "[OK] $Message" -ForegroundColor Green
}

function Write-WarningMsg([string]$Message) {
    Write-Host "[WARN] $Message" -ForegroundColor Yellow
}

function Write-ErrorMsg([string]$Message) {
    Write-Host "[ERROR] $Message" -ForegroundColor Red
}

function Assert-DockerAvailable() {
    $dockerCmd = Get-Command "docker" -ErrorAction SilentlyContinue
    if (-not $dockerCmd) {
        Write-ErrorMsg "Docker is not installed or not in PATH."
        Write-Host "Please install Docker Desktop and ensure it is running." -ForegroundColor DarkGray
        exit 1
    }
}

function Cleanup-HostNodeModules() {
    $hostNm = Join-Path $ProjectRoot "node_modules"
    if (Test-Path $hostNm) {
        for ($i = 0; $i -lt 15; $i++) {
            try {
                $items = @(Get-ChildItem -Path $hostNm -Force -ErrorAction SilentlyContinue)
                if ($items.Count -eq 0) {
                    Remove-Item -Path $hostNm -Force -Recurse -ErrorAction Stop
                    break
                }
            } catch {
                Start-Sleep -Milliseconds 400
            }
        }
    }
}

function Run-Build() {
    Assert-DockerAvailable
    Write-Header "Building Plugin via Docker (Production Bundle)"
    
    docker compose run --rm build
    $exitCode = $LASTEXITCODE
    Cleanup-HostNodeModules
    if ($exitCode -ne 0) {
        Write-ErrorMsg "Build failed with exit code $exitCode."
        exit $exitCode
    }
    
    $distFiles = @(Get-ChildItem -Path $DistDir -File -ErrorAction SilentlyContinue)
    Write-Success "Build succeeded. Output artifacts ($($distFiles.Count) files) located in $DistDir"

    if ($DeployAfterBuild) {
        Run-Deploy
    }
}

function Run-Test() {
    Assert-DockerAvailable
    Write-Header "Running Headless Unit Tests (Vitest) via Docker"
    
    docker compose run --rm test
    $exitCode = $LASTEXITCODE
    Cleanup-HostNodeModules
    if ($exitCode -ne 0) {
        Write-ErrorMsg "Unit tests failed with exit code $exitCode."
        exit $exitCode
    }
    
    Write-Success "All unit tests passed successfully."
}

function Run-Watch() {
    Assert-DockerAvailable
    Write-Header "Starting Real-time Incremental Watcher (docker compose up watch)"
    Write-Host "Monitoring 'src/' for changes. Press Ctrl+C to terminate." -ForegroundColor DarkGray
    
    docker compose up watch
}

function Run-Deploy() {
    Write-Header "Deploying Plugin to Obsidian Vault"
    Write-Host "Destination: $TargetPluginDir" -ForegroundColor DarkGray

    # Ensure build artifacts exist; trigger build if missing
    $MainJs = Join-Path $DistDir "main.js"
    $ManifestJson = Join-Path $DistDir "manifest.json"
    $StylesCss = Join-Path $DistDir "styles.css"

    if (-not (Test-Path $MainJs) -or -not (Test-Path $ManifestJson)) {
        Write-WarningMsg "Required build artifacts missing in $DistDir. Running build first..."
        Run-Build
    }

    # Verify artifacts exist after build attempt
    if (-not (Test-Path $MainJs) -or -not (Test-Path $ManifestJson)) {
        Write-ErrorMsg "Deployment aborted: main.js or manifest.json not found in $DistDir."
        exit 1
    }

    # Ensure target vault plugin directory exists
    if (-not (Test-Path $TargetPluginDir)) {
        Write-Host "Creating target plugin directory: $TargetPluginDir" -ForegroundColor DarkGray
        New-Item -ItemType Directory -Path $TargetPluginDir -Force | Out-Null
    }

    # Copy distribution artifacts
    Copy-Item -Path $MainJs -Destination (Join-Path $TargetPluginDir "main.js") -Force
    Copy-Item -Path $ManifestJson -Destination (Join-Path $TargetPluginDir "manifest.json") -Force
    Write-Host "  -> Deployed main.js" -ForegroundColor DarkGray
    Write-Host "  -> Deployed manifest.json" -ForegroundColor DarkGray

    if (Test-Path $StylesCss) {
        Copy-Item -Path $StylesCss -Destination (Join-Path $TargetPluginDir "styles.css") -Force
        Write-Host "  -> Deployed styles.css" -ForegroundColor DarkGray
    }

    # Touch .hotreload trigger marker for Obsidian Hot Reload community plugin
    $HotReloadFile = Join-Path $TargetPluginDir ".hotreload"
    if (Test-Path $HotReloadFile) {
        (Get-Item $HotReloadFile).LastWriteTime = Get-Date
        Write-Host "  -> Updated .hotreload timestamp" -ForegroundColor DarkGray
    } else {
        New-Item -ItemType File -Path $HotReloadFile -Force | Out-Null
        Write-Host "  -> Created .hotreload marker file" -ForegroundColor DarkGray
    }

    Cleanup-HostNodeModules
    Write-Success "Plugin deployed successfully to $TargetPluginDir"
    Write-Host "Obsidian Status: Plugin ready. If Hot Reload is active, changes reload automatically." -ForegroundColor Green
}

function Run-Clean() {
    Write-Header "Cleaning Build Artifacts and Local Workspace"
    
    if (Test-Path $DistDir) {
        Remove-Item -Recurse -Force $DistDir
        Write-Success "Removed distribution directory: $DistDir"
    } else {
        Write-Host "Distribution directory $DistDir already clean." -ForegroundColor DarkGray
    }

    Cleanup-HostNodeModules

    if ($All) {
        Assert-DockerAvailable
        Write-Host "Removing Docker containers, networks, and named volume (node_modules)..." -ForegroundColor Yellow
        docker compose down -v --remove-orphans
        Write-Success "Docker environment reset to clean state."
    } else {
        Write-Host "Tip: Use '.\dev.ps1 clean -All' to also remove the Docker node_modules volume." -ForegroundColor DarkGray
    }
}

function Run-Rebuild() {
    Assert-DockerAvailable
    Write-Header "Rebuilding Docker Development Image (No-Cache)"
    
    docker compose build --no-cache
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        Write-ErrorMsg "Docker image build failed with exit code $exitCode."
        exit $exitCode
    }
    
    Write-Success "Docker image rebuilt successfully."
}

function Run-Shell() {
    Assert-DockerAvailable
    Write-Header "Opening Interactive Container Shell"
    Write-Host "Entering Node.js container environment (/app). Type 'exit' to leave." -ForegroundColor DarkGray
    
    docker compose run --rm build /bin/sh
}

function Show-Help() {
    $helpText = @"
========================================================================
AI Proposals Obsidian Plugin -- Developer CLI (dev.ps1)
========================================================================
Usage:
  .\dev.ps1 <command> [options]

Commands:
  build             Compile production bundle into ./dist/ (tsc + esbuild)
  test              Run headless unit tests (Vitest) inside Docker
  watch             Start real-time incremental watcher (docker compose up watch)
  deploy            Sync ./dist/ artifacts to Obsidian vault & touch .hotreload
  clean             Remove ./dist/ directory (add -All to remove Docker volume)
  rebuild           Rebuild Docker image from scratch (--no-cache)
  shell             Open interactive shell inside the container
  help              Display this help manual

Options:
  -DeployAfterBuild  When running 'build', automatically deploy on success
  -PluginDir <path>  Specify custom destination directory for 'deploy'
  -All               Used with 'clean' to purge Docker volumes

Examples:
  .\dev.ps1 build
  .\dev.ps1 build -DeployAfterBuild
  .\dev.ps1 test
  .\dev.ps1 watch
  .\dev.ps1 deploy
  .\dev.ps1 deploy -PluginDir "D:\Vault\.obsidian\plugins\ai-proposals"
  .\dev.ps1 clean -All
  .\dev.ps1 shell
========================================================================
"@
    Write-Host $helpText -ForegroundColor White
}

# Anchor location to ProjectRoot during execution
Push-Location $ProjectRoot
try {
    switch ($Command) {
        'build'   { Run-Build }
        'test'    { Run-Test }
        'watch'   { Run-Watch }
        'deploy'  { Run-Deploy }
        'clean'   { Run-Clean }
        'rebuild' { Run-Rebuild }
        'shell'   { Run-Shell }
        default   { Show-Help }
    }
}
finally {
    Pop-Location
}
