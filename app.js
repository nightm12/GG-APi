import { createIcons, Monitor, Moon, Sun, TriangleAlert, X } from "lucide";

const TOKEN_KEY = "gg_build_executor_dashboard_password";
const API_KEY_KEY = "gogcli_build_executor_api_key";
const REMEMBER_KEY = "gogcli_build_executor_remember_key";
const THEME_KEY = "gogcli_build_executor_theme";
const MAX_ACTIVITY_ROWS = 30;

const state = {
  token: "",
  status: "stopped",
  desired: "stopped",
  message: "",
  connectedAt: 0,
  successCount: 0,
  failureCount: 0,
  activeCount: 0,
  hasApiKey: false,
  activities: [],
  errorDialogTrigger: null,
  refreshTimer: null,
};

const elements = {
  form: document.querySelector("#connection-form"),
  apiKey: document.querySelector("#user-api-key"),
  rememberKey: document.querySelector("#remember-key"),
  toggleKey: document.querySelector("#toggle-key"),
  connect: document.querySelector("#connect-button"),
  disconnect: document.querySelector("#disconnect-button"),
  stop: document.querySelector("#stop-button"),
  status: document.querySelector("#connection-status"),
  statusText: document.querySelector("#connection-status-text"),
  message: document.querySelector("#connection-message"),
  activeCount: document.querySelector("#active-count"),
  successCount: document.querySelector("#success-count"),
  failureCount: document.querySelector("#failure-count"),
  connectionDuration: document.querySelector("#connection-duration"),
  activityBody: document.querySelector("#activity-body"),
  clearActivity: document.querySelector("#clear-activity"),
  errorDialog: document.querySelector("#activity-error-dialog"),
  errorMetadata: document.querySelector("#activity-error-metadata"),
  errorResponse: document.querySelector("#activity-error-response"),
  errorResponseBody: document.querySelector("#activity-error-body"),
  loginPanel: document.querySelector("#login-panel"),
  loginForm: document.querySelector("#login-form"),
  dashboardPassword: document.querySelector("#dashboard-password"),
  loginMessage: document.querySelector("#login-message"),
  dismissPrefillToast: document.querySelector("#dismiss-prefill-toast"),
  prefillToast: document.querySelector("#prefill-unsupported-toast"),
  themeOptions: document.querySelectorAll("[data-theme-option]"),
};

function setStatus(status, text) {
  elements.status.dataset.state = status;
  elements.status.title = text;
  elements.statusText.textContent = text;
}

function setMessage(text, stateName = "") {
  elements.message.textContent = text || "";
  if (stateName) elements.message.dataset.state = stateName;
  else delete elements.message.dataset.state;
}

function showLogin(message = "") {
  elements.loginPanel.hidden = false;
  elements.loginMessage.textContent = message;
  if (message) elements.loginMessage.dataset.state = "error";
  else delete elements.loginMessage.dataset.state;
  elements.dashboardPassword.focus();
}

function hideLogin() {
  elements.loginPanel.hidden = true;
  elements.dashboardPassword.value = "";
  elements.loginMessage.textContent = "";
  delete elements.loginMessage.dataset.state;
}

async function api(path, payload) {
  const response = await fetch(path, {
    method: payload === undefined ? "GET" : "POST",
    headers: {
      Authorization: "Bearer " + state.token,
      ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    cache: "no-store",
  });
  const result = await response.json().catch(() => ({}));
  if (response.status === 401) {
    state.token = "";
    try { sessionStorage.removeItem(TOKEN_KEY); } catch {}
    showLogin();
    throw new Error("请重新输入 Railway 管理密码");
  }
  if (!response.ok) throw new Error(result.message || result.error || "请求失败");
  return result;
}

function updateControls() {
  const busy = state.status === "connecting";
  const keyValue = elements.apiKey.value.trim();
  elements.connect.disabled = busy || (state.status === "online" && !keyValue) || (!keyValue && !state.hasApiKey);
  elements.disconnect.disabled = state.desired !== "running" || busy;
  elements.stop.disabled = !state.hasApiKey && state.desired === "stopped";
  elements.apiKey.disabled = busy;
  elements.rememberKey.disabled = busy;
  elements.activeCount.textContent = String(state.activeCount);
  elements.successCount.textContent = String(state.successCount);
  elements.failureCount.textContent = String(state.failureCount);
  elements.clearActivity.disabled = state.activities.length === 0;
  updateDuration();
}

function updateDuration() {
  if (state.status !== "online" || !state.connectedAt) {
    elements.connectionDuration.textContent = "00:00:00";
    return;
  }
  const seconds = Math.max(0, Math.floor((Date.now() - state.connectedAt) / 1000));
  const hours = String(Math.floor(seconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  const remainder = String(seconds % 60).padStart(2, "0");
  elements.connectionDuration.textContent = hours + ":" + minutes + ":" + remainder;
}

function applyThemeMode(requestedMode, persist = true) {
  const mode = requestedMode === "light" || requestedMode === "dark" ? requestedMode : "system";
  const dark = mode === "dark" || (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.themeMode = mode;
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.content = dark ? "#101012" : "#f7f7f8";
  for (const option of elements.themeOptions) {
    option.setAttribute("aria-pressed", String(option.dataset.themeOption === mode));
  }
  if (!persist) return;
  try {
    if (mode === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, mode);
  } catch {}
}

function restoreThemeMode() {
  let mode = document.documentElement.dataset.themeMode || "system";
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") mode = saved;
  } catch {}
  applyThemeMode(mode, false);
}

function restoreUserKey() {
  try {
    const remembered = localStorage.getItem(REMEMBER_KEY) === "true";
    elements.rememberKey.checked = remembered;
    elements.apiKey.value = remembered ? localStorage.getItem(API_KEY_KEY) || "" : "";
  } catch {}
}

function persistUserKey(apiKey) {
  try {
    if (elements.rememberKey.checked && apiKey) {
      localStorage.setItem(API_KEY_KEY, apiKey);
      localStorage.setItem(REMEMBER_KEY, "true");
    } else {
      localStorage.removeItem(API_KEY_KEY);
      localStorage.setItem(REMEMBER_KEY, String(elements.rememberKey.checked));
    }
  } catch {}
}

function formatErrorBody(body) {
  if (!body) return "";
  try { return JSON.stringify(JSON.parse(body), null, 2); } catch { return body; }
}

function tokenUsageElement(activity) {
  const group = document.createElement("span");
  group.className = "token-usage";
  const values = [["inputTokens", "输入", "↑"], ["outputTokens", "输出", "↓"]];
  const hasCount = values.some(([key]) => Number.isSafeInteger(activity[key]) && activity[key] >= 0);
  if (!hasCount) {
    group.textContent = "-";
    return group;
  }
  for (const [key, label, arrow] of values) {
    const value = Number.isSafeInteger(activity[key]) && activity[key] >= 0 ? activity[key].toLocaleString("en-US") : "-";
    const item = document.createElement("span");
    item.className = "token-value token-" + (key === "inputTokens" ? "input" : "output");
    item.title = label + " Token";
    item.setAttribute("aria-label", label + " Token " + value);
    const icon = document.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = arrow;
    item.append(icon, document.createTextNode(" " + value));
    group.appendChild(item);
  }
  return group;
}

function renderActivity() {
  elements.clearActivity.disabled = state.activities.length === 0;
  if (!state.activities.length) {
    elements.activityBody.innerHTML = '<tr class="empty-row"><td colspan="6">暂无请求</td></tr>';
    return;
  }
  const rows = state.activities.slice(0, MAX_ACTIVITY_ROWS).map((activity) => {
    const date = new Date(activity.at);
    const row = document.createElement("tr");
    row.className = activity.result === "error" ? "activity-row activity-row-error" : "activity-row";
    const values = [
      date.toLocaleTimeString("zh-CN", { hour12: false }),
      activity.model,
      activity.stream ? "流式" : "非流式",
      activity.result === "success" ? "成功" : activity.error?.status >= 200 && activity.error?.status < 300 ? "异常" : "失败",
      "",
      (Number(activity.durationMS) || 0) + " ms",
    ];
    values.forEach((value, index) => {
      const cell = document.createElement("td");
      cell.className = ["activity-time", "activity-model", "activity-mode", "activity-result-cell", "numeric activity-tokens", "numeric activity-duration"][index];
      if (index === 2) {
        const badge = document.createElement("span");
        badge.className = "mode-badge";
        badge.textContent = value;
        cell.appendChild(badge);
      } else if (index === 3) {
        const result = document.createElement("div");
        result.className = "activity-result";
        const badge = document.createElement("span");
        badge.className = "result-badge " + (activity.result === "success" ? "result-success" : "result-error");
        badge.textContent = value;
        result.appendChild(badge);
        if (activity.error) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "error-details-button";
          button.textContent = "查看错误";
          button.setAttribute("aria-haspopup", "dialog");
          button.setAttribute("aria-controls", "activity-error-dialog");
          button.addEventListener("click", () => showActivityError(activity));
          result.appendChild(button);
        }
        cell.appendChild(result);
      } else if (index === 4) cell.appendChild(tokenUsageElement(activity));
      else cell.textContent = value;
      if (index === 1) cell.title = activity.model;
      else if (activity.result === "error") cell.title = activity.message || "";
      row.appendChild(cell);
    });
    return row;
  });
  elements.activityBody.replaceChildren(...rows);
}

function showActivityError(activity) {
  if (!activity.error) return;
  const date = new Date(activity.at);
  const fields = [
    ["时间", date.toLocaleString("zh-CN", { hour12: false })],
    ["模型", activity.model],
    ["请求 ID", activity.requestID],
    ["状态码", String(activity.error.status)],
    ["错误码", activity.error.code],
    ["错误信息", activity.error.message],
  ];
  const metadata = [];
  for (const [label, value] of fields) {
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = value || "-";
    metadata.push(term, description);
  }
  elements.errorMetadata.replaceChildren(...metadata);
  elements.errorResponse.hidden = !activity.error.body;
  elements.errorResponseBody.textContent = formatErrorBody(activity.error.body);
  if (!elements.errorDialog.open) {
    state.errorDialogTrigger = document.activeElement;
    elements.errorDialog.showModal();
  }
}

function restoreActivityErrorFocus() {
  const trigger = state.errorDialogTrigger;
  state.errorDialogTrigger = null;
  if (trigger?.isConnected) trigger.focus();
  else elements.clearActivity.focus();
}

function applySnapshot(snapshot) {
  state.status = snapshot.status || "stopped";
  state.desired = snapshot.desired || "stopped";
  state.message = snapshot.message || "";
  state.connectedAt = Number(snapshot.connectedAt) || 0;
  state.successCount = Number(snapshot.successCount) || 0;
  state.failureCount = Number(snapshot.failureCount) || 0;
  state.activeCount = Number(snapshot.activeCount) || 0;
  state.hasApiKey = snapshot.hasApiKey === true;
  const activities = Array.isArray(snapshot.activities) ? snapshot.activities : [];
  const activitiesChanged = JSON.stringify(state.activities) !== JSON.stringify(activities);
  state.activities = activities;
  if (state.activities.some((activity) => activity.model === "gemini-3.7-flash" && (activity.message || "").includes("Requests ending with a model turn are not supported"))) {
    elements.prefillToast.hidden = false;
  }
  const labels = {
    online: "后台运行中",
    connecting: "正在连接",
    paused: "已暂停",
    stopped: "已停止",
    error: "连接错误",
  };
  setStatus(state.status === "stopped" || state.status === "paused" ? "offline" : state.status, labels[state.status] || "状态未知");
  setMessage(snapshot.message || "", state.status === "error" ? "error" : "");
  if (activitiesChanged) renderActivity();
  updateControls();
}

async function refreshStatus() {
  if (!state.token) {
    if (elements.loginPanel.hidden) showLogin();
    return;
  }
  try {
    applySnapshot(await api("/api/status"));
  } catch (error) {
    if (state.token) setMessage("控制面板暂时无法连接：" + error.message, "error");
  }
}

async function submitAction(path, payload) {
  try {
    applySnapshot(await api(path, payload));
    setMessage(state.status === "error" ? state.message : "操作已发送");
    return true;
  } catch (error) {
    if (state.token) setMessage(error.message, "error");
    return false;
  }
}

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const apiKey = elements.apiKey.value.trim();
  if (!apiKey && !state.hasApiKey) {
    setMessage("请输入公益站 API Key", "error");
    elements.apiKey.focus();
    return;
  }
  persistUserKey(apiKey);
  void submitAction("/api/start", { apiKey });
});
elements.apiKey.addEventListener("input", updateControls);

elements.disconnect.addEventListener("click", () => {
  if (state.activeCount && !window.confirm("暂停会取消当前活动请求。继续吗？")) return;
  void submitAction("/api/pause", {});
});

elements.stop.addEventListener("click", () => {
  if (!window.confirm("停止后台并从 Railway 清除已保存的公益站 API Key？")) return;
  void submitAction("/api/stop", {}).then((success) => {
    if (!success) return;
    elements.apiKey.value = "";
    persistUserKey("");
    updateControls();
  });
});

elements.toggleKey.addEventListener("click", () => {
  const show = elements.apiKey.type === "password";
  elements.apiKey.type = show ? "text" : "password";
  elements.toggleKey.textContent = show ? "隐藏" : "显示";
  elements.toggleKey.setAttribute("aria-label", show ? "隐藏 API Key" : "显示 API Key");
});

elements.clearActivity.addEventListener("click", () => void submitAction("/api/clear-activity", {}));
elements.errorDialog.addEventListener("close", restoreActivityErrorFocus);
elements.dismissPrefillToast.addEventListener("click", () => { elements.prefillToast.hidden = true; });

elements.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = elements.dashboardPassword.value;
  elements.loginMessage.textContent = "正在登录";
  delete elements.loginMessage.dataset.state;
  try {
    const response = await fetch("/api/status", { headers: { Authorization: "Bearer " + password }, cache: "no-store" });
    if (!response.ok) throw new Error("密码不正确");
    state.token = password;
    try { sessionStorage.setItem(TOKEN_KEY, password); } catch {}
    hideLogin();
    applySnapshot(await response.json());
    if (state.refreshTimer === null) state.refreshTimer = window.setInterval(refreshStatus, 2000);
  } catch (error) {
    showLogin(error.message || "登录失败");
  }
});

for (const option of elements.themeOptions) option.addEventListener("click", () => applyThemeMode(option.dataset.themeOption));
const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
mediaQuery.addEventListener?.("change", () => {
  if (document.documentElement.dataset.themeMode === "system") applyThemeMode("system", false);
});

createIcons({
  icons: { Monitor, Moon, Sun, TriangleAlert, X },
  attrs: { "aria-hidden": "true", "stroke-width": "2" },
});

restoreThemeMode();
restoreUserKey();
renderActivity();
updateControls();
try { state.token = sessionStorage.getItem(TOKEN_KEY) || ""; } catch {}
if (state.token) {
  hideLogin();
  void refreshStatus();
  state.refreshTimer = window.setInterval(refreshStatus, 2000);
} else showLogin();

