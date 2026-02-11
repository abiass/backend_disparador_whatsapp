// ==========================================
// ROTAS DE CONTATOS
// ==========================================

import express from "express";
import multer from "multer";
const router = express.Router();
import { processarCSV, processarExcel } from "../utils/importacao.js";

// Configurar multer para upload
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const tiposPermitidos = [
      "text/csv",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ];

    if (tiposPermitidos.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Apenas arquivos CSV ou Excel são permitidos"));
    }
  },
});

/**
 * GET /api/contatos
 * Lista todos os contatos
 */
router.get("/", async (req, res) => {
  try {
    const { busca, filtro, limite = 20, offset = 0 } = req.query;

    let query = "SELECT * FROM contatos WHERE 1=1";
    const params = [];
    let paramCount = 1;

    // Buscar por nome ou telefone
    if (busca) {
      query += ` AND (nome ILIKE $${paramCount} OR telefone_normalizado ILIKE $${paramCount})`;
      params.push(`%${busca}%`);
      paramCount++;
    }

    // Filtrar por WhatsApp verificado
    if (filtro === "verificados") {
      query += ` AND whatsapp_verificado = true`;
    } else if (filtro === "nao_verificados") {
      query += ` AND whatsapp_verificado = false`;
    }

    // Contar total antes de paginar
    const countQuery = `SELECT COUNT(*) FROM contatos WHERE 1=1 ${busca ? `AND (nome ILIKE '%${busca}%' OR telefone_normalizado ILIKE '%${busca}%')` : ""}`;
    const countResult = await req.pool.query(countQuery);
    const total = parseInt(countResult.rows[0].count);

    // Paginação
    query += ` ORDER BY created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    params.push(parseInt(limite), parseInt(offset));

    const result = await req.pool.query(query, params);

    res.json({
      contatos: result.rows,
      total,
      pagina: Math.floor(parseInt(offset) / parseInt(limite)) + 1,
      limite: parseInt(limite),
    });
  } catch (erro) {
    console.error("[✗] Erro ao listar contatos:", erro);
    res.status(500).json({ erro: erro.message });
  }
});

/**
 * GET /api/grupos-importacao
 * Lista todos os grupos de importação com número de contatos
 */
router.get("/grupos-importacao/listar", async (req, res) => {
  try {
    const result = await req.pool.query(
      `SELECT 
        g.id,
        g.nome_arquivo,
        g.total_contatos,
        g.total_inseridos,
        g.total_atualizados,
        g.data_importacao,
        COUNT(c.id) as contatos_atuais
       FROM grupos_importacao g
       LEFT JOIN contatos c ON c.grupo_importacao_id = g.id
       GROUP BY g.id
       ORDER BY g.data_importacao DESC`,
      [],
    );

    res.json({
      grupos: result.rows,
      total: result.rows.length,
    });
  } catch (erro) {
    console.error("[✗] Erro ao listar grupos:", erro);
    res.status(500).json({ erro: erro.message });
  }
});

/**
 * GET /api/contatos-grupo/:grupoId
 * Lista contatos de um grupo específico
 */
router.get("/contatos-grupo/:grupoId", async (req, res) => {
  try {
    const { grupoId } = req.params;

    const result = await req.pool.query(
      `SELECT * FROM contatos 
       WHERE grupo_importacao_id = $1
       ORDER BY nome ASC`,
      [grupoId],
    );

    const grupoInfo = await req.pool.query(
      `SELECT * FROM grupos_importacao WHERE id = $1`,
      [grupoId],
    );

    res.json({
      grupo: grupoInfo.rows[0] || null,
      contatos: result.rows,
      total: result.rows.length,
    });
  } catch (erro) {
    console.error("[✗] Erro ao listar contatos do grupo:", erro);
    res.status(500).json({ erro: erro.message });
  }
});

/**
 * GET /api/contatos/:id
 * Obter detalhes de um contato
 */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await req.pool.query("SELECT * FROM contatos WHERE id = $1", [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ erro: "Contato não encontrado" });
    }

    res.json(result.rows[0]);
  } catch (erro) {
    console.error("[✗] Erro ao obter contato:", erro);
    res.status(500).json({ erro: erro.message });
  }
});

/**
 * POST /api/contatos
 * Criar novo contato
 */
router.post("/", async (req, res) => {
  try {
    const { nome, telefone, telefone_normalizado, email, empresa, cargo, tags } = req.body;

    if (!telefone_normalizado) {
      return res.status(400).json({ erro: "Telefone normalizado é obrigatório" });
    }

    // Verificar se já existe
    const existente = await req.pool.query(
      "SELECT id FROM contatos WHERE telefone_normalizado = $1",
      [telefone_normalizado],
    );

    if (existente.rows.length > 0) {
      return res.status(400).json({ erro: "Contato com este telefone já existe" });
    }

    const result = await req.pool.query(
      `INSERT INTO contatos (nome, telefone, telefone_normalizado, email, empresa, cargo, tags)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [nome, telefone, telefone_normalizado, email, empresa, cargo, tags || null],
    );

    // Registrar atividade
    await req.pool.query(
      `INSERT INTO atividades (tipo, descricao, dados_adicionais)
       VALUES ($1, $2, $3)`,
      ["contato_criado", `Contato "${nome}" criado`, { contato_id: result.rows[0].id }],
    );

    res.status(201).json({
      sucesso: true,
      contato: result.rows[0],
    });
  } catch (erro) {
    console.error("[✗] Erro ao criar contato:", erro);
    res.status(500).json({ erro: erro.message });
  }
});

/**
 * PUT /api/contatos/:id
 * Editar contato
 */
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, email, empresa, cargo, tags } = req.body;

    const result = await req.pool.query(
      `UPDATE contatos 
       SET nome = COALESCE($1, nome),
           email = COALESCE($2, email),
           empresa = COALESCE($3, empresa),
           cargo = COALESCE($4, cargo),
           tags = COALESCE($5, tags),
           updated_at = NOW()
       WHERE id = $6
       RETURNING *`,
      [nome, email, empresa, cargo, tags, id],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ erro: "Contato não encontrado" });
    }

    res.json({
      sucesso: true,
      contato: result.rows[0],
    });
  } catch (erro) {
    console.error("[✗] Erro ao editar contato:", erro);
    res.status(500).json({ erro: erro.message });
  }
});

/**
 * DELETE /api/contatos/:id
 * Deletar contato
 */
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Buscar contato antes de deletar
    const contatoResult = await req.pool.query("SELECT * FROM contatos WHERE id = $1", [id]);

    if (contatoResult.rows.length === 0) {
      return res.status(404).json({ erro: "Contato não encontrado" });
    }

    const contato = contatoResult.rows[0];

    // Deletar contato (cascata delete os registros relacionados)
    await req.pool.query("DELETE FROM contatos WHERE id = $1", [id]);

    // Registrar atividade
    await req.pool.query(
      `INSERT INTO atividades (tipo, descricao, dados_adicionais)
       VALUES ($1, $2, $3)`,
      ["contato_deletado", `Contato "${contato.nome}" deletado`, { contato_id: id }],
    );

    res.json({
      sucesso: true,
      mensagem: "Contato deletado com sucesso",
    });
  } catch (erro) {
    console.error("[✗] Erro ao deletar contato:", erro);
    res.status(500).json({ erro: erro.message });
  }
});

/**
 * POST /api/contatos/importar
 * Importar contatos de arquivo CSV ou Excel
 */
router.post("/importar", upload.single("arquivo"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ erro: "Arquivo é obrigatório" });
    }

    console.log(`\n📁 Importando arquivo: ${req.file.originalname} (${req.file.mimetype})`);

    // Criar grupo de importação
    const grupoResult = await req.pool.query(
      `INSERT INTO grupos_importacao (nome_arquivo)
       VALUES ($1)
       RETURNING id`,
      [req.file.originalname],
    );
    const grupoId = grupoResult.rows[0].id;

    let resultados;

    // Processar baseado no tipo de arquivo
    if (req.file.mimetype === "text/csv") {
      resultados = await processarCSV(req.file.buffer, req.pool, grupoId);
    } else {
      resultados = await processarExcel(req.file.buffer, req.pool, grupoId);
    }

    // Atualizar contador do grupo
    await req.pool.query(
      `UPDATE grupos_importacao 
       SET total_contatos = $1,
           total_inseridos = $2,
           total_atualizados = $3
       WHERE id = $4`,
      [
        resultados.inseridos + resultados.atualizados,
        resultados.inseridos,
        resultados.atualizados,
        grupoId,
      ],
    );

    // Registrar atividade
    await req.pool.query(
      `INSERT INTO atividades (tipo, descricao, dados_adicionais)
       VALUES ($1, $2, $3)`,
      [
        "contatos_importados",
        `Importação de contatos realizada: ${resultados.inseridos} inseridos, ${resultados.atualizados} atualizados`,
        {
          arquivo: req.file.originalname,
          grupo_id: grupoId,
          inseridos: resultados.inseridos,
          atualizados: resultados.atualizados,
          erros: resultados.erros.length,
        },
      ],
    );

    res.json({
      sucesso: true,
      grupo_id: grupoId,
      resultados: {
        inseridos: resultados.inseridos,
        atualizados: resultados.atualizados,
        erros: resultados.erros,
        total_processados: resultados.inseridos + resultados.atualizados + resultados.erros.length,
      },
    });
  } catch (erro) {
    console.error("[✗] Erro ao importar contatos:", erro);
    res.status(500).json({ erro: erro.message });
  }
});

/**
 * POST /api/contatos/validar
 * Valida múltiplos números contra WhatsApp
 */
router.post("/validar", async (req, res) => {
  try {
    const { ids } = req.body;
    const wppClient = req.app.get("wppClient");

    if (!wppClient || !ids || ids.length === 0) {
      return res.status(400).json({ erro: "ClienteWhatsApp e IDs são obrigatórios" });
    }

    const validados = [];
    const invalidos = [];

    for (const id of ids) {
      try {
        const result = await req.pool.query("SELECT * FROM contatos WHERE id = $1", [id]);

        if (result.rows.length === 0) continue;

        const contato = result.rows[0];
        const numeroFormatado = contato.telefone_normalizado + "@c.us";

        // Validar contra WhatsApp
        const existe = await wppClient.isRegisteredUser(numeroFormatado);

        if (existe) {
          // Atualizar como verificado
          await req.pool.query(
            "UPDATE contatos SET whatsapp_verificado = true, ultimo_verificado = NOW() WHERE id = $1",
            [id],
          );

          validados.push({
            id,
            telefone: contato.telefone_normalizado,
          });
        } else {
          invalidos.push({
            id,
            telefone: contato.telefone_normalizado,
          });
        }
      } catch (erro) {
        console.error(`Erro validando contato ${id}:`, erro.message);
      }
    }

    res.json({
      sucesso: true,
      validados: validados.length,
      invalidos: invalidos.length,
      detalhes: {
        validados,
        invalidos,
      },
    });
  } catch (erro) {
    console.error("[✗] Erro ao validar contatos:", erro);
    res.status(500).json({ erro: erro.message });
  }
});

/**
 * GET /api/contatos/exportar/csv
 * Exporta contatos em CSV
 */
router.get("/exportar/csv", async (req, res) => {
  try {
    const { filtro } = req.query;

    let query = "SELECT * FROM contatos";
    const params = [];

    if (filtro === "verificados") {
      query += " WHERE whatsapp_verificado = true";
    }

    query += " ORDER BY nome ASC";

    const result = await req.pool.query(query, params);
    const contatos = result.rows;

    // Montar CSV
    const headers = ["Nome", "Telefone", "Telefone Normalizado", "Email", "Empresa", "Cargo", "WhatsApp Verificado", "Data Criação"];
    const linhas = [headers.join(",")];

    contatos.forEach((contato) => {
      const linha = [
        contato.nome || "",
        contato.telefone || "",
        contato.telefone_normalizado || "",
        contato.email || "",
        contato.empresa || "",
        contato.cargo || "",
        contato.whatsapp_verificado ? "Sim" : "Não",
        new Date(contato.created_at).toLocaleDateString("pt-BR"),
      ];

      linhas.push(
        linha
          .map((cell) => `"${cell.toString().replace(/"/g, '""')}"`)
          .join(","),
      );
    });

    const csv = linhas.join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="contatos.csv"');
    res.send(csv);
  } catch (erro) {
    console.error("[✗] Erro ao exportar contatos:", erro);
    res.status(500).json({ erro: erro.message });
  }
});

/**
 * DELETE /api/contatos
 * Deleta múltiplos contatos
 */
router.delete("/", async (req, res) => {
  try {
    const { ids } = req.body;

    if (!ids || ids.length === 0) {
      return res.status(400).json({ erro: "IDs são obrigatórios" });
    }

    // Deletar contatos
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(",");
    await req.pool.query(`DELETE FROM contatos WHERE id IN (${placeholders})`, ids);

    // Registrar atividade
    await req.pool.query(
      `INSERT INTO atividades (tipo, descricao, dados_adicionais)
       VALUES ($1, $2, $3)`,
      ["contatos_deletados", `${ids.length} contatos deletados`, { quantidade: ids.length }],
    );

    res.json({
      sucesso: true,
      deletados: ids.length,
    });
  } catch (erro) {
    console.error("[✗] Erro ao deletar contatos:", erro);
    res.status(500).json({ erro: erro.message });
  }
});

export default router;
