import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import AdmZip from 'adm-zip';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.SUPABASE_SESSION_BUCKET || 'wpp-sessions';
const KEY = process.env.SESSION_FILE_KEY || 'session-default.zip';
const sessionDir = path.join(process.cwd(), '.wwebjs_auth');

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('⚠️ SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set - session persistence will be disabled');
}

const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

export async function downloadSession() {
  if (!supabase) return false;
  try {
    const { data, error } = await supabase.storage.from(BUCKET).download(KEY);
    if (error) {
      console.log('🔍 No session found in Supabase storage:', error.message);
      return false;
    }
    const buffer = Buffer.from(await data.arrayBuffer());
    const tmp = path.join(process.cwd(), 'tmp-session.zip');
    fs.writeFileSync(tmp, buffer);
    const zip = new AdmZip(tmp);
    zip.extractAllTo(process.cwd(), true);
    fs.unlinkSync(tmp);
    console.log('✅ Session restored from Supabase');
    return true;
  } catch (err) {
    console.error('❌ Error during session download:', err.message);
    return false;
  }
}

export async function uploadSession() {
  if (!supabase) return false;
  try {
    if (!fs.existsSync(sessionDir)) {
      console.log('ℹ️ No local session directory to upload');
      return false;
    }
    const zip = new AdmZip();
    zip.addLocalFolder(sessionDir);
    const buf = zip.toBuffer();
    const { error } = await supabase.storage.from(BUCKET).upload(KEY, buf, { upsert: true });
    if (error) {
      console.error('❌ Error uploading session:', error.message);
      return false;
    }
    console.log('✅ Session uploaded to Supabase');
    return true;
  } catch (err) {
    console.error('❌ Error during session upload:', err.message);
    return false;
  }
}
