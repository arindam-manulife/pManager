(() => {
  "use strict";
  const KEY = "pmanager.theme";
  const root = document.documentElement;

  function preferred() {
    const stored = localStorage.getItem(KEY);
    if (stored === "dark" || stored === "light") return stored;
    if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
      return "dark";
    }
    return "light";
  }

  function apply(theme) {
    root.dataset.theme = theme;
    document.querySelectorAll("#theme-toggle, [data-theme-toggle]").forEach((btn) => {
      btn.textContent = theme === "dark" ? "Light mode" : "Dark mode";
      btn.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
      btn.title = `Switch to ${theme === "dark" ? "light" : "dark"} mode`;
    });
  }

  function toggle() {
    const next = root.dataset.theme === "dark" ? "light" : "dark";
    localStorage.setItem(KEY, next);
    apply(next);
  }

  // Apply immediately to avoid a flash of the wrong theme.
  apply(preferred());

  function wire() {
    document.querySelectorAll("#theme-toggle, [data-theme-toggle]").forEach((btn) => {
      if (btn.dataset.themeBound === "1") return;
      btn.dataset.themeBound = "1";
      btn.addEventListener("click", toggle);
    });
    apply(root.dataset.theme || preferred());
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }

  // React to OS-level changes only if the user hasn't picked one explicitly.
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
      if (localStorage.getItem(KEY)) return;
      apply(e.matches ? "dark" : "light");
    });
  }

  window.PMTheme = { toggle, current: () => root.dataset.theme };
})();
