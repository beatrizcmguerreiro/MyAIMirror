(function initialiseNewChatVisualizations() {
  "use strict";

  if (window.__sentinelNewChatVisualizationsLoaded) return;
  window.__sentinelNewChatVisualizationsLoaded = true;

  const ROOT_ID = "sentinel-new-chat-visualizations";
  const HIDDEN_SUGGESTION_ATTRIBUTE = "data-sentinel-new-chat-suggestion-hidden";
  const PREFERENCES_KEY = "visualizationPreferences";
  const ANALYSES_KEY = "conversationAnalysesV1";
  const BEHAVIOURAL_KEY = "sentinelBehaviouralMetricsV1";
  const INTENT_KEYS = ["learning", "delegation", "reasoning", "criticalEngagement"];
  const INTENT_PRESENTATION = {
    learning: { short: "Learning", color: "#f8cbae" },
    delegation: { short: "Delegation", color: "#ffe084" },
    reasoning: { short: "User Reasoning", color: "#c0e0c4" },
    criticalEngagement: { short: "Critical Engagement", color: "#aed3ee" }
  };
  const DEFAULT_PREFERENCES = {
    newChatIntentions: true,
    newChatWriting: true,
    newChatReflection: true
  };
  const COMPOSER_SELECTORS = [
    "#prompt-textarea",
    '[data-testid="composer-text-input"]',
    'textarea[placeholder*="Ask"]',
    'textarea[placeholder*="Message"]',
    '[contenteditable="true"][role="textbox"]',
    'form [contenteditable="true"]',
    'div.ProseMirror[contenteditable="true"]'
  ];

  let preferences = { ...DEFAULT_PREFERENCES };
  let data = emptyData();
  let frame = null;
  let trackPositionUntil = 0;
  let refreshTimer = null;
  let listedConversationScope = null;
  const hiddenNativeSuggestions = new Set();

  const nativeSuggestionStyle = document.createElement("style");
  nativeSuggestionStyle.textContent = `
    [${HIDDEN_SUGGESTION_ATTRIBUTE}] {
      display: none !important;
    }
  `;
  document.documentElement.appendChild(nativeSuggestionStyle);

  function emptyData() {
    return {
      intentions: {
        prompts: 0,
        conversations: 0,
        counts: Object.fromEntries(INTENT_KEYS.map(key => [key, 0])),
        unclear: 0
      },
      behaviour: {
        prompts: 0,
        promptsWithPaste: 0,
        promptsWithEdits: 0,
        pasteEvents: 0,
        editActions: 0,
        revisionEpisodes: 0
      },
      sentiment: {
        prompts: 0,
        counts: { positive: 0, neutral: 0, negative: 0 }
      }
    };
  }

  function hasExtensionContext() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  function isVisible(element) {
    if (!element?.isConnected) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 40 && rect.height > 15;
  }

  function findComposer() {
    for (const selector of COMPOSER_SELECTORS) {
      const candidates = Array.from(document.querySelectorAll(selector))
        .filter(isVisible)
        .filter(element => !element.closest('[role="dialog"]'))
        .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
      if (candidates[0]) return candidates[0];
    }
    return null;
  }

  function getComposerShellRect(composer) {
    const composerRect = composer.getBoundingClientRect();
    const composerCenter = composerRect.left + composerRect.width / 2;
    const candidates = [];
    let current = composer;

    for (let depth = 0; current && depth < 9; depth += 1) {
      const rect = current.getBoundingClientRect();
      const closeToComposer = Math.abs(rect.bottom - composerRect.bottom) < 100;
      if (
        rect.width >= composerRect.width &&
        rect.height > 30 &&
        rect.height < 220 &&
        closeToComposer &&
        rect.left >= 0 &&
        rect.right <= window.innerWidth
      ) {
        const style = window.getComputedStyle(current);
        const cornerRadius = Number.parseFloat(style.borderTopLeftRadius) || 0;
        const hasVisibleBackground = style.backgroundColor !== "rgba(0, 0, 0, 0)" &&
          style.backgroundColor !== "transparent";
        const looksLikeComposerShell = cornerRadius >= 20 && (
          hasVisibleBackground ||
          style.boxShadow !== "none" ||
          Number.parseFloat(style.borderTopWidth) > 0
        );
        const centerOffset = Math.abs(
          rect.left + rect.width / 2 - composerCenter
        );
        const addedWidth = rect.width - composerRect.width;
        const bottomOffset = Math.abs(rect.bottom - composerRect.bottom);

        // ChatGPT can wrap the text input in offset layout containers. Prefer
        // the rounded, painted composer shell itself; horizontal-centre
        // proximity is only a fallback because the text field is asymmetric
        // once the left and right composer controls are included.
        candidates.push({
          rect,
          score: (looksLikeComposerShell ? 1000 : 0) +
            (current.tagName === "FORM" ? 200 : 0) +
            addedWidth - centerOffset * 0.5 - bottomOffset * 0.35
        });
      }
      current = current.parentElement;
    }

    return candidates.sort((a, b) => b.score - a.score)[0]?.rect || composerRect;
  }

  function isNewChatScreen() {
    const path = location.pathname.replace(/\/+$/, "") || "/";
    return (
      (location.hostname === "chatgpt.com" || location.hostname === "chat.openai.com") &&
      path === "/" &&
      !document.querySelector('[data-message-author-role]')
    );
  }

  function hasVisibleModal() {
    return Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]'))
      .some(isVisible);
  }

  function restoreNativeSuggestions() {
    hiddenNativeSuggestions.forEach(element => {
      if (element?.isConnected) element.removeAttribute(HIDDEN_SUGGESTION_ATTRIBUTE);
    });
    hiddenNativeSuggestions.clear();
  }

  function rectanglesOverlap(first, second) {
    return first.right > second.left &&
      first.left < second.right &&
      first.bottom > second.top &&
      first.top < second.bottom;
  }

  function hideNativeSuggestions(composer, visualizationsRect) {
    const main = composer.closest("main") || document.querySelector("main");
    if (!main) {
      restoreNativeSuggestions();
      return;
    }

    const nextHidden = new Set(
      Array.from(hiddenNativeSuggestions).filter(element => element?.isConnected)
    );

    function canHide(element, rect) {
      return Boolean(
        element?.isConnected &&
        !element.closest('[role="dialog"], [aria-modal="true"]') &&
        !element.contains(composer) &&
        !composer.contains(element) &&
        rect.width > 1 &&
        rect.height > 1 &&
        rectanglesOverlap(rect, visualizationsRect)
      );
    }

    main.querySelectorAll(
      'button, a, [role="button"], [role="option"], [role="menuitem"], [role="tooltip"], [data-testid*="suggest"]'
    ).forEach(element => {
      if (
        element.closest(`#${ROOT_ID}`) ||
        element.closest('[role="dialog"], [aria-modal="true"]') ||
        element.contains(composer) ||
        composer.contains(element)
      ) return;

      const text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
      if (!text) return;

      const rect = element.getBoundingClientRect();
      if (canHide(element, rect)) nextHidden.add(element);
    });

    // Some ChatGPT suggestions are ordinary text rather than buttons. Inspect
    // text ranges so that only text actually underneath the cards is hidden.
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    let textNode = walker.nextNode();
    while (textNode) {
      const text = textNode.nodeValue?.replace(/\s+/g, " ").trim();
      const element = textNode.parentElement;
      if (text && element && !nextHidden.has(element)) {
        const range = document.createRange();
        range.selectNodeContents(textNode);
        const rect = range.getBoundingClientRect();
        if (canHide(element, rect)) {
          const interactiveParent = element.closest(
            'button, a, [role="button"], [role="option"], [role="menuitem"], [role="tooltip"]'
          );
          const target = interactiveParent && main.contains(interactiveParent)
            ? interactiveParent
            : element;
          if (!target.contains(composer)) nextHidden.add(target);
        }
      }
      textNode = walker.nextNode();
    }

    nextHidden.forEach(element => {
      element.setAttribute(HIDDEN_SUGGESTION_ATTRIBUTE, "");
    });

    hiddenNativeSuggestions.clear();
    nextHidden.forEach(element => hiddenNativeSuggestions.add(element));
  }

  function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }

  function rate(count, total) {
    return total ? Math.round((count / total) * 100) : 0;
  }

  function aggregateIntentions(conversations) {
    const result = emptyData().intentions;
    Object.values(conversations || {}).forEach(records => {
      if (!Array.isArray(records)) return;
      if (records.some(record => record?.intention)) result.conversations += 1;
      records.forEach(record => {
        const intention = record?.intention;
        if (!intention) return;
        const labels = Array.isArray(intention.labels)
          ? intention.labels.filter(label => INTENT_KEYS.includes(label))
          : [];
        result.prompts += 1;
        if (!labels.length) result.unclear += 1;
        labels.forEach(label => {
          result.counts[label] += 1;
        });
      });
    });
    return result;
  }

  function aggregateSentiment(conversations) {
    const result = emptyData().sentiment;
    Object.values(conversations || {}).forEach(records => {
      if (!Array.isArray(records)) return;
      records.forEach(record => {
        const label = record?.sentiment?.label;
        if (!Object.hasOwn(result.counts, label)) return;
        result.prompts += 1;
        result.counts[label] += 1;
      });
    });
    return result;
  }

  function normaliseBehaviour(value) {
    return {
      prompts: number(value?.prompts),
      promptsWithPaste: number(value?.promptsWithPaste),
      promptsWithEdits: number(value?.promptsWithEdits),
      pasteEvents: number(value?.pasteEvents),
      editActions: number(value?.editActions),
      revisionEpisodes: number(value?.revisionEpisodes)
    };
  }

  function storageGet(keys) {
    return new Promise(resolve => {
      if (!hasExtensionContext()) return resolve({});
      try {
        chrome.storage.local.get(keys, stored => {
          if (chrome.runtime.lastError) return resolve({});
          resolve(stored || {});
        });
      } catch {
        resolve({});
      }
    });
  }

  async function sha256Fingerprint(value) {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 32);
  }

  function conversationKeyFromLink(link) {
    try {
      const url = new URL(link.href, location.origin);
      const match = url.pathname.match(/^\/c\/([^/]+)/);
      return match ? `/c/${match[1]}` : null;
    } catch {
      return null;
    }
  }

  async function listedSidebarConversationIds() {
    if (location.hostname !== "chatgpt.com" && location.hostname !== "chat.openai.com") {
      return null;
    }

    const sidebarRightEdge = Math.min(520, window.innerWidth * 0.4);
    const keys = Array.from(document.querySelectorAll('a[href*="/c/"]'))
      .filter(link => {
        const rect = link.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 &&
          rect.left >= 0 && rect.right <= sidebarRightEdge;
      })
      .map(conversationKeyFromLink)
      .filter(Boolean);

    if (!keys.length) return listedConversationScope;
    const ids = await Promise.all(
      Array.from(new Set(keys)).map(key =>
        sha256Fingerprint(`${location.hostname}|${key}`)
      )
    );
    listedConversationScope = new Set(ids);
    return listedConversationScope;
  }

  function scopedConversations(conversations, conversationIds) {
    if (!conversationIds) return conversations || {};
    return Object.fromEntries(
      Object.entries(conversations || {})
        .filter(([conversationId]) => conversationIds.has(conversationId))
    );
  }

  function scopedBehaviour(metrics, conversationIds) {
    if (!conversationIds) return normaliseBehaviour(metrics?.totals);
    const totals = normaliseBehaviour(null);
    conversationIds.forEach(conversationId => {
      const values = normaliseBehaviour(
        metrics?.conversations?.[conversationId]?.totals ||
        metrics?.conversations?.[conversationId]
      );
      Object.keys(totals).forEach(key => { totals[key] += values[key]; });
    });
    return totals;
  }

  const host = document.createElement("div");
  host.id = ROOT_ID;
  host.style.display = "none";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host {
        position: fixed;
        z-index: 999998;
        pointer-events: none;
        color: #1d1d1f;
        font-family: inherit;
        font-synthesis: none;
        -webkit-font-smoothing: antialiased;
        text-rendering: optimizeLegibility;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(var(--visible-cards, 3), minmax(0, 1fr));
        gap: 12px;
        width: 100%;
      }
      .card {
        min-width: 0;
        min-height: 142px;
        padding: 20px 21px 18px;
        border: 1px solid rgba(0, 0, 0, 0.065);
        border-radius: 18px;
        background: #f7f7f8;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.02);
        box-sizing: border-box;
      }
      #intentCard,
      #writingCard,
      #activityCard {
        display: flex;
        flex-direction: column;
        padding-top: 15px;
      }
      #intentCard[hidden],
      #writingCard[hidden],
      #activityCard[hidden] {
        display: none;
      }
      #intentCard .eyebrow,
      #writingCard .eyebrow,
      #activityCard .eyebrow {
        font-size: 14px;
        line-height: 18px;
      }
      #intentCard .intent-summary {
        min-height: 0;
        font-size: 15.5px;
        line-height: 19px;
      }
      #intentCard .subtle {
        margin: 2px 0 0;
        font-size: 12.5px;
        line-height: 16px;
      }
      .intent-legend {
        display: grid;
        grid-template-columns: minmax(0, 1.15fr) minmax(0, 0.85fr);
        gap: 6px 8px;
        margin-top: auto;
        transform: translateY(4px);
        color: #86868b;
        font-size: 11.5px;
        line-height: 15px;
      }
      .legend-item {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        min-width: 0;
        white-space: nowrap;
      }
      .legend-item:nth-child(odd) { transform: translateX(-3px); }
      .legend-item:nth-child(even) { transform: translateX(3px); }
      .legend-dot {
        width: 8px;
        height: 8px;
        flex: 0 0 auto;
        border-radius: 50%;
      }
      .eyebrow {
        margin: 0 0 15px;
        color: #6e6e73;
        font-size: 12px;
        font-weight: 600;
        line-height: 16px;
        letter-spacing: -0.01em;
      }
      .intent-track {
        display: flex;
        align-items: stretch;
        width: 100%;
        height: 6px;
        margin: 0 0 4px;
        overflow: hidden;
        border-radius: 999px;
        background: #e8e8ed;
        line-height: 0;
      }
      .intent-segment {
        display: block;
        min-width: 0;
        height: 6px;
        flex-shrink: 0;
      }
      .intent-empty {
        width: 100%;
        height: 100%;
        background: #e8e8ed;
      }
      .intent-summary {
        min-height: 34px;
        margin: 0;
        color: #1d1d1f;
        font-size: 15px;
        font-weight: 590;
        line-height: 20px;
        letter-spacing: -0.018em;
      }
      .subtle {
        margin: 9px 0 0;
        color: #86868b;
        font-size: 11.5px;
        line-height: 15px;
        letter-spacing: -0.008em;
      }
      .metrics {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 17px;
        margin-top: 8px;
      }
      .metrics > div {
        min-width: 0;
        text-align: center;
      }
      .metric-value {
        display: block;
        color: #1d1d1f;
        font-size: 20px;
        font-weight: 590;
        line-height: 24px;
        letter-spacing: -0.018em;
        font-variant-numeric: tabular-nums;
      }
      .metric-label {
        display: block;
        margin-top: 5px;
        color: #86868b;
        font-size: 12.5px;
        line-height: 16px;
        letter-spacing: -0.005em;
      }
      .tone-layout {
        display: flex;
        flex: 1;
        align-items: center;
        gap: 22px;
        justify-content: center;
        margin-top: 0;
      }
      .tone-ring {
        position: relative;
        display: flex;
        width: 72px;
        height: 72px;
        flex: 0 0 auto;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        background: #e8e8ed;
      }
      .tone-ring::after {
        position: absolute;
        inset: 8px;
        border-radius: 50%;
        background: #f7f7f8;
        content: "";
      }
      .tone-total {
        position: relative;
        z-index: 1;
        color: #1d1d1f;
        font-size: 20px;
        font-weight: 560;
        line-height: 24px;
        letter-spacing: -0.025em;
        font-variant-numeric: tabular-nums;
      }
      .tone-rates {
        display: grid;
        gap: 7px;
        min-width: 112px;
      }
      .tone-rate {
        display: grid;
        grid-template-columns: 8px minmax(0, 1fr) auto;
        gap: 7px;
        align-items: center;
        color: #86868b;
        font-size: 12.5px;
        line-height: 16px;
      }
      .tone-rate > span:nth-child(2) {
        font-size: 13.5px;
      }
      .tone-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
      }
      .tone-percent {
        color: #1d1d1f;
        font-variant-numeric: tabular-nums;
      }
      @media (max-width: 820px) {
        .grid { grid-template-columns: 1fr; }
        .card { min-height: auto; }
      }
      @media (prefers-color-scheme: dark) {
        :host { color: #f2f2f2; }
        .card {
          border-color: rgba(255, 255, 255, 0.1);
          background: #2c2c2e;
          box-shadow: none;
        }
        .eyebrow, .subtle, .metric-label, .intent-legend { color: #98989d; }
        .intent-summary, .metric-value, .tone-total, .tone-percent { color: #f5f5f7; }
        .tone-rate { color: #98989d; }
        .tone-ring::after { background: #2c2c2e; }
        .intent-track, .intent-empty { background: #48484a; }
      }
    </style>
    <div class="grid" id="grid">
      <section class="card" id="intentCard">
        <p class="eyebrow">Interaction focus</p>
        <div class="intent-track" id="intentTrack" aria-hidden="true"></div>
        <p class="intent-summary" id="intentSummary"></p>
        <p class="subtle" id="intentCaption">is your most common interaction focus.</p>
        <div class="intent-legend" aria-label="Intention colour legend">
          <span class="legend-item"><span class="legend-dot" style="background:#c0e0c4"></span>User Reasoning</span>
          <span class="legend-item"><span class="legend-dot" style="background:#f8cbae"></span>Learning</span>
          <span class="legend-item"><span class="legend-dot" style="background:#aed3ee"></span>Critical Engagement</span>
          <span class="legend-item"><span class="legend-dot" style="background:#ffe084"></span>Delegation</span>
        </div>
      </section>
      <section class="card" id="writingCard">
        <p class="eyebrow">Writing process</p>
        <div class="metrics">
          <div><span class="metric-value" id="pasteRate">0%</span><span class="metric-label">with pasted content</span></div>
          <div><span class="metric-value" id="editRate">0%</span><span class="metric-label">edited before sending</span></div>
          <div><span class="metric-value" id="revisionCount">0</span><span class="metric-label">revision episodes</span></div>
        </div>
      </section>
      <section class="card" id="activityCard">
        <p class="eyebrow">Prompt tone</p>
        <div class="tone-layout">
          <div class="tone-ring" id="toneRing" aria-hidden="true">
            <span class="tone-total" id="toneTotal">0</span>
          </div>
          <div class="tone-rates">
            <div class="tone-rate"><span class="tone-dot" style="background:#b9dfc4"></span><span>Positive</span><span class="tone-percent" id="positiveRate">0%</span></div>
            <div class="tone-rate"><span class="tone-dot" style="background:#d8d8dc"></span><span>Neutral</span><span class="tone-percent" id="neutralRate">0%</span></div>
            <div class="tone-rate"><span class="tone-dot" style="background:#f3bd9e"></span><span>Negative</span><span class="tone-percent" id="negativeRate">0%</span></div>
          </div>
        </div>
      </section>
    </div>
  `;
  document.documentElement.appendChild(host);

  window.__sentinelBindShadowTheme?.(shadow);

  const grid = shadow.getElementById("grid");
  const intentCard = shadow.getElementById("intentCard");
  const writingCard = shadow.getElementById("writingCard");
  const activityCard = shadow.getElementById("activityCard");
  const intentTrack = shadow.getElementById("intentTrack");
  const intentSummary = shadow.getElementById("intentSummary");
  const intentCaption = shadow.getElementById("intentCaption");
  const pasteRate = shadow.getElementById("pasteRate");
  const editRate = shadow.getElementById("editRate");
  const revisionCount = shadow.getElementById("revisionCount");
  const toneRing = shadow.getElementById("toneRing");
  const toneTotal = shadow.getElementById("toneTotal");
  const positiveRate = shadow.getElementById("positiveRate");
  const neutralRate = shadow.getElementById("neutralRate");
  const negativeRate = shadow.getElementById("negativeRate");

  function renderIntentions() {
    intentTrack.replaceChildren();
    const totalSignals = INTENT_KEYS.reduce(
      (total, key) => total + data.intentions.counts[key],
      0
    );
    if (!totalSignals) {
      const empty = document.createElement("span");
      empty.className = "intent-empty";
      intentTrack.appendChild(empty);
      intentSummary.textContent = "No intention pattern yet.";
      intentCaption.hidden = true;
      return;
    }

    const ranked = INTENT_KEYS
      .map(key => ({
        key,
        count: data.intentions.counts[key]
      }))
      .filter(item => item.count > 0)
      .sort((a, b) =>
        b.count - a.count || INTENT_KEYS.indexOf(a.key) - INTENT_KEYS.indexOf(b.key)
      );
    const dominant = INTENT_PRESENTATION[ranked[0].key];
    const dominantSegment = document.createElement("span");
    dominantSegment.className = "intent-segment";
    dominantSegment.style.flexBasis = "100%";
    dominantSegment.style.background = dominant.color;
    intentTrack.appendChild(dominantSegment);
    intentSummary.textContent = dominant.short;
    intentCaption.hidden = false;
  }

  function renderWriting() {
    const behaviour = data.behaviour;
    pasteRate.textContent = `${rate(behaviour.promptsWithPaste, behaviour.prompts)}%`;
    editRate.textContent = `${rate(behaviour.promptsWithEdits, behaviour.prompts)}%`;
    revisionCount.textContent = String(behaviour.revisionEpisodes);
  }

  function renderActivity() {
    const sentiment = data.sentiment;
    const positive = rate(sentiment.counts.positive, sentiment.prompts);
    const neutral = rate(sentiment.counts.neutral, sentiment.prompts);
    const negative = sentiment.prompts ? Math.max(0, 100 - positive - neutral) : 0;
    toneTotal.textContent = String(sentiment.prompts);
    positiveRate.textContent = `${positive}%`;
    neutralRate.textContent = `${neutral}%`;
    negativeRate.textContent = `${negative}%`;
    toneRing.style.background = sentiment.prompts
      ? `conic-gradient(#b9dfc4 0 ${positive}%, #d8d8dc ${positive}% ${positive + neutral}%, #f3bd9e ${positive + neutral}% 100%)`
      : "#e8e8ed";
  }

  function render() {
    intentCard.hidden = !preferences.newChatIntentions;
    writingCard.hidden = !preferences.newChatWriting;
    activityCard.hidden = !preferences.newChatReflection;
    const visibleCount = [intentCard, writingCard, activityCard]
      .filter(card => !card.hidden).length;
    grid.style.setProperty("--visible-cards", String(Math.max(1, visibleCount)));
    renderIntentions();
    renderWriting();
    renderActivity();
  }

  async function refreshData() {
    const [stored, conversationIds] = await Promise.all([
      storageGet([ANALYSES_KEY, BEHAVIOURAL_KEY, PREFERENCES_KEY]),
      listedSidebarConversationIds()
    ]);
    const conversations = scopedConversations(stored[ANALYSES_KEY], conversationIds);
    preferences = {
      ...DEFAULT_PREFERENCES,
      ...(stored[PREFERENCES_KEY] || {})
    };
    data = {
      intentions: aggregateIntentions(conversations),
      behaviour: scopedBehaviour(stored[BEHAVIOURAL_KEY], conversationIds),
      sentiment: aggregateSentiment(conversations)
    };
    render();
    schedulePosition();
  }

  function position() {
    frame = null;
    const disabled = document.documentElement.hasAttribute("data-sentinel-temporary-chat");
    const anyEnabled = preferences.newChatIntentions ||
      preferences.newChatWriting ||
      preferences.newChatReflection;
    const composer = findComposer();
    if (disabled || !anyEnabled || hasVisibleModal() || !isNewChatScreen() || !composer) {
      host.style.display = "none";
      restoreNativeSuggestions();
      continuePositionTracking();
      return;
    }

    const rect = getComposerShellRect(composer);
    const width = Math.min(960, rect.width);
    host.style.display = "block";
    host.style.width = `${Math.round(width)}px`;
    host.style.left = `${Math.round(rect.left + (rect.width - width) / 2)}px`;
    host.style.top = `${Math.round(rect.bottom + 18)}px`;
    hideNativeSuggestions(composer, host.getBoundingClientRect());
    continuePositionTracking();
  }

  function continuePositionTracking() {
    if (performance.now() < trackPositionUntil && frame === null) {
      frame = requestAnimationFrame(position);
    }
  }

  function schedulePosition() {
    if (frame !== null) return;
    frame = requestAnimationFrame(position);
  }

  function trackPositionFor(duration = 500) {
    trackPositionUntil = Math.max(trackPositionUntil, performance.now() + duration);
    schedulePosition();
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshData, 80);
  }

  window.addEventListener("resize", schedulePosition, { passive: true });
  window.addEventListener("scroll", schedulePosition, { passive: true });
  window.addEventListener("sentinel:temporary-chat-change", schedulePosition);

  // ChatGPT opens and closes its sidebar with an internal CSS transition. It
  // does not consistently resize the window or mutate the composer on every
  // animation frame, so follow the composer briefly after pointer actions and
  // transition starts instead of waiting for the final layout notification.
  document.addEventListener("pointerdown", () => trackPositionFor(), {
    capture: true,
    passive: true
  });
  document.addEventListener("transitionrun", () => trackPositionFor(), {
    capture: true,
    passive: true
  });

  const observer = new MutationObserver(() => {
    schedulePosition();
    if (isNewChatScreen()) scheduleRefresh();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  try {
    if (hasExtensionContext()) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== "local") return;
        if (
          changes[ANALYSES_KEY] ||
          changes[BEHAVIOURAL_KEY] ||
          changes[PREFERENCES_KEY]
        ) scheduleRefresh();
      });
    }
  } catch {
    observer.disconnect();
  }

  refreshData();
  schedulePosition();
})();
