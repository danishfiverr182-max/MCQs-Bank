import { createContext, useEffect, useState } from 'react';
import apiClient from '@/lib/axios';

export const AuthContext = createContext(undefined);

// The login screen has been removed — the app now authenticates
// itself silently using a configured admin account, instead of
// requiring someone to type credentials in. The backend's own auth
// checks (verifyJWT on every protected route, role middleware, etc.)
// are untouched and still run exactly as before; this only skips the
// manual sign-in step on the client. Credentials come from Vite env
// vars (see client/.env.example) rather than being hardcoded here, and
// should match whichever admin account the server seeds on boot
// (server/.env's ADMIN_EMAIL / ADMIN_PASSWORD).
const AUTO_LOGIN_EMAIL = import.meta.env.VITE_ADMIN_EMAIL;
const AUTO_LOGIN_PASSWORD = import.meta.env.VITE_ADMIN_PASSWORD;

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true); // true until the initial auth check resolves
  const [isAuthenticating, setIsAuthenticating] = useState(false); // true while a login request is in flight
  // Set only if silent auto-login itself fails (e.g. misconfigured env
  // vars, or the server down) — surfaced by ProtectedRoute instead of
  // leaving the app stuck on an infinite loading spinner.
  const [authError, setAuthError] = useState(null);

  const login = async (email, password) => {
    setIsAuthenticating(true);
    try {
      const { data } = await apiClient.post('/auth/login', { email, password });
      setUser(data.data.user);
      setAuthError(null);
      return { success: true };
    } catch (err) {
      return {
        success: false,
        message: err?.response?.data?.message || err?.message || 'Login failed',
      };
    } finally {
      setIsAuthenticating(false);
    }
  };

  // On mount: check for an existing session via /auth/me. If there
  // isn't one, sign in automatically rather than showing a login form.
  useEffect(() => {
    const bootstrap = async () => {
      try {
        const { data } = await apiClient.get('/auth/me');
        setUser(data.data.user);
      } catch (err) {
        if (!AUTO_LOGIN_EMAIL || !AUTO_LOGIN_PASSWORD) {
          setAuthError(
            'No admin session and no auto-login credentials configured (set VITE_ADMIN_EMAIL / VITE_ADMIN_PASSWORD in client/.env).'
          );
          setUser(null);
        } else {
          const result = await login(AUTO_LOGIN_EMAIL, AUTO_LOGIN_PASSWORD);
          if (!result.success) {
            setAuthError(result.message);
          }
        }
      } finally {
        setIsLoading(false);
      }
    };

    bootstrap();
  }, []);

  const logout = async () => {
    try {
      await apiClient.post('/auth/logout');
    } finally {
      // Clear local state even if the request fails — the goal is to
      // log the user out client-side regardless.
      setUser(null);
    }
  };

  const value = {
    user,
    isLoading,
    isAuthenticating,
    authError,
    login,
    logout,
    isAuthenticated: !!user,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
