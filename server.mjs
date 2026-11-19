import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { triage, isValidText } from "./triage.mjs";

// Transport limit, separate from the triage contract: about 32,000 Cyrillic
// characters, far more than an incoming request needs.
export const MAX_BODY_BYTES = 64 * 1024;

const html = await readFile(new URL("./index.html", import.meta.url));
const clientScript = await readFile(new URL("./app.mjs", import.meta.url));

const STATIC_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
};

function json(response, status, body, extraHeaders = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...STATIC_HEADERS,
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
}

function sendFile(response, contentType, body) {
  response.writeHead(200, { "Content-Type": contentType, ...STATIC_HEADERS });
  response.end(body);
}

class PayloadTooLarge extends Error {}

const utf8 = new TextDecoder("utf-8", { fatal: true });

// Past the limit the rest of the body is still read (and dropped): closing the
// socket mid-upload makes the client see a connection reset instead of the 413.
async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
  }
  if (size > MAX_BODY_BYTES) throw new PayloadTooLarge();
  return Buffer.concat(chunks);
}

// Invalid UTF-8 and broken JSON both throw here and count as invalid input.
function parseText(rawBody) {
  try {
    const body = JSON.parse(utf8.decode(rawBody));
    return isValidText(body?.text) ? body.text : null;
  } catch {
    return null;
  }
}

async function handleTriage(request, response, { classify, log }) {
  let rawBody;
  try {
    rawBody = await readBody(request);
  } catch (error) {
    if (!(error instanceof PayloadTooLarge)) throw error;
    return json(response, 413, { status: "payload_too_large" }, { Connection: "close" });
  }
  const text = parseText(rawBody);
  if (text === null) return json(response, 400, { status: "invalid_input" });

  const result = await triage(text, {
    classify,
    // The request text is customer data, so only the reason is logged.
    // The error class (not its message) still tells a timeout from a provider failure.
    onManualReview: (reason, error) =>
      log(JSON.stringify({ event: "triage_manual_review", reason, error: error?.name })),
  });
  return json(response, 200, result);
}

export function createTriageServer({ classify, log = console.warn } = {}) {
  const server = createServer(async (request, response) => {
    // Exact-match routing needs only the path; plain string ops cannot throw on a malformed target.
    const pathname = request.url.split("?", 1)[0];
    try {
      if (request.method === "GET" && pathname === "/") return sendFile(response, "text/html; charset=utf-8", html);
      if (request.method === "GET" && pathname === "/app.mjs") {
        return sendFile(response, "text/javascript; charset=utf-8", clientScript);
      }
      if (request.method === "POST" && pathname === "/api/triage") {
        return await handleTriage(request, response, { classify, log });
      }
      return json(response, 404, { status: "not_found" });
    } catch (error) {
      if (response.destroyed) return; // the client went away mid-request; nothing to answer
      if (!response.headersSent) json(response, 500, { status: "server_error" });
      else response.destroy();
      try {
        log(JSON.stringify({ event: "server_error", error: error?.name }));
      } catch {
        // The client already has its 500; a broken log sink must not crash the process.
      }
    }
  });

  // A client that asks before uploading (Expect: 100-continue) is refused early
  // when it already declares a body over the limit.
  server.on("checkContinue", (request, response) => {
    if (Number(request.headers["content-length"]) > MAX_BODY_BYTES) {
      return json(response, 413, { status: "payload_too_large" }, { Connection: "close" });
    }
    response.writeContinue();
    server.emit("request", request, response);
  });
  return server;
}

const isEntryPoint = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  const port = Number(process.env.PORT || 3000);
  createTriageServer().listen(port, "127.0.0.1", () => {
    console.log(`Listening on http://127.0.0.1:${port}`);
  });
}
