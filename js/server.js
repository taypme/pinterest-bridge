import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const WS_PORT = 18373;
const HTTP_PORT = 18374;
const HOST = "127.0.0.1";
const HEARTBEAT_STALE_MS = 45_000;
const PENDING_NUDGE_MS = 90_000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const JSON_DIR = path.join(ROOT_DIR, "json");

let extensionSocket = null;
let extensionMeta = null;
let extensionLastHeartbeatAt = 0;
let nextRequestId = 1;
const pending = new Map();

function logBridge(message, details) {
  const timestamp = new Date().toISOString();
  if (details === undefined) {
    console.log(`[${timestamp}] ${message}`);
    return;
  }

  console.log(`[${timestamp}] ${message}`, details);
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sanitizePinId(pinId) {
  const value = String(pinId || "").trim();
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid pin ID: ${pinId}`);
  }
  return value;
}

function ensureJsonDir() {
  fs.mkdirSync(JSON_DIR, { recursive: true });
}

function getPinFilePath(pinId) {
  return path.join(JSON_DIR, `${sanitizePinId(pinId)}.json`);
}

function deletePinFile(pinId) {
  const filePath = getPinFilePath(pinId);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return filePath;
  }
  return null;
}

function savePins(pins) {
  ensureJsonDir();

  const saved = [];
  for (const pin of pins) {
    const pinId = sanitizePinId(pin.pinId);
    const outPath = getPinFilePath(pinId);
    const payload = {
      ...pin,
      pinId,
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
    saved.push({ pinId, path: outPath });
  }

  return saved;
}

function readStoredPins() {
  ensureJsonDir();
  return fs
    .readdirSync(JSON_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const filePath = path.join(JSON_DIR, name);
      const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return {
        filePath,
        payload,
      };
    });
}

function runCommandViaExtension(type, payload, options = {}) {
  return new Promise((resolve, reject) => {
    if (!extensionSocket || extensionSocket.readyState !== 1) {
      reject(new Error("No extension connected. Load ./ext/dist as an unpacked extension in Chrome."));
      return;
    }

    const requestId = `${Date.now()}-${nextRequestId++}`;

    pending.set(requestId, {
      type,
      createdAt: Date.now(),
      lastProgressAt: Date.now(),
      nudgeCount: 0,
      onProgress: options.onProgress,
      resolve: (messagePayload) => {
        resolve(messagePayload);
      },
      reject: (error) => {
        reject(error);
      },
    });

    extensionSocket.send(
      JSON.stringify({
        type,
        requestId,
        payload,
      })
    );
  });
}

const wss = new WebSocketServer({ host: HOST, port: WS_PORT });
wss.on("connection", (socket) => {
  socket.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (msg.type === "hello" && msg.role === "extension") {
      extensionSocket = socket;
      extensionMeta = msg.meta || null;
      extensionLastHeartbeatAt = Date.now();
      logBridge("Extension connected", extensionMeta || "");
      return;
    }

    if (msg.type === "heartbeat") {
      extensionLastHeartbeatAt = Date.now();
      try {
        socket.send(
          JSON.stringify({
            type: "heartbeatAck",
            serverTime: new Date().toISOString(),
          })
        );
      } catch {}
      return;
    }

    if (msg.type === "commandResult" && msg.requestId) {
      const request = pending.get(msg.requestId);
      if (!request) return;
      pending.delete(msg.requestId);
      request.resolve(msg.payload ?? null);
      return;
    }

    if (msg.type === "commandProgress" && msg.requestId) {
      const request = pending.get(msg.requestId);
      if (!request?.onProgress) return;
      request.lastProgressAt = Date.now();
      request.onProgress(msg.payload ?? null);
      return;
    }

    if (msg.type === "commandLog") {
      logBridge(`[extension] ${msg.message || "log"}`, msg.details);
      return;
    }

    if (msg.type === "commandError" && msg.requestId) {
      const request = pending.get(msg.requestId);
      if (!request) return;
      pending.delete(msg.requestId);
      request.reject(new Error(msg.error || "Unknown extension error"));
    }
  });

  socket.on("close", () => {
    if (socket === extensionSocket) {
      extensionSocket = null;
      extensionMeta = null;
      extensionLastHeartbeatAt = 0;
      logBridge("Extension disconnected");
    }
  });
});

setInterval(() => {
  const now = Date.now();

  if (extensionSocket && extensionLastHeartbeatAt && now - extensionLastHeartbeatAt > HEARTBEAT_STALE_MS) {
    logBridge("Extension heartbeat stale", {
      staleMs: now - extensionLastHeartbeatAt,
    });
  }

  for (const [requestId, request] of pending.entries()) {
    if (request.type !== "syncBoard") continue;
    const idleMs = now - (request.lastProgressAt || request.createdAt || now);
    if (idleMs < PENDING_NUDGE_MS) continue;
    if (!extensionSocket || extensionSocket.readyState !== 1) continue;

    request.lastProgressAt = now;
    request.nudgeCount = (request.nudgeCount || 0) + 1;

    try {
      extensionSocket.send(
        JSON.stringify({
          type: "nudgeSync",
          requestId,
          details: {
            idleMs,
            nudgeCount: request.nudgeCount,
            commandType: request.type,
          },
        })
      );
      logBridge("Sent request nudge", {
        requestId,
        commandType: request.type,
        idleMs,
        nudgeCount: request.nudgeCount,
      });
    } catch (error) {
      logBridge("Failed to send request nudge", {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}, 15_000);

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, {
        ok: true,
        wsPort: WS_PORT,
        extensionConnected: Boolean(extensionSocket),
        extensionMeta,
        storedPins: fs.existsSync(JSON_DIR)
          ? fs.readdirSync(JSON_DIR).filter((name) => name.endsWith(".json")).length
          : 0,
      });
      return;
    }

    if (req.method === "POST" && req.url === "/scrape") {
      const body = await parseRequestBody(req);
      const targetUrl = String(body?.url || "").trim();

      if (!targetUrl) {
        sendJson(res, 400, { ok: false, error: "url is required" });
        return;
      }

      const savedPinIds = new Set();
      const boardsByUrl = new Map();
      const saveProgressPins = (progressPayload) => {
        const pins = Array.isArray(progressPayload?.pins) ? progressPayload.pins : [];
        for (const saved of savePins(pins)) {
          savedPinIds.add(saved.pinId);
        }

        if (progressPayload?.board?.url) {
          boardsByUrl.set(progressPayload.board.url, progressPayload.board);
        }

        logBridge("Saved pin batch", {
          board: progressPayload?.board?.slug || progressPayload?.board?.title || null,
          batchPins: pins.length,
          totalSavedPins: savedPinIds.size,
          step: progressPayload?.step ?? null,
        });
      };

      const payload = await runCommandViaExtension(
        "scrapeAccount",
        { url: targetUrl },
        { onProgress: saveProgressPins }
      );

      const pins = Array.isArray(payload?.pins) ? payload.pins : [];
      for (const saved of savePins(pins)) {
        savedPinIds.add(saved.pinId);
      }

      for (const board of Array.isArray(payload?.boards) ? payload.boards : []) {
        if (board?.url) {
          boardsByUrl.set(board.url, board);
        }
      }

      sendJson(res, 200, {
        ok: true,
        url: targetUrl,
        scrapedPins: payload?.totalPins || savedPinIds.size || pins.length,
        savedPins: savedPinIds.size,
        boards: Array.from(boardsByUrl.values()),
      });
      return;
    }

    if (req.method === "POST" && req.url === "/sync") {
      const storedPins = readStoredPins().map(({ payload }) => payload);
      const progress = {
        syncedPins: 0,
        skippedPins: 0,
        lastPinId: null,
        completedPins: 0,
      };
      const payload = await runCommandViaExtension(
        "syncBoard",
        { pins: storedPins },
        {
          onProgress: (progressPayload) => {
            if (progressPayload?.kind === "syncHeartbeat") {
              logBridge("Sync heartbeat", {
                phase: progressPayload?.phase || null,
                pinId: progressPayload?.pinId || null,
                attempt: progressPayload?.attempt || null,
                maxAttempts: progressPayload?.maxAttempts || null,
                completedPins: progressPayload?.completedPins || 0,
                totalPins: progressPayload?.totalPins || storedPins.length,
              });
              return;
            }

            if (progressPayload?.newlyPinned) {
              progress.syncedPins += 1;
              const deletedPath = deletePinFile(progressPayload?.pinId);
              logBridge("Deleted synced pin JSON", {
                pinId: progressPayload?.pinId || null,
                deletedPath,
              });
            } else if (progressPayload?.alreadyPinned) {
              progress.skippedPins += 1;
              const deletedPath = deletePinFile(progressPayload?.pinId);
              logBridge("Deleted already-pinned JSON", {
                pinId: progressPayload?.pinId || null,
                deletedPath,
              });
            } else {
              progress.skippedPins += 1;
            }

            progress.lastPinId = progressPayload?.pinId || null;
            progress.completedPins += 1;

            logBridge("Sync progress", {
              pinId: progressPayload?.pinId || null,
              saved: Boolean(progressPayload?.saved),
              newlyPinned: Boolean(progressPayload?.newlyPinned),
              alreadyPinned: Boolean(progressPayload?.alreadyPinned),
              syncedPins: progress.syncedPins,
              skippedPins: progress.skippedPins,
              completedPins: progress.completedPins,
              totalPins: storedPins.length,
            });
          },
        }
      );

      sendJson(res, 200, {
        ok: true,
        totalPins: storedPins.length,
        syncedPins: payload?.syncedPins || progress.syncedPins,
        skippedPins: payload?.skippedPins || progress.skippedPins,
        target: payload?.target || "profile",
      });
      return;
    }

    sendJson(res, 404, { ok: false, error: "not found" });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 0;

server.listen(HTTP_PORT, HOST, () => {
  console.log("Pinterest bridge server listening");
  console.log(`- HTTP: http://${HOST}:${HTTP_PORT}`);
  console.log(`- WS:   ws://${HOST}:${WS_PORT}`);
  console.log("Load ./ext/dist as an unpacked Chrome extension and stay logged into Pinterest.");
});
