import express from 'express';
import bcrypt from 'bcrypt';
import pool from '../config/database.js';
import { autenticarJWT } from '../middleware/authMiddleware.js';
const router = express.Router();

// Criar usuário (sem autenticação para permitir primeiro cadastro)
router.post('/usuarios', async (req, res) => {
  const { nome, senha, status, tipo_usuario, telas_liberadas } = req.body;
  try {
    const senha_hash = await bcrypt.hash(senha, 10);
    const result = await pool.query(
      `INSERT INTO usuarios (nome, senha_hash, status, tipo_usuario, telas_liberadas)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [nome, senha_hash, status || 'ativo', tipo_usuario || 'consultor', telas_liberadas || '[]']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Editar usuário (sem autenticação temporariamente)
router.put('/usuarios/:id', async (req, res) => {
  const { id } = req.params;
  const { nome, senha, status, tipo_usuario, telas_liberadas } = req.body;
  try {
    let query, params;
    if (senha) {
      const senha_hash = await bcrypt.hash(senha, 10);
      query = `UPDATE usuarios SET nome=$1, senha_hash=$2, status=$3, tipo_usuario=$4, telas_liberadas=$5 WHERE id=$6 RETURNING *`;
      params = [nome, senha_hash, status, tipo_usuario, telas_liberadas, id];
    } else {
      query = `UPDATE usuarios SET nome=$1, status=$2, tipo_usuario=$3, telas_liberadas=$4 WHERE id=$5 RETURNING *`;
      params = [nome, status, tipo_usuario, telas_liberadas, id];
    }
    const result = await pool.query(query, params);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Deletar usuário (sem autenticação temporariamente)
router.delete('/usuarios/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM usuarios WHERE id=$1', [id]);
    res.json({ message: 'Usuário deletado com sucesso' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Listar usuários
router.get('/usuarios', async (req, res) => {
  try {
    console.log('[usuarios] DB env debug:', {
      DB_USER: process.env.DB_USER ? 'set' : 'not set',
      DB_HOST: process.env.DB_HOST ? 'set' : 'not set',
      DB_NAME: process.env.DB_NAME ? 'set' : 'not set',
      DB_PASSWORD_type: typeof process.env.DB_PASSWORD,
      DB_PASSWORD_len: process.env.DB_PASSWORD ? process.env.DB_PASSWORD.length : 0
    });
    const result = await pool.query('SELECT id, nome, tipo_usuario, status, created_at FROM usuarios ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('[usuarios] DB error:', err);
    res.status(400).json({ error: err.message });
  }
});

export default router;
