console.log("SENTINEL: running");

// triggers
// TODO: move to separate file 
const TRIGGERS = {
  words: ["suicide", "self-harm"],
  phrases: ["kill myself", "end my life"]
};

// highlight style for the triggers
const HIGHLIGHT_TEXT =
  `color:#ff3b30; font-weight:700; background:rgba(255,59,48,0.18);` +
  `padding:0 3px; border-radius:5px; box-decoration-break:clone; -webkit-box-decoration-break:clone;`;

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeJSONParse(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

function normalizeMessageText(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

function cleanMiniMapText(text) {
  return (text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map(line => line.trim().replace(/\s{2,}/g, " "))
    .filter(line =>
      line &&
      !/^thinking$/i.test(line) &&
      !/^thought for\b/i.test(line)
    )
    .join("\n");
}

function getMiniMapText(message) {
  if (!message) return "";

  const clone = message.cloneNode(true);
  clone.querySelectorAll("table").forEach(table => {
    const placeholder = document.createElement("div");
    placeholder.textContent = "[table]";
    table.replaceWith(placeholder);
  });

  return cleanMiniMapText(clone.innerText || clone.textContent);
}

function getTriggerPatterns(terms = []) {
  const wantedTerms = new Set(terms.map(term => term.toLowerCase()));
  const includeTerm = term => !wantedTerms.size || wantedTerms.has(term.toLowerCase());

  return [
    ...TRIGGERS.phrases
      .filter(includeTerm)
      .map(term => ({ term, regex: new RegExp(escapeRegex(term), "gi") })),
    ...TRIGGERS.words
      .filter(includeTerm)
      .map(term => ({ term, regex: new RegExp(`\\b${escapeRegex(term)}\\b`, "gi") }))
  ].sort((a, b) => b.term.length - a.term.length);
}

function tmsHash(str) {
  // tiny stable hash (fast, good enough for de-duplication)
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

const runtimeMessageKeys = new WeakMap();
let runtimeMessageKeySeq = 0;

function getMessageKey(msg) {
  // try to find a stable id from the DOM (best case)
  const carrier =
    msg.closest("[data-message-id]") ||
    msg.closest("[data-testid]") ||
    msg;

  const text = normalizeMessageText(msg.innerText);
  const textHash = tmsHash(text);
  const msgId =
    carrier.getAttribute?.("data-message-id") ||
    msg.getAttribute?.("data-message-id");

  if (msgId) return `id:${msgId}`;

  const role = getMessageRole(msg);
  const cached = runtimeMessageKeys.get(msg);
  if (cached && cached.role === role && cached.textHash === textHash) {
    return cached.key;
  }

  const key = `runtime:${role}:${textHash}:${++runtimeMessageKeySeq}`;
  runtimeMessageKeys.set(msg, { key, role, textHash });
  return key;
}

function wasAlreadyCounted(key) {
  const raw = sessionStorage.getItem("tms_seenMessageKeys") || "[]";
  const arr = safeJSONParse(raw, []);
  return arr.includes(key);
}

function markCounted(key) {
  const raw = sessionStorage.getItem("tms_seenMessageKeys") || "[]";
  const arr = safeJSONParse(raw, []);
  if (!arr.includes(key)) arr.push(key);
  sessionStorage.setItem("tms_seenMessageKeys", JSON.stringify(arr));
}

function isNearPageBottom() {
  const doc = document.documentElement;
  const scrollBottom = window.scrollY + window.innerHeight;
  return doc.scrollHeight - scrollBottom < 320;
}

function isNearPageTop() {
  return window.scrollY < 320;
}

function shouldCountLiveMessage(msg, key) {
  if (!isNearPageBottom()) return false;
  if (!initialScanComplete && !allowFirstVisibleUserCount) return false;

  const userMessages = Array.from(document.querySelectorAll('[data-message-author-role="user"]'));
  const lastUserMessage = userMessages[userMessages.length - 1];
  return lastUserMessage ? getMessageKey(lastUserMessage) === key : false;
}

function getConversationKey() {
  const routeKey = `${location.pathname}${location.search}`;
  if (location.pathname.includes("/c/")) return routeKey;

  const firstMessage = document.querySelector('[data-message-author-role]');
  const firstHash = firstMessage ? tmsHash(normalizeMessageText(firstMessage.innerText)) : "empty";
  return `${routeKey}:${firstHash}`;
}

function getMessageRole(message) {
  return message.getAttribute("data-message-author-role") || "unknown";
}

function getVisibleConversationSignature(messages = document.querySelectorAll('[data-message-author-role]')) {
  const visibleMessages = Array.from(messages);
  if (!visibleMessages.length) return "";

  const sample = [
    ...visibleMessages.slice(0, 3),
    ...visibleMessages.slice(-3)
  ];
  const text = sample
    .map(message => `${getMessageRole(message)}:${normalizeMessageText(message.innerText).slice(0, 220)}`)
    .join("\n");

  return `${visibleMessages.length}:${tmsHash(text)}`;
}

function visibleMessagesOverlapMiniMap(messages) {
  if (!miniMapEntries.size) return false;
  return Array.from(messages).some(message => miniMapEntries.has(getMessageKey(message)));
}

function clearConversationState(clearSessionStats = true) {
  riskMarkers.forEach(item => item.marker.remove());
  riskMarkers.clear();
  miniMapEntries.clear();
  miniMapLineRefs = [];
  miniMapOrder = [];
  initialScanComplete = false;
  miniMapBuildComplete = false;

  const mini = document.getElementById("tms-risk-mini");
  if (mini) mini.innerHTML = "";

  const viewport = document.getElementById("tms-risk-viewport");
  if (viewport) {
    viewport.style.top = "0px";
    viewport.style.height = "42px";
  }

  sessionStorage.removeItem("tms_seenMessageKeys");

  if (clearSessionStats) {
    sessionStorage.removeItem("tms_sessionTriggers");
    sessionStorage.removeItem("tms_sessionTotalHits");
    sessionStorage.removeItem("tms_lastTriggerTime");
    chrome.storage.local.remove("activeSession");
  }
}

function handleConversationChange() {
  const nextKey = getConversationKey();
  if (nextKey === currentConversationKey) return false;

  const currentMessages = document.querySelectorAll('[data-message-author-role]');
  staleConversationSignature = visibleMessagesOverlapMiniMap(currentMessages)
    ? getVisibleConversationSignature(currentMessages)
    : null;
  currentConversationKey = nextKey;
  historyLoadInProgress = false;
  clearConversationState(true);
  return true;
}

const riskMarkers = new Map();
const miniMapEntries = new Map();
let miniMapLineRefs = [];
let miniMapOrder = [];
let riskBarUpdateTimer = null;
let miniMapRenderTimer = null;
let initialScanComplete = false;
let currentConversationKey = getConversationKey();
let historyLoadInProgress = false;
const historyLoadedConversations = new Set();
let activeScrollContainer = null;
let miniMapBuildComplete = false;
let allowFirstVisibleUserCount = false;
let staleConversationSignature = null;

function getRiskColor(hits) {
  if (hits >= 5) return "#d32f2f";
  if (hits >= 3) return "#ff9500";
  return "#ffcc00";
}

function getSessionTotalHits() {
  return Number(sessionStorage.getItem("tms_sessionTotalHits") || "0");
}

function getSessionRiskVisual(totalHits = getSessionTotalHits()) {
  if (totalHits > 5) {
    return {
      level: "critical",
      color: "#8b0000",
      glow: "rgba(139,0,0,0.58)"
    };
  }

  if (totalHits >= 5) {
    return {
      level: "severe",
      color: "#ff3b30",
      glow: "rgba(255,59,48,0.52)"
    };
  }

  if (totalHits >= 3) {
    return {
      level: "high",
      color: "#ff9500",
      glow: "rgba(255,149,0,0.48)"
    };
  }

  if (totalHits >= 1) {
    return {
      level: "low",
      color: "#ffd60a",
      glow: "rgba(255,214,10,0.45)"
    };
  }

  return {
    level: "",
    color: "#30d158",
    glow: "rgba(48,209,88,0.42)"
  };
}

function applyRiskMarkerVisual(marker, totalHits = 0) {
  if (!marker) return;

  const visual = getSessionRiskVisual(totalHits);
  marker.style.setProperty("--tms-marker-line-color", visual.color);
  marker.style.setProperty("--tms-marker-line-glow", visual.glow);

  if (visual.level) marker.dataset.level = visual.level;
  else delete marker.dataset.level;
}

function applyRiskMarkerVisualByKey(key, totalHits) {
  const item = riskMarkers.get(key);
  if (!item) return;

  item.sessionTotalHits = totalHits;
  applyRiskMarkerVisual(item.marker, totalHits);
}

function applyRiskMarkerVisualByOrder() {
  const mini = document.getElementById("tms-risk-mini");
  if (!mini || !riskMarkers.size) return;

  Array.from(riskMarkers.values())
    .map(item => {
      const entry = miniMapEntries.get(item.key);
      const top = entry ? getRiskMarkerTop(entry, item.matchedWords) : 0;
      return { item, top, order: miniMapOrder.indexOf(item.key) };
    })
    .sort((a, b) => a.top - b.top || a.order - b.order)
    .forEach(({ item }, index) => {
      item.visualTriggerIndex = index + 1;
      applyRiskMarkerVisual(item.marker, item.visualTriggerIndex);
    });
}

function shouldRenderMiniMapForCurrentScan() {
  return historyLoadInProgress || !miniMapBuildComplete || isNearPageBottom();
}

function getRiskLabel(hits) {
  if (hits >= 5) return "Severe";
  if (hits >= 3) return "High";
  return "Low";
}

function ensureRiskBar() {
  if (document.getElementById("tms-risk-style")) return;

  const style = document.createElement("style");
  style.id = "tms-risk-style";
  style.innerHTML = `
    #tms-risk-bar {
      --tms-risk-line-color: #30d158;
      --tms-risk-line-glow: rgba(48,209,88,0.42);
      position: fixed;
      top: 0;
      right: 0;
      width: 138px;
      height: 100vh;
      background: linear-gradient(
        180deg,
        rgba(58,58,58,0.74),
        rgba(68,68,68,0.68)
      );
      border-left: 1px solid rgba(0,0,0,0.14);
      border-top: 0;
      border-radius: 0;
      box-shadow: inset 1px 0 0 rgba(255,255,255,0.05);
      z-index: 999998;
      pointer-events: auto;
      overflow: hidden;
      backdrop-filter: blur(2px);
    }
    #tms-risk-bar::before {
      content: "";
      position: absolute;
      inset: 0;
      opacity: 0.18;
      background:
        repeating-linear-gradient(
          to bottom,
          transparent 0,
          transparent 9px,
          rgba(255,255,255,0.08) 10px
        );
      pointer-events: none;
    }
    #tms-risk-mini {
      position: absolute;
      inset: 8px 7px 8px 2px;
      pointer-events: none;
      z-index: 1;
    }
    .tms-mini-line {
      position: absolute;
      left: 0;
      right: 0;
      height: 2px;
      margin-bottom: 0;
      overflow: hidden;
      color: #f0f0f0;
      font: 500 3.65px/3.65px Consolas, "SF Mono", Menlo, monospace;
      letter-spacing: 0;
      white-space: nowrap;
      text-rendering: geometricPrecision;
      pointer-events: none;
      opacity: 1;
    }
    .tms-mini-line[data-role="user"] {
      color: #00d8ff;
      font-weight: 700;
      text-shadow: 0 0 3px rgba(0,216,255,0.5);
    }
    .tms-mini-line[data-role="assistant"] {
      color: #e8e4dc;
    }
    .tms-mini-line[data-role="unknown"] {
      color: #e4e4e4;
    }
    #tms-risk-viewport {
      position: absolute;
      left: 0;
      right: 0;
      min-height: 42px;
      background: rgba(255,255,255,0.07);
      border-top: 0;
      border-bottom: 0;
      pointer-events: none;
      z-index: 2;
      opacity: 0;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.09);
      transition: opacity 0.14s ease, background 0.14s ease;
    }
    #tms-risk-bar:hover #tms-risk-viewport {
      opacity: 0.9;
      background: rgba(255,255,255,0.13);
    }
    .tms-risk-marker {
      position: absolute;
      left: 0;
      right: 0;
      width: 100%;
      min-height: 3px;
      border: 0;
      border-radius: 0;
      padding: 0;
      cursor: default;
      opacity: 0.95;
      background: transparent;
      box-shadow: none;
      appearance: none;
      z-index: 4;
      pointer-events: none;
      transition: opacity 0.12s ease;
    }
    .tms-risk-marker::before {
      content: "";
      position: absolute;
      left: 0;
      right: 0;
      top: 0;
      height: 2px;
      background: var(--tms-marker-line-color, #30d158);
      box-shadow: 0 0 5px var(--tms-marker-line-glow, rgba(48,209,88,0.42));
    }
    .tms-risk-marker:hover {
      opacity: 1;
    }
    .tms-risk-focus {
      outline: 2px solid #ff3b30 !important;
      outline-offset: 4px !important;
      border-radius: 8px !important;
      transition: outline-color 0.25s ease;
    }
  `;
  document.head.appendChild(style);

  const bar = document.createElement("div");
  bar.id = "tms-risk-bar";
  bar.title = "Sentinel trigger minimap";
  bar.innerHTML = `
    <div id="tms-risk-mini"></div>
    <div id="tms-risk-viewport"></div>
  `;
  document.body.appendChild(bar);

  window.addEventListener("scroll", scheduleRiskBarUpdate, { passive: true });
  window.addEventListener("resize", () => {
    updateRiskBarFrame();
    scheduleMiniMapRender([]);
    scheduleRiskBarUpdate();
  });

  updateRiskBarFrame();
}

function findShareButton() {
  const candidates = Array.from(document.querySelectorAll("button, a"));
  return candidates.find(el => (el.innerText || "").trim() === "Share") || null;
}

function updateRiskBarFrame() {
  const bar = document.getElementById("tms-risk-bar");
  if (!bar) return;

  const shareButton = findShareButton();
  let top = 0;

  if (shareButton) {
    const shareRect = shareButton.getBoundingClientRect();
    const headerCandidate = shareButton.closest("header, nav") || shareButton.parentElement;
    const headerRect = headerCandidate?.getBoundingClientRect();
    top = Math.max(0, Math.round(Math.max(shareRect.bottom, headerRect?.bottom || 0)));
  }

  if (!top || top < 48 || top > 140) {
    top = 80;
  }

  bar.style.top = `${top}px`;
  bar.style.height = `calc(100vh - ${top}px)`;
}

function getMiniTextLines(text) {
  const lines = [];
  const paragraphs = text
    .replace(/\r/g, "")
    .split(/\n+/)
    .map(part => part.trim())
    .filter(Boolean);

  paragraphs.forEach((paragraph, paragraphIndex) => {
    const words = paragraph.split(/\s+/);
    let current = "";
    let lineIndex = 0;

    words.forEach(word => {
      const seed = `${paragraphIndex}:${lineIndex}:${current.slice(0, 12)}`;
      const target = 46 + (parseInt(tmsHash(seed).slice(0, 2), 16) % 42);
      const next = current ? `${current} ${word}` : word;

      if (next.length > target && current) {
        lines.push(current);
        current = word;
        lineIndex++;
      } else {
        current = next;
      }
    });

    if (current) lines.push(current);
  });

  return lines.length ? lines : [""];
}

function lineContainsTrigger(text, matchedTerms = []) {
  return getTriggerPatterns(matchedTerms).some(({ regex }) => {
    regex.lastIndex = 0;
    return regex.test(text);
  });
}

function syncMiniMapEntries(messages) {
  const currentKeys = [];

  Array.from(messages).forEach(message => {
    const key = getMessageKey(message);
    const text = getMiniMapText(message);
    const existing = miniMapEntries.get(key);
    currentKeys.push(key);

    if (existing) {
      existing.element = message;
      existing.role = getMessageRole(message);
      existing.text = text || existing.text;
      existing.lines = getMiniTextLines(existing.text);
      return;
    }

    miniMapEntries.set(key, {
      key,
      element: message,
      role: getMessageRole(message),
      text,
      lines: getMiniTextLines(text),
      mapTop: 0,
      mapHeight: 0,
      lineTops: new Map()
    });
  });

  integrateMiniMapOrder(currentKeys, messages);
}

function isVisibleWindowNearBottom(messages) {
  const visibleMessages = Array.from(messages);
  if (!visibleMessages.length) return isNearPageBottom();

  const lastVisible = visibleMessages[visibleMessages.length - 1];
  const allMessages = Array.from(document.querySelectorAll('[data-message-author-role]'));
  const lastDomMessage = allMessages[allMessages.length - 1];
  return lastVisible === lastDomMessage || isNearPageBottom();
}

function isVisibleWindowNearTop(messages) {
  const visibleMessages = Array.from(messages);
  if (!visibleMessages.length) return isNearPageTop();

  const firstVisible = visibleMessages[0];
  const allMessages = Array.from(document.querySelectorAll('[data-message-author-role]'));
  const firstDomMessage = allMessages[0];
  return firstVisible === firstDomMessage && (historyLoadInProgress || isNearPageTop());
}

function integrateMiniMapOrder(currentKeys, messages = []) {
  const uniqueKeys = currentKeys.filter((key, index) =>
    currentKeys.indexOf(key) === index
  );
  if (!uniqueKeys.length) return;

  const oldOrder = miniMapOrder.slice();
  const currentSet = new Set(uniqueKeys);
  const anchorIndexes = uniqueKeys
    .map(key => oldOrder.indexOf(key))
    .filter(index => index >= 0);

  miniMapOrder = oldOrder.filter(key => !currentSet.has(key));

  let insertAt = miniMapOrder.length;
  if (anchorIndexes.length) {
    const firstAnchor = Math.min(...anchorIndexes);
    insertAt = oldOrder
      .slice(0, firstAnchor)
      .filter(key => !currentSet.has(key)).length;
  } else if (isVisibleWindowNearBottom(messages)) {
    insertAt = miniMapOrder.length;
  } else if (isVisibleWindowNearTop(messages)) {
    insertAt = 0;
  }

  miniMapOrder.splice(insertAt, 0, ...uniqueKeys);
}

function getScrollTop(container) {
  return container === document.scrollingElement || container === document.documentElement
    ? window.scrollY
    : container.scrollTop;
}

function scrollContainerTo(container, top) {
  const safeTop = Math.max(0, top);
  ensureScrollContainerListener(container);

  if (container === document.scrollingElement || container === document.documentElement) {
    window.scrollTo({ top: safeTop, behavior: "smooth" });
  } else {
    container.scrollTo({ top: safeTop, behavior: "smooth" });
  }

  scheduleRiskBarUpdate();
  setTimeout(scheduleRiskBarUpdate, 120);
  setTimeout(scheduleRiskBarUpdate, 320);
  setTimeout(scheduleRiskBarUpdate, 650);
}

function setScrollTopInstant(container, top) {
  const safeTop = Math.max(0, top);
  if (container === document.scrollingElement || container === document.documentElement) {
    window.scrollTo(0, safeTop);
  } else {
    container.scrollTop = safeTop;
  }
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getScrollContainer(element) {
  let node = element?.parentElement;

  while (node && node !== document.body && node !== document.documentElement) {
    const style = getComputedStyle(node);
    const canScroll = /(auto|scroll)/.test(style.overflowY);
    if (canScroll && node.scrollHeight > node.clientHeight + 20) {
      ensureScrollContainerListener(node);
      return node;
    }
    node = node.parentElement;
  }

  const fallback = document.scrollingElement || document.documentElement;
  ensureScrollContainerListener(fallback);
  return fallback;
}

function ensureScrollContainerListener(container) {
  if (!container || activeScrollContainer === container) return;

  if (
    activeScrollContainer &&
    activeScrollContainer !== document.scrollingElement &&
    activeScrollContainer !== document.documentElement
  ) {
    activeScrollContainer.removeEventListener("scroll", scheduleRiskBarUpdate);
  }

  activeScrollContainer = container;

  if (container !== document.scrollingElement && container !== document.documentElement) {
    container.addEventListener("scroll", scheduleRiskBarUpdate, { passive: true });
  }
}

function getElementTopInContainer(element, container) {
  const elementRect = element.getBoundingClientRect();
  if (container === document.scrollingElement || container === document.documentElement) {
    return elementRect.top + window.scrollY;
  }

  const containerRect = container.getBoundingClientRect();
  return elementRect.top - containerRect.top + container.scrollTop;
}

function focusElementInScrollContainer(element) {
  const container = getScrollContainer(element);
  const containerHeight = container === document.scrollingElement || container === document.documentElement
    ? window.innerHeight
    : container.clientHeight;
  const absoluteTop = getElementTopInContainer(element, container);
  scrollContainerTo(container, absoluteTop - containerHeight * 0.35);

  element.classList.add("tms-risk-focus");
  setTimeout(() => element.classList.remove("tms-risk-focus"), 1600);
}

function findTriggerHighlight(message, matchedTerms = []) {
  const highlights = Array.from(message.querySelectorAll(".tms-highlighted-trigger"));
  if (!highlights.length) return null;

  const normalizedTerms = matchedTerms.map(term => term.toLowerCase());
  return highlights.find(highlight =>
    normalizedTerms.includes((highlight.dataset.tmsTerm || "").toLowerCase())
  ) || highlights[0];
}

function findTriggerTextNode(message, matchedTerms = []) {
  const patterns = getTriggerPatterns(matchedTerms);
  if (!patterns.length) return null;

  const walker = document.createTreeWalker(message, NodeFilter.SHOW_TEXT, null, false);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = node.nodeValue;
    const matches = patterns
      .map(({ term, regex }) => {
        regex.lastIndex = 0;
        const match = regex.exec(text);
        return match ? { node, term, index: match.index, length: match[0].length } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.index - b.index || b.length - a.length);

    if (matches.length) return matches[0];
  }

  return null;
}

function focusTextMatch(message, matchedTerms = []) {
  const highlight = findTriggerHighlight(message, matchedTerms);
  if (highlight) {
    focusElementInScrollContainer(highlight);
    return true;
  }

  const match = findTriggerTextNode(message, matchedTerms);
  if (!match) return false;

  const range = document.createRange();
  range.setStart(match.node, match.index);
  range.setEnd(match.node, match.index + match.length);
  const marker = document.createElement("span");
  marker.className = "tms-highlighted-trigger";
  marker.dataset.tmsTerm = match.term;
  marker.setAttribute("style", HIGHLIGHT_TEXT);

  try {
    range.surroundContents(marker);
    focusElementInScrollContainer(marker);
    return true;
  } catch {
    return false;
  }
}

function messageMatchesEntry(message, entry) {
  if (!message || !entry || !document.body.contains(message)) return false;

  if (getMessageKey(message) === entry.key) return true;

  const normalizedEntryText = normalizeMessageText(entry.text);
  const text = normalizeMessageText(message.innerText);
  if (!normalizedEntryText || text !== normalizedEntryText || normalizedEntryText.length < 40) {
    return false;
  }

  const sameTextCount = Array.from(document.querySelectorAll('[data-message-author-role]'))
    .filter(candidate => normalizeMessageText(candidate.innerText) === normalizedEntryText)
    .length;

  return sameTextCount === 1;
}

function getRenderedMessageForEntry(entry) {
  if (!entry) return null;
  if (messageMatchesEntry(entry.element, entry)) return entry.element;

  return Array.from(document.querySelectorAll('[data-message-author-role]'))
    .find(message => messageMatchesEntry(message, entry)) || null;
}

function getContainerScrollMetrics(container) {
  if (container === document.scrollingElement || container === document.documentElement) {
    return {
      scrollTop: window.scrollY,
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: window.innerHeight
    };
  }

  return {
    scrollTop: container.scrollTop,
    scrollHeight: container.scrollHeight,
    clientHeight: container.clientHeight
  };
}

function getVisibleMiniMapOrderIndex() {
  const messages = Array.from(document.querySelectorAll('[data-message-author-role]'));
  const indexes = messages
    .map(message => miniMapOrder.indexOf(getMessageKey(message)))
    .filter(index => index >= 0);

  if (!indexes.length) return -1;
  return Math.round((Math.min(...indexes) + Math.max(...indexes)) / 2);
}

function getMarkerScrollDirection(marker, key) {
  const viewport = document.getElementById("tms-risk-viewport");
  if (marker && viewport) {
    const markerRect = marker.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    const markerCenter = markerRect.top + markerRect.height / 2;
    const viewportCenter = viewportRect.top + viewportRect.height / 2;

    if (markerCenter < viewportCenter - 4) return -1;
    if (markerCenter > viewportCenter + 4) return 1;
  }

  const targetIndex = miniMapOrder.indexOf(key);
  const visibleIndex = getVisibleMiniMapOrderIndex();
  return visibleIndex >= 0 && targetIndex >= 0 && targetIndex < visibleIndex ? -1 : 1;
}

async function revealEntryByDirectionalScroll(entry, direction) {
  const firstMessage = document.querySelector('[data-message-author-role]');
  if (!firstMessage) return null;

  const container = getScrollContainer(firstMessage);
  for (let step = 0; step < 42; step++) {
    const found = getRenderedMessageForEntry(entry);
    if (found) return found;

    const metrics = getContainerScrollMetrics(container);
    const delta = metrics.clientHeight * 0.82 * direction;
    const nextTop = Math.max(0, Math.min(metrics.scrollHeight - metrics.clientHeight, metrics.scrollTop + delta));

    if (Math.abs(nextTop - metrics.scrollTop) < 4) break;

    setScrollTopInstant(container, nextTop);
    await wait(180);
  }

  return getRenderedMessageForEntry(entry);
}

function scrollToMarkerApproximation(marker) {
  const bar = document.getElementById("tms-risk-bar");
  const firstMessage = document.querySelector('[data-message-author-role]');
  if (!bar || !marker || !firstMessage) return false;

  const barRect = bar.getBoundingClientRect();
  const markerRect = marker.getBoundingClientRect();
  const markerCenter = markerRect.top + markerRect.height / 2;
  const ratio = Math.min(Math.max((markerCenter - barRect.top) / Math.max(barRect.height, 1), 0), 1);
  const container = getScrollContainer(firstMessage);
  const metrics = getContainerScrollMetrics(container);
  const maxScroll = Math.max(metrics.scrollHeight - metrics.clientHeight, 0);

  scrollContainerTo(container, ratio * maxScroll);
  return true;
}

function getMarkerCenterInBar(marker) {
  const bar = document.getElementById("tms-risk-bar");
  if (!bar || !marker) return null;

  const barRect = bar.getBoundingClientRect();
  const markerRect = marker.getBoundingClientRect();
  return markerRect.top + markerRect.height / 2 - barRect.top;
}

function getCurrentMiniViewportRange() {
  const mini = document.getElementById("tms-risk-mini");
  const firstMessage = document.querySelector('[data-message-author-role]');
  if (!mini || !firstMessage) return null;

  const container = getScrollContainer(firstMessage);
  return getMiniMapViewportFromVisibleMessages(mini, container);
}

function findClosestRenderedTriggerForMarker(marker, matchedWords = []) {
  const mini = document.getElementById("tms-risk-mini");
  const markerCenter = getMarkerCenterInBar(marker);
  if (!mini || markerCenter === null) return null;

  let closest = null;
  let closestDistance = Infinity;

  document.querySelectorAll('[data-message-author-role="user"]').forEach(message => {
    const result = detectTriggers(message.innerText || "");
    if (result.hits <= 0) return;

    const key = getMessageKey(message);
    const entry = miniMapEntries.get(key);
    if (!entry || !entry.mapHeight) return;

    const terms = matchedWords.length ? matchedWords : result.matchedWords;
    const triggerTop = mini.offsetTop + getRiskMarkerTop(entry, terms);
    const distance = Math.abs(triggerTop - markerCenter);

    if (distance < closestDistance) {
      closest = { message, matchedWords: terms };
      closestDistance = distance;
    }
  });

  return closest?.message ? closest : null;
}

function messageHasTriggerTerms(message, matchedWords = []) {
  if (!message || !document.body.contains(message)) return false;

  const result = detectTriggers(message.innerText || "");
  if (result.hits <= 0) return false;
  if (!matchedWords.length) return true;

  const terms = new Set(result.matchedWords.map(term => term.toLowerCase()));
  return matchedWords.some(term => terms.has(term.toLowerCase()));
}

function focusRenderedTriggerMessage(message, matchedWords = []) {
  if (!messageHasTriggerTerms(message, matchedWords)) return false;

  if (!focusTextMatch(message, matchedWords)) {
    focusElementInScrollContainer(message);
  }
  return true;
}

async function focusMarkerByMiniMapPosition(marker, matchedWords = []) {
  const firstMessage = document.querySelector('[data-message-author-role]');
  if (!firstMessage || getMarkerCenterInBar(marker) === null) return false;

  const container = getScrollContainer(firstMessage);

  for (let step = 0; step < 44; step++) {
    const markerCenter = getMarkerCenterInBar(marker);
    if (markerCenter === null) return false;

    const range = getCurrentMiniViewportRange();
    const renderedTrigger = findClosestRenderedTriggerForMarker(marker, matchedWords);

    if (range && markerCenter >= range.top - 10 && markerCenter <= range.bottom + 10 && renderedTrigger) {
      if (!focusTextMatch(renderedTrigger.message, renderedTrigger.matchedWords)) {
        focusElementInScrollContainer(renderedTrigger.message);
      }
      return true;
    }

    const metrics = getContainerScrollMetrics(container);
    const direction = range && markerCenter < range.top ? -1 : 1;
    const nextTop = Math.max(
      0,
      Math.min(metrics.scrollHeight - metrics.clientHeight, metrics.scrollTop + metrics.clientHeight * 0.72 * direction)
    );

    if (Math.abs(nextTop - metrics.scrollTop) < 4) break;

    setScrollTopInstant(container, nextTop);
    await wait(190);
  }

  const renderedTrigger = findClosestRenderedTriggerForMarker(marker, matchedWords);
  if (!renderedTrigger) return false;

  if (!focusTextMatch(renderedTrigger.message, renderedTrigger.matchedWords)) {
    focusElementInScrollContainer(renderedTrigger.message);
  }
  return true;
}

function getVisualTriggerEntryForMarker(marker, matchedWords = []) {
  const mini = document.getElementById("tms-risk-mini");
  if (!mini || !marker) return null;

  const markerRect = marker.getBoundingClientRect();
  const markerCenter = markerRect.top + markerRect.height / 2;
  let closest = null;
  let closestDistance = Infinity;

  miniMapOrder.forEach(key => {
    const entry = miniMapEntries.get(key);
    if (!entry || !entry.mapHeight) return;
    if (entry.role !== "user") return;
    if (!entry.lines.some(line => lineContainsTrigger(line, matchedWords))) return;

    const top = mini.getBoundingClientRect().top + getRiskMarkerTop(entry, matchedWords);
    const distance = Math.abs(top - markerCenter);
    if (distance < closestDistance) {
      closest = entry;
      closestDistance = distance;
    }
  });

  return closest;
}

async function focusTriggerMessage(key, fallbackElement) {
  const markerInfo = riskMarkers.get(key);
  const matchedWords = markerInfo?.matchedWords || [];
  const entry =
    miniMapEntries.get(key) ||
    getVisualTriggerEntryForMarker(markerInfo?.marker, matchedWords);

  if (!entry) return;

  let target = getRenderedMessageForEntry(entry);
  if (focusRenderedTriggerMessage(target, matchedWords)) {
    return;
  }

  if (messageMatchesEntry(markerInfo?.element, entry) && focusRenderedTriggerMessage(markerInfo.element, matchedWords)) {
    return;
  }

  if (messageMatchesEntry(fallbackElement, entry) && focusRenderedTriggerMessage(fallbackElement, matchedWords)) {
    return;
  }

  if (scrollToMarkerApproximation(markerInfo?.marker)) {
    await wait(520);
    target = getRenderedMessageForEntry(entry);
    if (focusRenderedTriggerMessage(target, matchedWords)) {
      return;
    }
  }

  const direction = getMarkerScrollDirection(markerInfo?.marker, key);
  target = await revealEntryByDirectionalScroll(entry, direction);
  if (focusRenderedTriggerMessage(target, matchedWords)) {
    return;
  }

  if (await focusMarkerByMiniMapPosition(markerInfo?.marker, matchedWords)) {
    return;
  }
}

function renderMiniMap(messages) {
  ensureRiskBar();
  syncMiniMapEntries(messages);

  const mini = document.getElementById("tms-risk-mini");
  const bar = document.getElementById("tms-risk-bar");
  if (!mini || !bar) return;

  const miniHeight = mini.clientHeight || bar.clientHeight;
  const entries = miniMapOrder
    .map(key => miniMapEntries.get(key))
    .filter(Boolean);
  const allLines = [];

  entries.forEach((entry, entryIndex) => {
    if (entryIndex > 0) {
      const gapLines = 0;
      for (let i = 0; i < gapLines; i++) {
        allLines.push({ entry: null, text: "", isGap: true });
      }
    }

    const markerInfo = riskMarkers.get(entry.key);
    entry.lines.forEach((text, lineIndex) => {
      allLines.push({
        entry,
        text,
        lineIndex,
        isGap: false,
        isTriggerLine: markerInfo ? lineContainsTrigger(text, markerInfo.matchedWords) : false
      });
    });
  });

  const normalLineStep = 3.65;
  const minLineStep = 2.45;
  const normalCapacity = Math.max(1, Math.floor(miniHeight / normalLineStep));
  const minimumCapacity = Math.max(1, Math.floor(miniHeight / minLineStep));
  let renderedLines = allLines;
  let lineStep = normalLineStep;

  if (allLines.length > normalCapacity) {
    lineStep = Math.max(minLineStep, Math.min(normalLineStep, miniHeight / allLines.length));
  }

  if (allLines.length > minimumCapacity) {
    const renderStride = Math.max(1, Math.ceil(allLines.length / minimumCapacity));
    renderedLines = allLines.filter((lineRef, index) =>
      index % renderStride === 0 ||
      (!lineRef.isGap && lineRef.lineIndex === 0) ||
      lineRef.isTriggerLine
    );
    lineStep = minLineStep;
  }

  const lineCount = Math.max(1, renderedLines.length);
  lineStep = Math.min(lineStep, miniHeight / lineCount);
  const lineHeight = Math.max(1.95, lineStep);
  const fontSize = Math.max(1.95, lineHeight);

  mini.innerHTML = "";
  miniMapLineRefs = [];

  entries.forEach(entry => {
    entry.mapTop = 0;
    entry.mapHeight = 0;
    entry.lineTops = new Map();
  });

  renderedLines.forEach((lineRef, index) => {
    const top = Math.min(miniHeight - lineHeight, index * lineStep);
    const entry = lineRef.entry;

    if (lineRef.isGap || !entry) return;

    const line = document.createElement("div");

    if (entry.mapHeight === 0) entry.mapTop = top;
    entry.mapHeight = top - entry.mapTop + lineHeight;
    entry.lineTops.set(lineRef.lineIndex, top);

    line.className = "tms-mini-line";
    line.dataset.role = entry.role;
    line.style.top = `${top}px`;
    line.style.height = `${lineHeight}px`;
    line.style.lineHeight = `${lineHeight}px`;
    line.style.fontSize = `${fontSize}px`;
    line.textContent = lineRef.text;

    miniMapLineRefs.push({ entry, top, height: lineHeight, lineIndex: lineRef.lineIndex, text: lineRef.text });
    mini.appendChild(line);
  });

  updateRiskBarPositions();
}

function scheduleMiniMapRender(messages) {
  clearTimeout(miniMapRenderTimer);
  miniMapRenderTimer = setTimeout(() => renderMiniMap(messages), 120);
}

function collectVisibleConversation(render = false) {
  const messages = document.querySelectorAll('[data-message-author-role]');
  syncMiniMapEntries(messages);
  messages.forEach(message => {
    if (getMessageRole(message) !== "user") return;
    const key = getMessageKey(message);
    const result = detectTriggers(message.innerText || "");
    if (result.hits > 0) {
      highlight(message);
      addRiskMarker(key, message, result.hits, result.matchedWords);
    }
  });
  if (render) renderMiniMap(messages);
}

async function loadConversationHistoryOnce() {
  const conversationKey = getConversationKey();
  if (
    historyLoadInProgress ||
    historyLoadedConversations.has(conversationKey) ||
    !document.querySelector('[data-message-author-role]')
  ) return;

  historyLoadInProgress = true;
  historyLoadedConversations.add(conversationKey);

  const firstMessage = document.querySelector('[data-message-author-role]');
  const container = getScrollContainer(firstMessage);
  const originalTop = getScrollTop(container);
  let previousTop = originalTop;
  let previousEntryCount = miniMapEntries.size;
  let stableRounds = 0;

  try {
    collectVisibleConversation(false);

    for (let step = 0; step < 36; step++) {
      const metrics = getContainerScrollMetrics(container);

      setScrollTopInstant(container, Math.max(0, metrics.scrollTop - metrics.clientHeight * 0.85));
      await wait(240);
      collectVisibleConversation(false);

      const nextTop = getScrollTop(container);
      const nextEntryCount = miniMapEntries.size;
      const noScrollMovement = Math.abs(nextTop - previousTop) < 8;
      const noNewMessages = nextEntryCount === previousEntryCount;

      if (noScrollMovement && noNewMessages) stableRounds++;
      else stableRounds = 0;

      previousTop = nextTop;
      previousEntryCount = nextEntryCount;

      if (stableRounds >= 4 || (nextTop <= 0 && noNewMessages)) break;
    }
  } finally {
    setScrollTopInstant(container, originalTop);
    await wait(120);
    collectVisibleConversation(true);
    miniMapBuildComplete = true;
    scheduleRiskBarUpdate();
    historyLoadInProgress = false;
  }
}

function setRiskBarLevel() {
  const bar = document.getElementById("tms-risk-bar");
  if (!bar) return;

  const visual = getSessionRiskVisual();
  bar.style.setProperty("--tms-risk-line-color", visual.color);
  bar.style.setProperty("--tms-risk-line-glow", visual.glow);

  if (visual.level) bar.dataset.level = visual.level;
  else delete bar.dataset.level;
}

function getRiskMarkerTop(entry, matchedWords = []) {
  if (!entry) return 0;

  const triggerLineIndex = entry.lines.findIndex(line => lineContainsTrigger(line, matchedWords));
  if (triggerLineIndex >= 0 && entry.lineTops?.has(triggerLineIndex)) {
    return entry.lineTops.get(triggerLineIndex);
  }

  return entry.mapTop;
}

function getContainerViewportRect(container) {
  if (container === document.scrollingElement || container === document.documentElement) {
    return { top: 0, bottom: window.innerHeight, height: window.innerHeight };
  }

  const rect = container.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom, height: rect.height };
}

function getMiniMapViewportFromVisibleMessages(mini, container) {
  if (!mini || !miniMapEntries.size) return null;

  const viewportRect = getContainerViewportRect(container);
  const spans = [];

  document.querySelectorAll('[data-message-author-role]').forEach(message => {
    const entry = miniMapEntries.get(getMessageKey(message));
    if (!entry || !entry.mapHeight) return;

    const rect = message.getBoundingClientRect();
    const overlapTop = Math.max(rect.top, viewportRect.top);
    const overlapBottom = Math.min(rect.bottom, viewportRect.bottom);
    if (overlapBottom <= overlapTop) return;

    const messageHeight = Math.max(rect.height, 1);
    const startRatio = Math.min(Math.max((overlapTop - rect.top) / messageHeight, 0), 1);
    const endRatio = Math.min(Math.max((overlapBottom - rect.top) / messageHeight, 0), 1);

    spans.push({
      top: mini.offsetTop + entry.mapTop + entry.mapHeight * startRatio,
      bottom: mini.offsetTop + entry.mapTop + entry.mapHeight * endRatio
    });
  });

  if (!spans.length) return null;

  return {
    top: Math.min(...spans.map(span => span.top)),
    bottom: Math.max(...spans.map(span => span.bottom))
  };
}

function updateRiskBarPositions() {
  const bar = document.getElementById("tms-risk-bar");
  if (!bar) return;

  const barHeight = bar.clientHeight;
  const firstMessage = document.querySelector('[data-message-author-role]');
  const container = getScrollContainer(firstMessage || document.body);
  const metrics = getContainerScrollMetrics(container);
  const scrollHeight = Math.max(metrics.scrollHeight, metrics.clientHeight, 1);
  const mini = document.getElementById("tms-risk-mini");
  const viewport = document.getElementById("tms-risk-viewport");
  const visibleRatio = Math.min(metrics.clientHeight / scrollHeight, 1);
  const viewportHeight = Math.max(42, barHeight * visibleRatio);
  const maxScroll = Math.max(scrollHeight - metrics.clientHeight, 1);
  const viewportTop = (metrics.scrollTop / maxScroll) * (barHeight - viewportHeight);

  if (viewport) {
    viewport.style.top = `${Math.min(barHeight - viewportHeight, Math.max(0, viewportTop))}px`;
    viewport.style.height = `${viewportHeight}px`;
  }

  riskMarkers.forEach(item => {
    const entry = miniMapEntries.get(item.key);
    const top = entry && mini
      ? mini.offsetTop + getRiskMarkerTop(entry, item.matchedWords)
      : 0;
    const markerHeight = 3;

    item.marker.style.top = `${Math.min(barHeight - markerHeight, Math.max(0, top))}px`;
    item.marker.style.height = `${markerHeight}px`;
  });

  applyRiskMarkerVisualByOrder();
  setRiskBarLevel();
}

function scheduleRiskBarUpdate() {
  clearTimeout(riskBarUpdateTimer);
  riskBarUpdateTimer = setTimeout(updateRiskBarPositions, 80);
}

function addRiskMarker(key, element, hits, matchedWords, sessionTotalHits = null) {
  ensureRiskBar();

  const bar = document.getElementById("tms-risk-bar");
  if (!bar) return;

  const existing = riskMarkers.get(key);
  if (existing) {
    existing.element = element;
    existing.hits = hits;
    existing.matchedWords = matchedWords;
    if (sessionTotalHits !== null) {
      existing.sessionTotalHits = sessionTotalHits;
      applyRiskMarkerVisual(existing.marker, sessionTotalHits);
    }
    if (shouldRenderMiniMapForCurrentScan()) {
      scheduleMiniMapRender(document.querySelectorAll('[data-message-author-role]'));
    }
    scheduleRiskBarUpdate();
    return;
  }

  const marker = document.createElement("button");
  marker.type = "button";
  marker.className = "tms-risk-marker";
  marker.title = `${getRiskLabel(hits)} trigger marker: ${matchedWords.join(", ")}`;
  marker.setAttribute("aria-label", marker.title);
  applyRiskMarkerVisual(marker, sessionTotalHits ?? 0);

  bar.appendChild(marker);
  riskMarkers.set(key, { key, element, hits, matchedWords, marker, sessionTotalHits });
  if (shouldRenderMiniMapForCurrentScan()) {
    scheduleMiniMapRender(document.querySelectorAll('[data-message-author-role]'));
  }
  scheduleRiskBarUpdate();
}

// single instance with dynamic content update + timer reset
let popupTimer = null;

function ensurePopupStyles() {
  if (document.getElementById("tms-popup-style")) return;

  const style = document.createElement("style");
  style.id = "tms-popup-style";
  style.innerHTML = `
    .tms-popup-box {
      position: fixed;
      top: 80px;
      left: 24px;
      width: 360px;
      max-width: calc(100vw - 48px);
      padding: 16px 20px 20px 20px;
      border-radius: 18px;
      font-family: system-ui, -apple-system, sans-serif;
      color: white;
      box-shadow: 0 12px 28px rgba(0,0,0,0.18);
      z-index: 999999;
      animation: tmsSlideIn 0.25s ease forwards;
      overflow: hidden;
    }
    .tms-popup-header { display:flex; justify-content:space-between; align-items:center; font-weight:600; margin-top:-2px; }
    .tms-popup-close { cursor:pointer; font-size:20px; font-weight:600; padding:4px 8px; border-radius:6px; transition:background 0.2s ease; }
    .tms-popup-close:hover { background: rgba(255,255,255,0.2); }
    .tms-popup-body { margin-top:12px; font-size:14px; }
    .tms-popup-expand { margin-top:12px; font-size:13px; cursor:pointer; opacity:0.9; }
    .tms-popup-details { max-height:0; overflow:hidden; transition:max-height 0.3s ease; margin-top:10px; font-size:13px; }
    .tms-popup-details.open { max-height:200px; }
    .tms-popup-snippet { background: rgba(255,255,255,0.15); padding:6px; border-radius:8px; word-break:break-word; }
    .tms-popup-progress {
      position:absolute; bottom:0; left:0; height:4px; width:100%;
      background: rgba(255,255,255,0.4);
      animation: tmsCountdown 8s linear forwards;
    }
    @keyframes tmsSlideIn { from { opacity:0; transform:translateX(-12px);} to { opacity:1; transform:translateX(0);} }
    @keyframes tmsCountdown { from { width:100%; } to { width:0%; } }
  `;
  document.head.appendChild(style);
}

// function to update the popup with session totals and matched words
function showPopup(sessionTotalHits, lastMatchedWords) {
  ensurePopupStyles();

  let severity = "low";
  let color = "#e53935";
  let title = "Trigger detected";

  if (sessionTotalHits >= 5) {
    severity = "severe";
    color = "#7f0000";
    title = "Severe trigger accumulation";
  } else if (sessionTotalHits >= 3) {
    severity = "high";
    color = "#c62828";
    title = "High trigger accumulation";
  }

  const detailText = sessionTotalHits >= 3
    ? "Triggers detected in session"
    : "Trigger detected in session";

  const wordList = lastMatchedWords.join(", ");
  const nowTime = new Date().toLocaleTimeString();

  const existing = document.getElementById("tms-trigger-popup");
  if (existing) {
    existing.querySelector("#tp-title").textContent = `⚠ ${title}`;
    existing.querySelector("#tp-severity").textContent = severity.toUpperCase();
    existing.querySelector("#tp-count").textContent = sessionTotalHits;
    existing.querySelector("#tp-detailText").textContent = detailText;
    existing.querySelector("#tp-words").textContent = wordList;
    existing.querySelector("#tp-time").textContent = nowTime;

    existing.querySelector(".tms-popup-box").style.background = color;

    const bar = existing.querySelector(".tms-popup-progress");
    const newBar = bar.cloneNode(true);
    bar.parentNode.replaceChild(newBar, bar);

    if (popupTimer) clearTimeout(popupTimer);
    popupTimer = setTimeout(() => existing.remove(), 8000);
    return;
  }

  const popup = document.createElement("div");
  popup.id = "tms-trigger-popup";

  popup.innerHTML = `
    <div class="tms-popup-box" style="background:${color};">
      <div class="tms-popup-header">
        <div id="tp-title">⚠ ${title}</div>
        <div class="tms-popup-close">×</div>
      </div>

      <div class="tms-popup-body">
        Severity: <strong id="tp-severity">${severity.toUpperCase()}</strong><br>
        Session triggers: <strong id="tp-count">${sessionTotalHits}</strong>
      </div>

      <div class="tms-popup-expand">View details ▾</div>

      <div class="tms-popup-details">
        <div class="tms-popup-snippet">
          <span id="tp-detailText">${detailText}</span>: <strong id="tp-words">${wordList}</strong>
        </div>
        <div style="margin-top:6px;font-size:12px;" id="tp-time">${nowTime}</div>
      </div>

      <div class="tms-popup-progress"></div>
    </div>
  `;

  document.body.appendChild(popup);

  popup.querySelector(".tms-popup-close").onclick = () => {
    popup.remove();
    if (popupTimer) clearTimeout(popupTimer);
    popupTimer = null;
  };

  popup.querySelector(".tms-popup-expand").onclick = () =>
    popup.querySelector(".tms-popup-details").classList.toggle("open");

  popupTimer = setTimeout(() => popup.remove(), 8000);
}

// detect triggers in text, return total hits, matched terms, and per-term counts
function detectTriggers(text) {
  let hits = 0;

  // term -> occurrences in this message
  const termCounts = {};

  getTriggerPatterns().forEach(({ term, regex }) => {
    const matches = text.match(regex);
    const count = matches ? matches.length : 0;
    if (count > 0) {
      termCounts[term] = (termCounts[term] || 0) + count;
      hits += count;
    }
  });

  const matchedWords = Object.keys(termCounts);
  return { hits, matchedWords, termCounts };
}

/*
  STORAGE
  TODO: better these functions
  - dailyCounts -> chrome.storage.local (for trends)
  - sessionTriggers -> window.sessionStorage (resets when tab closes)
*/
function updateStorage(hits, matchedTerms, termCounts) {
  if (hits === 0) return getSessionTotalHits();

  const today = new Date().toISOString().split("T")[0];
  const now = Date.now();
  const SESSION_TIMEOUT = 30 * 60 * 1000;

  const last = Number(sessionStorage.getItem("tms_lastTriggerTime") || "0");
  let sessionTriggers = safeJSONParse(sessionStorage.getItem("tms_sessionTriggers") || "{}", {});
  let sessionTotalHits = Number(sessionStorage.getItem("tms_sessionTotalHits") || "0");

  if (now - last > SESSION_TIMEOUT) {
  sessionTriggers = {};
  sessionTotalHits = 0;

  // reset de-duplication for a new session window
  // TODO can this be used for other LLM based systems
  sessionStorage.removeItem("tms_seenMessageKeys");
}

  // total occurrences
  sessionTotalHits += hits;

  // per-term occurrences (NOT +1)
  Object.entries(termCounts).forEach(([term, count]) => {
    sessionTriggers[term] = (sessionTriggers[term] || 0) + count;
  });

  sessionStorage.setItem("tms_sessionTriggers", JSON.stringify(sessionTriggers));
  sessionStorage.setItem("tms_sessionTotalHits", String(sessionTotalHits));
  sessionStorage.setItem("tms_lastTriggerTime", String(now));

  scheduleRiskBarUpdate();
  showPopup(sessionTotalHits, matchedTerms);

  // persistent daily trends
  chrome.storage.local.get(["dailyCounts"], res => {
    const daily = res.dailyCounts || {};
    daily[today] = (daily[today] || 0) + hits;
    chrome.storage.local.set({ dailyCounts: daily });
  });

  // persistent daily term counts (occurrences)
  chrome.storage.local.get(["dailyWordCounts"], res => {
    const dailyWordCounts = res.dailyWordCounts || {};
    if (!dailyWordCounts[today]) dailyWordCounts[today] = {};

    Object.entries(termCounts).forEach(([term, count]) => {
      dailyWordCounts[today][term] = (dailyWordCounts[today][term] || 0) + count;
    });

    chrome.storage.local.set({ dailyWordCounts });
  });

  // keep session snapshot for dashboard
  chrome.storage.local.set({
    activeSession: {
      totalHits: sessionTotalHits,
      words: sessionTriggers
    }
  });

  return sessionTotalHits;
}

// highlighting
function highlight(element) {
  if (element.dataset.highlighted) return;

  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null, false);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  const patterns = getTriggerPatterns();

  textNodes.forEach(node => {
    if (node.parentElement?.closest("code, pre, .tms-highlighted-trigger")) return;

    const originalText = node.nodeValue;
    const matches = [];

    patterns.forEach(({ term, regex }) => {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(originalText)) !== null) {
        matches.push({
          start: match.index,
          end: match.index + match[0].length,
          term,
          text: match[0]
        });
      }
    });

    matches.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
    const selected = [];
    let lastEnd = -1;
    matches.forEach(match => {
      if (match.start >= lastEnd) {
        selected.push(match);
        lastEnd = match.end;
      }
    });

    if (!selected.length) return;

    const fragment = document.createDocumentFragment();
    let cursor = 0;
    selected.forEach(match => {
      if (match.start > cursor) {
        fragment.appendChild(document.createTextNode(originalText.slice(cursor, match.start)));
      }

      const span = document.createElement("span");
      span.className = "tms-highlighted-trigger";
      span.dataset.tmsTerm = match.term.toLowerCase();
      span.setAttribute("style", HIGHLIGHT_TEXT);
      span.textContent = match.text;
      fragment.appendChild(span);
      cursor = match.end;
    });

    if (cursor < originalText.length) {
      fragment.appendChild(document.createTextNode(originalText.slice(cursor)));
    }

    node.parentNode.replaceChild(fragment, node);
  });

  element.dataset.highlighted = "true";
}

// main scanning function
function processMessage(msg) {
  const key = getMessageKey(msg);
  const alreadyCounted = wasAlreadyCounted(key);
  const result = detectTriggers(msg.innerText);

  if (result.hits > 0) {
    highlight(msg);
    addRiskMarker(key, msg, result.hits, result.matchedWords);

    // IMPORTANT: de-dup survives re-renders (TODO: double check)
    if (alreadyCounted) return;

    if (shouldCountLiveMessage(msg, key)) {
      const sessionTotalHits = updateStorage(result.hits, result.matchedWords, result.termCounts);
      applyRiskMarkerVisualByKey(key, sessionTotalHits);
      markCounted(key);
      allowFirstVisibleUserCount = false;
    } else if (!initialScanComplete && !allowFirstVisibleUserCount) {
      markCounted(key);
    }
    return;
  } else {
    if (alreadyCounted) return;
    // still mark so we don't keep re-processing the same message forever
  }

  markCounted(key);
}

function scan() {
  ensureRiskBar();
  updateRiskBarFrame();
  if (handleConversationChange()) {
    setTimeout(scan, 120);
    return;
  }

  const allMessages = document.querySelectorAll('[data-message-author-role]');
  if (!allMessages.length) {
    allowFirstVisibleUserCount = true;
    if (miniMapEntries.size || riskMarkers.size) clearConversationState(true);
    return;
  }

  const visibleSignature = getVisibleConversationSignature(allMessages);
  if (staleConversationSignature && visibleSignature === staleConversationSignature) {
    setTimeout(scan, 180);
    return;
  }
  staleConversationSignature = null;

  if (
    miniMapEntries.size &&
    !historyLoadInProgress &&
    !visibleMessagesOverlapMiniMap(allMessages)
  ) {
    clearConversationState(true);
  }

  if (shouldRenderMiniMapForCurrentScan()) {
    scheduleMiniMapRender(allMessages);
  }

  const userMessages = document.querySelectorAll('[data-message-author-role="user"]');
  userMessages.forEach(processMessage);

  initialScanComplete = true;
  if (!miniMapBuildComplete) loadConversationHistoryOnce();
}

let debounceTimer;
const observer = new MutationObserver(mutations => {
  const onlySentinelUiChanged = mutations.every(mutation =>
    mutation.target instanceof Element &&
    mutation.target.closest("#tms-risk-bar, #tms-trigger-popup")
  );
  if (onlySentinelUiChanged) return;

  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(scan, 300);
});

observer.observe(document.body, { childList: true, subtree: true });
ensureRiskBar();
scan();
setInterval(() => {
  if (handleConversationChange()) setTimeout(scan, 120);
}, 1000);

// cleanup session snapshot on tab close
window.addEventListener("pagehide", () => {
  chrome.storage.local.remove("activeSession");
});
