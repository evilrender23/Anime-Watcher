// Utilidades de interfaz: construcción segura del DOM (sin innerHTML), iconos,
// estados de carga/error, imágenes con placeholder y avisos.

export type Child = Node | string | number | null | undefined | false;

type Props<K extends keyof HTMLElementTagNameMap> = Partial<
  Omit<HTMLElementTagNameMap[K], "style" | "dataset" | "className" | "children">
> & {
  class?: string;
  style?: string;
  dataset?: Record<string, string>;
  attrs?: Record<string, string>;
};

/** Crea un elemento. Los textos se insertan como nodos de texto, nunca como HTML. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props<K> | null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    const { class: cls, style, dataset, attrs, ...rest } = props;
    if (cls) el.className = cls;
    if (style) el.style.cssText = style;
    if (dataset) Object.assign(el.dataset, dataset);
    if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    Object.assign(el, rest);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === "number" ? String(child) : child);
  }
  return el;
}

/** Mensaje legible de un error (el backend rechaza con strings en español). */
export function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";
const ICONS = {
  back: "M15 18l-6-6 6-6",
  next: "M9 18l6-6-6-6",
  search: "M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14z M20 20l-4.2-4.2",
  home: "M3 11l9-7 9 7 M5 9.5V20h5v-6h4v6h5V9.5",
  settings: "M4 7h9 M17 7h3 M4 17h3 M11 17h9 M15 5a2 2 0 1 0 0 4a2 2 0 1 0 0-4z M9 15a2 2 0 1 0 0 4a2 2 0 1 0 0-4z",
  play: "M8 5.5v13a.6.6 0 0 0 .9.5l10.2-6.5a.6.6 0 0 0 0-1L8.9 5a.6.6 0 0 0-.9.5z",
  x: "M6 6l12 12 M18 6L6 18",
  replay: "M3 12a9 9 0 1 0 2.6-6.4 M3 4v5h5",
  list: "M9 6h11 M9 12h11 M9 18h11 M4 6h.01 M4 12h.01 M4 18h.01",
  external: "M14 4h6v6 M20 4l-9 9 M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  fullscreen: "M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5",
  tv: "M3 5h18v12H3z M8 21h8 M12 17v4",
  alert: "M12 9v4 M12 16.5h.01 M10.3 4.2L2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z",
  sort: "M7 4v16 M3 16l4 4 4-4 M17 20V4 M13 8l4-4 4 4",
  save: "M5 12l5 5L20 7",
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, cls = "icon"): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", name === "play" ? `${cls} icon-fill` : cls);
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}

function hue(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) n = (n * 31 + text.charCodeAt(i)) >>> 0;
  return n % 360;
}

/**
 * Imagen remota con carga diferida y sin referrer; si falla (o no hay URL)
 * se sustituye por un degradado con la inicial del título.
 */
export function poster(src: string | null, title: string, cls: string): HTMLDivElement {
  const box = h("div", { class: `media ${cls}` });
  const placeholder = () => {
    box.classList.add("is-ph");
    box.style.setProperty("--ph-hue", String(hue(title)));
    const initial = Array.from(title.trim())[0]?.toUpperCase() ?? "?";
    box.replaceChildren(h("span", { class: "media-ph-letter" }, initial));
  };
  if (!src) {
    placeholder();
    return box;
  }
  const img = document.createElement("img");
  img.alt = "";
  img.loading = "lazy";
  img.decoding = "async";
  img.referrerPolicy = "no-referrer";
  img.addEventListener("error", placeholder, { once: true });
  img.addEventListener("load", () => box.classList.add("is-loaded"), { once: true });
  img.src = src;
  box.append(img);
  return box;
}

export function spinner(text = "Cargando…"): HTMLElement {
  return h("div", { class: "state state-loading" }, h("div", { class: "spinner" }), h("p", { class: "state-text" }, text));
}

export function errorBox(message: string, retry?: () => void): HTMLElement {
  return h(
    "div",
    { class: "state state-error" },
    icon("alert", "icon state-icon"),
    h("p", { class: "state-text" }, message),
    retry ? h("button", { class: "btn btn-primary", onclick: retry }, icon("replay"), "Reintentar") : null,
  );
}

export function empty(text: string): HTMLElement {
  return h("div", { class: "state state-empty" }, h("p", { class: "state-text" }, text));
}

/**
 * Carga datos mostrando un estado de carga en `container`; en caso de error muestra
 * el mensaje y un botón "Reintentar". No toca el DOM si la vista ya se abandonó.
 */
export function loadInto<T>(
  container: HTMLElement,
  signal: AbortSignal,
  load: () => Promise<T>,
  render: (data: T) => void,
  loadingText?: string,
): void {
  const run = async () => {
    container.replaceChildren(spinner(loadingText));
    let data: T;
    try {
      data = await load();
    } catch (e) {
      if (!signal.aborted) container.replaceChildren(errorBox(errMsg(e), () => void run()));
      return;
    }
    if (signal.aborted) return;
    container.replaceChildren();
    try {
      render(data);
    } catch (e) {
      console.error(e);
      container.replaceChildren(errorBox(errMsg(e), () => void run()));
    }
  };
  void run();
}

let toastHost: HTMLElement | null = null;

export function toast(message: string, kind: "ok" | "error" | "info" = "info"): void {
  if (!toastHost) {
    toastHost = h("div", { class: "toasts" });
    document.body.append(toastHost);
  }
  const el = h("div", { class: `toast toast-${kind}`, role: "status" }, message);
  toastHost.append(el);
  window.setTimeout(() => {
    el.classList.add("leaving");
    window.setTimeout(() => el.remove(), 260);
  }, kind === "error" ? 5000 : 3200);
}
