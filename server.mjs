import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { searchWeb } from "./web-search.mjs";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = resolve(ROOT, "public");
const KNOWLEDGE_PATH = resolve(ROOT, "data", "knowledge.json");
const MODEL = "gemini-3.1-flash-live-preview";

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "connect-src 'self' wss://generativelanguage.googleapis.com https://generativelanguage.googleapis.com",
    "img-src 'self' data:",
    "media-src 'self' blob:",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self' blob:",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
  "Cross-Origin-Opener-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

export function parseEnv(source) {
  const values = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function loadLocalEnv() {
  const localValues = {};
  for (const name of [".env", ".env.local"]) {
    const path = resolve(ROOT, name);
    if (!existsSync(path)) continue;
    Object.assign(localValues, parseEnv(readFileSync(path, "utf8")));
  }
  for (const [key, value] of Object.entries(localValues)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function createTokenPayload(now = Date.now()) {
  return {
    uses: 1,
    expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
    newSessionExpireTime: new Date(now + 60 * 1000).toISOString(),
  };
}

export function resolvePublicFile(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0]);
  } catch {
    return null;
  }

  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const candidate = resolve(PUBLIC_DIR, relative);
  if (candidate !== PUBLIC_DIR && !candidate.startsWith(`${PUBLIC_DIR}${sep}`)) return null;
  return candidate;
}

export function searchKnowledge(query, records, limit = 3) {
  const tokens = String(query)
    .toLocaleLowerCase("ru")
    .match(/[\p{L}\p{N}]+/gu)
    ?.filter((token) => token.length >= 3) ?? [];

  return records
    .map((record) => {
      const title = String(record.title ?? "").toLocaleLowerCase("ru");
      const keywords = (record.keywords ?? []).join(" ").toLocaleLowerCase("ru");
      const content = String(record.content ?? "").toLocaleLowerCase("ru");
      const score = tokens.reduce(
        (total, token) =>
          total +
          (title.includes(token) ? 4 : 0) +
          (keywords.includes(token) ? 3 : 0) +
          (content.includes(token) ? 1 : 0),
        0,
      );
      return { record, score };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ record }) => ({
      id: record.id,
      title: record.title,
      content: record.content,
    }));
}

const rateLimits = new Map();

function isRateLimited(address, now = Date.now()) {
  const windowMs = 60_000;
  const maxRequests = 30;
  const current = rateLimits.get(address);

  if (!current || now - current.startedAt >= windowMs) {
    rateLimits.set(address, { startedAt: now, count: 1 });
    return false;
  }

  current.count += 1;
  return current.count > maxRequests;
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

async function provisionToken(response) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    sendJson(response, 503, {
      error: "Добавьте новый GEMINI_API_KEY в файл .env.local и перезапустите сервер.",
      code: "MISSING_API_KEY",
    });
    return;
  }

  try {
    const upstream = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/auth_tokens",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(createTokenPayload()),
        signal: AbortSignal.timeout(12_000),
      },
    );

    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok || !payload.name) {
      console.error(
        "Gemini token provisioning failed",
        upstream.status,
        payload?.error?.status ?? "unknown",
        payload?.error?.message ?? "No upstream message",
      );
      sendJson(response, 502, {
        error: "Не удалось создать безопасную голосовую сессию. Проверьте API-ключ и квоту.",
        code: "TOKEN_PROVISION_FAILED",
      });
      return;
    }

    sendJson(response, 200, {
      token: payload.name,
      model: MODEL,
      expiresAt: payload.expireTime,
    });
  } catch (error) {
    console.error("Gemini token provisioning error", error?.name ?? "Error");
    sendJson(response, 502, {
      error: "Gemini сейчас недоступен. Проверьте соединение и попробуйте ещё раз.",
      code: "TOKEN_PROVISION_UNAVAILABLE",
    });
  }
}

export function createRequestHandler() {
  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (url.pathname.startsWith("/api/") && request.headers["sec-fetch-site"] === "cross-site") {
      sendJson(response, 403, { error: "Откройте приложение на локальном адресе." });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/search") {
      const query = url.searchParams.get("query")?.trim() ?? "";
      if (!query || query.length > 300) {
        sendJson(response, 400, { error: "Укажите поисковый запрос до 300 символов." });
        return;
      }
      if (isRateLimited(request.socket.remoteAddress ?? "unknown")) {
        sendJson(response, 429, { available: false, error: "Слишком много запросов. Попробуйте через минуту." });
        return;
      }
      sendJson(response, 200, await searchWeb(query, { apiKey: process.env.GEMINI_API_KEY?.trim() }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, {
        ok: true,
        model: MODEL,
        configured: Boolean(process.env.GEMINI_API_KEY?.trim()),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/knowledge") {
      const query = url.searchParams.get("query")?.trim() ?? "";
      if (!query || query.length > 200) {
        sendJson(response, 400, { error: "Укажите короткий поисковый запрос." });
        return;
      }
      try {
        const records = JSON.parse(readFileSync(KNOWLEDGE_PATH, "utf8"));
        sendJson(response, 200, { results: searchKnowledge(query, records) });
      } catch {
        sendJson(response, 500, { error: "База знаний временно недоступна." });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/token") {
      const address = request.socket.remoteAddress ?? "unknown";
      if (isRateLimited(address)) {
        sendJson(response, 429, {
          error: "Слишком много попыток подключения. Подождите минуту.",
          code: "RATE_LIMITED",
        });
        return;
      }
      await provisionToken(response);
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { error: "Метод не поддерживается." });
      return;
    }

    const filePath = resolvePublicFile(url.pathname);
    if (!filePath || !existsSync(filePath)) {
      sendJson(response, 404, { error: "Страница не найдена." });
      return;
    }

    try {
      const body = readFileSync(filePath);
      response.writeHead(200, {
        ...SECURITY_HEADERS,
        "Cache-Control": "no-cache",
        "Content-Type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
      });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch {
      sendJson(response, 500, { error: "Не удалось загрузить страницу." });
    }
  };
}

export function startServer({ port = Number(process.env.PORT) || 43829 } = {}) {
  const server = createServer(createRequestHandler());
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    const activePort = typeof address === "object" && address ? address.port : port;
    console.log(`Маняша готова: http://localhost:${activePort}`);
    if (!process.env.GEMINI_API_KEY?.trim()) {
      console.log("Добавьте новый GEMINI_API_KEY в .env.local для голосового подключения.");
    }
  });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  loadLocalEnv();
  startServer();
}
