/**
 * _meta.js: the Atlas Systems /_meta convention. VENDORED COPY.
 * Source of truth: atlas-api-index/shared/_meta.js. Copies carry this
 * pointer back; do not edit here, edit there and re-vendor.
 *
 * Contract (fixed estate-wide):
 *
 *   GET <route-prefix>/_meta  ->  200 application/json
 *   {
 *     "name":        "worker-name",
 *     "description": "one sentence",
 *     "version":     "1.0.0",
 *     "endpoints":   [{ "method": "GET", "path": "/x", "description": "..." }],
 *     "status":      "live",
 *     "source":      "https://github.com/AtlasReaper311/<repo>"
 *   }
 */

export function handleMeta(url, meta) {
  const path = url.pathname;
  if (path !== "/_meta" && !path.endsWith("/_meta")) return null;
  return Response.json(
    { status: "live", ...meta },
    {
      headers: {
        "cache-control": "public, max-age=60",
        "access-control-allow-origin": "*",
      },
    },
  );
}
