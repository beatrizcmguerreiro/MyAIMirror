(function initialiseVisualizationControls() {
  "use strict";

  const STORAGE_KEY = "visualizationPreferences";
  const ROOT_ID = "sentinel-visualization-controls";
  const DEFAULTS = Object.freeze({
    chatColors: true,
    triggerMinimap: true,
    draftTone: true,
    newChatIntentions: true,
    newChatWriting: true,
    newChatReflection: true,
    responseReflection: true
  });
  const ANALYSIS_DELAY_MS = 400;
  const MINIMUM_DRAFT_LENGTH = 3;
  const VERY_NEGATIVE_SCORE = 0.9;
  const NEW_CHAT_SUGGESTION_ATTRIBUTE = "data-sentinel-hide-new-chat-suggestion";
  const NEW_CHAT_SUGGESTION_LABELS = new Set([
    "Create an image",
    "Write or edit",
    "Look something up"
  ]);

  let preferences = { ...DEFAULTS };
  let composer = null;
  let analysisTimer = null;
  let analysisSequence = 0;
  let lastAnalyzedText = "";
  let lastSentiment = null;
  let influentialWord = null;
  let positionFrame = null;

  function hasExtensionContext() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
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

  function isVisible(element) {
    if (!element?.isConnected) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 40 && rect.height > 15;
  }

  function findTopBarAction(kind) {
    const candidates = Array.from(
      document.querySelectorAll('button, a, [role="button"]')
    )
      .filter(element => element.isConnected && !element.closest('[role="dialog"]'))
      .map(element => {
        const rect = element.getBoundingClientRect();
        const text = [
          element.innerText,
          element.getAttribute("aria-label"),
          element.getAttribute("data-testid")
        ].filter(Boolean).join(" ").trim();
        return { element, rect, text };
      })
      .filter(({ rect }) => (
        rect.width > 20 &&
        rect.height > 15 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < 120
      ));

    const matches = candidates.filter(({ text }) => {
      if (kind === "share") return /\bshare\b/i.test(text);
      return /(^|\s)(more|menu|options|overflow)(\s|$)/i.test(text) || /^\.{3}$/.test(text);
    });

    matches.sort((a, b) => b.rect.right - a.rect.right || a.rect.top - b.rect.top);
    return matches[0]?.element || null;
  }

  function findComposer() {
    const selectors = [
      "#prompt-textarea",
      '[data-testid="composer-text-input"]',
      'textarea[placeholder*="Ask"]',
      'textarea[placeholder*="Message"]',
      '[contenteditable="true"][role="textbox"]',
      'form [contenteditable="true"]',
      'div.ProseMirror[contenteditable="true"]',
      '[contenteditable="true"]',
      "textarea"
    ];

    for (const selector of selectors) {
      const candidates = Array.from(document.querySelectorAll(selector))
        .filter(isVisible)
        .filter(element => !element.closest('[role="dialog"]'))
        .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
      const candidate = candidates[0];
      if (candidate) return candidate;
    }
    return null;
  }

  function getDraftText(element = composer) {
    if (!element) return "";
    const value = element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
      ? element.value
      : element.innerText || element.textContent;
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function isSentinelTemporarilyDisabled() {
    return document.documentElement.hasAttribute("data-sentinel-temporary-chat");
  }

  function isChatGptNewChatScreen() {
    const path = location.pathname.replace(/\/+$/, "") || "/";
    return (
      (location.hostname === "chatgpt.com" || location.hostname === "chat.openai.com") &&
      path === "/" &&
      !document.querySelector('[data-message-author-role]')
    );
  }

  function applyNewChatSuggestionVisibility() {
    const existing = document.querySelectorAll(`[${NEW_CHAT_SUGGESTION_ATTRIBUTE}]`);
    if (!isChatGptNewChatScreen()) {
      existing.forEach(element => element.removeAttribute(NEW_CHAT_SUGGESTION_ATTRIBUTE));
      return;
    }

    Array.from(document.querySelectorAll("button, a, [role='button']"))
      .filter(element => NEW_CHAT_SUGGESTION_LABELS.has(
        String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim()
      ))
      .forEach(element => element.setAttribute(NEW_CHAT_SUGGESTION_ATTRIBUTE, ""));
  }

  if (!document.getElementById("sentinel-new-chat-heading-style")) {
    const newChatHeadingStyle = document.createElement("style");
    newChatHeadingStyle.id = "sentinel-new-chat-heading-style";
    newChatHeadingStyle.textContent = `
      [${NEW_CHAT_SUGGESTION_ATTRIBUTE}] {
        display: none !important;
      }
    `;
    document.head.appendChild(newChatHeadingStyle);
  }

  const host = document.createElement("div");
  host.id = ROOT_ID;
  host.style.display = "none";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host {
        position: fixed;
        inset: 0;
        z-index: 1000000;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #2f2f2f;
        pointer-events: none;
      }
      .visuals-anchor {
        position: fixed;
        pointer-events: auto;
      }
      .visuals-button {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        border: 0;
        background: transparent;
        color: inherit;
        border-radius: 8px;
        min-height: 32px;
        padding: 6px 8px;
        font-family: inherit;
        font-size: 14px;
        font-weight: 600;
        line-height: 20px;
        box-shadow: none;
        cursor: pointer;
      }
      .visuals-button:hover {
        background: rgba(0, 0, 0, 0.055);
      }
      .visuals-icon {
        width: 18px;
        height: 18px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.8;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .visuals-button:focus-visible,
      input:focus-visible {
        outline: 2px solid #0a84ff;
        outline-offset: 2px;
      }
      .tone {
        position: fixed;
        display: block;
        width: 14px;
        height: 14px;
        padding: 0;
        border: 2px solid rgba(255, 255, 255, 0.95);
        border-radius: 50%;
        background: #d1d1d6;
        box-sizing: border-box;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
        pointer-events: none;
      }
      .tone[hidden] { display: none; }
      .tone[data-state="positive"] { background: #34c759; }
      .tone[data-state="neutral"] { background: #d1d1d6; }
      .tone[data-state="negative"] { background: #ff9500; }
      .tone[data-state="very-negative"] { background: #ff3b30; }
      .tone[data-state="loading"],
      .tone[data-state="error"] {
        background: #f7f7f8;
        border-color: #dedee2;
      }
      .word-underline {
        position: fixed;
        display: none;
        height: 2px;
        border-radius: 999px;
        background: #8e8e93;
        pointer-events: none;
      }
      .word-underline[data-state="positive"] { background: #34c759; }
      .word-underline[data-state="neutral"] { background: #d1d1d6; }
      .word-underline[data-state="negative"] { background: #ff9500; }
      .word-underline[data-state="very-negative"] { background: #ff3b30; }
      .sr-only {
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
      .panel {
        position: absolute;
        top: calc(100% + 8px);
        right: 0;
        width: 232px;
        padding: 10px;
        border: 1px solid rgba(0, 0, 0, 0.09);
        border-radius: 16px;
        background: rgba(255, 255, 255, 0.99);
        box-shadow: 0 14px 36px rgba(0, 0, 0, 0.13);
        box-sizing: border-box;
      }
      .panel[hidden] { display: none; }
      .heading {
        margin: 0;
        padding: 6px 8px 10px;
        font-size: 13px;
        font-weight: 600;
      }
      .option {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 14px;
        min-height: 40px;
        padding: 5px 8px;
        border-radius: 9px;
        box-sizing: border-box;
        font-size: 13px;
        cursor: pointer;
      }
      .option:hover { background: rgba(0, 0, 0, 0.045); }
      .option-title { font-size: 13px; font-weight: 400; }
      .switch {
        position: relative;
        flex: 0 0 auto;
        width: 32px;
        height: 19px;
        margin: 0;
        border: 0;
        border-radius: 999px;
        appearance: none;
        -webkit-appearance: none;
        background: #c7c7cc;
        cursor: pointer;
        transition: background-color 140ms ease;
      }
      .switch::after {
        content: "";
        position: absolute;
        top: 2px;
        left: 2px;
        width: 15px;
        height: 15px;
        border-radius: 50%;
        background: #fff;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
        transition: transform 140ms ease;
      }
      .switch:checked { background: #22a447; }
      .switch:checked::after { transform: translateX(13px); }
      @media (prefers-reduced-motion: reduce) {
        .switch, .switch::after { transition: none; }
      }
      @media (prefers-color-scheme: dark) {
        :host { color: #f5f5f7; }
        .panel {
          background: rgba(42, 42, 44, 0.97);
          border-color: rgba(255, 255, 255, 0.13);
        }
        .visuals-button { background: transparent; }
        .visuals-button:hover { background: rgba(255, 255, 255, 0.1); }
        .option:hover { background: rgba(255, 255, 255, 0.08); }
        .switch { background: #636366; }
        .switch:checked { background: #30b85a; }
      }
    </style>
    <div class="visuals-anchor" id="visualsAnchor">
      <button class="visuals-button" id="visualsButton" type="button" aria-label="Choose visualizations" title="Choose visualizations" aria-expanded="false" aria-controls="visualsPanel">
        <svg class="visuals-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 7h10M18 7h2M4 17h2M10 17h10"></path>
          <circle cx="16" cy="7" r="2"></circle>
          <circle cx="8" cy="17" r="2"></circle>
        </svg>
      </button>
      <div class="panel" id="visualsPanel" hidden>
        <p class="heading">Visualizations</p>
        <label class="option">
          <span class="option-title">Prompt tone preview</span>
          <input class="switch" id="draftToneToggle" type="checkbox">
        </label>
        <label class="option">
          <span class="option-title">Chat colours</span>
          <input class="switch" id="chatColorsToggle" type="checkbox">
        </label>
        <label class="option" id="minimapOption">
          <span class="option-title">Conversation minimap</span>
          <input class="switch" id="minimapToggle" type="checkbox">
        </label>
        <label class="option">
          <span class="option-title">Interaction focus</span>
          <input class="switch" id="newChatIntentionsToggle" type="checkbox">
        </label>
        <label class="option">
          <span class="option-title">Writing process</span>
          <input class="switch" id="newChatWritingToggle" type="checkbox">
        </label>
        <label class="option">
          <span class="option-title">Prompt tone</span>
          <input class="switch" id="newChatReflectionToggle" type="checkbox">
        </label>
        <label class="option">
          <span class="option-title">Post-response reflection</span>
          <input class="switch" id="responseReflectionToggle" type="checkbox">
        </label>
      </div>
    </div>
    <span class="tone" id="toneIndicator" data-state="idle" aria-hidden="true"></span>
    <span class="word-underline" id="wordUnderline" data-state="idle" aria-hidden="true"></span>
    <span class="sr-only" id="toneStatus" aria-live="polite">Prompt tone preview waiting</span>
  `;
  document.documentElement.appendChild(host);

  window.__sentinelBindShadowTheme?.(shadow);

  const visualsAnchor = shadow.getElementById("visualsAnchor");
  const visualsButton = shadow.getElementById("visualsButton");
  const visualsPanel = shadow.getElementById("visualsPanel");
  const toneIndicator = shadow.getElementById("toneIndicator");
  const wordUnderline = shadow.getElementById("wordUnderline");
  const toneStatus = shadow.getElementById("toneStatus");
  const draftToneToggle = shadow.getElementById("draftToneToggle");
  const chatColorsToggle = shadow.getElementById("chatColorsToggle");
  const minimapToggle = shadow.getElementById("minimapToggle");
  const newChatIntentionsToggle = shadow.getElementById("newChatIntentionsToggle");
  const newChatWritingToggle = shadow.getElementById("newChatWritingToggle");
  const newChatReflectionToggle = shadow.getElementById("newChatReflectionToggle");
  const responseReflectionToggle = shadow.getElementById("responseReflectionToggle");

  function setToneState(state, label) {
    toneIndicator.dataset.state = state;
    toneIndicator.textContent = "";
    wordUnderline.dataset.state = state;
    toneStatus.textContent = label;
  }

  function resetToneState() {
    lastAnalyzedText = "";
    lastSentiment = null;
    influentialWord = null;
    wordUnderline.style.display = "none";
    setToneState("idle", "Prompt tone preview waiting");
  }

  function displaySentiment(sentiment) {
    const toneState = sentiment?.label === "negative" &&
      Number(sentiment.score) >= VERY_NEGATIVE_SCORE
      ? "very-negative"
      : sentiment?.label;
    const states = {
      positive: { label: "Positive wording estimate", emoji: "🙂" },
      neutral: { label: "Neutral wording estimate", emoji: "😐" },
      negative: { label: "Negative wording estimate", emoji: "🙁" }
    };
    const presentation = states[toneState === "very-negative" ? "negative" : toneState];
    if (!presentation) {
      setToneState("error", "Prompt tone preview unavailable");
      return;
    }
    setToneState(
      toneState,
      toneState === "very-negative"
        ? "Very negative wording estimate"
        : presentation.label
    );
  }

  async function analyzeDraft(text, sequence) {
    if (!hasExtensionContext()) {
      setToneState("error", "Prompt tone preview unavailable");
      return;
    }
    setToneState("loading", "Analysing prompt tone locally", "…");
    try {
      const response = await chrome.runtime.sendMessage({
        type: "sentinel:analyze-sentiment",
        text,
        explain: false
      });
      if (sequence !== analysisSequence || text !== getDraftText()) return;
      if (!response?.ok || !response.sentiment) {
        setToneState("error", "Prompt tone preview unavailable");
        return;
      }
      lastAnalyzedText = text;
      lastSentiment = response.sentiment;
      influentialWord = null;
      displaySentiment(lastSentiment);
      schedulePosition();
      console.info(
        `Sentinel prompt tone preview: ${lastSentiment.label} (${lastSentiment.score})`
      );

      // Word influence requires several additional model comparisons. Resolve
      // it after displaying the tone so it can never delay the coloured dot.
      chrome.runtime.sendMessage({
        type: "sentinel:analyze-sentiment",
        text,
        explain: true
      }).then(explanation => {
        if (sequence !== analysisSequence || text !== getDraftText()) return;
        if (!explanation?.ok) return;
        influentialWord = explanation.influentialWord || null;
        schedulePosition();
      }).catch(() => {
        // Keep the tone visible if the optional explanation is unavailable.
      });
    } catch {
      if (sequence === analysisSequence) {
        setToneState("error", "Prompt tone preview unavailable");
      }
    }
  }

  function scheduleDraftAnalysis() {
    clearTimeout(analysisTimer);
    analysisSequence += 1;

    if (isSentinelTemporarilyDisabled()) {
      resetToneState();
      return;
    }
    if (!preferences.draftTone) return;
    const text = getDraftText();
    if (text.length < MINIMUM_DRAFT_LENGTH) {
      resetToneState();
      return;
    }
    if (text === lastAnalyzedText && lastSentiment) {
      displaySentiment(lastSentiment);
      schedulePosition();
      return;
    }

    influentialWord = null;
    wordUnderline.style.display = "none";
    setToneState("loading", "Analysing prompt tone locally", "…");
    const sequence = analysisSequence;
    analysisTimer = setTimeout(() => analyzeDraft(text, sequence), ANALYSIS_DELAY_MS);
  }

  function syncPreferenceControls() {
    draftToneToggle.checked = preferences.draftTone;
    chatColorsToggle.checked = preferences.chatColors;
    minimapToggle.checked = preferences.triggerMinimap;
    newChatIntentionsToggle.checked = preferences.newChatIntentions;
    newChatWritingToggle.checked = preferences.newChatWriting;
    newChatReflectionToggle.checked = preferences.newChatReflection;
    responseReflectionToggle.checked = preferences.responseReflection;
    toneIndicator.hidden = !preferences.draftTone;
    document.documentElement.toggleAttribute(
      "data-sentinel-hide-trigger-minimap",
      !preferences.triggerMinimap
    );
    if (preferences.draftTone) scheduleDraftAnalysis();
    else {
      clearTimeout(analysisTimer);
      analysisSequence += 1;
      resetToneState();
    }
    schedulePosition();
  }

  async function savePreferences() {
    preferences = {
      draftTone: draftToneToggle.checked,
      chatColors: chatColorsToggle.checked,
      triggerMinimap: minimapToggle.checked,
      newChatIntentions: newChatIntentionsToggle.checked,
      newChatWriting: newChatWritingToggle.checked,
      newChatReflection: newChatReflectionToggle.checked,
      responseReflection: responseReflectionToggle.checked
    };
    syncPreferenceControls();
    await storageSet({ [STORAGE_KEY]: preferences });
  }

  function closePanel() {
    visualsPanel.hidden = true;
    visualsButton.setAttribute("aria-expanded", "false");
  }

  visualsButton.addEventListener("click", event => {
    event.stopPropagation();
    const willOpen = visualsPanel.hidden;
    visualsPanel.hidden = !willOpen;
    visualsButton.setAttribute("aria-expanded", String(willOpen));
  });
  [
    draftToneToggle,
    chatColorsToggle,
    minimapToggle,
    newChatIntentionsToggle,
    newChatWritingToggle,
    newChatReflectionToggle,
    responseReflectionToggle
  ].forEach(input => {
    input.addEventListener("change", savePreferences);
  });
  document.addEventListener("pointerdown", event => {
    if (!visualsPanel.hidden && !event.composedPath().includes(host)) closePanel();
  }, true);
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") closePanel();
  });

  function usableRect(rect) {
    return Boolean(
      rect &&
      Number.isFinite(rect.left) &&
      Number.isFinite(rect.top) &&
      (rect.width > 0 || rect.height > 0)
    );
  }

  function getTextEndRect(element) {
    if (!element || element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      return null;
    }

    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let lastTextNode = null;
    while (walker.nextNode()) {
      if (walker.currentNode.nodeValue?.length) lastTextNode = walker.currentNode;
    }
    if (!lastTextNode) return null;

    const range = document.createRange();
    const end = lastTextNode.nodeValue.length;
    range.setStart(lastTextNode, Math.max(0, end - 1));
    range.setEnd(lastTextNode, end);
    const rect = range.getBoundingClientRect();
    return usableRect(rect) ? rect : null;
  }

  function findInfluentialWordRect(element, explanation) {
    if (
      !element ||
      !explanation?.word ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLInputElement
    ) return null;

    const wanted = String(explanation.word).toLocaleLowerCase();
    const wantedOccurrence = Number(explanation.occurrence || 0);
    let occurrence = 0;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);

    while (walker.nextNode()) {
      const node = walker.currentNode;
      const value = node.nodeValue || "";
      const lowerValue = value.toLocaleLowerCase();
      let fromIndex = 0;

      while (fromIndex <= lowerValue.length - wanted.length) {
        const index = lowerValue.indexOf(wanted, fromIndex);
        if (index < 0) break;
        if (occurrence === wantedOccurrence) {
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + wanted.length);
          const rect = range.getBoundingClientRect();
          return usableRect(rect) ? rect : null;
        }
        occurrence += 1;
        fromIndex = index + wanted.length;
      }
    }
    return null;
  }

  function positionDraftVisuals(element) {
    const composerRect = element.getBoundingClientRect();
    const draftText = getDraftText(element);
    const textRect = getTextEndRect(element);
    const dotLeft = textRect
      ? Math.min(textRect.right + 7, composerRect.right - 18)
      : composerRect.left + 16;
    const dotTop = textRect
      ? textRect.top + Math.max(0, (textRect.height - 14) / 2)
      : composerRect.top + Math.max(0, (composerRect.height - 14) / 2);

    toneIndicator.style.display = preferences.draftTone && draftText
      ? "block"
      : "none";
    toneIndicator.style.left = `${Math.round(dotLeft)}px`;
    toneIndicator.style.top = `${Math.round(dotTop)}px`;

    const wordRect = findInfluentialWordRect(element, influentialWord);
    if (!preferences.draftTone || !wordRect || !lastSentiment) {
      wordUnderline.style.display = "none";
      return;
    }
    wordUnderline.style.display = "block";
    wordUnderline.style.left = `${Math.round(wordRect.left)}px`;
    wordUnderline.style.top = `${Math.round(wordRect.bottom + 1)}px`;
    wordUnderline.style.width = `${Math.max(4, Math.round(wordRect.width))}px`;
  }

  function positionControls() {
    positionFrame = null;
    if (isSentinelTemporarilyDisabled()) {
      clearTimeout(analysisTimer);
      analysisSequence += 1;
      composer = null;
      document
        .querySelectorAll(`[${NEW_CHAT_SUGGESTION_ATTRIBUTE}]`)
        .forEach(element => element.removeAttribute(NEW_CHAT_SUGGESTION_ATTRIBUTE));
      resetToneState();
      host.style.display = "none";
      return;
    }
    const nextComposer = findComposer();
    applyNewChatSuggestionVisibility();
    const shareControl = findTopBarAction("share");
    const overflowControl = findTopBarAction("overflow");
    const privacyButton = document
      .getElementById("sentinel-privacy-review")
      ?.shadowRoot
      ?.getElementById("privacyButton");
    const privacyRect = privacyButton?.getBoundingClientRect();
    const privacyButtonIsVisible = Boolean(
      privacyButton?.isConnected &&
      privacyRect?.width > 20 &&
      privacyRect?.height > 20 &&
      privacyRect.bottom > 0 &&
      privacyRect.right > 0
    );
    const headerAnchor = privacyButtonIsVisible
      ? privacyButton
      : shareControl || overflowControl;

    if (!nextComposer && !headerAnchor) {
      composer = null;
      host.style.display = "none";
      return;
    }

    host.style.display = "block";

    let buttonWidth = visualsButton.offsetWidth || 84;
    const buttonHeight = visualsButton.offsetHeight || 32;
    if (headerAnchor) {
      const shareRect = headerAnchor.getBoundingClientRect();
      const shareStyle = getComputedStyle(headerAnchor);
      visualsButton.style.color = shareStyle.color;
      visualsButton.style.fontFamily = shareStyle.fontFamily;
      visualsButton.style.fontSize = shareStyle.fontSize;
      visualsButton.style.fontWeight = shareStyle.fontWeight;
      visualsButton.style.lineHeight = shareStyle.lineHeight;
      visualsButton.style.letterSpacing = shareStyle.letterSpacing;
      buttonWidth = visualsButton.offsetWidth || buttonWidth;
      visualsAnchor.style.left = `${Math.max(12, Math.round(shareRect.left - buttonWidth - 4))}px`;
      visualsAnchor.style.top = `${Math.max(4, Math.round(shareRect.top + (shareRect.height - buttonHeight) / 2))}px`;
    } else if (nextComposer) {
      const composerRect = nextComposer.getBoundingClientRect();
      visualsAnchor.style.left = `${Math.max(12, Math.round(composerRect.right - buttonWidth))}px`;
      visualsAnchor.style.top = "12px";
    }

    if (!nextComposer) {
      composer = null;
      toneIndicator.style.display = "none";
      wordUnderline.style.display = "none";
      return;
    }

    if (composer !== nextComposer) {
      composer = nextComposer;
      resetToneState();
      if (preferences.draftTone) scheduleDraftAnalysis();
    }

    positionDraftVisuals(composer);
  }

  function schedulePosition() {
    if (positionFrame !== null) return;
    positionFrame = requestAnimationFrame(positionControls);
  }

  document.addEventListener("input", event => {
    const activeComposer = findComposer();
    if (activeComposer) composer = activeComposer;
    schedulePosition();
    if (
      activeComposer &&
      (event.target === activeComposer || activeComposer.contains(event.target))
    ) {
      scheduleDraftAnalysis();
    }
  }, true);
  document.addEventListener("compositionend", scheduleDraftAnalysis, true);
  window.addEventListener("resize", schedulePosition, { passive: true });
  window.addEventListener("scroll", schedulePosition, { passive: true });
  window.addEventListener("sentinel:temporary-chat-change", schedulePosition);

  const observer = new MutationObserver(schedulePosition);
  observer.observe(document.body, { childList: true, subtree: true });

  try {
    if (hasExtensionContext()) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== "local" || !changes[STORAGE_KEY]) return;
        preferences = { ...DEFAULTS, ...(changes[STORAGE_KEY].newValue || {}) };
        syncPreferenceControls();
      });
    }
  } catch {
    observer.disconnect();
  }

  storageGet([STORAGE_KEY]).then(stored => {
    preferences = { ...DEFAULTS, ...(stored[STORAGE_KEY] || {}) };
    syncPreferenceControls();
    schedulePosition();
  });
})();
