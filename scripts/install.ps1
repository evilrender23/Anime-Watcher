<#
  Instalador de Anime Watcher para Windows.

  Uso rápido (PowerShell):
    irm https://raw.githubusercontent.com/evilrender23/Anime-Watcher/main/scripts/install.ps1 | iex

  Con opciones:
    & ([scriptblock]::Create((irm https://raw.githubusercontent.com/evilrender23/Anime-Watcher/main/scripts/install.ps1))) -FromSource
    & ([scriptblock]::Create((irm https://raw.githubusercontent.com/evilrender23/Anime-Watcher/main/scripts/install.ps1))) -NoLaunch

  Desde un archivo local o un clon del repositorio:
    powershell -ExecutionPolicy Bypass -File scripts\install.ps1
    powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -FromSource
    powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -SourceDir .

  Opciones:
    -FromSource   Compila desde el código fuente de la rama main en lugar de descargar
                  la última versión publicada (también: $env:ANIME_WATCHER_FROM_SOURCE = '1').
    -SourceDir    Compila desde una copia local ya descargada (no se borra al terminar).
    -NoLaunch     No abre la aplicación al terminar.

  Si no hay ninguna versión publicada para tu equipo, o falla la descarga, se compila
  automáticamente desde el código fuente (instalando Node.js, Rust y las Build Tools con winget).

  Compatible con Windows PowerShell 5.1 y PowerShell 7.
#>
[CmdletBinding()]
param(
    [switch]$FromSource,
    [string]$SourceDir,
    [switch]$NoLaunch
)

# Windows PowerShell 5.1 lee los .ps1 sin BOM como ANSI y estropea las tildes;
# al ejecutarlo como archivo se vuelve a cargar leyéndolo como UTF-8.
# (El archivo no lleva BOM porque rompería "irm ... | iex".)
if ($PSCommandPath -and $PSVersionTable.PSVersion.Major -lt 6) {
    $AnimeWatcherRunAsFile = $true
    & ([scriptblock]::Create([IO.File]::ReadAllText($PSCommandPath, [Text.Encoding]::UTF8))) @PSBoundParameters
    exit 0
}
$AnimeWatcherExitOnError = [bool]$PSCommandPath -or (Test-Path Variable:AnimeWatcherRunAsFile)

# Todo se ejecuta en un ámbito propio para no alterar la sesión de quien lo lanza con iex.
& {
    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $Repo = 'evilrender23/Anime-Watcher'
    $ApiUrl = "https://api.github.com/repos/$Repo/releases/latest"
    $SourceZipUrl = "https://github.com/$Repo/archive/refs/heads/main.zip"
    $AppName = 'Anime Watcher'
    $UserAgent = 'anime-watcher-installer'

    function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
    function Write-Ok([string]$Message) { Write-Host "    $Message" -ForegroundColor Green }
    function Write-Note([string]$Message) { Write-Host "    $Message" -ForegroundColor Yellow }

    function Get-Arch {
        $arch = $env:PROCESSOR_ARCHITEW6432
        if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
        switch ($arch) {
            'AMD64' { return 'x64' }
            'ARM64' { return 'arm64' }
            default { throw "Arquitectura no compatible: $arch (se necesita Windows de 64 bits)." }
        }
    }

    function Save-Url([string]$Url, [string]$Path) {
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $Url -OutFile $Path -UseBasicParsing -Headers @{ 'User-Agent' = $UserAgent }
    }

    # Devuelve el instalador publicado para esta arquitectura o $null si no hay.
    function Get-ReleaseAsset([string]$Arch) {
        try {
            $release = Invoke-RestMethod -Uri $ApiUrl -UseBasicParsing -Headers @{ 'User-Agent' = $UserAgent; 'Accept' = 'application/vnd.github+json' }
        } catch {
            $response = $null
            if ($_.Exception.PSObject.Properties['Response']) { $response = $_.Exception.Response }
            if ($response -and [int]$response.StatusCode -eq 404) {
                Write-Note 'Todavía no hay ninguna versión publicada.'
            } else {
                Write-Note "No se pudo consultar la última versión: $($_.Exception.Message)"
            }
            return $null
        }
        $suffix = "_$Arch-setup.exe"
        $asset = @($release.assets | Where-Object { $_.name.EndsWith($suffix, [StringComparison]::OrdinalIgnoreCase) }) | Select-Object -First 1
        if (-not $asset) {
            Write-Note "La versión $($release.tag_name) no incluye un instalador para Windows $Arch."
            return $null
        }
        return [pscustomobject]@{ Name = $asset.name; Url = $asset.browser_download_url; Version = $release.tag_name }
    }

    function Install-Setup([string]$SetupPath) {
        Write-Step "Instalando $AppName..."
        $process = Start-Process -FilePath $SetupPath -ArgumentList '/S' -Wait -PassThru
        if ($process.ExitCode -ne 0) { throw "El instalador terminó con el código $($process.ExitCode)." }
        Write-Ok 'Instalación completada.'
    }

    # Descarga el instalador publicado. Devuelve $false si hay que recurrir al código fuente.
    function Install-FromRelease([string]$Arch, [string]$TempDir) {
        Write-Step 'Buscando la última versión publicada...'
        $asset = Get-ReleaseAsset $Arch
        if (-not $asset) { return $false }
        Write-Step "Descargando $($asset.Name) ($($asset.Version))..."
        $setup = Join-Path $TempDir $asset.Name
        try {
            Save-Url $asset.Url $setup
        } catch {
            Write-Note "No se pudo descargar el instalador: $($_.Exception.Message)"
            return $false
        }
        Install-Setup $setup
        return $true
    }

    function Get-SourceTree([string]$TempDir) {
        Write-Step 'Descargando el código fuente (rama main)...'
        $zip = Join-Path $TempDir 'source.zip'
        Save-Url $SourceZipUrl $zip
        $extractDir = Join-Path $TempDir 'source'
        Expand-Archive -LiteralPath $zip -DestinationPath $extractDir -Force
        $tree = Get-ChildItem -LiteralPath $extractDir -Directory | Select-Object -First 1
        if (-not $tree) { throw 'El archivo del código fuente está vacío.' }
        return $tree.FullName
    }

    function Get-BundleDir([string]$Tree) {
        $srcTauri = Join-Path $Tree 'src-tauri'
        $target = Join-Path $srcTauri 'target'
        if ($env:CARGO_TARGET_DIR) {
            if ([IO.Path]::IsPathRooted($env:CARGO_TARGET_DIR)) { $target = $env:CARGO_TARGET_DIR }
            else { $target = Join-Path $srcTauri $env:CARGO_TARGET_DIR }
        }
        return Join-Path $target 'release\bundle\nsis'
    }

    function Install-FromSourceTree([string]$Tree) {
        $buildScript = Join-Path $Tree 'scripts\build.ps1'
        if (-not (Test-Path -LiteralPath $buildScript)) { throw "No se encontró $buildScript" }
        Write-Step 'Compilando desde el código fuente (puede tardar bastante la primera vez)...'
        # Proceso aparte: así un "exit" del script de compilación no cierra este instalador.
        $powershellExe = (Get-Process -Id $PID).Path
        & $powershellExe -NoProfile -ExecutionPolicy Bypass -File $buildScript -InstallDeps -Bundles nsis
        if ($LASTEXITCODE -ne 0) { throw "La compilación falló (código $LASTEXITCODE)." }
        $bundleDir = Get-BundleDir $Tree
        $setup = Get-ChildItem -Path (Join-Path $bundleDir '*-setup.exe') -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if (-not $setup) { throw "No se encontró el instalador compilado en $bundleDir" }
        Install-Setup $setup.FullName
    }

    function Get-RegistryValue($Item, [string]$Name) {
        $property = $Item.PSObject.Properties[$Name]
        if ($property) { return [string]$property.Value }
        return ''
    }

    function Find-InstalledExe {
        $installDirs = @()
        $keys = Get-ChildItem -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue
        foreach ($key in $keys) {
            $entry = Get-ItemProperty -LiteralPath $key.PSPath
            if ((Get-RegistryValue $entry 'DisplayName') -ne $AppName) { continue }
            $icon = (Get-RegistryValue $entry 'DisplayIcon') -replace '^"([^"]*)".*$', '$1' -replace ',\s*-?\d+$', ''
            if ($icon -and $icon.EndsWith('.exe') -and (Test-Path -LiteralPath $icon)) { return $icon }
            $location = (Get-RegistryValue $entry 'InstallLocation').Trim('"')
            if ($location) { $installDirs += $location }
        }
        $installDirs += (Join-Path $env:LOCALAPPDATA $AppName)
        foreach ($dir in $installDirs) {
            if (-not (Test-Path -LiteralPath $dir)) { continue }
            $exe = Get-ChildItem -LiteralPath $dir -Filter '*.exe' | Where-Object { $_.Name -ne 'uninstall.exe' } | Select-Object -First 1
            if ($exe) { return $exe.FullName }
        }
        return $null
    }

    function Show-LegacyNotice {
        if (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'anicli-es\uninstall.exe')) {
            Write-Host ''
            Write-Note 'Se ha detectado la versión anterior "anicli-es". Puedes desinstalarla desde'
            Write-Note 'Configuración > Aplicaciones: Anime Watcher migra tu historial y tus ajustes'
            Write-Note 'automáticamente la primera vez que se abre.'
        }
    }

    function Start-App {
        $exe = Find-InstalledExe
        if (-not $exe) {
            Write-Note "No se encontró el ejecutable; abre $AppName desde el menú Inicio."
            return
        }
        Write-Step "Abriendo $AppName..."
        Start-Process -FilePath $exe
    }

    function Install-AnimeWatcher {
        $arch = Get-Arch
        Write-Host "Instalador de $AppName para Windows ($arch)" -ForegroundColor Magenta
        if ($SourceDir) {
            $tree = (Resolve-Path -LiteralPath $SourceDir).ProviderPath
            Install-FromSourceTree $tree
        } else {
            $tempDir = Join-Path ([IO.Path]::GetTempPath()) ('anime-watcher-install-' + [guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $tempDir | Out-Null
            try {
                $forced = $FromSource -or ($env:ANIME_WATCHER_FROM_SOURCE -eq '1')
                $installed = $false
                if (-not $forced) { $installed = Install-FromRelease $arch $tempDir }
                if (-not $installed) {
                    if (-not $forced) { Write-Note 'Se compilará desde el código fuente.' }
                    Install-FromSourceTree (Get-SourceTree $tempDir)
                }
            } finally {
                Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
                if (Test-Path -LiteralPath $tempDir) { Write-Note "No se pudo borrar la carpeta temporal $tempDir" }
            }
        }
        Show-LegacyNotice
        if (-not $NoLaunch) { Start-App }
        Write-Host ''
        Write-Host "¡Listo! $AppName está instalado." -ForegroundColor Green
    }

    try {
        Install-AnimeWatcher
    } catch {
        Write-Host ''
        Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
        if ($AnimeWatcherExitOnError) { exit 1 }
    }
}
