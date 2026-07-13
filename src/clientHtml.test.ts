import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { renderClientHtml } from "./clientHtml.js";

interface FakeElement {
  children: FakeElement[];
  className: string;
  disabled: boolean;
  placeholder: string;
  scrollHeight: number;
  scrollTop: number;
  textContent: string;
  addEventListener: (_name: string, _handler: (...args: unknown[]) => void) => void;
  append: (...children: FakeElement[]) => void;
  replaceChildren: (...children: FakeElement[]) => void;
  setAttribute: (name: string, value: string) => void;
}

interface FakeEventSourceInstance {
  closed: boolean;
  onerror?: () => void;
  url: string;
  addEventListener: (name: string, handler: (event: { data: string }) => void) => void;
  close: () => void;
}

function extractClientScript() {
  const html = renderClientHtml();
  const match = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/);
  assert.ok(match);
  return match[1];
}

function createFakeElement(): FakeElement {
  return {
    children: [],
    className: "",
    disabled: false,
    placeholder: "",
    scrollHeight: 0,
    scrollTop: 0,
    textContent: "",
    addEventListener: () => {},
    append(...children) {
      this.children.push(...children);
    },
    replaceChildren(...children) {
      this.children = children;
    },
    setAttribute(name, value) {
      Object.assign(this, { [name]: value });
    },
  };
}

function runClientScript() {
  const elements = new Map<string, FakeElement>();
  const eventSourceInstances: FakeEventSourceInstance[] = [];

  function elementById(id: string) {
    const existing = elements.get(id);
    if (existing) return existing;
    const element = createFakeElement();
    elements.set(id, element);
    return element;
  }

  function jsonResponse(payload: unknown) {
    return {
      ok: true,
      statusText: "OK",
      text: async () => JSON.stringify(payload),
    };
  }

  class FakeEventSource implements FakeEventSourceInstance {
    closed = false;
    listeners = new Map<string, Array<(event: { data: string }) => void>>();
    onerror?: () => void;

    constructor(public url: string) {
      eventSourceInstances.push(this);
    }

    addEventListener(name: string, handler: (event: { data: string }) => void) {
      const handlers = this.listeners.get(name) || [];
      handlers.push(handler);
      this.listeners.set(name, handlers);
    }

    close() {
      this.closed = true;
    }
  }

  const context = {
    Boolean,
    Date,
    Error,
    EventSource: FakeEventSource,
    FormData: class {
      get() {
        return "query";
      }
    },
    JSON,
    String,
    document: {
      createElement: () => createFakeElement(),
      getElementById: elementById,
    },
    encodeURIComponent,
    fetch: async (url: string) => {
      if (url === "/metrics/jobs") {
        return jsonResponse({ averages: {}, counts: {}, current: { queued: [] } });
      }
      const jobMatch = url.match(/^\/jobs\/([^/]+)$/);
      if (jobMatch) {
        return jsonResponse({ id: decodeURIComponent(jobMatch[1]), status: "running" });
      }
      return jsonResponse({});
    },
    window: {
      EventSource: FakeEventSource,
      addEventListener: () => {},
      clearInterval: () => {},
      setInterval: () => 1,
    },
  };

  runInNewContext(extractClientScript(), context);

  return {
    context: context as typeof context & {
      appendEvent: (name: string, data: unknown) => void;
      clearJobOutputs: () => void;
      selectJob: (id: string, summary?: { id: string; status: string }) => void;
    },
    elements,
    eventSourceInstances,
  };
}

test("renders the local web client shell", () => {
  const html = renderClientHtml();

  assert.match(html, /<!doctype html>/i);
  assert.match(html, /<title>Wiki Server Client<\/title>/);
  assert.match(html, /<form id="commandForm">/);
  assert.match(html, /id="queueList" aria-label="Queued jobs"/);
  assert.match(html, /value="query"/);
  assert.match(html, /value="ingest"/);
  assert.match(html, /value="lint"/);
});

test("client can submit commands and observe job state without external assets", () => {
  const html = renderClientHtml();

  assert.match(html, /fetch\(endpoint/);
  assert.match(html, /"\/jobs\/" \+ encodeURIComponent\(id\)/);
  assert.match(html, /new EventSource\("\/jobs\/" \+ encodeURIComponent\(id\) \+ "\/events"\)/);
  assert.match(html, /fetch\("\/metrics\/jobs"\)/);
  assert.match(html, /result\?\.lastAgentMessage/);
  assert.doesNotMatch(html, /<script\s+src=/i);
  assert.doesNotMatch(html, /<link\s+[^>]*href=/i);
});

test("client chooses active job from server current metrics before submitted fallback", () => {
  const html = renderClientHtml();

  assert.match(html, /let selectedJobId = "";/);
  assert.match(html, /let lastSubmittedJobId = "";/);
  assert.match(html, /function selectServerCurrentJob\(running, queued\)/);
  assert.match(html, /if \(running\) \{\s*selectJob\(running\.id, \{ id: running\.id, status: "running" \}\);/);
  assert.match(html, /const job = selectedQueued \|\| queued\[0\];/);
  assert.match(html, /selectJob\(job\.id, \{ id: job\.id, status: "queued" \}\);/);
  assert.match(html, /if \(!selectedJobId && lastSubmittedJobId\) \{\s*selectJob\(lastSubmittedJobId\);/);
  assert.match(html, /lastSubmittedJobId = payload\.jobId;/);
  assert.match(html, /if \(selectedJobId === payload\.jobId\) \{\s*appendEvent\("submit", payload\);/);
});

test("client exposes queued selection and cancels the selected running or queued job", () => {
  const html = renderClientHtml();

  assert.match(html, /renderQueueList\(queued, Boolean\(running\)\)/);
  assert.match(html, /button\.setAttribute\("aria-pressed", job\.id === selectedJobId \? "true" : "false"\)/);
  assert.match(html, /cancelButton\.disabled = !job \|\| !\(job\.status === "queued" \|\| job\.status === "running"\);/);
  assert.match(html, /"\/jobs\/" \+ encodeURIComponent\(selectedJobId\) \+ "\/cancel"/);
  assert.match(html, /"running " \+ running\.command/);
  assert.match(html, /"queued " \+ queued\[0\]\.command/);
});

test("client disables queued selection while a running job owns active detail", () => {
  const html = renderClientHtml();

  assert.match(html, /function renderQueueList\(queued, queuedSelectionDisabled\)/);
  assert.match(html, /button\.disabled = queuedSelectionDisabled;/);
  assert.match(html, /if \(queuedSelectionDisabled\) return;\s*selectJob\(job\.id, \{ id: job\.id, status: "queued" \}\);/);
});

test("client clears job detail panes only when selected job changes", () => {
  const html = renderClientHtml();

  assert.match(html, /const changed = selectedJobId !== id;/);
  assert.match(html, /if \(changed\) clearJobOutputs\(\);/);
  assert.match(html, /if \(changed\) watchJob\(id\);/);
  assert.match(html, /function clearJobOutputs\(\) \{\s*eventEntries = \[\];\s*eventOutputChars = 0;\s*omittedEventEntries = 0;\s*eventOutput\.textContent = "";\s*resultOutput\.textContent = "";\s*jobOutput\.textContent = "";\s*\}/);
});

test("client submit path does not reset selection or directly clear detail panes", () => {
  const html = renderClientHtml();
  const submitBody = html.slice(
    html.indexOf("async function submitCommand"),
    html.indexOf("async function readJson"),
  );

  assert.match(submitBody, /lastSubmittedJobId = payload\.jobId;/);
  assert.match(submitBody, /const metrics = await refreshMetrics\(\);/);
  assert.match(submitBody, /const serverCurrentExists = Boolean\(metrics\?\.current\?\.running \|\| \(metrics\?\.current\?\.queued \|\| \[\]\)\.length > 0\);/);
  assert.match(submitBody, /if \(!serverCurrentExists\) \{\s*selectJob\(payload\.jobId, \{ id: payload\.jobId, status: payload\.status \}\);/);
  assert.doesNotMatch(submitBody, /selectedJobId = "";/);
  assert.doesNotMatch(submitBody, /eventOutput\.textContent = "";/);
  assert.doesNotMatch(submitBody, /resultOutput\.textContent = "";/);
  assert.doesNotMatch(submitBody, /jobOutput\.textContent = "";/);
});

test("client keeps the event pane as a bounded tail buffer", () => {
  const html = renderClientHtml();
  const appendBody = html.slice(
    html.indexOf("function appendEvent"),
    html.indexOf("async function refreshMetrics"),
  );

  assert.match(html, /const MAX_EVENT_ENTRIES = 200;/);
  assert.match(html, /const MAX_EVENT_OUTPUT_CHARS = 120000;/);
  assert.match(html, /const EVENT_TRUNCATION_NOTICE = "\[Older events omitted; showing the bounded tail view\.\]\\n\\n";/);
  assert.match(html, /let eventEntries = \[\];/);
  assert.match(html, /let eventOutputChars = 0;/);
  assert.match(html, /let omittedEventEntries = 0;/);
  assert.match(appendBody, /eventEntries\.push\(block\);/);
  assert.match(appendBody, /eventOutputChars \+= block\.length;/);
  assert.match(appendBody, /eventEntries\.length > MAX_EVENT_ENTRIES/);
  assert.match(appendBody, /eventOutputChars > MAX_EVENT_OUTPUT_CHARS/);
  assert.match(appendBody, /eventEntries\.shift\(\)/);
  assert.match(appendBody, /omittedEventEntries \+= 1;/);
  assert.match(appendBody, /eventOutput\.textContent = notice \+ eventEntries\.join\(""\);/);
  assert.doesNotMatch(appendBody, /eventOutput\.textContent \+=/);
});

test("client event buffer trims and resets rendered state", () => {
  const { context, elements } = runClientScript();
  const eventOutput = elements.get("eventOutput");
  assert.ok(eventOutput);

  for (let index = 0; index < 205; index += 1) {
    context.appendEvent("count", "entry-" + String(index).padStart(3, "0"));
  }

  assert.match(eventOutput.textContent, /^\[Older events omitted; showing the bounded tail view\.\]\n\n/);
  assert.doesNotMatch(eventOutput.textContent, /entry-000/);
  assert.match(eventOutput.textContent, /entry-204/);

  context.clearJobOutputs();
  assert.equal(eventOutput.textContent, "");
  context.appendEvent("after-clear", "fresh-entry");
  assert.doesNotMatch(eventOutput.textContent, /Older events omitted/);
  assert.match(eventOutput.textContent, /fresh-entry/);

  for (let index = 0; index < 60; index += 1) {
    context.appendEvent("chars", "large-" + String(index).padStart(3, "0") + "-" + "x".repeat(2600));
  }

  assert.match(eventOutput.textContent, /^\[Older events omitted; showing the bounded tail view\.\]\n\n/);
  assert.doesNotMatch(eventOutput.textContent, /large-000-/);
  assert.match(eventOutput.textContent, /large-059-/);
});

test("client ignores stale EventSource error events", () => {
  const { context, elements, eventSourceInstances } = runClientScript();
  const eventOutput = elements.get("eventOutput");
  assert.ok(eventOutput);

  context.selectJob("job-a", { id: "job-a", status: "running" });
  context.selectJob("job-b", { id: "job-b", status: "running" });
  assert.equal(eventSourceInstances.length, 2);

  eventSourceInstances[0].onerror?.();
  assert.doesNotMatch(eventOutput.textContent, /SSE disconnected; polling continues\./);

  eventSourceInstances[1].onerror?.();
  assert.match(eventOutput.textContent, /SSE disconnected; polling continues\./);
});
