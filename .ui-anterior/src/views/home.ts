import * as api from "../api";
import type { EpisodeCard, HistoryEntry } from "../api";
import { cachedAnime } from "../data";
import { router, type ViewContext } from "../router";
import { detailRoute, playerRoute } from "../routes";
import { empty, errMsg, errorBox, h, icon, loadInto, poster, toast } from "../ui";

export function homeView(root: HTMLElement, ctx: ViewContext): void {
  const { signal } = ctx;

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
    h("div", { class: "section-head" }, h("h2", { class: "section-title" }, "Últimos episodios")),
    latestBody,
  );

  root.append(h("div", { class: "page" }, historySection, latestSection));

  const loadHistory = async () => {
    try {
      const list = await api.historyList();
      if (signal.aborted) return;
      list.sort((a, b) => b.updatedAt - a.updatedAt);
      historySection.hidden = list.length === 0;
      historyBody.replaceChildren(...list.map((entry) => historyCard(entry, loadHistory)));
    } catch (e) {
      if (signal.aborted) return;
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
          : empty("No hay episodios recientes."),
      );
    },
    "Cargando últimos episodios…",
  );
}

function historyCard(entry: HistoryEntry, refresh: () => Promise<void>): HTMLElement {
  const openDetail = () => router.navigate(detailRoute(entry.animeUrl));

  const removeBtn = h(
    "button",
    {
      class: "icon-btn card-remove",
      title: "Quitar de Continuar viendo",
      onclick: async (e) => {
        e.stopPropagation();
        removeBtn.disabled = true;
        try {
          await api.historyRemove(entry.animeUrl);
          await refresh();
        } catch (err) {
          removeBtn.disabled = false;
          toast(errMsg(err), "error");
        }
      },
    },
    icon("x"),
  );

  const playBtn = h(
    "button",
    {
      class: "play-fab",
      title: `Ver episodio ${entry.lastEpisode}`,
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
      h("span", { class: "badge badge-ep" }, `EP ${ep.number}`),
      h("span", { class: "card-play" }, icon("play")),
    ),
    h("div", { class: "card-body" }, h("div", { class: "card-title" }, ep.title)),
  );
}
