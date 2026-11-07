// Actualizador automático: consulta el latest.json de la última release de GitHub
// (configurado en tauri.conf.json), descarga la versión nueva en segundo plano y
// ofrece reiniciar para instalarla. La firma del paquete la verifica el backend.
//
// Funciona igual en Windows (instalador NSIS/MSI), macOS (.app) y Linux (AppImage,
// .deb o .rpm): el plugin elige la entrada de latest.json según el sistema y el tipo
// de instalación. Los fallos se traducen a mensajes claros en español.
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { errMsg, h, icon, toast } from "./ui";

export type UpdateStatus =
  | { kind: "none" }
  /** No hay ninguna versión publicada en GitHub (latest.json no existe). */
  | { kind: "unpublished" }
  | { kind: "ready"; version: string }
  /** Sólo en desarrollo: hay versión nueva, pero no se descarga ni se instala. */
  | { kind: "available"; version: string };

/** Error del actualizador con un mensaje para el usuario y el detalle técnico original. */
export class UpdateError extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
  }
}

/** Progreso de la descarga (0–1) o null si el servidor no indica el tamaño. */
type ProgressListener = (fraction: number | null) => void;

const CHECK_TIMEOUT_MS = 20_000;

let card: HTMLElement | null = null;
/** Actualización ya descargada y lista para instalar. */
let ready: Update | null = null;
let running: Promise<UpdateStatus> | null = null;
const progressListeners = new Set<ProgressListener>();

/** Monta el aviso de actualización; en la app instalada busca versiones nuevas al arrancar. */
export function mountUpdater(host: HTMLElement): void {
  card = host;
  if (import.meta.env.DEV) return;
  checkForUpdates().catch((e: unknown) => console.warn("No se pudo buscar actualizaciones", e));
}

/** Escucha el progreso de la descarga en curso. Devuelve la función para dejar de escuchar. */
export function onUpdateProgress(listener: ProgressListener): () => void {
  progressListeners.add(listener);
  return () => progressListeners.delete(listener);
}

/** Busca una versión nueva y la descarga. Si ya hay una búsqueda en curso, devuelve esa misma. */
export function checkForUpdates(): Promise<UpdateStatus> {
  if (ready) {
    showCard(ready);
    return Promise.resolve({ kind: "ready", version: ready.version });
  }
  if (!running) {
    running = findAndDownload().finally(() => {
      running = null;
    });
  }
  return running;
}

async function findAndDownload(): Promise<UpdateStatus> {
  let update: Update | null;
  try {
    update = await check({ timeout: CHECK_TIMEOUT_MS });
  } catch (e) {
    const detail = errMsg(e);
    // Sin ninguna release publicada (o sin latest.json) no hay nada que instalar:
    // no es un fallo de la app ni de la conexión.
    if (isNoRelease(detail)) return { kind: "unpublished" };
    throw new UpdateError(explain(detail), detail);
  }
  if (!update) return { kind: "none" };

  if (import.meta.env.DEV) {
    // En desarrollo no se instala nada: reemplazaría el binario de depuración.
    await update.close().catch(() => {});
    return { kind: "available", version: update.version };
  }

  let total = 0;
  let received = 0;
  const emit = (fraction: number | null) => progressListeners.forEach((fn) => fn(fraction));
  try {
    await update.download((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength ?? 0;
        emit(total ? 0 : null);
      } else if (event.event === "Progress") {
        received += event.data.chunkLength;
        emit(total ? Math.min(1, received / total) : null);
      } else {
        emit(1);
      }
    });
  } catch (e) {
    const detail = errMsg(e);
    throw new UpdateError(explain(detail), detail);
  }
  ready = update;
  showCard(update);
  return { kind: "ready", version: update.version };
}

/** latest.json no existe todavía (404) → todavía no se publicó ninguna versión. */
function isNoRelease(detail: string): boolean {
  return /valid release JSON|release.*not found|404/i.test(detail);
}

/** Traduce los errores del plugin (en inglés) a un mensaje para el usuario. */
function explain(detail: string): string {
  const d = detail.toLowerCase();
  if (/signature|minisign|public key|pubkey/.test(d)) {
    return "La actualización descargada no tiene una firma válida, así que no se instaló. Avisa al autor de la app.";
  }
  if (/platform .* was not found|target.*not found|platforms/.test(d)) {
    return "La última versión publicada todavía no incluye tu sistema. Vuelve a intentarlo más tarde.";
  }
  if (/appimage|unsupported.*(linux|package|installer)|only .* supported/.test(d)) {
    return "Esta instalación no se puede actualizar sola. Vuelve a instalar la app con el instalador de la web (AppImage, .deb o .rpm) para recibir actualizaciones.";
  }
  if (/permission|access is denied|read-only|eacces|eperm|operation not permitted/.test(d)) {
    return "No hay permiso para reemplazar la app. Muévela a una carpeta donde puedas escribir (por ejemplo, Aplicaciones) y vuelve a intentarlo.";
  }
  if (/timed? ?out|timeout|dns|connect|network|request|tls|certificate|error sending/.test(d)) {
    return "No se pudo conectar con GitHub. Revisa tu conexión e inténtalo de nuevo.";
  }
  return "No se pudo comprobar si hay actualizaciones.";
}

function showCard(update: Update): void {
  const host = card;
  if (!host) return;
  const installBtn: HTMLButtonElement = h(
    "button",
    {
      class: "btn btn-primary btn-sm",
      onclick: async () => {
        installBtn.disabled = true;
        try {
          // En Windows el instalador cierra la app y la vuelve a abrir al terminar.
          await update.install();
          await relaunch();
        } catch (e) {
          installBtn.disabled = false;
          const detail = errMsg(e);
          console.warn("update.install", detail);
          toast(`No se pudo instalar la actualización. ${explain(detail)}`, "error");
        }
      },
    },
    icon("replay"),
    "Reiniciar y actualizar",
  );
  host.replaceChildren(
    h("span", { class: "update-icon" }, icon("sparkle")),
    h(
      "div",
      { class: "update-text" },
      h("strong", { class: "update-title" }, `Versión ${update.version} lista`),
      h("span", { class: "update-desc" }, "Se instala al reiniciar. Tu historial y tus ajustes se conservan."),
    ),
    h(
      "div",
      { class: "update-actions" },
      installBtn,
      h("button", { class: "btn btn-ghost btn-sm", onclick: () => (host.hidden = true) }, "Más tarde"),
    ),
  );
  host.hidden = false;
}
