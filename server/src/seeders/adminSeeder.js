import env from '../config/env.js';
import { logger } from '../utils/logger.js';

// Creates the first admin user if no admin exists yet.
// Safe to run on every boot — idempotent, and safe to call even before
// the User model exists (Phase 2 will introduce it).
export const seedAdmin = async () => {
  let User;

  try {
    // Dynamic import so this doesn't crash the app if the model
    // hasn't been created yet (Phase 2 adds src/models/User.js).
    const userModule = await import('../models/User.js');
    User = userModule.default || userModule.User;
  } catch (err) {
    logger.debug(
      'adminSeeder: User model not defined yet — skipping seeding for now.'
    );
    return;
  }

  if (!User) {
    logger.debug('adminSeeder: User model export not found — skipping.');
    return;
  }

  try {
    const existingAdmin = await User.findOne({ role: 'admin' });

    if (existingAdmin) {
      logger.info('Admin already exists. Skipping.');
      return;
    }

    const admin = await User.create({
      firstName: 'Super',
      lastName: 'Admin',
      email: env.ADMIN_EMAIL,
      password: env.ADMIN_PASSWORD, // hashed once, automatically, by the pre-save hook
      role: 'admin',
      status: 'active',
    });

    logger.info(`✅ Admin user created: ${admin.email}`);
  } catch (err) {
    logger.error('adminSeeder failed:', err.message);
  }
};
