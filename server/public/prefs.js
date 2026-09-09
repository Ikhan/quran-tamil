/*
 * Theme and text size.
 *
 * Loaded from <head> without `defer` on purpose: it stamps <html> before the
 * first paint, so a dark-mode user never sees a white flash on the way in. The
 * controls are wired later, once the header exists.
 *
 * Both pages load this; only the dashboard has the buttons, and wiring simply
 * finds nothing on the login page.
 */
(function () {
  const THEME_KEY = "quranReels.theme";
  const SCALE_KEY = "quranReels.fontScale";

  /* Below 0.9 the muted 11px chips stop being legible; above 1.4 the reciter
     rows start wrapping. The step is coarse enough that two clicks are a
     visible change. */
  const MIN_SCALE = 0.9;
  const MAX_SCALE = 1.4;
  const SCALE_STEP = 0.1;
  const DEFAULT_SCALE = 1;

  const root = document.documentElement;

  /* Storage is unavailable in some private-browsing modes; the page must still
     work, just without remembering. */
  const read = (key) => {
    try {
      return window.localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  };

  const write = (key, value) => {
    try {
      window.localStorage.setItem(key, value);
    } catch (error) {
      // Preference is applied for this page load and simply not remembered.
    }
  };

  const systemPrefersDark = () =>
    window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;

  const round = (value) => Math.round(value * 100) / 100;

  const clamp = (value) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));

  const storedScale = () => {
    const raw = Number(read(SCALE_KEY));
    return Number.isFinite(raw) && raw > 0 ? clamp(raw) : DEFAULT_SCALE;
  };

  /* Resolved to a concrete theme rather than left to a media query, so the rest
     of the stylesheet only has one dark selector to honour. */
  const applyTheme = (theme) => {
    root.dataset.theme = theme;
  };

  const applyScale = (scale) => {
    root.style.setProperty("--font-scale", String(scale));
  };

  let theme = read(THEME_KEY) || (systemPrefersDark() ? "dark" : "light");
  let scale = storedScale();

  applyTheme(theme);
  applyScale(scale);

  /* Until the user picks a side, follow the OS if it changes mid-session. */
  window
    .matchMedia?.("(prefers-color-scheme: dark)")
    .addEventListener?.("change", (event) => {
      if (read(THEME_KEY)) {
        return;
      }
      theme = event.matches ? "dark" : "light";
      applyTheme(theme);
      render();
    });

  let controls = null;

  function render() {
    if (!controls) {
      return;
    }

    const dark = theme === "dark";
    controls.toggle.textContent = dark ? "☀" : "☾";
    controls.toggle.title = dark ? "Switch to light" : "Switch to dark";
    controls.toggle.setAttribute(
      "aria-label",
      dark ? "Switch to light theme" : "Switch to dark theme"
    );

    controls.down.disabled = scale <= MIN_SCALE;
    controls.up.disabled = scale >= MAX_SCALE;

    const percent = `${Math.round(scale * 100)}%`;
    controls.down.title = `Smaller text (now ${percent})`;
    controls.up.title = `Larger text (now ${percent})`;
  }

  const setTheme = (next) => {
    theme = next;
    applyTheme(theme);
    write(THEME_KEY, theme);
    render();
  };

  const nudgeScale = (direction) => {
    const next = round(clamp(scale + direction * SCALE_STEP));

    if (next === scale) {
      return;
    }

    scale = next;
    applyScale(scale);
    write(SCALE_KEY, String(scale));
    render();
  };

  const wire = () => {
    const toggle = document.getElementById("themeToggle");
    const down = document.getElementById("fontDown");
    const up = document.getElementById("fontUp");

    if (!toggle || !down || !up) {
      return;
    }

    controls = { toggle, down, up };

    toggle.addEventListener("click", () => {
      setTheme(theme === "dark" ? "light" : "dark");
    });
    down.addEventListener("click", () => nudgeScale(-1));
    up.addEventListener("click", () => nudgeScale(1));

    render();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();
