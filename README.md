# anicli-es

Aplicación de escritorio para Windows para ver animé subtitulado al español. Es una versión actualizada de [nolbap/anicli-es](https://github.com/nolbap/anicli-es) con interfaz gráfica hecha con [Tauri 2](https://tauri.app) y Rust. Al igual que el original, saca los animés de [MonosChinos](https://monoschinos.st), que antes estaba en monoschinos2.com.

## Funciones

- Búsqueda, ficha del animé (sinopsis, géneros, estado) y lista completa de episodios.
- Portada con los últimos episodios publicados y la sección "Continuar viendo" (historial local).
- Reproductor integrado (HLS y MP4) que prueba los servidores en orden y pasa al siguiente si uno falla.
- Controles del CLI original: anterior, siguiente, ver de nuevo, elegir otro episodio y buscar otro animé.
- Paso automático al siguiente episodio, pantalla completa y atajos de teclado: <kbd>Espacio</kbd>, <kbd>←</kbd>/<kbd>→</kbd>, <kbd>F</kbd>, <kbd>N</kbd> (siguiente) y <kbd>P</kbd> (anterior).
- Opción de reproducir en **mpv** o **VLC**. Se detectan solos (PATH, Program Files, scoop) o puedes poner la ruta en Ajustes.

### Servidores

| Servidor | Soporte |
|---|---|
| voe, mp4upload, savefiles/streamhls, lulu, mixdrop, doodstream/dsvplay, uqload, yourupload, hexload, streamwish y otros con JWPlayer | Directo: reproductor integrado, mpv o VLC |
| filemoon/byse (piden captcha), mega, ok.ru | Sólo reproductor web: el embed del servidor en un iframe aislado y sin ventanas emergentes, o "Abrir en navegador" |

Los servidores exigen cabeceras como `Referer`, y el WebView no puede enviarlas. Por eso la app levanta un proxy local en `127.0.0.1` con un puerto aleatorio. Ese proxy añade las cabeceras, deja pasar las peticiones `Range` para poder adelantar el video y reescribe las listas HLS.

## Instalación

Descarga el instalador (`.exe` o `.msi`) desde la sección de *releases*, o compílalo tú mismo como se explica abajo. Windows 10 y 11 ya traen WebView2. Si falta, el instalador lo descarga.

Si quieres usar un reproductor externo:

- mpv: <https://mpv.io/installation/>
- VLC: <https://www.videolan.org/vlc/>

## Desarrollo

Necesitas [Rust](https://rustup.rs) (toolchain MSVC con *Build Tools* de Visual Studio) y [Node.js](https://nodejs.org).

```powershell
npm install
npm run tauri dev      # modo desarrollo con recarga en caliente
npm run tauri build    # instaladores en src-tauri/target/release/bundle/
cd src-tauri; cargo test
```

Estructura:

```
src/                 interfaz (TypeScript + Vite, sin framework)
  api.ts             contrato con el backend (comandos de Tauri)
  views/             inicio, búsqueda, ficha, reproductor, ajustes
src-tauri/src/
  site.rs            extracción de MonosChinos (búsqueda, ficha, episodios, servidores)
  extract/           extractores de video por servidor (+ desempaquetador P.A.C.K.E.R.)
  proxy.rs           proxy local de video para el reproductor integrado
  player.rs          lanzamiento de mpv / VLC
  store.rs           ajustes e historial (%APPDATA%\com.anicli-es.desktop)
```

Cuando el sitio o algún servidor cambie su HTML, lo que hay que tocar está en `site.rs` y en `extract/`.

## Licencia

GPL-3.0, igual que el proyecto original.
