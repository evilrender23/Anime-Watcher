import * as api from "../api";
import type { EpisodeCard, HistoryEntry } from "../api";
import { cachedAnime } from "../data";
import { router, type ViewContext } from "../router";
import { detailRoute, playerRoute, searchRoute } from "../routes";
import { copyText, withMenu } from "../contextmenu";
import { listMenuItems } from "../mylist";
import { setCrumbs } from "../shell";
import { clock, continueLabel, empty, fact, h, icon, kbd, loadInto, poster, skeleton } from "../ui";

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

export function homeView(root: HTMLElement, ctx: ViewContext): void {
  const { signal } = ctx;
  setCrumbs("Inicio");

  const lead = h("div", { class: "home-lead" });
  const latestBody = h("div");
  const latestCount = h("span", { class: "rule-count" });

  root.append(
    h(
      "div",
      { class: "page home-page" },
      lead,
      h(
        "section",
        { class: "block" },
        h(
          "header",
          { class: "rule" },
          h("h2", { class: "rule-title" }, "Últimos episodios"),
          latestCount,
          h("span", { class: "rule-line", attrs: { "aria-hidden": "true" } }),
          h("span", { class: "rule-note" }, "Recién publicados"),
        ),
        latestBody,
      ),
    ),
  );

  const renderLead = async () => {
    try {
      const list = await api.historyList();
      if (signal.aborted) return;
      list.sort((a, b) => b.updatedAt - a.updatedAt);
      lead.replaceChildren(list[0] ? resumePanel(list[0], list.length) : welcome());
    } catch {
      if (!signal.aborted) lead.replaceChildren(welcome());
    }
  };
  void renderLead();
  const onHistory = () => void renderLead();
  window.addEventListener(api.HISTORY_EVENT, onHistory);
  signal.addEventListener("abort", () => window.removeEventListener(api.HISTORY_EVENT, onHistory), { once: true });

  loadInto(
    latestBody,
    signal,
    api.latest,
    (list) => {
      latestCount.textContent = String(list.length);
      latestBody.append(
        list.length
          ? h("div", { class: "grid grid-wide" }, list.map((ep, i) => latestCard(ep, i)))
          : empty("No hay episodios recientes.", "Vuelve a intentarlo en unos minutos o busca un animé."),
      );
    },
    "Cargando últimos episodios…",
    () => skeleton("wide", 8, "Cargando últimos episodios…"),
  );
}

function welcome(): HTMLElement {
  return h(
    "section",
    { class: "welcome" },
    h("p", { class: "eyebrow" }, "Anime Watcher"),
    h("h1", { class: "display" }, "¿Qué vas a ver hoy?"),
    h(
      "p",
      { class: "lede" },
      "Busca un animé por su nombre o elige uno de los episodios recién publicados. Lo que empieces a ver se guarda en la barra lateral para continuar donde lo dejaste.",
    ),
    h("p", { class: "hint" }, kbd(isMac ? "⌘" : "Ctrl"), kbd("K"), h("span", null, "para buscar")),
  );
}

/** Panel destacado con el último animé visto: portada + datos + acciones. */
function resumePanel(entry: HistoryEntry, total: number): HTMLElement {
  const watched = entry.watched.length;
  const when = relativeTime(entry.updatedAt);
  const panel = h(
    "section",
    { class: "resume", attrs: { "aria-label": "Seguir viendo" } },
    h(
      "button",
      { class: "resume-cover", title: `Ver ficha de ${entry.title}`, onclick: () => router.navigate(detailRoute(entry.animeUrl)) },
      poster(entry.cover, entry.title, "ratio-poster"),
    ),
    h(
      "div",
      { class: "resume-body" },
      h("p", { class: "eyebrow" }, "Seguir viendo", h("span", { class: "eyebrow-dim" }, `· ${when}`)),
      h("h1", { class: "display" }, entry.title),
      h(
        "dl",
        { class: "facts" },
        fact("Último", `EP ${entry.lastEpisode}${entry.position ? ` · ${clock(entry.position)}` : ""}`),
        fact("Vistos", String(watched)),
        fact("En biblioteca", String(total)),
      ),
      h(
        "div",
        { class: "actions" },
        h(
          "button",
          {
            class: "btn btn-primary",
            onclick: () => router.navigate(playerRoute(entry.lastEpisodeUrl, cachedAnime(entry.animeUrl))),
          },
          icon("play"),
          continueLabel(entry),
        ),
        h("button", { class: "btn", onclick: () => router.navigate(detailRoute(entry.animeUrl)) }, icon("list"), "Episodios"),
      ),
    ),
  );
  return withMenu(panel, () => [
    {
      label: continueLabel(entry),
      icon: "play",
      run: () => router.navigate(playerRoute(entry.lastEpisodeUrl, cachedAnime(entry.animeUrl))),
    },
    { label: "Ver ficha y episodios", icon: "list", run: () => router.navigate(detailRoute(entry.animeUrl)) },
    "-",
    ...listMenuItems({ animeUrl: entry.animeUrl, title: entry.title, cover: entry.cover, total: null }),
    "-",
    { label: "Copiar título", icon: "copy", run: () => copyText(entry.title) },
  ]);
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.round(diff / 60_000);
  if (min < 1) return "ahora";
  if (min < 60) return `hace ${min} min`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.round(hours / 24);
  if (days === 1) return "ayer";
  if (days < 30) return `hace ${days} días`;
  return new Date(ms).toLocaleDateString("es", { day: "numeric", month: "short" });
}

function latestCard(ep: EpisodeCard, index: number): HTMLElement {
  const tile = h(
    "button",
    {
      class: "tile",
      title: `${ep.title} · Episodio ${ep.number}`,
      style: `--i:${Math.min(index, 16)}`,
      onclick: () => router.navigate(playerRoute(ep.url)),
    },
    h("div", { class: "tile-media" }, poster(ep.thumb, ep.title, "ratio-wide"), h("span", { class: "tile-play" }, icon("play"))),
    h(
      "div",
      { class: "tile-caption" },
      h("span", { class: "tile-title" }, ep.title),
      h("span", { class: "tile-meta" }, `EP ${String(ep.number).padStart(2, "0")}`),
    ),
  );
  return withMenu(tile, () => [
    { label: `Ver episodio ${ep.number}`, icon: "play", run: () => router.navigate(playerRoute(ep.url)) },
    { label: "Buscar este animé", icon: "search", run: () => router.navigate(searchRoute(ep.title)) },
    "-",
    { label: "Copiar título", icon: "copy", run: () => copyText(ep.title) },
    { label: "Copiar enlace del episodio", icon: "link", run: () => copyText(ep.url) },
  ]);
}
