import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRootEnv = path.resolve(__dirname, '..', '.env');
console.log('projectRootEnv', projectRootEnv, 'exists?', fs.existsSync(projectRootEnv));
if (fs.existsSync(projectRootEnv)) dotenv.config({ path: projectRootEnv });
console.log('DB_USER:', typeof process.env.DB_USER, process.env.DB_USER ? '***' : 'not set');
console.log('DB_PASSWORD type:', typeof process.env.DB_PASSWORD, 'length:', process.env.DB_PASSWORD ? process.env.DB_PASSWORD.length : 0);
console.log('SUPABASE_URL present?', !!process.env.SUPABASE_URL);
