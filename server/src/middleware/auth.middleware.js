import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { verifyAccessToken } from '../utils/jwt.js';
import User from '../models/User.js';

// Authenticates the request and attaches req.user.
// Does NOT auto-refresh expired tokens — that is the explicit job of
// the /refresh route, keeping token renewal out of protected routes.
const verifyJWT = asyncHandler(async (req, res, next) => {
  const bearerHeader = req.headers?.authorization;
  const bearerToken =
    bearerHeader && bearerHeader.startsWith('Bearer ')
      ? bearerHeader.slice(7)
      : null;

  const token = req.cookies?.accessToken || bearerToken;

  if (!token) {
    throw new ApiError(401, 'Access token missing');
  }

  let decoded;
  try {
    decoded = verifyAccessToken(token);
  } catch (err) {
    throw new ApiError(401, 'Access token invalid or expired');
  }

  const user = await User.findById(decoded.userId);

  if (!user) {
    throw new ApiError(401, 'User no longer exists');
  }

  if (user.status !== 'active') {
    throw new ApiError(403, 'Account is disabled');
  }

  req.user = {
    userId: user._id.toString(),
    role: user.role,
    email: user.email,
  };

  next();
});

export default verifyJWT;
