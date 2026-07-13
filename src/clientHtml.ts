export function renderClientHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Wiki Server Client</title>
  <style>
    :root {
      color-scheme: light;
      font-family: "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      background: #f5f4ed;
      color: #242721;
      accent-color: #1b365d;
      --paper: #f5f4ed;
      --paper-deep: #ebe8dc;
      --ink: #242721;
      --ink-blue: #1b365d;
      --muted: #6d7068;
      --rule: #d3cfc0;
      --danger: #8e3434;
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: var(--paper); }
    header {
      border-bottom: 1px solid var(--rule);
      padding: 24px 30px 20px;
    }
    .kicker {
      margin: 0 0 4px;
      color: var(--ink-blue);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.18em;
      text-transform: uppercase;
    }
    h1, h2 { font-family: Georgia, "Times New Roman", serif; }
    h1 { color: var(--ink-blue); font-size: 27px; font-weight: 500; margin: 0; }
    main {
      display: grid;
      grid-template-columns: minmax(320px, 420px) minmax(0, 1fr);
      min-height: calc(100vh - 91px);
    }
    section {
      min-width: 0;
      padding: 28px 30px;
      border-right: 1px solid var(--rule);
    }
    section:last-child { border-right: 0; }
    h2 { color: var(--ink-blue); font-size: 15px; margin: 0 0 14px; font-weight: 600; }
    fieldset {
      border: 0;
      padding: 0;
      margin: 0 0 14px;
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    label.command {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid var(--rule);
      border-radius: 2px;
      padding: 8px 10px;
      cursor: pointer;
      user-select: none;
    }
    label.command:has(input:checked) {
      border-color: var(--ink-blue);
      background: var(--paper-deep);
      color: var(--ink-blue);
    }
    input[type="radio"] { margin: 0; }
    textarea {
      width: 100%;
      min-height: 260px;
      resize: vertical;
      border: 1px solid var(--rule);
      border-radius: 2px;
      padding: 13px;
      font: 13px/1.45 ui-monospace, "Cascadia Mono", Consolas, monospace;
      background: rgba(255, 255, 255, 0.24);
      color: var(--ink);
    }
    textarea:disabled { opacity: 0.55; }
    .actions, .toolbar {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
      margin-top: 12px;
    }
    button {
      border: 1px solid var(--rule);
      border-radius: 2px;
      background: transparent;
      color: var(--ink);
      padding: 8px 11px;
      font: inherit;
      cursor: pointer;
    }
    button.primary {
      background: var(--ink-blue);
      border-color: var(--ink-blue);
      color: var(--paper);
    }
    button.danger { border-color: var(--danger); color: var(--danger); }
    button:disabled { cursor: default; opacity: 0.5; }
    button:not(:disabled):hover {
      background: var(--paper-deep);
    }
    button.primary:not(:disabled):hover { background: #284b77; }
    .muted { color: var(--muted); }
    .status-line {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      margin-bottom: 12px;
      min-height: 30px;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 26px;
      max-width: 100%;
      border: 1px solid var(--rule);
      border-radius: 999px;
      padding: 4px 9px;
      background: transparent;
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .pill.running { border-color: #9d6c27; color: #74501d; }
    .pill.succeeded { border-color: var(--ink-blue); color: var(--ink-blue); }
    .pill.failed, .pill.cancelled, .pill.interrupted {
      border-color: var(--danger);
      color: var(--danger);
    }
    .split {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 14px;
    }
    .panel { min-width: 0; margin-bottom: 16px; }
    pre {
      margin: 0;
      min-height: 120px;
      max-height: 320px;
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      border: 1px solid var(--rule);
      border-radius: 2px;
      padding: 12px;
      background: rgba(255, 255, 255, 0.2);
      font: 12px/1.45 ui-monospace, "Cascadia Mono", Consolas, monospace;
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
      margin-bottom: 12px;
    }
    .metric {
      border-top: 1px solid var(--rule);
      padding: 10px 2px;
      min-width: 0;
    }
    .metric .value { color: var(--ink-blue); font: 500 20px/1.2 Georgia, "Times New Roman", serif; }
    .metric .label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; }
    .queue-list {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 12px;
    }
    .queue-list button {
      max-width: 100%;
      overflow-wrap: anywhere;
    }
    .queue-list button[aria-pressed="true"] {
      border-color: var(--ink-blue);
      background: var(--paper-deep);
    }
    .error { color: var(--danger); min-height: 20px; margin-top: 10px; overflow-wrap: anywhere; }
    @media (max-width: 840px) {
      main, .split { grid-template-columns: 1fr; }
      section { border-right: 0; border-bottom: 1px solid var(--rule); }
      .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
  </style>
</head>
<body>
  <header>
    <p class="kicker">Local knowledge system</p>
    <h1>Wiki Server</h1>
  </header>
  <main>
    <section aria-labelledby="submitTitle">
      <h2 id="submitTitle">Submit</h2>
      <form id="commandForm">
        <fieldset>
          <label class="command"><input type="radio" name="command" value="query" checked> Query</label>
          <label class="command"><input type="radio" name="command" value="ingest"> Ingest</label>
          <label class="command"><input type="radio" name="command" value="lint"> Lint</label>
        </fieldset>
        <textarea id="content" spellcheck="false" placeholder="/query question or /ingest source path/context"></textarea>
        <div class="actions">
          <button id="submitButton" class="primary" type="submit">Submit</button>
          <button id="refreshMetrics" type="button">Refresh metrics</button>
          <button id="cancelJob" class="danger" type="button" disabled>Cancel job</button>
        </div>
        <div id="formError" class="error" role="status"></div>
      </form>
    </section>
    <section aria-labelledby="stateTitle">
      <div class="toolbar">
        <h2 id="stateTitle" style="margin-right:auto">Current State</h2>
        <span id="pollState" class="muted"></span>
      </div>
      <div class="metrics" id="metrics"></div>
      <div class="queue-list" id="queueList" aria-label="Queued jobs"></div>
      <div class="status-line">
        <span id="jobStatus" class="pill">No active job</span>
        <span id="jobId" class="pill muted"></span>
      </div>
      <div class="split">
        <div class="panel">
          <h2>Result</h2>
          <pre id="resultOutput"></pre>
        </div>
        <div class="panel">
          <h2>Events</h2>
          <pre id="eventOutput"></pre>
        </div>
      </div>
      <div class="panel">
        <h2>Job JSON</h2>
        <pre id="jobOutput"></pre>
      </div>
    </section>
  </main>
  <script>
    const terminalStatuses = new Set(["succeeded", "failed", "cancelled", "interrupted"]);
    const MAX_EVENT_ENTRIES = 200;
    const MAX_EVENT_OUTPUT_CHARS = 120000;
    const EVENT_TRUNCATION_NOTICE = "[Older events omitted; showing the bounded tail view.]\\n\\n";
    const form = document.getElementById("commandForm");
    const content = document.getElementById("content");
    const formError = document.getElementById("formError");
    const submitButton = document.getElementById("submitButton");
    const cancelButton = document.getElementById("cancelJob");
    const jobStatus = document.getElementById("jobStatus");
    const jobId = document.getElementById("jobId");
    const jobOutput = document.getElementById("jobOutput");
    const eventOutput = document.getElementById("eventOutput");
    const resultOutput = document.getElementById("resultOutput");
    const pollState = document.getElementById("pollState");
    const metricsOutput = document.getElementById("metrics");
    const queueList = document.getElementById("queueList");
    let selectedJobId = "";
    let lastSubmittedJobId = "";
    let pollTimer = 0;
    let metricsTimer = 0;
    let eventSource = null;
    let eventEntries = [];
    let eventOutputChars = 0;
    let omittedEventEntries = 0;

    function selectedCommand() {
      return new FormData(form).get("command");
    }

    function setError(message) {
      formError.textContent = message || "";
    }

    function setContentState() {
      const lint = selectedCommand() === "lint";
      content.disabled = lint;
      content.placeholder = lint
        ? "Lint always runs the canonical full-wiki audit and sends an empty body."
        : selectedCommand() === "ingest"
          ? "Source path, pasted source, or structured Source / Ingest context block"
          : "Question for /query";
    }

    function setJobStatus(job) {
      jobStatus.className = "pill " + (job?.status || "");
      jobStatus.textContent = job ? job.status : "No active job";
      jobId.textContent = job ? job.id : "";
      cancelButton.disabled = !job || !(job.status === "queued" || job.status === "running");
    }

    async function submitCommand(event) {
      event.preventDefault();
      setError("");
      const command = selectedCommand();
      const rawContent = content.value;
      if (command !== "lint" && rawContent.trim().length === 0) {
        setError("Query and ingest require content.");
        return;
      }

      submitButton.disabled = true;
      try {
        const endpoint = "/" + command;
        const body = command === "lint" ? {} : { content: rawContent };
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const payload = await readJson(response);
        if (!response.ok) {
          throw new Error(payload.error || response.statusText);
        }
        lastSubmittedJobId = payload.jobId;
        const metrics = await refreshMetrics();
        const serverCurrentExists = Boolean(metrics?.current?.running || (metrics?.current?.queued || []).length > 0);
        if (!serverCurrentExists) {
          selectJob(payload.jobId, { id: payload.jobId, status: payload.status });
        }
        if (selectedJobId === payload.jobId) {
          appendEvent("submit", payload);
        }
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
      } finally {
        submitButton.disabled = false;
      }
    }

    async function readJson(response) {
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch {
        return { error: text };
      }
    }

    function selectJob(id, summary) {
      if (!id) return;
      const changed = selectedJobId !== id;
      selectedJobId = id;
      if (changed) clearJobOutputs();
      if (summary) setJobStatus(summary);
      if (changed) watchJob(id);
    }

    function clearJobOutputs() {
      eventEntries = [];
      eventOutputChars = 0;
      omittedEventEntries = 0;
      eventOutput.textContent = "";
      resultOutput.textContent = "";
      jobOutput.textContent = "";
    }

    function watchJob(id) {
      stopWatchers();
      pollJob(id);
      pollTimer = window.setInterval(() => pollJob(id), 3000);
      if ("EventSource" in window) {
        eventSource = new EventSource("/jobs/" + encodeURIComponent(id) + "/events");
        for (const name of ["status", "heartbeat", "agent_event", "done"]) {
          eventSource.addEventListener(name, (event) => {
            if (id !== selectedJobId) return;
            appendEvent(name, JSON.parse(event.data));
          });
        }
        eventSource.onerror = () => {
          if (id !== selectedJobId) return;
          appendEvent("events", "SSE disconnected; polling continues.");
          closeEventSource();
        };
      }
    }

    function stopWatchers() {
      if (pollTimer) window.clearInterval(pollTimer);
      pollTimer = 0;
      closeEventSource();
    }

    function closeEventSource() {
      if (eventSource) eventSource.close();
      eventSource = null;
    }

    async function pollJob(id) {
      try {
        pollState.textContent = "Polling " + new Date().toLocaleTimeString();
        const response = await fetch("/jobs/" + encodeURIComponent(id));
        const job = await readJson(response);
        if (!response.ok) throw new Error(job.error || response.statusText);
        if (id !== selectedJobId) return;
        renderJob(job);
        if (terminalStatuses.has(job.status)) {
          stopWatchers();
          pollState.textContent = "Terminal at " + new Date().toLocaleTimeString();
        }
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
      }
    }

    function renderJob(job) {
      setJobStatus(job);
      jobOutput.textContent = JSON.stringify(job, null, 2);
      if (job.status === "succeeded") {
        resultOutput.textContent = job.result?.lastAgentMessage || JSON.stringify(job.result || {}, null, 2);
      } else if (terminalStatuses.has(job.status)) {
        resultOutput.textContent = JSON.stringify(job.error || job.result || {}, null, 2);
      }
    }

    function appendEvent(name, data) {
      const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
      const compact = text.length > 2400 ? text.slice(0, 2400) + "\\n... truncated ..." : text;
      const block = "[" + new Date().toLocaleTimeString() + "] " + name + "\\n" + compact + "\\n\\n";
      eventEntries.push(block);
      eventOutputChars += block.length;
      trimEventEntries();
      renderEventEntries();
    }

    function trimEventEntries() {
      while (
        eventEntries.length > MAX_EVENT_ENTRIES ||
        eventOutputChars > MAX_EVENT_OUTPUT_CHARS
      ) {
        const removed = eventEntries.shift();
        if (!removed) break;
        eventOutputChars -= removed.length;
        omittedEventEntries += 1;
      }
    }

    function renderEventEntries() {
      const notice = omittedEventEntries > 0 ? EVENT_TRUNCATION_NOTICE : "";
      eventOutput.textContent = notice + eventEntries.join("");
      eventOutput.scrollTop = eventOutput.scrollHeight;
    }

    async function refreshMetrics() {
      try {
        const response = await fetch("/metrics/jobs");
        const metrics = await readJson(response);
        if (!response.ok) throw new Error(metrics.error || response.statusText);
        renderMetrics(metrics);
        return metrics;
      } catch (error) {
        metricsOutput.textContent = error instanceof Error ? error.message : String(error);
        return undefined;
      }
    }

    function renderMetrics(metrics) {
      const counts = metrics.counts || {};
      const running = metrics.current?.running;
      const queued = metrics.current?.queued || [];
      const currentLabel = running
        ? "running " + running.command
        : queued[0]
          ? "queued " + queued[0].command
          : "idle";
      selectServerCurrentJob(running, queued);
      const items = [
        ["queued", counts.queued || 0],
        ["running", counts.running || 0],
        ["succeeded", counts.succeeded || 0],
        ["failed", counts.failed || 0],
        ["avg queue", formatMs(metrics.averages?.queueWaitMs)],
        ["avg run", formatMs(metrics.averages?.runMs)],
        ["current", currentLabel],
        ["waiting", queued.length],
      ];
      metricsOutput.replaceChildren(...items.map(([label, value]) => {
        const node = document.createElement("div");
        node.className = "metric";
        const valueNode = document.createElement("div");
        valueNode.className = "value";
        valueNode.textContent = String(value);
        const labelNode = document.createElement("div");
        labelNode.className = "label";
        labelNode.textContent = String(label);
        node.append(valueNode, labelNode);
        return node;
      }));
      renderQueueList(queued, Boolean(running));
    }

    function selectServerCurrentJob(running, queued) {
      if (running) {
        selectJob(running.id, { id: running.id, status: "running" });
        return;
      }
      if (queued.length > 0) {
        const selectedQueued = queued.find((job) => job.id === selectedJobId);
        const job = selectedQueued || queued[0];
        selectJob(job.id, { id: job.id, status: "queued" });
        return;
      }
      if (!selectedJobId && lastSubmittedJobId) {
        selectJob(lastSubmittedJobId);
      }
    }

    function renderQueueList(queued, queuedSelectionDisabled) {
      queueList.replaceChildren(...queued.map((job, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.disabled = queuedSelectionDisabled;
        button.textContent = "#" + (index + 1) + " " + job.command + " " + job.id;
        button.setAttribute("aria-pressed", job.id === selectedJobId ? "true" : "false");
        button.addEventListener("click", () => {
          if (queuedSelectionDisabled) return;
          selectJob(job.id, { id: job.id, status: "queued" });
        });
        return button;
      }));
    }

    function formatMs(value) {
      if (value === null || value === undefined) return "-";
      if (value < 1000) return value + " ms";
      return Math.round(value / 1000) + " s";
    }

    async function cancelJob() {
      if (!selectedJobId) return;
      setError("");
      try {
        const response = await fetch("/jobs/" + encodeURIComponent(selectedJobId) + "/cancel", {
          method: "POST",
        });
        const job = await readJson(response);
        if (!response.ok) throw new Error(job.error || response.statusText);
        appendEvent("cancel", job);
        renderJob(job);
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
      }
    }

    form.addEventListener("submit", submitCommand);
    form.addEventListener("change", setContentState);
    document.getElementById("refreshMetrics").addEventListener("click", refreshMetrics);
    cancelButton.addEventListener("click", cancelJob);
    setContentState();
    refreshMetrics();
    metricsTimer = window.setInterval(refreshMetrics, 10000);
    window.addEventListener("beforeunload", () => {
      if (metricsTimer) window.clearInterval(metricsTimer);
      stopWatchers();
    });
  </script>
</body>
</html>`;
}
