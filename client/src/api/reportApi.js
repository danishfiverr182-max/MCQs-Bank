import apiClient, { handleApiError } from '@/lib/axios';

// reportApi.js — Prompt 100.
//
// The three test-export endpoints (/reports/test/:id/json|csv|pdf) are
// raw file downloads (Content-Disposition: attachment) — those are
// wired directly as <a href="/api/reports/test/:id/..."> links in
// GeneratedTest.jsx, not fetched through this file, since auth here is
// cookie-based (verifyJWT checks req.cookies.accessToken first — see
// auth.middleware.js) and a plain anchor tag already carries the
// httpOnly cookie with it. Wrapping those three in an axios call would
// only add a manual blob/save-as dance for no benefit.
//
// generateBlueprintReport is different: it's a normal JSON ApiResponse
// meant to be read on-screen (BlueprintDetail.jsx's Compliance Report
// section), so it gets a real service-layer function here, following
// the exact request/unwrap/error-normalize shape analyticsApi.js
// already established as this project's api/ convention.

const request = async (promise) => {
  try {
    const response = await promise;
    return response.data.data;
  } catch (err) {
    throw new Error(handleApiError(err));
  }
};

// GET /api/reports/blueprint/:blueprintId
export const getBlueprintComplianceReport = (blueprintId) =>
  request(apiClient.get(`/reports/blueprint/${blueprintId}`));
