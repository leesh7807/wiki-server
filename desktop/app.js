const api = window.wikiDesktop;
const state = { command: "query", health: null, metrics: null, workspace: null, selectedJobId: "", selectedJob: null };
const views = {
  work: ["Work", "Compose and run"],
  activity: ["Activity", "Queue and outcomes"],
  wiki: ["Wiki", "Storage and integration"],
  settings: ["Settings", "Profiles and diagnostics"],
};
const terminal = new Set(["succeeded", "failed", "cancelled", "interrupted"]);

document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => selectView(button.dataset.view)));
api.onNavigate((view) => {
  if (views[view]) selectView(view);
});
document.querySelectorAll(".command-tab").forEach((button) => button.addEventListener("click", () => selectCommand(button.dataset.command)));
document.getElementById("submitCommand").addEventListener("click", submit);
document.getElementById("refreshButton").addEventListener("click", refresh);
document.getElementById("cancelButton").addEventListener("click", cancelSelected);
document.getElementById("openDataButton").addEventListener("click", () => api.openData());
document.getElementById("openWikiButton").addEventListener("click", () => api.openWiki());
document.getElementById("openObsidianButton").addEventListener("click", openObsidian);
document.getElementById("openLogsButton").addEventListener("click", () => api.openLogs());
document.getElementById("openWebClientButton").addEventListener("click", () => api.openWebClient());
document.getElementById("autoLaunchToggle").addEventListener("change", updateAutoLaunch);
document.getElementById("copyGuideButton").addEventListener("click", async () => {
  await api.copyGuide();
  const status = document.getElementById("copyGuideStatus");
  status.textContent = "Copied";
  window.setTimeout(() => { status.textContent = ""; }, 1400);
});

function selectView(name) {
  document.querySelectorAll(".nav-item").forEach((node) => node.classList.toggle("active", node.dataset.view === name));
  document.querySelectorAll(".view").forEach((node) => node.classList.toggle("active", node.id === `${name}View`));
  document.getElementById("viewTitle").textContent = views[name][0];
  document.getElementById("viewKicker").textContent = views[name][1];
}

function selectCommand(command) {
  state.command = command;
  document.querySelectorAll(".command-tab").forEach((node) => {
    const active = node.dataset.command === command;
    node.classList.toggle("active", active);
    node.setAttribute("aria-checked", String(active));
  });
  const composer = document.getElementById("composer");
  const notice = document.getElementById("lintNotice");
  const labels = { query: "Question", ingest: "Source or ingest context", lint: "Full-wiki audit" };
  const placeholders = { query: "위키에서 확인할 질문을 입력하세요.", ingest: "파일 경로, 원문 또는 Source / Ingest context를 입력하세요.", lint: "" };
  document.getElementById("composerLabel").textContent = labels[command];
  composer.placeholder = placeholders[command];
  composer.hidden = command === "lint";
  composer.disabled = command === "lint";
  notice.hidden = command !== "lint";
  document.getElementById("submitCommand").firstChild.textContent = `Run ${command} `;
  renderCommandProfile();
}

async function submit() {
  const message = document.getElementById("composeMessage");
  const button = document.getElementById("submitCommand");
  message.textContent = "";
  button.disabled = true;
  try {
    const content = document.getElementById("composer").value;
    const accepted = await api.submit(state.command, content);
    state.selectedJobId = accepted.jobId;
    if (state.command !== "lint") document.getElementById("composer").value = "";
    message.textContent = `Accepted · ${accepted.jobId}`;
    await refresh();
  } catch (error) {
    message.textContent = error.message || String(error);
  } finally {
    button.disabled = false;
  }
}

async function cancelSelected() {
  if (!state.selectedJobId) return;
  try {
    await api.cancel(state.selectedJobId);
    await refresh();
  } catch (error) {
    document.getElementById("composeMessage").textContent = error.message || String(error);
  }
}

async function refresh() {
  try {
    const [health, metrics, workspace] = await Promise.all([api.health(), api.metrics(), api.workspace()]);
    state.health = health;
    state.metrics = metrics;
    state.workspace = workspace;
    setConnected(true);
    const current = metrics.current?.running || metrics.current?.queued?.[0];
    if (current) state.selectedJobId = current.id;
    if (state.selectedJobId) {
      try { state.selectedJob = await api.job(state.selectedJobId); } catch { state.selectedJob = null; }
    }
    render();
  } catch (error) {
    setConnected(false);
    document.getElementById("composeMessage").textContent = "서버를 시작하고 있습니다…";
  }
}

function setConnected(online) {
  document.getElementById("connectionDot").classList.toggle("online", online);
  document.getElementById("connectionLabel").textContent = online ? "Server online" : "Server offline";
}

function render() {
  renderCommandProfile();
  renderCurrentRun();
  renderMetrics();
  renderResult();
  renderWiki();
  renderWorkspace();
  renderProfiles();
}

function renderCommandProfile() {
  const runner = state.health?.agentRunner || {};
  const model = runner.appServerModels?.[state.command] || runner.appServerModel || "default";
  const effort = runner.appServerReasoningEfforts?.[state.command] || runner.appServerReasoningEffort || "default";
  document.getElementById("commandProfile").textContent = `${model} · ${effort}`;
}

function renderCurrentRun() {
  const job = state.selectedJob;
  const status = job?.status || "idle";
  const chip = document.getElementById("activeStatus");
  chip.className = `status-chip ${status}`;
  chip.textContent = status;
  document.getElementById("currentCommand").textContent = job ? job.command : "No active job";
  document.getElementById("currentRunStatus").textContent = status;
  document.getElementById("currentJobId").textContent = job?.id || "Waiting for work";
  document.getElementById("cancelButton").disabled = !job || !(status === "running" || status === "queued");
}

function renderMetrics() {
  const counts = state.metrics?.counts || {};
  const summary = [["queued", counts.queued || 0], ["running", counts.running || 0], ["succeeded", counts.succeeded || 0], ["failed", counts.failed || 0]];
  document.getElementById("miniMetrics").replaceChildren(...summary.slice(0, 4).map(([label, value]) => metricNode("mini-metric", label, value)));
  document.getElementById("metricCards").replaceChildren(...summary.map(([label, value]) => metricNode("metric-card", label, value)));
  const queued = state.metrics?.current?.queued || [];
  const list = document.getElementById("queueList");
  if (!queued.length) {
    const empty = document.createElement("p"); empty.className = "empty-state"; empty.textContent = "대기 중인 작업이 없습니다."; list.replaceChildren(empty);
  } else {
    list.replaceChildren(...queued.map((job, index) => {
      const button = document.createElement("button"); button.className = "queue-item";
      const order = document.createElement("span"); order.textContent = `#${index + 1}`;
      const command = document.createElement("strong"); command.textContent = job.command;
      const id = document.createElement("code"); id.textContent = job.id;
      button.append(order, command, id);
      button.addEventListener("click", async () => { state.selectedJobId = job.id; state.selectedJob = await api.job(job.id); renderCurrentRun(); renderResult(); });
      return button;
    }));
  }
  document.getElementById("jobDetail").textContent = state.selectedJob ? JSON.stringify(state.selectedJob, null, 2) : "선택된 작업이 없습니다.";
}

function metricNode(className, label, value) {
  const node = document.createElement("div"); node.className = className;
  const strong = document.createElement("strong"); strong.textContent = String(value);
  const span = document.createElement("span"); span.textContent = label;
  node.append(strong, span); return node;
}

function renderResult() {
  const job = state.selectedJob;
  const output = document.getElementById("resultOutput");
  document.getElementById("resultTitle").textContent = job ? `${job.command} · ${job.status}` : "결과가 여기에 표시됩니다";
  if (!job) output.textContent = "아직 실행된 작업이 없습니다.";
  else if (job.status === "succeeded") output.textContent = job.result?.lastAgentMessage || JSON.stringify(job.result || {}, null, 2);
  else if (terminal.has(job.status)) output.textContent = JSON.stringify(job.error || job.result || {}, null, 2);
  else output.textContent = "작업이 진행 중입니다…";
}

function renderWiki() {
  if (!state.health) return;
  document.getElementById("wikiRoot").textContent = state.health.wikiRoot;
  document.getElementById("wikiSource").textContent = state.health.wikiRootSource;
  document.getElementById("dataRoot").textContent = state.health.dataDir;
  const desktop = state.health.desktop || {};
  document.getElementById("connectionEndpoint").textContent = (desktop.baseUrl || "").replace("http://", "");
  document.getElementById("integrationGuide").textContent = desktop.integrationGuide || "Integration guide unavailable";
  const warning = document.getElementById("portWarning");
  warning.hidden = !desktop.portWarning;
  warning.textContent = desktop.portWarning || "";
}

function renderWorkspace() {
  const git = state.workspace?.git || {};
  document.getElementById("gitBranch").textContent = git.available ? git.branch : "Unavailable";
  document.getElementById("gitHead").textContent = git.available ? git.head : "—";
  document.getElementById("gitCommits").textContent = git.available ? String(git.commitCount) : "—";
  document.getElementById("gitState").textContent = git.available ? (git.clean ? "Clean" : `${git.changeCount} changes`) : "Unavailable";
  const obsidian = state.workspace?.obsidian || {};
  const button = document.getElementById("openObsidianButton");
  button.disabled = !obsidian.installed;
  button.textContent = obsidian.vaultRegistered ? "Open index in Obsidian" : obsidian.installed ? "Set up Obsidian vault" : "Obsidian not installed";
  document.getElementById("obsidianStatus").textContent = obsidian.message || "";
}

async function openObsidian() {
  const message = document.getElementById("obsidianStatus");
  try {
    const result = await api.openObsidian();
    message.textContent = result.needsVaultRegistration
      ? "Obsidian에서 열린 운영 위키 폴더를 ‘Open folder as vault’로 등록하세요."
      : "Obsidian에서 index.md를 열었습니다.";
  } catch (error) {
    message.textContent = error.message || String(error);
  }
}

function renderProfiles() {
  const runner = state.health?.agentRunner || {};
  document.getElementById("profileTable").replaceChildren(...["query", "ingest", "lint"].map((command) => {
    const row = document.createElement("div"); row.className = "profile-row";
    const name = document.createElement("strong"); name.textContent = command;
    const model = document.createElement("code"); model.textContent = runner.appServerModels?.[command] || runner.appServerModel || "default model";
    const effort = document.createElement("code"); effort.textContent = `${runner.appServerReasoningEfforts?.[command] || runner.appServerReasoningEffort || "default"} reasoning`;
    row.append(name, model, effort); return row;
  }));
}

async function refreshAutoLaunch() {
  const toggle = document.getElementById("autoLaunchToggle");
  const message = document.getElementById("autoLaunchMessage");
  try {
    const autoLaunch = await api.getAutoLaunch();
    toggle.checked = autoLaunch.enabled;
    toggle.disabled = !autoLaunch.supported;
    document.getElementById("autoLaunchLabel").textContent = autoLaunch.enabled ? "사용 중" : "사용 안 함";
    message.textContent = autoLaunch.message || "";
    message.classList.remove("error");
  } catch (error) {
    toggle.disabled = true;
    message.textContent = error.message || String(error);
    message.classList.add("error");
  }
}

async function updateAutoLaunch(event) {
  const toggle = event.currentTarget;
  const requested = toggle.checked;
  const message = document.getElementById("autoLaunchMessage");
  toggle.disabled = true;
  message.classList.remove("error");
  message.textContent = "저장 중…";
  try {
    const autoLaunch = await api.setAutoLaunch(requested);
    toggle.checked = autoLaunch.enabled;
    toggle.disabled = !autoLaunch.supported;
    document.getElementById("autoLaunchLabel").textContent = autoLaunch.enabled ? "사용 중" : "사용 안 함";
    message.textContent = autoLaunch.enabled
      ? "다음 Windows 로그인부터 백그라운드에서 시작합니다."
      : "자동 시작을 사용하지 않습니다.";
  } catch (error) {
    toggle.checked = !requested;
    toggle.disabled = false;
    document.getElementById("autoLaunchLabel").textContent = toggle.checked ? "사용 중" : "사용 안 함";
    message.textContent = error.message || String(error);
    message.classList.add("error");
  }
}

selectCommand("query");
refreshAutoLaunch();
refresh();
window.setInterval(refresh, 2500);
