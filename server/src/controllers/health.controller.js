import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import { isDBConnected } from '../config/db.js';
import env from '../config/env.js';
import { logger } from '../utils/logger.js';

const formatUptime = (seconds) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [h && `${h}h`, m && `${m}m`, `${s}s`].filter(Boolean).join(' ');
};

export const getHealth = asyncHandler(async (req, res) => {
  logger.debug(`Health check requested from ${req.ip}`);

  const dbConnected = isDBConnected();
  const uptime = process.uptime();

  const data = {
    status: 'ok',
    environment: env.NODE_ENV,
    database: {
      connected: dbConnected,
      status: dbConnected ? 'connected' : 'disconnected',
    },
    server: {
      uptime: Math.floor(uptime),
      uptimeFormatted: formatUptime(uptime),
      nodeVersion: process.version,
      platform: process.platform,
      memoryUsageMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    },
    timestamp: new Date().toISOString(),
  };

  return res.status(200).json(new ApiResponse(200, data, 'ExamEngine is running'));
});
