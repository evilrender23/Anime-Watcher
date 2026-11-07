import * as api from "../api";
import type { AnimeCard } from "../api";
import { router, type ViewContext } from "../router";
import { detailRoute } from "../routes";
import { empty, h, loadInto, poster, skeleton } from "../ui";

export function searchView(root: HTMLElement, ctx: ViewContext, query: string): void {
  const sub = h("p", { class: "page-sub" }, "Buscando…");
  const body = h("div");
  root.append(
    h(
      "div",
      { class: "page" },
      h(
        "div",
        { class: "page-head" },
        h("p", { class: "eyebrow" }, "Resultados de búsqueda"),
        h("h1", { class: "page-title" }, `“${query}”`),
        sub,
      ),
      body,
    ),
  );

  loadInto(
    body,
    ctx.signal,
    () => api.search(query),
    (list) => {
      if (!list.length) {
        sub.textContent = "0 resultados";
        body.append(
          empty(
            "No se encontró ningún animé con ese nombre.",
            "Prueba con el título en japonés o en romaji, o con una sola palabra clave.",
          ),
        );
        return;
      }
      sub.textContent = `${list.length} ${list.length === 1 ? "resultado" : "resultados"}`;
      body.append(h("div", { class: "grid grid-posters" }, list.map(animeCard)));
    },
    "Buscando…",
    () => skeleton("posters", 14, "Buscando…"),
  );
}

function animeCard(anime: AnimeCard): HTMLElement {
  const meta = [anime.year, anime.kind, anime.genre].filter((part): part is string => !!part && !!part.trim());
  return h(
    "button",
    { class: "card anime-card", title: anime.title, onclick: () => router.navigate(detailRoute(anime.url)) },
    h("div", { class: "card-media" }, poster(anime.cover, anime.title, "ratio-poster")),
    h(
      "div",
      { class: "card-body" },
      h("div", { class: "card-title" }, anime.title),
      meta.length ? h("div", { class: "card-meta" }, meta.join(" · ")) : null,
    ),
  );
}
