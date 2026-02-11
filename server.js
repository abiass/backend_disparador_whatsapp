import express from 'express';
import pkg from 'pg';
const { Pool } = pkg;
import cors from 'cors';
import wppPkg from 'whatsapp-web.js';
const { Client, LocalAuth } = wppPkg;
import qrcode from 'qrcode';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Load .env from project root if available (we run from backend/ during dev)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRootEnv = path.resolve(__dirname, '..', '.env');
const localEnv = path.resolve(__dirname, '.env');
if (fs.existsSync(projectRootEnv)) {
  dotenv.config({ path: projectRootEnv });
  console.log('[env] Loaded environment from project root .env');
} else if (fs.existsSync(localEnv)) {
  dotenv.config({ path: localEnv });
  console.log('[env] Loaded environment from backend/.env');
} else {
  dotenv.config();
  console.warn('[env] No .env file found - relying on process environment variables');
}

import usuariosRoutes from './routes/usuariosRoutes.js';
import loginRoutes from './routes/loginRoutes.js';
import campanhasRoutes from './routes/campanhasRoutes.js';
import contatosRoutes from './routes/contatosRoutes.js';
import templatesRelatoriosRoutes from './routes/templatesRelatoriosRoutes.js';
import FilaDisparo from './classes/FilaDisparo.js';
import { downloadSession, uploadSession } from './utils/sessionStore.js';

/**
 * Normaliza número de telefone brasileiro para o formato DDD + 8 dígitos
 * Remove o 9 adicional da Anatel para compatibilidade com WhatsApp
 */
function normalizarTelefone(telefone) {
  if (!telefone) return null;

  // Remove todos os caracteres não numéricos
  let numero = telefone.replace(/\D/g, '');

  // Remove código do país (55) se presente
  if (numero.startsWith('55') && numero.length > 10) {
    numero = numero.substring(2);
  }

  // Se tiver 11 dígitos (DDD + 9 + 8 dígitos)
  // Remove o 9 adicional da Anatel (terceiro dígito)
  if (numero.length === 11 && numero[2] === '9') {
    // Formato: XX 9 XXXX-XXXX -> XX XXXX-XXXX
    numero = numero.substring(0, 2) + numero.substring(3);
  }

  // Deve ter 10 dígitos no final (DDD + 8 dígitos)
  if (numero.length === 10) {
    return numero;
  }

  console.warn(`⚠️ Número com formato inesperado após normalização: ${telefone} -> ${numero}`);
  return numero; // Retorna mesmo assim para tentar enviar
}

function formatarNumeroWhatsapp(telefone) {
  const numeroNormalizado = normalizarTelefone(telefone);

  if (!numeroNormalizado) {
    return null;
  }

  const numeroComDDI = `55${numeroNormalizado}`;

  return {
    numeroNormalizado,
    numeroComDDI,
  };
}


const app = express();
app.use(express.json());
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));

// Configure sua conexão PostgreSQL (Supabase)
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: parseInt(process.env.DB_PORT) || 5432,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

// Middleware para adicionar pool às requisições
app.use((req, res, next) => {
  req.pool = pool;
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Debug env (masked) - remove in production
app.get('/api/_env', (req, res) => {
  res.json({
    db_user_set: !!process.env.DB_USER,
    db_host_set: !!process.env.DB_HOST,
    db_name_set: !!process.env.DB_NAME,
    db_password_type: typeof process.env.DB_PASSWORD,
    db_password_length: process.env.DB_PASSWORD ? process.env.DB_PASSWORD.length : 0
  });
});

// Rotas de usuários
app.use('/api', usuariosRoutes);

// Rotas de login
app.use('/api', loginRoutes);

// Rotas de campanhas
app.use('/api/campanhas', campanhasRoutes);

// Rotas de contatos
app.use('/api/contatos', contatosRoutes);

// Rotas de templates e relatórios
app.use('/api', templatesRelatoriosRoutes);

const server = createServer(app);
const wss = new WebSocketServer({ server });

// Endpoint para cadastrar novo lead
app.post('/api/leads/cadastrar', async (req, res) => {
  const { nome, telefone, cnpj, datahora, id_whatsapp } = req.body;
  if (!nome || !telefone) return res.status(400).json({ error: 'nome e telefone obrigatórios' });
  try {
    const result = await pool.query(
      'INSERT INTO leads_whatsapp (nome, telefone, cnpj, datahora, id_whatsapp) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [nome, telefone, cnpj || null, datahora || null, id_whatsapp || null]
    );
    res.json({ success: true, lead: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao cadastrar lead', details: err.message });
  }
});

// Função para buscar leads do banco de dados
async function getLeadsFromDB({ somenteRespondidos = true } = {}) {
  if (somenteRespondidos) {
    const { rows } = await pool.query(
      `SELECT * FROM leads_whatsapp 
       WHERE respondeu = TRUE OR respondeu_em IS NOT NULL 
       ORDER BY 
         CASE 
           WHEN status IN ('finalizado', 'perdido', 'em_atendimento') THEN 2
           ELSE 1
         END,
         respondeu_em ASC NULLS LAST,
         id ASC`,
    );
    return rows;
  }
  const { rows } = await pool.query(
    `SELECT * FROM leads_whatsapp 
     ORDER BY 
       CASE 
         WHEN status IN ('finalizado', 'perdido', 'em_atendimento') THEN 2
         ELSE 1
       END,
       respondeu_em ASC NULLS LAST,
       id ASC`
  );
  return rows;
}

// Instância global do WhatsApp Client
const wppClient = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { headless: true }
});

let qrCodeData = null;
let wppReady = false;

wppClient.on('qr', (qr) => {
  qrCodeData = qr;
  wppReady = false;
  console.log('QR code gerado para conexão WhatsApp');
});

wppClient.on('ready', () => {
  wppReady = true;
  console.log('✅ WhatsApp conectado!');
  
  // Inicializar fila de disparo quando WhatsApp estiver pronto
  const filaDisparo = new FilaDisparo(wppClient, pool, wss);
  app.set('filaDisparo', filaDisparo);
  console.log('✅ Fila de Disparo inicializada');
});

wppClient.on('disconnected', () => {
  wppReady = false;
  qrCodeData = null;
  console.log('WhatsApp desconectado!');
});

// Session persistence: restore from Supabase Storage before initializing

(async () => {
  try {
    await downloadSession();
  } catch (err) {
    console.warn('⚠️ Erro ao restaurar sessão antes de inicializar WhatsApp:', err.message);
  }

  // Inicia o client do WhatsApp
  wppClient.initialize();
})();

// Ao autenticar, sobe a sessão para o storage (garante persistência)
wppClient.on('authenticated', async () => {
  try {
    console.log('✅ WhatsApp autenticado — carregando sessão para storage');
    await uploadSession();
  } catch (err) {
    console.error('❌ Erro ao subir sessão após autenticação:', err.message);
  }
});

// Upload periódico da sessão (minutos)
const SESSION_UPLOAD_INTERVAL = parseInt(process.env.SESSION_UPLOAD_INTERVAL_MINUTES) || 5;
setInterval(() => {
  uploadSession().catch(err => console.error('Erro upload periódico de sessão:', err.message));
}, SESSION_UPLOAD_INTERVAL * 60 * 1000);

// Ao finalizar o processo, tenta subir a sessão
const gracefulUploadAndExit = async () => {
  try {
    await uploadSession();
  } catch (err) {
    console.error('Erro ao subir sessão no exit:', err.message);
  }
  process.exit(0);
};
process.on('SIGINT', gracefulUploadAndExit);
process.on('SIGTERM', gracefulUploadAndExit);
process.on('exit', () => { uploadSession().catch(() => {}); });

// Armazenar mensagens por número com cache e timestamp
const chatHistory = {};
const chatCache = {}; // { numero: { messages: [...], timestamp: Date.now() } }
const CACHE_EXPIRATION_TIME = 5 * 60 * 1000; // 5 minutos
const wsConnections = new Set(); // Armazenar conexões WebSocket ativas

// Mapeamento dinâmico: whatsappIdConversa → numeroLead normalizado
// Quando o frontend abre a modal, registra qual número está usando
const conversationMap = {}; // { "81935208579108": "5545999306874", ... }
const conversationTimeout = {}; // Para limpar mappings antigos

async function registrarRespostaLead(numeroLimpo, nomeContato) {
  try {
    const numeroEntrada = numeroLimpo.startsWith('55') ? numeroLimpo.substring(2) : numeroLimpo;
    const ddd = numeroEntrada.substring(0, 2);
    const corpo = numeroEntrada.substring(2);
    const numeroSem9 = corpo.length === 9 && corpo.startsWith('9') ? `${ddd}${corpo.substring(1)}` : numeroEntrada;
    const numeroCom9 = corpo.length === 8 ? `${ddd}9${corpo}` : numeroEntrada;

    const variantesLocal = [numeroSem9, numeroCom9].filter(Boolean);
    const variantes = Array.from(new Set([
      ...variantesLocal,
      ...variantesLocal.map((n) => `55${n}`),
    ]));

    // Validar se houve disparo para esse numero
    const enviado = await pool.query(
      'SELECT campanha_id, enviado_em FROM mensagens_enviadas WHERE telefone = ANY($1) ORDER BY enviado_em DESC LIMIT 1',
      [variantes],
    );

    if (!enviado.rows.length) {
      console.warn(`⚠️ Nenhum disparo encontrado para: ${variantes.join(' | ')}`);
      return;
    }

    const nomeFinal = nomeContato || 'Contato WhatsApp';

    const existente = await pool.query(
      'SELECT id FROM leads_whatsapp WHERE telefone = ANY($1) LIMIT 1',
      [variantes],
    );

    if (existente.rows.length) {
      await pool.query(
        'UPDATE leads_whatsapp SET respondeu = TRUE, respondeu_em = NOW(), updated_at = NOW() WHERE id = $1',
        [existente.rows[0].id],
      );
      const leadAtualizado = await pool.query('SELECT * FROM leads_whatsapp WHERE id = $1', [existente.rows[0].id]);
      if (leadAtualizado.rows.length) {
        broadcastLeadUpdate(leadAtualizado.rows[0]);
      }
      return;
    }

    const novoLead = await pool.query(
      `INSERT INTO leads_whatsapp (nome, telefone, datahora, status, respondeu, respondeu_em)
       VALUES ($1, $2, NOW(), 'respondido', TRUE, NOW())
       RETURNING *`,
      [nomeFinal, numeroSem9],
    );
    if (novoLead.rows && novoLead.rows.length) {
      broadcastLeadUpdate(novoLead.rows[0]);
    }
  } catch (err) {
    console.error('❌ Erro ao registrar resposta de lead:', err);
  }
}

wppClient.on('message', (msg) => {
  console.log('\n🟣 ===== MESSAGE EVENT =====');
  console.log('msg.from:', msg.from);
  console.log('msg.fromMe:', msg.fromMe); // LOG: verificar se é mensagem própria
  
  // Tentar obter o contato para pegar o número real
  msg.getContact().then(contact => {
    let numero = contact.number || msg.from;
    numero = numero.split('@')[0];
    
    // Normaliza o número para o formato brasileiro correto
    const numeroNormalizado = normalizarTelefone(numero);
    
    if (!numeroNormalizado) {
      console.warn('⚠️ Não foi possível normalizar o número:', numero);
      return;
    }
    
    console.log(`📱 Número normalizado: ${numero} -> ${numeroNormalizado}`);

    // ✅ CORREÇÃO: Só registra como lead se for mensagem RECEBIDA (não enviada por você)
    if (!msg.fromMe) {
      console.log('✅ Mensagem recebida do contato - registrando resposta');
      registrarRespostaLead(numeroNormalizado, contact.pushname || contact.name).catch(() => {});
    } else {
      console.log('⏭️  Mensagem enviada por você - ignorando registro de lead');
    }
    
    if (!chatHistory[numeroNormalizado]) chatHistory[numeroNormalizado] = [];
    // Detecta mídia
    if (msg.hasMedia) {
      msg.downloadMedia().then(media => {
        const mediaMsg = {
          fromMe: msg.fromMe,
          type: media.mimetype.startsWith('image') ? 'image' : media.mimetype.startsWith('audio') ? 'audio' : 'file',
          mimetype: media.mimetype,
          body: msg.body,
          mediaData: media.data, // base64
          timestamp: msg.timestamp
        };
        chatHistory[numeroNormalizado].push(mediaMsg);
        delete chatCache[numeroNormalizado];
        broadcastNewMessage(numeroNormalizado, mediaMsg);
      });
    } else {
      const textMsg = {
        fromMe: msg.fromMe,
        body: msg.body,
        timestamp: msg.timestamp
      };
      chatHistory[numeroNormalizado].push(textMsg);
      delete chatCache[numeroNormalizado];
      broadcastNewMessage(numeroNormalizado, textMsg);
    }
    console.log('🔊 Broadcasting para:', numeroNormalizado);
    console.log('🟣 ===== END MESSAGE =====\n');
  }).catch(err => {
    console.error('❌ Erro em getContact:', err);
    // Fallback
    let numero = (msg.fromMe ? msg.to : msg.from) || '';
    numero = numero.split('@')[0];
    
    const numeroNormalizado = normalizarTelefone(numero);
    if (!numeroNormalizado) {
      console.warn('⚠️ Não foi possível normalizar o número (fallback):', numero);
      return;
    }
    
    registrarRespostaLead(numeroNormalizado, null).catch(() => {});

    if (!chatHistory[numeroNormalizado]) chatHistory[numeroNormalizado] = [];
    chatHistory[numeroNormalizado].push({
      fromMe: msg.fromMe,
      body: msg.body,
      timestamp: msg.timestamp
    });
    delete chatCache[numeroNormalizado];
    
    const messageData = {
      fromMe: msg.fromMe,
      body: msg.body,
      timestamp: msg.timestamp
    };
    console.log('🔊 Broadcasting para:', numeroNormalizado);
    broadcastNewMessage(numeroNormalizado, messageData);
  }).catch(err => {
    console.error('❌ Erro ao processar message:', err);
    let numero = (msg.fromMe ? msg.to : msg.from) || '';
    numero = numero.split('@')[0];
    
    const numeroNormalizado = normalizarTelefone(numero);
    if (!numeroNormalizado) {
      console.warn('⚠️ Não foi possível normalizar o número (fallback 2):', numero);
      return;
    }
    
    if (!chatHistory[numeroNormalizado]) chatHistory[numeroNormalizado] = [];
    chatHistory[numeroNormalizado].push({
      fromMe: msg.fromMe,
      body: msg.body,
      timestamp: msg.timestamp
    });
    delete chatCache[numeroNormalizado];
    broadcastNewMessage(numeroNormalizado, {
      fromMe: msg.fromMe,
      body: msg.body,
      timestamp: msg.timestamp
    });
  });
});

wppClient.on('message_create', (msg) => {
  console.log('\n🔵 ===== MESSAGE_CREATE EVENT =====');
  
  // Tentar obter o contato para pegar o número real
  msg.getContact().then(contact => {
    let numero = contact.number || msg.to;
    numero = numero.split('@')[0];
    
    const numeroNormalizado = normalizarTelefone(numero);
    
    if (!numeroNormalizado) {
      console.warn('⚠️ Não foi possível normalizar o número (msg_create):', numero);
      return;
    }
    
    console.log(`📱 Número normalizado (msg_create): ${numero} -> ${numeroNormalizado}`);
    
    if (!chatHistory[numeroNormalizado]) chatHistory[numeroNormalizado] = [];
    chatHistory[numeroNormalizado].push({
      fromMe: true,
      body: msg.body,
      timestamp: msg.timestamp
    });
    
    const messageData = {
      fromMe: true,
      body: msg.body,
      timestamp: msg.timestamp
    };
    console.log('🔊 Broadcasting para:', numeroNormalizado);
    broadcastNewMessage(numeroNormalizado, messageData);
    console.log('🔵 ===== END MESSAGE_CREATE =====\n');
  }).catch(err => {
    console.error('❌ Erro em getContact (msg_create):', err);
    // Fallback
    let numero = msg.to.split('@')[0];
    
    const numeroNormalizado = normalizarTelefone(numero);
    if (!numeroNormalizado) {
      console.warn('⚠️ Não foi possível normalizar o número (fallback msg_create):', numero);
      return;
    }
    
    if (!chatHistory[numeroNormalizado]) chatHistory[numeroNormalizado] = [];
    chatHistory[numeroNormalizado].push({
      fromMe: true,
      body: msg.body,
      timestamp: msg.timestamp
    });
    broadcastNewMessage(numeroNormalizado, {
      fromMe: true,
      body: msg.body,
      timestamp: msg.timestamp
    });
  });
});

// Endpoint para obter leads e índice liberado
// Endpoint para obter leads do banco
app.get('/api/leads', async (req, res) => {
  try {
    const somenteRespondidos = req.query.respondidos === '1';
    const leads = await getLeadsFromDB({ somenteRespondidos });
    res.json({ leads, leadIndex: 0 });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar leads', details: err.message });
  }
});
// Endpoint para atualizar o id_whatsapp de um lead
app.post('/api/leads/update-id-whatsapp', async (req, res) => {
  const { id, id_whatsapp } = req.body;
  if (!id || !id_whatsapp) return res.status(400).json({ error: 'id e id_whatsapp obrigatórios' });
  try {
    await pool.query('UPDATE leads_whatsapp SET id_whatsapp = $1 WHERE id = $2', [id_whatsapp, id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar id_whatsapp', details: err.message });
  }
});

// Endpoint para liberar próximo lead após envio
app.post('/api/leads/next', async (req, res) => {
  const { user_id, next_index } = req.body;
  if (!user_id || typeof next_index !== 'number') {
    return res.status(400).json({ error: 'user_id e next_index obrigatórios' });
  }
  try {
    // Verifica se o lead atual tem sessao_conversa = TRUE
    const leadAtualIndex = next_index - 1;
    const leadAtualRes = await pool.query('SELECT id, sessao_conversa FROM leads_whatsapp ORDER BY id LIMIT 1 OFFSET $1', [leadAtualIndex]);
    if (!leadAtualRes.rows.length || !leadAtualRes.rows[0].sessao_conversa) {
      return res.status(403).json({ error: 'Lead atual ainda não teve conversa iniciada (sessao_conversa = FALSE)' });
    }
    await pool.query(
      `INSERT INTO leads_status (user_id, lead_index, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE SET lead_index = $2, updated_at = NOW()`,
      [user_id, next_index]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar status do lead' });
  }
});

// Endpoint para registrar quando uma conversa é aberta
app.post('/api/whatsapp/conversation/start', (req, res) => {
  const { numero } = req.body;
  if (!numero) return res.status(400).json({ error: 'número obrigatório' });
  
  // Normaliza o número para o formato brasileiro correto
  const numeroNormalizado = normalizarTelefone(numero);
  
  if (!numeroNormalizado) {
    return res.status(400).json({ error: 'Número de telefone inválido' });
  }
  
  console.log(`📱 Conversa iniciada com: ${numero} -> ${numeroNormalizado}`);
  console.log('💾 Aguardando para mapear com ID de conversa do WhatsApp...');
  
  res.json({ success: true, numero: numeroNormalizado });
});

// Endpoint para limpar mapping quando conversa é fechada
app.post('/api/whatsapp/conversation/end', (req, res) => {
  const { numero } = req.body;
  if (!numero) return res.status(400).json({ error: 'número obrigatório' });
  
  // Normaliza o número antes de procurar no map
  const numeroNormalizado = normalizarTelefone(numero);
  
  if (!numeroNormalizado) {
    return res.status(400).json({ error: 'Número de telefone inválido' });
  }
  
  // Remove todos os mappings para este número
  Object.keys(conversationMap).forEach(key => {
    if (conversationMap[key] === numeroNormalizado) {
      delete conversationMap[key];
      if (conversationTimeout[key]) clearTimeout(conversationTimeout[key]);
      console.log('🗑️ Mapping removido:', key, '→', numeroNormalizado);
    }
  });
  
  res.json({ success: true });
});

// Rota para obter o QR code (base64) e status de conexão
app.get('/api/whatsapp/qr', async (req, res) => {
  // wppClient.info é definido quando conectado
  const info = wppClient && wppClient.info ? wppClient.info : null;
  const isReady = wppReady && info && info.wid;
  console.log('DEBUG /api/whatsapp/qr:', {
    info,
    isReady,
    qrCodeData: !!qrCodeData
  });
  if (!qrCodeData && !isReady) {
    return res.json({
      qr: null,
      ready: false,
      info: null,
      status: 'waiting_qr',
      message: 'QR code ainda não disponível'
    });
  }
  let qrImage = null;
  if (qrCodeData) {
    qrImage = await qrcode.toDataURL(qrCodeData);
  }
  res.json({
    qr: qrImage,
    ready: !!isReady,
    info,
    status: isReady ? 'ready' : 'qr_available'
  });
});

// Endpoint para editar status do lead
app.put('/api/leads/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status_lead, obs_perdido } = req.body;
  if (!id || !status_lead) return res.status(400).json({ error: 'id e status_lead obrigatórios' });
  try {
    if (status_lead === 'PERDIDO') {
      await pool.query('UPDATE leads_whatsapp SET status_lead = $1, obs_perdido = $2 WHERE id = $3', [status_lead, obs_perdido || null, id]);
    } else {
      await pool.query('UPDATE leads_whatsapp SET status_lead = $1, obs_perdido = NULL WHERE id = $2', [status_lead, id]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar status do lead', details: err.message });
  }
});

// Rota para enviar mensagem para um número
app.post('/api/whatsapp/send', async (req, res) => {
  const { numero, mensagem } = req.body;
  if (!wppReady) return res.status(400).json({ error: 'WhatsApp não conectado' });
  if (!numero || !mensagem) return res.status(400).json({ error: 'Número e mensagem obrigatórios' });
  try {
    const infoNumero = formatarNumeroWhatsapp(numero);

    if (!infoNumero) {
      return res.status(400).json({ error: 'Número de telefone inválido' });
    }

    console.log(`📱 Número original: ${numero} -> Normalizado: ${infoNumero.numeroNormalizado}`);

    // Verifica se o número existe no WhatsApp
    const numberId = await wppClient.getNumberId(infoNumero.numeroComDDI);
    console.log('NumberId retornado:', numberId);

    if (!numberId) {
      return res.status(404).json({ error: 'Número não encontrado no WhatsApp ou não tem chat ativo' });
    }

    await wppClient.sendMessage(numberId._serialized, mensagem);

    // Atualiza a coluna sessao_conversa para TRUE no lead correspondente
    await pool.query('UPDATE leads_whatsapp SET sessao_conversa = TRUE WHERE telefone = $1', [numero]);

    res.json({ success: true });
  } catch (err) {
    console.error('Erro ao enviar mensagem:', err);
    res.status(500).json({ error: 'Erro ao enviar mensagem', details: err.message || err });
  }
});

// Rota para buscar histórico de conversa
app.get('/api/whatsapp/chat/:numero', async (req, res) => {
  try {
    const infoNumero = formatarNumeroWhatsapp(req.params.numero);

    if (!infoNumero) {
      return res.json({ history: [] });
    }
    
    console.log(`📱 Buscando histórico para: ${req.params.numero} -> ${infoNumero.numeroNormalizado}`);
    
    // Verificar se está em cache e ainda é válido
    if (chatCache[infoNumero.numeroNormalizado] && (Date.now() - chatCache[infoNumero.numeroNormalizado].timestamp) < CACHE_EXPIRATION_TIME) {
      console.log('Retornando histórico do cache');
      return res.json({ history: chatCache[infoNumero.numeroNormalizado].messages });
    }
    
    console.log('Cache expirado ou não existe, buscando do WhatsApp...');
    
    // Verifica se o número existe no WhatsApp e pega o ID correto
    const numberId = await wppClient.getNumberId(infoNumero.numeroComDDI);
    if (!numberId) {
      console.log('Número não encontrado, retornando histórico vazio');
      return res.json({ history: [] });
    }
    
    console.log('NumberId encontrado:', numberId._serialized);
    
    // 🔑 IMPORTANTE: Mapear este ID para o número normalizado
    if (numberId._serialized) {
      const chatId = numberId._serialized.split('@')[0];
      conversationMap[chatId] = infoNumero.numeroNormalizado;
      console.log('✅ Mapeamento registrado:', chatId, '→', infoNumero.numeroNormalizado);
      
      // Limpar timeout antigo se existir
      if (conversationTimeout[chatId]) clearTimeout(conversationTimeout[chatId]);
      
      // Definir timeout para remover o mapeamento após 1 hora de inatividade
      conversationTimeout[chatId] = setTimeout(() => {
        delete conversationMap[chatId];
        console.log('🗑️ Mapeamento expirado:', chatId);
      }, 60 * 60 * 1000); // 1 hora
    }
    
    // Busca o chat do WhatsApp usando o ID correto
    const chat = await wppClient.getChatById(numberId._serialized);
    if (!chat) {
      return res.json({ history: [] });
    }
    
    // Busca as mensagens do chat
    const messages = await chat.fetchMessages({ limit: 50 });
    const history = await Promise.all(messages.map(async msg => {
      if (msg.hasMedia) {
        const media = await msg.downloadMedia();
        return {
          fromMe: msg.fromMe,
          type: media.mimetype.startsWith('image') ? 'image' : media.mimetype.startsWith('audio') ? 'audio' : 'file',
          mimetype: media.mimetype,
          body: msg.body,
          mediaData: media.data, // base64
          timestamp: msg.timestamp
        };
      } else {
        return {
          fromMe: msg.fromMe,
          body: msg.body,
          timestamp: msg.timestamp
        };
      }
    }));

    // Extrai o id_whatsapp do chatId
    const id_whatsapp = numberId._serialized.split('@')[0];

    // Armazenar no cache com timestamp
    chatCache[infoNumero.numeroNormalizado] = {
      messages: history,
      timestamp: Date.now()
    };

    console.log(`Histórico encontrado: ${history.length} mensagens (armazenado em cache)`);
    res.json({ history, id_whatsapp });
  } catch (err) {
    console.error('Erro ao buscar histórico:', err);
    res.json({ history: [] });
  }
});

// Endpoint para exportar relatório de leads em CSV
app.get('/api/leads/relatorio/csv', async (req, res) => {
  const { dataInicio, dataFim } = req.query;
  if (!dataInicio || !dataFim) {
    return res.status(400).json({ error: 'dataInicio e dataFim obrigatórios' });
  }
  try {
    const result = await pool.query(
      `SELECT cnpj, nome, telefone, datahora FROM leads_whatsapp WHERE datahora >= $1 AND datahora <= $2 ORDER BY datahora ASC`,
      [dataInicio, dataFim]
    );
    const leads = result.rows;
    let csv = 'CNPJ,Nome,Telefone,Data/Hora\n';
    csv += leads.map(lead => [
      lead.cnpj,
      lead.nome,
      lead.telefone,
      lead.datahora ? new Date(lead.datahora).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
    ].map(v => `"${(v||'').toString().replace(/"/g,'""')}"`).join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="relatorio-leads-${dataInicio}-a-${dataFim}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao exportar CSV', details: err.message });
  }
});
// Endpoint para retornar volume de leads agrupado por período (day|week|month)
app.get('/api/leads/volume', async (req, res) => {
  const { period = 'day', start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start e end obrigatórios' });
  const valid = { day: 'day', week: 'week', month: 'month' };
  const p = valid[period] || 'day';
  try {
    const q = `SELECT date_trunc('${p}', datahora) AS periodo, COUNT(*)::int AS count FROM leads_whatsapp WHERE datahora >= $1 AND datahora <= $2 GROUP BY periodo ORDER BY periodo ASC`;
    const { rows } = await pool.query(q, [start, end]);
    const mapped = rows.map(r => ({ label: r.periodo.toISOString(), count: r.count }));
    res.json({ data: mapped });
  } catch (err) {
    console.error('Erro em /api/leads/volume', err);
    res.status(500).json({ error: 'Erro ao buscar volume', details: err.message });
  }
});

// Endpoint para relatório de leads por data
app.get('/api/leads/relatorio', async (req, res) => {
  const { dataInicio, dataFim } = req.query;
  if (!dataInicio || !dataFim) {
    return res.status(400).json({ error: 'dataInicio e dataFim obrigatórios' });
  }
  try {
    // Considera datahora como timestamp ou string ISO
    const result = await pool.query(
      `SELECT * FROM leads_whatsapp WHERE datahora >= $1 AND datahora <= $2 ORDER BY datahora ASC`,
      [dataInicio, dataFim]
    );
    res.json({ leads: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar relatório', details: err.message });
  }
});

// ===== ENDPOINTS DE RELATÓRIOS =====
app.get('/api/relatorios/geral', async (req, res) => {
  try {
    res.json({
      totalEnviados: 0,
      totalEntregues: 0,
      totalFalhas: 0,
      totalCampanhas: 0,
      campanhasAtivas: 0,
      taxaEntrega: 0
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar relatórios', details: err.message });
  }
});

app.get('/api/relatorios/grafico/envios', async (req, res) => {
  try {
    res.json({ dados: [] });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar gráfico de envios', details: err.message });
  }
});

app.get('/api/relatorios/grafico/status', async (req, res) => {
  try {
    res.json({ dados: [] });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar gráfico de status', details: err.message });
  }
});

// ===== ENDPOINT PARA DOWNLOAD DO TEMPLATE =====
app.get('/api/contatos/template/download', (req, res) => {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const filePath = path.join(__dirname, '..', 'public', 'template_contatos.csv');
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Arquivo não encontrado' });
    }
    
    res.setHeader('Content-Disposition', 'attachment; filename="template_contatos.csv"');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);
  } catch (err) {
    console.error('Erro ao fazer download:', err);
    res.status(500).json({ error: 'Erro ao fazer download do template' });
  }
});

// Inicialização do servidor
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Servidor backend rodando na porta ${PORT}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
});

// WebSocket para notificações em tempo real
wss.on('connection', (ws) => {
  console.log('Cliente WebSocket conectado');
  wsConnections.add(ws);
  
  ws.on('close', () => {
    console.log('Cliente WebSocket desconectado');
    wsConnections.delete(ws);
  });
});

// Função para broadcast de novas mensagens
function broadcastNewMessage(numero, message) {
  const payload = JSON.stringify({
    type: 'new_message',
    numero: numero,
    message: message
  });
  
  console.log('Enviando para', wsConnections.size, 'clientes WebSocket:', payload);
  
  wsConnections.forEach((ws) => {
    if (ws.readyState === 1) { // 1 = OPEN
      ws.send(payload);
    }
  });
}

function broadcastLeadUpdate(lead) {
  const payload = JSON.stringify({
    type: 'lead_update',
    lead
  });

  wsConnections.forEach((ws) => {
    if (ws.readyState === 1) { // 1 = OPEN
      ws.send(payload);
    }
  });
}
