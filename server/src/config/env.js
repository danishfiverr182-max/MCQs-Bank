import dotenv from 'dotenv';

dotenv.config();

const REQUIRED = ['MONGO_URI', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'];

for (const key of REQUIRED) {
  const value = process.env[key];
  if (value === undefined || value === '') {
    throw new Error(
      `❌ Missing required environment variable: ${key}\n` +
      `   Add it to your server/.env file. See .env.example for reference.`
    );
  }
}

const NODE_ENV = process.env.NODE_ENV || 'development';

const env = {
  PORT: parseInt(process.env.PORT, 10) || 5001,
  NODE_ENV,
  MONGO_URI: process.env.MONGO_URI,
  MONGO_DB_NAME: process.env.MONGO_DB_NAME || 'exam-engine',
  JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET,
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
  JWT_ACCESS_EXPIRY: process.env.JWT_ACCESS_EXPIRY || '15m',
  JWT_REFRESH_EXPIRY: process.env.JWT_REFRESH_EXPIRY || '7d',
  CORS_ORIGIN: process.env.CORS_ORIGIN || 'http://localhost:1234',
  MAX_UPLOAD_SIZE_BYTES: parseInt(process.env.MAX_UPLOAD_SIZE_BYTES, 10) || 10485760,
  DEFAULT_QUALITY_THRESHOLD: parseInt(process.env.DEFAULT_QUALITY_THRESHOLD, 10) || 50,
  RECENT_DAYS_THRESHOLD: parseInt(process.env.RECENT_DAYS_THRESHOLD, 10) || 30,
  SIMILARITY_THRESHOLD: parseInt(process.env.SIMILARITY_THRESHOLD, 10) || 85,
  ADMIN_EMAIL: process.env.ADMIN_EMAIL || 'admin@examengine.com',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'change_this_in_production',
  IS_PRODUCTION: NODE_ENV === 'production',
  IS_DEVELOPMENT: NODE_ENV === 'development',
};

Object.freeze(env);

export default env;
