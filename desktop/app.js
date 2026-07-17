const api = window.wikiDesktop;
const state = { command: "query", health: null, metrics: null, workspace: null, pullState: null, pullNotice: null, importPreview: null, selectedJobId: "", selectedJob: null };
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
document.getElementById("validateImportButton").addEventListener("click", validateGitImport);
document.getElementById("importConfirmation").addEventListener("change", renderImportPreview);
document.getElementById("applyImportButton").addEventListener("click", applyGitImport);
document.getElementById("checkPullButton").addEventListener("click", checkGitPull);
document.getElementById("pullButton").addEventListener("click", pullGitFastForward);
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
  const summary = [["queued", counts.queued || 0], ["running", counts.running || 0]];
  document.getElementById("miniMetrics").replaceChildren(...summary.map(([label, value]) => metricNode("mini-metric", label, value)));
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
  const sourceLabels = { environment: "WIKI_ROOT override", "legacy-sibling": "Development sibling" };
  document.getElementById("wikiSource").textContent = state.health.desktop?.wikiRootMode || sourceLabels[state.health.wikiRootSource] || state.health.wikiRootSource;
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
  const remote = state.workspace?.gitRemote || {};
  document.getElementById("gitOrigin").textContent = remote.origin || "Not configured";
  document.getElementById("gitBranch").textContent = git.available ? git.branch : "Unavailable";
  document.getElementById("gitHead").textContent = git.available ? git.head : "—";
  document.getElementById("gitCommits").textContent = git.available ? String(git.commitCount) : "—";
  document.getElementById("gitState").textContent = git.available ? (git.clean ? "Clean" : `${git.changeCount} changes`) : "Unavailable";
  const sync = state.pullState || remote;
  document.getElementById("gitSyncState").textContent = syncLabel(sync);
  const checkButton = document.getElementById("checkPullButton");
  checkButton.disabled = !remote.available || !remote.origin;
  checkButton.title = checkButton.disabled ? "Origin을 먼저 가져오거나 설정하세요." : "Origin을 fetch하여 fast-forward 가능 여부를 확인합니다.";
  const pullButton = document.getElementById("pullButton");
  const canPull = Boolean(state.pullState?.fetched && state.pullState?.clean && state.pullState?.canPull && state.pullState?.relation === "behind");
  pullButton.disabled = !canPull;
  pullButton.classList.toggle("ready", canPull);
  const derivedNotice = state.pullNotice || { text: pullMessage(sync), tone: sync.relation === "behind" ? "success" : "neutral" };
  setOperationMessage(document.getElementById("pullMessage"), derivedNotice.text, derivedNotice.tone);
  const obsidian = state.workspace?.obsidian || {};
  const button = document.getElementById("openObsidianButton");
  button.disabled = !obsidian.installed;
  button.textContent = obsidian.vaultRegistered ? "Obsidian에서 index 열기" : obsidian.installed ? "Obsidian Vault 설정" : "Obsidian 미설치";
  document.getElementById("obsidianStatus").textContent = obsidian.message || "";
}

async function validateGitImport() {
  const button = document.getElementById("validateImportButton");
  const message = document.getElementById("importMessage");
  const remoteUrl = document.getElementById("gitRemoteUrl").value;
  button.disabled = true;
  setOperationMessage(message, "격리된 staging 디렉터리에 clone하고 필수 구조를 검증하는 중입니다…");
  state.importPreview = null;
  document.getElementById("importConfirmation").checked = false;
  renderImportPreview();
  try {
    state.importPreview = await api.prepareGitImport(remoteUrl);
    setOperationMessage(message, "Clone과 필수 wiki 구조 검증을 완료했습니다. 아래 변경 내용과 backup 위치를 확인하세요.", "success");
  } catch (error) {
    setOperationMessage(message, userErrorMessage(error), "error");
  } finally {
    button.disabled = false;
    renderImportPreview();
  }
}

function renderImportPreview() {
  const preview = state.importPreview;
  const container = document.getElementById("importPreview");
  container.hidden = !preview;
  if (!preview) return;
  const changes = preview.changes || {};
  document.getElementById("importValidation").textContent = preview.valid ? "필수 구조 검증 완료" : "검증 실패";
  document.getElementById("importBranch").textContent = preview.branch || "—";
  document.getElementById("importHead").textContent = preview.head || "—";
  document.getElementById("importChangeSummary").textContent = `+${changes.addedCount || 0} ~${changes.modifiedCount || 0} −${changes.removedCount || 0}`;
  document.getElementById("importTrustWarning").textContent = preview.trustWarning || "";
  document.getElementById("importBackupPath").textContent = preview.backupPath || "—";
  const paths = changes.paths || [];
  document.getElementById("importChanges").textContent = paths.length ? `${paths.join("\n")}${changes.truncated ? "\n… 나머지 변경 경로는 생략됨" : ""}` : "콘텐츠 차이가 없습니다.";
  document.getElementById("applyImportButton").disabled = !document.getElementById("importConfirmation").checked;
}

async function applyGitImport() {
  if (!state.importPreview || !document.getElementById("importConfirmation").checked) return;
  const button = document.getElementById("applyImportButton");
  const message = document.getElementById("importMessage");
  button.disabled = true;
  setOperationMessage(message, "서버를 중지하고 현재 위키를 backup한 뒤 검증된 위키로 교체하는 중입니다…");
  try {
    const result = await api.applyGitImport(state.importPreview.id);
    state.importPreview = null;
    state.pullState = null;
    state.pullNotice = null;
    document.getElementById("importConfirmation").checked = false;
    document.getElementById("gitRemoteUrl").value = "";
    setOperationMessage(message, `가져오기를 완료했습니다. 기존 위키 backup: ${result.backupPath}`, "success");
    renderImportPreview();
    await refresh();
  } catch (error) {
    setOperationMessage(message, userErrorMessage(error), "error");
    renderImportPreview();
  }
}

async function checkGitPull() {
  const button = document.getElementById("checkPullButton");
  const message = document.getElementById("pullMessage");
  button.disabled = true;
  state.pullNotice = { text: "Worktree를 변경하지 않고 origin을 확인하는 중입니다…", tone: "neutral" };
  setOperationMessage(message, state.pullNotice.text);
  try {
    state.pullState = await api.checkGitPull();
    state.pullNotice = { text: pullMessage(state.pullState), tone: state.pullState.relation === "behind" ? "success" : "neutral" };
  } catch (error) {
    state.pullState = null;
    state.pullNotice = { text: userErrorMessage(error), tone: "error" };
  } finally {
    button.disabled = false;
    renderWorkspace();
  }
}

async function pullGitFastForward() {
  if (!state.pullState?.canPull) return;
  if (!window.confirm("Clean 상태의 운영 위키를 확인된 origin branch로 fast-forward할까요? Merge commit, reset, force checkout은 실행하지 않습니다.")) return;
  const button = document.getElementById("pullButton");
  const message = document.getElementById("pullMessage");
  button.disabled = true;
  state.pullNotice = { text: "서버를 중지하고 fast-forward-only pull을 적용하는 중입니다…", tone: "neutral" };
  setOperationMessage(message, state.pullNotice.text);
  try {
    state.pullState = await api.pullGitFastForward();
    state.pullNotice = { text: "Fast-forward pull을 완료하고 서버를 재시작했습니다.", tone: "success" };
    await refresh();
  } catch (error) {
    state.pullNotice = { text: userErrorMessage(error), tone: "error" };
  } finally {
    renderWorkspace();
  }
}

function syncLabel(sync) {
  const labels = {
    unchecked: "원격 확인 필요",
    "up-to-date": "최신 상태",
    behind: sync?.behind ? `원격보다 ${sync.behind}개 뒤처짐` : "Fast-forward 가능",
    ahead: sync?.ahead ? `로컬이 ${sync.ahead}개 앞섬` : "로컬이 앞섬",
    diverged: "분기됨 · pull 차단",
    "no-origin": "Origin 미설정",
    "missing-remote-branch": "원격 branch 없음",
    detached: "Detached HEAD",
    unavailable: "확인 불가",
  };
  return labels[sync?.relation] || "원격 확인 필요";
}

function pullMessage(sync) {
  if (sync?.relation === "no-origin") return "Origin이 없습니다. Git remote에서 가져오면 이후 안전한 pull을 사용할 수 있습니다.";
  if (sync?.relation === "unavailable") return "Git 상태를 확인할 수 없습니다.";
  if (sync?.relation === "detached") return "Detached HEAD에서는 pull할 수 없습니다.";
  if (!sync?.clean) return "로컬 worktree에 변경이 있어 pull할 수 없습니다.";
  if (sync.relation === "behind") return `Fast-forward 가능: 원격 commit ${sync.behind}개를 적용할 수 있습니다.`;
  if (sync.relation === "diverged") return "로컬과 원격 history가 분기되어 pull할 수 없습니다.";
  if (sync.relation === "ahead") return "로컬 branch가 origin보다 앞서 있어 pull하지 않습니다.";
  if (sync.relation === "up-to-date") return "운영 위키가 원격과 동일한 최신 상태입니다.";
  if (sync.relation === "missing-remote-branch") return "현재 branch와 같은 원격 branch를 찾을 수 없습니다.";
  return syncLabel(sync);
}

function setOperationMessage(element, text, tone = "neutral") {
  element.textContent = text || "";
  element.classList.toggle("error", tone === "error");
  element.classList.toggle("success", tone === "success");
}

function userErrorMessage(error) {
  const message = String(error?.message || error || "알 수 없는 오류가 발생했습니다.")
    .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, "")
    .replace(/^Error:\s*/i, "");
  const missing = message.match(/^Remote repository is not an operational wiki\. Missing or invalid: (.+)\.$/i);
  if (missing) return `운영 위키 필수 구조를 확인할 수 없습니다. 누락 또는 잘못된 항목: ${missing[1]}`;
  if (/^Git clone failed\./i.test(message)) return "Git clone에 실패했습니다. Remote 주소, 네트워크, 시스템 Git/SSH 인증을 확인하세요.";
  if (/^Git fetch failed\./i.test(message)) return "Origin fetch에 실패했습니다. 네트워크와 시스템 Git/SSH 인증을 확인하세요.";
  if (/^Remote cloned and validated, but the change preview/i.test(message)) return "Remote 검증은 완료했지만 변경 내용 preview를 만들 수 없습니다.";
  if (/^Do not embed credentials/i.test(message)) return "Remote URL에 인증정보를 넣지 마세요. Git Credential Manager 또는 SSH를 사용하세요.";
  if (/^Enter a valid Git remote URL/i.test(message)) return "올바른 Git remote URL을 입력하세요.";
  if (/^Pull refused: the operational wiki has local changes/i.test(message)) return "로컬 worktree에 변경이 있어 pull할 수 없습니다.";
  if (/^Pull refused: local and remote history have diverged/i.test(message)) return "로컬과 원격 history가 분기되어 pull할 수 없습니다.";
  return message;
}

async function openObsidian() {
  const message = document.getElementById("obsidianStatus");
  try {
    const result = await api.openObsidian();
    message.textContent = result.needsVaultRegistration
      ? "Obsidian에서 열린 운영 위키 폴더를 ‘Open folder as vault’로 등록하세요."
      : "Obsidian에서 index.md를 열었습니다.";
  } catch (error) {
    message.textContent = userErrorMessage(error);
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
      ? "다음 로그인부터 백그라운드에서 시작합니다."
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
