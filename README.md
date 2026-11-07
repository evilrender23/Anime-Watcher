# Anime Watcher

Anime Watcher es una aplicación de escritorio para Windows, macOS y Linux para ver animé subtitulado al español. Es una versión actualizada de [nolbap/anicli-es](https://github.com/nolbap/anicli-es) con interfaz gráfica hecha con [Tauri 2](https://tauri.app) y Rust. Al igual que el original, saca los animés de [MonosChinos](https://monoschinos.st), que antes estaba en monoschinos2.com.

## Funciones

- Búsqueda, ficha del animé (sinopsis, géneros, estado) y lista completa de episodios.
- Portada con los últimos episodios publicados y la sección "Continuar viendo" (historial local).
- Reproductor integrado (HLS y MP4) que prueba los servidores en orden y pasa al siguiente si uno falla.
- Controles del CLI original: anterior, siguiente, ver de nuevo, elegir otro episodio y buscar otro animé.
- Paso automático al siguiente episodio, pantalla completa y atajos de teclado: <kbd>Espacio</kbd>, <kbd>←</kbd>/<kbd>→</kbd>, <kbd>F</kbd>, <kbd>N</kbd> (siguiente) y <kbd>P</kbd> (anterior).
- Opción de reproducir en **mpv** o **VLC**. Se detectan solos (PATH, Program Files, scoop, Homebrew, /Applications) o puedes poner la ruta en Ajustes.
- Tema oscuro y actualizaciones automáticas desde este repositorio.

### Servidores

| Servidor | Soporte |
|---|---|
| voe, mp4upload, savefiles/streamhls, lulu, mixdrop, doodstream/dsvplay, uqload, yourupload, hexload, streamwish y otros con JWPlayer | Directo: reproductor integrado, mpv o VLC |
| filemoon/byse (piden captcha), mega, ok.ru | Sólo reproductor web: el embed del servidor en un iframe aislado y sin ventanas emergentes, o "Abrir en navegador" |

Los servidores exigen cabeceras como `Referer`, y el WebView no puede enviarlas. Por eso la app levanta un proxy local en `127.0.0.1` con un puerto aleatorio. Ese proxy añade las cabeceras, deja pasar las peticiones `Range` para poder adelantar el video y reescribe las listas HLS.

## Instalación

**Windows** (en PowerShell):

```powershell
irm https://raw.githubusercontent.com/evilrender23/Anime-Watcher/main/scripts/install.ps1 | iex
```

**macOS y Linux** (en una terminal):

```bash
curl -fsSL https://raw.githubusercontent.com/evilrender23/Anime-Watcher/main/scripts/install.sh | bash
```

El instalador descarga de la [última release](https://github.com/evilrender23/Anime-Watcher/releases/latest) el paquete de tu sistema y lo instala. Si todavía no hay una release para tu sistema (por ejemplo Linux ARM), descarga el código, instala lo necesario para compilarlo y lo compila en tu equipo.

| Sistema | Dónde se instala |
|---|---|
| Windows | `%LOCALAPPDATA%\Anime Watcher` (sin permisos de administrador), con acceso en el menú Inicio. Se desinstala desde Configuración → Aplicaciones. |
| macOS | `/Applications/Anime Watcher.app` (o `~/Applications` si no tienes permiso). |
| Linux | `~/.local/bin/anime-watcher.AppImage`, con su acceso en el menú de aplicaciones. Necesita FUSE 2 (`libfuse2`). |

Opciones:

```powershell
# Windows: compilar desde el código aunque haya release
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/evilrender23/Anime-Watcher/main/scripts/install.ps1))) -FromSource
# Windows: instalar desde un clon del repositorio
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -SourceDir .
```

```bash
# macOS/Linux: compilar desde el código, instalar desde un clon o desinstalar
curl -fsSL https://raw.githubusercontent.com/evilrender23/Anime-Watcher/main/scripts/install.sh | bash -s -- --from-source
bash scripts/install.sh --source-dir .
bash scripts/install.sh --uninstall
```

También puedes descargar el instalador (`.exe`, `.msi`, `.dmg`, `.AppImage`, `.deb` o `.rpm`) a mano desde la página de *releases*. Windows 10 y 11 ya traen WebView2; si falta, el instalador lo descarga. Las compilaciones de macOS no están firmadas por Apple: si el sistema se queja al abrirla, haz clic derecho → Abrir.

¿Venías de **anicli-es**? Al abrir Anime Watcher por primera vez se copian tu historial y tus ajustes. Después puedes desinstalar anicli-es.

Si quieres usar un reproductor externo:

- mpv: <https://mpv.io/installation/>
- VLC: <https://www.videolan.org/vlc/>

## Actualizaciones automáticas

Cada vez que se abre, la app consulta el `latest.json` de la última release de este repositorio. Si hay una versión nueva, la descarga en segundo plano, comprueba su firma y muestra un aviso con el botón **Reiniciar y actualizar**. Tu historial y tus ajustes se conservan. También puedes buscar actualizaciones a mano en **Ajustes → Actualizaciones**.

## Compilar

Los scripts de `scripts/` compilan la app y dejan los instaladores en `src-tauri/target/release/bundle/`. Con `-InstallDeps` / `--install-deps` instalan antes lo que falte: Node.js, Rust y, según el sistema, las Build Tools de Visual Studio, las Command Line Tools de Xcode o las bibliotecas de WebKitGTK.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -InstallDeps            # todos los formatos
powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -Bundles nsis           # sólo el instalador .exe
```

```bash
bash scripts/build.sh --install-deps                 # todos los formatos de tu sistema
bash scripts/build.sh --bundles appimage             # sólo el AppImage (macOS: --bundles app)
```

Si existe la clave de firma (`~/.tauri/anime-watcher.key`, o la variable `TAURI_SIGNING_PRIVATE_KEY`), la compilación genera también los archivos firmados del actualizador. Si no existe, compila igual, pero sin ellos.

## Publicar una versión

El workflow [`.github/workflows/release.yml`](.github/workflows/release.yml) compila para Windows x64, macOS (Apple Silicon e Intel) y Linux x64, y publica la release con los instaladores y el `latest.json` del actualizador. Primero crea la release como borrador, compila los cuatro sistemas en paralelo y, al final, genera un único `latest.json` con todas las plataformas ([`scripts/updater-json.py`](scripts/updater-json.py)) y publica la release. Así el actualizador funciona con cualquier instalación: NSIS o MSI en Windows, `.app` en macOS y AppImage, `.deb` o `.rpm` en Linux.

Antes de la primera publicación, guarda la clave privada como secreto del repositorio (Settings → Secrets and variables → Actions):

- `TAURI_SIGNING_PRIVATE_KEY`: el contenido de `~/.tauri/anime-watcher.key`.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: sólo si la clave tiene contraseña.

La clave pública correspondiente está en `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`). Guarda una copia de la clave privada en un lugar seguro: si se pierde, las apps ya instaladas no aceptarán las actualizaciones firmadas con una clave nueva.

Para cada versión:

1. Sube el número de versión en `src-tauri/tauri.conf.json`, `package.json` y `src-tauri/Cargo.toml`.
2. Haz commit, crea la etiqueta y súbela:

   ```bash
   git tag v1.0.1
   git push origin main --tags
   ```

El workflow también se puede lanzar a mano desde la pestaña *Actions*.

## Desarrollo

Necesitas [Rust](https://rustup.rs) y [Node.js](https://nodejs.org) 20.19 o superior, más los [requisitos de Tauri](https://v2.tauri.app/start/prerequisites/) de tu sistema. `scripts/build.ps1 -InstallDeps` / `scripts/build.sh --install-deps` los instalan por ti.

```powershell
npm install
npm run tauri dev      # modo desarrollo con recarga en caliente
cd src-tauri; cargo test
```

Estructura:

```
src/                 interfaz (TypeScript + Vite, sin framework)
  api.ts             contrato con el backend (comandos de Tauri)
  updater.ts         actualizador automático (aviso y descarga)
  views/             inicio, búsqueda, ficha, reproductor, ajustes
src-tauri/src/
  site.rs            extracción de MonosChinos (búsqueda, ficha, episodios, servidores)
  extract/           extractores de video por servidor (+ desempaquetador P.A.C.K.E.R.)
  proxy.rs           proxy local de video para el reproductor integrado
  player.rs          lanzamiento de mpv / VLC
  store.rs           ajustes e historial (carpeta de datos com.evilrender23.animewatcher)
scripts/             instaladores (install.ps1, install.sh) y compiladores (build.ps1, build.sh)
.github/workflows/   compilación y publicación de releases
```

Cuando el sitio o algún servidor cambie su HTML, lo que hay que tocar está en `site.rs` y en `extract/`.

## Licencia

GPL-3.0, igual que el proyecto original.
