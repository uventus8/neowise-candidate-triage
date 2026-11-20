import { test } from "node:test";
import assert from "node:assert/strict";
import { describeResult, createTriageController, mount } from "../app.mjs";

const READY = { status: "ready", topic: "delivery", draft: "Спасибо за обращение." };
const MANUAL = { status: "manual_review", topic: null, draft: null };

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// A fetch stub whose responses are released by the test, in any order.
// With honorAbort: false it behaves like a transport that delivers a response
// even after abort(), so only the controller's own stale check can drop it.
function controllableFetch({ honorAbort = true } = {}) {
  const calls = [];
  const fetchImpl = (url, init) =>
    new Promise((resolve, reject) => {
      calls.push({ url, init, resolve, reject });
      if (honorAbort) init.signal?.addEventListener("abort", () => reject(init.signal.reason));
    });
  return { calls, fetchImpl };
}

test("describes a ready result with a readable topic, the draft and an announcement", () => {
  assert.deepEqual(describeResult(200, READY), {
    state: "ready",
    topic: "Доставка",
    draft: "Спасибо за обращение.",
    message: "Готово: тема «Доставка». Проверьте черновик перед отправкой клиенту.",
  });
});

test("describes a too long request without suggesting a retry", () => {
  const view = describeResult(413, { status: "payload_too_large" });
  assert.equal(view.state, "tooLong");
  assert.equal(view.draft, "");
  assert.match(view.message, /слишком длинн/);
});

test("describes manual_review as a message without topic or draft", () => {
  const view = describeResult(200, MANUAL);
  assert.equal(view.state, "manual");
  assert.equal(view.topic, "");
  assert.equal(view.draft, "");
  assert.match(view.message, /вручную/);
});

test("describes invalid_input and unexpected answers without a draft", () => {
  assert.equal(describeResult(400, { status: "invalid_input" }).state, "invalid");
  const unexpected = [
    [500, { status: "server_error" }],
    [200, null],
    [200, { status: "ready", topic: "refund", draft: "x" }],
    [200, { status: "ready", topic: "toString", draft: "x" }],
    [200, { status: "ready", topic: "delivery", draft: "  " }],
    [200, { status: "ready", topic: "delivery" }],
    [500, { status: "ready", topic: "delivery", draft: "x" }],
    [500, { status: "manual_review", topic: null, draft: null }],
  ];
  for (const [status, body] of unexpected) {
    const view = describeResult(status, body);
    assert.equal(view.state, "error", JSON.stringify(body));
    assert.equal(view.draft, "");
  }
});

test("clears the previous draft as soon as a new request starts", async () => {
  const { calls, fetchImpl } = controllableFetch();
  const views = [];
  const submit = createTriageController({ fetchImpl, render: (view) => views.push(view) });

  const first = submit("Где заказ?");
  assert.equal(calls[0].url, "/api/triage");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { text: "Где заказ?" });
  calls[0].resolve(jsonResponse(READY));
  await first;
  const second = submit("Сколько стоит?");

  assert.equal(views.at(-1).state, "loading");
  assert.equal(views.at(-1).draft, "");
  calls[1].resolve(jsonResponse(MANUAL));
  await second;
});

test("shows the manual review message and no draft after a ready result", async () => {
  const { calls, fetchImpl } = controllableFetch();
  const views = [];
  const submit = createTriageController({ fetchImpl, render: (view) => views.push(view) });

  const first = submit("Где заказ?");
  calls[0].resolve(jsonResponse(READY));
  await first;
  const second = submit("Где заказ? [error]");
  calls[1].resolve(jsonResponse(MANUAL));
  await second;

  assert.equal(views.at(-1).state, "manual");
  assert.equal(views.at(-1).draft, "");
});

test("aborts the older request when a newer one is submitted", async () => {
  const { calls, fetchImpl } = controllableFetch();
  const submit = createTriageController({ fetchImpl, render: () => {} });
  const older = submit("Где заказ?");
  const newer = submit("Сколько стоит?");
  assert.equal(calls[0].init.signal.aborted, true);
  calls[1].resolve(jsonResponse(READY));
  await Promise.all([older, newer]);
});

test("keeps the newest result when responses arrive in reverse order", async () => {
  const { calls, fetchImpl } = controllableFetch({ honorAbort: false });
  const views = [];
  const submit = createTriageController({ fetchImpl, render: (view) => views.push(view) });

  const older = submit("Где заказ?");
  const newer = submit("Сколько стоит?");
  calls[1].resolve(jsonResponse({ status: "ready", topic: "pricing", draft: "Новый ответ" }));
  await newer;
  calls[0].resolve(jsonResponse(READY));
  await older;

  assert.deepEqual(views.map((view) => view.state), ["loading", "loading", "ready"]);
  assert.equal(views.at(-1).topic, "Цены");
  assert.equal(views.at(-1).draft, "Новый ответ");
});

test("does not send empty input and asks for text instead", async () => {
  const { calls, fetchImpl } = controllableFetch();
  const views = [];
  const submit = createTriageController({ fetchImpl, render: (view) => views.push(view) });

  await submit("   ");

  assert.equal(calls.length, 0);
  assert.equal(views.at(-1).state, "invalid");
});

test("shows an error without a draft when the request fails or hangs", async () => {
  const views = [];
  const failing = createTriageController({
    fetchImpl: () => Promise.reject(new TypeError("Failed to fetch")),
    render: (view) => views.push(view),
  });
  await failing("Где заказ?");
  assert.equal(views.at(-1).state, "error");

  const hanging = createTriageController({
    fetchImpl: controllableFetch().fetchImpl,
    render: (view) => views.push(view),
    timeoutMs: 20,
  });
  await hanging("Где заказ?");
  assert.equal(views.at(-1).state, "error");
  assert.equal(views.at(-1).draft, "");
});

test("shows an error when the response body is not JSON", async () => {
  const views = [];
  const submit = createTriageController({
    fetchImpl: async () => new Response("<html>Bad Gateway</html>", { status: 502 }),
    render: (view) => views.push(view),
  });
  await submit("Где заказ?");
  assert.equal(views.at(-1).state, "error");
});

// Minimal stand-in for the page elements mount() touches.
function fakeDocument() {
  const element = () => ({ textContent: "", hidden: false, dataset: {}, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } });
  const elements = {
    "#message": { value: "" },
    "#status": element(),
    "#result": element(),
    "#topic": element(),
    "#draft": element(),
  };
  const button = element();
  let onSubmit;
  elements["#triage-form"] = {
    ...element(),
    querySelector: () => button,
    addEventListener: (type, handler) => (onSubmit = handler),
  };
  return {
    elements,
    querySelector: (selector) => elements[selector],
    submit: (text) => {
      elements["#message"].value = text;
      onSubmit({ preventDefault() {} });
    },
  };
}

test("mount shows the draft, then hides and clears it on manual review", async () => {
  const doc = fakeDocument();
  const { calls, fetchImpl } = controllableFetch();
  mount(doc, { fetchImpl });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  doc.submit("Когда доставка?");
  calls[0].resolve(jsonResponse(READY));
  await settle();
  assert.equal(doc.elements["#draft"].textContent, "Спасибо за обращение.");
  assert.equal(doc.elements["#topic"].textContent, "Доставка");
  assert.equal(doc.elements["#result"].hidden, false);

  doc.submit("Когда доставка? [error]");
  assert.equal(doc.elements["#draft"].textContent, "", "the old draft is cleared while loading");
  assert.equal(doc.elements["#result"].hidden, true, "the result block is hidden while loading");
  calls[1].resolve(jsonResponse(MANUAL));
  await settle();
  assert.equal(doc.elements["#draft"].textContent, "");
  assert.equal(doc.elements["#result"].hidden, true);
  assert.match(doc.elements["#status"].textContent, /вручную/);

  doc.submit("Когда доставка?");
  calls[2].reject(new TypeError("Failed to fetch"));
  await settle();
  assert.equal(doc.elements["#result"].hidden, true, "no result block after a network error");
  assert.equal(doc.elements["#status"].dataset.state, "error");
});
