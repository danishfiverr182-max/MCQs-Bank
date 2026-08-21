import apiClient, { handleApiError } from '@/lib/axios';

// analyticsApi.js — Prompt 97.
//
// Prompt 97 describes this as matching an existing `api/` service-layer
// pattern (qaApi.js, mcqApi.js) built on a shared `axiosInstance`. That
// pattern doesn't actually exist in this codebase yet — every page so
// far (QADashboard.jsx, ExamList.jsx, etc.) imports the shared client
// directly from `@/lib/axios` as `apiClient` and unwraps
// `response.data.data` inline itself. This file follows that real,
// established convention instead of inventing a new one: it wraps
// `apiClient`, unwraps `.data.data` for the caller, and normalizes
// errors through the existing `handleApiError` helper — this IS the
// project's api/ service layer pattern, just under the names actually
// in use. This is also the first file under `client/src/api/`, so
// AnalyticsDashboard.jsx (and any future page) can follow this same
// shape going forward.
//
// Every function resolves to the already-unwrapped `data` payload (or
// rejects with a normalized error string via handleApiError) so calling
// pages never touch `response.data.data` themselves.

const request = async (promise) => {
  try {
    const response = await promise;
    return response.data.data;
  } catch (err) {
    throw new Error(handleApiError(err));
  }
};

// GET /api/analytics/overview
export const getOverview = () => request(apiClient.get('/analytics/overview'));

// GET /api/analytics/subjects?blueprintId=
export const getSubjectStats = (blueprintId) =>
  request(apiClient.get('/analytics/subjects', { params: blueprintId ? { blueprintId } : {} }));

// GET /api/analytics/difficulty
export const getDifficultyStats = () => request(apiClient.get('/analytics/difficulty'));

// GET /api/analytics/exposure?type=&limit=
export const getMCQExposure = ({ type, limit } = {}) =>
  request(apiClient.get('/analytics/exposure', { params: { type, limit } }));

// GET /api/analytics/generation-history?months=&examId=
export const getGenerationHistory = ({ months = 12, examId } = {}) =>
  request(apiClient.get('/analytics/generation-history', { params: { months, examId } }));

// GET /api/analytics/trends
export const getTrends = () => request(apiClient.get('/analytics/trends'));

// GET /api/analytics/activity-logs?page=&limit=&action=&entityType=&actorId=&from=&to=
export const getActivityLogs = (params = {}) =>
  request(apiClient.get('/analytics/activity-logs', { params }));
