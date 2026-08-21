import helmet from 'helmet';

// This backend is API-only: every response is JSON, or a PDF/CSV/JSON file
// download (Phase 9 reports) — it never serves its own HTML or client-side
// script/style/image assets. That means the strictest possible CSP is also
// the *correct* one: there is no in-origin page here that a CSP would ever
// need to carve out exceptions for (no inline scripts, no stylesheets, no
// same-origin images to allow) — `default-src 'none'` costs nothing and
// closes off any scenario where this origin could be tricked into hosting
// or reflecting attacker-controlled content.
//
// `frameAncestors: ["'none'"]` additionally blocks this API from ever being
// framed by another site (defense in depth alongside the default
// `X-Frame-Options: SAMEORIGIN` helmet() already sets).
export const helmetConfig = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  // Deliberate loosening, not an oversight: helmet's default
  // Cross-Origin-Resource-Policy is `same-origin`, which would let the
  // browser BLOCK the Netlify-hosted frontend from actually loading the
  // PDF/CSV/JSON file downloads this API returns (Phase 9 reports),
  // since those are fetched cross-origin from the API's own domain.
  // `cross-origin` permits exactly that cross-origin fetch/download while
  // every other Helmet default (X-Content-Type-Options: nosniff,
  // Strict-Transport-Security, X-Frame-Options, X-DNS-Prefetch-Control,
  // etc.) stays fully enabled below.
  crossOriginResourcePolicy: { policy: 'cross-origin' },
});
