const DEFAULT_ORIGIN = "https://japan-shopping.0902.one";
const ALLOWED_ORIGINS = new Set([
  DEFAULT_ORIGIN,
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  "http://127.0.0.1:8787",
  "http://localhost:8787",
]);
const MAX_PAYLOAD_BYTES = 900_000;

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  const allowOrigin = ALLOWED_ORIGINS.has(origin) ? origin : DEFAULT_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(request, data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(request),
      ...(init.headers || {}),
    },
  });
}

function text(request, message, status = 400) {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      ...corsHeaders(request),
    },
  });
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function parseSpaceId(url) {
  const match = url.pathname.match(/^\/v1\/spaces\/([a-f0-9]{64})$/);
  return match ? match[1] : "";
}

async function getAuthContext(request, env, spaceId) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    return { response: text(request, "Missing sync authorization", 401) };
  }

  const authHash = await sha256Hex(`worker-token:${token}`);
  const row = await env.DB.prepare(
    "SELECT auth_hash, payload, updated_at FROM sync_docs WHERE space_id = ?",
  )
    .bind(spaceId)
    .first();

  if (row && row.auth_hash !== authHash) {
    return {
      response: text(request, "Sync code does not match this space", 403),
    };
  }

  return { authHash, row };
}

function sanitizeSnapshot(input) {
  return {
    version: 1,
    records: Array.isArray(input.records) ? input.records.slice(0, 5000) : [],
    trip: input.trip && input.trip.id ? input.trip : null,
    deletedIds: Array.isArray(input.deletedIds)
      ? input.deletedIds.filter((id) => typeof id === "string").slice(0, 10000)
      : [],
    updatedAt: new Date().toISOString(),
  };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const url = new URL(request.url);
    const spaceId = parseSpaceId(url);
    if (!spaceId) return text(request, "Not found", 404);

    const auth = await getAuthContext(request, env, spaceId);
    if (auth.response) return auth.response;

    if (request.method === "GET") {
      if (!auth.row) {
        return json(request, {
          version: 1,
          records: [],
          trip: null,
          deletedIds: [],
          updatedAt: null,
        });
      }

      const payload = JSON.parse(auth.row.payload || "{}");
      return json(request, {
        ...sanitizeSnapshot(payload),
        updatedAt: auth.row.updated_at,
      });
    }

    if (request.method === "PUT") {
      const length = Number(request.headers.get("Content-Length") || 0);
      if (length > MAX_PAYLOAD_BYTES) {
        return text(request, "Sync payload is too large", 413);
      }

      const body = await request.text();
      if (body.length > MAX_PAYLOAD_BYTES) {
        return text(request, "Sync payload is too large", 413);
      }

      let parsed;
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        return text(request, "Invalid JSON", 400);
      }

      const payload = sanitizeSnapshot(parsed);
      const storedPayload = JSON.stringify(payload);

      await env.DB.prepare(
        `INSERT INTO sync_docs (space_id, auth_hash, payload, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(space_id) DO UPDATE SET
           payload = excluded.payload,
           updated_at = excluded.updated_at`,
      )
        .bind(spaceId, auth.authHash, storedPayload, payload.updatedAt)
        .run();

      return json(request, payload);
    }

    return text(request, "Method not allowed", 405);
  },
};
