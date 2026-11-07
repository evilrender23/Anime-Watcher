import "./styles.css";
import { router } from "./router";
import { homeRoute, searchRoute, settingsRoute } from "./routes";
import { h, icon } from "./ui";

const backBtn = h(
  "button",
  { class: "icon-btn topbar-back", title: "Atrás (Alt+←)", disabled: true, onclick: () => router.back() },
  icon("back"),
);

const brand = h(
  "button",
  { class: "brand", title: "Inicio", onclick: () => router.navigate(homeRoute()) },
  h("span", { class: "brand-mark" }, icon("play")),
  h("span", { class: "brand-name" }, "anicli", h("span", { class: "brand-accent" }, "-es")),
);

const searchInput = h("input", {
  type: "search",
  class: "search-input",
  placeholder: "Buscar animé…",
  spellcheck: false,
  autocomplete: "off",
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
);

const homeBtn = h("button", { class: "nav-btn", onclick: () => router.navigate(homeRoute()) }, icon("home"), "Inicio");
const settingsBtn = h(
  "button",
  { class: "nav-btn", onclick: () => router.navigate(settingsRoute()) },
  icon("settings"),
  "Ajustes",
);

const view = h("main", { class: "view" });
const app = document.getElementById("app") ?? document.body;
app.append(
  h("header", { class: "topbar" }, backBtn, brand, searchForm, h("nav", { class: "nav" }, homeBtn, settingsBtn)),
  view,
);

router.onChange((route, canGoBack) => {
  backBtn.disabled = !canGoBack;
  homeBtn.classList.toggle("active", route.section === "home");
  settingsBtn.classList.toggle("active", route.section === "settings");
});

// Botón "atrás" del ratón y Alt+←.
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
  }
});

router.mount(view, homeRoute());
