// Client logic for the triage page. DOM wiring lives in mount(); everything
// else is plain functions so it can be tested in Node without a browser.

const TOPIC_LABELS = { delivery: "Доставка", pricing: "Цены", other: "Другое" };
const REQUEST_TIMEOUT_MS = 10_000;

const MESSAGES = {
  loading: "Разбираем заявку…",
  manual: "AI не смог надёжно разобрать эту заявку. Определите тему и подготовьте ответ вручную.",
  invalid: "Введите текст заявки.",
  tooLong: "Заявка слишком длинная для автоматического разбора. Разберите её вручную.",
  error: "Не удалось получить ответ сервера. Повторите попытку или разберите заявку вручную.",
};

const view = (state, { topic = "", draft = "", message = MESSAGES[state] ?? "" } = {}) => ({
  state,
  topic,
  draft,
  message,
});

export function describeResult(httpStatus, body) {
  const status = body?.status;
  if (httpStatus === 200 && status === "ready" && Object.hasOwn(TOPIC_LABELS, body.topic)
      && typeof body.draft === "string" && body.draft.trim() !== "") {
    const topic = TOPIC_LABELS[body.topic];
    return view("ready", {
      topic,
      draft: body.draft,
      message: `Готово: тема «${topic}». Проверьте черновик перед отправкой клиенту.`,
    });
  }
  if (httpStatus === 200 && status === "manual_review") return view("manual");
  if (httpStatus === 400 && status === "invalid_input") return view("invalid");
  if (httpStatus === 413) return view("tooLong");
  return view("error");
}

// Returns submit(text). Only the latest submission may update the screen:
// a newer submit aborts the older request and its late answer is ignored.
export function createTriageController({ fetchImpl = fetch, render, timeoutMs = REQUEST_TIMEOUT_MS }) {
  let latest = 0;
  let inFlight = null;

  return async function submit(text) {
    const id = ++latest;
    inFlight?.abort();
    inFlight = null;

    if (typeof text !== "string" || text.trim() === "") {
      render(view("invalid"));
      return;
    }

    render(view("loading"));
    const controller = new AbortController();
    inFlight = controller;
    const timer = setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), timeoutMs);

    let next;
    try {
      const response = await fetchImpl("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });
      let body = null;
      try {
        body = await response.json();
      } catch {
        // A non-JSON body (proxy error page, etc.) is described as an error below.
      }
      next = describeResult(response.status, body);
    } catch {
      next = view("error");
    } finally {
      clearTimeout(timer);
      if (inFlight === controller) inFlight = null;
    }
    if (id === latest) render(next);
  };
}

export function mount(doc = document, { fetchImpl } = {}) {
  const form = doc.querySelector("#triage-form");
  const input = doc.querySelector("#message");
  const button = form.querySelector("button");
  const status = doc.querySelector("#status");
  const result = doc.querySelector("#result");
  const topic = doc.querySelector("#topic");
  const draft = doc.querySelector("#draft");

  const render = (next) => {
    // textContent only: model output is never interpreted as HTML.
    status.textContent = next.message;
    status.dataset.state = next.state;
    topic.textContent = next.topic;
    draft.textContent = next.draft;
    result.hidden = next.state !== "ready";
    button.textContent = next.state === "loading" ? "Разбираем…" : "Разобрать заявку";
  };

  const submit = createTriageController({ fetchImpl, render });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit(input.value);
  });
}

if (typeof document !== "undefined") mount();
