// ==========================================
// ROTAS DE TEMPLATES E RELATÓRIOS
// ==========================================

import express from "express";
const router = express.Router();

// ==========================================
// TEMPLATES
// ==========================================

/**
 * GET /api/templates
 * Lista todos os templates
 */
router.get("/templates", async (req, res) => {
  try {
    const { ativo, categoria, limite = 20, offset = 0 } = req.query;

    let query = "SELECT * FROM templates WHERE 1=1";
    const params = [];
    let paramCount = 1;

    if (ativo === "true") {
      query += ` AND ativo = true`;
    } else if (ativo === "false") {
      query += ` AND ativo = false`;
    }

    if (categoria) {
      query += ` AND categoria = $${paramCount}`;
      params.push(categoria);
      paramCount++;
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    params.push(parseInt(limite), parseInt(offset));

    const result = await req.pool.query(query, params);
    res.json({
      templates: result.rows,
      total: result.rows.length,
    });
  } catch (erro) {
    console.error("[✗] Erro ao listar templates:", erro);
    res.status(500).json({ erro: erro.message });
  }
});

/**
 * GET /api/templates/:id
 * Obter detalhes de um template
 */
router.get("/templates/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await req.pool.query("SELECT * FROM templates WHERE id = $1", [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ erro: "Template não encontrado" });
    }

    res.json(result.rows[0]);
  } catch (erro) {
    console.error("[✗] Erro ao obter template:", erro);
    res.status(500).json({ erro: erro.message });
  }
});

/**
 * POST /api/templates
 * Criar novo template
 */
router.post("/templates", async (req, res) => {
  try {
    const { nome, conteudo, variaveis, categoria, descricao } = req.body;

    if (!nome || !conteudo) {
      return res.status(400).json({
        erro: "Nome e conteúdo são obrigatórios",
      });
    }

    const result = await req.pool.query(
      `INSERT INTO templates (nome, conteudo, variaveis, categoria, descricao, ativo)
       VALUES ($1, $2, $3, $4, $5, true)
       RETURNING *`,
      [nome, conteudo, variaveis || null, categoria || "geral", descricao || ""],
    );

    // Registrar atividade
    await req.pool.query(
      `INSERT INTO atividades (tipo, descricao, dados_adicionais)
       VALUES ($1, $2, $3)`,
      ["template_criado", `Template "${nome}" criado`, { template_id: result.rows[0].id }],
    );

    res.status(201).json({
      sucesso: true,
      template: result.rows[0],
    });
  } catch (erro) {
    console.error("[✗] Erro ao criar template:", erro);
    res.status(500).json({ erro: erro.message });
  }
});

/**
 * PUT /api/templates/:id
 * Editar template
 */
router.put("/templates/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, conteudo, variaveis, categoria, descricao, ativo } = req.body;

    const result = await req.pool.query(
      `UPDATE templates 
       SET nome = COALESCE($1, nome),
           conteudo = COALESCE($2, conteudo),
           variaveis = COALESCE($3, variaveis),
           categoria = COALESCE($4, categoria),
           descricao = COALESCE($5, descricao),
           ativo = COALESCE($6, ativo),
           updated_at = NOW()
       WHERE id = $7
       RETURNING *`,
      [nome, conteudo, variaveis, categoria, descricao, ativo, id],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ erro: "Template não encontrado" });
    }

    res.json({
      sucesso: true,
      template: result.rows[0],
    });
  } catch (erro) {
    console.error("[✗] Erro ao editar template:", erro);
    res.status(500).json({ erro: erro.message });
  }
});

/**
 * DELETE /api/templates/:id
 * Deletar template
 */
router.delete("/templates/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const templateResult = await req.pool.query("SELECT * FROM templates WHERE id = $1", [id]);

    if (templateResult.rows.length === 0) {
      return res.status(404).json({ erro: "Template não encontrado" });
    }

    const template = templateResult.rows[0];

    // Verificar se está sendo usado
    const campanhasResult = await req.pool.query(
      "SELECT COUNT(*) FROM campanhas WHERE template_id = $1",
      [id],
    );

    if (parseInt(campanhasResult.rows[0].count) > 0) {
      return res.status(400).json({
        erro: "Não é possível deletar template que está siendo usado",
      });
    }

    await req.pool.query("DELETE FROM templates WHERE id = $1", [id]);

    res.json({
      sucesso: true,
      mensagem: "Template deletado com sucesso",
    });
  } catch (erro) {
    console.error("[✗] Erro ao deletar template:", erro);
    res.status(500).json({ erro: erro.message });
  }
});

// ==========================================
// RELATÓRIOS
// ==========================================

/**
 * GET /api/relatorios/geral
 * Relatório geral do sistema
 */
router.get("/relatorios/geral", async (req, res) => {
  try {
    const { dataInicio, dataFim } = req.query;

    // Montar query com filtro de data
    let filtroData = "1=1";
    if (dataInicio && dataFim) {
      filtroData = `enviado_em BETWEEN '${dataInicio}' AND '${dataFim}'`;
    }

    // Estatísticas gerais
    const statsResult = await req.pool.query(
      `SELECT 
        COUNT(*) as total_mensagens,
        SUM(CASE WHEN status = 'enviado' THEN 1 ELSE 0 END) as enviadas,
        SUM(CASE WHEN status = 'entregue' THEN 1 ELSE 0 END) as entregues,
        SUM(CASE WHEN status = 'lido' THEN 1 ELSE 0 END) as lidas,
        SUM(CASE WHEN status = 'falha' THEN 1 ELSE 0 END) as falhas
       FROM mensagens_enviadas
       WHERE ${filtroData}`,
    );

    const stats = statsResult.rows[0];

    // Calcular taxas
    const taxaEntrega = stats.total_mensagens > 0 ? 
      ((parseInt(stats.entregues || 0) / parseInt(stats.total_mensagens)) * 100).toFixed(2) : 0;
    const taxaErro = stats.total_mensagens > 0 ?
      ((parseInt(stats.falhas || 0) / parseInt(stats.total_mensagens)) * 100).toFixed(2) : 0;

    // Campanhas em andamento
    const campanhasResult = await req.pool.query(
      `SELECT status, COUNT(*) as total FROM campanhas GROUP BY status`,
    );

    // Total de contatos
    const contatosResult = await req.pool.query("SELECT COUNT(*) as total FROM contatos");

    res.json({
      resumoGeral: {
        total_mensagens: parseInt(stats.total_mensagens) || 0,
        enviadas: parseInt(stats.enviadas) || 0,
        entregues: parseInt(stats.entregues) || 0,
        lidas: parseInt(stats.lidas) || 0,
        falhas: parseInt(stats.falhas) || 0,
        taxa_entrega: taxaEntrega,
        taxa_erro: taxaErro,
      },
      campanhas: campanhasResult.rows,
      contatos_totais: parseInt(contatosResult.rows[0].total),
    });
  } catch (erro) {
    console.error("[✗] Erro ao obter relatório geral:", erro);
    res.status(500).json({ erro: erro.message });
  }
});

/**
 * GET /api/relatorios/campanha/:id
 * Relatório detalhado de uma campanha
 */
router.get("/relatorios/campanha/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Dados da campanha
    const campanhaResult = await req.pool.query(
      "SELECT * FROM campanhas WHERE id = $1",
      [id],
    );

    if (campanhaResult.rows.length === 0) {
      return res.status(404).json({ erro: "Campanha não encontrada" });
    }

    const campanha = campanhaResult.rows[0];

    // Mensagens por status
    const mensagensResult = await req.pool.query(
      `SELECT status, COUNT(*) as total 
       FROM mensagens_enviadas 
       WHERE campanha_id = $1 
       GROUP BY status`,
      [id],
    );

    // Erros mais comuns
    const errosResult = await req.pool.query(
      `SELECT erro, COUNT(*) as total 
       FROM mensagens_enviadas 
       WHERE campanha_id = $1 AND status = 'falha'
       GROUP BY erro
       ORDER BY total DESC
       LIMIT 5`,
      [id],
    );

    // Envios ao longo do tempo (últimos 7 dias)
    const historico = await req.pool.query(
      `SELECT DATE(enviado_em) as data, COUNT(*) as total
       FROM mensagens_enviadas
       WHERE campanha_id = $1 AND enviado_em >= NOW() - INTERVAL '7 days'
       GROUP BY DATE(enviado_em)
       ORDER BY data ASC`,
      [id],
    );

    // Calcular taxa de entrega
    const totalMensagens = mensagensResult.rows.reduce((acc, row) => acc + parseInt(row.total), 0);
    const entregues = mensagensResult.rows.find((row) => row.status === "entregue")?.total || 0;
    const taxaEntrega = totalMensagens > 0 ? 
      ((parseInt(entregues) / totalMensagens) * 100).toFixed(2) : 0;

    res.json({
      campanha: {
        id: campanha.id,
        nome: campanha.nome,
        status: campanha.status,
        data_inicio: campanha.data_inicio,
        data_fim: campanha.data_fim,
        total_contatos: campanha.total_contatos,
      },
      estatisticas: {
        total_mensagens: totalMensagens,
        detalhamento: mensagensResult.rows,
        taxa_entrega: taxaEntrega,
      },
      erros_comuns: errosResult.rows,
      historico_envios: historico.rows,
    });
  } catch (erro) {
    console.error("[✗] Erro ao obter relatório de campanha:", erro);
    res.status(500).json({ erro: erro.message });
  }
});

/**
 * GET /api/relatorios/exportar/:id
 * Exporta relatório de campanha em CSV
 */
router.get("/relatorios/exportar/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await req.pool.query(
      `SELECT telefone, nome_contato, status, erro, enviado_em
       FROM mensagens_enviadas
       WHERE campanha_id = $1
       ORDER BY enviado_em DESC`,
      [id],
    );

    const mensagens = result.rows;

    // Montar CSV
    const headers = ["Telefone", "Nome Contato", "Status", "Erro", "Data Envio"];
    const linhas = [headers.join(",")];

    mensagens.forEach((msg) => {
      const linha = [
        msg.telefone,
        msg.nome_contato || "",
        msg.status,
        msg.erro || "",
        new Date(msg.enviado_em).toLocaleString("pt-BR"),
      ];

      linhas.push(
        linha
          .map((cell) => `"${cell.toString().replace(/"/g, '""')}"`)
          .join(","),
      );
    });

    const csv = linhas.join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="relatorio_campanha_${id}.csv"`,
    );
    res.send(csv);
  } catch (erro) {
    console.error("[✗] Erro ao exportar relatório:", erro);
    res.status(500).json({ erro: erro.message });
  }
});

/**
 * GET /api/relatorios/grafico/envios
 * Dados para gráfico de envios (últimos 30 dias)
 */
router.get("/relatorios/grafico/envios", async (req, res) => {
  try {
    const result = await req.pool.query(
      `SELECT DATE(enviado_em) as data, COUNT(*) as total
       FROM mensagens_enviadas
       WHERE enviado_em >= NOW() - INTERVAL '30 days'
       GROUP BY DATE(enviado_em)
       ORDER BY data ASC`,
    );

    res.json({
      dados: result.rows.map((row) => ({
        data: row.data,
        envios: parseInt(row.total),
      })),
    });
  } catch (erro) {
    console.error("[✗] Erro ao obter dados de gráfico:", erro);
    res.status(500).json({ erro: erro.message });
  }
});

/**
 * GET /api/relatorios/grafico/status
 * Dados para gráfico de status (pizza)
 */
router.get("/relatorios/grafico/status", async (req, res) => {
  try {
    const result = await req.pool.query(
      `SELECT status, COUNT(*) as total
       FROM mensagens_enviadas
       GROUP BY status`,
    );

    const statusMap = {
      enviado: "Enviado",
      entregue: "Entregue",
      lido: "Lido",
      falha: "Falha",
    };

    const dados = result.rows.map((row) => ({
      status: statusMap[row.status] || row.status,
      total: parseInt(row.total),
    }));

    res.json({ dados });
  } catch (erro) {
    console.error("[✗] Erro ao obter dados de status:", erro);
    res.status(500).json({ erro: erro.message });
  }
});

export default router;
