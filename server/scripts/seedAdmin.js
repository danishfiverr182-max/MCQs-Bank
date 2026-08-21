// Standalone script — NOT part of the Express app lifecycle.
// Run with: npm run seed:admin (from server/)
//
// Creates the first admin account out-of-band, since there is no
// public registration endpoint in this system.

import mongoose from 'mongoose';
import env from '../src/config/env.js';
import User from '../src/models/User.js';

const SEED_ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL;
const SEED_ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD;

const run = async () => {
  if (!SEED_ADMIN_EMAIL || !SEED_ADMIN_PASSWORD) {
    console.error(
      'Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD before running this script'
    );
    process.exit(1);
  }

  let connected = false;

  try {
    await mongoose.connect(env.MONGO_URI, { dbName: env.MONGO_DB_NAME });
    connected = true;

    const existing = await User.findOne({ email: SEED_ADMIN_EMAIL });

    if (existing) {
      console.log(`Admin already exists for ${SEED_ADMIN_EMAIL}, skipping.`);
    } else {
      await User.create({
        email: SEED_ADMIN_EMAIL,
        password: SEED_ADMIN_PASSWORD, // hashed automatically by pre-save hook
        role: 'admin',
        status: 'active',
      });
      console.log(`Admin created: ${SEED_ADMIN_EMAIL}`);
    }

    process.exitCode = 0;
  } catch (error) {
    console.error('❌ Failed to seed admin:', error.message);
    process.exitCode = 1;
  } finally {
    if (connected) {
      await mongoose.disconnect();
    }
    process.exit(process.exitCode ?? 1);
  }
};

run();
