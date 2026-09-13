(function initialiseSentinelUsageOverview() {
  "use strict";

  if (window.__sentinelUsageOverviewLoaded) return;
  window.__sentinelUsageOverviewLoaded = true;

  const ROOT_ID = "sentinel-usage-overview";
  const ANALYSES_KEY = "conversationAnalysesV1";
  const BEHAVIOURAL_KEY = "sentinelBehaviouralMetricsV1";
  const REFLECTIONS_KEY = "sentinelPostResponseReflectionsV1";
  const INTENTIONS = [
    { key: "learning", label: "Learning", color: "#f8cbae" },
    { key: "reasoning", label: "User reasoning", color: "#c0e0c4" },
    { key: "criticalEngagement", label: "Critical engagement", color: "#aed3ee" },
    { key: "delegation", label: "Delegation", color: "#ffe084" }
  ];
  const REFLECTION_INTENT = {
    understand: "learning",
    "own-thinking": "reasoning",
    "question-further": "criticalEngagement",
    accepted: "delegation",
    // Preserve the comparable choice saved by the earlier prototype.
    result: "delegation"
  };

  let positionFrame = null;
  let refreshTimer = null;
  let layoutSettleTimer = null;
  let searchButton = null;

  function hasExtensionContext() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
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

    if (!keys.length) return null;
    const ids = await Promise.all(
      Array.from(new Set(keys)).map(key =>
        sha256Fingerprint(`${location.hostname}|${key}`)
      )
    );
    return new Set(ids);
  }

  function isVisible(element) {
    if (!element?.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 20 || rect.bottom <= 0 || rect.right <= 0) {
      return false;
    }
    const style = getComputedStyle(element);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number(style.opacity) <= 0.01
    ) return false;

    // Collapsed ChatGPT sidebars can leave the expanded header controls laid
    // out beyond an overflow-clipped rail. A rectangle alone therefore does
    // not mean the control is actually visible. Verify that its centre is
    // exposed to pointer hit-testing before using it as the + button anchor.
    const x = Math.min(window.innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
    const y = Math.min(window.innerHeight - 1, Math.max(0, rect.top + rect.height / 2));
    const hit = document.elementFromPoint(x, y);
    return Boolean(hit && (hit === element || element.contains(hit)));
  }

  function findSearchButton() {
    return Array.from(document.querySelectorAll('button, a, [role="button"]'))
      .filter(element => !element.closest('[role="dialog"], [aria-modal="true"]'))
      .filter(isVisible)
      .map(element => {
        const rect = element.getBoundingClientRect();
        const label = [
          element.getAttribute("aria-label"),
          element.getAttribute("title"),
          element.getAttribute("data-testid"),
          element.innerText
        ].filter(Boolean).join(" ");
        return { element, rect, label };
      })
      .filter(({ rect, label }) => (
        /search/i.test(label) &&
        rect.top < 100 &&
        rect.left < Math.min(520, window.innerWidth * 0.45)
      ))
      .sort((a, b) => a.rect.top - b.rect.top || b.rect.left - a.rect.left)[0]
      ?.element || null;
  }

  function findSidebarToggle(activeSearchButton) {
    if (!activeSearchButton) return null;
    const searchRect = activeSearchButton.getBoundingClientRect();
    const searchCenterY = searchRect.top + searchRect.height / 2;
    const candidates = Array.from(document.querySelectorAll('button, a, [role="button"]'))
      .filter(element => element !== activeSearchButton)
      .filter(element => !element.closest('[role="dialog"], [aria-modal="true"]'))
      .filter(isVisible)
      .map(element => {
        const rect = element.getBoundingClientRect();
        const label = [
          element.getAttribute("aria-label"),
          element.getAttribute("title"),
          element.getAttribute("data-testid"),
          element.innerText
        ].filter(Boolean).join(" ");
        return { element, rect, label };
      })
      .filter(({ rect }) => (
        rect.left > searchRect.left &&
        rect.left - searchRect.right < 100 &&
        Math.abs((rect.top + rect.height / 2) - searchCenterY) < 14
      ));

    return candidates.sort((first, second) => {
      const firstIsSidebar = /sidebar/i.test(first.label) ? 0 : 1;
      const secondIsSidebar = /sidebar/i.test(second.label) ? 0 : 1;
      return firstIsSidebar - secondIsSidebar || first.rect.left - second.rect.left;
    })[0]?.element || null;
  }

  function emptyBehaviour() {
    return {
      prompts: 0,
      promptsWithPaste: 0,
      promptsWithEdits: 0,
      revisionEpisodes: 0
    };
  }

  function normaliseBehaviour(value) {
    const result = emptyBehaviour();
    Object.keys(result).forEach(key => {
      const number = Number(value?.[key]);
      result[key] = Number.isFinite(number) && number >= 0 ? number : 0;
    });
    return result;
  }

  function percentage(part, total) {
    return total ? Math.round((part / total) * 100) : 0;
  }

  function addBehaviour(targetValue, sourceValue) {
    const target = normaliseBehaviour(targetValue);
    const source = normaliseBehaviour(sourceValue);
    Object.keys(target).forEach(key => { target[key] += source[key]; });
    return target;
  }

  function intentionMeta(key) {
    return INTENTIONS.find(item => item.key === key) || {
      key,
      label: "Unclear",
      color: "#d1d1d6"
    };
  }

  function dominantIntention(records) {
    const counts = Object.fromEntries(INTENTIONS.map(item => [item.key, 0]));
    (Array.isArray(records) ? records : []).forEach(record => {
      const labels = Array.isArray(record?.intention?.labels)
        ? record.intention.labels
        : [];
      labels.forEach(label => {
        if (Object.hasOwn(counts, label)) counts[label] += 1;
      });
    });
    const leading = INTENTIONS
      .map(item => ({ key: item.key, count: counts[item.key] }))
      .sort((first, second) => second.count - first.count)[0];
    return leading?.count ? leading.key : null;
  }

  function aggregateUsage(stored, listedConversationIds = null) {
    const storedConversations = stored[ANALYSES_KEY] || {};
    const conversations = listedConversationIds
      ? Object.fromEntries(
          Object.entries(storedConversations)
            .filter(([conversationId]) => listedConversationIds.has(conversationId))
        )
      : storedConversations;
    const behavioural = stored[BEHAVIOURAL_KEY] || {};
    const storedReflections = Array.isArray(stored[REFLECTIONS_KEY])
      ? stored[REFLECTIONS_KEY]
      : [];
    const reflections = listedConversationIds
      ? storedReflections.filter(record => listedConversationIds.has(record?.conversationId))
      : storedReflections;
    const conversationIds = listedConversationIds || new Set([
        ...Object.keys(conversations),
        ...Object.keys(behavioural.conversations || {}),
        ...reflections.map(record => record?.conversationId).filter(Boolean)
      ]);
    const behaviourByStyle = Object.fromEntries(
      INTENTIONS.map(item => [item.key, { chats: 0, totals: emptyBehaviour() }])
    );
    const toneContext = Object.fromEntries(
      ["positive", "neutral", "negative"].map(tone => [tone, {
        prompts: 0,
        counts: Object.fromEntries(INTENTIONS.map(item => [item.key, 0]))
      }])
    );
    const combinationCounts = new Map();
    const intentionCounts = Object.fromEntries(
      INTENTIONS.map(item => [item.key, 0])
    );
    let prompts = 0;
    let analysedPrompts = 0;
    let toneReadings = 0;
    let activePrompts = 0;
    let relianceOnlyPrompts = 0;
    let mixedPrompts = 0;

    Object.entries(conversations).forEach(([conversationId, records]) => {
      if (!Array.isArray(records)) return;
      records.forEach(record => {
        const hasTone = ["positive", "neutral", "negative"]
          .includes(record?.sentiment?.label);
        if (hasTone) {
          toneReadings += 1;
        }
        const labels = Array.isArray(record?.intention?.labels)
          ? record.intention.labels
          : null;
        if (hasTone || labels) prompts += 1;
        if (!labels) return;
        analysedPrompts += 1;
        const validLabels = INTENTIONS.map(item => item.key).filter(key => labels.includes(key));
        validLabels.forEach(label => { intentionCounts[label] += 1; });
        const activelyEngaged = validLabels.includes("reasoning") ||
          validLabels.includes("criticalEngagement");
        if (activelyEngaged) activePrompts += 1;
        if (validLabels.includes("delegation") && !activelyEngaged) relianceOnlyPrompts += 1;
        if (validLabels.length > 1) {
          mixedPrompts += 1;
          const combination = validLabels.join("|");
          combinationCounts.set(combination, (combinationCounts.get(combination) || 0) + 1);
        }

        const tone = record?.sentiment?.label;
        if (toneContext[tone]) {
          toneContext[tone].prompts += 1;
          validLabels.forEach(label => { toneContext[tone].counts[label] += 1; });
        }
      });

      const dominant = dominantIntention(records);
      const conversationBehaviour = behavioural.conversations?.[conversationId]?.totals ||
        behavioural.conversations?.[conversationId];
      if (dominant && conversationBehaviour) {
        behaviourByStyle[dominant].chats += 1;
        behaviourByStyle[dominant].totals = addBehaviour(
          behaviourByStyle[dominant].totals,
          conversationBehaviour
        );
      }
    });

    let comparableReflections = 0;
    let matchingReflections = 0;
    reflections.forEach(record => {
      const expectedIntent = REFLECTION_INTENT[record?.choice];
      const responseIndex = Number(record?.responseIndex);
      const analysis = Number.isInteger(responseIndex)
        ? conversations[record?.conversationId]?.[responseIndex - 1]
        : null;
      const labels = Array.isArray(analysis?.intention?.labels)
        ? analysis.intention.labels
        : null;
      if (!expectedIntent || !labels) return;
      comparableReflections += 1;
      if (labels.includes(expectedIntent)) matchingReflections += 1;
    });

    const combinations = Array.from(combinationCounts.entries())
      .map(([key, count]) => ({
        keys: key.split("|"),
        count,
        rate: percentage(count, analysedPrompts)
      }))
      .sort((first, second) => second.count - first.count)
      .slice(0, 3);

    const totalIntentionSignals = Object.values(intentionCounts)
      .reduce((total, count) => total + count, 0);
    const categoryRows = INTENTIONS
      .map((item, index) => ({
        ...item,
        index,
        count: intentionCounts[item.key],
        rate: percentage(intentionCounts[item.key], totalIntentionSignals)
      }))
      .sort((first, second) => second.count - first.count || first.index - second.index);

    const processStyles = INTENTIONS.map(item => {
      const group = behaviourByStyle[item.key];
      const prompts = group.totals.prompts;
      return {
        ...item,
        chats: group.chats,
        prompts,
        editRate: percentage(group.totals.promptsWithEdits, prompts),
        pasteRate: percentage(group.totals.promptsWithPaste, prompts),
        revisionsPerPrompt: prompts
          ? Number((group.totals.revisionEpisodes / prompts).toFixed(1))
          : 0
      };
    }).filter(item => item.chats > 0 && item.prompts > 0)
      .sort((first, second) => second.revisionsPerPrompt - first.revisionsPerPrompt);

    const toneRows = Object.entries(toneContext).map(([tone, context]) => {
      const leading = INTENTIONS
        .map(item => ({ ...item, count: context.counts[item.key] }))
        .sort((first, second) => second.count - first.count)[0];
      return {
        tone,
        prompts: context.prompts,
        leading: leading?.count ? leading : null,
        rate: leading?.count ? percentage(leading.count, context.prompts) : 0
      };
    });

    return {
      chats: conversationIds.size,
      prompts,
      analysedPrompts,
      toneReadings,
      reflections: reflections.length,
      categoryRows,
      activeRate: percentage(activePrompts, analysedPrompts),
      mixedRate: percentage(mixedPrompts, analysedPrompts),
      relianceOnlyRate: percentage(relianceOnlyPrompts, analysedPrompts),
      combinations,
      processStyles,
      toneRows,
      comparableReflections,
      matchingReflections,
      reflectionAgreement: percentage(matchingReflections, comparableReflections)
    };
  }

  function insightFor(data) {
    if (!data.analysedPrompts) {
      return "As you use AI across more chats, this overview will show how you engage with it.";
    }

    if (data.comparableReflections >= 3 && data.reflectionAgreement < 50) {
      return "Your reflections and the classifier often differ. That gap is useful: your own account should remain the primary interpretation.";
    }
    if (data.relianceOnlyRate >= 30) {
      return "Delegation without reasoning or critical engagement appears regularly. Consider where you still want to inspect the process, not only the result.";
    }
    if (data.mixedRate >= 40) {
      return "Many prompts combine several intentions. Your AI use is often layered rather than purely learning or task-oriented.";
    }
    return "These relationships combine classifier, tone, writing-process, and reflection signals across chats; they are prompts for reflection, not scores.";
  }

  const host = document.createElement("div");
  host.id = ROOT_ID;
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host {
        position: fixed;
        inset: 0;
        z-index: 999998;
        color: #1d1d1f;
        font-family: inherit;
        pointer-events: none;
      }
      * { box-sizing: border-box; }
      .trigger {
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
        cursor: pointer;
        pointer-events: auto;
      }
      .trigger:hover,
      .trigger[aria-expanded="true"] { background: rgba(0, 0, 0, .055); }
      .trigger:focus-visible,
      .close:focus-visible {
        outline: 2px solid #0a84ff;
        outline-offset: 2px;
      }
      .trigger svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; }
      .trigger[hidden] { display: none; }
      .panel {
        position: fixed;
        width: min(400px, calc(100vw - 24px));
        max-height: calc(100vh - 76px);
        overflow: auto;
        padding: 18px;
        border: 1px solid rgba(0, 0, 0, .09);
        border-radius: 20px;
        background: #f3f3f5;
        box-shadow: 0 18px 48px rgba(0, 0, 0, .16);
        pointer-events: auto;
      }
      .panel[hidden] { display: none; }
      .header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
      .eyebrow { margin: 0 0 4px; color: #8e8e93; font-size: 11px; font-weight: 650; letter-spacing: .06em; text-transform: uppercase; }
      h2 { margin: 0; font-size: 20px; line-height: 1.2; }
      .scope { margin: 5px 0 0; color: #5f5f64; font-size: 14px; line-height: 1.45; }
      .close { width: 30px; height: 30px; border: 0; border-radius: 50%; background: #f0f0f2; color: #4a4a4e; font-size: 20px; line-height: 1; cursor: pointer; }
      .coverage { margin: -4px 0 14px; color: #5f5f64; font-size: 14px; line-height: 1.45; }
      .section { padding: 15px 0; border-top: 1px solid #e8e8eb; }
      .category-section { padding-bottom: 0; }
      .section-title { margin: 0 0 12px; font-size: 16px; font-weight: 650; }
      .category-list { display: grid; gap: 9px; }
      .category-row { display: grid; grid-template-columns: 140px minmax(0, 162px) 42px; align-items: center; justify-content: start; gap: 8px; }
      .category-name { overflow: hidden; font-size: 14px; line-height: 1.3; text-overflow: ellipsis; white-space: nowrap; }
      .category-track { height: 10px; overflow: hidden; border-radius: 999px; background: #e5e5e9; }
      .category-fill { display: block; width: var(--category-rate); height: 100%; border-radius: inherit; background: var(--category-color); }
      .category-rate { color: #4f4f54; font-size: 15px; font-weight: 500; text-align: right; font-variant-numeric: tabular-nums; }
      .signal-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
      .signal { min-width: 0; padding: 11px 9px; border-radius: 12px; background: #f5f5f7; }
      .signal-value { display: block; font-size: 19px; font-weight: 700; font-variant-numeric: tabular-nums; }
      .signal-label { display: block; margin-top: 3px; color: #737378; font-size: 10.5px; line-height: 1.3; }
      .note { margin: 10px 0 0; color: #838388; font-size: 10.5px; line-height: 1.35; }
      .combination-list, .tone-list { display: grid; gap: 7px; }
      .combination, .tone-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 30px; padding: 7px 9px; border-radius: 10px; background: #f5f5f7; font-size: 11.5px; }
      .combination-label, .tone-label { display: flex; align-items: center; gap: 6px; min-width: 0; }
      .dots { display: inline-flex; flex: 0 0 auto; }
      .mini-dot { width: 8px; height: 8px; margin-left: -2px; border: 1px solid rgba(255,255,255,.9); border-radius: 50%; background: var(--dot-color); }
      .mini-dot:first-child { margin-left: 0; }
      .row-value { flex: 0 0 auto; color: #737378; font-variant-numeric: tabular-nums; }
      .style-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
      .style-card { min-width: 0; padding: 11px; border: 1px solid #e8e8eb; border-radius: 12px; }
      .style-name { display: flex; align-items: center; gap: 6px; margin: 0 0 8px; font-size: 11px; font-weight: 650; }
      .style-name::before { content: ""; width: 8px; height: 8px; flex: 0 0 8px; border-radius: 50%; background: var(--style-color); }
      .style-value { display: block; font-size: 17px; font-weight: 700; font-variant-numeric: tabular-nums; }
      .style-meta { display: block; margin-top: 3px; color: #737378; font-size: 10px; line-height: 1.3; }
      .empty { margin: 0; color: #838388; font-size: 11.5px; line-height: 1.45; }
      .agreement { display: flex; align-items: center; gap: 12px; }
      .agreement-value { min-width: 58px; font-size: 21px; font-weight: 700; font-variant-numeric: tabular-nums; }
      .agreement-copy { margin: 0; color: #5f5f64; font-size: 11.5px; line-height: 1.45; }
      .insight { display: flex; gap: 10px; margin-top: 20px; padding: 12px; border: 1px solid #dedee2; border-radius: 13px; background: #f5f5f7; }
      .insight svg { width: 20px; height: 20px; flex: 0 0 20px; fill: none; stroke: #5c5c60; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
      .insight p { margin: 0; color: #4a4a4e; font-size: 14px; line-height: 1.45; }
      @media (prefers-color-scheme: dark) {
        :host { color: #f2f2f2; }
        .trigger:hover, .trigger[aria-expanded="true"] { background: rgba(255,255,255,.1); }
        .panel { background: rgba(36,36,38,.99); border-color: rgba(255,255,255,.12); box-shadow: 0 18px 48px rgba(0,0,0,.4); }
        .eyebrow, .scope, .coverage, .signal-label, .row-value, .style-meta, .note, .empty { color: #a1a1a7; }
        .category-track { background: #444448; }
        .category-rate { color: #c7c7cc; }
        .close, .signal, .combination, .tone-row, .insight { background: #343437; color: #f2f2f2; }
        .section { border-color: #444448; }
        .insight { border-color: #4a4a4e; }
        .style-card { border-color: #444448; }
        .agreement-copy { color: #c7c7cc; }
        .insight svg { stroke: #d1d1d6; }
        .insight p { color: #dedee2; }
      }
    </style>
    <button class="trigger" id="trigger" type="button" aria-label="Open usage overview" title="Usage overview" aria-expanded="false" aria-controls="panel" hidden>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>
    </button>
    <section class="panel" id="panel" role="dialog" aria-labelledby="title" hidden>
      <div class="header">
        <div>
          <h2 id="title">Usage overview</h2>
          <p class="scope" id="scope">Across all chats on this device</p>
        </div>
        <button class="close" id="close" type="button" aria-label="Close usage overview">×</button>
      </div>
      <p class="coverage" id="coverage">No linked signals yet</p>
      <section class="section category-section">
        <h3 class="section-title">Intention categories</h3>
        <div class="category-list" id="categoryList"></div>
        <div class="insight">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18h6M10 21h4M8.4 14.5A6 6 0 1 1 15.6 14.5C14.6 15.3 14 16.1 14 17h-4c0-.9-.6-1.7-1.6-2.5Z"></path></svg>
          <p id="insight"></p>
        </div>
      </section>
    </section>
  `;
  document.documentElement.appendChild(host);

  window.__sentinelBindShadowTheme?.(shadow);

  const trigger = shadow.getElementById("trigger");
  const panel = shadow.getElementById("panel");
  const closeButton = shadow.getElementById("close");

  function positionPanel(searchRect) {
    const panelWidth = panel.offsetWidth || Math.min(400, window.innerWidth - 24);
    const preferredLeft = Math.max(12, searchRect.right - 400);
    const left = Math.min(window.innerWidth - panelWidth - 12, preferredLeft);
    panel.style.left = `${Math.max(12, Math.round(left))}px`;
    panel.style.top = `${Math.max(56, Math.round(searchRect.bottom + 10))}px`;
  }

  function setPanelOpen(open) {
    if (open) {
      const activeSearch = searchButton?.isConnected ? searchButton : findSearchButton();
      if (!activeSearch) return;
      // Set coordinates while the panel is still hidden. Otherwise its
      // default fixed position can briefly cover Search, causing the visual
      // visibility check to close the panel during the same click.
      positionPanel(activeSearch.getBoundingClientRect());
    }
    panel.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
    if (open) {
      refresh();
      position();
      closeButton.focus();
    }
  }

  function render(data) {
    shadow.getElementById("coverage").textContent = [
      `${data.chats} ${data.chats === 1 ? "chat" : "chats"}`,
      `${data.prompts} ${data.prompts === 1 ? "prompt" : "prompts"}`
    ].join(" · ");

    const categoryList = shadow.getElementById("categoryList");
    categoryList.replaceChildren();
    data.categoryRows.forEach(category => {
      const row = document.createElement("div");
      row.className = "category-row";
      row.innerHTML = `
        <span class="category-name" title="${category.label}">${category.label}</span>
        <span class="category-track" aria-hidden="true"><span class="category-fill" style="--category-rate:${category.rate}%;--category-color:${category.color}"></span></span>
        <span class="category-rate">${category.rate}%</span>
      `;
      categoryList.appendChild(row);
    });

    shadow.getElementById("insight").textContent = insightFor(data);
  }

  async function refresh() {
    clearTimeout(refreshTimer);
    const [stored, listedConversationIds] = await Promise.all([
      storageGet([ANALYSES_KEY, BEHAVIOURAL_KEY, REFLECTIONS_KEY]),
      listedSidebarConversationIds()
    ]);
    if (!hasExtensionContext()) return;
    render(aggregateUsage(stored, listedConversationIds));
  }

  function position() {
    positionFrame = null;
    if (document.documentElement.hasAttribute("data-sentinel-temporary-chat")) {
      trigger.hidden = true;
      setPanelOpen(false);
      return;
    }

    searchButton = findSearchButton();
    if (!searchButton) {
      trigger.hidden = true;
      setPanelOpen(false);
      return;
    }

    const searchRect = searchButton.getBoundingClientRect();
    const searchStyle = getComputedStyle(searchButton);
    const size = Math.max(28, Math.min(36, Math.round(searchRect.height)));
    const sidebarToggle = findSidebarToggle(searchButton);
    const searchCenter = searchRect.left + searchRect.width / 2;
    const sidebarRect = sidebarToggle?.getBoundingClientRect();
    const nativeSpacing = sidebarRect
      ? (sidebarRect.left + sidebarRect.width / 2) - searchCenter
      : size + 5;
    const spacing = nativeSpacing >= size && nativeSpacing <= 90
      ? nativeSpacing
      : size + 5;
    const triggerCenter = searchCenter - spacing;
    trigger.hidden = false;
    trigger.style.width = `${size}px`;
    trigger.style.height = `${size}px`;
    trigger.style.left = `${Math.max(8, Math.round(triggerCenter - size / 2))}px`;
    trigger.style.top = `${Math.round(searchRect.top + (searchRect.height - size) / 2)}px`;
    trigger.style.color = searchStyle.color;

    if (!panel.hidden) {
      positionPanel(searchRect);
    }
  }

  function schedulePosition() {
    if (positionFrame !== null) return;
    positionFrame = requestAnimationFrame(position);
  }

  trigger.addEventListener("click", () => setPanelOpen(panel.hidden));
  closeButton.addEventListener("click", () => {
    setPanelOpen(false);
    trigger.focus();
  });
  shadow.addEventListener("pointerdown", event => event.stopPropagation());
  document.addEventListener("pointerdown", () => {
    if (!panel.hidden) setPanelOpen(false);
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape" || panel.hidden) return;
    setPanelOpen(false);
    trigger.focus();
  });
  window.addEventListener("resize", schedulePosition, { passive: true });
  window.addEventListener("scroll", schedulePosition, { passive: true });
  window.addEventListener("sentinel:temporary-chat-change", schedulePosition);
  document.addEventListener("transitionend", schedulePosition, true);

  const observer = new MutationObserver(() => {
    schedulePosition();
    // Sidebar collapse/expand animations can continue after the class change
    // that triggered this observer. Recheck once the layout has settled.
    clearTimeout(layoutSettleTimer);
    layoutSettleTimer = setTimeout(schedulePosition, 260);
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style", "aria-hidden", "data-state"]
  });

  // ChatGPT has shipped sidebar variants whose collapse animation changes
  // geometry without a dependable mutation or transition event. Reconcile the
  // header control periodically so it cannot remain behind in the collapsed rail.
  const visibilityInterval = setInterval(() => {
    if (!hasExtensionContext()) {
      clearInterval(visibilityInterval);
      observer.disconnect();
      return;
    }
    schedulePosition();
  }, 350);
  window.addEventListener("pagehide", () => {
    clearInterval(visibilityInterval);
    clearTimeout(layoutSettleTimer);
    observer.disconnect();
  }, { once: true });

  if (hasExtensionContext()) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (!changes[ANALYSES_KEY] && !changes[BEHAVIOURAL_KEY] && !changes[REFLECTIONS_KEY]) return;
      if (panel.hidden) return;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refresh, 80);
    });
  }

  schedulePosition();
})();
