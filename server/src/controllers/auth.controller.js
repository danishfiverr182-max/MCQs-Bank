import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import ApiError from '../utils/ApiError.js';
import * as authService from '../services/auth.service.js';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '../utils/jwt.js';
import env from '../config/env.js';
import { logger } from '../utils/logger.js';

// ─── Shared cookie options ──────────────────────────────────────────
const cookieOptions = {
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: env.NODE_ENV === 'production' ? 'none' : 'lax',
  path: '/',
};

const accessCookieOptions = { ...cookieOptions, maxAge: 15 * 60 * 1000 }; // 15m
const refreshCookieOptions = {
  ...cookieOptions,
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7d
};

// ─── login ───────────────────────────────────────────────────────────
export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const user = await authService.validateCredentials(email, password);

  const accessToken = signAccessToken({ userId: user._id, role: user.role });
  const refreshToken = signRefreshToken({ userId: user._id });

  await authService.updateRefreshToken(user._id, refreshToken);
  await authService.recordLogin(user._id);

  logger.info(`Admin login: ${user.email}`);

  // Prompt 92: the login route runs before verifyJWT ever populates
  // req.user (that's the whole point of this request), so
  // autoLogResponse's `req.logContext.actor ?? req.user` fallback would
  // find nothing — supply the actor explicitly using the account that
  // just authenticated.
  req.logContext.actor = { userId: user._id.toString(), role: user.role, email: user.email };
  req.logContext.summary = `${user.email} logged in`;

  res.cookie('accessToken', accessToken, accessCookieOptions);
  res.cookie('refreshToken', refreshToken, refreshCookieOptions);

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        user: user.toSafeObject(),
        accessToken, // also returned in body for non-cookie clients
        refreshToken,
      },
      'Login successful'
    )
  );
});

// ─── logout ──────────────────────────────────────────────────────────
export const logout = asyncHandler(async (req, res) => {
  if (req.user) {
    await authService.clearRefreshToken(req.user.userId);
  }

  res.clearCookie('accessToken', cookieOptions);
  res.clearCookie('refreshToken', cookieOptions);

  logger.info(`Admin logout: ${req.user?.email ?? 'unknown'}`);

  // Prompt 92: req.user is already populated here (logout requires
  // verifyJWT), so the generic fallback picks it up fine — just add a
  // readable summary.
  req.logContext.summary = `${req.user?.email ?? 'unknown'} logged out`;

  return res
    .status(200)
    .json(new ApiResponse(200, null, 'Logged out successfully'));
});

// ─── refresh ─────────────────────────────────────────────────────────
export const refresh = asyncHandler(async (req, res) => {
  const incomingToken = req.cookies?.refreshToken || req.body?.refreshToken;

  if (!incomingToken) {
    throw new ApiError(401, 'Refresh token missing');
  }

  let decoded;
  try {
    decoded = verifyRefreshToken(incomingToken);
  } catch (err) {
    throw new ApiError(401, 'Refresh token invalid or expired');
  }

  const user = await authService.findByIdWithRefreshToken(decoded.userId);

  // Prevents reuse of a stale/rotated token
  if (!user || user.refreshToken !== incomingToken) {
    throw new ApiError(401, 'Refresh token mismatch or revoked');
  }

  const newAccessToken = signAccessToken({
    userId: user._id,
    role: user.role,
  });
  const newRefreshToken = signRefreshToken({ userId: user._id });

  await authService.updateRefreshToken(user._id, newRefreshToken); // rotation

  res.cookie('accessToken', newAccessToken, accessCookieOptions);
  res.cookie('refreshToken', newRefreshToken, refreshCookieOptions);

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
      },
      'Token refreshed'
    )
  );
});

// ─── getMe ───────────────────────────────────────────────────────────
export const getMe = asyncHandler(async (req, res) => {
  // Requires verifyJWT to have already run (route-level middleware)
  const user = await authService.findByEmail(req.user.email);

  if (!user) {
    throw new ApiError(404, 'User not found');
  }

  return res
    .status(200)
    .json(new ApiResponse(200, { user: user.toSafeObject() }, 'Current user fetched'));
});
