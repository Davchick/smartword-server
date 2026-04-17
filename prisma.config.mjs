import dotenv from 'dotenv';
import path from 'path';
import { defineConfig, env } from 'prisma/config';

// Load .env.development in dev, .env in production
const envFile = process.env.NODE_ENV === 'production' ? '.env' : '.env.development';
dotenv.config({ path: path.resolve(process.cwd(), envFile) });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: env('DATABASE_URL'),
  },
});
