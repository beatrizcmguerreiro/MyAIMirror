(function initialiseSentinelThemeSupport() {
  "use strict";

  if (window.__sentinelBindShadowTheme) return;

  const THEME_ATTRIBUTE = "data-sentinel-page-theme";
  const boundRoots = new Map();

  function declaredTheme() {
    const elements = [document.documentElement, document.body].filter(Boolean);
    for (const element of elements) {
      const declaration = [
        element.getAttribute("data-theme"),
        element.getAttribute("data-color-scheme"),
        element.getAttribute("data-mode"),
        element.getAttribute("color-scheme")
      ].filter(Boolean).join(" ").toLowerCase();
      const classes = Array.from(element.classList || [])
        .join(" ")
        .toLowerCase();
      if (/\b(dark|night)\b/.test(`${declaration} ${classes}`)) return "dark";
      if (/\b(light|day)\b/.test(`${declaration} ${classes}`)) return "light";
    }
    return null;
  }

  function backgroundIsDark() {
    for (const element of [document.body, document.documentElement]) {
      if (!element) continue;
      const value = getComputedStyle(element).backgroundColor;
      const match = value.match(/rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)(?:\s*[,/]\s*([\d.]+))?/i);
      if (!match || (match[4] !== undefined && Number(match[4]) === 0)) continue;
      const red = Number(match[1]);
      const green = Number(match[2]);
      const blue = Number(match[3]);
      return red * 0.2126 + green * 0.7152 + blue * 0.0722 < 128;
    }
    return null;
  }

  function pageUsesDarkTheme() {
    const declared = declaredTheme();
    if (declared) return declared === "dark";

    const colourScheme = getComputedStyle(document.documentElement).colorScheme;
    if (/\bdark\b/i.test(colourScheme) && !/\blight\b/i.test(colourScheme)) {
      return true;
    }

    const darkBackground = backgroundIsDark();
    return darkBackground === null
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
      : darkBackground;
  }

  function findDarkMediaRules(shadowRoot) {
    const rules = [];
    shadowRoot.querySelectorAll("style").forEach(style => {
      try {
        Array.from(style.sheet?.cssRules || []).forEach(rule => {
          if (/prefers-color-scheme\s*:\s*dark/i.test(rule.conditionText || "")) {
            rules.push(rule);
          }
        });
      } catch {
        // Inline extension styles are normally readable. A component still
        // keeps its light palette if a host browser blocks CSSOM access.
      }
    });
    return rules;
  }

  function applyTheme() {
    const dark = pageUsesDarkTheme();
    const theme = dark ? "dark" : "light";
    if (document.documentElement.getAttribute(THEME_ATTRIBUTE) !== theme) {
      document.documentElement.setAttribute(THEME_ATTRIBUTE, theme);
    }

    boundRoots.forEach((rules, shadowRoot) => {
      if (!shadowRoot?.host) {
        boundRoots.delete(shadowRoot);
        return;
      }
      shadowRoot.host.setAttribute("data-sentinel-theme", theme);
      rules.forEach(rule => {
        rule.media.mediaText = dark ? "all" : "not all";
      });
    });
  }

  window.__sentinelBindShadowTheme = shadowRoot => {
    if (!(shadowRoot instanceof ShadowRoot)) return;
    const rules = findDarkMediaRules(shadowRoot);
    boundRoots.set(shadowRoot, rules);
    applyTheme();
  };

  const observer = new MutationObserver(applyTheme);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style", "data-theme", "data-color-scheme", "data-mode", "color-scheme"]
  });
  if (document.body) {
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme", "data-color-scheme", "data-mode", "color-scheme"]
    });
  }
  window.matchMedia("(prefers-color-scheme: dark)")
    .addEventListener?.("change", applyTheme);
  applyTheme();
})();
