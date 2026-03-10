import http from "node:http";

const targetUrl = String(process.argv[2] || "").trim();

if (!targetUrl) {
  console.error("Usage: npm run scrape <url>");
  process.exit(1);
}

const RETRY_DELAYS_MS = [1000, 2000, 5000];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function postJson(pathname, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      {
        host: "127.0.0.1",
        port: 18374,
        path: pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            resolve({
              statusCode: res.statusCode || 0,
              body: data ? JSON.parse(data) : {},
            });
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function postScrapeRequest() {
  let lastError = null;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await postJson("/scrape", { url: targetUrl });
    } catch (error) {
      lastError = error;
      if (attempt === RETRY_DELAYS_MS.length) {
        break;
      }
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }

  throw lastError;
}

try {
  const res = await postScrapeRequest();
  const data = res.body;
  if (res.statusCode < 200 || res.statusCode >= 300 || !data.ok) {
    throw new Error(data?.error || `Request failed with status ${res.statusCode}`);
  }

  console.log(`Scraped ${data.url}`);
  console.log(`Boards: ${Array.isArray(data.boards) ? data.boards.length : 0}`);
  console.log(`Pins saved to ./json: ${data.savedPins}`);
} catch (error) {
  const details = error instanceof Error ? error.message : String(error);
  console.error(`Failed to scrape '${targetUrl}':`, details);
  console.error("Is `npm run server` running, and is the extension loaded/connected?");
  process.exit(1);
}
