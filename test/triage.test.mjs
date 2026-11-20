import { test } from "node:test";
import assert from "node:assert/strict";
import { triage, MODEL_TIMEOUT_MS } from "../triage.mjs";

const MANUAL = { status: "manual_review", topic: null, draft: null };
const reply = (value) => async () => JSON.stringify(value);

test("aborts the model after the default 300 ms budget, not earlier or much later", async () => {
  assert.equal(MODEL_TIMEOUT_MS, 300);
  let signal;
  const classify = (text, options) => {
    signal = options.signal;
    return new Promise(() => {});
  };
  let abortedEarly;
  setTimeout(() => (abortedEarly = signal.aborted), MODEL_TIMEOUT_MS - 50);
  const started = performance.now();
  assert.deepEqual(await triage("Где заказ?", { classify }), MANUAL);
  const elapsed = performance.now() - started;
  assert.equal(abortedEarly, false, "aborted before the budget ran out");
  assert.equal(signal.aborted, true);
  assert.ok(elapsed >= MODEL_TIMEOUT_MS - 5 && elapsed < MODEL_TIMEOUT_MS + 300, `took ${elapsed} ms`);
});

test("does not abort a model call that already finished", async () => {
  let signal;
  const classify = async (text, options) => {
    signal = options.signal;
    return JSON.stringify({ topic: "other", draft: "Ответ" });
  };
  await triage("Где заказ?", { classify, timeoutMs: 20 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(signal.aborted, false);
});

test("passes the request text and an abort signal to the model", async () => {
  let seen;
  const classify = async (text, options) => {
    seen = { text, signal: options.signal };
    return JSON.stringify({ topic: "other", draft: "Ответ" });
  };
  await triage("Где заказ?", { classify });
  assert.equal(seen.text, "Где заказ?");
  assert.ok(seen.signal instanceof AbortSignal);
});

test("returns manual_review on timeout even if the model ignores the abort signal", async () => {
  const classify = () => new Promise(() => {});
  const started = performance.now();
  const result = await triage("Где заказ?", { classify, timeoutMs: 50 });
  assert.deepEqual(result, MANUAL);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1000, `took ${elapsed} ms`);
});

test("aborts the model call when the time budget runs out", async () => {
  let signal;
  const classify = (text, options) => {
    signal = options.signal;
    return new Promise(() => {});
  };
  await triage("Где заказ?", { classify, timeoutMs: 20 });
  assert.equal(signal.aborted, true);
});

test("returns manual_review when the model throws synchronously", async () => {
  const classify = () => {
    throw new Error("boom");
  };
  assert.deepEqual(await triage("Где заказ?", { classify }), MANUAL);
});

const badOutputs = {
  "a non-string value": async () => ({ topic: "other", draft: "Ответ" }),
  "JSON null": reply(null),
  "a JSON array": reply([{ topic: "other", draft: "Ответ" }]),
  "a missing topic": reply({ draft: "Ответ" }),
  "a topic with different case": reply({ topic: "Delivery", draft: "Ответ" }),
  "an inherited property name as topic": reply({ topic: "toString", draft: "Ответ" }),
  "a missing draft": reply({ topic: "other" }),
  "a non-string draft": reply({ topic: "other", draft: 42 }),
  "a whitespace-only draft": reply({ topic: "other", draft: " \n\t " }),
};

for (const [name, classify] of Object.entries(badOutputs)) {
  test(`returns manual_review for model output with ${name}`, async () => {
    assert.deepEqual(await triage("Где заказ?", { classify }), MANUAL);
  });
}

test("returns only status, topic and a trimmed draft", async () => {
  const classify = reply({ topic: "pricing", draft: "  Цена — 100 ₽.\n", confidence: 0.9 });
  assert.deepEqual(await triage("Сколько стоит?", { classify }), {
    status: "ready",
    topic: "pricing",
    draft: "Цена — 100 ₽.",
  });
});

test("reports why the model result was rejected", async () => {
  const reasons = [];
  const onManualReview = (reason) => reasons.push(reason);
  await triage("x", { classify: reply({ topic: "refund", draft: "Ответ" }), onManualReview });
  await triage("x", { classify: () => new Promise(() => {}), timeoutMs: 10, onManualReview });
  await triage("x", { classify: async () => { throw new Error("down"); }, onManualReview });
  await triage("x", { classify: async () => "not json", onManualReview });
  await triage("x", { classify: reply({ topic: "delivery", draft: "  " }), onManualReview });
  await triage("x", { classify: reply([]), onManualReview });
  assert.deepEqual(reasons, ["invalid_topic", "timeout", "model_error", "bad_json", "empty_draft", "not_an_object"]);
});

test("a model failure after the timeout does not cause an unhandled rejection", async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const classify = () => new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 30));
    assert.deepEqual(await triage("x", { classify, timeoutMs: 10 }), MANUAL);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
