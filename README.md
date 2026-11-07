# Anime Watcher

Anime Watcher es una aplicación de escritorio para Windows, macOS y Linux para ver animé subtitulado al español. Es una versión actualizada de [nolbap/anicli-es](https://github.com/nolbap/anicli-es) con interfaz gráfica hecha con [Tauri 2](https://tauri.app) y Rust. Al igual que el original, saca los animés de [MonosChinos](https://monoschinos.st), que antes estaba en monoschinos2.com.

## Funciones

- Búsqueda, ficha del animé (sinopsis, géneros, estado) y lista completa de episodios.
- Portada con los últimos episodios publicados y la sección "Continuar viendo" (historial local).
- Reproductor integrado (HLS y MP4) que prueba los servidores en orden y pasa al siguiente si uno falla.
- Controles del CLI original: anterior, siguiente, ver de nuevo, elegir otro episodio y buscar otro animé.
- Paso automático al siguiente episodio, pantalla completa y atajos de teclado: <kbd>Espacio</kbd>, <kbd>←</kbd>/<kbd>→</kbd>, <kbd>F</kbd>, <kbd>N</kbd> (siguiente) y <kbd>P</kbd> (anterior).
- Opción de reproducir en **mpv** o **VLC**. Se detectan solos (PATH, Program Files, scoop, Homebrew, /Applications) o puedes poner la ruta en Ajustes.
- Mi lista al estilo MyAnimeList: estados, notas del 1 al 10 y progreso, que se actualiza sola al ver episodios.
- Tema oscuro y actualizaciones automáticas desde la rama `main` de este repositorio.

### Servidores

| Servidor | Soporte |
|---|---|
| voe, mp4upload, savefiles/streamhls, lulu, mixdrop, doodstream/dsvplay, uqload, yourupload, hexload, streamwish y otros con JWPlayer | Directo: reproductor integrado, mpv o VLC |
| filemoon/byse (piden captcha), mega, ok.ru | Sólo reproductor web: el embed del servidor en un iframe aislado y sin ventanas emergentes, o "Abrir en navegador" |

Los servidores exigen cabeceras como `Referer`, y el WebView no puede enviarlas. Por eso la app levanta un proxy local en `127.0.0.1` con un puerto aleatorio. Ese proxy añade las cabeceras, deja pasar las peticiones `Range` para poder adelantar el video y reescribe las listas HLS.

## Instalación

Un solo comando descarga el código de la rama `main`, lo compila en tu equipo y lo instala. Si falta algo necesario para compilar (Git, Node.js 20.19+, Rust y, según el sistema, las Build Tools de C++, las herramientas de Xcode o WebKitGTK), lo instala solo avisando de que es una dependencia. Rust va con rustup a `~/.cargo` y Node.js a la carpeta de la app, sin tocar el sistema; las herramientas de Xcode, los paquetes de Linux y las Build Tools piden permiso con la ventana del sistema.

**Windows** (PowerShell):

```powershell
irm https://raw.githubusercontent.com/evilrender23/Anime-Watcher/main/instalar.ps1 | iex
```

**macOS y Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/evilrender23/Anime-Watcher/main/instalar.sh | bash
```

También desde un clon: `bash Anime-Watcher/instalar.sh` o `powershell -ExecutionPolicy Bypass -File Anime-Watcher\instalar.ps1`.

| | Código y caché | App | Acceso |
|---|---|---|---|
| Windows | `%LOCALAPPDATA%\AnimeWatcher\codigo` | `%LOCALAPPDATA%\AnimeWatcher\app` | menú Inicio |
| macOS | `~/Library/Application Support/AnimeWatcher/codigo` | `/Applications/Anime Watcher.app` (o `~/Applications` si no puedes escribir en `/Applications`) | Launchpad, Spotlight y la carpeta Aplicaciones |
| Linux | `~/.local/share/AnimeWatcher/codigo` | `~/.local/share/AnimeWatcher/app` | menú de aplicaciones y `anime-watcher` en `~/.local/bin` |

Opciones: `--repo`, `--rama`, `--destino` y `--bin` (en Windows `-Repo`, `-Rama` y `-Destino`). La primera compilación tarda unos minutos; las siguientes aprovechan la caché.

### Sin compilar: instaladores de Releases

En [Releases](https://github.com/evilrender23/Anime-Watcher/releases/latest) están los instaladores ya compilados para **Windows** (`.exe` / `.msi`) y **macOS** (`.dmg` para Apple Silicon e Intel). No están firmados: en Mac, ábrela la primera vez con clic derecho → **Abrir**; en Windows, si sale SmartScreen, **Más información → Ejecutar de todas formas**. Estas copias no se compilan solas: avisan cuando hay un release nuevo y abren su página para descargarlo.

¿Venías de **anicli-es**? Al abrir Anime Watcher por primera vez se copian tu historial y tus ajustes. Después puedes desinstalar anicli-es.

Si quieres usar un reproductor externo:

- mpv: <https://mpv.io/installation/>
- VLC: <https://www.videolan.org/vlc/>

## Actualizaciones automáticas

Instalada con el comando, cada equipo compila la rama `main`. La app instalada guarda en `version.json` el commit del que salió (en Mac, dentro de `Anime Watcher.app/Contents/Resources`). Un minuto después de abrirse y cada 6 horas hace `git fetch` en `codigo/` y, si hay commits nuevos, relanza el instalador en segundo plano (`--actualizar`). Este compila la versión nueva aparte mientras sigues usando la app, que muestra el progreso en la barra lateral. Cuando termina, aparece **Reiniciar y actualizar**: la app se cierra, el instalador la cambia por la versión nueva y la vuelve a abrir. Si la cierras sin más, el cambio se aplica igual y la próxima vez que la abras ya es la nueva.

En **Ajustes → Actualizaciones** ves el commit instalado, puedes buscar a mano y desactivar las actualizaciones automáticas. El progreso queda en `registro/actualizacion.log` y la salida de git, npm y cargo en `registro/compilacion.log`. Tu lista, historial y ajustes se guardan aparte y no se tocan.

Publicar una versión es solo hacer push a `main`. Volver a ejecutar el comando de instalación también actualiza.

Para publicar un release con instaladores: sube la versión en `package.json`, `src-tauri/Cargo.toml` y `src-tauri/tauri.conf.json`, haz commit y sube una etiqueta igual (`git tag v1.0.3 && git push origin v1.0.3`). El workflow `.github/workflows/release.yml` compila Windows y macOS (Apple Silicon e Intel) y publica el release.

## Compilar instaladores

Los scripts de `scripts/` generan paquetes sueltos (`.exe`, `.msi`, `.dmg`, `.AppImage`, `.deb`, `.rpm`) en `src-tauri/target/release/bundle/`, por si quieres repartirlos a mano. Esas copias no se actualizan solas; para eso usa el instalador de arriba.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -InstallDeps            # todos los formatos
powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -Bundles nsis           # sólo el instalador .exe
```

```bash
bash scripts/build.sh --install-deps                 # todos los formatos de tu sistema
bash scripts/build.sh --bundles appimage             # sólo el AppImage (macOS: --bundles app)
```

## Desarrollo

Necesitas [Rust](https://rustup.rs) y [Node.js](https://nodejs.org) 20.19 o superior, más los [requisitos de Tauri](https://v2.tauri.app/start/prerequisites/) de tu sistema. `instalar.ps1` / `instalar.sh` los instalan por ti.

```powershell
npm install
npm run tauri dev      # modo desarrollo con recarga en caliente
cd src-tauri; cargo test
```

Estructura:

```
src/                 interfaz (TypeScript + Vite, sin framework)
  api.ts             contrato con el backend (comandos de Tauri)
  updater.ts         actualizaciones: estado, aviso y progreso
  mylist.ts          Mi lista (estilo MyAnimeList)
  views/             inicio, búsqueda, ficha, reproductor, ajustes
src-tauri/src/
  site.rs            extracción de MonosChinos (búsqueda, ficha, episodios, servidores)
  extract/           extractores de video por servidor (+ desempaquetador P.A.C.K.E.R.)
  proxy.rs           proxy local de video para el reproductor integrado
  player.rs          lanzamiento de mpv / VLC
  store.rs           ajustes, historial y lista (carpeta de datos com.evilrender23.animewatcher)
  update.rs          actualizaciones desde main con git + instalador
instalar.sh          instalador y actualizador para macOS y Linux
instalar.ps1         instalador y actualizador para Windows
scripts/             compiladores de paquetes sueltos (build.ps1, build.sh)
```

Cuando el sitio o algún servidor cambie su HTML, lo que hay que tocar está en `site.rs` y en `extract/`.

## Licencia

GPL-3.0, igual que el proyecto original.
