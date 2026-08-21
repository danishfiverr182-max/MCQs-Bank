import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';

// This is the only file allowed to run Mongoose queries against User.
// Controllers must go through these functions exclusively.

export const findByEmail = async (email, { withPassword = false } = {}) => {
  const query = User.findOne({ email });
  if (withPassword) query.select('+password');
  return query;
};

export const findByIdWithRefreshToken = async (userId) => {
  return User.findById(userId).select('+refreshToken');
};

export const updateRefreshToken = async (userId, refreshToken) => {
  return User.findByIdAndUpdate(userId, { refreshToken }, { new: true });
};

export const clearRefreshToken = async (userId) => {
  return updateRefreshToken(userId, null);
};

export const recordLogin = async (userId) => {
  return User.findByIdAndUpdate(userId, { lastLogin: new Date() });
};

export const validateCredentials = async (email, password) => {
  const user = await findByEmail(email, { withPassword: true });

  // Identical message for "no such user" and "wrong password" to avoid
  // leaking which emails exist in the system.
  if (!user) throw new ApiError(401, 'Invalid email or password');

  if (user.status !== 'active') {
    throw new ApiError(403, 'Account is disabled');
  }

  const isMatch = await user.comparePassword(password);
  if (!isMatch) throw new ApiError(401, 'Invalid email or password');

  return user;
};
