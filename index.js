import mime from "mime";
import config from "./config.js";

/**
 * Cloudflare Workers Entry Point for Interstellar
 *
 * NODE.JS DEPENDENCY & RUNTIME COMPATIBILITY NOTES:
 * - Removed long-running HTTP listeners (`http.createServer()`, `server.listen()`, `server.on('upgrade')`, Express `app.listen()`).
 * - Removed Node.js `fs` calls and `express.static()`. Static assets are served via Cloudflare Workers Static Assets (`env.ASSETS`).
 * - Removed `node-fetch` in favor of native global Web `fetch()`.
 * - Flagged server-specific transport modules: `@nebula-services/bare-server-node` and `@mercuryworkshop/wisp-js/server`
 *   rely on raw Node.js HTTP server sockets (`http.IncomingMessage`, `net.Socket`) and cannot run directly in edge V8 environments.
 *   For Bare/Wisp proxy functionality on Cloudflare Workers, use edge-compatible WebSockets/Fetch API or delegate to an external Bare server.
 * - Compatibility flag included in wrangler.toml: `compatibility_flags = ["nodejs_compat"]`.
 */

// In-memory asset cache (per Worker instance)
const cache = new Map();
const CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

// Route mappings for static HTML pages
const ROUTE_MAP = new Map([
  ["/b", "/apps.html"],
  ["/a", "/games.html"],
  ["/play.html", "/games.html"],
  ["/c", "/settings.html"],
  ["/d", "/tabs.html"],
  ["/", "/index.html"],
]);

/**
 * Get file extension from pathname or URL string
 */
function getExtname(filename) {
  const dotIndex = filename.lastIndexOf(".");
  return dotIndex < 0 ? "" : filename.slice(dotIndex);
}

/**
 * Verify Basic Auth credentials against config.users
 */
function checkBasicAuth(request) {
  if (config.challenge === false) return true;

  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Basic ")) return false;

  try {
    const base64Credentials = authHeader.split(" ")[1];
    const credentials = atob(base64Credentials);
    const [username, password] = credentials.split(":");

    return config.users && config.users[username] === password;
  } catch (_err) {
    return false;
  }
}

export default {
  /**
   * Main Cloudflare Worker Fetch Handler
   * @param {Request} request
   * @param {Object} env
   * @param {ExecutionContext} _ctx
   * @returns {Promise<Response>}
   */
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // 1. Password Protection Check
    if (!checkBasicAuth(request)) {
      return new Response("Unauthorized", {
        status: 401,
        headers: {
          "WWW-Authenticate": 'Basic realm="Interstellar Password Protection"',
          "Content-Type": "text/plain",
        },
      });
    }

    // 2. Asset Proxy Handling (`/e/*`)
    if (pathname.startsWith("/e/")) {
      return handleAssetProxy(pathname, request);
    }

    // 3. Static Page Route Rewriting (`/a`, `/b`, `/c`, `/d`, `/play.html`, `/`)
    const targetPath = ROUTE_MAP.get(pathname) || pathname;

    // 4. Serve Static Assets via env.ASSETS
    if (env.ASSETS) {
      const assetUrl = new URL(targetPath, request.url);
      const assetRequest = new Request(assetUrl.toString(), request);
      const response = await env.ASSETS.fetch(assetRequest);

      if (response.status === 404) {
        // Fallback to 404.html
        const notFoundUrl = new URL("/404.html", request.url);
        const notFoundResponse = await env.ASSETS.fetch(new Request(notFoundUrl.toString(), request));
        return new Response(notFoundResponse.body, {
          status: 404,
          headers: notFoundResponse.headers,
        });
      }

      return response;
    }

    return new Response("Static asset handling requires env.ASSETS binding in wrangler.toml", {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });
  },
};

/**
 * Handle proxying and caching assets under `/e/*`
 */
async function handleAssetProxy(pathname, _request) {
  const baseUrls = {
    "/e/1/": "https://raw.githubusercontent.com/qrs/x/fixy/",
    "/e/2/": "https://raw.githubusercontent.com/3v1/V5-Assets/main/",
    "/e/3/": "https://raw.githubusercontent.com/3v1/V5-Retro/master/",
  };

  let reqTarget;
  for (const [prefix, baseUrl] of Object.entries(baseUrls)) {
    if (pathname.startsWith(prefix)) {
      reqTarget = baseUrl + pathname.slice(prefix.length);
      break;
    }
  }

  if (!reqTarget) {
    return new Response("Not Found", { status: 404 });
  }

  // Check in-memory cache
  if (cache.has(pathname)) {
    const { data, contentType, timestamp } = cache.get(pathname);
    if (Date.now() - timestamp <= CACHE_TTL) {
      return new Response(data, {
        status: 200,
        headers: { "Content-Type": contentType },
      });
    }
    cache.delete(pathname);
  }

  try {
    const assetResponse = await fetch(reqTarget);
    if (!assetResponse.ok) {
      return new Response("Asset Not Found", { status: 404 });
    }

    const arrayBuffer = await assetResponse.arrayBuffer();
    const ext = getExtname(reqTarget);
    const no = [".unityweb"];
    const contentType = no.includes(ext) ? "application/octet-stream" : mime.getType(ext) || "application/octet-stream";

    cache.set(pathname, {
      data: arrayBuffer,
      contentType,
      timestamp: Date.now(),
    });

    return new Response(arrayBuffer, {
      status: 200,
      headers: { "Content-Type": contentType },
    });
  } catch (error) {
    console.error("Error fetching proxy asset:", error);
    return new Response("Error fetching the asset", {
      status: 500,
      headers: { "Content-Type": "text/html" },
    });
  }
}
