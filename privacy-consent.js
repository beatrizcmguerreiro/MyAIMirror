(function initialiseSentinelPrivacyConsent() {
  "use strict";

  const STORAGE_KEY = "sentinelPrivacyConsent";
  const CONSENT_VERSION = 2;
  const ROOT_ID = "sentinel-privacy-consent";
  const REVIEW_ROOT_ID = "sentinel-privacy-review";
  const DISMISSED_KEY = "sentinelPrivacyNoticeDismissed";
  const TEMPORARY_CHAT_ATTRIBUTE = "data-sentinel-temporary-chat";
  let reviewObserver = null;
  let temporaryChatActive = false;

  function hasExtensionContext() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  function isLoggedOutChatGpt() {
    const labels = Array.from(document.querySelectorAll('a, button, [role="button"]'))
      .filter(element => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .map(element => String(element.innerText || element.textContent || "")
        .replace(/\s+/g, " ").trim());
    return labels.some(label => /^log in$/i.test(label)) &&
      labels.some(label => /^sign up(?: for free)?$/i.test(label));
  }

  function storageGet(keys) {
    return new Promise(resolve => {
      try {
        if (!hasExtensionContext()) return resolve({});
        chrome.storage.local.get(keys, result => {
          if (chrome.runtime.lastError) return resolve({});
          resolve(result || {});
        });
      } catch {
        resolve({});
      }
    });
  }

  function storageSet(values) {
    return new Promise(resolve => {
      try {
        if (!hasExtensionContext()) return resolve(false);
        chrome.storage.local.set(values, () => {
          if (chrome.runtime.lastError) return resolve(false);
          resolve(true);
        });
      } catch {
        resolve(false);
      }
    });
  }

  function storageRemove(keys) {
    return new Promise(resolve => {
      try {
        if (!hasExtensionContext()) return resolve(false);
        chrome.storage.local.remove(keys, () => {
          if (chrome.runtime.lastError) return resolve(false);
          resolve(true);
        });
      } catch {
        resolve(false);
      }
    });
  }

  function detectTemporaryChat() {
    return Array.from(document.querySelectorAll('button, [role="button"]')).some(element => {
      const label = [
        element.innerText,
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.getAttribute("data-testid")
      ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      if (/turn off temporary chat/i.test(label)) return true;
      return /temporary chat/i.test(label) && (
        element.getAttribute("aria-pressed") === "true" ||
        element.getAttribute("data-state") === "on"
      );
    });
  }

  function updateTemporaryChatMode() {
    const active = detectTemporaryChat();
    document.documentElement.toggleAttribute(TEMPORARY_CHAT_ATTRIBUTE, active);
    if (active === temporaryChatActive) return;
    temporaryChatActive = active;
    window.dispatchEvent(new CustomEvent("sentinel:temporary-chat-change", {
      detail: { active }
    }));
  }

  function findHeaderAnchor() {
    const candidates = Array.from(document.querySelectorAll('button, a, [role="button"]'))
      .filter(element => !element.closest('[role="dialog"]'))
      .map(element => {
        const rect = element.getBoundingClientRect();
        const text = [
          element.innerText,
          element.getAttribute("aria-label"),
          element.getAttribute("data-testid"),
          element.getAttribute("title")
        ].filter(Boolean).join(" ").trim();
        return { element, rect, text };
      })
      .filter(({ rect }) => (
        rect.width > 20 &&
        rect.height > 15 &&
        rect.top < 120 &&
        rect.bottom > 0 &&
        rect.right > window.innerWidth / 2
      ));

    const shareControl = candidates
      .filter(({ text }) => /\bshare\b/i.test(text))
      .sort((a, b) => b.rect.right - a.rect.right || a.rect.top - b.rect.top)[0];
    if (shareControl) return shareControl.element;

    // New Chat has no Share action. Its temporary-chat control is a stable
    // top-right anchor; unlike a generic "right-most" fallback, it cannot
    // accidentally resolve to the central Chat/Work segmented control.
    return candidates
      .filter(({ text }) => /temporary chat/i.test(text))
      .sort((a, b) => b.rect.right - a.rect.right || a.rect.top - b.rect.top)[0]
      ?.element || null;
  }

  function removePrivacyReviewButton() {
    reviewObserver?.disconnect();
    reviewObserver = null;
    document.getElementById(REVIEW_ROOT_ID)?.remove();
  }

  function showPrivacyReviewButton() {
    if (isLoggedOutChatGpt()) {
      removePrivacyReviewButton();
      return;
    }
    if (document.getElementById(REVIEW_ROOT_ID)) return;

    updateTemporaryChatMode();

    const reviewHost = document.createElement("div");
    reviewHost.id = REVIEW_ROOT_ID;
    const reviewShadow = reviewHost.attachShadow({ mode: "open" });
    reviewShadow.innerHTML = `
      <style>
        :host {
          position: fixed;
          inset: 0;
          z-index: 999999;
          pointer-events: none;
          color: #202123;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        button {
          position: fixed;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 32px;
          height: 32px;
          padding: 6px;
          border: 0;
          border-radius: 8px;
          background: transparent;
          color: inherit;
          font: inherit;
          font-size: 14px;
          font-weight: 600;
          line-height: 20px;
          cursor: pointer;
          pointer-events: auto;
        }
        button:hover { background: rgba(0, 0, 0, 0.055); }
        button::after {
          content: attr(data-tooltip);
          position: absolute;
          top: calc(100% + 9px);
          left: 50%;
          z-index: 2;
          padding: 7px 10px;
          border-radius: 8px;
          background: #202123;
          color: #fff;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          font-size: 13px;
          font-weight: 600;
          line-height: 18px;
          white-space: nowrap;
          box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
          opacity: 0;
          visibility: hidden;
          transform: translate(-50%, -2px);
          transition: opacity 120ms ease, transform 120ms ease, visibility 120ms ease;
          pointer-events: none;
        }
        button:hover::after,
        button:focus-visible::after {
          opacity: 1;
          visibility: visible;
          transform: translate(-50%, 0);
        }
        button:focus-visible {
          outline: 2px solid #0a84ff;
          outline-offset: 2px;
        }
        svg {
          width: 20px;
          height: 20px;
          fill: none;
          stroke: currentColor;
          stroke-linecap: round;
          stroke-linejoin: round;
          stroke-width: 1.8;
        }
        @media (prefers-color-scheme: dark) {
          :host { color: #f5f5f7; }
          button:hover { background: rgba(255, 255, 255, 0.1); }
        }
      </style>
      <button id="privacyButton" type="button" aria-label="Review My AI Mirror privacy access" data-tooltip="Review privacy access">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3 19 6v5c0 4.6-2.8 8.2-7 10-4.2-1.8-7-5.4-7-10V6l7-3Z"></path>
          <path d="M9.5 12 11 13.5l3.5-3.5"></path>
        </svg>
      </button>
    `;
    document.documentElement.appendChild(reviewHost);

    window.__sentinelBindShadowTheme?.(reviewShadow);

    const privacyButton = reviewShadow.getElementById("privacyButton");
    let positionFrame = null;
    const positionButton = () => {
      positionFrame = null;
      const headerAnchor = findHeaderAnchor();
      if (!headerAnchor) {
        privacyButton.hidden = true;
        return;
      }

      privacyButton.hidden = false;
      const shareRect = headerAnchor.getBoundingClientRect();
      const shareStyle = getComputedStyle(headerAnchor);
      privacyButton.style.color = shareStyle.color;
      privacyButton.style.fontFamily = shareStyle.fontFamily;
      privacyButton.style.fontSize = shareStyle.fontSize;
      privacyButton.style.fontWeight = shareStyle.fontWeight;
      privacyButton.style.lineHeight = shareStyle.lineHeight;
      privacyButton.style.letterSpacing = shareStyle.letterSpacing;
      const width = privacyButton.offsetWidth || 32;
      const height = privacyButton.offsetHeight || 32;
      privacyButton.style.left = `${Math.max(12, Math.round(shareRect.left - width - 4))}px`;
      privacyButton.style.top = `${Math.max(4, Math.round(shareRect.top + (shareRect.height - height) / 2))}px`;
    };
    const schedulePosition = () => {
      if (positionFrame !== null) return;
      positionFrame = requestAnimationFrame(positionButton);
    };

    privacyButton.addEventListener("click", async () => {
      await storageRemove(STORAGE_KEY);
      sessionStorage.removeItem(DISMISSED_KEY);
      removePrivacyReviewButton();
      showNotice();
    });
    window.addEventListener("resize", schedulePosition, { passive: true });
    reviewObserver = new MutationObserver(() => {
      schedulePosition();
      updateTemporaryChatMode();
    });
    reviewObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-label", "aria-pressed", "data-state", "title"]
    });
    schedulePosition();
  }

  function enableSentinel() {
    if (document.documentElement.dataset.sentinelFeaturesRequested === "true") return;
    if (!hasExtensionContext() || isLoggedOutChatGpt()) return;
    document.documentElement.dataset.sentinelFeaturesRequested = "true";
    try {
      chrome.runtime.sendMessage({ type: "sentinel:enable-page-features" }, response => {
        if (chrome.runtime.lastError || !response?.ok) {
          delete document.documentElement.dataset.sentinelFeaturesRequested;
          return;
        }
      });
    } catch {
        delete document.documentElement.dataset.sentinelFeaturesRequested;
    }
  }

  function showNotice() {
    if (isLoggedOutChatGpt()) return;
    if (document.getElementById(ROOT_ID)) return;
    if (sessionStorage.getItem(DISMISSED_KEY) === "true") {
      showPrivacyReviewButton();
      return;
    }

    const host = document.createElement("div");
    host.id = ROOT_ID;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host {
          position: fixed;
          inset: 0;
          z-index: 2147483647;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          color: #202123;
        }
        .backdrop {
          position: fixed;
          inset: 0;
          display: grid;
          place-items: center;
          padding: 24px;
          background: rgba(0, 0, 0, 0.38);
          backdrop-filter: blur(3px);
          box-sizing: border-box;
        }
        .dialog {
          width: min(440px, calc(100vw - 32px));
          padding: 24px;
          border: 1px solid rgba(0, 0, 0, 0.1);
          border-radius: 20px;
          background: #fff;
          box-shadow: 0 24px 70px rgba(0, 0, 0, 0.24);
          box-sizing: border-box;
        }
        .eyebrow {
          margin: 0 0 7px;
          color: #6b6b70;
          font-size: 12px;
          font-weight: 650;
          letter-spacing: 0.04em;
          text-transform: uppercase;
        }
        h2 {
          margin: 0 0 10px;
          color: #171719;
          font-size: 22px;
          line-height: 1.2;
        }
        .intro {
          margin: 0 0 18px;
          color: #4c4c50;
          font-size: 14px;
          line-height: 1.5;
        }
        ul {
          display: grid;
          gap: 10px;
          margin: 0;
          padding: 0;
          list-style: none;
        }
        li {
          position: relative;
          padding-left: 22px;
          color: #303034;
          font-size: 13px;
          line-height: 1.45;
        }
        li::before {
          content: "";
          position: absolute;
          top: 6px;
          left: 2px;
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #5f5f64;
        }
        .note {
          margin: 18px 0 0;
          padding-top: 14px;
          border-top: 1px solid #e7e7e9;
          color: #77777c;
          font-size: 12px;
          line-height: 1.45;
        }
        .actions {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 9px;
          margin-top: 20px;
        }
        .never {
          margin-right: auto;
          padding-inline: 4px;
          border: 0;
          background: transparent;
          color: #77777c;
          font-size: 12px;
          font-weight: 500;
        }
        .never:hover { color: #303034; }
        button {
          min-height: 40px;
          padding: 8px 16px;
          border-radius: 999px;
          font: inherit;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
        }
        .secondary {
          border: 1px solid #d8d8dc;
          background: #fff;
          color: #303034;
        }
        .primary {
          border: 1px solid #3f3f43;
          background: #4a4a4e;
          color: #fff;
        }
        .primary:hover { background: #3f3f43; }
        button:focus-visible {
          outline: 3px solid rgba(10, 132, 255, 0.45);
          outline-offset: 2px;
        }
        @media (prefers-color-scheme: dark) {
          :host { color: #f5f5f7; }
          .dialog { background: #252527; border-color: rgba(255,255,255,.13); }
          h2 { color: #fff; }
          .intro, li { color: #e1e1e5; }
          .eyebrow, .note { color: #aaaab1; }
          .note { border-color: #414145; }
          .secondary { background: #323235; border-color: #55555a; color: #fff; }
          .never { color: #aaaab1; }
          .never:hover { color: #fff; }
        }
      </style>
      <div class="backdrop">
        <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="sentinelPrivacyTitle" aria-describedby="sentinelPrivacyDescription">
          <p class="eyebrow">Before we begin</p>
          <h2 id="sentinelPrivacyTitle">Would you like to use My AI Mirror?</h2>
          <p class="intro" id="sentinelPrivacyDescription">
            My AI Mirror helps you reflect on how you use AI. To create your personal insights and visualizations, it needs to read the conversations shown in this chatbot.
          </p>
          <ul>
            <li>Analysis happens privately on your device.</li>
            <li>Your messages are never sent to an external analysis service.</li>
            <li>My AI Mirror saves general results and extracted topic labels, not the text of your messages.</li>
            <li>Typing reflection uses only paste and editing counts. Raw keystrokes, draft text, and pasted content are not saved.</li>
          </ul>
          <p class="note">Choose “Not now” to keep My AI Mirror off on this page, or “Don’t ask again” to keep it off until you change your privacy choice in the extension.</p>
          <div class="actions">
            <button class="never" id="neverButton" type="button">Don’t ask again</button>
            <button class="secondary" id="declineButton" type="button">Not now</button>
            <button class="primary" id="allowButton" type="button">Use My AI Mirror</button>
          </div>
        </section>
      </div>
    `;
    document.documentElement.appendChild(host);

    window.__sentinelBindShadowTheme?.(shadow);

    const allowButton = shadow.getElementById("allowButton");
    const declineButton = shadow.getElementById("declineButton");
    const neverButton = shadow.getElementById("neverButton");
    allowButton.focus();

    allowButton.addEventListener("click", async () => {
      allowButton.disabled = true;
      sessionStorage.removeItem(DISMISSED_KEY);
      await storageSet({
        [STORAGE_KEY]: {
          status: "granted",
          version: CONSENT_VERSION,
          grantedAt: new Date().toISOString()
        }
      });
      host.remove();
      showPrivacyReviewButton();
      enableSentinel();
    });

    declineButton.addEventListener("click", () => {
      sessionStorage.setItem(DISMISSED_KEY, "true");
      host.remove();
      if (document.documentElement.dataset.sentinelFeaturesRequested === "true") {
        location.reload();
        return;
      }
      showPrivacyReviewButton();
    });

    neverButton.addEventListener("click", async () => {
      neverButton.disabled = true;
      await storageSet({
        [STORAGE_KEY]: {
          status: "declined",
          version: CONSENT_VERSION,
          declinedAt: new Date().toISOString()
        }
      });
      host.remove();
      if (document.documentElement.dataset.sentinelFeaturesRequested === "true") {
        location.reload();
        return;
      }
      showPrivacyReviewButton();
    });
  }

  storageGet([STORAGE_KEY]).then(stored => {
    const consent = stored[STORAGE_KEY];
    if (consent?.status === "granted" && consent.version === CONSENT_VERSION) {
      showPrivacyReviewButton();
      enableSentinel();
      return;
    }
    if (consent?.status === "declined" && consent.version === CONSENT_VERSION) {
      showPrivacyReviewButton();
      return;
    }
    showNotice();
  });
})();
