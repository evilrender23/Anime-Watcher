import * as api from "../api";
import type { AnimeCard } from "../api";
import { router, type ViewContext } from "../router";
import { detailRoute, homeRoute } from "../routes";
import { copyText, withMenu } from "../contextmenu";
import { listMenuItems } from "../mylist";
import { setCrumbs } from "../shell";
import { groupByFranchise, seasonInfo } from "../seasons";
import { SOURCES, sourceOf } from "../sources";
import { empty, h, loadInto, poster, skeleton } from "../ui";

export function searchView(root: HTMLElement, ctx: ViewContext, query: string): void {
  setCrumbs({ label: "Inicio", onClick: () => router.navigate(homeRoute()) }, "Búsqueda");
  const body = h("div", { class: "search-sources" });
  root.append(
    h(
      "div",
      { class: "page" },
      h(
        "header",
        { class: "page-head" },
        h("p", { class: "eyebrow" }, "Resultados para"),
        h("h1", { class: "display" }, `“${query}”`),
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
        body.append(
          empty(
            "No se encontró ningún animé con ese nombre en MonosChinos ni en JKAnime.",
            "Prueba con el título en japonés o en romaji, o con una sola palabra clave.",
          ),
        );
        return;
      }
      // Una sección por fuente: el mismo animé puede estar en las dos con distintos servidores.
      // Dentro de cada fuente, las temporadas de una misma serie van juntas y en orden.
      for (const source of SOURCES) {
        const items = list.filter((a) => sourceOf(a.url).id === source.id);
        if (!items.length) continue;
        const { groups, singles } = groupByFranchise(items);
        const section = h(
          "section",
          { class: "block" },
          h(
            "header",
            { class: "rule" },
            h("h2", { class: "rule-title" }, source.name),
            h("span", { class: "rule-count" }, String(items.length)),
            h("span", { class: "rule-line", attrs: { "aria-hidden": "true" } }),
          ),
        );
        let n = 0;
        for (const group of groups) {
          section.append(
            h(
              "div",
              { class: "franchise" },
              h(
                "h3",
                { class: "franchise-head" },
                h("span", { class: "franchise-name" }, group.name),
                h("span", { class: "rule-count" }, `${group.items.length} entregas`),
              ),
              h("div", { class: "grid grid-posters" }, group.items.map((a) => animeCard(a, n++, true))),
            ),
          );
        }
        if (singles.length) {
          section.append(
            h(
              "div",
              { class: "franchise" },
              groups.length ? h("h3", { class: "franchise-head" }, h("span", { class: "franchise-name" }, "Otros resultados")) : null,
              h("div", { class: "grid grid-posters" }, singles.map((a) => animeCard(a, n++))),
            ),
          );
        }
        body.append(section);
      }
    },
    "Buscando en MonosChinos y JKAnime…",
    () => skeleton("posters", 14, "Buscando…"),
  );
}

function animeCard(anime: AnimeCard, index: number, inFranchise = false): HTMLElement {
  const meta = [anime.kind, anime.year].filter((part): part is string => !!part && !!part.trim());
  const season = inFranchise ? seasonInfo(anime.title, anime.kind) : null;
  const tile = h(
    "button",
    {
      class: "tile",
      title: anime.title,
      style: `--i:${Math.min(index, 16)}`,
      onclick: () => router.navigate(detailRoute(anime.url)),
    },
    h(
      "div",
      { class: "tile-media" },
      poster(anime.cover, anime.title, "ratio-poster"),
      season ? h("span", { class: `season-badge season-${season.category}` }, season.label) : null,
    ),
    h(
      "div",
      { class: "tile-caption tile-caption-stack" },
      h("span", { class: "tile-title" }, anime.title),
      meta.length ? h("span", { class: "tile-meta" }, meta.join(" · ")) : null,
      anime.genre ? h("span", { class: "tile-sub" }, anime.genre) : null,
    ),
  );
  return withMenu(tile, () => [
    { label: "Ver ficha y episodios", icon: "list", run: () => router.navigate(detailRoute(anime.url)) },
    "-",
    ...listMenuItems({ animeUrl: anime.url, title: anime.title, cover: anime.cover, total: null }),
    "-",
    { label: "Copiar título", icon: "copy", run: () => copyText(anime.title) },
    { label: "Copiar enlace", icon: "link", run: () => copyText(anime.url) },
  ]);
}
