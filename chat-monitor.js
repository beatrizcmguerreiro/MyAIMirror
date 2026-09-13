console.log("SENTINEL: running");

// triggers
// TODO: move to separate file 
// Kept for possible future use, but disabled while Sentinel focuses on
// reflective features rather than manual safety-keyword monitoring.
const MANUAL_TRIGGERS_ENABLED = false;
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

function isSentinelTemporarilyDisabled() {
  return document.documentElement.hasAttribute("data-sentinel-temporary-chat") ||
    isLoggedOutChatGpt();
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

function hasExtensionContext() {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

function isExtensionContextInvalidated(error) {
  return !hasExtensionContext() ||
    /extension context invalidated/i.test(String(error?.message || error || ""));
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
  if (!MANUAL_TRIGGERS_ENABLED) return [];

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

function removeManualTriggerUi() {
  document.querySelectorAll(".tms-highlighted-trigger").forEach(highlight => {
    const parent = highlight.parentNode;
    highlight.replaceWith(document.createTextNode(highlight.textContent || ""));
    parent?.normalize();
  });
  document
    .querySelectorAll('[data-message-author-role="user"][data-highlighted]')
    .forEach(message => message.removeAttribute("data-highlighted"));
  document.getElementById("tms-risk-bar")?.remove();
  document.getElementById("tms-trigger-popup")?.remove();
  document.getElementById("tms-risk-style")?.remove();
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

const ANALYSIS_CONVERSATIONS_KEY = "conversationAnalysesV1";
const SENTIMENT_METHOD = "cardiff-twitter-roberta-sentiment-latest";
const SENTIMENT_VERSION = "f3ec4d0925f90c3ca7ee7814f52d6ee7cf180445-q8";
const INTENT_LABEL_KEYS = [
  "learning",
  "delegation",
  "reasoning",
  "criticalEngagement"
];
let analysisPersistenceQueue = Promise.resolve();
const pendingAnalysisKeys = new Set();
let lastSuccessfulAnalysisSave = null;

function getLocalStorage(keys) {
  return new Promise(resolve => {
    try {
      if (!chrome.runtime?.id) return resolve({});
      chrome.storage.local.get(keys, result => {
        if (chrome.runtime.lastError) return resolve({});
        resolve(result || {});
      });
    } catch {
      resolve({});
    }
  });
}

function setLocalStorage(values) {
  return new Promise(resolve => {
    try {
      if (!chrome.runtime?.id) return resolve();
      chrome.storage.local.set(values, () => {
        if (chrome.runtime.lastError) return resolve(false);
        resolve(true);
      });
    } catch {
      resolve();
    }
  });
}

function removeLocalStorage(keys) {
  try {
    if (!chrome.runtime?.id) return;
    chrome.storage.local.remove(keys);
  } catch {
    // Reloading an unpacked extension invalidates scripts already in the page.
    // The refreshed content script will take over after the page is reloaded.
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

async function getConversationStorageId(conversationKey) {
  return sha256Fingerprint(`${location.hostname}|${conversationKey}`);
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
  const normalizedTextHash = tmsHash(normalizeMessageText(msg?.innerText));
  if (
    pendingNewChatPromptHash &&
    normalizedTextHash === pendingNewChatPromptHash
  ) return true;

  if (!isNearPageBottom()) return false;
  if (!initialScanComplete && !allowFirstVisibleUserCount) return false;

  const userMessages = Array.from(document.querySelectorAll('[data-message-author-role="user"]'));
  const lastUserMessage = userMessages[userMessages.length - 1];
  return lastUserMessage ? getMessageKey(lastUserMessage) === key : false;
}

function getConversationKey() {
  const normalizedPath = location.pathname.replace(/\/+$/, "") || "/";
  const chatGptConversation = normalizedPath.match(/^\/c\/([^/]+)/);
  if (chatGptConversation) return `/c/${chatGptConversation[1]}`;

  const firstMessage = document.querySelector('[data-message-author-role]');
  const firstHash = firstMessage ? tmsHash(normalizeMessageText(firstMessage.innerText)) : "empty";
  return `${normalizedPath}:${firstHash}`;
}

function isChatGptHost() {
  return location.hostname === "chatgpt.com" || location.hostname === "chat.openai.com";
}

function isCanonicalConversationRoute() {
  if (!isChatGptHost()) return true;
  return /^\/c\/[^/]+/.test(location.pathname);
}

function isEmptyChatGptNewChatRoute() {
  if (!isChatGptHost()) return false;
  const normalizedPath = location.pathname.replace(/\/+$/, "") || "/";
  return normalizedPath === "/" &&
    !document.querySelector('[data-message-author-role="user"]');
}

function createSentimentAggregate(method = SENTIMENT_METHOD, version = SENTIMENT_VERSION) {
  return {
    messages: 0,
    positive: 0,
    neutral: 0,
    negative: 0,
    scoreSum: 0,
    timeline: [],
    method,
    version
  };
}

function sessionSentimentFromRecord(record) {
  return {
    messages: Number(record.messages || 0),
    positive: Number(record.positive || 0),
    neutral: Number(record.neutral || 0),
    negative: Number(record.negative || 0),
    scoreSum: Number(record.scoreSum || 0),
    timeline: Array.isArray(record.timeline) ? record.timeline.slice(-100) : [],
    method: record.method,
    version: record.version
  };
}

function signedSentimentScore(sentiment) {
  const score = Number(sentiment?.score || 0);
  if (sentiment?.label === "positive") return score;
  if (sentiment?.label === "negative") return -score;
  return 0;
}

function sentimentAggregateFromAnalyses(analyses) {
  const aggregate = createSentimentAggregate();
  (Array.isArray(analyses) ? analyses : []).forEach(analysis => {
    const sentiment = analysis?.sentiment;
    if (!sentiment || !["positive", "neutral", "negative"].includes(sentiment.label)) {
      return;
    }
    const score = signedSentimentScore(sentiment);
    aggregate.messages += 1;
    aggregate[sentiment.label] += 1;
    aggregate.scoreSum = Number((aggregate.scoreSum + score).toFixed(3));
    aggregate.timeline.push({ label: sentiment.label, score });
  });
  return aggregate;
}

function sentimentRate(count, total) {
  return total ? Number(((count / total) * 100).toFixed(1)) : 0;
}

function getDominantSentiment(sentiment) {
  const counts = {
    positive: Number(sentiment?.positive || 0),
    neutral: Number(sentiment?.neutral || 0),
    negative: Number(sentiment?.negative || 0)
  };
  const highest = Math.max(...Object.values(counts));
  if (!highest) return "none";

  const leaders = Object.entries(counts)
    .filter(([, count]) => count === highest)
    .map(([label]) => label);
  return leaders.length === 1 ? leaders[0] : "mixed";
}

function averageTimelineScore(entries) {
  if (!entries.length) return 0;
  return entries.reduce((sum, entry) => sum + Number(entry.score || 0), 0) /
    entries.length;
}

function describeToneChange(timeline) {
  const entries = Array.isArray(timeline)
    ? timeline.filter(entry =>
        entry &&
        ["positive", "neutral", "negative"].includes(entry.label) &&
        Number.isFinite(Number(entry.score))
      )
    : [];

  if (!entries.length) {
    return { direction: "no_data", first: null, latest: null, labelChanges: 0 };
  }
  if (entries.length === 1) {
    return {
      direction: "not_enough_data",
      first: entries[0].label,
      latest: entries[0].label,
      labelChanges: 0
    };
  }

  const midpoint = Math.ceil(entries.length / 2);
  const earlierAverage = averageTimelineScore(entries.slice(0, midpoint));
  const laterAverage = averageTimelineScore(entries.slice(midpoint));
  const change = Number((laterAverage - earlierAverage).toFixed(3));
  const labelChanges = entries.slice(1).reduce(
    (count, entry, index) => count + Number(entry.label !== entries[index].label),
    0
  );

  let direction = "stable";
  if (change >= 0.15) direction = "more_positive";
  else if (change <= -0.15) direction = "more_negative";
  else if (labelChanges > 1) direction = "variable";

  return {
    direction,
    first: entries[0].label,
    latest: entries[entries.length - 1].label,
    labelChanges,
    scoreChange: change
  };
}

function compactSentimentSummary(sentiment) {
  if (!sentiment) {
    return {
      messages: 0,
      counts: { positive: 0, neutral: 0, negative: 0 },
      rates: { positive: 0, neutral: 0, negative: 0 },
      dominantSentiment: "none",
      averageScore: 0
    };
  }

  const messages = Number(sentiment.messages || 0);
  const counts = {
    positive: Number(sentiment.positive || 0),
    neutral: Number(sentiment.neutral || 0),
    negative: Number(sentiment.negative || 0)
  };
  const summary = {
    messages,
    counts,
    rates: {
      positive: sentimentRate(counts.positive, messages),
      neutral: sentimentRate(counts.neutral, messages),
      negative: sentimentRate(counts.negative, messages)
    },
    dominantSentiment: getDominantSentiment(sentiment),
    averageScore: messages
      ? Number((Number(sentiment.scoreSum || 0) / messages).toFixed(3))
      : 0
  };

  if (Array.isArray(sentiment.timeline)) {
    summary.toneChange = describeToneChange(sentiment.timeline);
  }
  return summary;
}

async function logSentimentTotals(currentConversation = null) {
  const stored = await getLocalStorage([ANALYSIS_CONVERSATIONS_KEY]);
  const conversations = stored[ANALYSIS_CONVERSATIONS_KEY] || {};
  const allChats = Object.values(conversations).reduce((total, analyses) => {
    const aggregate = sentimentAggregateFromAnalyses(analyses);
    total.messages += aggregate.messages;
    total.positive += aggregate.positive;
    total.neutral += aggregate.neutral;
    total.negative += aggregate.negative;
    total.scoreSum = Number((total.scoreSum + aggregate.scoreSum).toFixed(3));
    return total;
  }, createSentimentAggregate());

  console.info("Sentinel sentiment totals:", {
    currentChat: compactSentimentSummary(currentConversation),
    allChats: compactSentimentSummary(allChats)
  });
}

async function getConversationAnalysisRecords(conversationId) {
  const stored = await getLocalStorage([ANALYSIS_CONVERSATIONS_KEY]);
  const conversations = stored[ANALYSIS_CONVERSATIONS_KEY] || {};
  const analyses = conversations[conversationId];
  return Array.isArray(analyses) ? analyses : [];
}

function createIntentAggregate() {
  return {
    messages: 0,
    learning: 0,
    delegation: 0,
    reasoning: 0,
    criticalEngagement: 0,
    mixed: 0,
    unclear: 0,
    scoreSums: {
      learning: 0,
      delegation: 0,
      reasoning: 0,
      criticalEngagement: 0
    }
  };
}

function intentAggregateFromAnalyses(analyses) {
  const aggregate = createIntentAggregate();
  (Array.isArray(analyses) ? analyses : []).forEach(analysis => {
    const intention = analysis?.intention;
    if (!intention || !intention.scores) return;
    const labels = Array.isArray(intention.labels)
      ? intention.labels.filter(label => INTENT_LABEL_KEYS.includes(label))
      : [];
    aggregate.messages += 1;
    INTENT_LABEL_KEYS.forEach(key => {
      if (labels.includes(key)) aggregate[key] += 1;
      aggregate.scoreSums[key] = Number((
        aggregate.scoreSums[key] + Number(intention.scores[key] || 0)
      ).toFixed(3));
    });
    if (labels.length > 1) aggregate.mixed += 1;
    if (labels.length === 0) aggregate.unclear += 1;
  });
  return aggregate;
}

function compactIntentSummary(record) {
  const messages = Number(record?.messages || 0);
  const counts = Object.fromEntries(
    [...INTENT_LABEL_KEYS, "mixed", "unclear"].map(key => [
      key,
      Number(record?.[key] || 0)
    ])
  );
  const rates = Object.fromEntries(
    Object.entries(counts).map(([key, count]) => [
      key,
      sentimentRate(count, messages)
    ])
  );
  const averageScores = Object.fromEntries(
    INTENT_LABEL_KEYS.map(key => [
      key,
      messages
        ? Number((Number(record?.scoreSums?.[key] || 0) / messages).toFixed(3))
        : 0
    ])
  );

  return { messages, counts, rates, averageScores };
}

function logIntentTotals(analyses) {
  console.info(
    "Sentinel intention totals for current chat:",
    compactIntentSummary(intentAggregateFromAnalyses(analyses))
  );
}

function persistConversationAnalysis(
  conversationId,
  sentiment,
  intent,
  existingAnalysisIndex = null
) {
  const operation = analysisPersistenceQueue.then(async () => {
    const stored = await getLocalStorage([ANALYSIS_CONVERSATIONS_KEY]);
    const conversations = stored[ANALYSIS_CONVERSATIONS_KEY] || {};
    const analyses = Array.isArray(conversations[conversationId])
      ? conversations[conversationId]
      : [];
    const canUpdateExisting = Number.isInteger(existingAnalysisIndex) &&
      existingAnalysisIndex >= 0 &&
      existingAnalysisIndex < analyses.length;
    const analysis = canUpdateExisting
      ? { ...analyses[existingAnalysisIndex] }
      : {};

    // Keep the prompt's original capture time on the shared analysis record.
    // Intention inference updates this same record later and must not replace it.
    if (!canUpdateExisting) analysis.recordedAt = new Date().toISOString();

    if (sentiment) {
      analysis.sentiment = {
        label: sentiment.label,
        score: Number(Number(sentiment.score || 0).toFixed(3))
      };
    }
    if (intent) {
      analysis.intention = {
        labels: intent.labels.filter(label => INTENT_LABEL_KEYS.includes(label)),
        scores: Object.fromEntries(INTENT_LABEL_KEYS.map(key => [
          key,
          Number(Number(intent.scores?.[key] || 0).toFixed(3))
        ]))
      };
    }
    if (!analysis.sentiment && !analysis.intention) {
      return { saved: false, index: null };
    }

    const analysisIndex = canUpdateExisting
      ? existingAnalysisIndex
      : analyses.length;
    if (canUpdateExisting) analyses[analysisIndex] = analysis;
    else analyses.push(analysis);
    conversations[conversationId] = analyses;
    const storageSaved = await setLocalStorage({
      [ANALYSIS_CONVERSATIONS_KEY]: conversations
    });
    if (!storageSaved) {
      return { saved: false, index: null };
    }
    if (intent) logIntentTotals(analyses);
    return { saved: true, index: analysisIndex };
  });

  analysisPersistenceQueue = operation.catch(error => {
    console.error("Sentinel could not persist conversation analysis:", error);
  });
  return operation;
}

function migrateConversationAnalysisIdentity(fromConversationKey, toConversationKey) {
  const operation = analysisPersistenceQueue.then(async () => {
    const fromId = await getConversationStorageId(fromConversationKey);
    const toId = await getConversationStorageId(toConversationKey);
    if (fromId === toId) return false;

    const stored = await getLocalStorage([ANALYSIS_CONVERSATIONS_KEY]);
    const conversations = stored[ANALYSIS_CONVERSATIONS_KEY] || {};
    const source = conversations[fromId];
    if (!Array.isArray(source) || !source.length) return false;

    // A successful retry may already have populated the final identity. In
    // that case, preserve it and only remove the obsolete temporary record.
    if (!Array.isArray(conversations[toId]) || !conversations[toId].length) {
      conversations[toId] = source;
    }
    delete conversations[fromId];

    return Boolean(await setLocalStorage({
      [ANALYSIS_CONVERSATIONS_KEY]: conversations
    }));
  });

  analysisPersistenceQueue = operation.catch(error => {
    console.error("Sentinel could not migrate the conversation identity:", error);
  });
  return operation;
}

let lastRestoredConversationKey = null;

async function restoreConversationSentiment(conversationKey, force = false) {
  try {
    // ChatGPT briefly exposes non-conversation routes while navigating. Wait
    // for /c/<id> so temporary DOM states never become storage identities.
    if (!isCanonicalConversationRoute()) {
      if (isEmptyChatGptNewChatRoute()) {
        sessionStorage.removeItem("tms_sessionSentiment");
        removeLocalStorage("activeSession");
      }
      return;
    }

    if (!force && conversationKey === lastRestoredConversationKey) return;
    lastRestoredConversationKey = conversationKey;

    const conversationId = await getConversationStorageId(conversationKey);
    const analyses = await getConversationAnalysisRecords(conversationId);
    if (conversationKey !== currentConversationKey) return;

    const aggregate = sentimentAggregateFromAnalyses(analyses);
    const record = aggregate.messages ? aggregate : null;

    scheduleMiniMapRender(document.querySelectorAll('[data-message-author-role]'));

    // Replace the previous chat snapshot only after the new record is ready.
    // This avoids a temporary null value while navigating between saved chats.
    sessionStorage.removeItem("tms_sessionTriggers");
    sessionStorage.removeItem("tms_sessionTotalHits");
    sessionStorage.removeItem("tms_lastTriggerTime");
    sessionStorage.removeItem("tms_lastActivityTime");

    if (!record) {
      const visibleSignature = getVisibleConversationSignature();
      const preserveLiveTransition = Boolean(
        lastSuccessfulAnalysisSave?.visibleSignature &&
        Date.now() - lastSuccessfulAnalysisSave.savedAt < 30000 &&
        visibleSignature === lastSuccessfulAnalysisSave.visibleSignature
      );
      if (!preserveLiveTransition) {
        sessionStorage.removeItem("tms_sessionSentiment");
        removeLocalStorage("activeSession");
      }
      console.info("Sentinel sentiment: no saved history for this conversation");
      await logSentimentTotals();
      return;
    }

    const sessionSentiment = sessionSentimentFromRecord(record);
    sessionStorage.setItem("tms_sessionSentiment", JSON.stringify(sessionSentiment));
    console.info(
      `Sentinel sentiment restored: ${sessionSentiment.messages} message(s)`
    );
    await logSentimentTotals(sessionSentiment);
  } catch (error) {
    if (lastRestoredConversationKey === conversationKey) {
      lastRestoredConversationKey = null;
    }
    console.error("Sentinel could not restore conversation sentiment:", error);
  }
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
  return Array.from(messages).some(message =>
    miniMapEntries.has(getMessageKey(message)) || Boolean(findReusableMiniMapEntry(message))
  );
}

function clearConversationState(clearSessionStats = true) {
  riskMarkers.forEach(item => item.marker.remove());
  riskMarkers.clear();
  miniMapEntries.clear();
  miniMapLineRefs = [];
  miniMapOrder = [];
  miniMapIntentsByMessageKey.clear();
  miniMapIntentPendingKeys.clear();
  miniMapIntentAttemptedKeys.clear();
  clearTimeout(miniMapIntentBackfillTimer);
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
    sessionStorage.removeItem("tms_lastActivityTime");
    sessionStorage.removeItem("tms_sessionSentiment");
    removeLocalStorage("activeSession");
  }
}

function handleConversationChange() {
  const nextKey = getConversationKey();
  if (nextKey === currentConversationKey) return false;

  const previousKey = currentConversationKey;
  const currentMessages = document.querySelectorAll('[data-message-author-role]');
  const previousVisibleSignature = getVisibleConversationSignature(currentMessages);
  staleConversationSignature = visibleMessagesOverlapMiniMap(currentMessages)
    ? getVisibleConversationSignature(currentMessages)
    : null;
  currentConversationKey = nextKey;
  historyLoadInProgress = false;
  // Clear the old visual state immediately. The stored session snapshot is
  // swapped after the next conversation record has loaded.
  clearConversationState(false);
  conversationRestorePromise = restoreConversationSentiment(nextKey);

  const recentSave = lastSuccessfulAnalysisSave;
  if (
    recentSave?.conversationKey === previousKey &&
    Date.now() - recentSave.savedAt < 30000 &&
    previousKey.startsWith("/c/") &&
    nextKey.startsWith("/c/")
  ) {
    setTimeout(async () => {
      if (currentConversationKey !== nextKey || getConversationKey() !== nextKey) return;
      const currentSignature = getVisibleConversationSignature();
      if (!currentSignature || currentSignature !== previousVisibleSignature) return;

      const migrated = await migrateConversationAnalysisIdentity(previousKey, nextKey);
      if (!migrated) return;
      lastSuccessfulAnalysisSave = {
        conversationKey: nextKey,
        savedAt: Date.now(),
        visibleSignature: currentSignature
      };
      conversationRestorePromise = restoreConversationSentiment(nextKey, true);
    }, 1200);
  }
  return true;
}

const riskMarkers = new Map();
const miniMapEntries = new Map();
let miniMapLineRefs = [];
let miniMapOrder = [];
const miniMapIntentsByMessageKey = new Map();
const miniMapIntentPendingKeys = new Set();
const miniMapIntentAttemptedKeys = new Set();
let miniMapIntentBackfillTimer = null;
let miniMapIntentBackfillRunning = false;
let riskBarUpdateTimer = null;
let miniMapRenderTimer = null;
let initialScanComplete = false;
let currentConversationKey = getConversationKey();
let historyLoadInProgress = false;
const historyLoadedConversations = new Set();
let activeScrollContainer = null;
let miniMapBuildComplete = false;
let allowFirstVisibleUserCount = false;
let pendingNewChatPromptHash = null;
let staleConversationSignature = null;
let conversationRestorePromise = Promise.resolve();

const SUBMISSION_COMPOSER_SELECTORS = [
  "#prompt-textarea",
  '[data-testid="composer-text-input"]',
  'textarea[placeholder]',
  '[contenteditable="true"][role="textbox"]',
  'form [contenteditable="true"]',
  'div.ProseMirror[contenteditable="true"]'
];

function findSubmissionComposer(target) {
  if (target instanceof Element) {
    for (const selector of SUBMISSION_COMPOSER_SELECTORS) {
      if (target.matches(selector)) return target;
      const composer = target.closest(selector);
      if (composer) return composer;
    }
  }

  const active = document.activeElement;
  if (active instanceof Element) {
    for (const selector of SUBMISSION_COMPOSER_SELECTORS) {
      if (active.matches(selector)) return active;
      const composer = active.closest(selector);
      if (composer) return composer;
    }
  }
  return null;
}

function rememberSubmittedPrompt(composer) {
  if (!composer || isSentinelTemporarilyDisabled()) return;
  const text = composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement
    ? composer.value
    : composer.innerText || composer.textContent;
  const normalized = normalizeMessageText(text);
  if (normalized) pendingNewChatPromptHash = tmsHash(normalized);
}

function isSubmissionButton(target) {
  if (!(target instanceof Element)) return false;
  const button = target.closest('button, [role="button"]');
  if (!button) return false;
  const label = [
    button.getAttribute("aria-label"),
    button.getAttribute("data-testid"),
    button.getAttribute("title")
  ].filter(Boolean).join(" ");
  return /send|submit/i.test(label);
}
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
  const existingBar = document.getElementById("tms-risk-bar");
  if (existingBar) {
    existingBar.style.display = "";
    return;
  }

  if (!document.getElementById("tms-risk-style")) {
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
        rgba(248,248,248,0.94),
        rgba(235,235,235,0.90)
      );
      border-left: 1px solid rgba(0,0,0,0.08);
      border-top: 0;
      border-radius: 0;
      box-shadow: inset 1px 0 0 rgba(255,255,255,0.65);
      /* Keep the minimap above chat content, but below ChatGPT menus/dialogs. */
      z-index: 10;
      pointer-events: auto;
      overflow: hidden;
      backdrop-filter: blur(2px);
    }
    html[data-sentinel-hide-trigger-minimap] #tms-risk-bar {
      display: none !important;
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
          rgba(0,0,0,0.035) 10px
        );
      pointer-events: none;
    }
    #tms-risk-mini {
      position: absolute;
      inset: 8px 7px 76px 2px;
      pointer-events: none;
      z-index: 1;
    }
    #tms-intent-legend {
      position: absolute;
      left: 2px;
      right: 2px;
      bottom: 6px;
      min-height: 54px;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      align-content: center;
      column-gap: 5px;
      row-gap: 7px;
      padding: 8px 3px;
      box-sizing: border-box;
      border: 0;
      border-radius: 0;
      background: transparent;
      box-shadow: none;
      color: #505054;
      font: 600 10px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      pointer-events: none;
      z-index: 5;
    }
    .tms-intent-legend-item {
      display: flex;
      align-items: flex-start;
      gap: 5px;
      min-width: 0;
    }
    .tms-intent-legend-dot {
      width: 8px;
      height: 8px;
      margin-top: 2px;
      flex: 0 0 8px;
      border-radius: 50%;
      background: var(--tms-legend-color);
      box-shadow: 0 0 0 1px rgba(0, 0, 0, .08);
    }
    .tms-intent-legend-label {
      min-width: 0;
      overflow-wrap: normal;
      word-break: normal;
      hyphens: none;
    }
    .tms-intent-layer {
      position: absolute;
      left: 0;
      right: 0;
      min-height: 0;
      border-radius: 0;
      background: var(--tms-intent-overlay, transparent);
      opacity: 0.94;
      pointer-events: none;
      z-index: 0;
    }
    .tms-mini-line {
      position: absolute;
      left: 0;
      right: 0;
      height: 2px;
      margin-bottom: 0;
      overflow: hidden;
      color: #686868;
      font: 500 5.65px/5.25px Consolas, "SF Mono", Menlo, monospace;
      letter-spacing: 0;
      white-space: nowrap;
      text-rendering: geometricPrecision;
      pointer-events: none;
      opacity: 1;
      z-index: 1;
    }
    .tms-mini-line[data-role="user"] {
      color: #007f9f;
      font-weight: 700;
      text-shadow: none;
    }
    .tms-mini-line[data-role="assistant"] {
      color: #707070;
    }
    .tms-mini-line[data-role="unknown"] {
      color: #808080;
    }
    #tms-risk-viewport {
      position: absolute;
      left: 0;
      right: 0;
      min-height: 42px;
      background: rgba(0,0,0,0.025);
      border-top: 0;
      border-bottom: 0;
      pointer-events: none;
      z-index: 2;
      opacity: 0;
      box-shadow: inset 0 0 0 1px rgba(0,0,0,0.07);
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
    .tms-risk-focus {
      outline: 2px solid #ff3b30 !important;
      outline-offset: 4px !important;
      border-radius: 8px !important;
      transition: outline-color 0.25s ease;
    }
    html[data-sentinel-page-theme="dark"] #tms-risk-bar {
      background: linear-gradient(
        180deg,
        rgba(38,38,40,0.96),
        rgba(25,25,27,0.94)
      );
      border-left-color: rgba(255,255,255,0.12);
      box-shadow: inset 1px 0 0 rgba(255,255,255,0.04);
    }
    html[data-sentinel-page-theme="dark"] #tms-risk-bar::before {
      background: repeating-linear-gradient(
        to bottom,
        transparent 0,
        transparent 9px,
        rgba(255,255,255,0.035) 10px
      );
    }
    html[data-sentinel-page-theme="dark"] #tms-intent-legend {
      color: #c7c7cc;
    }
    html[data-sentinel-page-theme="dark"] .tms-intent-legend-dot {
      box-shadow: 0 0 0 1px rgba(255,255,255,.12);
    }
    html[data-sentinel-page-theme="dark"] .tms-intent-layer {
      opacity: 0.78;
      filter: saturate(1.18) brightness(1.08);
    }
    html[data-sentinel-page-theme="dark"] .tms-mini-line {
      color: #c7c7cc;
    }
    html[data-sentinel-page-theme="dark"] .tms-mini-line[data-role="user"] {
      color: #72d8f2;
    }
    html[data-sentinel-page-theme="dark"] .tms-mini-line[data-role="assistant"] {
      color: #d1d1d6;
    }
    html[data-sentinel-page-theme="dark"] .tms-mini-line[data-role="unknown"] {
      color: #aeaeb2;
    }
    html[data-sentinel-page-theme="dark"] .tms-mini-line[data-intent-background="true"] {
      color: #202124;
      text-shadow: 0 1px 0 rgba(255,255,255,.28);
    }
    html[data-sentinel-page-theme="dark"] .tms-mini-line[data-intent-background="true"][data-role="user"] {
      color: #12343b;
    }
    html[data-sentinel-page-theme="dark"] #tms-risk-viewport {
      background: rgba(255,255,255,0.035);
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.10);
    }
    `;
    document.head.appendChild(style);
  }

  const bar = document.createElement("div");
  bar.id = "tms-risk-bar";
  bar.title = "Sentinel conversation minimap";
  bar.innerHTML = `
    <div id="tms-risk-mini"></div>
    <div id="tms-risk-viewport"></div>
    <div id="tms-intent-legend" aria-label="Interaction intention colour legend">
      <span class="tms-intent-legend-item">
        <span class="tms-intent-legend-dot" style="--tms-legend-color:#c0e0c4"></span>
        <span class="tms-intent-legend-label">User Reasoning</span>
      </span>
      <span class="tms-intent-legend-item">
        <span class="tms-intent-legend-dot" style="--tms-legend-color:#f8cbae"></span>
        <span class="tms-intent-legend-label">Learning</span>
      </span>
      <span class="tms-intent-legend-item">
        <span class="tms-intent-legend-dot" style="--tms-legend-color:#aed3ee"></span>
        <span class="tms-intent-legend-label">Critical Engagement</span>
      </span>
      <span class="tms-intent-legend-item">
        <span class="tms-intent-legend-dot" style="--tms-legend-color:#ffe084"></span>
        <span class="tms-intent-legend-label">Delegation</span>
      </span>
    </div>
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

  top = Math.max(40, top - 52);

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
  const claimedKeys = new Set();

  Array.from(messages).forEach(message => {
    let key = getMessageKey(message);
    const text = getMiniMapText(message);
    let existing = miniMapEntries.get(key);

    // ChatGPT can replace a message's DOM node while generating a response or
    // updating the conversation title. When no stable data-message-id exists,
    // reconnect the replacement node to its previous minimap entry instead of
    // treating the same prompt as a second message at a different position.
    if (!existing) {
      const reusable = findReusableMiniMapEntry(message, claimedKeys);
      if (reusable) {
        key = reusable.key;
        existing = reusable;
        runtimeMessageKeys.set(message, {
          key,
          role: getMessageRole(message),
          textHash: tmsHash(normalizeMessageText(message.innerText))
        });
      }
    }

    currentKeys.push(key);
    claimedKeys.add(key);

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

function findReusableMiniMapEntry(message, claimedKeys = new Set()) {
  const role = getMessageRole(message);
  const text = normalizeMessageText(getMiniMapText(message));
  if (!text) return null;

  const orderedKeys = [
    ...miniMapOrder,
    ...Array.from(miniMapEntries.keys()).filter(key => !miniMapOrder.includes(key))
  ];

  for (const key of orderedKeys) {
    if (claimedKeys.has(key)) continue;
    const entry = miniMapEntries.get(key);
    if (!entry || entry.role !== role) continue;
    if (normalizeMessageText(entry.text) !== text) continue;

    // A connected node represents a real existing message. Reuse only entries
    // whose old node was replaced, which still allows repeated identical
    // prompts to remain separate chronological messages.
    if (entry.element && entry.element !== message && entry.element.isConnected) continue;
    return entry;
  }

  return null;
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

const MINIMAP_INTENT_PRESENTATION = {
  learning: { overlay: "rgba(248,203,173,0.94)" },
  delegation: { overlay: "rgba(255,224,132,0.94)" },
  reasoning: { overlay: "rgba(192,224,174,0.94)" },
  criticalEngagement: { overlay: "rgba(174,211,238,0.94)" },
  unclear: { overlay: "rgba(239,160,160,0.94)" }
};

function getMiniMapIntent(entry) {
  return miniMapIntentsByMessageKey.get(entry.key) || null;
}

function getMiniMapIntentLayer(intent) {
  if (!intent) return null;

  const labels = Array.isArray(intent?.labels)
    ? intent.labels.filter(label => MINIMAP_INTENT_PRESENTATION[label])
    : [];
  if (!labels.length) labels.push("unclear");

  // Keep every prompt as one solid block. For multi-label results, use the
  // detected label with the highest model score instead of a colour gradient.
  const primaryLabel = labels.reduce((best, label) => (
    Number(intent?.scores?.[label] || 0) > Number(intent?.scores?.[best] || 0)
      ? label
      : best
  ), labels[0]);
  return {
    labels: [primaryLabel],
    background: MINIMAP_INTENT_PRESENTATION[primaryLabel].overlay
  };
}

function scheduleMiniMapIntentBackfill(entries) {
  clearTimeout(miniMapIntentBackfillTimer);
  if (miniMapIntentBackfillRunning || isSentinelTemporarilyDisabled()) return;

  const conversationKey = currentConversationKey;
  const missingEntries = entries.filter(entry =>
    entry.role === "user" &&
    normalizeMessageText(entry.text) &&
    !miniMapIntentsByMessageKey.has(entry.key) &&
    !miniMapIntentPendingKeys.has(entry.key) &&
    !miniMapIntentAttemptedKeys.has(entry.key)
  );
  if (!missingEntries.length) return;

  miniMapIntentBackfillTimer = setTimeout(async () => {
    if (conversationKey !== currentConversationKey || miniMapIntentBackfillRunning) return;
    miniMapIntentBackfillRunning = true;
    try {
      for (const entry of missingEntries) {
        if (
          conversationKey !== currentConversationKey ||
          isSentinelTemporarilyDisabled()
        ) break;
        if (
          miniMapIntentsByMessageKey.has(entry.key) ||
          miniMapIntentPendingKeys.has(entry.key)
        ) continue;

        miniMapIntentAttemptedKeys.add(entry.key);
        const intent = await analyzeIntentLocally(entry.text);
        if (
          conversationKey !== currentConversationKey ||
          isSentinelTemporarilyDisabled()
        ) break;
        if (intent) {
          miniMapIntentsByMessageKey.set(entry.key, intent);
          scheduleMiniMapRender(document.querySelectorAll('[data-message-author-role]'));
        }
      }
    } finally {
      miniMapIntentBackfillRunning = false;
      if (conversationKey !== currentConversationKey) {
        scheduleMiniMapRender(document.querySelectorAll('[data-message-author-role]'));
      }
    }
  }, 900);
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

  const normalLineStep = 5.25;
  const minLineStep = 3.4;
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
  const lineHeight = Math.max(2.8, lineStep);
  const fontSize = Math.max(3.2, lineHeight * 1.08);

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
    if (entry.role === "user" && getMiniMapIntentLayer(getMiniMapIntent(entry))) {
      line.dataset.intentBackground = "true";
    }
    line.style.top = `${top}px`;
    line.style.height = `${lineHeight}px`;
    line.style.lineHeight = `${lineHeight}px`;
    line.style.fontSize = `${fontSize}px`;
    line.textContent = lineRef.text;

    miniMapLineRefs.push({ entry, top, height: lineHeight, lineIndex: lineRef.lineIndex, text: lineRef.text });
    mini.appendChild(line);
  });

  entries.forEach(entry => {
    if (entry.role !== "user") return;
    const intent = getMiniMapIntent(entry);
    const presentation = getMiniMapIntentLayer(intent);
    if (!presentation || entry.mapHeight <= 0) return;

    const layer = document.createElement("div");
    layer.className = "tms-intent-layer";
    layer.dataset.intentLabels = presentation.labels.join(",");
    // The miniature font is slightly larger than its line box, so its visible
    // glyphs sit above the mathematical line top. Lift the colour band by the
    // same optical offset to keep it centred around the prompt text.
    const opticalOffset = Math.max(0.75, lineHeight * 0.18);
    layer.style.top = `${entry.mapTop - opticalOffset}px`;
    layer.style.height = `${Math.max(1, entry.mapHeight)}px`;
    layer.style.setProperty("--tms-intent-overlay", presentation.background);
    mini.appendChild(layer);
  });

  scheduleMiniMapIntentBackfill(entries);

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
  const mapTop = mini?.offsetTop || 0;
  const mapHeight = mini?.clientHeight || barHeight;
  const visibleRatio = Math.min(metrics.clientHeight / scrollHeight, 1);
  const viewportHeight = Math.min(mapHeight, Math.max(42, mapHeight * visibleRatio));
  const maxScroll = Math.max(scrollHeight - metrics.clientHeight, 1);
  const viewportTop = mapTop + (metrics.scrollTop / maxScroll) * (mapHeight - viewportHeight);

  if (viewport) {
    viewport.style.top = `${Math.min(mapTop + mapHeight - viewportHeight, Math.max(mapTop, viewportTop))}px`;
    viewport.style.height = `${viewportHeight}px`;
  }

  riskMarkers.forEach(item => {
    const entry = miniMapEntries.get(item.key);
    const top = entry && mini
      ? mini.offsetTop + getRiskMarkerTop(entry, item.matchedWords)
      : mapTop;
    const markerHeight = 3;

    item.marker.style.top = `${Math.min(mapTop + mapHeight - markerHeight, Math.max(mapTop, top))}px`;
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
  - conversationAnalysesV1 -> chrome.storage.local (classifications and scores only)
  - sessionTriggers -> window.sessionStorage (resets when tab closes)
  - sessionSentiment -> window.sessionStorage (active conversation snapshot, no text)
*/
function updateStorage(hits, matchedTerms, termCounts, sentiment) {
  const now = Date.now();
  const SESSION_TIMEOUT = 30 * 60 * 1000;

  const last = Number(sessionStorage.getItem("tms_lastActivityTime") || "0");
  let sessionTriggers = safeJSONParse(sessionStorage.getItem("tms_sessionTriggers") || "{}", {});
  let sessionTotalHits = Number(sessionStorage.getItem("tms_sessionTotalHits") || "0");
  let sessionSentiment = safeJSONParse(
    sessionStorage.getItem("tms_sessionSentiment") || "null",
    null
  );

  if (sentiment && !sessionSentiment) {
    sessionSentiment = createSentimentAggregate(sentiment.method, sentiment.version);
  }

  // Do not mix scores produced by different analysis versions in one aggregate.
  if (
    sentiment && sessionSentiment && (
      sessionSentiment.method !== sentiment.method ||
      sessionSentiment.version !== sentiment.version
    )
  ) {
    sessionSentiment = sentiment
      ? createSentimentAggregate(sentiment.method, sentiment.version)
      : null;
  }

  if (now - last > SESSION_TIMEOUT) {
    sessionTriggers = {};
    sessionTotalHits = 0;

    // Trigger sessions expire after inactivity; conversation sentiment does not.
    sessionStorage.removeItem("tms_seenMessageKeys");
  }

  sessionTotalHits += hits;
  Object.entries(termCounts).forEach(([term, count]) => {
    sessionTriggers[term] = (sessionTriggers[term] || 0) + count;
  });

  if (sentiment && sessionSentiment) {
    const signedScore = signedSentimentScore(sentiment);
    sessionSentiment.messages += 1;
    sessionSentiment[sentiment.label] += 1;
    sessionSentiment.scoreSum = Number((sessionSentiment.scoreSum + signedScore).toFixed(3));
    sessionSentiment.timeline.push({
      score: signedScore,
      label: sentiment.label
    });
    // Keep a bounded aggregate history and never store the message text.
    sessionSentiment.timeline = sessionSentiment.timeline.slice(-100);
  }

  sessionStorage.setItem("tms_sessionTriggers", JSON.stringify(sessionTriggers));
  sessionStorage.setItem("tms_sessionTotalHits", String(sessionTotalHits));
  if (sessionSentiment) {
    sessionStorage.setItem("tms_sessionSentiment", JSON.stringify(sessionSentiment));
  } else {
    sessionStorage.removeItem("tms_sessionSentiment");
  }
  sessionStorage.setItem("tms_lastActivityTime", String(now));

  if (hits > 0) {
    sessionStorage.setItem("tms_lastTriggerTime", String(now));
    scheduleRiskBarUpdate();
    showPopup(sessionTotalHits, matchedTerms);
  }

  if (sentiment) {
    logSentimentTotals(sessionSentiment);
  }

  return sessionTotalHits;
}

async function analyzeSentimentLocally(text) {
  try {
    if (!hasExtensionContext() || isSentinelTemporarilyDisabled()) return null;
    const promptText = typeof text === "string" ? text.trim() : "";
    if (!promptText) return null;
    const response = await chrome.runtime.sendMessage({
      type: "sentinel:analyze-sentiment",
      text: promptText
    });
    if (!response?.ok) {
      console.error(
        "Sentinel local sentiment model returned no result:",
        response?.error || "unknown-error"
      );
      return null;
    }
    return response.sentiment;
  } catch (error) {
    // Reloading or updating an unpacked extension leaves its previous content
    // script in the tab until the page refreshes. Stop quietly in that state;
    // the newly injected script takes over after the refresh.
    if (isExtensionContextInvalidated(error)) return null;
    console.error("Sentinel could not reach the local sentiment model:", error);
    return null;
  }
}

async function analyzeIntentLocally(text) {
  try {
    if (!hasExtensionContext() || isSentinelTemporarilyDisabled()) return null;
    const promptText = typeof text === "string" ? text.trim() : "";
    if (!promptText) return null;
    const response = await chrome.runtime.sendMessage({
      type: "sentinel:analyze-intent",
      text: promptText
    });
    if (!response?.ok) {
      console.error(
        "Sentinel local intention model returned no result:",
        response?.error || "unknown-error"
      );
      return null;
    }
    return response.intent;
  } catch (error) {
    if (isExtensionContextInvalidated(error)) return null;
    console.error("Sentinel could not reach the local intention model:", error);
    return null;
  }
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
async function processMessage(msg) {
  if (isSentinelTemporarilyDisabled()) return;
  const key = getMessageKey(msg);
  const alreadyCounted = wasAlreadyCounted(key);
  const result = detectTriggers(msg.innerText);

  if (result.hits > 0) {
    highlight(msg);
    addRiskMarker(key, msg, result.hits, result.matchedWords);
  }

  // IMPORTANT: de-dup survives re-renders.
  if (alreadyCounted) return;

  if (shouldCountLiveMessage(msg, key)) {
    if (!isCanonicalConversationRoute()) {
      // A newly submitted ChatGPT prompt appears in the DOM before ChatGPT
      // assigns its permanent /c/<id> route. Keep it eligible for the next
      // scan instead of marking it as processed under the temporary route.
      pendingNewChatPromptHash = tmsHash(normalizeMessageText(msg.innerText));
      setTimeout(scan, 250);
      return;
    }

    // location.pathname can receive its permanent /c/<id> just before the
    // scan loop updates currentConversationKey. Never persist against that
    // stale New Chat identity; let the next scan synchronize the route first.
    const conversationKeyAtStart = getConversationKey();
    if (conversationKeyAtStart !== currentConversationKey) {
      setTimeout(scan, 0);
      return;
    }

    await conversationRestorePromise;
    if (
      conversationKeyAtStart !== currentConversationKey ||
      conversationKeyAtStart !== getConversationKey()
    ) return;

    const conversationId = await getConversationStorageId(conversationKeyAtStart);
    const pendingKey = `${conversationId}:${key}`;

    if (pendingAnalysisKeys.has(pendingKey)) {
      pendingNewChatPromptHash = null;
      allowFirstVisibleUserCount = false;
      return;
    }

    pendingAnalysisKeys.add(pendingKey);
    miniMapIntentPendingKeys.add(key);
    try {
      const promptText = normalizeMessageText(msg.innerText);
      if (!promptText) {
        // Image/file-only submissions are valid behavioural prompts, but
        // sentiment and intention models require text. Mark the DOM message as
        // handled without sending an empty request to either local model.
        markCounted(key);
        pendingNewChatPromptHash = null;
        allowFirstVisibleUserCount = false;
        return;
      }
      const sentiment = await analyzeSentimentLocally(promptText);
      // A first request can arrive while the local model is still starting.
      // Do not mark the prompt as processed until a classification has really
      // been saved; the next scan can then retry a transient startup failure.
      if (!sentiment) return;

      // Persist and expose sentiment immediately. Intention inference can be
      // slower, especially on the first prompt after startup, and must not
      // delay the conversation colour visualization.
      const persisted = await persistConversationAnalysis(
        conversationId,
        sentiment,
        null
      );
      if (!persisted?.saved) return;
      const analysisIndex = persisted.index;
      markCounted(key);
      const conversationIsStillActive = !isSentinelTemporarilyDisabled() &&
        conversationKeyAtStart === currentConversationKey &&
        conversationKeyAtStart === getConversationKey();
      let sessionTotalHits = 0;
      if (conversationIsStillActive) {
        lastSuccessfulAnalysisSave = {
          conversationKey: conversationKeyAtStart,
          savedAt: Date.now(),
          visibleSignature: getVisibleConversationSignature()
        };
        sessionTotalHits = updateStorage(
          result.hits,
          result.matchedWords,
          result.termCounts,
          sentiment
        );
      }
      window.dispatchEvent(new CustomEvent("sentinel:sentiment-updated"));
      if (conversationIsStillActive && result.hits > 0) {
        applyRiskMarkerVisualByKey(key, sessionTotalHits);
      }

      pendingNewChatPromptHash = null;
      allowFirstVisibleUserCount = false;

      const intent = await analyzeIntentLocally(promptText);
      if (intent) {
        await persistConversationAnalysis(
          conversationId,
          null,
          intent,
          analysisIndex
        );
        if (
          !isSentinelTemporarilyDisabled() &&
          conversationKeyAtStart === currentConversationKey &&
          conversationKeyAtStart === getConversationKey()
        ) {
          miniMapIntentsByMessageKey.set(key, intent);
          scheduleMiniMapRender(document.querySelectorAll('[data-message-author-role]'));
        }
      }
      pendingNewChatPromptHash = null;
      allowFirstVisibleUserCount = false;
    } catch (error) {
      console.error("Sentinel could not store conversation analysis:", error);
    } finally {
      pendingAnalysisKeys.delete(pendingKey);
      miniMapIntentPendingKeys.delete(key);
    }
  } else {
    // Existing/history messages are not live prompts, but should still be
    // remembered so later DOM re-renders do not treat them as new submissions.
    markCounted(key);
  }
}

function scan() {
  if (isSentinelTemporarilyDisabled()) {
    clearConversationState(false);
    removeManualTriggerUi();
    return;
  }
  if (handleConversationChange()) {
    setTimeout(scan, 120);
    return;
  }

  const allMessages = document.querySelectorAll('[data-message-author-role]');
  if (!allMessages.length) {
    // Only the empty New Chat screen may later reveal a genuinely new first
    // prompt. Empty DOM states on /c/<id> are ordinary navigation/loading.
    allowFirstVisibleUserCount = isEmptyChatGptNewChatRoute();
    if (allowFirstVisibleUserCount) pendingNewChatPromptHash = null;
    if (miniMapEntries.size || riskMarkers.size) clearConversationState(false);
    const riskBar = document.getElementById("tms-risk-bar");
    if (riskBar) riskBar.style.display = "none";
    return;
  }

  ensureRiskBar();
  updateRiskBarFrame();

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
    clearConversationState(false);
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

// Capture the outgoing prompt before ChatGPT clears the composer. On a new
// chat, the message node and permanent /c/<id> route are created in separate
// React commits; remembering this hash makes their order irrelevant.
document.addEventListener("keydown", event => {
  if (event.isComposing || event.key !== "Enter" || event.shiftKey) return;
  rememberSubmittedPrompt(findSubmissionComposer(event.target));
}, true);

document.addEventListener("click", event => {
  if (!isSubmissionButton(event.target)) return;
  const form = event.target.closest?.("form");
  const composer = form
    ? SUBMISSION_COMPOSER_SELECTORS
      .map(selector => form.querySelector(selector))
      .find(Boolean)
    : findSubmissionComposer(event.target);
  rememberSubmittedPrompt(composer);
}, true);

document.addEventListener("submit", event => {
  const form = event.target instanceof HTMLFormElement ? event.target : null;
  if (!form) return;
  const composer = SUBMISSION_COMPOSER_SELECTORS
    .map(selector => form.querySelector(selector))
    .find(Boolean);
  rememberSubmittedPrompt(composer);
}, true);

window.addEventListener("sentinel:temporary-chat-change", event => {
  if (event.detail?.active) {
    clearConversationState(false);
    removeManualTriggerUi();
    return;
  }

  // Anything left in the DOM from a temporary session must be treated as
  // history, not as a newly submitted prompt when normal mode resumes.
  initialScanComplete = false;
  allowFirstVisibleUserCount = false;
  pendingNewChatPromptHash = null;
  conversationRestorePromise = restoreConversationSentiment(currentConversationKey, true);
  setTimeout(scan, 180);
});
if (!MANUAL_TRIGGERS_ENABLED) removeManualTriggerUi();
if (isSentinelTemporarilyDisabled()) {
  conversationRestorePromise = Promise.resolve();
  removeManualTriggerUi();
} else {
  conversationRestorePromise = restoreConversationSentiment(currentConversationKey);
  scan();
  // ChatGPT can finish hydrating an existing conversation after the content
  // scripts have loaded. These retries make startup deterministic even when no
  // navigation or later DOM mutation occurs.
  setTimeout(scan, 500);
  setTimeout(scan, 1500);
}
const conversationMonitorInterval = setInterval(() => {
  if (!hasExtensionContext()) {
    clearInterval(conversationMonitorInterval);
    observer.disconnect();
    return;
  }
  if (isSentinelTemporarilyDisabled()) return;
  if (handleConversationChange()) setTimeout(scan, 120);
}, 1000);

// cleanup session snapshot on tab close
window.addEventListener("pagehide", () => {
  removeLocalStorage("activeSession");
});
