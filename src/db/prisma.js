const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { env } = require('../config/env');

// Connection pool configuration for production scale
// NODE_ENV=production: optimized for high concurrency
// NODE_ENV=development: minimal overhead for local dev
const isProduction = env.isProduction;

const poolConfig = {
  connectionString: env.databaseUrl,
  // Maximum number of clients in the pool
  max: isProduction ? 30 : 5,
  // Minimum number of idle connections to keep ready
  min: isProduction ? 5 : 1,
  // Close idle connections after this many milliseconds
  idleTimeoutMillis: isProduction ? 30000 : 60000,
  // Maximum time (ms) a client can sit idle in the pool before being removed
  connectionTimeoutMillis: 10000,
  // Maximum time (ms) to wait for a connection from the pool
  maxUses: 7500, // Recycle connections after 7500 uses to prevent stale connections
};

const adapter = new PrismaPg(poolConfig);
const prisma = new PrismaClient({
  adapter,
  log: isProduction
    ? [
        { emit: 'event', level: 'query' },
        { emit: 'event', level: 'error' },
        { emit: 'event', level: 'warn' },
      ]
    : ['error', 'warn'], //dev mode: only errors + warnings
});

// Log slow queries in production for monitoring
if (isProduction) {
  prisma.$on('query', (e) => {
    const duration = e.duration;
    if (duration > 1000) {
      console.warn(`[DB] Slow query (${duration}ms): ${e.query.substring(0, 200)}`);
    }
  });

  prisma.$on('error', (e) => {
    console.error('[DB] Database error:', e.message);
  });

  prisma.$on('warn', (e) => {
    console.warn('[DB] Database warning:', e.message);
  });
}

module.exports = { prisma };


