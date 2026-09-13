import { env, pipeline } from "./sentiment-runtime/transformers-browser.min.js";

const MODEL_ID = "Xenova/twitter-roberta-base-sentiment-latest";
const MODEL_METHOD = "cardiff-twitter-roberta-sentiment-latest";
const MODEL_REVISION = "f3ec4d0925f90c3ca7ee7814f52d6ee7cf180445";
const MODEL_VERSION = `${MODEL_REVISION}-q8`;

const INTENT_MODEL_ID = "Xenova/nli-deberta-v3-xsmall";
const INTENT_MODEL_METHOD = "deberta-v3-xsmall-zero-shot-intent";
const INTENT_MODEL_REVISION = "2a4f614a701367a02d51389039afc998faeda637";
const INTENT_MODEL_VERSION = `${INTENT_MODEL_REVISION}-q8-v1`;
const INTENT_THRESHOLD = 0.5;
const MODEL_MAX_TOKENS = 512;
const INTENT_LABELS = [
  {
    key: "learning",
    description: "to learn, understand, or receive an explanation"
  },
  {
    key: "delegation",
    description: "to delegate the production of a complete result to the AI"
  },
  {
    key: "reasoning",
    description: "to present their own reasoning, attempt, interpretation, or opinion"
  },
  {
    key: "criticalEngagement",
    description: "to critically question, verify, compare, or correct information"
  }
];

// The model is downloaded once and cached by the browser. Only model assets are
// fetched remotely; prompts are processed by the model locally on the device.
env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;
env.useWasmCache = false;
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.wasmPaths = {
  mjs: chrome.runtime.getURL("sentiment-runtime/onnx-runtime-loader.mjs"),
  wasm: chrome.runtime.getURL("sentiment-runtime/onnx-runtime.wasm")
};

let classifierPromise;
let lastProgressBucket = -1;
let intentClassifierPromise;
let lastIntentProgressBucket = -1;
const MAX_EXPLANATION_WORDS = 20;
const EXPLANATION_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from",
  "had", "has", "have", "he", "her", "his", "i", "in", "is", "it", "its",
  "me", "my", "of", "on", "or", "our", "she", "so", "that", "the", "their",
  "them", "they", "this", "to", "was", "we", "were", "with", "you", "your"
]);

function enforceTokenizerLimit(classifier) {
  const tokenizer = classifier?.tokenizer;
  if (!tokenizer) return classifier;

  // Some converted model revisions omit model_max_length from their tokenizer
  // metadata. In that case Transformers.js treats the limit as Infinity, even
  // though RoBERTa/DeBERTa ONNX graphs accept at most 512 tokens. Supplying the
  // real ceiling here makes the pipelines' existing `truncation: true` safe.
  if (tokenizer._tokenizerConfig) {
    tokenizer._tokenizerConfig.model_max_length = MODEL_MAX_TOKENS;
  }
  return classifier;
}

function reportModelProgress(event) {
  if (event?.status === "progress" && Number.isFinite(event.progress)) {
    const bucket = Math.floor(event.progress / 10) * 10;
    if (bucket !== lastProgressBucket) {
      lastProgressBucket = bucket;
      console.info(`Sentinel sentiment model download: ${bucket}%`);
    }
    return;
  }

  if (["initiate", "ready", "done"].includes(event?.status)) {
    console.info(`Sentinel sentiment model: ${event.status}`);
  }
}

function getClassifier() {
  if (!classifierPromise) {
    console.info("Sentinel sentiment model: loading");
    classifierPromise = pipeline("text-classification", MODEL_ID, {
      dtype: "q8",
      device: "wasm",
      session_options: { executionProviders: ["wasm"] },
      revision: MODEL_REVISION,
      progress_callback: reportModelProgress
    }).then(classifier => {
      enforceTokenizerLimit(classifier);
      console.info("Sentinel sentiment model: ready");
      return classifier;
    }).catch(error => {
      classifierPromise = undefined;
      throw error;
    });
  }
  return classifierPromise;
}

function reportIntentModelProgress(event) {
  if (event?.status === "progress" && Number.isFinite(event.progress)) {
    const bucket = Math.floor(event.progress / 10) * 10;
    if (bucket !== lastIntentProgressBucket) {
      lastIntentProgressBucket = bucket;
      console.info(`Sentinel intention model download: ${bucket}%`);
    }
    return;
  }

  if (["initiate", "ready", "done"].includes(event?.status)) {
    console.info(`Sentinel intention model: ${event.status}`);
  }
}

function getIntentClassifier() {
  if (!intentClassifierPromise) {
    console.info("Sentinel intention model: loading");
    intentClassifierPromise = pipeline(
      "zero-shot-classification",
      INTENT_MODEL_ID,
      {
        dtype: "q8",
        device: "wasm",
        session_options: { executionProviders: ["wasm"] },
        revision: INTENT_MODEL_REVISION,
        progress_callback: reportIntentModelProgress
      }
    ).then(classifier => {
      enforceTokenizerLimit(classifier);
      console.info("Sentinel intention model: ready");
      return classifier;
    }).catch(error => {
      intentClassifierPromise = undefined;
      throw error;
    });
  }
  return intentClassifierPromise;
}

function normalizeIntentResult(output) {
  const scoreByDescription = new Map(
    (output?.labels || []).map((label, index) => [
      String(label),
      Number(output?.scores?.[index] || 0)
    ])
  );
  const scores = Object.fromEntries(
    INTENT_LABELS.map(({ key, description }) => [
      key,
      Number((scoreByDescription.get(description) || 0).toFixed(3))
    ])
  );
  const labels = INTENT_LABELS
    .filter(({ key }) => scores[key] >= INTENT_THRESHOLD)
    .map(({ key }) => key);

  return {
    labels,
    summary: labels.length === 0
      ? "unclear"
      : labels.length > 1
        ? "mixed"
        : labels[0],
    scores,
    threshold: INTENT_THRESHOLD,
    method: INTENT_MODEL_METHOD,
    version: INTENT_MODEL_VERSION
  };
}

async function analyzeIntent(classifier, text) {
  const descriptions = INTENT_LABELS.map(label => label.description);
  const output = await classifier(text, descriptions, {
    hypothesis_template: "The user's intention is {}.",
    multi_label: true
  });
  return normalizeIntentResult(output);
}

function normalizePrediction(prediction) {
  const label = String(prediction.label || "").toLowerCase();
  if (!new Set(["positive", "neutral", "negative"]).has(label)) {
    throw new Error(`Unexpected sentiment label: ${prediction.label}`);
  }

  const probability = Number(prediction.score);

  return {
    label,
    score: Number(probability.toFixed(3)),
    method: MODEL_METHOD,
    version: MODEL_VERSION
  };
}

function predictionList(output) {
  if (!Array.isArray(output)) return output ? [output] : [];
  if (output.length === 1 && Array.isArray(output[0])) return output[0];
  return output;
}

function getLabelProbability(output, label) {
  const match = predictionList(output).find(
    prediction => String(prediction?.label || "").toLowerCase() === label
  );
  return Number(match?.score || 0);
}

function getWordCandidates(text) {
  const matches = Array.from(text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu))
    .map(match => ({
      word: match[0],
      start: match.index,
      end: match.index + match[0].length
    }))
    .filter(candidate =>
      candidate.word.length > 1 &&
      !EXPLANATION_STOP_WORDS.has(candidate.word.toLowerCase())
    );

  if (matches.length <= MAX_EXPLANATION_WORDS) return matches;
  return Array.from({ length: MAX_EXPLANATION_WORDS }, (_, index) => {
    const matchIndex = Math.round(index * (matches.length - 1) / (MAX_EXPLANATION_WORDS - 1));
    return matches[matchIndex];
  }).filter((candidate, index, candidates) =>
    index === 0 || candidate.start !== candidates[index - 1].start
  );
}

function removeCandidate(text, candidate) {
  return `${text.slice(0, candidate.start)} ${text.slice(candidate.end)}`
    .replace(/\s+/g, " ")
    .trim();
}

async function analyzeWithWordInfluence(classifier, text) {
  const baseOutput = await classifier(text, { top_k: null, truncation: true });
  const basePredictions = predictionList(baseOutput)
    .slice()
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
  const topPrediction = basePredictions[0];
  const sentiment = normalizePrediction(topPrediction);
  const candidates = getWordCandidates(text);

  if (!candidates.length) return { sentiment, influentialWord: null };

  const variants = candidates.map(candidate => removeCandidate(text, candidate));
  const variantOutputs = await classifier(variants, { top_k: null, truncation: true });
  const outputs = Array.isArray(variantOutputs) && Array.isArray(variantOutputs[0])
    ? variantOutputs
    : [variantOutputs];
  const baseProbability = getLabelProbability(basePredictions, sentiment.label);

  const ranked = candidates.map((candidate, index) => ({
    ...candidate,
    influence: baseProbability - getLabelProbability(outputs[index], sentiment.label)
  })).sort((a, b) => b.influence - a.influence);
  const strongest = ranked[0];

  if (!strongest || strongest.influence <= 0.005) {
    return { sentiment, influentialWord: null };
  }

  const previousText = text.slice(0, strongest.start).toLowerCase();
  const escapedWord = strongest.word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const previousMatches = previousText.match(new RegExp(escapedWord, "giu")) || [];

  return {
    sentiment,
    influentialWord: {
      word: strongest.word,
      occurrence: previousMatches.length,
      influence: Number(strongest.influence.toFixed(3))
    }
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "sentinel-offscreen") return false;

  if (message?.type === "sentinel:prewarm-models") {
    console.info("Sentinel sentiment model: preparing for live prompt tone");
    getClassifier()
      .then(() => {
        console.info("Sentinel sentiment model: ready for live prompt tone");
        sendResponse({ ok: true });
      })
      .catch(error => {
        console.warn("Sentinel sentiment model prewarming was interrupted:", error);
        sendResponse({ ok: false, error: "local-model-unavailable" });
      });
    return true;
  }

  const isSentimentRequest = message?.type === "sentinel:run-sentiment";
  const isIntentRequest = message?.type === "sentinel:run-intent";
  if (!isSentimentRequest && !isIntentRequest) return false;

  const text = typeof message.text === "string" ? message.text.trim() : "";
  if (!text) {
    sendResponse({ ok: false, error: "empty-text" });
    return false;
  }

  // The raw prompt is used only for this inference call and is never persisted.
  if (isIntentRequest) {
    console.info("Sentinel intention analysis: processing locally");
    getIntentClassifier()
      .then(classifier => analyzeIntent(classifier, text))
      .then(intent => {
        console.info("Sentinel intention result:", {
          summary: intent.summary,
          detectedCategories: intent.labels,
          scores: intent.scores
        });
        sendResponse({ ok: true, intent });
      })
      .catch(error => {
        console.error("Sentinel offscreen intention analysis failed:", error);
        sendResponse({ ok: false, error: "local-intention-model-unavailable" });
      });
    return true;
  }

  console.info("Sentinel sentiment analysis: processing locally");
  getClassifier()
    .then(async classifier => {
      if (message.explain === true) {
        return analyzeWithWordInfluence(classifier, text);
      }
      const output = await classifier(text, { top_k: 1, truncation: true });
      const prediction = Array.isArray(output) ? output[0] : output;
      return { sentiment: normalizePrediction(prediction), influentialWord: null };
    })
    .then(result => {
      const { sentiment, influentialWord } = result;
      console.info(
        `Sentinel sentiment result: ${sentiment.label} (${sentiment.score})`
      );
      sendResponse({ ok: true, sentiment, influentialWord });
    })
    .catch(error => {
      console.error("Sentinel offscreen sentiment analysis failed:", error);
      sendResponse({ ok: false, error: "local-model-unavailable" });
    });

  return true;
});
