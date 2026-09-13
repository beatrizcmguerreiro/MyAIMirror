(function initialisePostResponseReflection() {
  "use strict";

  if (window.__sentinelPostResponseReflectionLoaded) return;
  window.__sentinelPostResponseReflectionLoaded = true;

  const STORAGE_KEY = "sentinelPostResponseReflectionsV1";
  const PREFERENCE_KEY = "visualizationPreferences";
  const HOST_ID = "sentinel-post-response-reflection";
  const STABLE_RESPONSE_MS = 1200;
  const MAX_RECORDS = 250;
  const CHOICES = [
    { value: "understand", label: "It clarified something" },
    { value: "own-thinking", label: "It prompted my own thinking" },
    { value: "question-further", label: "I want to question it further" },
    { value: "accepted", label: "I accepted it as given" }
  ];

  let enabled = true;
  let reconcileTimer = null;
  let lastResponseElement = null;
  let lastResponseLength = -1;
  let lastResponseChangedAt = 0;
  let lastPathname = location.pathname;

  function hasExtensionContext() {
    return Boolean(globalThis.chrome?.runtime?.id);
  }

  function storageGet(keys) {
    return new Promise(resolve => {
      if (!hasExtensionContext()) return resolve({});
      try {
        chrome.storage.local.get(keys, result => {
          if (chrome.runtime.lastError) return resolve({});
          resolve(result || {});
        });
      } catch {
        resolve({});
      }
    });
  }

  function storageSet(value) {
    return new Promise(resolve => {
      if (!hasExtensionContext()) return resolve(false);
      try {
        chrome.storage.local.set(value, () => {
          resolve(!chrome.runtime.lastError);
        });
      } catch {
        resolve(false);
      }
    });
  }

  function conversationKey() {
    const match = location.pathname.match(/^\/c\/([^/?#]+)/);
    return match ? `/c/${match[1]}` : null;
  }

  async function sha256Fingerprint(value) {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 32);
  }

  async function conversationStorageId(key = conversationKey()) {
    return key ? sha256Fingerprint(`${location.hostname}|${key}`) : null;
  }

  function isTemporaryChat() {
    return document.documentElement.hasAttribute("data-sentinel-temporary-chat") ||
      location.pathname.startsWith("/temporary-chat");
  }

  function assistantMessages() {
    return Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'))
      .filter(element => !element.closest(`#${HOST_ID}`));
  }

  function responseTurn(message) {
    return message.closest('article[data-testid^="conversation-turn"]') ||
      message.closest('[data-testid^="conversation-turn"]') ||
      message.parentElement;
  }

  function isGenerating() {
    return Array.from(document.querySelectorAll("button")).some(button => {
      const label = `${button.getAttribute("aria-label") || ""} ${button.textContent || ""}`;
      return /stop (generating|responding)/i.test(label);
    });
  }

  function removeCard() {
    document.getElementById(HOST_ID)?.remove();
  }

  function alignCardToResponse(host, responseElement) {
    if (!host?.isConnected || !responseElement?.isConnected) return;
    const hostRect = host.getBoundingClientRect();
    const responseRect = responseElement.getBoundingClientRect();
    if (!hostRect.width || !responseRect.width) return;

    const width = Math.min(responseRect.width, hostRect.width);
    const availableOffset = Math.max(0, hostRect.width - width);
    const offset = Math.min(
      availableOffset,
      Math.max(0, responseRect.left - hostRect.left)
    );
    host.style.setProperty("--sentinel-reply-width", `${width}px`);
    host.style.setProperty("--sentinel-reply-offset", `${offset}px`);
  }

  function responseKey(id, index) {
    return `${id}:${index}`;
  }

  async function existingChoice(id, index) {
    const stored = await storageGet(STORAGE_KEY);
    const records = Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
    return records.find(record => record.key === responseKey(id, index))?.choice || null;
  }

  async function saveChoice(id, index, choice) {
    const stored = await storageGet(STORAGE_KEY);
    const records = Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
    const key = responseKey(id, index);
    const record = {
      key,
      conversationId: id,
      responseIndex: index,
      choice,
      createdAt: Date.now()
    };
    const next = records.filter(item => item?.key !== key);
    next.push(record);
    return storageSet({ [STORAGE_KEY]: next.slice(-MAX_RECORDS) });
  }

  function createCard(id, index, selectedChoice, responseElement) {
    const host = document.createElement("div");
    host.id = HOST_ID;
    host.dataset.responseIndex = String(index);
    const replyText = responseElement.querySelector("p, li") || responseElement;
    const replyStyle = getComputedStyle(replyText);
    host.style.setProperty(
      "--sentinel-reply-font-family",
      replyStyle.fontFamily || "inherit"
    );
    host.style.setProperty(
      "--sentinel-reply-font-size",
      replyStyle.fontSize || "1rem"
    );
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host {
          display: block;
          width: 100%;
          box-sizing: border-box;
        }
        * { box-sizing: border-box; }
        .frame {
          width: var(--sentinel-reply-width, min(100%, 48rem));
          margin: -12px 0 28px var(--sentinel-reply-offset, auto);
          font-family: var(--sentinel-reply-font-family, inherit);
          font-size: var(--sentinel-reply-font-size, 1rem);
          color: #1d1d1f;
          -webkit-font-smoothing: antialiased;
        }
        .card {
          border: 1px solid rgba(0, 0, 0, .065);
          border-radius: 18px;
          background: #f7f7f8;
          padding: 18px 20px 17px;
          box-shadow: 0 1px 2px rgba(0, 0, 0, .02);
        }
        .eyebrow {
          margin: 0 0 6px;
          color: #8e8e93;
          font-size: 11px;
          font-weight: 650;
          letter-spacing: .06em;
          text-transform: uppercase;
        }
        .question {
          margin: 0 0 14px;
          font-size: inherit;
          font-weight: 650;
          line-height: 1.3;
        }
        .choices {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }
        button {
          appearance: none;
          min-height: 34px;
          border: 1px solid #e1e1e5;
          border-radius: 999px;
          background: #fff;
          color: #3a3a3c;
          cursor: pointer;
          font: inherit;
          font-size: inherit;
          line-height: 1.2;
          padding: 7px 12px;
          transition: background 140ms ease, border-color 140ms ease, color 140ms ease, transform 140ms ease;
        }
        button:hover { background: #f0f0f2; }
        button:active { transform: scale(.98); }
        button[aria-pressed="true"] {
          border-color: #48484a;
          background: #48484a;
          color: #fff;
        }
        button:focus-visible {
          outline: 2px solid rgba(72, 72, 74, .45);
          outline-offset: 2px;
        }
        .status {
          position: absolute;
          width: 1px;
          height: 1px;
          padding: 0;
          margin: -1px;
          overflow: hidden;
          clip: rect(0, 0, 0, 0);
          white-space: nowrap;
          border: 0;
        }
        @media (prefers-color-scheme: dark) {
          .frame { color: #f2f2f2; }
          .card { background: #2c2c2e; border-color: rgba(255,255,255,.1); box-shadow: none; }
          .eyebrow { color: #98989d; }
          button { color: #f2f2f2; background: #3a3a3c; border-color: #48484a; }
          button:hover { background: #48484a; }
          button[aria-pressed="true"] { color: #fff; background: #5c5c60; border-color: #5c5c60; }
        }
        :host([data-sentinel-theme="dark"]) .frame { color: #f2f2f2; }
        :host([data-sentinel-theme="dark"]) .card {
          background: #2c2c2e;
          border-color: rgba(255,255,255,.1);
          box-shadow: none;
        }
        :host([data-sentinel-theme="dark"]) .eyebrow { color: #98989d; }
        :host([data-sentinel-theme="dark"]) button {
          color: #f2f2f2;
          background: #3a3a3c;
          border-color: #48484a;
        }
        :host([data-sentinel-theme="dark"]) button:hover { background: #48484a; }
        :host([data-sentinel-theme="dark"]) button[aria-pressed="true"] {
          color: #fff;
          background: #5c5c60;
          border-color: #6a6a70;
        }
      </style>
      <div class="frame">
        <section class="card" aria-label="Post-response reflection">
          <p class="eyebrow">Response reflection</p>
          <p class="question">How did this response affect your thinking?</p>
          <div class="choices" role="group" aria-label="Choose what changed after this response"></div>
          <p class="status" aria-live="polite"></p>
        </section>
      </div>
    `;

    window.__sentinelBindShadowTheme?.(shadow);

    const choices = shadow.querySelector(".choices");
    const status = shadow.querySelector(".status");
    let saving = false;
    CHOICES.forEach(choice => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = choice.label;
      button.dataset.choice = choice.value;
      button.setAttribute("aria-pressed", String(selectedChoice === choice.value));
      button.addEventListener("click", async () => {
        if (saving) return;
        saving = true;
        choices.querySelectorAll("button").forEach(item => {
          item.setAttribute("aria-pressed", String(item === button));
          item.disabled = true;
        });
        status.textContent = "Saving reflection";
        const saved = await saveChoice(id, index, choice.value);
        status.textContent = saved === false
          ? "Reflection could not be saved"
          : "Reflection saved";
        choices.querySelectorAll("button").forEach(item => { item.disabled = false; });
        saving = false;
      });
      choices.appendChild(button);
    });
    if (selectedChoice) {
      status.textContent = "Previously saved reflection";
    }
    return host;
  }

  async function reconcile() {
    reconcileTimer = null;
    if (!enabled || isTemporaryChat()) {
      removeCard();
      return;
    }

    const key = conversationKey();
    const messages = assistantMessages();
    const latest = messages.at(-1);
    if (!key || !latest || isGenerating()) {
      removeCard();
      return;
    }

    const length = (latest.innerText || latest.textContent || "").trim().length;
    if (!length) {
      removeCard();
      return;
    }
    if (latest !== lastResponseElement || length !== lastResponseLength) {
      lastResponseElement = latest;
      lastResponseLength = length;
      lastResponseChangedAt = Date.now();
      removeCard();
      scheduleReconcile(STABLE_RESPONSE_MS + 80);
      return;
    }
    if (Date.now() - lastResponseChangedAt < STABLE_RESPONSE_MS) {
      scheduleReconcile(STABLE_RESPONSE_MS);
      return;
    }

    const turn = responseTurn(latest);
    if (!turn?.parentNode) return;
    const index = messages.length;
    const id = await conversationStorageId(key);
    if (!id || key !== conversationKey()) return;
    const current = document.getElementById(HOST_ID);
    if (current?.dataset.responseIndex === String(index) && current.previousElementSibling === turn) {
      alignCardToResponse(current, latest);
      return;
    }
    removeCard();
    const selected = await existingChoice(id, index);
    if (!enabled || key !== conversationKey()) return;
    const card = createCard(id, index, selected, latest);
    turn.insertAdjacentElement("afterend", card);
    alignCardToResponse(card, latest);
  }

  function scheduleReconcile(delay = 180) {
    clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(reconcile, delay);
  }

  async function loadPreferences() {
    const stored = await storageGet(PREFERENCE_KEY);
    enabled = stored[PREFERENCE_KEY]?.responseReflection !== false;
    scheduleReconcile(0);
  }

  if (hasExtensionContext()) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[PREFERENCE_KEY]) return;
      enabled = changes[PREFERENCE_KEY].newValue?.responseReflection !== false;
      scheduleReconcile(0);
    });
  }

  document.addEventListener("sentinel:conversation-data-removed", async event => {
    const deletedConversationKey = event.detail?.conversationKey;
    if (!deletedConversationKey || !hasExtensionContext()) return;
    const deletedConversationId = await conversationStorageId(deletedConversationKey);

    const stored = await storageGet(STORAGE_KEY);
    const records = Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
    const remainingRecords = records.filter(record =>
      record?.conversationId !== deletedConversationId
    );

    if (remainingRecords.length !== records.length) {
      await storageSet({ [STORAGE_KEY]: remainingRecords });
    }
    if (conversationKey() === deletedConversationKey) removeCard();
  });

  const observer = new MutationObserver(() => {
    if (location.pathname !== lastPathname) {
      lastPathname = location.pathname;
      lastResponseElement = null;
      lastResponseLength = -1;
      lastResponseChangedAt = 0;
      removeCard();
    }
    scheduleReconcile();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  window.addEventListener("popstate", () => scheduleReconcile(0));
  loadPreferences();
})();
