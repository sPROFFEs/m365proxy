param(
    [switch] $FromRepo,
    [switch] $Yes,
    [switch] $UseSystemNode,
    [switch] $NoPath,
    [switch] $SkipBrowserCheck,
    [switch] $DryRun,
    [string] $NodeVersion = 'latest',
    [string] $Prefix,
    [string] $BinDir
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

function Fail([string] $Message) { throw $Message }
if ($env:OS -ne 'Windows_NT') {
    Fail 'install.ps1 is for native Windows. On Linux/macOS use install-online.sh.'
}
function Note([string] $Message) { Write-Host "`n[m365proxy] $Message" }
function Invoke-Checked([string] $File, [object[]] $Arguments) {
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$File exited with code $LASTEXITCODE." }
}
function Refresh-Path {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (($machine, $user) -join ';').Trim(';')
}
function Ensure-Git {
    $git = Get-Command git.exe -ErrorAction SilentlyContinue
    if ($git) { return $git.Source }
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if (-not $winget) { Fail 'Git is required and winget is not available. Install Git for Windows, then rerun.' }
    Note 'Git is missing; installing Git for Windows with winget.'
    & $winget.Source install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { Fail "winget could not install Git (exit $LASTEXITCODE)." }
    Refresh-Path
    $git = Get-Command git.exe -ErrorAction SilentlyContinue
    if (-not $git) {
        $candidate = Join-Path $env:ProgramFiles 'Git\cmd\git.exe'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
        Fail 'Git was installed but is not visible in this shell. Open a new PowerShell window and rerun.'
    }
    return $git.Source
}
function Add-UserPath([string] $Directory) {
    $current = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($null -eq $current) { $current = '' }
    $parts = @($current -split ';' | Where-Object { $_ -and $_.Trim() })
    $needle = $Directory.TrimEnd('\')
    $exists = $false
    foreach ($part in $parts) {
        if ($part.Trim().TrimEnd('\').Equals($needle, [StringComparison]::OrdinalIgnoreCase)) { $exists = $true; break }
    }
    if (-not $exists) {
        $updated = if ($current.Trim()) { $current.TrimEnd(';') + ';' + $Directory } else { $Directory }
        [Environment]::SetEnvironmentVariable('Path', $updated, 'User')
    }
    if (-not (($env:Path -split ';') | Where-Object { $_.TrimEnd('\').Equals($needle, [StringComparison]::OrdinalIgnoreCase) })) {
        $env:Path = "$Directory;$env:Path"
    }
}
function Get-NodeMajorVersion([string] $NodePath) {
    $versionText = (& $NodePath --version).Trim()
    if ($LASTEXITCODE -ne 0) {
        Fail "Node failed while checking its version: $NodePath"
    }
    if ($versionText -notmatch '^v(?<major>[0-9]+)\.') {
        Fail "Could not parse Node version: $versionText"
    }
    return [int] $Matches['major']
}

# When invoked as: irm .../install.ps1 | iex, first obtain a clean repo snapshot
# and reinvoke the checked-in installer from disk.
$localPackage = $null
if ($PSScriptRoot) { $localPackage = Join-Path $PSScriptRoot 'package.json' }
$hasRepo = $PSScriptRoot -and (Test-Path -LiteralPath $localPackage -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'UPSTREAM.json') -PathType Leaf)
if (-not $FromRepo -and -not $hasRepo) {
    $git = Ensure-Git
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('m365proxy-online-' + [Guid]::NewGuid().ToString('N'))
    try {
        New-Item -ItemType Directory -Path $tmp | Out-Null
        $repo = Join-Path $tmp 'm365proxy'
        Note 'Downloading sPROFFEs/m365proxy from GitHub.'
        Invoke-Checked $git @('clone', '--depth', '1', '--branch', 'main', 'https://github.com/sPROFFEs/m365proxy.git', $repo)
        $script = Join-Path $repo 'install.ps1'
        $powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
        & $powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File $script -FromRepo -Yes
        $code = $LASTEXITCODE
        if ($code -ne 0) { throw "m365proxy installer exited with code $code." }
    } finally {
        if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    }
    return
}
$SourceRoot = $PSScriptRoot
if (-not $SourceRoot -or -not (Test-Path -LiteralPath (Join-Path $SourceRoot 'UPSTREAM.json') -PathType Leaf)) {
    Fail 'Run install.ps1 from the m365proxy repository, or use the documented one-line installer.'
}
if (-not $Prefix) { $Prefix = Join-Path $env:LOCALAPPDATA 'm365proxy' }
if (-not $BinDir) { $BinDir = Join-Path $Prefix 'bin' }
$Prefix = [IO.Path]::GetFullPath($Prefix)
$BinDir = [IO.Path]::GetFullPath($BinDir)
$SourceRoot = [IO.Path]::GetFullPath($SourceRoot)
if ($Prefix.Contains("`n") -or $Prefix.Contains("`r") -or $Prefix.Contains('"')) { Fail 'The installation prefix contains unsupported characters.' }
if ($BinDir.Contains("`n") -or $BinDir.Contains("`r") -or $BinDir.Contains('"')) { Fail 'The bin directory contains unsupported characters.' }
if ($Prefix.TrimEnd('\').Equals($SourceRoot.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) { Fail 'Use a dedicated installation prefix outside the source checkout.' }
if ($UseSystemNode -and $NodeVersion -ne 'latest') { Fail '-UseSystemNode cannot be combined with -NodeVersion.' }
if ($NodeVersion -ne 'latest' -and $NodeVersion -notmatch '^24\.[0-9]+\.[0-9]+$') { Fail '-NodeVersion must be latest or a stable 24.x.y release.' }
$archName = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
switch -Regex ($archName) {
    '^(AMD64|x86_64)$' { $Arch = 'x64'; break }
    '^(ARM64|aarch64)$' { $Arch = 'arm64'; break }
    default { Fail "Unsupported Windows architecture: $archName. Requires x64 or arm64." }
}
Write-Host @"
Installation plan
  Platform:      Windows $Arch
  Application:   $Prefix\releases\...
  Command:       $BinDir\m365proxy.cmd
  Node:          $(if ($UseSystemNode) { 'existing Node >=24 + npm' } else { "private Node 24 ($NodeVersion)" })
  User PATH:     $(if ($NoPath) { 'unchanged' } else { $BinDir })
  Browser:       Playwright Chromium, private download cache
  Account data:  $env:USERPROFILE\.m365-copilot-local (existing profile/key preserved)
No Microsoft sign-in or service auto-start occurs during installation.
"@
if ($DryRun) { return }
if (-not $Yes) {
    $answer = Read-Host 'Continue? [y/N]'
    if ($answer -notmatch '^[yY]([eE][sS])?$') { Write-Host 'Cancelled.'; return }
}
$git = Ensure-Git
$installedBin = Join-Path $Prefix 'bin'
if (-not $BinDir.TrimEnd('\').Equals($installedBin.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
    $externalLauncher = Join-Path $BinDir 'm365proxy.cmd'
    if (Test-Path -LiteralPath $externalLauncher -PathType Leaf) {
        $existingShim = Get-Content -LiteralPath $externalLauncher -Raw -ErrorAction SilentlyContinue
        if ($existingShim -notmatch 'm365proxy-managed-shim-v1') {
            Fail 'An unrelated m365proxy.cmd already exists in the requested bin directory.'
        }
    }
}
$marker = Join-Path $Prefix '.m365proxy-install'
if (Test-Path -LiteralPath $Prefix) {
    $entries = @(Get-ChildItem -LiteralPath $Prefix -Force -ErrorAction SilentlyContinue)
    if ($entries.Count -gt 0) {
        if (-not (Test-Path -LiteralPath $marker -PathType Leaf) -or (Get-Content -LiteralPath $marker -Raw).Trim() -ne 'm365proxy-user-install-v1') {
            Fail 'Non-empty prefix does not belong to this installer; refusing to overwrite it.'
        }
    }
}
New-Item -ItemType Directory -Force -Path $Prefix, (Join-Path $Prefix 'runtime'), (Join-Path $Prefix 'releases'), (Join-Path $Prefix 'bin'), (Join-Path $Prefix 'browsers') | Out-Null
[IO.File]::WriteAllText($marker, "m365proxy-user-install-v1`n", (New-Object Text.UTF8Encoding($false)))
$temp = Join-Path $Prefix ('.download-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
$guard = $null
$release = $null
try {
    if ($UseSystemNode) {
        $nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
        $npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
        if (-not $nodeCmd -or -not $npmCmd) { Fail '-UseSystemNode requires node and npm on PATH.' }
        $Node = $nodeCmd.Source
        $major = Get-NodeMajorVersion $Node
        if ($major -lt 24) { Fail 'Existing Node is older than 24.' }
    } else {
        Note 'Downloading the official Node 24 checksum manifest over HTTPS.'
        $dist = if ($NodeVersion -eq 'latest') { 'https://nodejs.org/download/release/latest-v24.x' } else { "https://nodejs.org/download/release/v$NodeVersion" }
        $manifest = Join-Path $temp 'SHASUMS256.txt'
        Invoke-WebRequest -UseBasicParsing -Uri "$dist/SHASUMS256.txt" -OutFile $manifest
        $pattern = '^([0-9a-fA-F]{64})\s+\*?(node-v24\.[0-9]+\.[0-9]+-win-' + [Regex]::Escape($Arch) + '\.zip)$'
        $hits = @()
        foreach ($line in Get-Content -LiteralPath $manifest) {
            if ($line -match $pattern) {
                $version = ($Matches[2] -replace '^node-v','') -replace '-win-.*$',''
                if ($NodeVersion -eq 'latest' -or $NodeVersion -eq $version) {
                    $hits += [PSCustomObject]@{ Hash = $Matches[1].ToLowerInvariant(); Archive = $Matches[2]; Version = $version }
                }
            }
        }
        if ($hits.Count -ne 1) { Fail 'Node checksum manifest did not contain exactly one matching Windows Node 24 archive.' }
        $hit = $hits[0]
        $Runtime = Join-Path (Join-Path $Prefix 'runtime') ("node-v{0}-win-{1}" -f $hit.Version, $Arch)
        $hashFile = Join-Path $Runtime '.archive-sha256'
        $validRuntime = (Test-Path -LiteralPath (Join-Path $Runtime 'node.exe') -PathType Leaf) -and (Test-Path -LiteralPath $hashFile -PathType Leaf)
        if ($validRuntime) { $validRuntime = ((Get-Content -LiteralPath $hashFile -Raw).Trim().ToLowerInvariant() -eq $hit.Hash) }
        if (-not $validRuntime) {
            if (Test-Path -LiteralPath $Runtime) { Fail "Existing private runtime is incomplete or has a different checksum: $Runtime" }
            Note "Installing private Node v$($hit.Version). System Node remains unchanged."
            $archivePath = Join-Path $temp $hit.Archive
            Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/download/release/v$($hit.Version)/$($hit.Archive)" -OutFile $archivePath
            $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
            if ($actual -ne $hit.Hash) { Fail 'Node archive checksum verification failed.' }
            $expanded = Join-Path $temp 'node-expanded'
            Expand-Archive -LiteralPath $archivePath -DestinationPath $expanded
            $root = Get-ChildItem -LiteralPath $expanded -Directory | Select-Object -First 1
            if (-not $root) { Fail 'Downloaded Node archive did not contain a runtime directory.' }
            Move-Item -LiteralPath $root.FullName -Destination $Runtime
            [IO.File]::WriteAllText((Join-Path $Runtime '.archive-sha256'), $hit.Hash + "`n", (New-Object Text.UTF8Encoding($false)))
        }
        $Node = Join-Path $Runtime 'node.exe'
        $major = Get-NodeMajorVersion $Node
        if ($major -ne 24) { Fail 'Downloaded Node 24 cannot run on this Windows host.' }
    }
    $env:Path = "$(Split-Path -Parent $Node);$env:Path"
    $env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $Prefix 'browsers'
    $env:PLAYWRIGHT_SKIP_BROWSER_GC = '1'
    # Hold the same application state lock while building and activating.
    $state = if ($env:M365_LOCAL_STATE_DIR) { [IO.Path]::GetFullPath($env:M365_LOCAL_STATE_DIR) } else { Join-Path $env:USERPROFILE '.m365-copilot-local' }
    $stateLock = Join-Path $SourceRoot 'scripts\state-lock.mjs'
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $Node
    $psi.Arguments = '"' + $stateLock + '" "' + $state + '"'
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $guard = New-Object Diagnostics.Process
    $guard.StartInfo = $psi
    if (-not $guard.Start()) { Fail 'Could not start the state-lock helper.' }
    $readyTask = $guard.StandardOutput.ReadLineAsync()
    if (-not $readyTask.Wait(20000)) {
        try { $guard.Kill() } catch {}
        try { $guard.WaitForExit(2000) | Out-Null } catch {}
        $detail = $guard.StandardError.ReadToEnd().Trim()
        if (-not $detail) { $detail = 'The state-lock helper did not become ready within 20 seconds.' }
        Fail "Cannot acquire the state directory. $detail"
    }
    $ready = $readyTask.Result
    if ($ready -ne 'READY') {
        $detail = $guard.StandardError.ReadToEnd().Trim()
        if (-not $detail) { $detail = 'The state-lock helper did not return READY.' }
        Fail "Cannot acquire the state directory. $detail"
    }
    $stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
    $release = Join-Path (Join-Path $Prefix 'releases') ("release-$stamp-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $release | Out-Null
    foreach ($name in @('src','scripts','tests','examples','docs')) {
        $src = Join-Path $SourceRoot $name
        if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination $release -Recurse }
    }
    foreach ($name in @('package.json','UPSTREAM.json','README.md','LICENSE','THIRD_PARTY_NOTICES.md','TEST_REPORT.md','.gitignore','install.sh','install-macos.sh','install-online.sh','install.ps1')) {
        $src = Join-Path $SourceRoot $name
        if (Test-Path -LiteralPath $src -PathType Leaf) { Copy-Item -LiteralPath $src -Destination $release }
    }
    $upstream = Get-Content -LiteralPath (Join-Path $SourceRoot 'UPSTREAM.json') -Raw | ConvertFrom-Json
    if ($upstream.bundledInThisZip -eq $true) {
        New-Item -ItemType Directory -Force -Path (Join-Path $release 'vendor') | Out-Null
        Copy-Item -LiteralPath (Join-Path $SourceRoot 'vendor\cramt') -Destination (Join-Path $release 'vendor') -Recurse
        Copy-Item -LiteralPath (Join-Path $SourceRoot 'UPSTREAM_FILES_SHA256.json') -Destination $release
    }
    [IO.File]::WriteAllText((Join-Path $release '.node-path'), $Node + "`n", (New-Object Text.UTF8Encoding($false)))
    Note 'Fetching/verifying pinned upstream source, installing dependencies and building.'
    Invoke-Checked $Node @((Join-Path $release 'scripts\bootstrap.mjs'), '--skip-browser')
    Note 'Installing the Chromium revision required by the pinned Playwright dependency.'
    Invoke-Checked $Node @((Join-Path $release 'scripts\browser-setup.mjs'), 'install')
    if (-not $SkipBrowserCheck) {
        Note 'Smoke-testing Chromium locally with about:blank. No Microsoft login is performed.'
        Invoke-Checked $Node @((Join-Path $release 'scripts\browser-setup.mjs'), 'check')
    }
    Invoke-Checked $Node @((Join-Path $release 'src\cli.mjs'), 'doctor')
    $installedBin = Join-Path $Prefix 'bin'
    Copy-Item -LiteralPath (Join-Path $release 'scripts\windows\launcher.mjs') -Destination (Join-Path $installedBin 'm365proxy-launcher.mjs') -Force
    Copy-Item -LiteralPath (Join-Path $release 'scripts\windows\launcher.cmd') -Destination (Join-Path $installedBin 'm365proxy.cmd') -Force
    $currentTmp = Join-Path $Prefix ('.current-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    [IO.File]::WriteAllText($currentTmp, $release + "`n", (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $currentTmp -Destination (Join-Path $Prefix 'current.txt') -Force
    if (-not $BinDir.TrimEnd('\').Equals($installedBin.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
        New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
        $target = Join-Path $installedBin 'm365proxy.cmd'
        $shim = "@echo off`r`nrem m365proxy-managed-shim-v1`r`ncall `"$target`" %*`r`nexit /b %ERRORLEVEL%`r`n"
        [IO.File]::WriteAllText((Join-Path $BinDir 'm365proxy.cmd'), $shim, [Text.Encoding]::ASCII)
    }
    if (-not $NoPath) { Add-UserPath $BinDir }
} finally {
    if ($guard) {
        try { $guard.StandardInput.Close() } catch {}
        try { if (-not $guard.HasExited) { $guard.WaitForExit(5000) | Out-Null } } catch {}
        try { $guard.Dispose() } catch {}
    }
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }
}
$launcher = Join-Path $BinDir 'm365proxy.cmd'
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { Fail 'Installation completed but the launcher was not created.' }
& $launcher --help
if ($LASTEXITCODE -ne 0) { Fail "Installed launcher failed its help smoke test with code $LASTEXITCODE." }
Write-Host "`nInstallation completed. Open a new terminal if PATH was updated, then run:"
Write-Host '  m365proxy menu'
Write-Host 'No Microsoft session has been tested by this installer.'
