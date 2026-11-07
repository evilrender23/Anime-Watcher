#!/bin/bash
# Instala o actualiza Anime Watcher en Mac o en Linux compilándolo desde una rama del repositorio
# (main por defecto). Es el equivalente de instalar.ps1.
#
#   git clone https://github.com/evilrender23/Anime-Watcher
#   bash Anime-Watcher/instalar.sh [--repo URL|RUTA] [--rama main] [--destino CARPETA] [--bin CARPETA]
#
# O en una línea:
#   curl -fsSL https://raw.githubusercontent.com/evilrender23/Anime-Watcher/main/instalar.sh | bash
#
# Desde un clon, sin --repo, instala desde el origin de ese clon.
#
# En <destino> (por defecto ~/Library/Application Support/AnimeWatcher en Mac y
# ~/.local/share/AnimeWatcher en Linux) deja:
#   codigo/    el clon, con node_modules y la caché de cargo (src-tauri/target/) para que la
#              siguiente compilación sea rápida;
#   app/       la app (Mac: Anime Watcher.app; Linux: anime-watcher) y version.json (commit, fecha,
#              rama, repo);
#   registro/  actualizacion.log, con las líneas que lee la app (PASO n/total, LISTO, APLICADO,
#              ERROR), y compilacion.log, con la salida de git, npm y cargo.
# En Mac crea ~/Applications/Anime Watcher.app (abre la de app/); en Linux, enlaza `anime-watcher`
# en --bin (por defecto ~/.local/bin) y crea un lanzador en el menú de aplicaciones.
#
# Pregunta antes de instalar lo que falte: Mac, las herramientas de línea de comandos de Xcode;
# Linux, un compilador de C, git, curl, pkg-config y WebKitGTK (con el gestor de paquetes y sudo);
# los dos, Rust. Node.js (dependencia para compilar la interfaz) se instala sin preguntar, avisando,
# en <destino>/node si el sistema no tiene uno de 20.19 o más nuevo.
#
# Actualizaciones: la app lo relanza con --actualizar --esperar-pid <su pid> --relanzar. Así no
# pregunta ni instala requisitos, compila en app.nuevo, escribe LISTO y, cuando la app se cierra,
# cambia app/ por la versión nueva y la vuelve a abrir.

set -uo pipefail

case "$(uname -s)" in
    Darwin) LINUX=false ;;
    Linux) LINUX=true ;;
    *) echo "Este instalador es para Mac y Linux; en Windows, usa instalar.ps1." >&2; exit 2 ;;
esac

REPO='https://github.com/evilrender23/Anime-Watcher'
RAMA='main'
if $LINUX; then DESTINO="${XDG_DATA_HOME:-$HOME/.local/share}/AnimeWatcher"; else DESTINO="$HOME/Library/Application Support/AnimeWatcher"; fi
BIN="$HOME/.local/bin"
REPO_INDICADO=false
ACTUALIZAR=false
ESPERAR_PID=0
RELANZAR=false
NOMBRE_APP='Anime Watcher'
BINARIO='anime-watcher'

while [ $# -gt 0 ]; do
    case "$1" in
        --repo) REPO="$2"; REPO_INDICADO=true; shift 2 ;;
        --rama) RAMA="$2"; shift 2 ;;
        --destino) DESTINO="$2"; shift 2 ;;
        --bin) BIN="$2"; shift 2 ;;
        --actualizar) ACTUALIZAR=true; shift ;;
        --esperar-pid) ESPERAR_PID="$2"; shift 2 ;;
        --relanzar) RELANZAR=true; shift ;;
        -h|--help) sed -n '2,31p' "${BASH_SOURCE[0]:-/dev/null}" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Opción desconocida: $1" >&2; exit 2 ;;
    esac
done

INTERACTIVO=true
$ACTUALIZAR && INTERACTIVO=false
# Sin nadie delante, git no debe quedarse esperando credenciales: mejor que falle y lo diga.
$ACTUALIZAR && export GIT_TERMINAL_PROMPT=0

# Lanzado desde la app (o desde el menú), el PATH no trae lo de la terminal.
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cargar_nvm() {
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    [ -s "$NVM_DIR/nvm.sh" ] || return 1
    # shellcheck source=/dev/null
    . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
}

# Ejecutado desde un clon de Anime Watcher y sin --repo: el mismo repositorio (un fork, una copia local).
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    PROPIO=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
    if ! $REPO_INDICADO && [ -f "$PROPIO/src-tauri/tauri.conf.json" ] && command -v git >/dev/null 2>&1; then
        ORIGEN=$(git -C "$PROPIO" remote get-url origin 2>/dev/null) && [ -n "$ORIGEN" ] && REPO="$ORIGEN"
    fi
fi

CODIGO="$DESTINO/codigo"
APP="$DESTINO/app"
NUEVO="$DESTINO/app.nuevo"
REGISTRO="$DESTINO/registro"
LOG="$REGISTRO/compilacion.log"
ESTADO="$REGISTRO/actualizacion.log"
ULTIMA="$REGISTRO/ultima-salida.log"
CERROJO="$REGISTRO/instalar.lock"
# La app lo deja si se cierra sin aplicar la actualización: se cambia de versión, pero no se abre.
NO_RELANZAR="$REGISTRO/no-relanzar"
# Carpetas de git, node, npm, cargo y rustc encontradas al instalar desde la terminal. Lanzado
# desde la app (abierta desde el Dock, el Finder o el menú) el PATH es el mínimo del sistema y no
# trae lo que añade la configuración de la terminal (nvm, ~/.cargo/bin, ~/.local/node/bin…).
RUTAS="$REGISTRO/rutas"
# Node.js propio (si el sistema no tiene uno válido): sólo hace falta para compilar.
NODE_PROPIO="$DESTINO/node"
NODE_SERIE='latest-v22.x'
TOTAL=7

cargar_rutas() {
    local d
    [ -f "$RUTAS" ] || return 0
    while IFS= read -r d; do
        [ -n "$d" ] && [ -d "$d" ] && case ":$PATH:" in *":$d:"*) ;; *) PATH="$d:$PATH" ;; esac
    done < "$RUTAS"
    export PATH
}
cargar_rutas
[ -x "$NODE_PROPIO/bin/node" ] && export PATH="$NODE_PROPIO/bin:$PATH"

anotar() { printf '%s\n' "$1" >> "$ESTADO"; }
paso() {
    anotar "PASO $1/$TOTAL $2"
    $INTERACTIVO && printf '\033[36m[%s/%s] %s\033[0m\n' "$1" "$TOTAL" "$2"
    return 0
}
fallar() {
    local texto
    texto=$(printf '%s' "$1" | tr '\n' ' ')
    anotar "ERROR $texto" 2>/dev/null
    $INTERACTIVO && printf '\033[31mERROR: %s\033[0m\n' "$texto" >&2
    exit 1
}
tiene() { command -v "$1" >/dev/null 2>&1; }

guardar_rutas() {
    local p ruta
    for p in git node npm cargo rustc; do
        ruta=$(command -v "$p" 2>/dev/null) || continue
        case "$ruta" in /*) dirname "$ruta" ;; esac
    done | awk '!visto[$0]++' > "$RUTAS.nuevo" && mv "$RUTAS.nuevo" "$RUTAS"
}

# ejecutar CARPETA PROGRAMA ARGUMENTOS…: la salida va a compilacion.log (y a la pantalla, atenuada).
ejecutar() {
    local carpeta=$1 resultado
    shift
    printf '> %s\n' "$*" >> "$LOG"
    if $INTERACTIVO; then
        (cd "$carpeta" && "$@") 2>&1 | tee "$ULTIMA" | tee -a "$LOG" | sed $'s/^/\033[2m/; s/$/\033[0m/'
        resultado=${PIPESTATUS[0]}
    else
        (cd "$carpeta" && "$@") > "$ULTIMA" 2>&1
        resultado=$?
        cat "$ULTIMA" >> "$LOG"
    fi
    return "$resultado"
}

# ---------------------------------------------------------------- requisitos

# Paquetes de desarrollo de WebKitGTK y compañía que pide Tauri 2 (https://v2.tauri.app/start/prerequisites/).
PM=''
PAQUETES=''
if $LINUX; then
    if tiene apt-get; then PM=apt; PAQUETES='build-essential curl wget file git pkg-config libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev'
    elif tiene dnf; then PM=dnf; PAQUETES='gcc gcc-c++ make curl wget file git pkgconf-pkg-config webkit2gtk4.1-devel openssl-devel libappindicator-gtk3-devel librsvg2-devel libxdo-devel'
    elif tiene pacman; then PM=pacman; PAQUETES='base-devel curl wget file git pkgconf webkit2gtk-4.1 openssl appmenu-gtk-module libappindicator-gtk3 librsvg xdotool'
    elif tiene zypper; then PM=zypper; PAQUETES='gcc gcc-c++ make curl wget file git pkg-config webkit2gtk3-devel libopenssl-devel libappindicator3-1 librsvg-devel'
    fi
fi

hay_xcode() { xcode-select -p >/dev/null 2>&1 && tiene git; }
hay_sistema() {
    tiene cc && tiene git && tiene curl && tiene pkg-config && pkg-config --exists webkit2gtk-4.1 2>/dev/null
}
hay_rust() { tiene cargo && tiene rustc && rustc --version >/dev/null 2>&1; }
# Vite 8 necesita Node.js ^20.19.0 o >=22.12.0.
hay_node() {
    local v mayor menor
    tiene node || cargar_nvm || return 1
    tiene npm || return 1
    v=$(node -p 'process.versions.node' 2>/dev/null) || return 1
    mayor=${v%%.*}; menor=${v#*.}; menor=${menor%%.*}
    case "$mayor$menor" in ''|*[!0-9]*) return 1 ;; esac
    [ "$mayor" -gt 22 ] || { [ "$mayor" -eq 22 ] && [ "$menor" -ge 12 ]; } || { [ "$mayor" -eq 20 ] && [ "$menor" -ge 19 ]; }
}

instalar_xcode() {
    xcode-select --install >/dev/null 2>&1
    echo 'Acepta la ventana de macOS que pide instalar las herramientas de línea de comandos; se espera a que acabe…'
    until hay_xcode; do sleep 5; done
}

# Los nombres de paquete no llevan espacios: se separan a propósito por palabras.
# shellcheck disable=SC2086
instalar_sistema() {
    case "$PM" in
        apt) sudo apt-get update && sudo apt-get install -y $PAQUETES ;;
        dnf) sudo dnf install -y $PAQUETES ;;
        pacman) sudo pacman -S --needed --noconfirm $PAQUETES ;;
        zypper) sudo zypper install -y $PAQUETES ;;
        *) fallar "No se reconoce el gestor de paquetes: instala a mano un compilador de C, git, curl, pkg-config y WebKitGTK 4.1 (https://v2.tauri.app/start/prerequisites/)." ;;
    esac
}

instalar_rust() {
    if tiene rustup; then
        ejecutar "$DESTINO" rustup default stable
    else
        ejecutar "$DESTINO" bash -c "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal"
    fi
}

# Node.js LTS oficial de nodejs.org en <destino>/node, con su SHA-256 comprobado. No usa sudo, brew
# ni nvm y no toca el sistema, así que también vale durante una actualización sin nadie delante.
instalar_node() {
    local so arq base sumas archivo tmp
    if $LINUX; then so=linux; else so=darwin; fi
    case "$(uname -m)" in
        x86_64|amd64) arq=x64 ;;
        arm64|aarch64) arq=arm64 ;;
        *) fallar "No hay Node.js oficial para $(uname -m): instálalo a mano (20.19+ o 22.12+) y vuelve a ejecutar el instalador." ;;
    esac
    base="https://nodejs.org/dist/$NODE_SERIE"
    sumas=$(curl -fsSL "$base/SHASUMS256.txt") || fallar 'No se pudo descargar la lista de Node.js de nodejs.org: revisa la conexión.'
    archivo=$(printf '%s\n' "$sumas" | awk -v f="-$so-$arq.tar.gz" '$2 ~ f"$" { print $2; exit }')
    [ -n "$archivo" ] || fallar "nodejs.org no tiene Node.js para $so-$arq."
    tmp=$(mktemp -d "${TMPDIR:-/tmp}/anime-watcher-node.XXXXXX") || fallar 'No se pudo crear una carpeta temporal.'
    ejecutar "$tmp" curl -fsSLo "$archivo" "$base/$archivo" || { rm -rf "$tmp"; fallar 'No se pudo descargar Node.js.'; }
    if ! (cd "$tmp" && printf '%s\n' "$sumas" | grep " $archivo\$" | shasum -a 256 -c - >/dev/null 2>&1); then
        rm -rf "$tmp"
        fallar 'El Node.js descargado no coincide con su SHA-256; no se instala.'
    fi
    ejecutar "$tmp" tar -xzf "$archivo" || { rm -rf "$tmp"; fallar 'No se pudo descomprimir Node.js.'; }
    rm -rf "$NODE_PROPIO"
    mv "$tmp/${archivo%.tar.gz}" "$NODE_PROPIO" || { rm -rf "$tmp"; fallar "No se pudo instalar Node.js en $NODE_PROPIO."; }
    rm -rf "$tmp"
    export PATH="$NODE_PROPIO/bin:$PATH"
}

# Node.js sólo se usa para compilar la interfaz: si falta, se instala sin preguntar, avisando.
asegurar_node() {
    hay_node && return 0
    local aviso="Node.js es una dependencia para compilar Anime Watcher y no se encontró (o es anterior a 20.19): se instala en $NODE_PROPIO"
    anotar "PASO 1/$TOTAL Instalando Node.js (dependencia necesaria para compilar)"
    $INTERACTIVO && printf '\033[33m%s\033[0m\n' "$aviso"
    printf '%s\n' "$aviso" >> "$LOG"
    instalar_node
    hay_node || fallar "Se instaló Node.js en $NODE_PROPIO, pero no funciona (detalles en $LOG)."
    $INTERACTIVO && printf '\033[32mNode.js %s instalado.\033[0m\n' "$(node --version)"
    return 0
}

# Node.js va aparte (asegurar_node): se instala sin preguntar.
if $LINUX; then REQUISITOS='sistema rust'; else REQUISITOS='xcode rust'; fi
nombre_de() {
    case "$1" in
        xcode) echo 'Herramientas de línea de comandos de Xcode (con Git)' ;;
        sistema) echo 'Compilador de C, Git, curl, pkg-config y WebKitGTK (con sudo)' ;;
        rust) echo 'Rust (rustup)' ;;
        node) echo 'Node.js 20.19+ o 22.12+' ;;
    esac
}
hay() { "hay_$1"; }

comprobar_requisitos() {
    local faltan='' nombres='' r respuesta si
    for r in $REQUISITOS; do
        hay "$r" || { faltan="$faltan $r"; nombres="$nombres${nombres:+, }$(nombre_de "$r")"; }
    done
    [ -z "$faltan" ] && return 0
    $INTERACTIVO || fallar "Falta $nombres (o no está en el PATH de la app). Vuelve a ejecutar el comando de instalación en una terminal."
    printf '\033[33mFalta: %s\033[0m\n' "$nombres"
    # Con `curl | bash` la entrada es el propio script: se pregunta en la terminal.
    printf '¿Instalarlo? [T]odo / [u]no a uno / [n]ada '
    read -r respuesta < /dev/tty
    respuesta=$(printf '%s' "$respuesta" | tr '[:upper:]' '[:lower:]' | tr -d ' ')
    for r in $faltan; do
        hay "$r" && continue
        case "$respuesta" in
            ''|t|todo|s|si|sí) si=true ;;
            u*)
                printf '¿Instalar %s? [S/n] ' "$(nombre_de "$r")"
                read -r si < /dev/tty
                case "$si" in [nN]*) si=false ;; *) si=true ;; esac ;;
            *) si=false ;;
        esac
        $si || fallar "Sin $(nombre_de "$r") no se puede compilar Anime Watcher."
        echo "Instalando $(nombre_de "$r")…"
        "instalar_$r"
        hay "$r" || fallar "Se instaló $(nombre_de "$r"), pero no aparece: abre una terminal nueva y vuelve a ejecutar el instalador."
    done
}

# ---------------------------------------------------------------- código

explicar_error_git() {
    if grep -qiE 'Authentication failed|Repository not found|could not read Username|(^|[^0-9])40[13]([^0-9]|$)' "$ULTIMA"; then
        fallar "Sin acceso a $1: hace falta permiso para ver el repositorio y haber iniciado sesión en GitHub con Git."
    fi
    if grep -qiE 'Could not resolve host|unable to access' "$ULTIMA"; then
        fallar "Sin conexión con $1."
    fi
    fallar "git falló con $1 (detalles en $LOG)"
}

descargar_codigo() {
    if [ -d "$CODIGO/.git" ]; then
        $REPO_INDICADO && ejecutar "$CODIGO" git remote set-url origin "$REPO"
        local origen
        origen=$(git -C "$CODIGO" remote get-url origin)
        ejecutar "$CODIGO" git fetch --prune origin "$RAMA" || explicar_error_git "$origen"
        ejecutar "$CODIGO" git checkout -B "$RAMA" "origin/$RAMA" || fallar "git checkout falló (detalles en $LOG)"
        ejecutar "$CODIGO" git reset --hard "origin/$RAMA" || fallar "git reset falló (detalles en $LOG)"
        # Sin -x: lo ignorado (node_modules/, src-tauri/target/) es la caché.
        ejecutar "$CODIGO" git clean -fd || fallar "git clean falló (detalles en $LOG)"
    else
        mkdir -p "$DESTINO"
        ejecutar "$DESTINO" git clone --branch "$RAMA" "$REPO" "$CODIGO" || explicar_error_git "$REPO"
    fi
}

json() { printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; }

# ---------------------------------------------------------------- accesos

crear_lanzador_linux() {
    local carpeta="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
    mkdir -p "$carpeta" || return 1
    cat > "$carpeta/anime-watcher.desktop" <<LANZADOR
[Desktop Entry]
Type=Application
Name=Anime Watcher
Comment=Ver animé subtitulado al español
Exec="$APP/$BINARIO"
Icon=$APP/icon.png
Terminal=false
Categories=AudioVideo;Video;Player;
StartupWMClass=anime-watcher
LANZADOR
    tiene update-desktop-database && update-desktop-database "$carpeta" >/dev/null 2>&1
    return 0
}

# Un .app mínimo en ~/Applications que abre la de app/ (así Launchpad y Spotlight la encuentran y
# la de verdad se puede cambiar sin tocar este acceso). Sin firma: macOS lo deja abrir porque se creó en local.
crear_app_mac() {
    local acceso="$HOME/Applications/$NOMBRE_APP.app" icono
    rm -rf "$acceso"
    mkdir -p "$acceso/Contents/MacOS" "$acceso/Contents/Resources" || return 1
    icono=$(find "$APP/$NOMBRE_APP.app/Contents/Resources" -maxdepth 1 -name '*.icns' 2>/dev/null | head -1)
    [ -n "$icono" ] && cp "$icono" "$acceso/Contents/Resources/icon.icns"
    cat > "$acceso/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>$NOMBRE_APP</string>
  <key>CFBundleIdentifier</key><string>com.evilrender23.animewatcher.acceso</string>
  <key>CFBundleExecutable</key><string>abrir</string>
  <key>CFBundleIconFile</key><string>icon.icns</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
</dict></plist>
PLIST
    printf '#!/bin/bash\nexec open "%s/%s.app" --args "$@"\n' "$APP" "$NOMBRE_APP" > "$acceso/Contents/MacOS/abrir"
    chmod +x "$acceso/Contents/MacOS/abrir"
}

# Restos del instalador anterior (basado en releases): el AppImage suelto.
limpiar_instalacion_antigua() {
    rm -f "$HOME/.local/bin/anime-watcher.AppImage"
}

# ---------------------------------------------------------------- actualizar

# La app que se lanzó desde esta instalación.
procesos_de_la_app() { pgrep -f -- "$APP/" >/dev/null 2>&1; }

esperar_pid() {
    if [ "$ESPERAR_PID" -gt 0 ] 2>/dev/null; then
        while kill -0 "$ESPERAR_PID" 2>/dev/null; do sleep 1; done
    fi
}

esperar_cierre() {
    local avisado=false
    esperar_pid
    while procesos_de_la_app; do
        if $INTERACTIVO && ! $avisado; then
            printf '\033[33mCierra Anime Watcher para terminar la instalación…\033[0m\n'
            avisado=true
        fi
        sleep 1
    done
}

abrir_app() {
    if $LINUX; then
        # Sin la terminal ni este script: sigue abierta cuando acaban.
        (cd "$HOME" && setsid "$APP/$BINARIO" >/dev/null 2>&1 < /dev/null &)
    else
        open "$APP/$NOMBRE_APP.app" >/dev/null 2>&1
    fi
}

limpiar() { rm -rf "$CERROJO"; }

# Un cerrojo con el pid dentro. Si lo tiene una instalación viva que solo espera a que se cierre la
# app, se la sustituye (esta compila lo último y hace lo mismo); si ya está cambiando de versión, no.
tomar_cerrojo() {
    local dueno i
    mkdir "$CERROJO" 2>/dev/null && return 0
    dueno=$(cat "$CERROJO/pid" 2>/dev/null)
    if [ -n "$dueno" ] && [ "$dueno" != "$$" ] && kill -0 "$dueno" 2>/dev/null \
        && ps -p "$dueno" -o command= 2>/dev/null | grep -q 'instalar\.sh'; then
        [ "$(cat "$CERROJO/fase" 2>/dev/null)" = cambiando ] && fallar 'Otra instalación está cambiando Anime Watcher de versión; vuelve a intentarlo en un momento.'
        kill -TERM -- "-$dueno" 2>/dev/null || kill -TERM "$dueno" 2>/dev/null
        for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$dueno" 2>/dev/null || break; sleep 1; done
        kill -KILL -- "-$dueno" 2>/dev/null || kill -KILL "$dueno" 2>/dev/null
    fi
    rm -rf "$CERROJO"
    mkdir "$CERROJO" 2>/dev/null || fallar 'Ya hay otra instalación de Anime Watcher en marcha.'
}
fase() { printf '%s\n' "$1" > "$CERROJO/fase"; }

# ---------------------------------------------------------------- principal

principal() {
    mkdir -p "$REGISTRO" || { echo "No se puede crear $REGISTRO" >&2; exit 1; }
    tomar_cerrojo
    echo $$ > "$CERROJO/pid"
    fase compilando
    trap limpiar EXIT
    : > "$LOG"
    : > "$ESTADO"

    if $LINUX; then paso 1 'Comprobando el compilador de C, Git, WebKitGTK, Rust y Node.js'
    else paso 1 'Comprobando las herramientas de Xcode, Git, Rust y Node.js'; fi
    comprobar_requisitos
    asegurar_node
    guardar_rutas

    paso 2 "Descargando el código ($RAMA)"
    descargar_codigo
    local commit fecha origen
    commit=$(git -C "$CODIGO" rev-parse HEAD)
    fecha=$(git -C "$CODIGO" log -1 --format=%cI)
    origen=$(git -C "$CODIGO" remote get-url origin)

    paso 3 'Instalando las dependencias de JavaScript'
    ejecutar "$CODIGO" npm ci --no-audit --no-fund || fallar "npm ci falló (detalles en $LOG)"

    paso 4 'Compilando la app (la primera vez tarda unos minutos)'
    local compilado="$CODIGO/src-tauri/target/release"
    if $LINUX; then
        ejecutar "$CODIGO" npm run tauri -- build --no-bundle || fallar "La compilación falló (detalles en $LOG)"
        [ -x "$compilado/$BINARIO" ] || fallar "La compilación no dejó $compilado/$BINARIO"
    else
        ejecutar "$CODIGO" npm run tauri -- build --bundles app || fallar "La compilación falló (detalles en $LOG)"
        [ -d "$compilado/bundle/macos/$NOMBRE_APP.app" ] || fallar "La compilación no dejó $NOMBRE_APP.app"
    fi

    paso 5 'Preparando la versión nueva'
    rm -rf "$NUEVO"
    mkdir -p "$NUEVO"
    if $LINUX; then
        cp "$compilado/$BINARIO" "$NUEVO/" || fallar 'No se pudo copiar lo compilado.'
        cp "$CODIGO/src-tauri/icons/128x128.png" "$NUEVO/icon.png" 2>/dev/null
    else
        cp -R "$compilado/bundle/macos/$NOMBRE_APP.app" "$NUEVO/" || fallar 'No se pudo copiar lo compilado.'
        # Lo compilado aquí no trae cuarentena, pero por si acaso.
        xattr -dr com.apple.quarantine "$NUEVO" 2>/dev/null
    fi
    printf '{\n  "commit": %s,\n  "fecha": %s,\n  "rama": %s,\n  "repo": %s\n}\n' \
        "$(json "$commit")" "$(json "$fecha")" "$(json "$RAMA")" "$(json "$origen")" > "$NUEVO/version.json"
    anotar "LISTO $commit"

    if [ -d "$APP" ]; then
        paso 6 'Esperando a que se cierre la app para cambiar de versión'
        fase esperando
        esperar_cierre
    else
        paso 6 "Instalando en $APP"
    fi
    fase cambiando
    rm -rf "$APP.anterior"
    [ -d "$APP" ] && mv "$APP" "$APP.anterior"
    mv "$NUEVO" "$APP" || { [ -d "$APP.anterior" ] && mv "$APP.anterior" "$APP"; fallar "No se pudo instalar en $APP."; }
    rm -rf "$APP.anterior"

    if $LINUX; then
        paso 7 "Creando el acceso en el menú y enlazando $BINARIO en $BIN"
        mkdir -p "$BIN" || fallar "No se puede crear $BIN"
        ln -sf "$APP/$BINARIO" "$BIN/$BINARIO"
        crear_lanzador_linux || echo 'Aviso: no se pudo crear el lanzador del menú de aplicaciones.'
        limpiar_instalacion_antigua
    else
        paso 7 "Creando ~/Applications/$NOMBRE_APP.app"
        crear_app_mac || echo "Aviso: no se pudo crear ~/Applications/$NOMBRE_APP.app."
    fi
    fase hecho
    anotar "APLICADO $commit"
    if $RELANZAR && [ ! -e "$NO_RELANZAR" ]; then abrir_app; fi
    rm -f "$NO_RELANZAR"
    $INTERACTIVO || return 0

    printf '\033[32mAnime Watcher %s instalado en %s.\033[0m\n' "${commit:0:7}" "$APP"
    if $LINUX; then
        echo "Ábrelo desde el menú de aplicaciones o con:  $BINARIO"
        case ":$PATH:" in
            *":$BIN:"*) ;;
            *) printf '\033[33m%s no está en el PATH: añade  export PATH="%s:$PATH"  a tu ~/.bashrc o ~/.zshrc.\033[0m\n' "$BIN" "$BIN" ;;
        esac
    else
        echo "Ábrelo desde Launchpad, Spotlight o ~/Applications/$NOMBRE_APP.app"
    fi
    echo 'Se actualiza sola: cuando haya cambios en GitHub, los compila y los instala al reiniciarla.'
}

# En la misma línea: bash lee el script según avanza, y git puede haberlo cambiado mientras tanto.
principal; exit $?
