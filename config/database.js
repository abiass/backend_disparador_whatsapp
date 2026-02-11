import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Ensure we load the project root .env early, even if this module is imported
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRootEnv = path.resolve(__dirname, '..', '..', '.env');
const localEnv = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(projectRootEnv)) {
  dotenv.config({ path: projectRootEnv });
  console.log('[db] Loaded environment from project root .env');
} else if (fs.existsSync(localEnv)) {
  dotenv.config({ path: localEnv });
  console.log('[db] Loaded environment from backend/.env');
} else {
  dotenv.config();
  console.warn('[db] .env not found - relying on process environment variables');
}

console.log('[db] DB_USER:', process.env.DB_USER ? '***' : 'not set', 'DB_HOST:', process.env.DB_HOST || 'not set', 'DB_NAME:', process.env.DB_NAME || 'not set');
console.log('[db] DB_PASSWORD type:', typeof process.env.DB_PASSWORD, 'length:', process.env.DB_PASSWORD ? process.env.DB_PASSWORD.length : 0);
const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'postgres',
  password: process.env.DB_PASSWORD,
  port: parseInt(process.env.DB_PORT) || 5432,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

export default pool;

