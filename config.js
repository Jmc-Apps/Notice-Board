// Where the app looks for its API. Leave this empty to call the API on
// the *same site* it's hosted from (the default — this is what you want
// when deploying via Cloudflare Pages, as in the main README instructions).
//
// If you're hosting this app's files somewhere else (e.g. GitHub Pages)
// that can't run the API itself, deploy the standalone Worker in
// ../worker/ first (see README.md, "Hosting the frontend elsewhere"),
// then paste its URL here, keeping the /api on the end. It'll look
// something like:
//
//   window.NOTICE_BOARD_API_BASE = "https://notice-board-api.YOUR-SUBDOMAIN.workers.dev/api";

window.NOTICE_BOARD_API_BASE = "";
