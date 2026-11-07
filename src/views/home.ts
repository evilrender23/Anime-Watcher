import * as api from "../api";
import type { EpisodeCard, HistoryEntry } from "../api";
import { cachedAnime } from "../data";
import { router, type ViewContext } from "../router";
import { detailRoute, playerRoute } from "../routes";
import { empty, errMsg, errorBox, h, icon, loadInto, poster, skeleton, toast } from "../ui";

export function homeView(root: HTMLElement, ctx: ViewContext): void {
  const { signal } = ctx;

  const heroSlot = h("div", { class: "hero-slot" });

  const historyBody = h("div", { class: "row-scroll" });
  const historySection = h(
    "section",
    { class: "section", hidden: true },
    h("div", { class: "section-head" }, h("h2", { class: "section-title" }, "Continuar viendo")),
    historyBody,
  );

  const latestBody = h("div");
  const latestSection = h(
    "section",
    { class: "section" },
    h(
      "div",
      { class: "section-head" },
      h("h2", { class: "section-title" }, "Últimos episodios"),
      h("span", { class: "section-note" }, "Recién publicados"),
    ),
    latestBody,
  );

  root.append(h("div", { class: "page home-page" }, heroSlot, historySection, latestSection));

  const loadHistory = async () => {
    try {
      const list = await api.historyList();
      if (signal.aborted) return;
      list.sort((a, b) => b.updatedAt - a.updatedAt);
      const [first, ...rest] = list;
      heroSlot.replaceChildren(first ? heroCard(first, loadHistory) : welcome());
      historySection.hidden = rest.length === 0;
      historyBody.replaceChildren(...rest.map((entry) => historyCard(entry, loadHistory)));
    } catch (e) {
      if (signal.aborted) return;
      heroSlot.replaceChildren();
      historySection.hidden = false;
      historyBody.replaceChildren(errorBox(errMsg(e), () => void loadHistory()));
    }
  };
  void loadHistory();

  loadInto(
    latestBody,
    signal,
    api.latest,
    (list) => {
      latestBody.append(
        list.length
          ? h("div", { class: "grid grid-wide" }, list.map(latestCard))
          : empty("No hay episodios recientes.", "Vuelve a intentarlo en unos minutos o busca un animé arriba."),
      );
    },
    "Cargando últimos episodios…",
    () => skeleton("wide", 8, "Cargando últimos episodios…"),
  );
}

async function removeEntry(entry: HistoryEntry, btn: HTMLButtonElement, refresh: () => Promise<void>): Promise<void> {
  btn.disabled = true;
  try {
    await api.historyRemove(entry.animeUrl);
    await refresh();
  } catch (err) {
    btn.disabled = false;
    toast(errMsg(err), "error");
  }
}

function welcome(): HTMLElement {
  return h(
    "section",
    { class: "welcome" },
    h("p", { class: "eyebrow" }, "Bienvenido"),
    h("h1", { class: "welcome-title" }, "¿Qué vas a ver hoy?"),
    h(
      "p",
      { class: "welcome-text" },
      "Busca un animé por su nombre o elige uno de los últimos episodios. Lo que empieces a ver aparecerá aquí para continuar donde lo dejaste.",
    ),
  );
}

/** Bloque destacado con el animé visto más recientemente. */
function heroCard(entry: HistoryEntry, refresh: () => Promise<void>): HTMLElement {
  const backdrop: HTMLElement[] = [];
  if (entry.cover) {
    const img = document.createElement("img");
    img.className = "hero-backdrop";
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.addEventListener("error", () => img.remove(), { once: true });
    img.src = entry.cover;
    backdrop.push(img);
  }

  const removeBtn: HTMLButtonElement = h(
    "button",
    {
      class: "btn btn-ghost",
      title: "Quitar de Continuar viendo",
      onclick: () => void removeEntry(entry, removeBtn, refresh),
    },
    icon("x"),
    "Quitar",
  );

  const watchedCount = entry.watched.length;

  return h(
    "section",
    { class: "hero", attrs: { "aria-label": "Seguir viendo" } },
    backdrop,
    h(
      "div",
      { class: "hero-inner" },
      h(
        "button",
        { class: "hero-cover", title: `Ver ficha de ${entry.title}`, onclick: () => router.navigate(detailRoute(entry.animeUrl)) },
        poster(entry.cover, entry.title, "ratio-poster"),
      ),
      h(
        "div",
        { class: "hero-info" },
        h("p", { class: "eyebrow" }, "Seguir viendo"),
        h("h1", { class: "hero-title" }, entry.title),
        h(
          "p",
          { class: "hero-meta" },
          h("span", { class: "hero-ep" }, `Episodio ${entry.lastEpisode}`),
          watchedCount > 0
            ? h("span", null, ` · ${watchedCount} ${watchedCount === 1 ? "episodio visto" : "episodios vistos"}`)
            : null,
        ),
        h(
          "div",
          { class: "hero-actions" },
          h(
            "button",
            {
              class: "btn btn-primary btn-lg",
              onclick: () => router.navigate(playerRoute(entry.lastEpisodeUrl, cachedAnime(entry.animeUrl))),
            },
            icon("play"),
            `Continuar · Episodio ${entry.lastEpisode}`,
          ),
          h("button", { class: "btn btn-lg", onclick: () => router.navigate(detailRoute(entry.animeUrl)) }, icon("list"), "Ver ficha"),
          removeBtn,
        ),
      ),
    ),
  );
}

function historyCard(entry: HistoryEntry, refresh: () => Promise<void>): HTMLElement {
  const openDetail = () => router.navigate(detailRoute(entry.animeUrl));

  const removeBtn: HTMLButtonElement = h(
    "button",
    {
      class: "icon-btn card-remove",
      title: "Quitar de Continuar viendo",
      attrs: { "aria-label": `Quitar ${entry.title} de Continuar viendo` },
      onclick: (e) => {
        e.stopPropagation();
        void removeEntry(entry, removeBtn, refresh);
      },
    },
    icon("x"),
  );

  const playBtn = h(
    "button",
    {
      class: "play-fab",
      title: `Ver episodio ${entry.lastEpisode}`,
      attrs: { "aria-label": `Ver ${entry.title}, episodio ${entry.lastEpisode}` },
      onclick: (e) => {
        e.stopPropagation();
        router.navigate(playerRoute(entry.lastEpisodeUrl, cachedAnime(entry.animeUrl)));
      },
    },
    icon("play"),
  );

  return h(
    "div",
    {
      class: "card hist-card",
      tabIndex: 0,
      role: "button",
      title: entry.title,
      onclick: openDetail,
      onkeydown: (e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          openDetail();
        }
      },
    },
    h("div", { class: "card-media" }, poster(entry.cover, entry.title, "ratio-poster"), removeBtn, playBtn),
    h(
      "div",
      { class: "card-body" },
      h("div", { class: "card-title" }, entry.title),
      h("div", { class: "card-meta accent" }, `Episodio ${entry.lastEpisode}`),
    ),
  );
}

function latestCard(ep: EpisodeCard): HTMLElement {
  return h(
    "button",
    { class: "card ep-card", title: `${ep.title} · Episodio ${ep.number}`, onclick: () => router.navigate(playerRoute(ep.url)) },
    h(
      "div",
      { class: "card-media" },
      poster(ep.thumb, ep.title, "ratio-wide"),
      h("span", { class: "card-play" }, icon("play")),
    ),
    h(
      "div",
      { class: "card-body card-body-row" },
      h("div", { class: "card-title" }, ep.title),
      h("span", { class: "badge badge-ep" }, `EP ${ep.number}`),
    ),
  );
}
