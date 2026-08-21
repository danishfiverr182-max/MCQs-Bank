import env from '../config/env.js';

const getTimestamp = () => {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  );
};

const info = (...args) => {
  console.log(`[${getTimestamp()}] [INFO]`, ...args);
};

const warn = (...args) => {
  console.warn(`[${getTimestamp()}] [WARN]`, ...args);
};

const error = (...args) => {
  console.error(`[${getTimestamp()}] [ERROR]`, ...args);
};

const debug = (...args) => {
  if (env.NODE_ENV !== 'production') {
    console.log(`[${getTimestamp()}] [DEBUG]`, ...args);
  }
};

export const logger = { info, warn, error, debug };
