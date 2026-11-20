import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { createTriageServer, MAX_BODY_BYTES } from "../server.mjs";
import { MODEL_TIMEOUT_MS } from "../triage.mjs";

const MANUAL = { status: "manual_review", topic: null, draft: null };
const INVALID = { status: "invalid_input" };

let server;
let baseUrl;
let logs = [];

beforeEach(() => {
  logs = [];
});

before(async () => {
  server = createTriageServer({ log: (line) => logs.push(line) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

// Every request has a deadline, so a hanging handler fails the test instead of hanging the suite.
const deadline = () => AbortSignal.timeout(5000);

async function triage(rawBody) {
  const response = await fetch(`${baseUrl}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: rawBody,
    signal: deadline(),
  });
  return { status: response.status, type: response.headers.get("content-type"), body: await response.json() };
}

const triageText = (text) => triage(JSON.stringify({ text }));

const invalidBodies = {
  "empty body": "",
  "broken JSON": "{\"text\":",
  "JSON null": "null",
  "JSON array": "[\"Где заказ?\"]",
  "JSON string": "\"Где заказ?\"",
  "missing text": "{}",
  "empty text": "{\"text\":\"\"}",
  "whitespace-only text": "{\"text\":\" \\n\\t \"}",
  "numeric text": "{\"text\":42}",
  "null text": "{\"text\":null}",
  "array text": "{\"text\":[\"Где заказ?\"]}",
  "object text": "{\"text\":{\"value\":\"Где заказ?\"}}",
};

for (const [name, rawBody] of Object.entries(invalidBodies)) {
  test(`returns 400 invalid_input for ${name}`, async () => {
    const reply = await triage(rawBody);
    assert.equal(reply.status, 400);
    assert.deepEqual(reply.body, INVALID);
  });
}

// Sends raw bytes over TCP and returns the raw HTTP response text.
function rawRequest(bytes, { closeAfterWrite = false } = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect(server.address().port, "127.0.0.1");
    let received = "";
    socket.on("data", (chunk) => (received += chunk));
    socket.on("end", () => resolve(received));
    socket.on("close", () => resolve(received));
    socket.on("error", reject);
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error("no response within 5 s"));
    });
    socket.write(bytes, () => closeAfterWrite && socket.destroy());
  });
}

test("returns 400 invalid_input for a body that is not valid UTF-8", async () => {
  const reply = await triage(Buffer.from([0x7b, 0x22, 0x74, 0x65, 0x78, 0x74, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]));
  assert.equal(reply.status, 400);
  assert.deepEqual(reply.body, INVALID);
});

test("accepts a body of exactly the size limit and rejects one byte more with 413", async () => {
  const wrapper = JSON.stringify({ text: "" }).length;
  const exact = JSON.stringify({ text: "a".repeat(MAX_BODY_BYTES - wrapper) });
  assert.equal(Buffer.byteLength(exact), MAX_BODY_BYTES);
  assert.equal((await triage(exact)).status, 200);

  const tooLarge = JSON.stringify({ text: "a".repeat(MAX_BODY_BYTES - wrapper + 1) });
  const reply = await triage(tooLarge);
  assert.equal(reply.status, 413);
  assert.deepEqual(reply.body, { status: "payload_too_large" });
});

test("answers 413, not a connection reset, for multi-megabyte bodies", async () => {
  const body = JSON.stringify({ text: "a".repeat(2 * 1024 * 1024) });
  for (let attempt = 0; attempt < 10; attempt++) {
    const reply = await triage(body);
    assert.equal(reply.status, 413);
  }
});

test("answers 500 server_error when the request fails after the body was read", async () => {
  const failing = createTriageServer({
    log: () => {
      throw new Error("log sink down");
    },
  });
  await new Promise((resolve) => failing.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${failing.address().port}/api/triage`, {
      method: "POST",
      body: JSON.stringify({ text: "Где заказ? [error]" }),
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { status: "server_error" });
    const again = await fetch(`http://127.0.0.1:${failing.address().port}/`, { signal: AbortSignal.timeout(2000) });
    assert.equal(again.status, 200, "the server keeps running after a failing log sink");
  } finally {
    await new Promise((resolve) => failing.close(resolve));
  }
});

test("keeps serving after a malformed request target", async () => {
  for (const target of ["//[", "http://[", "//"]) {
    const raw = await rawRequest(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    assert.match(raw, /^HTTP\/1\.1 404 /, target);
  }
  assert.deepEqual(logs.filter((line) => line.includes("server_error")), []);
  assert.equal((await fetch(`${baseUrl}/`, { signal: deadline() })).status, 200);
  assert.equal((await triageText("Когда будет доставка?")).status, 200);
});

test("does not log a client that disconnects mid-body as a server error", async () => {
  // Wait for the server to finish with the aborted request instead of sleeping.
  const handled = new Promise((resolve) =>
    server.once("request", (request, response) => response.once("close", resolve)));
  await rawRequest(
    "POST /api/triage HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{\"text\":",
    { closeAfterWrite: true },
  );
  await handled;
  await new Promise(setImmediate);
  assert.deepEqual(logs.filter((line) => line.includes("server_error")), []);
});

test("logs the manual review reason without the request text", async () => {
  await triageText("Секретный адрес клиента [error]");
  assert.equal(logs.length, 1);
  assert.deepEqual(JSON.parse(logs[0]), { event: "triage_manual_review", reason: "model_error", error: "Error" });
  assert.ok(!logs[0].includes("Секретный"));
});

const readyCases = {
  delivery: "Когда будет доставка заказа?",
  pricing: "Какая стоимость подписки?",
  other: "Хочу поменять email в профиле",
};

for (const [topic, text] of Object.entries(readyCases)) {
  test(`returns 200 ready with topic ${topic} and a draft`, async () => {
    const reply = await triageText(text);
    assert.equal(reply.status, 200);
    assert.match(reply.type, /^application\/json/);
    assert.deepEqual(reply.body, {
      status: "ready",
      topic,
      draft: "Спасибо за обращение. Уточним детали заявки.",
    });
  });
}

for (const marker of ["[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
  test(`returns 200 manual_review when the model fails with ${marker}`, async () => {
    const reply = await triageText(`Где моя доставка? ${marker}`);
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body, MANUAL);
  });
}

test("returns manual_review within the 300 ms model budget on [timeout]", async () => {
  const started = performance.now();
  const reply = await triageText("Где моя доставка? [timeout]");
  const elapsed = performance.now() - started;
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body, MANUAL);
  // The mock delays 1200 ms; the precise 300 ms budget is pinned in triage.test.mjs.
  // A loose upper bound keeps this end-to-end check stable on a loaded machine.
  assert.ok(elapsed >= MODEL_TIMEOUT_MS - 50, `answered too early: ${elapsed} ms`);
  assert.ok(elapsed < 1000, `waited for the 1200 ms mock instead of the ${MODEL_TIMEOUT_MS} ms budget: ${elapsed} ms`);
  assert.deepEqual(JSON.parse(logs[0]), { event: "triage_manual_review", reason: "timeout", error: "ModelTimeout" });
});

test("serves the page and the client script", async () => {
  const page = await fetch(`${baseUrl}/`, { signal: deadline() });
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /^text\/html/);
  const html = await page.text();
  assert.match(html, /<script type="module" src="\/app\.mjs">/);
  for (const id of ["triage-form", "message", "status", "result", "topic", "draft"]) {
    assert.match(html, new RegExp(`id="${id}"`), `index.html must contain #${id} for app.mjs`);
  }
  assert.match(html, /id="result"[^>]*hidden/);

  assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");

  const script = await fetch(`${baseUrl}/app.mjs`, { signal: deadline() });
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type"), /^text\/javascript/);
  assert.match(await script.text(), /export function mount/);
});

test("refuses a declared oversized body before the client uploads it", async () => {
  const raw = await rawRequest(
    "POST /api/triage HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n"
      + `Content-Length: ${MAX_BODY_BYTES + 1}\r\nExpect: 100-continue\r\n\r\n`,
  );
  assert.match(raw, /^HTTP\/1\.1 413 /);
  assert.ok(!raw.includes("100 Continue"));
});

test("still accepts a small body sent with Expect: 100-continue", async () => {
  const body = JSON.stringify({ text: "Когда будет доставка?" });
  const raw = await rawRequest(
    "POST /api/triage HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nConnection: close\r\n"
      + `Content-Length: ${Buffer.byteLength(body)}\r\nExpect: 100-continue\r\n\r\n${body}`,
  );
  assert.match(raw, /HTTP\/1\.1 200 /);
  assert.match(raw, /"status":"ready"/);
});

test("returns 404 not_found for unknown routes and methods", async () => {
  for (const [method, path] of [["GET", "/api/triage"], ["POST", "/"], ["GET", "/server.mjs"]]) {
    const response = await fetch(`${baseUrl}${path}`, { method, signal: deadline() });
    assert.equal(response.status, 404, `${method} ${path}`);
    assert.deepEqual(await response.json(), { status: "not_found" });
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});
