import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as api from "../api";
import type { DetectedPlayers, PlayerKind, Settings } from "../api";
import type { ViewContext } from "../router";
import { setCrumbs } from "../shell";
import { errMsg, h, icon, loadInto, skeleton, toast } from "../ui";
import { checkForUpdates } from "../updater";

const MPV_URL = "https://mpv.io/installation/";
const VLC_URL = "https://www.videolan.org/vlc/";

export function settingsView(root: HTMLElement, ctx: ViewContext): void {
  setCrumbs("Ajustes");
  const body = h("div", { class: "settings" });
  root.append(
    h(
      "div",
      { class: "page settings-page" },
      h(
        "header",
        { class: "page-head" },
        h("p", { class: "eyebrow" }, "Preferencias"),
        h("h1", { class: "display" }, "Ajustes"),
        h("p", { class: "lede" }, "Elige cómo quieres ver tus episodios. Los cambios se aplican al pulsar Guardar."),
      ),
      body,
    ),
  );
  loadInto(
    body,
    ctx.signal,
    () => Promise.all([api.getSettings(), api.detectPlayers()]),
    ([settings, detected]) => renderForm(body, ctx.signal, settings, detected),
    "Cargando ajustes…",
    () => skeleton("panels", 3, "Cargando ajustes…"),
  );
}

/** Grupo de ajustes: título a la izquierda, filas a la derecha. */
const group = (title: string, desc: string | null, ...rows: (HTMLElement | null)[]) =>
  h(
    "section",
    { class: "set-group" },
    h("header", { class: "set-group-head" }, h("h2", null, title), desc ? h("p", null, desc) : null),
    h("div", { class: "set-rows" }, rows),
  );

/** Fila: etiqueta y descripción a la izquierda, control a la derecha. */
const row = (label: string, desc: string | Node | null, control: HTMLElement | null, cls = "") =>
  h(
    "div",
    { class: `set-row ${cls}`.trim() },
    h("div", { class: "set-text" }, h("span", { class: "set-label" }, label), desc ? h("span", { class: "set-desc" }, desc) : null),
    control,
  );

function renderForm(body: HTMLElement, signal: AbortSignal, settings: Settings, detected: DetectedPlayers): void {
  let player: PlayerKind = settings.player;

  const detectedMpv = h("code", { class: "detected" });
  const detectedVlc = h("code", { class: "detected" });
  const showDetected = (d: DetectedPlayers) => {
    for (const [el, path] of [
      [detectedMpv, d.mpv],
      [detectedVlc, d.vlc],
    ] as const) {
      el.textContent = path ?? "No detectado";
      el.title = path ?? "";
      el.classList.toggle("missing", !path);
    }
  };
  showDetected(detected);

  const option = (value: PlayerKind, title: string, desc: string, status: HTMLElement | null) =>
    h(
      "label",
      { class: "choice" },
      h("input", {
        type: "radio",
        name: "player",
        value,
        checked: settings.player === value,
        onchange: () => {
          player = value;
        },
      }),
      h("span", { class: "choice-dot", attrs: { "aria-hidden": "true" } }),
      h("span", { class: "set-text" }, h("span", { class: "set-label" }, title), h("span", { class: "set-desc" }, desc)),
      status,
    );

  const pathInput = (value: string | null, placeholder: string) =>
    h("input", { type: "text", class: "input input-mono", value: value ?? "", placeholder, spellcheck: false, autocomplete: "off" });
  const mpvInput = pathInput(settings.mpvPath, "Automática");
  const vlcInput = pathInput(settings.vlcPath, "Automática");
  const autoNext = h("input", { type: "checkbox", class: "switch", role: "switch", checked: settings.autoNext });

  const saveBtn: HTMLButtonElement = h(
    "button",
    {
      class: "btn btn-primary",
      onclick: async () => {
        const next: Settings = {
          player,
          mpvPath: mpvInput.value.trim() || null,
          vlcPath: vlcInput.value.trim() || null,
          autoNext: autoNext.checked,
        };
        saveBtn.disabled = true;
        try {
          await api.saveSettings(next);
          toast("Ajustes guardados.", "ok");
          api.detectPlayers().then(
            (d) => {
              if (!signal.aborted) showDetected(d);
            },
            (e: unknown) => console.warn("detectPlayers", e),
          );
        } catch (e) {
          toast(errMsg(e), "error");
        } finally {
          saveBtn.disabled = false;
        }
      },
    },
    icon("save"),
    "Guardar cambios",
  );

  const openBtn = (url: string) =>
    h(
      "button",
      { class: "btn btn-sm btn-quiet", onclick: () => openUrl(url).catch((e: unknown) => toast(errMsg(e), "error")) },
      icon("external"),
      "Descargar",
    );

  body.append(
    group(
      "Reproductor",
      "Dónde se abren los episodios.",
      h(
        "div",
        { class: "choices", role: "radiogroup", attrs: { "aria-label": "Reproductor" } },
        option("builtin", "Integrado", "Reproduce dentro de la app, sin instalar nada.", null),
        option("mpv", "mpv", "Ligero y rápido.", detectedMpv),
        option("vlc", "VLC", "Reproductor clásico.", detectedVlc),
      ),
    ),
    group(
      "Rutas",
      "Déjalas vacías para detectar el reproductor automáticamente.",
      row("Ejecutable de mpv", null, mpvInput, "set-row-field"),
      row("Ejecutable de VLC", null, vlcInput, "set-row-field"),
    ),
    group(
      "Reproducción",
      null,
      h(
        "label",
        { class: "set-row set-row-toggle" },
        h(
          "span",
          { class: "set-text" },
          h("span", { class: "set-label" }, "Siguiente episodio automático"),
          h("span", { class: "set-desc" }, "Al terminar un episodio en el reproductor integrado, empieza el siguiente."),
        ),
        autoNext,
      ),
    ),
    h("div", { class: "settings-save" }, saveBtn),
    updatesGroup(signal),
    group(
      "Reproductores externos",
      "Opcionales. La app los detecta solos o usa la ruta que indiques arriba.",
      row("mpv", h("code", null, MPV_URL), openBtn(MPV_URL)),
      row("VLC", h("code", null, VLC_URL), openBtn(VLC_URL)),
    ),
  );
}

function updatesGroup(signal: AbortSignal): HTMLElement {
  const version = h("code", null, "…");
  getVersion().then(
    (v) => {
      version.textContent = v;
    },
    (e: unknown) => console.warn("getVersion", e),
  );
  const status = h("p", { class: "set-status", attrs: { "aria-live": "polite" } });
  const checkBtn: HTMLButtonElement = h(
    "button",
    {
      class: "btn btn-sm",
      onclick: async () => {
        checkBtn.disabled = true;
        status.textContent = "Buscando actualizaciones…";
        status.title = "";
        try {
          const result = await checkForUpdates();
          if (signal.aborted) return;
          status.textContent =
            result.kind === "ready"
              ? `La versión ${result.version} ya está descargada. Reinicia la app para instalarla.`
              : "Tienes la última versión.";
        } catch (e) {
          // El plugin responde en inglés; el detalle queda en la consola y en el título.
          console.warn("checkForUpdates", e);
          if (signal.aborted) return;
          status.textContent = "No se pudo comprobar si hay actualizaciones. Revisa tu conexión e inténtalo más tarde.";
          status.title = errMsg(e);
        } finally {
          checkBtn.disabled = false;
        }
      },
    },
    icon("replay"),
    "Buscar",
  );
  return group(
    "Actualizaciones",
    "Las versiones nuevas se descargan solas desde GitHub; sólo hay que reiniciar para instalarlas.",
    row("Versión instalada", version, checkBtn),
    status,
  );
}
