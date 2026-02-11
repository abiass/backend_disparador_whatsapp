import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import pool from '../config/database.js';
import express from 'express';
import dotenv from 'dotenv';

dotenv.config();

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'sua_chave_secreta_supersegura';

// Rota de login
router.post('/login', async (req, res) => {
  const { nome, senha } = req.body;
  if (!nome || !senha) return res.status(400).json({ error: 'Nome e senha obrigatórios' });
  try {
    const result = await pool.query('SELECT * FROM usuarios WHERE nome = $1 AND status = $2', [nome, 'ativo']);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Usuário ou senha inválidos' });
    const usuario = result.rows[0];
    const senhaValida = await bcrypt.compare(senha, usuario.senha_hash);
    if (!senhaValida) return res.status(401).json({ error: 'Usuário ou senha inválidos' });
    const token = jwt.sign({ id: usuario.id, nome: usuario.nome }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, usuario: { id: usuario.id, nome: usuario.nome } });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao realizar login', details: err.message });
  }
});

export default router;
