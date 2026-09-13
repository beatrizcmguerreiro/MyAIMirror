(function initialiseMyAiMirrorReport() {
  "use strict";

  if (window.__myAiMirrorReportLoaded) return;
  window.__myAiMirrorReportLoaded = true;

  const ROOT_ID = "my-ai-mirror-report";
  const MENU_ITEM_ATTRIBUTE = "data-my-ai-mirror-report-item";
  const ANALYSES_KEY = "conversationAnalysesV1";
  const BEHAVIOURAL_KEY = "sentinelBehaviouralMetricsV1";
  const REFLECTIONS_KEY = "sentinelPostResponseReflectionsV1";
  const THEMES_KEY = "sentinelThemeMetricsV1";
  const INTENTIONS = [
    { key: "learning", label: "Learning", color: "#f8b98f" },
    { key: "reasoning", label: "User reasoning", color: "#9ed9aa" },
    { key: "criticalEngagement", label: "Critical engagement", color: "#86c8f2" },
    { key: "delegation", label: "Delegation", color: "#ffd45d" }
  ];
  const TONES = [
    { key: "positive", label: "Positive", color: "#9ed9aa" },
    { key: "neutral", label: "Neutral", color: "#c8c8ce" },
    { key: "negative", label: "Negative", color: "#f8b98f" }
  ];
  const REFLECTION_LABELS = {
    understand: "Clarified something",
    "own-thinking": "Prompted my own thinking",
    "question-further": "Questioned it further",
    accepted: "Accepted it as given",
    result: "Accepted it as given"
  };

  let menuScanFrame = null;
  let lastFocusedElement = null;
  let refreshTimer = null;
  let latestReportData = null;

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

  function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }

  function percentage(part, total) {
    return total ? Math.round((part / total) * 100) : 0;
  }

  function emptyBehaviourTotals() {
    return {
      prompts: 0,
      promptsWithPaste: 0,
      pasteEvents: 0,
      promptsWithEdits: 0,
      editActions: 0,
      revisionEpisodes: 0
    };
  }

  function addBehaviourTotals(target, source) {
    Object.keys(target).forEach(key => {
      target[key] += number(source?.[key]);
    });
    return target;
  }

  function conversationKeyFromHref(href) {
    try {
      const match = new URL(href, location.origin).pathname.match(/^\/c\/([^/]+)/);
      return match ? `/c/${match[1]}` : null;
    } catch {
      return null;
    }
  }

  async function sha256Fingerprint(value) {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 32);
  }

  async function currentSidebarConversationIds() {
    const conversationKeys = new Set();
    const sidebarLimit = Math.min(520, window.innerWidth * .4);
    document.querySelectorAll('a[href*="/c/"]').forEach(link => {
      const rect = link.getBoundingClientRect();
      if (!rect.width || !rect.height || rect.left < 0 || rect.right > sidebarLimit) return;
      const key = conversationKeyFromHref(link.href);
      if (key) conversationKeys.add(key);
    });

    const currentKey = conversationKeyFromHref(location.href);
    if (currentKey) conversationKeys.add(currentKey);

    return new Set(await Promise.all(
      Array.from(conversationKeys, key => sha256Fingerprint(`${location.hostname}|${key}`))
    ));
  }

  function formatDecimal(value) {
    return Number(value || 0).toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 1
    });
  }

  function dateKey(date) {
    return date.toISOString().slice(0, 10);
  }

  function reconcileDailyPromptTotal(daily, promptTotal) {
    const reconciled = Object.fromEntries(
      Object.entries(daily || {}).map(([date, totals]) => [date, { ...totals }])
    );
    const datedPromptTotal = Object.values(reconciled)
      .reduce((total, values) => total + number(values?.prompts), 0);
    const missingPrompts = Math.max(0, number(promptTotal) - datedPromptTotal);
    if (!missingPrompts) return reconciled;

    const today = dateKey(new Date());
    reconciled[today] = {
      ...emptyBehaviourTotals(),
      ...(reconciled[today] || {}),
      prompts: number(reconciled[today]?.prompts) + missingPrompts
    };
    return reconciled;
  }

  function lastEightWeeks(daily) {
    const weeks = [];
    const now = new Date();
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const currentMonday = new Date(today);
    currentMonday.setUTCDate(today.getUTCDate() - ((today.getUTCDay() + 6) % 7));

    for (let offset = 7; offset >= 0; offset -= 1) {
      const start = new Date(currentMonday);
      start.setUTCDate(currentMonday.getUTCDate() - offset * 7);
      const end = new Date(start);
      end.setUTCDate(start.getUTCDate() + 6);
      let prompts = 0;
      const days = [];
      for (let dayOffset = 0; dayOffset < 7; dayOffset += 1) {
        const day = new Date(start);
        day.setUTCDate(start.getUTCDate() + dayOffset);
        const observed = day <= today;
        const dayPrompts = observed ? number(daily?.[dateKey(day)]?.prompts) : null;
        if (observed) prompts += dayPrompts;
        days.push({
          key: dateKey(day),
          label: day.toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" }),
          dateLabel: day.toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" }),
          prompts: dayPrompts,
          observed
        });
      }
      weeks.push({
        key: dateKey(start),
        endKey: dateKey(end),
        label: start.toLocaleDateString(undefined, {
          day: "numeric",
          month: "short",
          timeZone: "UTC"
        }),
        fullLabel: `${start.toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" })} - ${end.toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" })}`,
        prompts,
        days
      });
    }
    const firstTrackedDate = Object.entries(daily || {})
      .filter(([, totals]) => number(totals?.prompts) > 0)
      .map(([key]) => key)
      .sort()[0];
    if (!firstTrackedDate) return weeks.slice(-1);
    const firstVisibleWeek = weeks.findIndex(week => week.endKey >= firstTrackedDate);
    return firstVisibleWeek >= 0 ? weeks.slice(firstVisibleWeek) : weeks;
  }

  function aggregateReport(stored, includedConversationIds = null) {
    const scope = includedConversationIds instanceof Set
      ? includedConversationIds
      : null;
    const includeEntry = ([conversationId]) => !scope || scope.has(conversationId);
    const conversations = Object.fromEntries(
      Object.entries(stored[ANALYSES_KEY] || {}).filter(includeEntry)
    );
    const storedBehavioural = stored[BEHAVIOURAL_KEY] || {};
    const behaviouralConversations = Object.fromEntries(
      Object.entries(storedBehavioural.conversations || {}).filter(includeEntry)
    );
    const scopedBehaviourTotals = Object.values(behaviouralConversations)
      .reduce((totals, conversation) => addBehaviourTotals(totals, conversation?.totals || conversation), emptyBehaviourTotals());
    const scopedDaily = {};
    Object.values(behaviouralConversations).forEach(conversation => {
      Object.entries(conversation?.daily || {}).forEach(([date, totals]) => {
        scopedDaily[date] = addBehaviourTotals(
          scopedDaily[date] || emptyBehaviourTotals(),
          totals
        );
      });
    });
    const behavioural = scope
      ? {
        ...storedBehavioural,
        totals: scopedBehaviourTotals,
        daily: scopedDaily,
        conversations: behaviouralConversations
      }
      : storedBehavioural;
    const reflections = (Array.isArray(stored[REFLECTIONS_KEY])
      ? stored[REFLECTIONS_KEY]
      : []).filter(record => !scope || scope.has(record?.conversationId));
    const themeConversations = Object.fromEntries(
      Object.entries(stored[THEMES_KEY]?.conversations || {}).filter(includeEntry)
    );
    const analyses = Object.values(conversations).flatMap(records =>
      Array.isArray(records) ? records : []
    );
    const conversationIds = scope || new Set([
      ...Object.keys(conversations),
      ...Object.keys(behavioural.conversations || {}),
      ...Object.keys(themeConversations),
      ...reflections.map(record => record?.conversationId).filter(Boolean)
    ]);

    const behaviour = behavioural.totals || {};
    const trackedPrompts = number(behaviour.prompts);
    const analysedRecords = analyses.filter(record => record?.sentiment || record?.intention);
    const analysedPrompts = analysedRecords.length;
    const prompts = Math.max(trackedPrompts, analysedPrompts);
    const analysisDaily = {};
    let datedAnalysedPrompts = 0;
    analysedRecords.forEach(record => {
      const capturedAt = new Date(record?.recordedAt || "");
      if (Number.isNaN(capturedAt.getTime())) return;
      const key = dateKey(capturedAt);
      analysisDaily[key] = analysisDaily[key] || emptyBehaviourTotals();
      analysisDaily[key].prompts += 1;
      datedAnalysedPrompts += 1;
    });
    const analysisTimelineIsComplete = analysedPrompts > 0 &&
      datedAnalysedPrompts === analysedPrompts &&
      analysedPrompts >= trackedPrompts;
    const datedPromptRecords = analysisTimelineIsComplete
      ? analysisDaily
      : (behavioural.daily || {});
    const reportDaily = reconcileDailyPromptTotal(datedPromptRecords, prompts);
    const weeks = lastEightWeeks(reportDaily);
    const eightWeekPrompts = weeks.reduce((total, week) => total + week.prompts, 0);
    const activeDays = Object.values(reportDaily)
      .filter(day => number(day?.prompts) > 0).length;

    const intentionCounts = Object.fromEntries(INTENTIONS.map(item => [item.key, 0]));
    const toneCounts = Object.fromEntries(TONES.map(item => [item.key, 0]));
    let intentionsAnalysed = 0;
    let activeEngagement = 0;
    let combinedIntentions = 0;
    let delegationOnly = 0;

    analyses.forEach(record => {
      const tone = record?.sentiment?.label;
      if (Object.hasOwn(toneCounts, tone)) toneCounts[tone] += 1;

      const labels = Array.isArray(record?.intention?.labels)
        ? record.intention.labels.filter(label => Object.hasOwn(intentionCounts, label))
        : null;
      if (!labels) return;
      intentionsAnalysed += 1;
      labels.forEach(label => { intentionCounts[label] += 1; });
      const active = labels.includes("reasoning") || labels.includes("criticalEngagement");
      if (active) activeEngagement += 1;
      if (labels.length > 1) combinedIntentions += 1;
      if (labels.includes("delegation") && !active) delegationOnly += 1;
    });

    const totalIntentionSignals = Object.values(intentionCounts)
      .reduce((total, count) => total + count, 0);
    const intentionRows = INTENTIONS.map(item => ({
      ...item,
      count: intentionCounts[item.key],
      rate: percentage(intentionCounts[item.key], totalIntentionSignals)
    }));
    const toneTotal = Object.values(toneCounts).reduce((total, count) => total + count, 0);
    const toneRows = TONES.map(item => ({
      ...item,
      count: toneCounts[item.key],
      rate: percentage(toneCounts[item.key], toneTotal)
    }));

    const themeCounts = new Map();
    let themePromptCount = 0;
    Object.values(themeConversations).forEach(conversation => {
      Object.values(conversation?.prompts || {}).forEach(terms => {
        themePromptCount += 1;
        new Set(Array.isArray(terms) ? terms : []).forEach(term => {
          const cleanTerm = String(term || "").trim();
          if (cleanTerm) themeCounts.set(cleanTerm, (themeCounts.get(cleanTerm) || 0) + 1);
        });
      });
    });
    const themes = Array.from(themeCounts.entries())
      .map(([term, count]) => ({ term, count }))
      .sort((first, second) => second.count - first.count || first.term.localeCompare(second.term))
      .slice(0, 20);

    const reflectionCounts = new Map();
    reflections.forEach(record => {
      const label = REFLECTION_LABELS[record?.choice];
      if (label) reflectionCounts.set(label, (reflectionCounts.get(label) || 0) + 1);
    });
    const reflectionRows = Array.from(reflectionCounts.entries())
      .map(([label, count]) => ({ label, count, rate: percentage(count, reflections.length) }))
      .sort((first, second) => second.count - first.count);

    return {
      chats: conversationIds.size,
      prompts,
      activeDays,
      promptsPerChat: conversationIds.size ? prompts / conversationIds.size : 0,
      eightWeekPrompts,
      weeklyAverage: eightWeekPrompts / weeks.length,
      weekCount: weeks.length,
      weeks,
      analysedPrompts,
      intentionsAnalysed,
      totalIntentionSignals,
      intentionRows,
      activeEngagement,
      combinedIntentions,
      delegationOnly,
      activeRate: percentage(activeEngagement, intentionsAnalysed),
      combinedRate: percentage(combinedIntentions, intentionsAnalysed),
      delegationOnlyRate: percentage(delegationOnly, intentionsAnalysed),
      toneRows,
      toneTotal,
      trackedPrompts,
      promptsWithPaste: number(behaviour.promptsWithPaste),
      promptsWithEdits: number(behaviour.promptsWithEdits),
      pasteRate: percentage(number(behaviour.promptsWithPaste), prompts),
      editRate: percentage(number(behaviour.promptsWithEdits), prompts),
      revisionEpisodes: number(behaviour.revisionEpisodes),
      editActions: number(behaviour.editActions),
      pasteEvents: number(behaviour.pasteEvents),
      reflections: reflections.length,
      reflectionRows,
      themePromptCount,
      themes
    };
  }

  const host = document.createElement("div");
  host.id = ROOT_ID;
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { position: fixed; inset: 0; z-index: 1000001; color: #202124; font-family: inherit; pointer-events: none; }
      * { box-sizing: border-box; }
      .backdrop { position: fixed; inset: 0; display: grid; place-items: center; padding: 24px; background: rgba(0,0,0,.42); backdrop-filter: blur(3px); pointer-events: auto; }
      .backdrop[hidden] { display: none; }
      .report { width: min(980px, 100%); max-height: min(860px, calc(100vh - 48px)); overflow: auto; border: 1px solid #dedee2; border-radius: 24px; background: #f5f5f7; box-shadow: 0 28px 90px rgba(0,0,0,.24); }
      .header { position: sticky; top: 0; z-index: 3; display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; padding: 24px 26px 18px; border-bottom: 1px solid #e0e0e4; background: rgba(245,245,247,.95); backdrop-filter: blur(16px); }
      .eyebrow { margin: 0 0 4px; color: #717178; font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
      h1 { margin: 0; font-size: 28px; line-height: 1.16; }
      .subtitle { margin: 7px 0 0; color: #66666d; font-size: 14px; }
      .close { width: 38px; height: 38px; flex: 0 0 38px; border: 1px solid #d8d8dc; border-radius: 50%; background: #fff; color: #4f4f55; font-size: 25px; line-height: 1; cursor: pointer; }
      .header-actions { display: flex; align-items: center; gap: 9px; }
      .download { min-height: 38px; padding: 0 16px; border: 1px solid #35353a; border-radius: 999px; background: #35353a; color: #fff; font: inherit; font-size: 13px; font-weight: 700; cursor: pointer; }
      .download:hover { background: #202124; }
      .download:disabled { cursor: wait; opacity: .65; }
      .close:focus-visible, .download:focus-visible { outline: 2px solid #0a84ff; outline-offset: 2px; }
      .content { display: grid; gap: 16px; padding: 20px 26px 26px; }
      .summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
      .summary-card, .card { border: 1px solid #e1e1e5; border-radius: 18px; background: #fff; }
      .summary-card { padding: 16px; }
      .summary-value { display: block; font-size: 27px; font-weight: 750; font-variant-numeric: tabular-nums; }
      .summary-label { display: block; margin-top: 3px; color: #73737a; font-size: 13px; line-height: 1.35; }
      .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
      .card { min-width: 0; padding: 18px; }
      .card-wide { grid-column: 1 / -1; }
      .card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 15px; }
      h2 { margin: 0; font-size: 18px; }
      .card-note { margin: 0; color: #85858c; font-size: 12px; text-align: right; }
      .week-chart { min-height: 230px; }
      .week-chart svg { display: block; width: 100%; height: auto; overflow: visible; }
      .chart-grid { stroke: #e5e5e9; stroke-width: 1; }
      .chart-axis-label, .chart-week-label { fill: #77777e; font-family: inherit; font-size: 11px; }
      .chart-area { fill: rgba(134,200,242,.2); }
      .chart-line { fill: none; stroke: #4ea7df; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }
      .chart-point { fill: #fff; stroke: #4ea7df; stroke-width: 3; }
      .chart-value { fill: currentColor; font-family: inherit; font-size: 11px; font-weight: 700; text-anchor: middle; }
      .rows { display: grid; gap: 10px; }
      .metric-row { display: grid; grid-template-columns: minmax(120px, 1fr) minmax(90px, 1.35fr) 42px; align-items: center; gap: 10px; }
      .metric-name { overflow: hidden; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
      .track { height: 10px; overflow: hidden; border-radius: 999px; background: #ededf0; }
      .fill { display: block; width: var(--rate); height: 100%; border-radius: inherit; background: var(--color); }
      .rate { font-size: 14px; font-weight: 650; text-align: right; font-variant-numeric: tabular-nums; }
      .engagement-grid, .process-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 9px; margin-top: 16px; }
      .mini-metric { padding: 12px; border-radius: 13px; background: #f5f5f7; }
      .mini-value { display: block; font-size: 21px; font-weight: 750; }
      .mini-label { display: block; margin-top: 4px; color: #74747b; font-size: 11.5px; line-height: 1.35; }
      .tone-layout { display: grid; grid-template-columns: 124px 1fr; align-items: center; gap: 20px; }
      .donut { position: relative; width: 116px; aspect-ratio: 1; border-radius: 50%; background: conic-gradient(var(--positive) 0 var(--positive-end), var(--neutral) var(--positive-end) var(--neutral-end), var(--negative) var(--neutral-end) 100%); }
      .donut::after { content: ""; position: absolute; inset: 17px; border-radius: 50%; background: #fff; }
      .donut-total { position: absolute; inset: 0; z-index: 1; display: grid; place-content: center; text-align: center; }
      .donut-number { font-size: 25px; font-weight: 750; }
      .donut-label { color: #85858c; font-size: 10px; }
      .tone-list { display: grid; gap: 10px; }
      .tone-row { display: grid; grid-template-columns: 10px 1fr auto; align-items: center; gap: 8px; font-size: 13px; }
      .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--color); }
      .cloud { display: flex; min-height: 150px; flex-wrap: wrap; align-content: center; align-items: center; justify-content: center; gap: 8px 14px; padding: 18px; border-radius: 14px; background: #f5f5f7; }
      .cloud-word { max-width: 100%; overflow-wrap: anywhere; color: hsl(var(--hue) 55% 34%); font-size: var(--size); font-weight: var(--weight); line-height: 1; }
      .empty { display: grid; min-height: 110px; place-items: center; margin: 0; padding: 18px; color: #808087; font-size: 13px; line-height: 1.45; text-align: center; }
      .reflection-list { display: grid; gap: 8px; }
      .reflection-row { display: flex; justify-content: space-between; gap: 12px; padding: 10px 12px; border-radius: 11px; background: #f5f5f7; font-size: 13px; }
      .privacy { margin: 0; color: #85858c; font-size: 11.5px; line-height: 1.5; text-align: center; }
      @media (max-width: 760px) {
        .backdrop { padding: 8px; }
        .report { max-height: calc(100vh - 16px); border-radius: 18px; }
        .header { padding: 20px 18px 15px; }
        .content { padding: 16px 18px 22px; }
        .summary-grid { grid-template-columns: repeat(2, 1fr); }
        .grid { grid-template-columns: 1fr; }
        .card-wide { grid-column: auto; }
      }
      @media (prefers-color-scheme: dark) {
        :host { color: #f1f1f3; }
        .backdrop { background: rgba(0,0,0,.66); }
        .report { border-color: #3d3d42; background: #1f1f22; }
        .header { border-color: #3d3d42; background: rgba(31,31,34,.94); }
        .eyebrow, .subtitle, .summary-label, .card-note, .day-label, .mini-label, .donut-label, .privacy { color: #aaaab1; }
        .close, .summary-card, .card { border-color: #3d3d42; background: #29292d; color: #f1f1f3; }
        .download { border-color: #ececf0; background: #ececf0; color: #202124; }
        .download:hover { background: #fff; }
        .track, .mini-metric, .cloud, .reflection-row { background: #37373c; }
        .chart-grid { stroke: #48484e; }
        .chart-axis-label, .chart-week-label { fill: #aaaab1; }
        .chart-area { fill: rgba(134,200,242,.13); }
        .chart-point { fill: #29292d; }
        .donut::after { background: #29292d; }
        .cloud-word { color: hsl(var(--hue) 72% 72%); }
        .empty { color: #aaaab1; }
      }
    </style>
    <div class="backdrop" id="backdrop" hidden>
      <section class="report" role="dialog" aria-modal="true" aria-labelledby="reportTitle">
        <header class="header">
          <div>
            <p class="eyebrow">Overall usage</p>
            <h1 id="reportTitle">My AI Mirror report</h1>
            <p class="subtitle">A local overview of how you use AI across your chats.</p>
          </div>
          <div class="header-actions">
            <button class="download" id="download" type="button">Download PDF</button>
            <button class="close" id="close" type="button" aria-label="Close report">×</button>
          </div>
        </header>
        <div class="content">
          <section class="summary-grid" id="summary"></section>
          <section class="grid">
            <article class="card card-wide">
              <div class="card-head"><h2>Prompts per week</h2><p class="card-note" id="weeklyNote"></p></div>
              <div class="week-chart" id="trend"></div>
            </article>
            <article class="card">
              <div class="card-head"><h2>Interaction focus</h2><p class="card-note">All intention signals</p></div>
              <div class="rows" id="intentions"></div>
              <div class="engagement-grid" id="engagement"></div>
            </article>
            <article class="card">
              <div class="card-head"><h2>Prompt tone</h2><p class="card-note">Local sentiment model</p></div>
              <div class="tone-layout" id="tone"></div>
            </article>
            <article class="card">
              <div class="card-head"><h2>Writing process</h2><p class="card-note">Before prompts are sent</p></div>
              <div class="process-grid" id="process"></div>
            </article>
            <article class="card">
              <div class="card-head"><h2>Response reflections</h2><p class="card-note" id="reflectionNote"></p></div>
              <div class="reflection-list" id="reflections"></div>
            </article>
            <article class="card card-wide">
              <div class="card-head"><h2>Common themes</h2><p class="card-note">Most recurring locally extracted topics</p></div>
              <div class="cloud" id="cloud"></div>
            </article>
          </section>
          <p class="privacy">Calculated privately on this device. The theme cloud stores extracted topic labels and prompt fingerprints, never the full text of your prompts.</p>
        </div>
      </section>
    </div>
  `;
  document.documentElement.appendChild(host);
  window.__sentinelBindShadowTheme?.(shadow);

  const backdrop = shadow.getElementById("backdrop");
  const closeButton = shadow.getElementById("close");
  const downloadButton = shadow.getElementById("download");

  function addSummaryCard(container, value, label) {
    const card = document.createElement("div");
    card.className = "summary-card";
    const valueElement = document.createElement("span");
    valueElement.className = "summary-value";
    valueElement.textContent = value;
    const labelElement = document.createElement("span");
    labelElement.className = "summary-label";
    labelElement.textContent = label;
    card.append(valueElement, labelElement);
    container.appendChild(card);
  }

  function renderSummary(data) {
    const summary = shadow.getElementById("summary");
    summary.replaceChildren();
    addSummaryCard(summary, data.prompts.toLocaleString(), "prompts tracked");
    addSummaryCard(summary, data.chats.toLocaleString(), data.chats === 1 ? "chat" : "chats");
    addSummaryCard(summary, formatDecimal(data.weeklyAverage), `prompts per week · ${data.weekCount}-week average`);
    addSummaryCard(summary, formatDecimal(data.promptsPerChat), "prompts per chat");
  }

  function renderTrend(data) {
    const trend = shadow.getElementById("trend");
    trend.replaceChildren();
    const namespace = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(namespace, "svg");
    svg.setAttribute("viewBox", "0 0 820 230");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Prompts per week over the last eight weeks");
    const left = 42;
    const right = 800;
    const top = 24;
    const bottom = 188;
    const maximum = Math.max(1, ...data.weeks.map(week => week.prompts));
    const axisMaximum = Math.max(4, Math.ceil(maximum / 4) * 4);
    const xFor = index => data.weeks.length === 1
      ? (left + right) / 2
      : left + (index / (data.weeks.length - 1)) * (right - left);
    const yFor = value => bottom - (value / axisMaximum) * (bottom - top);

    for (let step = 0; step <= 4; step += 1) {
      const value = (axisMaximum / 4) * step;
      const y = yFor(value);
      const line = document.createElementNS(namespace, "line");
      line.setAttribute("class", "chart-grid");
      line.setAttribute("x1", String(left));
      line.setAttribute("x2", String(right));
      line.setAttribute("y1", String(y));
      line.setAttribute("y2", String(y));
      const label = document.createElementNS(namespace, "text");
      label.setAttribute("class", "chart-axis-label");
      label.setAttribute("x", "34");
      label.setAttribute("y", String(y + 4));
      label.setAttribute("text-anchor", "end");
      label.textContent = String(Math.round(value));
      svg.append(line, label);
    }

    const points = data.weeks.map((week, index) => [xFor(index), yFor(week.prompts)]);
    const area = document.createElementNS(namespace, "path");
    area.setAttribute("class", "chart-area");
    area.setAttribute("d", `M ${left} ${bottom} L ${points.map(point => point.join(" ")).join(" L ")} L ${right} ${bottom} Z`);
    const path = document.createElementNS(namespace, "polyline");
    path.setAttribute("class", "chart-line");
    path.setAttribute("points", points.map(point => point.join(",")).join(" "));
    svg.append(area, path);

    data.weeks.forEach((week, index) => {
      const [x, y] = points[index];
      const point = document.createElementNS(namespace, "circle");
      point.setAttribute("class", "chart-point");
      point.setAttribute("cx", String(x));
      point.setAttribute("cy", String(y));
      point.setAttribute("r", "5");
      const value = document.createElementNS(namespace, "text");
      value.setAttribute("class", "chart-value");
      value.setAttribute("x", String(x));
      value.setAttribute("y", String(Math.max(14, y - 11)));
      value.textContent = String(week.prompts);
      const label = document.createElementNS(namespace, "text");
      label.setAttribute("class", "chart-week-label");
      label.setAttribute("x", String(x));
      label.setAttribute("y", "214");
      label.setAttribute("text-anchor", "middle");
      label.textContent = week.label;
      const title = document.createElementNS(namespace, "title");
      title.textContent = `${week.fullLabel}: ${week.prompts} ${week.prompts === 1 ? "prompt" : "prompts"}`;
      point.appendChild(title);
      svg.append(point, value, label);
    });
    trend.appendChild(svg);
    shadow.getElementById("weeklyNote").textContent =
      `${formatDecimal(data.weeklyAverage)} weekly average · ${data.weekCount === 1 ? "current week" : `last ${data.weekCount} weeks`}`;
  }

  function renderIntentions(data) {
    const rows = shadow.getElementById("intentions");
    rows.replaceChildren();
    data.intentionRows.forEach(item => {
      const row = document.createElement("div");
      row.className = "metric-row";
      row.innerHTML = `
        <span class="metric-name">${item.label}</span>
        <span class="track"><span class="fill" style="--rate:${item.rate}%;--color:${item.color}"></span></span>
        <span class="rate">${item.rate}%</span>
      `;
      rows.appendChild(row);
    });
    const engagement = shadow.getElementById("engagement");
    engagement.replaceChildren();
    [
      [data.activeRate, "reasoning or critical engagement"],
      [data.combinedRate, "combined intentions"],
      [data.delegationOnlyRate, "delegation without active engagement"]
    ].forEach(([value, label]) => {
      const item = document.createElement("div");
      item.className = "mini-metric";
      item.innerHTML = `<span class="mini-value">${value}%</span><span class="mini-label">${label}</span>`;
      engagement.appendChild(item);
    });
  }

  function renderTone(data) {
    const tone = shadow.getElementById("tone");
    tone.replaceChildren();
    if (!data.toneTotal) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "Tone results will appear after prompts have been analysed.";
      tone.appendChild(empty);
      return;
    }
    const positive = data.toneRows.find(item => item.key === "positive")?.rate || 0;
    const neutral = data.toneRows.find(item => item.key === "neutral")?.rate || 0;
    const donut = document.createElement("div");
    donut.className = "donut";
    donut.style.setProperty("--positive", TONES[0].color);
    donut.style.setProperty("--neutral", TONES[1].color);
    donut.style.setProperty("--negative", TONES[2].color);
    donut.style.setProperty("--positive-end", `${positive}%`);
    donut.style.setProperty("--neutral-end", `${positive + neutral}%`);
    donut.innerHTML = `<div class="donut-total"><span class="donut-number">${data.toneTotal}</span><span class="donut-label">prompts</span></div>`;
    const list = document.createElement("div");
    list.className = "tone-list";
    data.toneRows.forEach(item => {
      const row = document.createElement("div");
      row.className = "tone-row";
      row.innerHTML = `<span class="dot" style="--color:${item.color}"></span><span>${item.label}</span><strong>${item.rate}%</strong>`;
      list.appendChild(row);
    });
    tone.append(donut, list);
  }

  function renderProcess(data) {
    const process = shadow.getElementById("process");
    process.replaceChildren();
    [
      [`${data.pasteRate}%`, "with pasted content", `${data.pasteEvents} paste events`],
      [`${data.editRate}%`, "edited before sending", `${data.editActions} edit actions`],
      [String(data.revisionEpisodes), "revision episodes", "across tracked prompts"]
    ].forEach(([value, label, title]) => {
      const item = document.createElement("div");
      item.className = "mini-metric";
      item.title = title;
      item.innerHTML = `<span class="mini-value">${value}</span><span class="mini-label">${label}</span>`;
      process.appendChild(item);
    });
  }

  function renderReflections(data) {
    const container = shadow.getElementById("reflections");
    container.replaceChildren();
    shadow.getElementById("reflectionNote").textContent = `${data.reflections} recorded`;
    if (!data.reflectionRows.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "Your response-reflection choices will appear here.";
      container.appendChild(empty);
      return;
    }
    data.reflectionRows.forEach(item => {
      const row = document.createElement("div");
      row.className = "reflection-row";
      const label = document.createElement("span");
      label.textContent = item.label;
      const value = document.createElement("strong");
      value.textContent = `${item.rate}%`;
      row.append(label, value);
      container.appendChild(row);
    });
  }

  function renderCloud(data) {
    const cloud = shadow.getElementById("cloud");
    cloud.replaceChildren();
    if (!data.themes.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "Themes will appear as you revisit chats or send new prompts.";
      cloud.appendChild(empty);
      return;
    }
    const counts = data.themes.map(item => item.count);
    const minimum = Math.min(...counts);
    const maximum = Math.max(...counts);
    data.themes.forEach((item, index) => {
      const scale = maximum === minimum ? .55 : (item.count - minimum) / (maximum - minimum);
      const word = document.createElement("span");
      word.className = "cloud-word";
      word.textContent = item.term;
      word.title = `Found in ${item.count} ${item.count === 1 ? "prompt" : "prompts"}`;
      word.style.setProperty("--size", `${14 + scale * 22}px`);
      word.style.setProperty("--weight", String(Math.round(540 + scale * 240)));
      word.style.setProperty("--hue", String([18, 145, 203, 42][index % 4]));
      cloud.appendChild(word);
    });
  }

  function render(data) {
    latestReportData = data;
    renderSummary(data);
    renderTrend(data);
    renderIntentions(data);
    renderTone(data);
    renderProcess(data);
    renderReflections(data);
    renderCloud(data);
  }

  async function refresh() {
    const stored = await storageGet([
      ANALYSES_KEY,
      BEHAVIOURAL_KEY,
      REFLECTIONS_KEY,
      THEMES_KEY
    ]);
    if (!hasExtensionContext()) return;
    const conversationIds = await currentSidebarConversationIds();
    render(aggregateReport(stored, conversationIds));
  }

  function setOpen(open) {
    backdrop.hidden = !open;
    if (open) {
      lastFocusedElement = document.activeElement;
      refresh();
      closeButton.focus();
    } else if (lastFocusedElement instanceof HTMLElement && lastFocusedElement.isConnected) {
      lastFocusedElement.focus();
    }
  }

  closeButton.addEventListener("click", () => setOpen(false));
  downloadButton.addEventListener("click", async () => {
    downloadButton.disabled = true;
    downloadButton.textContent = "Preparing PDF…";
    try {
      await refresh();
      if (!latestReportData || !globalThis.MyAiMirrorPdf?.downloadReport) {
        throw new Error("PDF generator unavailable");
      }
      globalThis.MyAiMirrorPdf.downloadReport(latestReportData);
      downloadButton.textContent = "PDF downloaded";
      setTimeout(() => { downloadButton.textContent = "Download PDF"; }, 1800);
    } catch (error) {
      console.error("My AI Mirror could not create the PDF report:", error);
      downloadButton.textContent = "Try again";
    } finally {
      downloadButton.disabled = false;
    }
  });
  backdrop.addEventListener("click", event => {
    if (event.target === backdrop) setOpen(false);
  });
  shadow.addEventListener("pointerdown", event => event.stopPropagation());
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !backdrop.hidden) setOpen(false);
  });

  function isVisible(element) {
    if (!element?.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 20 || rect.bottom <= 0 || rect.right <= 0) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > .01;
  }

  function findCurrentChatMenu() {
    const deleteItems = Array.from(document.querySelectorAll('[role="menuitem"], button'))
      .filter(isVisible)
      .filter(item => /^delete$/i.test(String(item.textContent || "").trim()));

    for (const deleteItem of deleteItems) {
      let candidate = deleteItem;
      for (let depth = 0; candidate && depth < 8; depth += 1) {
        const text = String(candidate.textContent || "").replace(/\s+/g, " ");
        if (/view files in chat/i.test(text) && /archive/i.test(text) && /delete/i.test(text)) {
          return { menu: candidate, deleteItem };
        }
        candidate = candidate.parentElement;
      }
    }
    return null;
  }

  function directChildWithin(element, ancestor) {
    let current = element;
    while (current?.parentElement && current.parentElement !== ancestor) {
      current = current.parentElement;
    }
    return current?.parentElement === ancestor ? current : null;
  }

  function replaceMenuItemLabel(item, templateLabel, nextLabel) {
    const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if (String(node.nodeValue || "").trim() === templateLabel) {
        node.nodeValue = node.nodeValue.replace(templateLabel, nextLabel);
        return node.parentElement;
      }
      node = walker.nextNode();
    }
    const label = document.createElement("span");
    label.textContent = nextLabel;
    item.appendChild(label);
    return label;
  }

  async function downloadCurrentReport(item, labelElement) {
    if (item.getAttribute("aria-busy") === "true") return;
    item.setAttribute("aria-busy", "true");
    if (labelElement) labelElement.textContent = "Creating PDF…";
    try {
      const stored = await storageGet([
        ANALYSES_KEY,
        BEHAVIOURAL_KEY,
        REFLECTIONS_KEY,
        THEMES_KEY
      ]);
      const conversationIds = await currentSidebarConversationIds();
      const reportData = aggregateReport(stored, conversationIds);
      if (!globalThis.MyAiMirrorPdf?.downloadReport) {
        throw new Error("PDF generator unavailable");
      }
      globalThis.MyAiMirrorPdf.downloadReport(reportData);
      if (labelElement?.isConnected) labelElement.textContent = "PDF downloaded";
    } catch (error) {
      console.error("My AI Mirror could not create the PDF report:", error);
      if (labelElement?.isConnected) labelElement.textContent = "Try again";
    } finally {
      item.removeAttribute("aria-busy");
    }
  }

  function injectMenuItem() {
    menuScanFrame = null;
    const existingItem = document.querySelector(`[${MENU_ITEM_ATTRIBUTE}]`);
    if (existingItem && isVisible(existingItem)) return;
    existingItem?.remove();
    const found = findCurrentChatMenu();
    if (!found) return;

    const deleteRow = directChildWithin(found.deleteItem, found.menu) || found.deleteItem;
    const neutralTemplate = Array.from(
      found.menu.querySelectorAll('[role="menuitem"], button')
    ).find(item => /^(archive|pin chat|view files in chat)$/i.test(
      String(item.textContent || "").trim()
    ));
    const template = neutralTemplate || found.deleteItem;
    const templateLabel = String(template.textContent || "").trim();
    const reportItem = template.cloneNode(true);
    reportItem.removeAttribute("id");
    reportItem.removeAttribute("href");
    reportItem.removeAttribute("target");
    reportItem.removeAttribute("aria-labelledby");
    reportItem.removeAttribute("data-testid");
    reportItem.setAttribute("role", "menuitem");
    reportItem.setAttribute("aria-label", "Create PDF report");
    reportItem.setAttribute(MENU_ITEM_ATTRIBUTE, "true");
    const labelElement = replaceMenuItemLabel(
      reportItem,
      templateLabel,
      "Create PDF report"
    );
    const icon = reportItem.querySelector("svg");
    if (icon) {
      icon.setAttribute("viewBox", "0 0 24 24");
      icon.setAttribute("fill", "none");
      icon.setAttribute("stroke", "currentColor");
      icon.setAttribute("stroke-width", "1.8");
      icon.setAttribute("stroke-linecap", "round");
      icon.setAttribute("aria-hidden", "true");
      icon.innerHTML = '<path d="M4 19V9M10 19V5M16 19v-7M22 19H2"></path>';
    }
    const setHighlighted = highlighted => {
      reportItem.toggleAttribute("data-highlighted", highlighted);
      reportItem.style.backgroundColor = highlighted
        ? "var(--token-main-surface-secondary, rgba(127,127,127,.12))"
        : "";
    };
    reportItem.addEventListener("pointerenter", () => setHighlighted(true));
    reportItem.addEventListener("pointerleave", () => setHighlighted(false));
    reportItem.addEventListener("focus", () => setHighlighted(true));
    reportItem.addEventListener("blur", () => setHighlighted(false));
    reportItem.addEventListener("click", event => {
      event.preventDefault();
      downloadCurrentReport(reportItem, labelElement);
    });
    found.menu.insertBefore(reportItem, deleteRow);
  }

  function scheduleMenuScan() {
    if (menuScanFrame !== null) return;
    menuScanFrame = requestAnimationFrame(injectMenuItem);
  }

  const observer = new MutationObserver(scheduleMenuScan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("pointerdown", () => setTimeout(scheduleMenuScan, 0), true);

  if (hasExtensionContext()) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || backdrop.hidden) return;
      if (![ANALYSES_KEY, BEHAVIOURAL_KEY, REFLECTIONS_KEY, THEMES_KEY]
        .some(key => changes[key])) return;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refresh, 80);
    });
  }

  scheduleMenuScan();
})();
