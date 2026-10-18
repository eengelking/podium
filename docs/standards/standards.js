// The theme and mode switch on the standards pages (#354). It sets the same attributes on <html> that the app sets
// (data-theme-name, data-theme, data-mode), so every sample is painted by the app's own tokens.css. The choice is
// remembered for these pages only, under its own key, and the pages work without it.
(function () {
  var KEY = "podium.standards.choice";
  var root = document.documentElement;
  var choice = { theme: "podium", mode: "system" };
  try {
    var saved = JSON.parse(localStorage.getItem(KEY));
    if (saved && typeof saved.theme === "string" && /^(light|dark|system)$/.test(saved.mode)) choice = saved;
  } catch (e) {}
  var media = matchMedia("(prefers-color-scheme: dark)");
  function apply() {
    var dark = choice.mode === "dark" || (choice.mode === "system" && media.matches);
    root.dataset.themeName = choice.theme;
    root.dataset.theme = dark ? "dark" : "light";
    root.dataset.mode = choice.mode;
    var sel = document.getElementById("s-theme");
    if (sel) sel.value = choice.theme;
    document.querySelectorAll("#s-mode button").forEach(function (b) { b.setAttribute("aria-checked", String(b.dataset.mode === choice.mode)); });
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(choice)); } catch (e) {} }
  apply();
  document.addEventListener("DOMContentLoaded", function () {
    apply();
    var sel = document.getElementById("s-theme");
    if (sel) sel.addEventListener("change", function () { choice.theme = sel.value; apply(); save(); });
    document.querySelectorAll("#s-mode button").forEach(function (b) { b.addEventListener("click", function () { choice.mode = b.dataset.mode; apply(); save(); }); });
  });
  if (media.addEventListener) media.addEventListener("change", apply);
})();
