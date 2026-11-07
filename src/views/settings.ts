import { openUrl } from "@tauri-apps/plugin-opener";
import * as api from "../api";
import type { DetectedPlayers, PlayerKind, Settings } from "../api";
import type { ViewContext } from "../router";
import { errMsg, h, icon, loadInto, skeleton, toast } from "../ui";

const MPV_URL = "https://mpv.io/installation/";
const VLC_URL = "https://www.videolan.org/vlc/";

export function settingsView(root: HTMLElement, ctx: ViewContext): void {
  const body = h("div");
  root.append(
    h(
      "div",
      { class: "page settings-page" },
      h("div", { class: "page-head" }, h("h1", { class: "page-title" }, "Ajustes")),
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
      h("h2", { class: "panel-title" }, "Reproductor"),
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
      h("h2", { class: "panel-title" }, "Rutas manuales"),
      h("p", { class: "panel-desc" }, "Déjalas vacías para detectar el reproductor automáticamente."),
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Ruta de mpv.exe"), mpvInput),
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Ruta de vlc.exe"), vlcInput),
    ),
    h(
      "section",
      { class: "panel" },
      h("h2", { class: "panel-title" }, "Reproducción"),
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
    h(
      "section",
      { class: "panel panel-help" },
      h("h2", { class: "panel-title" }, "Ayuda"),
      h(
        "p",
        { class: "panel-desc" },
        "El reproductor integrado funciona sin instalar nada. Si prefieres mpv o VLC, instálalos desde sus páginas oficiales; la app los detecta automáticamente o puedes indicar la ruta del ejecutable arriba.",
      ),
      link("mpv", MPV_URL),
      link("VLC", VLC_URL),
    ),
  );
}
