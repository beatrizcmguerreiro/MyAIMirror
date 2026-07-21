import { env, pipeline } from "./sentiment-runtime/transformers-browser.min.js";

const MODEL_ID = "Xenova/twitter-roberta-base-sentiment-latest";
const MODEL_METHOD = "cardiff-twitter-roberta-sentiment-latest";
const MODEL_REVISION = "f3ec4d0925f90c3ca7ee7814f52d6ee7cf180445";
const MODEL_VERSION = `${MODEL_REVISION}-q8`;

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
const MAX_EXPLANATION_WORDS = 20;
const EXPLANATION_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from",
  "had", "has", "have", "he", "her", "his", "i", "in", "is", "it", "its",
  "me", "my", "of", "on", "or", "our", "she", "so", "that", "the", "their",
  "them", "they", "this", "to", "was", "we", "were", "with", "you", "your"
]);

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
      revision: MODEL_REVISION,
      progress_callback: reportModelProgress
    }).then(classifier => {
      console.info("Sentinel sentiment model: ready");
      return classifier;
    }).catch(error => {
      classifierPromise = undefined;
      throw error;
    });
  }
  return classifierPromise;
}

function normalizePrediction(prediction) {
  const label = String(prediction.label || "").toLowerCase();
  if (!new Set(["positive", "neutral", "negative"]).has(label)) {
    throw new Error(`Unexpected sentiment label: ${prediction.label}`);
  }

  const probability = Number(prediction.score);
  const signedScore = label === "positive"
    ? probability
    : label === "negative"
      ? -probability
      : 0;

  return {
    label,
    score: Number(signedScore.toFixed(3)),
    confidence: Number(probability.toFixed(3)),
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
  if (
    message?.target !== "sentinel-offscreen" ||
    message?.type !== "sentinel:run-sentiment"
  ) return false;

  const text = typeof message.text === "string" ? message.text.trim() : "";
  if (!text) {
    sendResponse({ ok: false, error: "empty-text" });
    return false;
  }

  // The raw prompt is used only for this inference call and is never persisted.
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
        `Sentinel sentiment result: ${sentiment.label} (${sentiment.confidence})`
      );
      sendResponse({ ok: true, sentiment, influentialWord });
    })
    .catch(error => {
      console.error("Sentinel offscreen sentiment analysis failed:", error);
      sendResponse({ ok: false, error: "local-model-unavailable" });
    });

  return true;
});
