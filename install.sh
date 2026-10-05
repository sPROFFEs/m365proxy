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
