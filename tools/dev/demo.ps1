# One command on Windows from a fresh clone to an open NightMail window. Needs Node.js 24 and Docker Desktop.
#
#   npm run demo:windows                  # or: powershell -ExecutionPolicy Bypass -File tools\dev\demo.ps1
#   npm run demo:windows -- -Check        # only check the prerequisites, change nothing
#   npm run demo:windows -- -Build        # build the app here instead of downloading it
#   npm run demo:windows -- -Wsl          # use the backend started in WSL by tools/dev/demo-wsl.sh instead
#   options: [-Perfil <profile>] [-RepoRoot <folder>], and with -Wsl: [-WslDir <linux folder>] [-Distro <name>]
#
# Checks every prerequisite first and stops before changing anything if one is missing. Then: npm ci
# (when needed), starts the local network and the backend in Docker (infra/devnet and infra/backend:
# the first run builds the backend image and compiles the contracts, which takes minutes, and deploys
# the contracts once), copies the compiled contracts and the backend details the app needs out of the
# containers, gets the app (the one built here, a fresh build with -Build, or the pinned release
# download, checked by its SHA-256) and opens it with window.ps1. Running it again reuses everything
# and never opens a second window. -RepoRoot (default: this checkout) is meant for testing with -Check.
param(
    [switch]$Check,
    [switch]$Build,
    [switch]$Wsl,
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
$Steps = if ($Wsl) { 4 } else { 5 }

# Docker: the local network (infra/devnet) and the backend (infra/backend), with what the app needs copied
# out of them into .data\dev\docker.
$DevnetCompose = Join-Path $Repo 'infra\devnet\docker-compose.yml'
$BackendCompose = Join-Path $Repo 'infra\backend\docker-compose.yml'
$DockerState = Join-Path $Repo '.data\dev\docker'
$ServerContainer = 'nightmail-backend-server'
# Compose 2.7.0 made `up --wait` accept a one-shot service that exits 0 (docker/compose#9572) and 2.17.0
# added --wait-timeout (docker/compose#10276), per the docker/compose release notes on GitHub.
$ComposeWant = '2.17.0'

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

# Ports (string keys) that answer on 127.0.0.1.
function Get-OpenPorts([string[]]$List) {
    $open = @()
    foreach ($p in $List) {
        $c = New-Object System.Net.Sockets.TcpClient
        try {
            $iar = $c.BeginConnect('127.0.0.1', [int]$p, $null, $null)
            if ($iar.AsyncWaitHandle.WaitOne(1500) -and $c.Connected) { $open += $p }
        } catch {
        } finally {
            $c.Close()
        }
    }
    return $open
}

# Docker Desktop answers (the docker CLI reaches its engine).
function Test-DockerUp {
    & docker.exe info --format '{{.ServerVersion}}' *> $null
    return $LASTEXITCODE -eq 0
}

function Get-DockerDesktopExe {
    $candidates = @((Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'), (Join-Path $env:LOCALAPPDATA 'Programs\Docker\Docker\Docker Desktop.exe'))
    return $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}

# Right after installing Docker Desktop, a terminal opened before may not have docker.exe on PATH yet.
# Docker Desktop ships it in resources\bin: add that folder for this run (window.ps1 inherits it).
if (-not $Wsl -and -not (Get-Command docker.exe -ErrorAction SilentlyContinue)) {
    $desktopExe = Get-DockerDesktopExe
    if ($desktopExe) {
        $dockerBin = Join-Path (Split-Path $desktopExe) 'resources\bin'
        if (Test-Path (Join-Path $dockerBin 'docker.exe')) { $env:PATH = "$dockerBin;$env:PATH" }
    }
}

# Compose version problem, or '' if it is recent enough.
function Get-ComposeProblem {
    $cv = (& docker.exe compose version --short 2>$null | Out-String).Trim().TrimStart('v') -replace '-.*$', ''
    if (-not $cv) { return 'the compose plugin is missing' }
    if (-not (Test-Version $cv $ComposeWant)) { return "Compose $cv, need $ComposeWant or later" }
    return ''
}

# State of a container ('' if it does not exist).
function Get-ContainerState([string]$Name) {
    $s = (& docker.exe inspect --format '{{.State.Status}}' $Name 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { return '' }
    return $s
}

# Fingerprint of everything the backend image is built from (the paths Dockerfile.dockerignore lets in).
# Compose recreates the containers after every build, even an unchanged one, so the image is only built
# again when this changes.
function Get-BackendInputs {
    $ignore = Join-Path $Repo 'infra\backend\Dockerfile.dockerignore'
    $paths = @('infra\backend\Dockerfile', 'infra\backend\Dockerfile.dockerignore') +
        @(Get-Content $ignore | Where-Object { $_ -like '!*' } | ForEach-Object { $_.Substring(1) -replace '/', '\' })
    $lines = foreach ($p in $paths) {
        $full = Join-Path $Repo $p
        $files = if (Test-Path $full -PathType Container) { Get-ChildItem $full -Recurse -File | Sort-Object FullName } else { Get-Item $full -ErrorAction SilentlyContinue }
        foreach ($f in $files) { "$($f.FullName.Substring($Repo.Length)) $((Get-FileHash $f.FullName -Algorithm SHA256).Hash)" }
    }
    $bytes = [Text.Encoding]::UTF8.GetBytes(($lines -join "`n"))
    return [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($bytes)) -replace '-', ''
}

# ---------- 1. Prerequisites ----------
Write-Host "[1/$Steps] Checking prerequisites"
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

$wslRepo = ''
$startDocker = $false
if ($Wsl) {
    # WSL, the distribution (the default one unless -Distro) and the Linux copy made by demo-wsl.sh.
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
} else {
    # Docker Desktop with Compose. If it is installed but stopped, the full run starts it.
    if (-not (Get-Command docker.exe -ErrorAction SilentlyContinue)) {
        Miss 'docker' 'Docker Desktop is not installed' @('https://docs.docker.com/desktop/setup/install/windows-install/')
    } elseif (Test-DockerUp) {
        $problem = Get-ComposeProblem
        if ($problem) { Miss 'docker' $problem @('Update Docker Desktop') }
        else { Ok 'docker' "$((& docker.exe version --format '{{.Server.Version}}' 2>$null | Out-String).Trim()), compose $((& docker.exe compose version --short 2>$null | Out-String).Trim())" }
    } elseif (Get-DockerDesktopExe) {
        Write-Host ('  START    {0,-14} {1}' -f 'docker', 'Docker Desktop is not running, the full run starts it')
        $startDocker = $true
    } else {
        Miss 'docker' 'installed but not responding' @('Start Docker Desktop and run this again')
    }

    # The backend ports must be free unless our backend already holds them (another backend, such as the
    # one of tools/dev/up.sh in WSL, would make Docker fail to publish them).
    if (-not $startDocker -and $script:Missing -eq 0 -and (Get-ContainerState $ServerContainer) -ne 'running') {
        $busy = @(Get-OpenPorts @('2525', '8787', '8788', '8789'))
        if ($busy.Count -gt 0) {
            Miss 'ports' "already in use by another program: $($busy -join ', ')" @(
                'Are the payer and mail server of tools/dev/up.sh running in WSL? Stop them there with:',
                'bash tools/dev/down.sh   (or use that backend instead: npm run demo:windows -- -Wsl)')
        } else {
            Ok 'ports' '2525, 8787, 8788 and 8789 are free'
        }
    }
}

# WebView2 runtime (Evergreen): per machine or per user.
$wv2Id = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
$wv2 = @("HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$wv2Id", "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$wv2Id", "HKCU:\Software\Microsoft\EdgeUpdate\Clients\$wv2Id") |
    ForEach-Object { (Get-ItemProperty $_ -Name pv -ErrorAction SilentlyContinue).pv } | Where-Object { $_ -and $_ -ne '0.0.0.0' } | Select-Object -First 1
if ($wv2) { Ok 'webview2' $wv2 } else { Miss 'webview2' '' @('https://developer.microsoft.com/microsoft-edge/webview2/ (Evergreen runtime)') }

if ($Wsl) {
    # Backend ports as seen from Windows (WSL ports reach 127.0.0.1 with mirrored networking).
    $open = @(Get-OpenPorts @($Ports.Keys))
    $down = @($Ports.Keys | Where-Object { $open -notcontains $_ } | ForEach-Object { "$($Ports[$_]) ($_)" })
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
    if ($Wsl) {
        if ($wslRepo -and -not (Test-Path (Join-Path $wslRepo 'vendor\base-styles\packages\styles'))) {
            Miss 'base-styles' "not in $WslDir" @($RunWsl)
        }
    } elseif (-not (Test-Path (Join-Path $Repo 'vendor\base-styles\packages\styles'))) {
        Miss 'base-styles' 'vendor\base-styles is missing' @('With Git for Windows, in Git Bash: bash tools/vendor-base-styles.sh')
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
    Write-Host "[2/$Steps] Installing dependencies (npm ci)"
    Push-Location $Repo
    & npm.cmd ci
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -ne 0) { exit 1 }
} else {
    Write-Host "[2/$Steps] Dependencies already installed"
}

function Copy-Mirror([string]$From, [string]$To) {
    & robocopy.exe $From $To /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { Write-Host "ERROR: could not copy $From to $To (robocopy $LASTEXITCODE)."; exit 1 }
}

if ($Wsl) {
    # ---------- 3. Contracts from the WSL copy ----------
    # Files only from the WSL copy: git is never run on the \\wsl.localhost path.
    Write-Host '[3/4] Copying the compiled contracts from the WSL copy'
    Copy-Mirror (Join-Path $wslRepo 'contracts\managed') (Join-Path $Repo 'contracts\managed')
    # contracts\managed no longer holds the Docker image's copy: the Docker path must copy it again.
    Remove-Item (Join-Path $DockerState 'contracts-image.txt') -Force -ErrorAction SilentlyContinue
    if ($appFrom -eq 'build') { Copy-Mirror (Join-Path $wslRepo 'vendor\base-styles') (Join-Path $Repo 'vendor\base-styles') }
} else {
    # ---------- 3. Local network and backend in Docker ----------
    if ($startDocker) {
        Write-Host '      Starting Docker Desktop (up to 3 min)'
        Start-Process -FilePath (Get-DockerDesktopExe) | Out-Null
        $deadline = (Get-Date).AddMinutes(3)
        while (-not (Test-DockerUp) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 3 }
        if (-not (Test-DockerUp)) { Write-Host 'ERROR: Docker Desktop did not start in 3 min. Start it and run this again.'; exit 1 }
        $problem = Get-ComposeProblem
        if ($problem) { Write-Host "ERROR: $problem. Update Docker Desktop and run this again."; exit 1 }
        if ((Get-ContainerState $ServerContainer) -ne 'running' -and @(Get-OpenPorts @('2525', '8787', '8788', '8789')).Count -gt 0) {
            Write-Host 'ERROR: ports 2525, 8787, 8788 or 8789 are in use by another program. Run npm run demo:windows -- -Check to see which.'
            exit 1
        }
    }
    Write-Host '[3/5] Starting the local network and the backend in Docker, and waiting until they are healthy'
    Write-Host '      (the first run builds the backend image, compiles the contracts and deploys them: several minutes)'
    & docker.exe compose -f $DevnetCompose up -d --wait
    if ($LASTEXITCODE -ne 0) { Write-Host "ERROR: the local network did not become healthy. See: docker compose -f infra\devnet\docker-compose.yml ps"; exit 1 }
    New-Item -ItemType Directory -Force $DockerState | Out-Null
    $inputs = Get-BackendInputs
    $inputsFile = Join-Path $DockerState 'image-inputs.txt'
    & docker.exe image inspect nightmail-backend:local *> $null
    $haveImage = $LASTEXITCODE -eq 0
    # Built in its own step, and recorded as soon as the build succeeds: if the start below is interrupted, the
    # next run does not build again (Compose would recreate the containers and kill a deployment in flight).
    if (-not $haveImage -or (Get-Content $inputsFile -ErrorAction SilentlyContinue | Select-Object -First 1) -ne $inputs) {
        Write-Host '      Building the backend image'
        & docker.exe compose -f $BackendCompose build
        if ($LASTEXITCODE -ne 0) { Write-Host 'ERROR: the backend image did not build. See the messages above.'; exit 1 }
        Set-Content -Path $inputsFile -Value $inputs -Encoding ascii
    }
    & docker.exe compose -f $BackendCompose up -d --wait --wait-timeout 2400
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'ERROR: the backend did not become healthy. Its last log lines:'
        & docker.exe compose -f $BackendCompose logs --no-color --tail 25 deploy payer server
        Write-Host 'Full logs: docker compose -f infra\backend\docker-compose.yml logs'
        exit 1
    }

    # ---------- 4. What the app needs from the backend ----------
    Write-Host '[4/5] Copying the compiled contracts and the backend details out of Docker'
    # The compiled contracts come from the image (the same ones the backend deployed). Copied again only
    # when the image changes.
    $image = (& docker.exe inspect --format '{{.Image}}' $ServerContainer 2>$null | Out-String).Trim()
    $marker = Join-Path $DockerState 'contracts-image.txt'
    $managed = Join-Path $Repo 'contracts\managed'
    if (-not $image) { Write-Host "ERROR: could not inspect the container $ServerContainer."; exit 1 }
    if ((Test-Path (Join-Path $managed 'token\contract\index.js')) -and (Get-Content $marker -ErrorAction SilentlyContinue | Select-Object -First 1) -eq $image) {
        Write-Host '      Compiled contracts already copied'
    } else {
        $tmp = Join-Path $DockerState 'managed.tmp'
        Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
        & docker.exe cp "${ServerContainer}:/app/contracts/managed" $tmp
        if ($LASTEXITCODE -ne 0) { Write-Host 'ERROR: could not copy the compiled contracts out of the backend container.'; exit 1 }
        Copy-Mirror $tmp $managed
        Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
        Set-Content -Path $marker -Value $image -Encoding ascii
    }
    # contracts.json (public contract addresses), from the backend volume.
    $contractsFile = Join-Path $DockerState 'contracts.json'
    & docker.exe cp "${ServerContainer}:/app/.data/operator/undeployed/contracts.json" $contractsFile
    if ($LASTEXITCODE -ne 0) { Write-Host 'ERROR: could not copy contracts.json out of the backend container.'; exit 1 }
    # The receipt key fingerprint (public), from the mail server's log of this start, or computed from the key in
    # the backend volume if that line is no longer in the log.
    $keyLine = & docker.exe logs $ServerContainer 2>&1 | Select-String -Pattern 'receipt key (sha256:[0-9a-f]+)' | Select-Object -Last 1
    $key = if ($keyLine) { $keyLine.Matches[0].Groups[1].Value } else { (& docker.exe exec $ServerContainer node infra/backend/receipt-key.mjs 2>$null | Out-String).Trim() }
    if ($key -notmatch '^sha256:[0-9a-f]{64}$') { Write-Host "ERROR: could not get the issuer's receipt key. See: docker logs $ServerContainer"; exit 1 }
    Set-Content -Path (Join-Path $DockerState 'run.env') -Value "NIGHTMAIL_ISSUER_RECEIPT_KEY=$key" -Encoding ascii
}

switch ($appFrom) {
    'build' {
        Write-Host '      Building the app (the first build takes several minutes)'
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

# ---------- Last step: window ----------
Write-Host "[$Steps/$Steps] Opening the window"
$window = Join-Path $Repo 'tools\dev\window.ps1'
if ($Wsl) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $window $Perfil -WslRepo $wslRepo -Distro $Distro -Bin $exe
} else {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $window $Perfil -Docker -Bin $exe
}
exit $LASTEXITCODE
