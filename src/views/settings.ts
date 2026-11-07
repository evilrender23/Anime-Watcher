import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as api from "../api";
import type { DetectedPlayers, PlayerKind, Settings } from "../api";
import type { ViewContext } from "../router";
import { errMsg, h, icon, loadInto, skeleton, toast, type IconName } from "../ui";
import { checkForUpdates } from "../updater";

const MPV_URL = "https://mpv.io/installation/";
const VLC_URL = "https://www.videolan.org/vlc/";

export function settingsView(root: HTMLElement, ctx: ViewContext): void {
  const body = h("div");
  root.append(
    h(
      "div",
      { class: "page settings-page" },
      h(
        "div",
        { class: "page-head" },
        h("h1", { class: "page-title" }, "Ajustes"),
        h("p", { class: "page-sub" }, "Elige cómo quieres ver tus episodios."),
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

const panelHead = (name: IconName, title: string, desc?: string) =>
  h(
    "div",
    { class: "panel-head" },
    h("span", { class: "panel-icon" }, icon(name)),
    h("div", { class: "panel-heading" }, h("h2", { class: "panel-title" }, title), desc ? h("p", { class: "panel-desc" }, desc) : null),
  );

function renderForm(body: HTMLElement, signal: AbortSignal, settings: Settings, detected: DetectedPlayers): void {
  let player: PlayerKind = settings.player;

  const detectedMpv = h("span", { class: "detected" });
  const detectedVlc = h("span", { class: "detected" });
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
      { class: "radio-card" },
      h("input", {
        type: "radio",
        name: "player",
        value,
        checked: settings.player === value,
        onchange: () => {
          player = value;
        },
      }),
      h(
        "div",
        { class: "radio-body" },
        h("div", { class: "radio-title" }, title),
        h("div", { class: "radio-desc" }, desc, status ? " " : null, status),
      ),
    );

  const pathInput = (value: string | null, placeholder: string) =>
    h("input", { type: "text", class: "input", value: value ?? "", placeholder, spellcheck: false, autocomplete: "off" });
  const mpvInput = pathInput(settings.mpvPath, "Detección automática — p. ej. C:\\Program Files\\mpv\\mpv.exe");
  const vlcInput = pathInput(settings.vlcPath, "Detección automática — p. ej. C:\\Program Files\\VideoLAN\\VLC\\vlc.exe");
  const autoNext = h("input", { type: "checkbox", class: "switch", role: "switch", checked: settings.autoNext });

  const saveBtn: HTMLButtonElement = h(
    "button",
    {
      class: "btn btn-primary btn-lg",
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
    "Guardar",
  );

  const link = (label: string, url: string) =>
    h(
      "div",
      { class: "link-row" },
      h("span", { class: "link-label" }, label),
      h("code", { class: "link-url" }, url),
      h(
        "button",
        { class: "btn btn-sm", onclick: () => openUrl(url).catch((e: unknown) => toast(errMsg(e), "error")) },
        icon("external"),
        "Abrir",
      ),
    );

  body.append(
    h(
      "section",
      { class: "panel" },
      panelHead("tv", "Reproductor", "Dónde se abren los episodios."),
      h(
        "div",
        { class: "radio-group", role: "radiogroup" },
        option("builtin", "Integrado", "Reproduce dentro de la app, sin instalar nada.", null),
        option("mpv", "mpv", "Ligero y rápido. Ruta detectada:", detectedMpv),
        option("vlc", "VLC", "Reproductor clásico. Ruta detectada:", detectedVlc),
      ),
    ),
    h(
      "section",
      { class: "panel" },
      panelHead("folder", "Rutas manuales", "Déjalas vacías para detectar el reproductor automáticamente."),
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Ruta de mpv.exe"), mpvInput),
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Ruta de vlc.exe"), vlcInput),
    ),
    h(
      "section",
      { class: "panel" },
      panelHead("skip", "Reproducción"),
      h(
        "label",
        { class: "check toggle-row" },
        h(
          "span",
          { class: "toggle-text" },
          h("span", { class: "toggle-title" }, "Pasar al siguiente episodio automáticamente"),
          h("span", { class: "toggle-desc" }, "Al terminar un episodio en el reproductor integrado, empieza el siguiente."),
        ),
        autoNext,
      ),
    ),
    h("div", { class: "settings-actions" }, saveBtn),
    updatesPanel(signal),
    h(
      "section",
      { class: "panel panel-help" },
      panelHead(
        "info",
        "Ayuda",
        "El reproductor integrado funciona sin instalar nada. Si prefieres mpv o VLC, instálalos desde sus páginas oficiales; la app los detecta automáticamente o puedes indicar la ruta del ejecutable arriba.",
      ),
      link("mpv", MPV_URL),
      link("VLC", VLC_URL),
    ),
  );
}

function updatesPanel(signal: AbortSignal): HTMLElement {
  const version = h("strong", null, "…");
  getVersion().then(
    (v) => {
      version.textContent = v;
    },
    (e: unknown) => console.warn("getVersion", e),
  );
  const status = h("p", { class: "update-status", attrs: { "aria-live": "polite" } });
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
    "Buscar actualizaciones",
  );
  return h(
    "section",
    { class: "panel" },
    panelHead(
      "download",
      "Actualizaciones",
      "La app busca versiones nuevas en GitHub cada vez que se abre y las descarga sola; sólo tienes que reiniciarla para instalarlas.",
    ),
    h("div", { class: "update-row" }, h("span", { class: "update-version" }, "Versión instalada ", version), checkBtn),
    status,
  );
}
