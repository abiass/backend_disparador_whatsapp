import pool from '../config/database.js';

(async () => {
  try {
    const res = await pool.query('SELECT NOW() as now');
    console.log('DB OK:', res.rows[0]);
    process.exit(0);
  } catch (err) {
    console.error('DB ERROR:', err);
    process.exit(1);
  }
})();
