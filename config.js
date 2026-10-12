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

window.NOTICE_BOARD_API_BASE = "https://notice-board-api.apps-bef.workers.dev/api";

// Public half of the VAPID key pair used for push notifications — safe to
// be public (the matching private key lives only as a Cloudflare secret).
// See README.md, "Push notifications", if you ever regenerate these.
window.NOTICE_BOARD_VAPID_PUBLIC_KEY = "BI0-hdshU8l3Mj1v1mCgt3jO9R-j408aL71qXXECEOiLD4y9dvGwauccTQP_-eQyCvT4GhbpiPkbthwGvNw3_mo";
