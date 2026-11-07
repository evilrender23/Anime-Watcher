// Lista personal al estilo MyAnimeList: estados, notas del 1 al 10 y progreso.
// Controles reutilizables por la vista "Mi lista" y por la ficha del animé.
import * as api from "./api";
import type { ListEntry, ListStatus, ListUpdate } from "./api";
import { sameUrl } from "./data";
import { errMsg, h, icon, toast } from "./ui";

export const STATUSES: { id: ListStatus; label: string; short: string }[] = [
  { id: "watching", label: "Viendo", short: "Viendo" },
  { id: "completed", label: "Completado", short: "Completados" },
  { id: "on_hold", label: "En espera", short: "En espera" },
  { id: "dropped", label: "Abandonado", short: "Abandonados" },
  { id: "plan_to_watch", label: "Planeo ver", short: "Planeo ver" },
];

export const statusLabel = (s: ListStatus) => STATUSES.find((x) => x.id === s)?.label ?? s;

/** Escala de MyAnimeList. */
export const SCORES: [number, string][] = [
  [10, "Obra maestra"],
  [9, "Excelente"],
  [8, "Muy bueno"],
  [7, "Bueno"],
  [6, "Aceptable"],
  [5, "Normal"],
  [4, "Malo"],
  [3, "Muy malo"],
  [2, "Horrible"],
  [1, "Atroz"],
];

// ---- Caché ----

let cache: ListEntry[] | null = null;
let pending: Promise<ListEntry[]> | null = null;
window.addEventListener(api.LIST_EVENT, () => {
  // Descarta también una carga en curso: podría traer datos de antes del cambio.
  cache = null;
  pending = null;
});

/** Lista completa (en caché hasta el siguiente cambio). */
export function loadList(): Promise<ListEntry[]> {
  if (cache) return Promise.resolve(cache);
  if (pending) return pending;
  const request: Promise<ListEntry[]> = api.listAll().then(
    (list) => {
      if (pending === request) {
        cache = list;
        pending = null;
      }
      return list;
    },
    (e: unknown) => {
      if (pending === request) pending = null;
      throw e;
    },
  );
  pending = request;
  return request;
}

const toUpdate = (e: ListEntry | ListUpdate): ListUpdate => ({
  animeUrl: e.animeUrl,
  title: e.title,
  cover: e.cover,
  status: e.status,
  score: e.score,
  progress: e.progress,
  total: e.total,
  notes: e.notes,
});

/**
 * Guarda un cambio aplicando las reglas de MyAnimeList: subir episodios desde
 * "Planeo ver" pasa a "Viendo"; llegar al total pasa a "Completado".
 */
export async function saveEntry(entry: ListEntry | ListUpdate, patch: Partial<ListUpdate>): Promise<ListEntry> {
  const next = { ...toUpdate(entry), ...patch };
  if (patch.progress !== undefined && patch.status === undefined) {
    if (next.status === "plan_to_watch" && next.progress > 0) next.status = "watching";
    if (next.status === "watching" && next.total && next.progress >= next.total) {
      next.status = "completed";
      toast(`«${next.title}» marcado como completado.`, "ok");
    }
  }
  return api.listSave(next);
}

export async function removeEntry(entry: ListEntry): Promise<void> {
  await api.listRemove(entry.animeUrl);
  toast(`«${entry.title}» quitado de tu lista.`, "info");
}

// ---- Controles ----

type OnSaved = (entry: ListEntry) => void;

async function guarded(el: HTMLElement & { disabled: boolean }, run: () => Promise<void>): Promise<void> {
  el.disabled = true;
  try {
    await run();
  } catch (e) {
    toast(errMsg(e), "error");
  } finally {
    el.disabled = false;
  }
}

export function statusSelect(entry: ListEntry, onSaved: OnSaved): HTMLSelectElement {
  const select: HTMLSelectElement = h(
    "select",
    {
      class: `select select-status st-${entry.status}`,
      title: "Estado",
      attrs: { "aria-label": `Estado de ${entry.title}` },
      onchange: () =>
        void guarded(select, async () => onSaved(await saveEntry(entry, { status: select.value as ListStatus }))),
    },
    STATUSES.map((s) => h("option", { value: s.id, selected: s.id === entry.status }, s.label)),
  );
  return select;
}

export function scoreSelect(entry: ListEntry, onSaved: OnSaved): HTMLSelectElement {
  const select: HTMLSelectElement = h(
    "select",
    {
      class: entry.score ? "select select-score" : "select select-score is-empty",
      title: "Nota",
      attrs: { "aria-label": `Nota de ${entry.title}` },
      onchange: () =>
        void guarded(select, async () => onSaved(await saveEntry(entry, { score: select.value ? Number(select.value) : null }))),
    },
    h("option", { value: "", selected: !entry.score }, "Sin nota"),
    SCORES.map(([n, label]) => h("option", { value: String(n), selected: entry.score === n }, `${n} · ${label}`)),
  );
  return select;
}

/** "− 3 / 12 +" con barra de progreso. */
export function progressStepper(entry: ListEntry, onSaved: OnSaved): HTMLElement {
  const set = (btn: HTMLButtonElement, value: number) => {
    const max = entry.total ?? Infinity;
    const progress = Math.max(0, Math.min(max, value));
    if (progress === entry.progress) return;
    void guarded(btn, async () => onSaved(await saveEntry(entry, { progress })));
  };
  const minus: HTMLButtonElement = h(
    "button",
    {
      class: "step-btn",
      title: "Un episodio menos",
      disabled: entry.progress <= 0,
      attrs: { "aria-label": "Un episodio menos" },
      onclick: () => set(minus, entry.progress - 1),
    },
    "−",
  );
  const plus: HTMLButtonElement = h(
    "button",
    {
      class: "step-btn",
      title: "Un episodio más",
      disabled: entry.total !== null && entry.progress >= entry.total,
      attrs: { "aria-label": "Un episodio más" },
      onclick: () => set(plus, entry.progress + 1),
    },
    "+",
  );
  const fraction = entry.total ? Math.min(1, entry.progress / entry.total) : 0;
  return h(
    "div",
    { class: "stepper" },
    h(
      "div",
      { class: "stepper-row" },
      minus,
      h(
        "span",
        { class: "stepper-value" },
        h("strong", null, String(entry.progress)),
        h("span", { class: "stepper-total" }, ` / ${entry.total ?? "?"}`),
      ),
      plus,
    ),
    h("span", { class: "meter", attrs: { "aria-hidden": "true" } }, h("i", { style: `--p:${fraction}` })),
  );
}

/** Punto de color del estado. */
export const statusDot = (status: ListStatus) => h("i", { class: `dot st-${status}`, attrs: { "aria-hidden": "true" } });

/**
 * Panel de la ficha: "Añadir a mi lista" o, si ya está, estado / nota / progreso.
 * `base` describe el animé; `watchedGuess` es el progreso sugerido al añadirlo.
 */
export function listPanel(base: Omit<ListUpdate, "status" | "score" | "progress" | "notes">, watchedGuess: number): HTMLElement {
  const box = h("section", { class: "list-panel", attrs: { "aria-label": "Mi lista" } });

  const render = (entry: ListEntry | null) => {
    if (!entry) {
      const add: HTMLButtonElement = h(
        "button",
        {
          class: "btn list-add",
          onclick: () =>
            void guarded(add, async () => {
              const status: ListStatus = watchedGuess > 0 ? "watching" : "plan_to_watch";
              render(await saveEntry({ ...base, status, score: null, progress: watchedGuess, notes: "" }, {}));
              toast(`Añadido a tu lista como «${statusLabel(status)}».`, "ok");
            }),
        },
        icon("plus"),
        "Añadir a mi lista",
      );
      box.replaceChildren(add);
      return;
    }
    const onSaved = (e: ListEntry) => render(e);
    const remove: HTMLButtonElement = h(
      "button",
      {
        class: "list-remove",
        title: "Quitar de mi lista",
        onclick: () =>
          void guarded(remove, async () => {
            await removeEntry(entry);
            render(null);
          }),
      },
      "Quitar",
    );
    box.replaceChildren(
      h("header", { class: "list-panel-head" }, statusDot(entry.status), h("span", null, "En mi lista"), remove),
      h("label", { class: "list-field" }, h("span", null, "Estado"), statusSelect(entry, onSaved)),
      h("label", { class: "list-field" }, h("span", null, "Nota"), scoreSelect(entry, onSaved)),
      h("div", { class: "list-field" }, h("span", null, "Progreso"), progressStepper(entry, onSaved)),
    );
  };

  box.append(h("div", { class: "skel skel-line skel-w80" }));
  loadList().then(
    (list) => render(list.find((e) => sameUrl(e.animeUrl, base.animeUrl)) ?? null),
    (e: unknown) => box.replaceChildren(h("p", { class: "side-empty side-error" }, errMsg(e))),
  );
  return box;
}
