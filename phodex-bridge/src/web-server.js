// FILE: web-server.js
// Purpose: Hosts a browser/PWA Remodex client that talks directly to the local bridge.
// Layer: CLI service
// Exports: startWebApp
// Depends on: http, fs, path, url, crypto, ws, bridge handlers, codex transport

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");
const { WebSocket, WebSocketServer } = require("ws");
const {
  CodexDesktopRefresher,
  readBridgeConfig,
} = require("./codex-desktop-refresher");
const { createCodexTransport } = require("./codex-transport");
const { handleDesktopRequest } = require("./desktop-handler");
const { handleGitRequest } = require("./git-handler");
const { handleThreadContextRequest } = require("./thread-context-handler");
const { handleWorkspaceRequest } = require("./workspace-handler");
const { rememberActiveThread } = require("./session-state");

const DEFAULT_WEB_HOST = "127.0.0.1";
const DEFAULT_WEB_PORT = 9173;
const STATIC_ROOT = path.join(__dirname, "web-app");
const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
]);

function startWebApp(argv = process.argv.slice(3), env = process.env) {
  const options = parseWebOptions(argv, env);
  const config = readBridgeConfig({ env });
  const clients = new Set();
  const desktopRefresher = new CodexDesktopRefresher({
    enabled: config.refreshEnabled,
    debounceMs: config.refreshDebounceMs,
    refreshCommand: config.refreshCommand,
    bundleId: config.codexBundleId,
    appPath: config.codexAppPath,
  });
  const codex = createCodexTransport({
    endpoint: config.codexEndpoint,
    env,
  });

  let codexHandshakeState = config.codexEndpoint ? "warm" : "cold";
  const forwardedInitializeRequestIds = new Set();
  let isShuttingDown = false;

  const server = http.createServer((req, res) => {
    serveStatic(req, res);
  });
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const requestURL = safeRequestURL(req);
    if (!requestURL || requestURL.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    if (!isAuthorized(requestURL, options.token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    clients.add(ws);
    sendToClient(ws, JSON.stringify({
      method: "remodex/web/status",
      params: {
        connected: true,
        codexEndpoint: config.codexEndpoint || null,
        mode: config.codexEndpoint ? "endpoint" : "spawn",
      },
    }));

    ws.on("message", (data) => {
      const rawMessage = typeof data === "string" ? data : data.toString("utf8");
      handleClientMessage(ws, rawMessage);
    });

    ws.on("close", () => {
      clients.delete(ws);
    });
  });

  codex.onMessage((message) => {
    trackCodexHandshakeState(message);
    desktopRefresher.handleOutbound(message);
    rememberThreadFromMessage("codex", message);
    broadcast(clients, message);
  });

  codex.onClose(() => {
    broadcast(clients, JSON.stringify({
      method: "remodex/web/status",
      params: {
        connected: false,
        message: "Codex app-server disconnected.",
      },
    }));
    desktopRefresher.handleTransportReset();
  });

  codex.onError((error) => {
    const launchDescription = typeof codex.describe === "function" ? codex.describe() : "Codex endpoint";
    console.error("[remodex-web] Failed to start or connect Codex app-server.");
    console.error(`[remodex-web] Launch command: ${launchDescription}`);
    console.error(`[remodex-web] ${error.message}`);
    broadcast(clients, JSON.stringify({
      method: "remodex/web/status",
      params: {
        connected: false,
        message: error.message,
      },
    }));
  });

  server.listen(options.port, options.host, () => {
    const localURL = buildLocalURL(options);
    console.log(`[remodex-web] listening on ${localURL}`);
    if (options.host === "127.0.0.1" || options.host === "localhost") {
      console.log("[remodex-web] For iPhone LAN access, restart with --host 0.0.0.0 and open your Mac's LAN/Tailscale URL.");
    }
    if (options.token) {
      console.log("[remodex-web] Keep the URL token private; anyone with it can control this Codex bridge.");
    }
  });

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  function handleClientMessage(ws, rawMessage) {
    if (handleBridgeManagedHandshakeMessage(rawMessage, (response) => sendToClient(ws, response))) {
      return;
    }
    if (handleThreadContextRequest(rawMessage, (response) => sendToClient(ws, response))) {
      return;
    }
    if (handleWorkspaceRequest(rawMessage, (response) => sendToClient(ws, response))) {
      return;
    }
    if (handleDesktopRequest(rawMessage, (response) => sendToClient(ws, response), {
      bundleId: config.codexBundleId,
      appPath: config.codexAppPath,
    })) {
      return;
    }
    if (handleGitRequest(rawMessage, (response) => sendToClient(ws, response))) {
      return;
    }

    desktopRefresher.handleInbound(rawMessage);
    rememberThreadFromMessage("web", rawMessage);
    codex.send(rawMessage);
  }

  function handleBridgeManagedHandshakeMessage(rawMessage, sendResponse) {
    let parsed = null;
    try {
      parsed = JSON.parse(rawMessage);
    } catch {
      return false;
    }

    const method = typeof parsed?.method === "string" ? parsed.method.trim() : "";
    if (!method) {
      return false;
    }

    if (method === "initialize" && parsed.id != null) {
      if (codexHandshakeState !== "warm") {
        forwardedInitializeRequestIds.add(String(parsed.id));
        return false;
      }

      sendResponse(JSON.stringify({
        id: parsed.id,
        result: {
          bridgeManaged: true,
        },
      }));
      return true;
    }

    return method === "initialized" && codexHandshakeState === "warm";
  }

  function trackCodexHandshakeState(rawMessage) {
    let parsed = null;
    try {
      parsed = JSON.parse(rawMessage);
    } catch {
      return;
    }

    const responseId = parsed?.id;
    if (responseId == null) {
      return;
    }

    const responseKey = String(responseId);
    if (!forwardedInitializeRequestIds.has(responseKey)) {
      return;
    }

    forwardedInitializeRequestIds.delete(responseKey);
    if (parsed?.result != null) {
      codexHandshakeState = "warm";
      return;
    }

    const errorMessage = typeof parsed?.error?.message === "string"
      ? parsed.error.message.toLowerCase()
      : "";
    if (errorMessage.includes("already initialized")) {
      codexHandshakeState = "warm";
    }
  }

  function rememberThreadFromMessage(source, rawMessage) {
    const context = extractBridgeMessageContext(rawMessage);
    if (context.threadId) {
      rememberActiveThread(context.threadId, source);
    }
  }

  function shutdown() {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;
    for (const client of clients) {
      try {
        client.close();
      } catch {
        // Ignore shutdown races.
      }
    }
    server.close();
    desktopRefresher.handleTransportReset();
    codex.shutdown();
    setTimeout(() => process.exit(0), 100);
  }
}

function serveStatic(req, res) {
  const requestURL = safeRequestURL(req);
  if (!requestURL) {
    sendPlain(res, 400, "Bad request");
    return;
  }

  const pathname = requestURL.pathname === "/" ? "/index.html" : requestURL.pathname;
  const decodedPath = decodeURIComponent(pathname);
  const normalizedPath = path.normalize(decodedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(STATIC_ROOT, normalizedPath);
  if (!filePath.startsWith(STATIC_ROOT)) {
    sendPlain(res, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendPlain(res, 404, "Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=3600",
      "Content-Type": MIME_TYPES.get(ext) || "application/octet-stream",
    });
    res.end(content);
  });
}

function sendPlain(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

function safeRequestURL(req) {
  try {
    return new URL(req.url || "/", "http://localhost");
  } catch {
    return null;
  }
}

function isAuthorized(requestURL, token) {
  return !token || requestURL.searchParams.get("token") === token;
}

function sendToClient(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(message);
  }
}

function broadcast(clients, message) {
  for (const client of clients) {
    sendToClient(client, message);
  }
}

function parseWebOptions(argv, env) {
  let host = readString(env.REMODEX_WEB_HOST) || DEFAULT_WEB_HOST;
  let port = parsePort(env.REMODEX_WEB_PORT, DEFAULT_WEB_PORT);
  let token = readString(env.REMODEX_WEB_TOKEN) || crypto.randomBytes(18).toString("base64url");

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host" && argv[index + 1]) {
      host = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--host=")) {
      host = arg.slice("--host=".length);
      continue;
    }
    if (arg === "--port" && argv[index + 1]) {
      port = parsePort(argv[index + 1], port);
      index += 1;
      continue;
    }
    if (arg.startsWith("--port=")) {
      port = parsePort(arg.slice("--port=".length), port);
      continue;
    }
    if (arg === "--token" && argv[index + 1]) {
      token = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--token=")) {
      token = arg.slice("--token=".length);
      continue;
    }
    if (arg === "--no-token") {
      token = "";
    }
  }

  return {
    host,
    port,
    token,
  };
}

function buildLocalURL({ host, port, token }) {
  const visibleHost = host === "0.0.0.0" ? "localhost" : host;
  const url = new URL(`http://${visibleHost}:${port}/`);
  if (token) {
    url.searchParams.set("token", token);
  }
  return url.toString();
}

function parsePort(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
    return fallback;
  }
  return parsed;
}

function extractBridgeMessageContext(rawMessage) {
  let parsed = null;
  try {
    parsed = JSON.parse(rawMessage);
  } catch {
    return { method: "", threadId: null, turnId: null };
  }

  const method = parsed?.method;
  const params = parsed?.params;
  const threadId = extractThreadId(method, params);
  const turnId = extractTurnId(method, params);

  return {
    method: typeof method === "string" ? method : "",
    threadId,
    turnId,
  };
}

function extractThreadId(method, params) {
  if (method === "turn/start" || method === "turn/started") {
    return (
      readString(params?.threadId)
      || readString(params?.thread_id)
      || readString(params?.turn?.threadId)
      || readString(params?.turn?.thread_id)
    );
  }

  if (method === "thread/start" || method === "thread/started") {
    return (
      readString(params?.threadId)
      || readString(params?.thread_id)
      || readString(params?.thread?.id)
      || readString(params?.thread?.threadId)
      || readString(params?.thread?.thread_id)
    );
  }

  if (method === "thread/read" || method === "thread/resume" || method === "turn/completed") {
    return (
      readString(params?.threadId)
      || readString(params?.thread_id)
      || readString(params?.turn?.threadId)
      || readString(params?.turn?.thread_id)
    );
  }

  return null;
}

function extractTurnId(method, params) {
  if (method === "turn/started" || method === "turn/completed") {
    return (
      readString(params?.turnId)
      || readString(params?.turn_id)
      || readString(params?.id)
      || readString(params?.turn?.id)
    );
  }

  if (method === "turn/start") {
    return readString(params?.turnId) || readString(params?.turn_id);
  }

  return null;
}

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

module.exports = {
  startWebApp,
  __test: {
    buildLocalURL,
    parseWebOptions,
  },
};
