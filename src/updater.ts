// Actualizador automático: consulta el latest.json de la última release de GitHub
// (configurado en tauri.conf.json), descarga la versión nueva en segundo plano y
// ofrece reiniciar para instalarla. La firma del paquete la verifica el backend.
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { errMsg, h, icon, toast } from "./ui";

export type UpdateStatus = { kind: "none" } | { kind: "ready"; version: string };

let card: HTMLElement | null = null;
/** Actualización ya descargada y lista para instalar. */
let ready: Update | null = null;
let running: Promise<UpdateStatus> | null = null;

/** Monta el aviso de actualización; en la app instalada busca versiones nuevas al arrancar. */
export function mountUpdater(host: HTMLElement): void {
  card = host;
  if (import.meta.env.DEV) return;
  checkForUpdates().catch((e: unknown) => console.warn("No se pudo buscar actualizaciones", e));
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
  const update = await check();
  if (!update) return { kind: "none" };
  await update.download();
  ready = update;
  showCard(update);
  return { kind: "ready", version: update.version };
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
          toast(`No se pudo instalar la actualización: ${errMsg(e)}`, "error");
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
      h("strong", { class: "update-title" }, `Anime Watcher ${update.version} está lista`),
      h("span", { class: "update-desc" }, "Se instala al reiniciar la app. Tu historial y tus ajustes se conservan."),
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
