# Opens the native Windows app against the NightMail backend started in WSL by tools/dev/demo-wsl.sh.
#
#   npm run demo:windows                  # or: powershell -ExecutionPolicy Bypass -File tools\dev\demo.ps1
#   npm run demo:windows -- -Check        # only check the prerequisites, change nothing
#   npm run demo:windows -- -Build        # build the app here instead of downloading it
#   options: [-Perfil <profile>] [-WslDir <linux folder>] [-Distro <name, default: the WSL default>]
#            [-RepoRoot <folder>]
#
# Checks every prerequisite first and stops before changing anything if one is missing. Then: npm ci
# (when needed), copies the compiled contracts from the WSL copy, gets the app (the one built here, a
# fresh build with -Build, or the pinned release download, checked by its SHA-256) and opens it with
# window.ps1. -RepoRoot (default: this checkout) is meant for testing with -Check.
param(
    [switch]$Check,
    [switch]$Build,
    [string]$Perfil = 'perfil-a',
    [string]$WslDir = '',
    [string]$Distro = '',
    [string]$RepoRoot = ''
)

# Prebuilt app (debug build from build.ps1) published with the release, pinned by its SHA-256.
$AppUrl = 'https://github.com/Leyenda95/nightmail/releases/download/v0.1.0-alpha/nightmail-desktop-windows-x64.exe'
$AppSha256 = '8F54842C7572AE332618E5BBB425FEC74112B9FF7926CE09066A62D1CC15A925'

if (-not $RepoRoot) { $RepoRoot = Join-Path $PSScriptRoot '..\..' }
$Repo = (Resolve-Path $RepoRoot).Path
$TargetDir = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $Repo 'apps\desktop\src-tauri\target' }
$BuiltExe = Join-Path $TargetDir 'debug\nightmail-desktop.exe'
$DownloadedExe = Join-Path $Repo '.data\dev\bin\nightmail-desktop.exe'
$Ports = [ordered]@{ '9944' = 'devnet node'; '8088' = 'indexer'; '6300' = 'proof server'; '8787' = 'mail API'; '8788' = 'issuer'; '8789' = 'relayer' }
$RunWsl = "In WSL: bash $(if ($Repo -match '^([A-Za-z]):\\?(.*)$') { '/mnt/' + $Matches[1].ToLower() + '/' + ($Matches[2] -replace '\\', '/') } else { $Repo })/tools/dev/demo-wsl.sh"

function Test-Version([string]$Have, [string]$Want) {
    try { return [version]$Have -ge [version]$Want } catch { return $false }
}

# Commit checked out in a git checkout, read from its files (git may not be installed). '' without git.
function Get-GitHead([string]$Dir) {
    $head = Get-Content (Join-Path $Dir '.git\HEAD') -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $head) { return '' }
    if ($head -notmatch '^ref: (.+)$') { return $head.Trim() }
    $ref = $Matches[1].Trim()
    $loose = Get-Content (Join-Path $Dir ".git\$ref") -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($loose) { return $loose.Trim() }
    $packed = Get-Content (Join-Path $Dir '.git\packed-refs') -ErrorAction SilentlyContinue | Where-Object { $_ -like "* $ref" } | Select-Object -First 1
    if ($packed) { return $packed.Split(' ')[0] }
    return ''
}

function Test-AppHash([string]$Path) {
    (Test-Path $Path) -and (Get-FileHash $Path -Algorithm SHA256).Hash -eq $AppSha256
}

# ---------- 1. Prerequisites ----------
Write-Host '[1/4] Checking prerequisites'
$script:Missing = 0
function Ok([string]$Name, [string]$Detail) { Write-Host ('  OK       {0,-14} {1}' -f $Name, $Detail) }
function Note([string]$Name, [string]$Detail) { Write-Host ('  NOTE     {0,-14} {1}' -f $Name, $Detail) }
function Miss([string]$Name, [string]$Detail, [string[]]$Help = @()) {
    Write-Host ('  MISSING  {0,-14} {1}' -f $Name, $Detail)
    foreach ($line in $Help) { Write-Host ('           {0,-14} {1}' -f '', $line) }
    $script:Missing++
}

$nodeWant = (Get-Content (Join-Path $Repo '.nvmrc') -Raw).Trim().TrimStart('v')
if (Get-Command node.exe -ErrorAction SilentlyContinue) {
    $v = (& node.exe -v).Trim().TrimStart('v')
    if ($v.Split('.')[0] -eq $nodeWant.Split('.')[0] -and (Test-Version $v $nodeWant)) { Ok 'node' $v }
    else { Miss 'node' "found $v, need $nodeWant or a later $($nodeWant.Split('.')[0]).x" @('https://nodejs.org/en/download') }
} else {
    Miss 'node' "need $nodeWant" @('https://nodejs.org/en/download')
}
if (Get-Command npm.cmd -ErrorAction SilentlyContinue) { Ok 'npm' (& npm.cmd -v) } else { Miss 'npm' 'comes with Node' @('Install Node (see above)') }

# WSL, the distribution (the default one unless -Distro) and the Linux copy made by demo-wsl.sh.
$wslRepo = ''
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    Miss 'wsl' '' @('In an administrator terminal: wsl --install')
} else {
    $distroArgs = if ($Distro) { @('-d', $Distro) } else { @() }
    $info = (& wsl.exe @distroArgs -e sh -c 'echo $WSL_DISTRO_NAME:$HOME' 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $info -notmatch '^([^:]+):(/.*)$') {
        Miss 'wsl' $(if ($Distro) { "distribution $Distro not found" } else { 'no default distribution' }) @('wsl --install -d Ubuntu (or pass -Distro <name>)')
    } else {
        $Distro = $Matches[1]
        $wslHome = $Matches[2]
        Ok 'wsl' $Distro
        if (-not $WslDir) { $WslDir = "$wslHome/nightmail-wsl" }
        $unc = if (Test-Path "\\wsl.localhost\$Distro\") { "\\wsl.localhost\$Distro" } else { "\\wsl$\$Distro" }
        $wslRepo = $unc + ($WslDir -replace '/', '\')
        $need = @('.data\dev\run.env', '.data\operator\undeployed\contracts.json', 'contracts\managed\token\contract\index.js')
        $absent = @($need | Where-Object { -not (Test-Path (Join-Path $wslRepo $_)) })
        if ($absent.Count -eq 0) { Ok 'wsl-copy' $WslDir }
        else { Miss 'wsl-copy' "$WslDir is not ready (missing $($absent -join ', '))" @($RunWsl) }

        # The backend must run the same commit as this checkout (the app's helper process runs from here).
        $here = Get-GitHead $Repo
        $there = (Get-Content (Join-Path $wslRepo '.data\dev\source-commit') -ErrorAction SilentlyContinue | Select-Object -First 1)
        if ($here -match '^[0-9a-f]{40}$' -and "$there".Trim() -match '^[0-9a-f]{40}$' -and $here -ne $there.Trim()) {
            Write-Host ('  WARNING  {0,-14} {1}' -f 'versions', "the WSL copy runs commit $($there.Substring(0, 7)), this checkout is on $($here.Substring(0, 7)).")
            Write-Host ('           {0,-14} {1}' -f '', "Run demo-wsl.sh again ($RunWsl). A prebuilt app may not match either: use -Build.")
        }
    }
}

# WebView2 runtime (Evergreen): per machine or per user.
$wv2Id = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
$wv2 = @("HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$wv2Id", "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$wv2Id", "HKCU:\Software\Microsoft\EdgeUpdate\Clients\$wv2Id") |
    ForEach-Object { (Get-ItemProperty $_ -Name pv -ErrorAction SilentlyContinue).pv } | Where-Object { $_ -and $_ -ne '0.0.0.0' } | Select-Object -First 1
if ($wv2) { Ok 'webview2' $wv2 } else { Miss 'webview2' '' @('https://developer.microsoft.com/microsoft-edge/webview2/ (Evergreen runtime)') }

# Backend ports as seen from Windows (WSL ports reach 127.0.0.1 with mirrored networking).
$down = @()
foreach ($p in $Ports.Keys) {
    $c = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $c.BeginConnect('127.0.0.1', [int]$p, $null, $null)
        if (-not ($iar.AsyncWaitHandle.WaitOne(1500) -and $c.Connected)) { $down += "$($Ports[$p]) ($p)" }
    } catch {
        $down += "$($Ports[$p]) ($p)"
    } finally {
        $c.Close()
    }
}
$wslConfig = Join-Path $env:USERPROFILE '.wslconfig'
$mirrored = (Get-Content $wslConfig -ErrorAction SilentlyContinue) -match '^\s*networkingMode\s*=\s*mirrored\s*$'
if ($down.Count -eq 0) {
    Ok 'backend' 'all ports answer'
    if (-not $mirrored) { Note 'wsl-network' "networkingMode=mirrored not found in $wslConfig, but the ports answer" }
} else {
    $help = @($RunWsl, 'and keep that Ubuntu terminal open while you use the app.')
    if (-not $mirrored) { $help = @("Set networkingMode=mirrored under [wsl2] in $wslConfig, run wsl --shutdown, then:") + $help }
    Miss 'backend' ('not responding: ' + ($down -join ', ')) $help
}

# The app: built here (-Build or an existing build) or downloaded.
$appFrom = ''
if ($Build) {
    $m = Select-String -Path (Join-Path $Repo 'apps\desktop\src-tauri\Cargo.toml') -Pattern '^rust-version\s*=\s*"(.*)"' | Select-Object -First 1
    $rustWant = if ($m) { $m.Matches[0].Groups[1].Value } else { '' }
    if (Get-Command rustc.exe -ErrorAction SilentlyContinue) {
        $v = ((& rustc.exe --version) -split ' ')[1]
        if (-not $rustWant -or (Test-Version $v $rustWant)) { Ok 'rust' $v } else { Miss 'rust' "found $v, need $rustWant or later" @('rustup update stable') }
    } else { Miss 'rust' "need $rustWant or later (MSVC)" @('https://rustup.rs') }
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if ((Test-Path $vswhere) -and (& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)) { Ok 'msvc' 'C++ build tools' }
    else { Miss 'msvc' 'Visual Studio Build Tools with the C++ workload' @('https://visualstudio.microsoft.com/visual-cpp-build-tools/') }
    if ((Test-Path 'C:\Strawberry\perl\bin\perl.exe') -or (Get-Command perl.exe -ErrorAction SilentlyContinue)) { Ok 'perl' 'Strawberry Perl' }
    else { Miss 'perl' 'needed to build the encrypted database' @('https://strawberryperl.com') }
    if ($wslRepo -and -not (Test-Path (Join-Path $wslRepo 'vendor\base-styles\packages\styles'))) {
        Miss 'base-styles' "not in $WslDir" @($RunWsl)
    }
    $appFrom = 'build'
} elseif (Test-Path $BuiltExe) {
    Ok 'app' "built here on $((Get-Item $BuiltExe).LastWriteTime.ToString('yyyy-MM-dd HH:mm')): $BuiltExe (-Build to build it again)"
    $appFrom = 'built'
} elseif (Test-AppHash $DownloadedExe) {
    Ok 'app' "downloaded before: $DownloadedExe"
    $appFrom = 'downloaded'
} elseif ($AppSha256 -eq 'TO_BE_FILLED_AT_RELEASE') {
    Miss 'app' 'no prebuilt app is pinned in this version' @('Build it here instead: npm run demo:windows -- -Build')
} else {
    Write-Host ('  FETCH    {0,-14} {1}' -f 'app', "$AppUrl (checked by SHA-256)")
    $appFrom = 'download'
}

if ($script:Missing -gt 0) {
    Write-Host "$($script:Missing) prerequisite(s) missing. Install them and run this again. Nothing was changed."
    exit 1
}
Write-Host '      All prerequisites present.'
if ($Check) { exit 0 }

# ---------- 2. Dependencies ----------
$lock = Join-Path $Repo 'package-lock.json'
$installed = Join-Path $Repo 'node_modules\.package-lock.json'
if (-not (Test-Path $installed) -or (Get-Item $lock).LastWriteTime -gt (Get-Item $installed).LastWriteTime) {
    Write-Host '[2/4] Installing dependencies (npm ci)'
    Push-Location $Repo
    & npm.cmd ci
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -ne 0) { exit 1 }
} else {
    Write-Host '[2/4] Dependencies already installed'
}

# ---------- 3. Contracts and app ----------
# Files only from the WSL copy: git is never run on the \\wsl.localhost path.
function Copy-Mirror([string]$From, [string]$To) {
    & robocopy.exe $From $To /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { Write-Host "ERROR: could not copy $From to $To (robocopy $LASTEXITCODE)."; exit 1 }
}
Write-Host '[3/4] Copying the compiled contracts from the WSL copy'
Copy-Mirror (Join-Path $wslRepo 'contracts\managed') (Join-Path $Repo 'contracts\managed')

switch ($appFrom) {
    'build' {
        Write-Host '      Building the app (the first build takes several minutes)'
        Copy-Mirror (Join-Path $wslRepo 'vendor\base-styles') (Join-Path $Repo 'vendor\base-styles')
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Repo 'tools\dev\build.ps1')
        if ($LASTEXITCODE -ne 0) { exit 1 }
        $exe = $BuiltExe
    }
    'built' { Write-Host '      Using the app built here (-Build to build it again)'; $exe = $BuiltExe }
    'downloaded' { Write-Host '      Using the app downloaded before'; $exe = $DownloadedExe }
    'download' {
        Write-Host "      Downloading the app from $AppUrl"
        New-Item -ItemType Directory -Force (Split-Path $DownloadedExe) | Out-Null
        $tmp = "$DownloadedExe.part"
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            $ProgressPreference = 'SilentlyContinue'
            Invoke-WebRequest -Uri $AppUrl -OutFile $tmp -UseBasicParsing -ErrorAction Stop
        } catch {
            Remove-Item $tmp -Force -ErrorAction SilentlyContinue
            Write-Host "ERROR: download failed: $($_.Exception.Message). Or build it here: npm run demo:windows -- -Build"
            exit 1
        }
        $got = (Get-FileHash $tmp -Algorithm SHA256).Hash
        if ($got -ne $AppSha256) {
            Remove-Item $tmp -Force -ErrorAction SilentlyContinue
            Write-Host "ERROR: the downloaded app does not match the pinned SHA-256 (got $got). It was deleted."
            exit 1
        }
        try {
            Move-Item $tmp $DownloadedExe -Force -ErrorAction Stop
        } catch {
            Remove-Item $tmp -Force -ErrorAction SilentlyContinue
            Write-Host "ERROR: could not replace $DownloadedExe (is the app open?): $($_.Exception.Message)"
            exit 1
        }
        $exe = $DownloadedExe
    }
}

# Never launch a downloaded app that does not match the pinned hash.
if ($exe -eq $DownloadedExe -and -not (Test-AppHash $exe)) {
    Write-Host "ERROR: $exe does not match the pinned SHA-256. Delete it and run this again."
    exit 1
}

# ---------- 4. Window ----------
Write-Host '[4/4] Opening the window'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Repo 'tools\dev\window.ps1') $Perfil -WslRepo $wslRepo -Distro $Distro -Bin $exe
exit $LASTEXITCODE
