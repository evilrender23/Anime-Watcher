#!/usr/bin/env bash
# Instala Anime Watcher en macOS o Linux con un solo comando.
#
# Uso:
#   curl -fsSL https://raw.githubusercontent.com/evilrender23/Anime-Watcher/main/scripts/install.sh | bash
#
# Con opciones (añade "-s --" antes de ellas):
#   curl -fsSL https://raw.githubusercontent.com/evilrender23/Anime-Watcher/main/scripts/install.sh | bash -s -- --from-source
#   curl -fsSL https://raw.githubusercontent.com/evilrender23/Anime-Watcher/main/scripts/install.sh | bash -s -- --uninstall
#
# Desde una copia local del repositorio (compila esa copia y no la borra):
#   bash scripts/install.sh --source-dir .
#   bash scripts/install.sh --from-source --no-launch
#
# Descarga el instalador de la última versión publicada en GitHub. Si no hay
# ninguna para tu sistema (o con --from-source, o ANIME_WATCHER_FROM_SOURCE=1),
# descarga el código fuente y lo compila con scripts/build.sh.
set -euo pipefail

REPO="evilrender23/Anime-Watcher"
RAW_BASE="https://raw.githubusercontent.com/$REPO/main"
API_URL="https://api.github.com/repos/$REPO/releases/latest"
SOURCE_URL="https://github.com/$REPO/archive/refs/heads/main.tar.gz"
APP_NAME="Anime Watcher"

DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
APPIMAGE_PATH="$HOME/.local/bin/anime-watcher.AppImage"
DESKTOP_FILE="$DATA_HOME/applications/anime-watcher.desktop"
ICON_FILE="$DATA_HOME/icons/hicolor/128x128/apps/anime-watcher.png"

FROM_SOURCE=0
if [ "${ANIME_WATCHER_FROM_SOURCE:-}" = 1 ]; then FROM_SOURCE=1; fi
NO_LAUNCH=0
UNINSTALL=0
SOURCE_DIR=""    # copia local del código a compilar (--source-dir)

OS=""            # macos | linux
ARCH=""          # x64 | arm64
TMP_DIR=""
ASSET_FILE=""    # instalador descargado de la release
INSTALLED_APP="" # .app instalada (macOS)

info() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  cat <<'EOF'
Instala Anime Watcher.

Uso: install.sh [--from-source] [--source-dir ruta] [--no-launch] [--uninstall]

  --from-source       Compila desde el código fuente en lugar de descargar la versión publicada.
  --source-dir ruta   Compila e instala desde una copia local del código (no se borra).
  --no-launch         No abre la aplicación al terminar.
  --uninstall         Desinstala Anime Watcher.
  -h, --help          Muestra esta ayuda.
EOF
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --from-source) FROM_SOURCE=1 ;;
      --no-launch) NO_LAUNCH=1 ;;
      --uninstall) UNINSTALL=1 ;;
      -h | --help) usage; exit 0 ;;
      --source-dir)
        [ $# -ge 2 ] || die "--source-dir necesita la ruta del código, por ejemplo: --source-dir ."
        SOURCE_DIR="$2"
        shift
        ;;
      --source-dir=*) SOURCE_DIR="${1#--source-dir=}" ;;
      *) usage >&2; die "Opción desconocida: $1" ;;
    esac
    shift
  done
}

cleanup() {
  if [ -n "$TMP_DIR" ]; then rm -rf "$TMP_DIR"; fi
}

detect_platform() {
  case "$(uname -s)" in
    Darwin) OS=macos ;;
    Linux) OS=linux ;;
    *) die "Sistema no compatible: $(uname -s). En Windows usa install.ps1." ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) ARCH=x64 ;;
    arm64 | aarch64) ARCH=arm64 ;;
    *) die "Arquitectura no compatible: $(uname -m)." ;;
  esac
  # Una terminal bajo Rosetta dice x86_64 aunque el Mac sea Apple Silicon.
  if [ "$OS" = macos ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then
    ARCH=arm64
  fi
}

# Final del nombre del archivo publicado que corresponde a este equipo.
asset_suffix() {
  case "$OS-$ARCH" in
    macos-arm64) echo "_aarch64.app.tar.gz" ;;
    macos-x64) echo "_x64.app.tar.gz" ;;
    linux-x64) echo "_amd64.AppImage" ;;
    linux-arm64) echo "_aarch64.AppImage" ;;
  esac
}

# --- Versión publicada ------------------------------------------------------

# $1 = JSON de la API de GitHub, $2 = sufijo. Imprime la primera URL que termina en el sufijo.
pick_asset_url() {
  local urls url
  urls="$(printf '%s\n' "$1" | grep -o '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*"' |
    sed 's/.*"\([^"]*\)"$/\1/')" || return 1
  while IFS= read -r url; do
    case "$url" in *"$2") printf '%s\n' "$url"; return 0 ;; esac
  done <<<"$urls"
  return 1
}

release_tag() {
  printf '%s\n' "$1" | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' |
    sed 's/.*"\([^"]*\)"$/\1/'
}

download() {
  curl -fL --retry 3 --progress-bar -o "$2" "$1"
}

# Descarga el instalador publicado en ASSET_FILE. Falla si no hay uno utilizable.
download_release() {
  local json url tag
  info "Buscando la última versión publicada..."
  if ! json="$(curl -fsSL -H 'Accept: application/vnd.github+json' "$API_URL" 2>/dev/null)"; then
    warn "Todavía no hay versiones publicadas o GitHub no responde."
    return 1
  fi
  if ! url="$(pick_asset_url "$json" "$(asset_suffix)")"; then
    warn "La última versión no incluye un instalador para tu equipo ($OS $ARCH)."
    return 1
  fi
  tag="$(release_tag "$json" || true)"
  info "Descargando $APP_NAME ${tag:-}..."
  ASSET_FILE="$TMP_DIR/${url##*/}"
  if ! download "$url" "$ASSET_FILE"; then
    warn "No se pudo descargar $url"
    return 1
  fi
}

install_release() {
  if [ "$OS" = macos ]; then
    local app
    mkdir -p "$TMP_DIR/app"
    tar -xzf "$ASSET_FILE" -C "$TMP_DIR/app"
    app="$(newest "$TMP_DIR/app"/*.app)"
    [ -n "$app" ] || die "El archivo descargado no contiene la aplicación."
    install_macos_app "$app"
  else
    install_linux_appimage "$ASSET_FILE" ""
  fi
}

# --- Compilación desde el código fuente -------------------------------------

# Imprime el más reciente de los archivos indicados que exista.
newest() {
  local file best=""
  for file in "$@"; do
    [ -e "$file" ] || continue
    if [ -z "$best" ] || [ "$file" -nt "$best" ]; then best="$file"; fi
  done
  printf '%s' "$best"
}

source_version() {
  sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1/src-tauri/tauri.conf.json"
}

# Descarga y descomprime la rama main; imprime la ruta del código.
download_source() {
  info "Descargando el código fuente..." >&2
  download "$SOURCE_URL" "$TMP_DIR/source.tar.gz" || die "No se pudo descargar el código fuente. Revisa tu conexión a internet."
  tar -xzf "$TMP_DIR/source.tar.gz" -C "$TMP_DIR"
  printf '%s' "$TMP_DIR/Anime-Watcher-main"
}

# $1 = carpeta con el código de Anime Watcher. Compila e instala el resultado.
build_and_install() {
  local src="$1" bundle_dir artifact
  [ -f "$src/scripts/build.sh" ] || die "No encuentro scripts/build.sh en $src"

  info "Compilando $APP_NAME $(source_version "$src") (la primera vez puede tardar bastante)..."
  # stdin cerrado: con "curl | bash" la entrada estándar es este mismo script.
  if [ "$OS" = macos ]; then
    bash "$src/scripts/build.sh" --install-deps --bundles app </dev/null
  else
    bash "$src/scripts/build.sh" --install-deps --bundles appimage </dev/null
  fi

  bundle_dir="${CARGO_TARGET_DIR:-$src/src-tauri/target}/release/bundle"
  if [ "$OS" = macos ]; then
    artifact="$(newest "$bundle_dir/macos"/*.app)"
    [ -n "$artifact" ] || die "No encontré la aplicación compilada en $bundle_dir/macos"
    install_macos_app "$artifact"
  else
    artifact="$(newest "$bundle_dir/appimage"/*.AppImage)"
    [ -n "$artifact" ] || die "No encontré el AppImage compilado en $bundle_dir/appimage"
    install_linux_appimage "$artifact" "$src/src-tauri/icons/128x128.png"
  fi
}

# --- Instalación --------------------------------------------------------------

install_macos_app() {
  local dest_dir="/Applications"
  if [ ! -w "$dest_dir" ]; then
    dest_dir="$HOME/Applications"
    mkdir -p "$dest_dir"
  fi
  INSTALLED_APP="$dest_dir/$APP_NAME.app"
  info "Instalando en $INSTALLED_APP"
  rm -rf "$INSTALLED_APP"
  ditto "$1" "$INSTALLED_APP"
  xattr -dr com.apple.quarantine "$INSTALLED_APP" 2>/dev/null || true
}

# $1 = AppImage, $2 = icono local (vacío: se descarga del repositorio).
install_linux_appimage() {
  info "Instalando en $APPIMAGE_PATH"
  mkdir -p "$(dirname "$APPIMAGE_PATH")" "$(dirname "$DESKTOP_FILE")" "$(dirname "$ICON_FILE")"
  # Copia + renombrado: funciona aunque la versión anterior esté abierta.
  cp "$1" "$APPIMAGE_PATH.new"
  chmod +x "$APPIMAGE_PATH.new"
  mv -f "$APPIMAGE_PATH.new" "$APPIMAGE_PATH"

  if [ -n "$2" ] && [ -f "$2" ]; then
    cp "$2" "$ICON_FILE"
  elif ! curl -fsSL -o "$ICON_FILE" "$RAW_BASE/src-tauri/icons/128x128.png"; then
    warn "No se pudo descargar el icono; el acceso directo usará uno genérico."
  fi

  write_desktop_entry
  refresh_desktop_database
}

write_desktop_entry() {
  cat >"$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=$APP_NAME
Comment=Ver animé subtitulado al español
Exec="$APPIMAGE_PATH"
Icon=anime-watcher
Terminal=false
Categories=AudioVideo;Video;Player;
EOF
}

refresh_desktop_database() {
  if have update-desktop-database; then
    update-desktop-database "$(dirname "$DESKTOP_FILE")" >/dev/null 2>&1 || true
  fi
}

# Los AppImage necesitan libfuse.so.2 para arrancar.
has_fuse2() {
  local ldconfig cache lib
  for ldconfig in ldconfig /sbin/ldconfig /usr/sbin/ldconfig; do
    have "$ldconfig" || continue
    cache="$("$ldconfig" -p 2>/dev/null)" || continue
    case "$cache" in *libfuse.so.2*) return 0 ;; esac
  done
  for lib in /usr/lib/libfuse.so.2 /usr/lib64/libfuse.so.2 /lib/*/libfuse.so.2 /usr/lib/*/libfuse.so.2; do
    [ -e "$lib" ] && return 0
  done
  return 1
}

fuse_hint() {
  warn "$APP_NAME no puede arrancar porque falta FUSE 2 (libfuse2). Instálalo con:"
  if have apt-get; then
    warn "  sudo apt-get install libfuse2   (en Ubuntu 24.04 o superior: libfuse2t64)"
  elif have dnf; then
    warn "  sudo dnf install fuse fuse-libs"
  elif have pacman; then
    warn "  sudo pacman -S fuse2"
  elif have zypper; then
    warn "  sudo zypper install libfuse2"
  else
    warn "  el paquete libfuse2 (o fuse2) de tu distribución"
  fi
}

# --- Desinstalación -----------------------------------------------------------

uninstall() {
  local path removed=0
  if [ "$OS" = macos ]; then
    for path in "/Applications/$APP_NAME.app" "$HOME/Applications/$APP_NAME.app"; do
      if [ -d "$path" ]; then rm -rf "$path"; info "Eliminado $path"; removed=1; fi
    done
  else
    for path in "$APPIMAGE_PATH" "$DESKTOP_FILE" "$ICON_FILE"; do
      if [ -e "$path" ]; then rm -f "$path"; info "Eliminado $path"; removed=1; fi
    done
    refresh_desktop_database
  fi
  if [ "$removed" -eq 1 ]; then
    info "$APP_NAME se ha desinstalado."
  else
    info "$APP_NAME no estaba instalado."
  fi
}

# --- Inicio -------------------------------------------------------------------

launch() {
  if [ "$OS" = macos ]; then
    open "$INSTALLED_APP"
  elif ! has_fuse2; then
    fuse_hint
  elif [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    nohup "$APPIMAGE_PATH" >/dev/null 2>&1 &
  else
    info "Abre $APP_NAME desde el menú de aplicaciones."
  fi
}

main() {
  parse_args "$@"
  detect_platform
  if [ "$UNINSTALL" -eq 1 ]; then
    uninstall
    return
  fi
  have curl || die "Necesito curl para descargar Anime Watcher. Instálalo y vuelve a intentarlo."
  have tar || die "Necesito tar para descomprimir Anime Watcher. Instálalo y vuelve a intentarlo."

  # Compilar ocupa varios GB: en Linux /tmp suele estar en memoria, así que se usa la caché del usuario.
  local tmp_base="${TMPDIR:-/tmp}"
  if [ "$OS" = linux ]; then
    tmp_base="${XDG_CACHE_HOME:-$HOME/.cache}"
    mkdir -p "$tmp_base"
  fi
  TMP_DIR="$(mktemp -d "$tmp_base/anime-watcher.XXXXXX")"
  trap cleanup EXIT

  local src
  if [ -n "$SOURCE_DIR" ]; then
    src="$(cd "$SOURCE_DIR" 2>/dev/null && pwd)" || die "La carpeta $SOURCE_DIR no existe."
    build_and_install "$src"
  elif [ "$FROM_SOURCE" -eq 0 ] && download_release; then
    install_release
  else
    info "Se compilará $APP_NAME desde el código fuente."
    src="$(download_source)"
    build_and_install "$src"
  fi

  info "¡$APP_NAME está instalado!"
  if [ "$NO_LAUNCH" -eq 0 ]; then
    launch
  elif [ "$OS" = linux ] && ! has_fuse2; then
    fuse_hint
  fi
}

main "$@"
