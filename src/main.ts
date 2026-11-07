import { getVersion } from "@tauri-apps/api/app";
import "./styles.css";
import * as api from "./api";
import type { HistoryEntry } from "./api";
import { cachedAnime, sameUrl } from "./data";
import { router } from "./router";
import { detailRoute, homeRoute, playerRoute, searchRoute, settingsRoute } from "./routes";
import { mountCrumbs } from "./shell";
import { errMsg, h, icon, poster, toast, type IconName } from "./ui";
import { mountUpdater } from "./updater";

// ---------------------------------------------------------------------------
// Distribución (inspirada en Hermes):
//   ┌──────────┬────────────────────────────────────────────┐
//   │ sidebar  │ ┌ barra del panel: ‹  Inicio / Ficha …  ┐ │
//   │ marca    │ │                                        │ │
//   │ buscar   │ │  vista                                 │ │
//   │ nav      │ │                                        │ │
//   │ biblio-  │ │                                        │ │
//   │ teca     │ └────────────────────────────────────────┘ │
//   │ versión  │                                            │
//   └──────────┴────────────────────────────────────────────┘
// ---------------------------------------------------------------------------

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

// ---- Marca ----
const brand = h(
  "button",
  { class: "brand", title: "Inicio", onclick: () => router.navigate(homeRoute()) },
  h("span", { class: "brand-mark", attrs: { "aria-hidden": "true" } }, icon("play")),
  h("span", { class: "wordmark" }, "Anime", h("span", { class: "wordmark-dim" }, "Watcher")),
);

// ---- Búsqueda ----
const searchInput = h("input", {
  type: "search",
  class: "search-input",
  placeholder: "Buscar animé",
  spellcheck: false,
  autocomplete: "off",
  attrs: { "aria-label": "Buscar animé" },
  onkeydown: (e) => {
    if (e.key === "Escape") searchInput.blur();
  },
});

const searchForm = h(
  "form",
  {
    class: "search",
    role: "search",
    onsubmit: (e: SubmitEvent) => {
      e.preventDefault();
      const query = searchInput.value.trim();
      if (!query) return;
      searchInput.blur();
      router.navigate(searchRoute(query));
    },
  },
  icon("search", "icon search-icon"),
  searchInput,
  h("kbd", { class: "kbd search-kbd", attrs: { "aria-hidden": "true" } }, isMac ? "⌘K" : "Ctrl K"),
);

// ---- Navegación ----
const navRow = (label: string, name: IconName, onClick: () => void) =>
  h("button", { class: "side-row", onclick: onClick }, icon(name), h("span", { class: "side-row-label" }, label));

const homeBtn = navRow("Inicio", "home", () => router.navigate(homeRoute()));
const settingsBtn = navRow("Ajustes", "settings", () => router.navigate(settingsRoute()));

// ---- Biblioteca (Continuar viendo) ----
const libraryList = h("div", { class: "library", role: "list" });
const libraryCount = h("span", { class: "side-count" });
let libraryEntries: HistoryEntry[] = [];
let currentAnimeUrl: string | null = null;

function libraryRow(entry: HistoryEntry): HTMLElement {
  const remove: HTMLButtonElement = h(
    "button",
    {
      class: "lib-remove",
      title: "Quitar de Continuar viendo",
      attrs: { "aria-label": `Quitar ${entry.title}` },
      onclick: async (e) => {
        e.stopPropagation();
        remove.disabled = true;
        try {
          await api.historyRemove(entry.animeUrl);
        } catch (err) {
          remove.disabled = false;
          toast(errMsg(err), "error");
        }
      },
    },
    icon("x"),
  );
  const active = currentAnimeUrl !== null && sameUrl(entry.animeUrl, currentAnimeUrl);
  return h(
    "div",
    {
      class: active ? "lib-row active" : "lib-row",
      role: "listitem",
      tabIndex: 0,
      title: `${entry.title} · Episodio ${entry.lastEpisode} (doble clic para continuar)`,
      onclick: () => router.navigate(detailRoute(entry.animeUrl)),
      ondblclick: () => router.navigate(playerRoute(entry.lastEpisodeUrl, cachedAnime(entry.animeUrl))),
      onkeydown: (e) => {
        if (e.target === e.currentTarget && e.key === "Enter") router.navigate(detailRoute(entry.animeUrl));
      },
    },
    poster(entry.cover, entry.title, "lib-thumb"),
    h("span", { class: "lib-title" }, entry.title),
    h("span", { class: "lib-ep", title: `Episodio ${entry.lastEpisode}` }, `EP ${entry.lastEpisode}`),
    remove,
  );
}

function renderLibrary(): void {
  libraryCount.textContent = libraryEntries.length ? String(libraryEntries.length) : "";
  if (!libraryEntries.length) {
    libraryList.replaceChildren(h("p", { class: "side-empty" }, "Lo que empieces a ver aparecerá aquí."));
    return;
  }
  libraryList.replaceChildren(...libraryEntries.map(libraryRow));
}

async function loadLibrary(): Promise<void> {
  try {
    const list = await api.historyList();
    libraryEntries = list.sort((a, b) => b.updatedAt - a.updatedAt);
    renderLibrary();
  } catch (e) {
    libraryList.replaceChildren(h("p", { class: "side-empty side-error" }, errMsg(e)));
  }
}
window.addEventListener(api.HISTORY_EVENT, () => void loadLibrary());

// ---- Pie de la barra lateral ----
const version = h("span", { class: "side-version" });
getVersion().then(
  (v) => {
    version.textContent = `v${v}`;
  },
  () => {},
);
const updateCard = h("aside", { class: "update-card", hidden: true, role: "status", attrs: { "aria-label": "Actualización" } });

const sidebar = h(
  "aside",
  { class: "sidebar", attrs: { "aria-label": "Barra lateral" } },
  h("div", { class: "side-top" }, brand),
  searchForm,
  h("nav", { class: "side-nav", attrs: { "aria-label": "Principal" } }, homeBtn, settingsBtn),
  h(
    "div",
    { class: "side-section" },
    h("div", { class: "side-heading" }, h("span", null, "Continuar viendo"), libraryCount),
    libraryList,
  ),
  updateCard,
  h("footer", { class: "side-foot" }, h("span", null, "por EvilRender23"), version),
);

// ---- Panel principal ----
const backBtn = h(
  "button",
  { class: "icon-btn", title: "Atrás (Alt+←)", disabled: true, attrs: { "aria-label": "Atrás" }, onclick: () => router.back() },
  icon("back"),
);
const crumbs = h("nav", { class: "crumbs", attrs: { "aria-label": "Ubicación" } });
mountCrumbs(crumbs);
const view = h("main", { class: "view", id: "contenido" });
const pane = h("section", { class: "pane" }, h("header", { class: "pane-bar" }, backBtn, crumbs), view);

const app = document.getElementById("app") ?? document.body;
app.classList.add("shell");
app.append(sidebar, pane);
mountUpdater(updateCard);
void loadLibrary();

router.onChange((route, canGoBack) => {
  backBtn.disabled = !canGoBack;
  for (const [btn, section] of [
    [homeBtn, "home"],
    [settingsBtn, "settings"],
  ] as const) {
    const on = route.section === section;
    btn.classList.toggle("active", on);
    if (on) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  }
  // Resalta en la biblioteca el animé de la ficha abierta (el reproductor avisa con aw:now-playing).
  if (route.section !== "player") {
    currentAnimeUrl = route.key.startsWith("detail:") ? route.key.slice("detail:".length) : null;
  }
  renderLibrary();
  view.scrollTo(0, 0);
});

window.addEventListener("aw:now-playing", (e) => {
  currentAnimeUrl = (e as CustomEvent<string | null>).detail;
  renderLibrary();
});

// Botón "atrás" del ratón, Alt+← y Ctrl/⌘+K para buscar.
window.addEventListener("mousedown", (e) => {
  if (e.button === 3 || e.button === 4) e.preventDefault();
});
window.addEventListener("mouseup", (e) => {
  if (e.button === 3) {
    e.preventDefault();
    router.back();
  }
});
window.addEventListener("keydown", (e) => {
  if (e.altKey && e.key === "ArrowLeft") {
    e.preventDefault();
    router.back();
  } else if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
});

router.mount(view, homeRoute());
