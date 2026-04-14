const state = {
  activeThreadId: null,
  activeTurnId: null,
  connected: false,
  initialized: false,
  messages: [],
  models: [],
  pending: new Map(),
  requestSeq: 0,
  threads: [],
  ws: null,
};

const els = {
  approvalPanel: document.querySelector("#approval-panel"),
  composer: document.querySelector("#composer"),
  connectionPill: document.querySelector("#connection-pill"),
  cwdInput: document.querySelector("#cwd-input"),
  effortSelect: document.querySelector("#effort-select"),
  interruptButton: document.querySelector("#interrupt-button"),
  messages: document.querySelector("#messages"),
  modelSelect: document.querySelector("#model-select"),
  newThreadButton: document.querySelector("#new-thread-button"),
  promptInput: document.querySelector("#prompt-input"),
  refreshButton: document.querySelector("#refresh-button"),
  sendButton: document.querySelector("#send-button"),
  threadList: document.querySelector("#thread-list"),
  threadProject: document.querySelector("#thread-project"),
  threadTitle: document.querySelector("#thread-title"),
  toast: document.querySelector("#toast"),
};

connect();
registerServiceWorker();

els.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  sendPrompt().catch(showError);
});
els.refreshButton.addEventListener("click", () => refreshThreads().catch(showError));
els.newThreadButton.addEventListener("click", () => createThread().catch(showError));
els.interruptButton.addEventListener("click", () => interruptTurn().catch(showError));

function connect() {
  const token = currentToken();
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const wsURL = new URL(`${protocol}//${location.host}/ws`);
  if (token) wsURL.searchParams.set("token", token);

  setConnection("Connecting", false);
  const ws = new WebSocket(wsURL);
  state.ws = ws;

  ws.addEventListener("open", async () => {
    state.connected = true;
    setConnection("Connected", true);
    try {
      await initializeRuntime();
      await Promise.allSettled([loadModels(), refreshThreads()]);
    } catch (error) {
      showError(error);
    }
  });

  ws.addEventListener("message", (event) => {
    handleWireMessage(event.data);
  });

  ws.addEventListener("close", () => {
    state.connected = false;
    state.initialized = false;
    setConnection("Disconnected", false);
    setTimeout(connect, 1400);
  });

  ws.addEventListener("error", () => {
    setConnection("Error", false);
  });
}

async function initializeRuntime() {
  const clientInfo = {
    name: "remodex_web",
    title: "Remodex Web",
    version: "0.1.0",
  };
  try {
    await request("initialize", {
      clientInfo,
      capabilities: {
        experimentalApi: true,
      },
    });
  } catch (error) {
    await request("initialize", { clientInfo });
  }
  notify("initialized");
  state.initialized = true;
}

function currentToken() {
  const params = new URLSearchParams(location.search);
  const token = params.get("token") || localStorage.getItem("remodex-web-token") || "";
  if (token) localStorage.setItem("remodex-web-token", token);
  return token;
}

function request(method, params = null) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("WebSocket is not connected."));
  }

  const id = `web-${Date.now()}-${++state.requestSeq}`;
  const payload = params == null ? { id, method } : { id, method, params };
  state.ws.send(JSON.stringify(payload));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(id);
      reject(new Error(`${method} timed out.`));
    }, 90_000);
    state.pending.set(id, { method, resolve, reject, timer });
  });
}

function notify(method, params = null) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  const payload = params == null ? { method } : { method, params };
  state.ws.send(JSON.stringify(payload));
}

function respond(id, result) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  state.ws.send(JSON.stringify({ id, result }));
}

function handleWireMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }

  if (message.id != null && !message.method) {
    const key = String(message.id);
    const pending = state.pending.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    state.pending.delete(key);
    if (message.error) {
      pending.reject(new Error(message.error.message || `${pending.method} failed.`));
    } else {
      pending.resolve(message.result);
    }
    return;
  }

  if (message.id != null && message.method) {
    handleServerRequest(message);
    return;
  }

  if (message.method) {
    handleNotification(message.method, message.params || {});
  }
}

function handleNotification(method, params) {
  if (method === "remodex/web/status") {
    if (params?.message) showToast(params.message);
    return;
  }

  switch (method) {
    case "thread/started":
      upsertThread(params.thread || params);
      if (params.thread?.id) setActiveThread(params.thread.id, params.thread);
      break;
    case "thread/name/updated":
      updateThreadTitle(params.threadId || params.thread_id, params.name || params.title);
      break;
    case "thread/status/changed":
      updateThreadStatus(params.threadId || params.thread_id, params.status);
      break;
    case "turn/started":
      state.activeTurnId = readTurnId(params);
      els.interruptButton.disabled = false;
      break;
    case "turn/completed":
      els.interruptButton.disabled = true;
      state.activeTurnId = null;
      refreshActiveThreadSoon();
      refreshThreadsSoon();
      break;
    case "turn/failed":
    case "error":
    case "codex/event/error":
      els.interruptButton.disabled = true;
      state.activeTurnId = null;
      showToast(readErrorMessage(params));
      break;
    case "item/started":
    case "codex/event/item_started":
      handleItemStarted(params);
      break;
    case "item/agentMessage/delta":
    case "codex/event/agent_message_content_delta":
    case "codex/event/agent_message_delta":
      appendAssistantDelta(params);
      break;
    case "item/completed":
    case "codex/event/item_completed":
    case "codex/event/agent_message":
      completeItem(params);
      break;
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
    case "item/plan/delta":
    case "item/commandExecution/outputDelta":
    case "item/command_execution/outputDelta":
    case "item/toolCall/outputDelta":
    case "item/tool_call/outputDelta":
    case "item/fileChange/outputDelta":
      appendToolDelta(method, params);
      break;
    default:
      break;
  }
}

async function loadModels() {
  const result = await request("model/list", {
    cursor: null,
    limit: 50,
    includeHidden: false,
  });
  const models = result?.items || result?.data || result?.models || [];
  state.models = models;
  renderModels();
}

async function refreshThreads() {
  const result = await request("thread/list", {
    sourceKinds: ["cli", "vscode", "appServer", "exec", "unknown"],
    cursor: null,
    limit: 100,
    archived: false,
  });
  state.threads = result?.data || result?.items || result?.threads || [];
  renderThreads();
}

async function createThread() {
  const params = selectedRuntimeParams();
  const cwd = els.cwdInput.value.trim();
  if (cwd) params.cwd = cwd;

  const result = await request("thread/start", params);
  const thread = result?.thread || result;
  if (!thread?.id) throw new Error("thread/start did not return a thread.");
  upsertThread(thread);
  setActiveThread(thread.id, thread);
  state.messages = [];
  renderMessages();
  await refreshThreads();
}

async function selectThread(threadId) {
  const thread = state.threads.find((item) => item.id === threadId);
  setActiveThread(threadId, thread);
  await readThread(threadId);
}

async function readThread(threadId) {
  const result = await request("thread/read", {
    threadId,
    includeTurns: true,
  });
  const thread = result?.thread || result;
  if (thread?.id) upsertThread(thread);
  state.messages = messagesFromThread(thread);
  renderThreads();
  renderMessages();
}

async function sendPrompt() {
  const text = els.promptInput.value.trim();
  if (!text) return;
  els.promptInput.value = "";
  els.sendButton.disabled = true;

  try {
    if (!state.activeThreadId) {
      await createThread();
    }
    const threadId = state.activeThreadId;
    addMessage({
      id: `local-user-${Date.now()}`,
      role: "user",
      text,
    });
    const params = {
      threadId,
      input: [{ type: "text", text }],
      ...selectedRuntimeParams(),
    };
    const result = await request("turn/start", params);
    state.activeTurnId = readTurnId(result) || state.activeTurnId;
    els.interruptButton.disabled = false;
  } finally {
    els.sendButton.disabled = false;
  }
}

async function interruptTurn() {
  if (!state.activeThreadId) return;
  const params = { threadId: state.activeThreadId };
  if (state.activeTurnId) params.turnId = state.activeTurnId;
  await request("turn/interrupt", params);
  els.interruptButton.disabled = true;
}

function selectedRuntimeParams() {
  const params = {};
  const model = els.modelSelect.value;
  const effort = els.effortSelect.value;
  if (model) params.model = model;
  if (effort) params.effort = effort;
  return params;
}

function handleServerRequest(message) {
  const method = message.method || "request";
  const params = message.params || {};
  const command = params.command || params.reason || params.prompt || "";
  const title = method.includes("requestApproval") ? "Approval needed" : "Codex needs input";
  const body = command || JSON.stringify(params, null, 2);

  els.approvalPanel.innerHTML = "";
  els.approvalPanel.classList.remove("hidden");
  els.approvalPanel.append(
    node("strong", {}, title),
    node("pre", { class: "content" }, body),
    approvalActions(message)
  );
}

function approvalActions(message) {
  const wrap = node("div", { class: "approval-actions" });
  const approve = node("button", { type: "button" }, "Approve");
  const reject = node("button", { type: "button", class: "ghost danger" }, "Reject");
  approve.addEventListener("click", () => {
    respond(message.id, "accept");
    els.approvalPanel.classList.add("hidden");
  });
  reject.addEventListener("click", () => {
    respond(message.id, "deny");
    els.approvalPanel.classList.add("hidden");
  });
  wrap.append(approve, reject);
  return wrap;
}

function messagesFromThread(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const messages = [];
  for (const turn of turns) {
    for (const item of Array.isArray(turn.items) ? turn.items : []) {
      const message = messageFromItem(item, turn);
      if (message) messages.push(message);
    }
  }
  return messages;
}

function messageFromItem(item, turn) {
  const type = normalizeType(item?.type);
  if (type === "usermessage") {
    return {
      id: item.id || cryptoId(),
      role: "user",
      text: userContentText(item.content),
      turnId: turn?.id || null,
    };
  }
  if (type === "agentmessage") {
    return {
      id: item.id || cryptoId(),
      role: "assistant",
      text: item.text || "",
      turnId: turn?.id || null,
    };
  }
  if (type === "plan") {
    return {
      id: item.id || cryptoId(),
      role: "assistant",
      text: item.text || "",
      label: "Plan",
      turnId: turn?.id || null,
    };
  }
  if (type === "reasoning") {
    return {
      id: item.id || cryptoId(),
      role: "tool",
      text: [...(item.summary || []), ...(item.content || [])].join("\n"),
      label: "Reasoning",
      turnId: turn?.id || null,
    };
  }
  if (type === "commandexecution") {
    return {
      id: item.id || cryptoId(),
      role: "tool",
      text: `$ ${item.command || ""}\n${item.aggregatedOutput || ""}`.trim(),
      label: `Command ${item.status || ""}`.trim(),
      turnId: turn?.id || null,
    };
  }
  if (type === "filechange") {
    const files = Array.isArray(item.changes)
      ? item.changes.map((change) => change.path || change.file || change.kind || "change").join("\n")
      : "";
    return {
      id: item.id || cryptoId(),
      role: "tool",
      text: files || item.status || "File changes",
      label: `Files ${item.status || ""}`.trim(),
      turnId: turn?.id || null,
    };
  }
  if (type.endsWith("toolcall") || type === "collabagenttoolcall" || type === "websearch") {
    return {
      id: item.id || cryptoId(),
      role: "tool",
      text: toolItemText(item),
      label: item.tool || item.type,
      turnId: turn?.id || null,
    };
  }
  return null;
}

function handleItemStarted(params) {
  const item = incomingItem(params);
  if (normalizeType(item?.type) !== "agentmessage") return;
  upsertMessage({
    id: item.id || messageKey(params),
    role: "assistant",
    text: "",
    turnId: readTurnId(params),
  });
}

function appendAssistantDelta(params) {
  const delta = params.delta || params.event?.delta || "";
  if (!delta) return;
  const key = messageKey(params);
  upsertMessage({
    id: key,
    role: "assistant",
    text: delta,
    append: true,
    turnId: readTurnId(params),
  });
}

function completeItem(params) {
  const item = incomingItem(params);
  if (!item) {
    const text = params.message || params.event?.message || "";
    if (text) {
      upsertMessage({
        id: messageKey(params),
        role: "assistant",
        text,
        turnId: readTurnId(params),
      });
    }
    return;
  }

  const message = messageFromItem(item, { id: readTurnId(params) });
  if (message) upsertMessage(message);
}

function appendToolDelta(method, params) {
  const delta = params.delta || params.output || params.text || params.event?.delta || "";
  if (!delta) return;
  upsertMessage({
    id: messageKey(params, method),
    role: "tool",
    label: toolLabelFromMethod(method),
    text: delta,
    append: true,
    turnId: readTurnId(params),
  });
}

function addMessage(message) {
  state.messages.push(message);
  renderMessages();
}

function upsertMessage(message) {
  const index = state.messages.findIndex((item) => item.id === message.id);
  if (index === -1) {
    state.messages.push({
      id: message.id,
      role: message.role,
      label: message.label,
      text: message.text || "",
      turnId: message.turnId || null,
    });
  } else {
    const existing = state.messages[index];
    state.messages[index] = {
      ...existing,
      ...message,
      text: message.append ? `${existing.text || ""}${message.text || ""}` : (message.text || existing.text || ""),
    };
  }
  renderMessages();
}

function upsertThread(thread) {
  if (!thread?.id) return;
  const index = state.threads.findIndex((item) => item.id === thread.id);
  if (index === -1) {
    state.threads.unshift(thread);
  } else {
    state.threads[index] = { ...state.threads[index], ...thread };
  }
  renderThreads();
}

function updateThreadTitle(threadId, title) {
  const thread = state.threads.find((item) => item.id === threadId);
  if (thread) {
    thread.name = title || thread.name;
    thread.title = title || thread.title;
    renderThreads();
  }
}

function updateThreadStatus(threadId, status) {
  const thread = state.threads.find((item) => item.id === threadId);
  if (thread) {
    thread.status = status || thread.status;
    renderThreads();
  }
}

function setActiveThread(threadId, thread = null) {
  state.activeThreadId = threadId;
  if (thread) upsertThread(thread);
  const active = thread || state.threads.find((item) => item.id === threadId);
  els.threadTitle.textContent = displayThreadTitle(active) || "Conversation";
  els.threadProject.textContent = active?.cwd || active?.current_working_directory || "No project selected";
  renderThreads();
}

function renderModels() {
  const selected = els.modelSelect.value;
  els.modelSelect.innerHTML = "";
  els.modelSelect.append(node("option", { value: "" }, "Default"));
  for (const model of state.models) {
    const id = model.model || model.id || model.name;
    if (!id) continue;
    els.modelSelect.append(node("option", { value: id }, model.name || id));
  }
  els.modelSelect.value = selected;
}

function renderThreads() {
  els.threadList.innerHTML = "";
  if (!state.threads.length) {
    els.threadList.append(node("p", { class: "thread-preview" }, "No threads yet."));
    return;
  }
  for (const thread of state.threads) {
    const button = node("button", {
      class: `thread-card ${thread.id === state.activeThreadId ? "active" : ""}`,
      type: "button",
      role: "listitem",
    });
    button.append(
      node("p", { class: "thread-name" }, displayThreadTitle(thread)),
      node("p", { class: "thread-meta" }, thread.cwd || thread.current_working_directory || "No project"),
      node("p", { class: "thread-preview" }, thread.preview || formatDate(thread.updatedAt || thread.updated_at))
    );
    button.addEventListener("click", () => selectThread(thread.id).catch(showError));
    els.threadList.append(button);
  }
}

function renderMessages() {
  els.messages.innerHTML = "";
  if (!state.messages.length) {
    els.messages.append(node("p", { class: "empty" }, "Start a thread or pick one from the list."));
    return;
  }
  for (const message of state.messages) {
    const article = node("article", { class: `message ${message.role || "assistant"}` });
    article.append(
      node("p", { class: "role" }, message.label || message.role || "message"),
      node("pre", { class: "content" }, message.text || "")
    );
    els.messages.append(article);
  }
  els.messages.scrollTop = els.messages.scrollHeight;
}

function setConnection(text, ready) {
  els.connectionPill.textContent = text;
  els.connectionPill.classList.toggle("ready", ready);
}

function showError(error) {
  showToast(error?.message || String(error));
}

function showToast(text) {
  if (!text) return;
  els.toast.textContent = text;
  els.toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => els.toast.classList.add("hidden"), 5000);
}

function refreshThreadsSoon() {
  clearTimeout(refreshThreadsSoon.timer);
  refreshThreadsSoon.timer = setTimeout(() => refreshThreads().catch(() => {}), 600);
}

function refreshActiveThreadSoon() {
  clearTimeout(refreshActiveThreadSoon.timer);
  refreshActiveThreadSoon.timer = setTimeout(() => {
    if (state.activeThreadId) readThread(state.activeThreadId).catch(() => {});
  }, 800);
}

function displayThreadTitle(thread) {
  if (!thread) return "Conversation";
  return thread.name || thread.title || thread.preview || "Conversation";
}

function userContentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => {
    if (typeof item === "string") return item;
    return item.text || item.content || item.image_url || item.url || "";
  }).filter(Boolean).join("\n");
}

function incomingItem(params) {
  return params.item || params.event?.item || params.event || null;
}

function readTurnId(value) {
  return value?.turnId
    || value?.turn_id
    || value?.turn?.id
    || value?.id
    || value?.event?.turnId
    || value?.event?.turn_id
    || null;
}

function readItemId(params) {
  return params.itemId
    || params.item_id
    || params.item?.id
    || params.event?.item?.id
    || params.event?.item_id
    || null;
}

function messageKey(params, fallback = "message") {
  return readItemId(params)
    || `${readTurnId(params) || state.activeTurnId || state.activeThreadId || "thread"}-${fallback}`;
}

function toolLabelFromMethod(method) {
  if (method.includes("reasoning")) return "Reasoning";
  if (method.includes("plan")) return "Plan";
  if (method.includes("command")) return "Command";
  if (method.includes("file")) return "Files";
  return "Tool";
}

function toolItemText(item) {
  if (item.prompt) return item.prompt;
  if (item.query) return item.query;
  if (item.result) return typeof item.result === "string" ? item.result : JSON.stringify(item.result, null, 2);
  if (item.arguments) return JSON.stringify(item.arguments, null, 2);
  return item.status || item.tool || item.type || "";
}

function readErrorMessage(params) {
  return params?.message
    || params?.error?.message
    || params?.turn?.error?.message
    || "Codex reported an error.";
}

function normalizeType(value) {
  return String(value || "").replace(/[_-]/g, "").toLowerCase();
}

function formatDate(value) {
  if (!value) return "";
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

function cryptoId() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function node(tagName, attrs = {}, text = "") {
  const element = document.createElement(tagName);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") element.className = value;
    else element.setAttribute(key, value);
  }
  if (text != null) element.textContent = text;
  return element;
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
}
