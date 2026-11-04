# Findly Search

A clean search frontend with a Cloudflare Pages Functions backend.

## Deployment

1. Connect this repository to **Cloudflare Pages** using Git integration.
2. Use production branch `main`, leave build command empty, and use repository root `.` as output directory.
3. Pages automatically picks up `functions/api/search.js` and exposes `GET /api/search`.
4. Do **not** deploy with GitHub Pages or dashboard drag-and-drop: neither runs Pages Functions. Use Cloudflare Pages Git integration or Wrangler.

The browser requests only `/api/search` on the same origin; the Function queries upstream public search indices. No CORS proxy URL or public API key is required. Rate limits, upstream outages, and differences in index coverage may still cause searches to fail or return incomplete results. Configure optional officially approved Reddit Data API access with Pages secrets `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, and `REDDIT_USER_AGENT` (a valid unique app user-agent) to additionally query the official OAuth API. Never put secrets in frontend files. Official access must comply with Reddit terms and access policies.

## API

`GET /api/search?q=keyword&period=all&sort=relevance`

- `q`: 1–200 characters
- `period`: `all`, `day`, `week`, `month`, `year`
- `sort`: `relevance`, `recent`, `popular`
- Returns `{ "data": [ ... ] }` or `{ "error": "..." }` with HTTP status.

The UI includes a copy-address action for each search result. All source requests occur server-side; this removes browser CORS errors but cannot circumvent upstream permission requirements.
