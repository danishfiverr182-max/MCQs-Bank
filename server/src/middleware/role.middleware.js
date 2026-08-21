import ApiError from '../utils/ApiError.js';

// Authorization only — assumes verifyJWT has already run and populated
// req.user. Route-agnostic: usage looks like
//   router.get('/admin-only', verifyJWT, requireRole('admin'), controller)
const requireRole = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) return next(new ApiError(401, 'Not authenticated'));

    if (!allowedRoles.includes(req.user.role)) {
      return next(new ApiError(403, 'Insufficient permissions'));
    }

    next();
  };
};

export default requireRole;
