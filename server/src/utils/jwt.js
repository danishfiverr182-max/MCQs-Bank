import jwt from 'jsonwebtoken';
import env from '../config/env.js';

export const signAccessToken = (payload) => {
  // payload: { userId, role }
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, { expiresIn: '15m' });
};

export const signRefreshToken = (payload) => {
  // payload: { userId }
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, { expiresIn: '7d' });
};

export const verifyAccessToken = (token) => {
  // Throws on invalid/expired — caller wraps in try/catch
  return jwt.verify(token, env.JWT_ACCESS_SECRET);
};

export const verifyRefreshToken = (token) => {
  // Throws on invalid/expired — caller wraps in try/catch
  return jwt.verify(token, env.JWT_REFRESH_SECRET);
};
