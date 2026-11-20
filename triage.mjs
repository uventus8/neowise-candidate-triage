import { classify as mockClassify } from "./mock-ai.mjs";

export const TOPICS = new Set(["delivery", "pricing", "other"]);
export const MODEL_TIMEOUT_MS = 300;

const MANUAL_REVIEW = Object.freeze({ status: "manual_review", topic: null, draft: null });

class ModelTimeout extends Error {
  name = "ModelTimeout";
}

export function isValidText(value) {
  return typeof value === "string" && value.trim() !== "";
}

// Runs the model with a hard time budget. Promise.race keeps the budget even if
// a model client ignores the abort signal; the signal still lets a well-behaved
// client (like the mock) stop its work.
async function callModel(classify, text, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ModelTimeout());
    }, timeoutMs);
  });
  try {
    // Promise.race subscribes to both promises, so a model failure after the timeout is still handled.
    const call = Promise.resolve().then(() => classify(text, { signal: controller.signal }));
    return await Promise.race([call, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Returns a ready result, or the reason the model output can't be shown.
function parseModelOutput(raw) {
  if (typeof raw !== "string") return { reason: "not_a_string" };
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { reason: "bad_json" };
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return { reason: "not_an_object" };
  if (!TOPICS.has(data.topic)) return { reason: "invalid_topic" };
  if (!isValidText(data.draft)) return { reason: "empty_draft" };
  return { result: { status: "ready", topic: data.topic, draft: data.draft.trim() } };
}

export async function triage(
  text,
  { classify = mockClassify, timeoutMs = MODEL_TIMEOUT_MS, onManualReview = () => {} } = {},
) {
  let raw;
  try {
    raw = await callModel(classify, text, timeoutMs);
  } catch (error) {
    onManualReview(error instanceof ModelTimeout ? "timeout" : "model_error", error);
    return MANUAL_REVIEW;
  }
  const { result, reason } = parseModelOutput(raw);
  if (result) return result;
  onManualReview(reason);
  return MANUAL_REVIEW;
}
