<#
.SYNOPSIS
  Installs CodeGraph: the MCP server (global) and the VS Code extension.
.DESCRIPTION
  Run from anywhere:
    .\install.ps1 -Workspace C:\path\to\your-project
  What it does:
    1. Checks Node.js >= 20.
    2. npm install -g ./mcp  (global `codegraph-mcp`, `duckgraph-mcp`, `codegraph-setup` commands)
    3. codegraph-setup --workspace <Workspace>  (writes the Claude Desktop entry, no hand-editing)
    4. Installs codegraph-*.vsix into VS Code via `code --install-extension` (skipped with -SkipExtension).
.PARAMETER Workspace
  Project folder the MCP server should index. Defaults to the current directory.
.PARAMETER ServerName
  MCP server name in Claude config. Default "codegraph".
.PARAMETER ConfigPath
  Override the Claude Desktop config path (mainly for testing).
.PARAMETER SkipMcp
  Skip the MCP server install.
.PARAMETER SkipExtension
  Skip the VS Code extension install.
#>
param(
  [string]$Workspace = (Get-Location).Path,
  [string]$ServerName = "codegraph",
  [string]$ConfigPath = "",
  [switch]$SkipMcp,
  [switch]$SkipExtension
)

$ErrorActionPreference = "Stop"
$root = Split-Path $MyInvocation.MyCommand.Definition -Parent

function Require-Node {
  try {
    $version = (& node --version) -replace "^v", ""
  } catch {
    throw "Node.js was not found on PATH. Install Node.js 20+ from https://nodejs.org, then re-run."
  }
  if ([version]$version -lt [version]"20.0.0") {
    throw "Node.js $version found, but CodeGraph needs Node.js 20+. Upgrade, then re-run."
  }
  Write-Host "Node.js $version OK"
}

if (-not $SkipMcp) {
  Require-Node
  Write-Host "Installing CodeGraph MCP server globally..."
  & npm install -g (Join-Path $root "mcp") --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm install -g ./mcp failed" }

  $setupArgs = @("--workspace", (Resolve-Path $Workspace).Path, "--name", $ServerName)
  if ($ConfigPath -ne "") { $setupArgs += @("--config-path", $ConfigPath) }
  try {
    & codegraph-setup @setupArgs
  } catch {
    # Same-session PATH may not see the fresh global bin yet; run it directly.
    & node (Join-Path $root "mcp/bin/codegraph-setup.js") @setupArgs
  }
  Write-Host "MCP server installed. Restart Claude Desktop to pick it up."
}

if (-not $SkipExtension) {
  $vsix = Get-ChildItem (Join-Path $root "codegraph-*.vsix") | Sort-Object Name | Select-Object -Last 1
  if (-not $vsix) {
    Write-Warning "No codegraph-*.vsix found next to install.ps1; skipping extension install."
  } elseif (-not (Get-Command code -ErrorAction SilentlyContinue)) {
    Write-Warning "'code' CLI not on PATH. Install the extension manually:"
    Write-Warning "  code --install-extension $($vsix.FullName)"
    Write-Warning "Or open the .vsix in VS Code: Extensions view -> ... -> Install from VSIX."
  } else {
    Write-Host "Installing VS Code extension $($vsix.Name)..."
    & code --install-extension $vsix.FullName --force
    Write-Host "Extension installed."
  }
}

Write-Host "Done."
