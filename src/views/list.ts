// "Mi lista": la lista personal al estilo MyAnimeList, con pestañas por estado,
// estadísticas, filtro, orden y edición en línea de estado, nota y progreso.
import type { ListEntry, ListStatus } from "../api";
import * as api from "../api";
import { listMenuItems, loadList, progressStepper, removeEntry, scoreSelect, STATUSES, statusDot, statusSelect } from "../mylist";
import { router, type ViewContext } from "../router";
import { detailRoute } from "../routes";
import { copyText, withMenu } from "../contextmenu";
import { setCrumbs } from "../shell";
import { empty, errMsg, fact, h, icon, poster, skeleton, toast } from "../ui";

type Tab = ListStatus | "all";
type Sort = "updated" | "title" | "score" | "progress";

// Se conservan durante la sesión al volver a la vista.
let tab: Tab = "watching";
let sort: Sort = "updated";
let filter = "";

const SORTS: [Sort, string][] = [
  ["updated", "Última edición"],
  ["title", "Título"],
  ["score", "Nota"],
  ["progress", "Progreso"],
];

export function listView(root: HTMLElement, ctx: ViewContext): void {
  setCrumbs("Mi lista");
  const { signal } = ctx;

  const stats = h("div", { class: "list-stats" });
  const tabs = h("div", { class: "tabs", role: "tablist", attrs: { "aria-label": "Estados" } });
  const body = h("div", { class: "list-body" });

  const filterInput = h("input", {
    type: "search",
    class: "input input-sm list-filter",
    placeholder: "Filtrar por título",
    value: filter,
    spellcheck: false,
    oninput: () => {
      filter = filterInput.value;
      draw();
    },
  });
  const sortSelect: HTMLSelectElement = h(
    "select",
    {
      class: "select select-sm",
      attrs: { "aria-label": "Ordenar" },
      onchange: () => {
        sort = sortSelect.value as Sort;
        draw();
      },
    },
    SORTS.map(([id, label]) => h("option", { value: id, selected: id === sort }, label)),
  );

  root.append(
    h(
      "div",
      { class: "page list-page" },
      h(
        "header",
        { class: "page-head" },
        h("p", { class: "eyebrow" }, "Colección"),
        h("h1", { class: "display" }, "Mi lista"),
        stats,
      ),
      h("div", { class: "list-bar" }, tabs, h("div", { class: "list-tools" }, filterInput, sortSelect)),
      body,
    ),
  );

  let entries: ListEntry[] = [];

  const draw = () => {
    renderStats(stats, entries);
    renderTabs(tabs, entries, (t) => {
      tab = t;
      draw();
    });
    renderTable(body, entries);
  };

  const reload = async () => {
    try {
      entries = await loadList();
      if (!signal.aborted) draw();
    } catch (e) {
      if (!signal.aborted) body.replaceChildren(h("p", { class: "state-text" }, errMsg(e)));
    }
  };

  body.append(skeleton("panels", 4));
  void reload();
  const onChange = () => void reload();
  window.addEventListener(api.LIST_EVENT, onChange);
  signal.addEventListener("abort", () => window.removeEventListener(api.LIST_EVENT, onChange), { once: true });
}

function renderStats(host: HTMLElement, entries: ListEntry[]): void {
  const scored = entries.filter((e) => e.score);
  const mean = scored.length ? scored.reduce((n, e) => n + (e.score ?? 0), 0) / scored.length : null;
  const episodes = entries.reduce((n, e) => n + e.progress, 0);
  // Barra de distribución por estado, como el resumen de MyAnimeList.
  const bar = h(
    "div",
    { class: "dist", attrs: { "aria-hidden": "true" } },
    STATUSES.map((s) => {
      const n = entries.filter((e) => e.status === s.id).length;
      return n ? h("i", { class: `st-${s.id}`, style: `flex:${n}`, title: `${s.label}: ${n}` }) : null;
    }),
  );
  host.replaceChildren(
    h(
      "dl",
      { class: "facts" },
      fact("Animés", String(entries.length)),
      fact("Episodios vistos", String(episodes)),
      fact("Nota media", mean === null ? "—" : mean.toFixed(2)),
      fact("Completados", String(entries.filter((e) => e.status === "completed").length)),
    ),
  );
  if (entries.length) host.append(bar);
}

function renderTabs(host: HTMLElement, entries: ListEntry[], select: (t: Tab) => void): void {
  const count = (t: Tab) => (t === "all" ? entries.length : entries.filter((e) => e.status === t).length);
  const item = (t: Tab, label: string) =>
    h(
      "button",
      {
        class: t === tab ? "tab active" : "tab",
        role: "tab",
        attrs: { "aria-selected": String(t === tab) },
        onclick: () => select(t),
      },
      t === "all" ? null : statusDot(t),
      label,
      h("span", { class: "tab-count" }, String(count(t))),
    );
  host.replaceChildren(item("all", "Todos"), ...STATUSES.map((s) => item(s.id, s.short)));
}

function sorted(entries: ListEntry[]): ListEntry[] {
  const q = filter.trim().toLowerCase();
  const list = entries.filter((e) => (tab === "all" || e.status === tab) && (!q || e.title.toLowerCase().includes(q)));
  const byTitle = (a: ListEntry, b: ListEntry) => a.title.localeCompare(b.title, "es");
  switch (sort) {
    case "title":
      return list.sort(byTitle);
    case "score":
      return list.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || byTitle(a, b));
    case "progress":
      return list.sort((a, b) => b.progress - a.progress || byTitle(a, b));
    default:
      return list.sort((a, b) => b.updatedAt - a.updatedAt);
  }
}

function renderTable(host: HTMLElement, entries: ListEntry[]): void {
  const rows = sorted(entries);
  if (!rows.length) {
    host.replaceChildren(
      entries.length
        ? empty("No hay animés en esta pestaña.", filter ? "Prueba con otro filtro." : undefined)
        : empty(
            "Tu lista está vacía.",
            "Añade animés desde su ficha con «Añadir a mi lista», o empieza a ver uno: se añade solo como «Viendo».",
          ),
    );
    return;
  }
  host.replaceChildren(
    h(
      "div",
      { class: "ltable", role: "table" },
      h(
        "div",
        { class: "lrow lhead", role: "row" },
        h("span", { role: "columnheader" }, "#"),
        h("span", { role: "columnheader" }, "Título"),
        h("span", { role: "columnheader" }, "Nota"),
        h("span", { role: "columnheader" }, "Progreso"),
        h("span", { role: "columnheader" }, "Estado"),
        h("span", { role: "columnheader", attrs: { "aria-label": "Acciones" } }),
      ),
      rows.map((e, i) => row(e, i)),
    ),
  );
}

function row(entry: ListEntry, index: number): HTMLElement {
  // Cada control guarda; la vista se vuelve a dibujar sola con el evento de la lista.
  const onSaved = () => {};
  const open = () => router.navigate(detailRoute(entry.animeUrl));
  const remove: HTMLButtonElement = h(
    "button",
    {
      class: "icon-btn lrow-remove",
      title: "Quitar de mi lista",
      attrs: { "aria-label": `Quitar ${entry.title} de mi lista` },
      onclick: async () => {
        remove.disabled = true;
        try {
          await removeEntry(entry);
        } catch (e) {
          remove.disabled = false;
          toast(errMsg(e), "error");
        }
      },
    },
    icon("trash"),
  );
  const base = { animeUrl: entry.animeUrl, title: entry.title, cover: entry.cover, total: entry.total };
  const rowEl = h(
    "div",
    { class: `lrow st-row-${entry.status}`, role: "row", style: `--i:${Math.min(index, 20)}` },
    h("span", { class: "lrow-num", role: "cell" }, String(index + 1)),
    h(
      "button",
      { class: "lrow-title", role: "cell", title: `Ver ficha de ${entry.title}`, onclick: open },
      poster(entry.cover, entry.title, "lrow-thumb"),
      h(
        "span",
        { class: "lrow-text" },
        h("span", { class: "lrow-name" }, entry.title),
        h("span", { class: "lrow-sub" }, `Editado ${new Date(entry.updatedAt).toLocaleDateString("es", { day: "numeric", month: "short", year: "numeric" })}`),
      ),
    ),
    h("span", { role: "cell" }, scoreSelect(entry, onSaved)),
    h("span", { role: "cell" }, progressStepper(entry, onSaved)),
    h("span", { role: "cell" }, statusSelect(entry, onSaved)),
    h("span", { role: "cell", class: "lrow-actions" }, remove),
  );
  return withMenu(rowEl, () => [
    { label: "Ver ficha y episodios", icon: "list", run: open },
    "-",
    ...listMenuItems(base),
    "-",
    { label: "Copiar título", icon: "copy", run: () => copyText(entry.title) },
  ]);
}
