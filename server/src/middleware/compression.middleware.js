import compression from 'compression';

// Global gzip compression. `threshold: 1024` skips compressing tiny
// responses (below ~1KB the gzip framing overhead isn't worth the CPU).
//
// PDF downloads (Phase 9 reports, `/api/reports/test/:id/pdf`) are
// explicitly excluded via `filter`: PDF is already a compressed binary
// format, pdfkit's output doesn't shrink meaningfully under gzip, and
// re-encoding it costs CPU on every single request for no real payload
// win. Everything else falls through to compression's own default
// filter (which already respects `Cache-Control: no-transform` and
// content-type sniffing).
export const compressionMiddleware = compression({
  threshold: 1024,
  filter: (req, res) => {
    if (req.path.endsWith('/pdf')) return false;
    return compression.filter(req, res);
  },
});
