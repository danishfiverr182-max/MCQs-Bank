// Configured Axios instance — completed in Prompt 9, updated in Prompt 18.
// All API calls in the app should import this instance rather than
// calling axios directly, so auth headers, logging, and error
// normalization are applied consistently everywhere.

import axios from 'axios';

const api = axios.create({
  baseURL: '/api', // Vite dev-server proxy forwards this to http://localhost:5000
  withCredentials: true, // required for httpOnly cookies (Phase 2 auth)
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// ─── Request interceptor ───────────────────────────────────────────
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('accessToken');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }

    if (import.meta.env.DEV) {
      console.debug(`→ ${config.method?.toUpperCase()} ${config.url}`);
    }

    return config;
  },
  (error) => Promise.reject(error)
);

// ─── Response interceptor ──────────────────────────────────────────
api.interceptors.response.use(
  (response) => {
    if (import.meta.env.DEV) {
      console.debug(`← ${response.status} ${response.config.url}`);
    }
    return response;
  },
  (error) => {
    const status = error?.response?.status;
    const requestUrl = error?.config?.url || '';

    // Requests under /auth/* handle their own 401s (AuthContext's silent
    // /me check and auto-login, etc.) — reloading here would cause a
    // hard-navigation loop on every logged-out page load. Only reload
    // for OTHER protected API calls whose 401 means "your session
    // expired mid-use" — there's no /login page to redirect to since
    // the login screen was removed, so a reload just re-runs
    // AuthContext's bootstrap effect, which signs back in automatically.
    if (status === 401 && !requestUrl.startsWith('/auth/')) {
      localStorage.removeItem('accessToken');
      window.location.reload();
      return Promise.reject(
        error.response?.data || {
          success: false,
          message: 'Network error — check your connection',
          statusCode: 0,
        }
      );
    }

    return Promise.reject(
      error.response?.data || {
        success: false,
        message: 'Network error — check your connection',
        statusCode: 0,
      }
    );
  }
);

export default api;

// ─── Shared error helper ───────────────────────────────────────────
export const handleApiError = (error) => {
  // Returns a consistent error string from any Axios error shape
  if (typeof error === 'string') return error;
  return error?.message || error?.error || 'Something went wrong';
};
