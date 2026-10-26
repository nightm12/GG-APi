import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT_VERSION = "0.0.2";
const UPSTREAM_URL = "wss://gcli.ggchan.dev/api/build/ws";
const GOOGLE_API_ROOT = "https://generativelanguage.googleapis.com/v1beta/models";
const MAX_ACTIVITY_ROWS = 30;
const MAX_ERROR_MESSAGE_LENGTH = 1000;
const MAX_ERROR_BODY_DISPLAY_LENGTH = 64 * 1024;
const MAX_REQUEST_BODY_LENGTH = 32 * 1024;
const NON_ERROR_FINISH_REASONS = new Set(["", "FINISH_REASON_UNSPECIFIED", "STOP", "MAX_TOKENS"]);
const CLOSE_EXECUTOR_REPLACED = 4001;
const CLOSE_API_KEY_CHANGED = 4002;
const ROOT = fileURLToPath(new URL(".", import.meta.url));
const DIST = resolve(ROOT, "dist");
const DATA_DIR = resolve(process.env.DATA_DIR || join(ROOT, "data"));
const STATE_FILE = join(DATA_DIR, "state.json");
const HTTP_PORT = Number(process.env.PORT || 3000);

for (const name of ["GEMINI_API_KEY", "DASHBOARD_PASSWORD", "APP_ENCRYPTION_KEY"]) {
  if (!process.env[name]) throw new Error(`Required Railway variable is missing: ${name}`);
}
if (Buffer.byteLength(process.env.DASHBOARD_PASSWORD) < 16) {
  throw new Error("DASHBOARD_PASSWORD must be at least 16 bytes");
}
if (Buffer.byteLength(process.env.APP_ENCRYPTION_KEY) < 32) {
  throw new Error("APP_ENCRYPTION_KEY must be at least 32 bytes");
}

const encryptionKey = scryptSync(process.env.APP_ENCRYPTION_KEY, "gg-build-executor-state-v1", 32);
const blankState = () => ({
  desired: "stopped",
  status: "stopped",
  message: "后台执行器已停止",
  encryptedApiKey: null,
  connectedAt: 0,
  successCount: 0,
  failureCount: 0,
  activities: [],
});
let persisted = blankState();
let saveChain = Promise.resolve();
let workerSocket = null;
let workerRegistered = false;
let reconnectTimer = null;
let reconnectAttempt = 0;
let workerEpoch = 0;
let shuttingDown = false;
const activeRequests = new Map();

function encrypt(text) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

function decrypt(value) {
  if (typeof value !== "string") return "";
  const [ivText, tagText, dataText] = value.split(".");
  if (!ivText || !tagText || !dataText) return "";
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(dataText, "base64url")), decipher.final()]).toString("utf8");
}

async function loadState() {
  await mkdir(DATA_DIR, { recursive: true });
  try {
    const loaded = JSON.parse(await readFile(STATE_FILE, "utf8"));
    persisted = { ...blankState(), ...loaded };
    if (!Array.isArray(persisted.activities)) persisted.activities = [];
    persisted.activities = persisted.activities.slice(0, MAX_ACTIVITY_ROWS);
    if (persisted.desired !== "running" && persisted.desired !== "paused") persisted.desired = "stopped";
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function saveState() {
  const snapshot = JSON.stringify(persisted);
  saveChain = saveChain.catch(() => {}).then(async () => {
    const temporaryFile = `${STATE_FILE}.tmp`;
    await writeFile(temporaryFile, snapshot, { mode: 0o600 });
    await rename(temporaryFile, STATE_FILE);
  });
  return saveChain;
}

function isAuthorized(request) {
  const header = request.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const expected = Buffer.from(process.env.DASHBOARD_PASSWORD);
  const supplied = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function statusSnapshot() {
  return {
    desired: persisted.desired,
    status: persisted.status,
    message: persisted.message,
    hasApiKey: Boolean(persisted.encryptedApiKey),
    connectedAt: persisted.connectedAt,
    activeCount: activeRequests.size,
    successCount: persisted.successCount,
    failureCount: persisted.failureCount,
    activities: persisted.activities,
  };
}

function sendJSON(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function readJSON(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > MAX_REQUEST_BODY_LENGTH) throw new Error("Request body is too large");
  }
  return body ? JSON.parse(body) : {};
}

function contentType(path) {
  return ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".ico": "image/x-icon", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" })[extname(path)] || "application/octet-stream";
}

async function serveStatic(pathname, response) {
  const relativePath = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const path = resolve(DIST, relativePath);
  if (!path.startsWith(`${DIST}${process.platform === "win32" ? "\\" : "/"}`) && path !== join(DIST, "index.html")) {
    sendJSON(response, 404, { error: "not_found" });
    return;
  }
  try {
    const data = await readFile(path);
    response.writeHead(200, { "Content-Type": contentType(path), "Cache-Control": path.endsWith("index.html") ? "no-cache" : "public, max-age=3600" });
    response.end(data);
  } catch {
    if (extname(pathname)) {
      sendJSON(response, 404, { error: "not_found" });
      return;
    }
    const html = await readFile(join(DIST, "index.html"));
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    response.end(html);
  }
}

function updateStatus(status, message) {
  persisted.status = status;
  persisted.message = String(message || "").slice(0, MAX_ERROR_MESSAGE_LENGTH);
  void saveState().catch((error) => console.error("State persistence failed:", error instanceof Error ? error.message : "unknown error"));
}

function stopReconnectTimer() {
  if (reconnectTimer !== null) clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function sendUpstream(payload, socket = workerSocket) {
  if (!socket || socket !== workerSocket || socket.readyState !== 1) return false;
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function abortActiveRequests() {
  for (const active of activeRequests.values()) active.controller.abort();
  activeRequests.clear();
}

function scheduleReconnect(reason) {
  if (shuttingDown || persisted.desired !== "running" || reconnectTimer !== null) return;
  const delays = [1000, 2000, 5000, 10000, 15000, 30000];
  const delay = delays[Math.min(reconnectAttempt, delays.length - 1)];
  reconnectAttempt += 1;
  updateStatus("connecting", `${reason || "连接断开"}，${Math.ceil(delay / 1000)} 秒后重连`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWorker();
  }, delay);
}

function connectWorker() {
  stopReconnectTimer();
  if (shuttingDown || persisted.desired !== "running" || !persisted.encryptedApiKey || workerSocket) return;
  let apiKey;
  try {
    apiKey = decrypt(persisted.encryptedApiKey);
  } catch {
    persisted.desired = "stopped";
    updateStatus("error", "无法解密已保存的 API Key；请重新输入并启动后台");
    return;
  }
  if (!apiKey) {
    persisted.desired = "stopped";
    updateStatus("error", "没有已保存的公益站 API Key");
    return;
  }

  const epoch = ++workerEpoch;
  workerRegistered = false;
  updateStatus("connecting", "正在连接公益站后台");
  let socket;
  try {
    socket = new WebSocket(UPSTREAM_URL);
  } catch (error) {
    scheduleReconnect(error instanceof Error ? error.message : "无法创建连接");
    return;
  }
  workerSocket = socket;
  socket.addEventListener("open", () => {
    if (epoch !== workerEpoch || persisted.desired !== "running") {
      socket.close(1000, "worker stopped");
      return;
    }
    reconnectAttempt = 0;
    if (!sendUpstream({ type: "register", clientVersion: CLIENT_VERSION, apiKey }, socket)) socket.close();
  });
  socket.addEventListener("message", (event) => {
    if (epoch !== workerEpoch) return;
    void handleUpstreamMessage(String(event.data));
  });
  socket.addEventListener("error", () => {
    if (epoch === workerEpoch && persisted.desired === "running") updateStatus("connecting", "公益站连接出错，正在重试");
  });
  socket.addEventListener("close", (event) => {
    if (epoch !== workerEpoch) return;
    workerSocket = null;
    workerRegistered = false;
    abortActiveRequests();
    persisted.connectedAt = 0;
    if (event.code === CLOSE_EXECUTOR_REPLACED) {
      persisted.desired = "paused";
      updateStatus("paused", "该 API Key 已在其他执行器连接");
    } else if (event.code === CLOSE_API_KEY_CHANGED) {
      persisted.desired = "paused";
      updateStatus("error", "公益站 API Key 已更换，请更新 Key 后恢复后台");
    } else if (persisted.desired === "running") {
      scheduleReconnect("公益站连接已断开");
    } else if (persisted.status === "error") {
      void saveState();
    } else {
      updateStatus(persisted.desired, persisted.desired === "paused" ? "后台已暂停" : "后台执行器已停止");
    }
  });
}

async function handleUpstreamMessage(raw) {
  let message;
  try { message = JSON.parse(raw); } catch { return; }
  if (message.type === "registered") {
    if (message.clientVersion !== CLIENT_VERSION) {
      updateStatus("error", "后台客户端版本不匹配");
      persisted.desired = "paused";
      workerSocket?.close(1008, "client version outdated");
      return;
    }
    workerRegistered = true;
    persisted.connectedAt = Date.now();
    updateStatus("online", "后台运行中；关闭网页不会中断执行");
    return;
  }
  if (message.type === "error") {
    updateStatus("error", String(message.message || "公益站连接失败"));
    if (!workerRegistered) {
      persisted.desired = "paused";
      workerSocket?.close(1008, "registration rejected");
    }
    if (message.code === "client_version_outdated") {
      persisted.desired = "paused";
      workerSocket?.close(1008, "client version outdated");
    }
    return;
  }
  if (message.type === "cancel") {
    activeRequests.get(String(message.requestId || ""))?.controller.abort();
    return;
  }
  if (message.type === "request") await executeRequest(message);
}

function parseJSONBody(text) {
  try { return text.trim() ? JSON.parse(text) : null; } catch { return null; }
}

function findSSESeparator(value) {
  const crlf = value.indexOf("\r\n\r\n");
  const lf = value.indexOf("\n\n");
  if (crlf === -1 && lf === -1) return null;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function executionError(status, code, message, body = "") {
  return Object.assign(new Error(String(message || "Build 请求执行失败").slice(0, MAX_ERROR_MESSAGE_LENGTH)), { status, code, body });
}

function googleResponseError(status, payload, rawBody = "") {
  const details = payload && typeof payload === "object" ? payload.error : null;
  return executionError(status || 502, String(details?.status || `google_http_${status}`), String(details?.message || rawBody.trim() || `Google Build API 请求失败 (${status})`), rawBody);
}

function abnormalFinishReason(payload, rawBody) {
  if (!payload || typeof payload !== "object") return null;
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : payload.candidates && typeof payload.candidates === "object" ? [payload.candidates] : [];
  const issues = candidates.flatMap((candidate, position) => {
    if (!candidate || typeof candidate !== "object") return [];
    const reason = String(candidate.finishReason || "").trim().toUpperCase();
    if (NON_ERROR_FINISH_REASONS.has(reason)) return [];
    const index = Number.isInteger(candidate.index) ? candidate.index : position;
    const prefix = `候选 ${index}: ${reason}`;
    return [candidate.finishMessage ? `${prefix} - ${String(candidate.finishMessage).trim()}` : prefix];
  });
  return issues.length ? { status: 200, code: "finish_reason_error", message: `Google Build API 返回异常结束原因：${issues.join("；")}`.slice(0, MAX_ERROR_MESSAGE_LENGTH), body: rawBody } : null;
}

function truncateErrorBody(body) {
  const text = typeof body === "string" ? body : "";
  return text.length <= MAX_ERROR_BODY_DISPLAY_LENGTH ? text : `${text.slice(0, MAX_ERROR_BODY_DISPLAY_LENGTH)}\n\n[原始响应过长，已截断]`;
}

function observeTokenUsage(usage, metadata) {
  if (!metadata) return;
  for (const [field, key] of [["inputTokens", "promptTokenCount"], ["outputTokens", "candidatesTokenCount"]]) {
    if (Number.isSafeInteger(metadata[key]) && metadata[key] >= 0) usage[field] = metadata[key];
  }
}

async function sendExecutionError(requestID, stream, status, code, message, body = "") {
  if (!requestID) return;
  sendUpstream({ type: stream ? "stream-error" : "error", requestId: requestID, status, error: { code, message, body } });
}

async function sendStreamChunk(payload, signal) {
  const socket = workerSocket;
  if (!socket || socket.readyState !== 1) return false;
  while (socket.bufferedAmount > 1024 * 1024) {
    if (signal.aborted || socket !== workerSocket || socket.readyState !== 1) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (signal.aborted || socket !== workerSocket || socket.readyState !== 1) return false;
  return sendUpstream(payload, socket);
}

async function callGoogle(model, stream, requestBody, signal) {
  const action = stream ? "streamGenerateContent?alt=sse" : "generateContent";
  return fetch(`${GOOGLE_API_ROOT}/${encodeURIComponent(model)}:${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: requestBody,
    signal,
  });
}

async function executeNonStream(requestID, model, requestBody, signal, usage) {
  const response = await callGoogle(model, false, requestBody, signal);
  const responseBody = await response.text();
  const payload = parseJSONBody(responseBody);
  if (!response.ok) throw googleResponseError(response.status, payload, responseBody);
  if (!payload || typeof payload !== "object" || !responseBody.trim()) throw executionError(502, "invalid_google_response", "Google Build API 返回了无效响应");
  observeTokenUsage(usage, payload.usageMetadata);
  if (!sendUpstream({ type: "response", requestId: requestID, status: response.status, responseBody })) throw executionError(503, "backend_disconnected", "公益站连接已断开");
  return abnormalFinishReason(payload, responseBody);
}

async function executeStream(requestID, model, requestBody, signal, usage) {
  const response = await callGoogle(model, true, requestBody, signal);
  if (!response.ok) {
    const errorBody = await response.text();
    throw googleResponseError(response.status, parseJSONBody(errorBody), errorBody);
  }
  if (!response.body) throw executionError(502, "missing_stream_body", "Google Build API 未返回流式响应体");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let responseIssue = null;
  const consumeEvent = async (eventText) => {
    const data = eventText.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n").trim();
    if (!data || data === "[DONE]") return;
    const payload = parseJSONBody(data);
    if (!payload || typeof payload !== "object") throw executionError(502, "invalid_sse_payload", "Google Build API 返回了无效 SSE 数据");
    if (payload.error) throw googleResponseError(Number(payload.error.code) || 502, payload, data);
    responseIssue ||= abnormalFinishReason(payload, data);
    observeTokenUsage(usage, payload.usageMetadata);
    if (!(await sendStreamChunk({ type: "stream-chunk", requestId: requestID, chunkBody: data }, signal))) throw executionError(503, "backend_disconnected", "公益站连接已断开");
  };
  try {
    while (true) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      let separator;
      while ((separator = findSSESeparator(buffer)) !== null) {
        await consumeEvent(buffer.slice(0, separator.index));
        buffer = buffer.slice(separator.index + separator.length);
      }
      if (done) break;
    }
    if (buffer.trim()) await consumeEvent(buffer);
  } finally {
    reader.releaseLock();
  }
  if (!sendUpstream({ type: "stream-end", requestId: requestID, status: response.status })) throw executionError(503, "backend_disconnected", "公益站连接已断开");
  return responseIssue;
}

async function executeRequest(message) {
  const requestID = String(message.requestId || "").trim();
  const model = String(message.model || "").trim();
  const stream = message.stream === true;
  const requestBody = typeof message.requestBody === "string" ? message.requestBody : "";
  const parsedBody = parseJSONBody(requestBody);
  if (!requestID || !/^[A-Za-z0-9._-]{1,160}$/.test(model) || !parsedBody || typeof parsedBody !== "object" || !Array.isArray(parsedBody.contents)) {
    await sendExecutionError(requestID, stream, 400, "invalid_build_request", "后端发送了无效的 Build 请求");
    return;
  }
  if (activeRequests.has(requestID)) return;
  const controller = new AbortController();
  const startedAt = performance.now();
  const usage = { inputTokens: null, outputTokens: null };
  activeRequests.set(requestID, { controller, model, stream, startedAt });
  void saveState().catch((error) => console.error("State persistence failed:", error instanceof Error ? error.message : "unknown error"));
  let result = "success";
  let resultMessage = "成功";
  let errorDetails = null;
  let responseIssue = null;
  try {
    responseIssue = stream
      ? await executeStream(requestID, model, requestBody, controller.signal, usage)
      : await executeNonStream(requestID, model, requestBody, controller.signal, usage);
    if (responseIssue) {
      result = "error";
      resultMessage = responseIssue.message;
      errorDetails = { status: responseIssue.status, code: responseIssue.code, message: responseIssue.message, body: truncateErrorBody(responseIssue.body) };
      persisted.failureCount += 1;
    } else persisted.successCount += 1;
  } catch (error) {
    result = "error";
    const details = error?.name === "AbortError"
      ? { status: 499, code: "request_cancelled", message: "请求已取消", body: "" }
      : { status: Number(error?.status) || 502, code: String(error?.code || "build_execution_failed"), message: String(error?.message || "Build 请求执行失败").slice(0, MAX_ERROR_MESSAGE_LENGTH), body: typeof error?.body === "string" ? error.body : "" };
    resultMessage = details.message;
    errorDetails = { ...details, body: truncateErrorBody(details.body) };
    persisted.failureCount += 1;
    if (!controller.signal.aborted) await sendExecutionError(requestID, stream, details.status, details.code, details.message, details.body);
  } finally {
    activeRequests.delete(requestID);
    persisted.activities.unshift({ at: new Date().toISOString(), requestID, model, stream, result, message: resultMessage, error: errorDetails, durationMS: Math.round(performance.now() - startedAt), ...usage });
    persisted.activities.length = Math.min(persisted.activities.length, MAX_ACTIVITY_ROWS);
    await saveState();
  }
}

async function handleAPI(request, response, pathname) {
  if (pathname === "/api/status" && request.method === "GET") {
    if (!isAuthorized(request)) return sendJSON(response, 401, { error: "unauthorized" });
    return sendJSON(response, 200, statusSnapshot());
  }
  if (!isAuthorized(request)) return sendJSON(response, 401, { error: "unauthorized" });
  if (request.method !== "POST") return sendJSON(response, 405, { error: "method_not_allowed" });

  let body;
  try { body = await readJSON(request); } catch { return sendJSON(response, 400, { error: "invalid_request" }); }
  if (pathname === "/api/start") {
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    let keyChanged = false;
    if (apiKey) {
      let currentKey = "";
      try { currentKey = decrypt(persisted.encryptedApiKey); } catch {}
      keyChanged = apiKey !== currentKey;
      persisted.encryptedApiKey = encrypt(apiKey);
    }
    if (!persisted.encryptedApiKey) return sendJSON(response, 400, { error: "api_key_required", message: "请输入公益站 API Key" });
    persisted.desired = "running";
    persisted.connectedAt = 0;
    if (keyChanged && workerSocket) {
      const oldSocket = workerSocket;
      workerSocket = null;
      workerRegistered = false;
      workerEpoch += 1;
      abortActiveRequests();
      oldSocket.close(1000, "API Key changed");
    }
    await saveState();
    if (!workerSocket) connectWorker();
    return sendJSON(response, 200, statusSnapshot());
  }
  if (pathname === "/api/pause") {
    persisted.desired = "paused";
    stopReconnectTimer();
    persisted.connectedAt = 0;
    abortActiveRequests();
    workerEpoch += 1;
    const socket = workerSocket;
    workerSocket = null;
    workerRegistered = false;
    socket?.close(1000, "executor paused");
    updateStatus("paused", "后台已暂停；恢复后继续接收请求");
    await saveState();
    return sendJSON(response, 200, statusSnapshot());
  }
  if (pathname === "/api/stop") {
    persisted.desired = "stopped";
    persisted.encryptedApiKey = null;
    stopReconnectTimer();
    persisted.connectedAt = 0;
    abortActiveRequests();
    workerEpoch += 1;
    const socket = workerSocket;
    workerSocket = null;
    workerRegistered = false;
    socket?.close(1000, "executor stopped");
    updateStatus("stopped", "后台已停止，保存的公益站 API Key 已清除");
    await saveState();
    return sendJSON(response, 200, statusSnapshot());
  }
  if (pathname === "/api/clear-activity") {
    persisted.activities = [];
    await saveState();
    return sendJSON(response, 200, statusSnapshot());
  }
  return sendJSON(response, 404, { error: "not_found" });
}

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url || "/", "http://localhost").pathname;
  if (pathname === "/health") return sendJSON(response, 200, { status: "ok" });
  if (pathname.startsWith("/api/")) {
    try { await handleAPI(request, response, pathname); } catch (error) {
      console.error("API request failed:", error instanceof Error ? error.message : "unknown error");
      if (!response.headersSent) sendJSON(response, 500, { error: "internal_error" });
    }
    return;
  }
  await serveStatic(pathname, response);
});

await loadState();
server.listen(HTTP_PORT, "0.0.0.0", () => console.log(`GG Build Executor listening on ${HTTP_PORT}`));
if (persisted.desired === "running" && persisted.encryptedApiKey) connectWorker();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shuttingDown = true;
    stopReconnectTimer();
    abortActiveRequests();
    const socket = workerSocket;
    workerSocket = null;
    workerRegistered = false;
    socket?.close(1001, "service restarting");
    void saveState().finally(() => server.close(() => process.exit(0)));
  });
}
