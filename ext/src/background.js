import * as cheerio from "cheerio";
import _ from "lodash";

const WS_URL = "ws://127.0.0.1:18373";
const PINTEREST_URL_MATCH = "https://www.pinterest.com/*";
const WS_HEARTBEAT_MS = 15_000;
const WS_ACK_STALE_MS = 45_000;
let ws;
let reconnectTimer;
let heartbeatTimer;
let lastHeartbeatAckAt = 0;
let activeSyncState = null;

function sendSocketMessage(message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function logToBridge(message, details) {
  sendSocketMessage({
    type: "commandLog",
    message,
    details,
  });
}

function startHeartbeatLoop() {
  stopHeartbeatLoop();
  heartbeatTimer = setInterval(() => {
    sendSocketMessage({
      type: "heartbeat",
      activeSync: activeSyncState
        ? {
            requestId: activeSyncState.requestId,
            pinId: activeSyncState.currentPinId,
            pinUrl: activeSyncState.currentPinUrl,
            attempts: activeSyncState.pinAttempts,
            completedPins: activeSyncState.completedPins,
          }
        : null,
      sentAt: new Date().toISOString(),
    });

    if (lastHeartbeatAckAt && Date.now() - lastHeartbeatAckAt > WS_ACK_STALE_MS) {
      logToBridge("WebSocket heartbeat ack stale, reconnecting", {
        staleMs: Date.now() - lastHeartbeatAckAt,
      });
      try {
        ws.close();
      } catch {}
    }
  }, WS_HEARTBEAT_MS);
}

function stopHeartbeatLoop() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function connectSocket() {
  try {
    ws = new WebSocket(WS_URL);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.addEventListener("open", () => {
    lastHeartbeatAckAt = Date.now();
    sendSocketMessage({
      type: "hello",
      role: "extension",
      meta: { extensionVersion: chrome.runtime.getManifest().version },
    });
    startHeartbeatLoop();
  });

  ws.addEventListener("message", async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg.type === "heartbeatAck") {
      lastHeartbeatAckAt = Date.now();
      return;
    }

    if (msg.type === "nudgeSync") {
      handleSyncNudge(msg);
      return;
    }

    if (!msg?.requestId) return;

    try {
      let payload;
      if (msg.type === "scrapeAccount") {
        payload = await scrapeTargetUrl(msg.payload?.url, msg.requestId);
      } else if (msg.type === "syncBoard") {
        payload = await syncBoard(msg.payload?.pins || [], msg.requestId);
      } else {
        return;
      }

      sendSocketMessage({ type: "commandResult", requestId: msg.requestId, payload });
    } catch (error) {
      sendSocketMessage({
        type: "commandError",
        requestId: msg.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  ws.addEventListener("close", scheduleReconnect);
  ws.addEventListener("error", () => {
    try {
      ws.close();
    } catch {}
  });
}

function scheduleReconnect() {
  stopHeartbeatLoop();
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectSocket();
  }, 3000);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getOrCreateRoutineTab() {
  const existing = await chrome.tabs.query({ url: [PINTEREST_URL_MATCH] });
  if (existing.length > 0) {
    return existing[0].id;
  }

  const tab = await chrome.tabs.create({ url: "https://www.pinterest.com/", active: false });
  return tab.id;
}

async function waitForTabComplete(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === "complete") {
    await delay(1500);
    return;
  }

  await new Promise((resolve) => {
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
  await delay(1500);
}

async function navigateTo(tabId, url) {
  await chrome.tabs.update(tabId, { url, active: false });
  await waitForTabComplete(tabId);
}

async function runInTab(tabId, func, args = []) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func,
    args,
  });

  return result?.result;
}

async function reloadRoutineTab(tabId) {
  await chrome.tabs.reload(tabId);
  await waitForTabComplete(tabId);
}

async function recreateRoutineTab(tabId, url) {
  try {
    await chrome.tabs.remove(tabId);
  } catch {}
  const nextTabId = await getOrCreateRoutineTab();
  await navigateTo(nextTabId, url);
  return nextTabId;
}

function handleSyncNudge(msg) {
  if (!activeSyncState) return;
  if (msg.requestId !== activeSyncState.requestId) return;
  activeSyncState.kickRequested = true;
  logToBridge("Received sync nudge", {
    requestId: msg.requestId,
    currentPinId: activeSyncState.currentPinId,
    details: msg.details || null,
  });
}

async function navigateAndCapture(tabId, url, options = {}) {
  await navigateTo(tabId, url);
  return runInTab(tabId, captureRenderedPage, [options]);
}

function normalizePinterestUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url, "https://www.pinterest.com");
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString().replace(/\/+$/, "/");
  } catch {
    return null;
  }
}

function getScrapeTargetFromUrl(rawUrl) {
  const normalized = normalizePinterestUrl(rawUrl);
  if (!normalized) {
    throw new Error("Invalid Pinterest URL");
  }

  const parsed = new URL(normalized);
  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== "www.pinterest.com" && hostname !== "pinterest.com") {
    throw new Error("URL must be on pinterest.com");
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length === 0) {
    throw new Error("Pinterest URL must include a board or user path");
  }

  return {
    title: parts[parts.length - 1] || parts[0],
    slug: parts[parts.length - 1] || parts[0],
    url: normalized,
  };
}

function getPinterestPathParts(url) {
  const normalized = normalizePinterestUrl(url);
  if (!normalized) return null;

  try {
    const pathname = new URL(normalized).pathname;
    return {
      normalized,
      parts: pathname.split("/").filter(Boolean),
    };
  } catch {
    return null;
  }
}

function getBoardCandidateFromUrl(url, account) {
  const pathInfo = getPinterestPathParts(url);
  if (!pathInfo) return null;

  const { normalized, parts } = pathInfo;
  const normalizedAccount = String(account || "").trim().replace(/^@/, "").toLowerCase();
  if (parts.length < 2) return null;
  if (parts[0].toLowerCase() !== normalizedAccount) return null;

  const slug = parts[1];
  if (
    !slug ||
    ["pin", "boards", "_created", "_saved", "_profile", "_tools", "_shop"].includes(slug.toLowerCase())
  ) {
    return null;
  }

  return {
    url: normalized,
    slug,
  };
}

function parseBoardLinks(page, account) {
  const $ = cheerio.load(page.html);
  const links = [];

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href") || "";
    const board = getBoardCandidateFromUrl(href, account);
    if (!board) return;

    const title = $(element).text().trim().replace(/\s+/g, " ") || board.slug;
    links.push({
      title,
      url: board.url,
      slug: board.slug,
    });
  });

  return _.uniqBy(
    links.filter((board) => board.slug && board.slug !== "_created"),
    "url"
  );
}

function parseBoardPins(page, board) {
  const $ = cheerio.load(page.html);
  const pins = [];

  $("a[href*=\"/pin/\"]").each((_, element) => {
    const href = $(element).attr("href") || "";
    const match = href.match(/\/pin\/(\d+)/);
    if (!match) return;

    const pinId = match[1];
    const pinUrl = normalizePinterestUrl(`https://www.pinterest.com/pin/${pinId}/`);
    const image = $(element).find("img").first();
    const title =
      image.attr("alt") ||
      $(element).attr("aria-label") ||
      $(element).text().trim().replace(/\s+/g, " ") ||
      null;
    const imageUrl =
      image.attr("src") ||
      image.attr("srcset")?.split(",").pop()?.trim().split(" ")[0] ||
      null;

    pins.push({
      pinId,
      pinUrl,
      title,
      imageUrl,
      board: {
        title: board.title,
        slug: board.slug,
        url: board.url,
      },
      scrapedFrom: page.url,
    });
  });

  return _.uniqBy(pins, "pinId");
}

async function scrapeTargetUrl(rawUrl, requestId) {
  const target = getScrapeTargetFromUrl(rawUrl);
  const tabId = await getOrCreateRoutineTab();

  logToBridge("Starting scrapeTargetUrl", {
    target,
  });

  logToBridge("Switching target", {
    slug: target.slug,
    url: target.url,
  });
  await navigateTo(tabId, target.url);
  const pins = await scrapeBoardIncrementally(tabId, target, requestId);
  logToBridge("Finished target", {
    slug: target.slug,
    url: target.url,
    pinsCollected: pins.length,
  });

  return {
    url: target.url,
    boards: [target],
    totalPins: _.uniqBy(pins, "pinId").length,
  };
}

async function scrapeBoardIncrementally(tabId, board, requestId) {
  const seenPinIds = new Set();
  const collectedPins = [];
  let stableSteps = 0;
  let bottomConfirmations = 0;
  let confirmationMode = false;
  const maxBottomConfirmations = 25;
  const bottomRetryWaitMs = 3000;

  logToBridge("Starting target scrape loop", {
    slug: board.slug,
    url: board.url,
  });

  for (let step = 0; step < 5000; step += 1) {
    const snapshot = await runInTab(tabId, scanVisiblePinsAndScroll, [board]);
    const visiblePins = Array.isArray(snapshot?.pins) ? snapshot.pins : [];
    const newPins = [];

    for (const pin of visiblePins) {
      const pinId = String(pin?.pinId || "");
      if (!/^\d+$/.test(pinId) || seenPinIds.has(pinId)) continue;
      seenPinIds.add(pinId);
      collectedPins.push(pin);
      newPins.push(pin);
    }

    if (newPins.length > 0) {
      confirmationMode = false;
      bottomConfirmations = 0;
      logToBridge("Discovered pins during scroll", {
        slug: board.slug,
        url: board.url,
        step,
        batchPins: newPins.length,
        totalTargetPins: collectedPins.length,
        beforeHeight: snapshot?.beforeHeight ?? null,
        afterHeight: snapshot?.afterHeight ?? null,
      });
      sendSocketMessage({
        type: "commandProgress",
        requestId,
        payload: {
          board,
          pins: newPins,
          totalBoardPins: collectedPins.length,
          step,
        },
      });
    }

    if (snapshot?.heightIncreased) {
      stableSteps = 0;
      confirmationMode = false;
      bottomConfirmations = 0;
      logToBridge("Scrolled lower", {
        slug: board.slug,
        url: board.url,
        step,
        beforeHeight: snapshot?.beforeHeight ?? null,
        afterHeight: snapshot?.afterHeight ?? null,
        visiblePins: visiblePins.length,
      });
      continue;
    }

    stableSteps += 1;
    logToBridge("Height stalled", {
      slug: board.slug,
      url: board.url,
      step,
      stableSteps,
      visiblePins: visiblePins.length,
      beforeHeight: snapshot?.beforeHeight ?? null,
      afterHeight: snapshot?.afterHeight ?? null,
    });
    if (stableSteps < 3) {
      continue;
    }

    confirmationMode = true;
    logToBridge("Bottom candidate reached, waiting before retry", {
      slug: board.slug,
      url: board.url,
      step,
      bottomConfirmations,
      waitMs: bottomRetryWaitMs,
    });
    await delay(bottomRetryWaitMs);

    const retrySnapshot = await runInTab(tabId, scanVisiblePinsAndScroll, [board, true]);
    const retryPins = Array.isArray(retrySnapshot?.pins) ? retrySnapshot.pins : [];
    const retryNewPins = [];

    for (const pin of retryPins) {
      const pinId = String(pin?.pinId || "");
      if (!/^\d+$/.test(pinId) || seenPinIds.has(pinId)) continue;
      seenPinIds.add(pinId);
      collectedPins.push(pin);
      retryNewPins.push(pin);
    }

    if (retryNewPins.length > 0) {
      confirmationMode = false;
      bottomConfirmations = 0;
      logToBridge("Discovered pins during bottom retry", {
        slug: board.slug,
        url: board.url,
        step,
        batchPins: retryNewPins.length,
        totalTargetPins: collectedPins.length,
        beforeHeight: retrySnapshot?.beforeHeight ?? null,
        afterHeight: retrySnapshot?.afterHeight ?? null,
      });
      sendSocketMessage({
        type: "commandProgress",
        requestId,
        payload: {
          board,
          pins: retryNewPins,
          totalBoardPins: collectedPins.length,
          step,
        },
      });
    }

    if (retrySnapshot?.heightIncreased) {
      stableSteps = 0;
      confirmationMode = false;
      bottomConfirmations = 0;
      logToBridge("Bottom retry found more page", {
        slug: board.slug,
        url: board.url,
        step,
        beforeHeight: retrySnapshot?.beforeHeight ?? null,
        afterHeight: retrySnapshot?.afterHeight ?? null,
      });
      continue;
    }

    if (confirmationMode) {
      bottomConfirmations += 1;
      logToBridge("Bottom confirmation failed", {
        slug: board.slug,
        url: board.url,
        step,
        bottomConfirmations,
        remainingConfirmations: maxBottomConfirmations - bottomConfirmations,
      });
    }

    if (bottomConfirmations >= maxBottomConfirmations) {
      logToBridge("Stopping target after bottom confirmations", {
        slug: board.slug,
        url: board.url,
        totalTargetPins: collectedPins.length,
        maxBottomConfirmations,
      });
      break;
    }
  }

  return collectedPins;
}

async function syncBoard(pins, requestId) {
  const pinList = _.uniqBy(
    (Array.isArray(pins) ? pins : []).filter((pin) => /^\d+$/.test(String(pin?.pinId || ""))),
    (pin) => String(pin.pinId)
  );

  if (pinList.length === 0) {
    return { syncedPins: 0, skippedPins: 0, target: "profile" };
  }

  let tabId = await getOrCreateRoutineTab();
  let syncedPins = 0;
  let skippedPins = 0;
  activeSyncState = {
    requestId,
    tabId,
    currentPinId: null,
    currentPinUrl: null,
    pinAttempts: 0,
    completedPins: 0,
    kickRequested: false,
  };

  for (const pin of pinList) {
    const pinUrl = normalizePinterestUrl(pin.pinUrl || `https://www.pinterest.com/pin/${pin.pinId}/`);
    activeSyncState.tabId = tabId;
    activeSyncState.currentPinId = pin.pinId;
    activeSyncState.currentPinUrl = pinUrl;
    activeSyncState.pinAttempts = 0;

    sendSocketMessage({
      type: "commandProgress",
      requestId,
      payload: {
        kind: "syncHeartbeat",
        phase: "pinStart",
        pinId: pin.pinId,
        pinUrl,
        completedPins: activeSyncState.completedPins,
        totalPins: pinList.length,
      },
    });

    const syncOutcome = await syncSinglePinWithReload(tabId, pin, pinUrl, requestId);
    tabId = syncOutcome.tabId;
    const result = syncOutcome.result;

    sendSocketMessage({
      type: "commandProgress",
      requestId,
      payload: {
        kind: "sync",
        pinId: pin.pinId,
        pinUrl,
        saved: Boolean(result?.saved),
        newlyPinned: Boolean(result?.newlyPinned),
        alreadyPinned: Boolean(result?.alreadyPinned),
        reason: result?.reason || null,
      },
    });

    if (result?.newlyPinned) {
      syncedPins += 1;
    } else {
      skippedPins += 1;
    }

    activeSyncState.completedPins += 1;
    activeSyncState.kickRequested = false;

    await delay(1250);
  }

  activeSyncState = null;

  return {
    syncedPins,
    skippedPins,
    target: "profile",
  };
}

async function syncSinglePinWithReload(initialTabId, pin, pinUrl, requestId) {
  const maxAttempts = 5;
  let lastResult = { saved: false, reason: "Pin page failed to load" };
  let tabId = initialTabId;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (activeSyncState) {
      activeSyncState.tabId = tabId;
      activeSyncState.pinAttempts = attempt;
    }

    logToBridge("Sync loading pin", {
      pinId: pin.pinId,
      pinUrl,
      attempt,
      maxAttempts,
      tabId,
    });

    sendSocketMessage({
      type: "commandProgress",
      requestId,
      payload: {
        kind: "syncHeartbeat",
        phase: "pinAttempt",
        pinId: pin.pinId,
        pinUrl,
        attempt,
        maxAttempts,
      },
    });

    try {
      if (activeSyncState?.kickRequested && attempt > 1) {
        logToBridge("Applying requested sync kick", {
          pinId: pin.pinId,
          pinUrl,
          attempt,
        });
        tabId = await recreateRoutineTab(tabId, pinUrl);
        if (activeSyncState) {
          activeSyncState.tabId = tabId;
          activeSyncState.kickRequested = false;
        }
      } else {
        await navigateTo(tabId, pinUrl);
      }

      const pageState = await runInTab(tabId, inspectPinPageState, []);

      if (!pageState?.loaded) {
        lastResult = {
          saved: false,
          reason: pageState?.reason || "Pin page not ready",
        };

        logToBridge("Sync pin page not ready, retrying", {
          pinId: pin.pinId,
          pinUrl,
          attempt,
          reason: lastResult.reason,
        });
        if (attempt === 1 || attempt === 3) {
          await reloadRoutineTab(tabId);
        } else if (attempt >= 4) {
          tabId = await recreateRoutineTab(tabId, pinUrl);
          if (activeSyncState) {
            activeSyncState.tabId = tabId;
          }
        }
        await delay(1500);
        continue;
      }

      const result = await runInTab(tabId, quickSaveCurrentPin, []);
      lastResult = result || { saved: false, reason: "Unknown save failure" };

      if (lastResult?.saved) {
        return { result: lastResult, tabId };
      }

      if (!shouldRetrySyncResult(lastResult)) {
        return { result: lastResult, tabId };
      }

      logToBridge("Sync save attempt failed, retrying", {
        pinId: pin.pinId,
        pinUrl,
        attempt,
        reason: lastResult?.reason || null,
      });
      if (attempt === 2) {
        await reloadRoutineTab(tabId);
      } else if (attempt >= 4) {
        tabId = await recreateRoutineTab(tabId, pinUrl);
        if (activeSyncState) {
          activeSyncState.tabId = tabId;
        }
      }
      await delay(1500);
    } catch (error) {
      lastResult = {
        saved: false,
        reason: error instanceof Error ? error.message : String(error),
      };

      logToBridge("Sync pin attempt threw, retrying", {
        pinId: pin.pinId,
        pinUrl,
        attempt,
        reason: lastResult.reason,
      });
      if (attempt === 1 || attempt === 2) {
        try {
          await reloadRoutineTab(tabId);
        } catch {}
      } else {
        tabId = await recreateRoutineTab(tabId, pinUrl);
        if (activeSyncState) {
          activeSyncState.tabId = tabId;
        }
      }
      await delay(1500);
    }
  }

  return { result: lastResult, tabId };
}

function shouldRetrySyncResult(result) {
  const reason = String(result?.reason || "").toLowerCase();
  if (!reason) return false;

  return (
    reason.includes("not ready") ||
    reason.includes("failed to load") ||
    reason.includes("empty") ||
    reason.includes("wrapper") ||
    reason.includes("save ui") ||
    reason.includes("quick save")
  );
}

function captureRenderedPage(options = {}) {
  const delayMs = Number(options.delayMs || 1200);
  const maxScrollSteps = Number(options.maxScrollSteps || 60);
  const scroll = Boolean(options.scroll);

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  return (async () => {
    if (scroll) {
      let stableSteps = 0;
      let previousHeight = 0;

      for (let step = 0; step < maxScrollSteps; step += 1) {
        window.scrollTo(0, document.body.scrollHeight);
        await sleep(delayMs);
        const height = document.body.scrollHeight;
        if (height === previousHeight) {
          stableSteps += 1;
          if (stableSteps >= 3) break;
        } else {
          stableSteps = 0;
          previousHeight = height;
        }
      }

      window.scrollTo(0, 0);
      await sleep(300);
    } else {
      await sleep(delayMs);
    }

    return {
      url: location.href,
      title: document.title,
      html: document.documentElement.outerHTML,
    };
  })();
}

function collectBoardLinksByScrolling(account) {
  const normalizedAccount = String(account || "").trim().replace(/^@/, "").toLowerCase();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const boards = new Map();

  function normalizeUrl(url) {
    try {
      const parsed = new URL(url, location.origin);
      parsed.hash = "";
      parsed.search = "";
      return parsed.toString().replace(/\/+$/, "/");
    } catch {
      return null;
    }
  }

  function collectVisibleBoards() {
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    for (const anchor of anchors) {
      const href = anchor.getAttribute("href") || "";
      const url = normalizeUrl(href);
      if (!url) continue;

      const parsed = new URL(url);
      const parts = parsed.pathname.split("/").filter(Boolean);
      if (parts.length < 2) continue;
      if (parts[0].toLowerCase() !== normalizedAccount) continue;
      if (
        ["pin", "boards", "_created", "_saved", "_profile", "_tools", "_shop"].includes(
          parts[1].toLowerCase()
        )
      ) {
        continue;
      }

      const title =
        anchor.textContent?.replace(/\s+/g, " ").trim() ||
        anchor.getAttribute("aria-label") ||
        parts[1];

      boards.set(url, {
        title,
        url,
        slug: parts[1],
      });
    }
  }

  return (async () => {
    let stableSteps = 0;
    let previousHeight = 0;

    for (let step = 0; step < 60; step += 1) {
      collectVisibleBoards();
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(1200);

      const currentHeight = document.body.scrollHeight;
      if (currentHeight === previousHeight) {
        stableSteps += 1;
        if (stableSteps >= 3) {
          await sleep(3000);
          let recovered = false;

          for (let retry = 0; retry < 3; retry += 1) {
            window.scrollTo(0, document.body.scrollHeight);
            await sleep(1800);
            collectVisibleBoards();

            const retriedHeight = document.body.scrollHeight;
            if (retriedHeight > currentHeight) {
              previousHeight = retriedHeight;
              stableSteps = 0;
              recovered = true;
              break;
            }
          }

          if (!recovered) {
            break;
          }
        }
      } else {
        previousHeight = currentHeight;
        stableSteps = 0;
      }
    }

    collectVisibleBoards();
    window.scrollTo(0, 0);
    return Array.from(boards.values());
  })();
}

function collectPinsByScrolling(board) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const pins = new Map();

  function normalizeUrl(url) {
    try {
      const parsed = new URL(url, location.origin);
      parsed.hash = "";
      parsed.search = "";
      return parsed.toString().replace(/\/+$/, "/");
    } catch {
      return null;
    }
  }

  function collectVisiblePins() {
    const anchors = Array.from(document.querySelectorAll('a[href*="/pin/"]'));
    for (const anchor of anchors) {
      const href = anchor.getAttribute("href") || "";
      const match = href.match(/\/pin\/(\d+)/);
      if (!match) continue;

      const pinId = match[1];
      const image = anchor.querySelector("img");
      const pinUrl = normalizeUrl(`https://www.pinterest.com/pin/${pinId}/`);
      pins.set(pinId, {
        pinId,
        pinUrl,
        title:
          image?.getAttribute("alt") ||
          anchor.getAttribute("aria-label") ||
          anchor.textContent?.replace(/\s+/g, " ").trim() ||
          null,
        imageUrl: image?.getAttribute("src") || image?.getAttribute("srcset")?.split(",").pop()?.trim().split(" ")[0] || null,
        board,
        scrapedFrom: location.href,
      });
    }
  }

  return (async () => {
    let stableSteps = 0;
    let previousHeight = 0;

    for (let step = 0; step < 120; step += 1) {
      collectVisiblePins();
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(1200);

      const currentHeight = document.body.scrollHeight;
      if (currentHeight === previousHeight) {
        stableSteps += 1;
        if (stableSteps >= 3) {
          await sleep(3000);
          let recovered = false;

          for (let retry = 0; retry < 4; retry += 1) {
            window.scrollTo(0, document.body.scrollHeight);
            await sleep(2000);
            collectVisiblePins();

            const retriedHeight = document.body.scrollHeight;
            if (retriedHeight > currentHeight) {
              previousHeight = retriedHeight;
              stableSteps = 0;
              recovered = true;
              break;
            }
          }

          if (!recovered) {
            break;
          }
        }
      } else {
        previousHeight = currentHeight;
        stableSteps = 0;
      }
    }

    collectVisiblePins();
    return Array.from(pins.values());
  })();
}

function scanVisiblePinsAndScroll(board, slowRetry = false) {
  const delayMs = slowRetry ? 2000 : 1200;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function normalizeUrl(url) {
    try {
      const parsed = new URL(url, location.origin);
      parsed.hash = "";
      parsed.search = "";
      return parsed.toString().replace(/\/+$/, "/");
    } catch {
      return null;
    }
  }

  function collectVisiblePins() {
    const pins = [];
    const anchors = Array.from(document.querySelectorAll('a[href*="/pin/"]'));
    for (const anchor of anchors) {
      const href = anchor.getAttribute("href") || "";
      const match = href.match(/\/pin\/(\d+)/);
      if (!match) continue;

      const pinId = match[1];
      const image = anchor.querySelector("img");
      pins.push({
        pinId,
        pinUrl: normalizeUrl(`https://www.pinterest.com/pin/${pinId}/`),
        title:
          image?.getAttribute("alt") ||
          anchor.getAttribute("aria-label") ||
          anchor.textContent?.replace(/\s+/g, " ").trim() ||
          null,
        imageUrl:
          image?.getAttribute("src") ||
          image?.getAttribute("srcset")?.split(",").pop()?.trim().split(" ")[0] ||
          null,
        board,
        scrapedFrom: location.href,
      });
    }

    return pins;
  }

  return (async () => {
    const beforeHeight = document.body.scrollHeight;
    const pins = collectVisiblePins();
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(delayMs);
    const afterHeight = document.body.scrollHeight;

    return {
      pins,
      beforeHeight,
      afterHeight,
      heightIncreased: afterHeight > beforeHeight,
    };
  })();
}

function quickSaveCurrentPin() {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function normalize(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function visibleNodes(selectors) {
    return Array.from(document.querySelectorAll(selectors)).filter((node) => {
      const text = normalize(node.textContent || node.getAttribute("aria-label") || "");
      if (!text) return false;
      const style = window.getComputedStyle(node);
      return style.display !== "none" && style.visibility !== "hidden";
    });
  }

  function findClickableByText(text, selectors = 'button, [role="button"], div[tabindex="0"]') {
    const wanted = normalize(text);
    return visibleNodes(selectors).find((node) => {
      const haystack = normalize(node.textContent || node.getAttribute("aria-label") || "");
      return haystack === wanted || haystack.includes(wanted);
    });
  }

  function click(node) {
    if (!node) return false;
    node.scrollIntoView({ block: "center" });
    node.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    node.click();
    node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    return true;
  }

  return (async () => {
    await sleep(1200);

    const quickSaveButtons = visibleNodes('button, [role="button"], div[tabindex="0"]');
    const saveStateButton = quickSaveButtons.find((node) => {
      const text = normalize(node.textContent || node.getAttribute("aria-label") || "");
      return (
        text === "save" ||
        text.includes("quick save") ||
        text === "saved" ||
        text.includes("saved to profile") ||
        text.includes("saved")
      );
    });

    if (!saveStateButton) {
      return { saved: false, reason: "Quick save button not found" };
    }

    const currentStateText = normalize(
      saveStateButton.textContent || saveStateButton.getAttribute("aria-label") || ""
    );
    if (currentStateText.includes("saved")) {
      return {
        saved: true,
        alreadyPinned: true,
        newlyPinned: false,
      };
    }

    click(saveStateButton);
    await sleep(1200);
    return {
      saved: true,
      alreadyPinned: false,
      newlyPinned: true,
    };
  })();
}

function inspectPinPageState() {
  function visible(node) {
    if (!node) return false;
    const style = window.getComputedStyle(node);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  const pinLinks = Array.from(document.querySelectorAll('a[href*="/pin/"]'));
  const pinImages = Array.from(document.querySelectorAll('img[src*="pinimg.com"], img[srcset*="pinimg.com"]'));
  const saveButtons = Array.from(
    document.querySelectorAll('button, [role="button"], div[tabindex="0"]')
  ).filter((node) => {
    if (!visible(node)) return false;
    const text = String(node.textContent || node.getAttribute("aria-label") || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    return text.includes("save");
  });

  if (saveButtons.length > 0 || pinImages.length > 0) {
    return {
      loaded: true,
      saveButtons: saveButtons.length,
      pinImages: pinImages.length,
      pinLinks: pinLinks.length,
    };
  }

  const wrapper = document.querySelector("#__PWS_ROOT__, [data-test-id=\"closeup-content\"], [data-test-id=\"pin-closeup-test-id\"]");
  if (wrapper && wrapper.textContent?.trim() === "" && wrapper.children.length === 0) {
    return {
      loaded: false,
      reason: "Pin wrapper is empty",
    };
  }

  const bodyText = document.body?.textContent?.replace(/\s+/g, " ").trim() || "";
  if (!bodyText && pinLinks.length === 0) {
    return {
      loaded: false,
      reason: "Pin page body is empty",
    };
  }

  return {
    loaded: false,
    reason: "Pin page not ready",
  };
}

connectSocket();
