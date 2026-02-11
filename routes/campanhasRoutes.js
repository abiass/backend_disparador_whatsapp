// ==========================================
// ROTAS DE CAMPANHAS
// ==========================================

import express from "express";
const router = express.Router();

/**
 * GET /api/campanhas
 * Lista todas as campanhas com filtros opcionais
 */
router.get("/", async (req, res) => {
  try {
    const { status, busca, limite = 20, offset = 0 } = req.query;

    let query = "SELECT * FROM campanhas WHERE 1=1";
    const params = [];
    let paramCount = 1;

    // Filtro por status
    if (status) {
      query += ` AND status = $${paramCount}`;
      params.push(status);
      paramCount++;
    }

    // Busca por nome
    if (busca) {
      query += ` AND nome ILIKE $${paramCount}`;
      params.push(`%${busca}%`);
      paramCount++;
    }

    // Ordenação e paginação
    query += ` ORDER BY created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    params.push(limite, offset);

    const result = await req.pool.query(query, params);

    // Contar total
    let countQuery = "SELECT COUNT(*) FROM campanhas WHERE 1=1";
    const countParams = [];
    let countParamCount = 1;

    if (status) {
      countQuery += ` AND status = $${countParamCount}`;
      countParams.push(status);
      countParamCount++;
    }

    if (busca) {
      countQuery += ` AND nome ILIKE $${countParamCount}`;
      countParams.push(`%${busca}%`);
    }

    const countResult = await req.pool.query(countQuery, countParams);
    const total = parseInt(countResult.rows[0].count);

    res.json({
      campanhas: result.rows,
      total,
      pagina: Math.floor(offset / limite) + 1,
      limite: parseInt(limite),
    });
  } catch (erro) {
    console.error("[✗] Erro ao listar campanhas:", erro);
    res.status(500).json({ erro: erro.message });
  }
});

/**
 * GET /api/campanhas/:id
 * Obter detalhes de uma campanha específica
 */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Buscar campanha
    const campanhaResult = await req.pool.query("SELECT * FROM campanhas WHERE id = $1", [id]);

    if (campanhaResult.rows.length === 0) {
      return res.status(404).json({ erro: "Campanha não encontrada" });
    }

    const campanha = campanhaResult.rows[0];

    // Buscar template
    const templateResult = await req.pool.query("SELECT * FROM templates WHERE id = $1", [
      campanha.template_id,
    ]);

    // Buscar contatos
    const contatosResult = await req.pool.query(
      `SELECT cc.status, COUNT(*) as total 
       FROM campanha_contatos cc 
       WHERE cc.campanha_id = $1 
       GROUP BY cc.status`,
      [id],
    );

    // Montar resposta com estatísticas detalhadas
    const estatisticas = {
      total_contatos: campanha.total_contatos,
      enviados: campanha.enviados,
      entregues: campanha.entregues,
      falhas: campanha.falhas,
      pendentes: campanha.total_contatos - campanha.enviados - campanha.falhas,
    };

    res.json({
      campanha,
      template: templateResult.rows[0] || null,
      estatisticas,
      detalhamentoStatus: contatosResult.rows,
    });
  } catch (erro) {
    console.error("[✗] Erro ao obter campanha:", erro);
    res.status(500).json({ erro: erro.message });
  }
});

/**
 * POST /api/campanhas
 * Criar nova campanha
 */
router.post("/", async (req, res) => {
  try {
    const {
      nome,
      descricao,
      template_id,
      mensagem_template,
      contatos_selecionados,
      contatos,
      intervalo_min = 5,
      intervalo_max = 13,
      limite_por_hora = 30,
      data_agendamento = null,
    } = req.body;

    // Usar contatos_selecionados ou contatos (compatibilidade)
    const listaContatos = contatos_selecionados || contatos;

    // Validações
    if (!nome) {
      return res.status(400).json({
        erro: "Nome da campanha é obrigatório",
      });
    }

    if (!mensagem_template || mensagem_template.trim().length < 10) {
      return res.status(400).json({
        erro: "Mensagem é obrigatória e deve ter pelo menos 10 caracteres",
      });
    }

    if (!listaContatos || listaContatos.length === 0) {
      return res.status(400).json({
        erro: "Selecione pelo menos um contato",
      });
    }

    // Determinar status
    const status = data_agendamento ? "agendada" : "rascunho";

    // Converter data vazia para null
    const dataAgendamentoFinal = data_agendamento && data_agendamento.trim() !== '' ? data_agendamento : null;

    // Criar campanha
    const campanhaResult = await req.pool.query(
      `INSERT INTO campanhas 
       (nome, descricao, status, template_id, mensagem_template, intervalo_min, intervalo_max, limite_por_hora, data_agendamento, total_contatos)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [nome, descricao, status, template_id || null, mensagem_template, intervalo_min, intervalo_max, limite_por_hora, dataAgendamentoFinal, listaContatos.length],
    );

    const campanha = campanhaResult.rows[0];

    // Adicionar contatos à campanha
    const contatosValidos = [];
    for (const contatoId of listaContatos) {
      // Validar se contato existe
      const contatoResult = await req.pool.query(
        "SELECT id FROM contatos WHERE id = $1",
        [contatoId],
      );

      if (contatoResult.rows.length > 0) {
        await req.pool.query(
          `INSERT INTO campanha_contatos (campanha_id, contato_id, status)
           VALUES ($1, $2, 'pendente')
           ON CONFLICT (campanha_id, contato_id) DO NOTHING`,
          [campanha.id, contatoId],
        );
        contatosValidos.push(contatoId);
      }
    }

    // Registrar atividade
    await req.pool.query(
      `INSERT INTO atividades (tipo, descricao, dados_adicionais)
       VALUES ($1, $2, $3)`,
      ["campanha_criada", `Campanha "${nome}" criada com ${contatosValidos.length} contatos`, { campanha_id: campanha.id, contatos: contatosValidos.length }],
    );

    res.status(201).json({
      sucesso: true,
      campanha: {
        ...campanha,
        contatos_adicionados: contatosValidos.length,
      },
    });
  } catch (erro) {
    console.error("[✗] Erro ao criar campanha:", erro);
    res.status(500).json({ erro: erro.message });
  }
});

/**
 * POST /api/campanhas/:id/iniciar
 * Inicia uma campanha (coloca na fila de disparo)
 */
router.post("/:id/iniciar", async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`\n[RUN] Tentando iniciar campanha #${id}`);
    
    const filaDisparo = req.app.get("filaDisparo");
    console.log(`[Q] FilaDisparo disponível:`, !!filaDisparo);

    // Validar campanha
    const campanhaResult = await req.pool.query("SELECT * FROM campanhas WHERE id = $1", [id]);

    if (campanhaResult.rows.length === 0) {
      return res.status(404).json({ erro: "Campanha não encontrada" });
    }

    const campanha = campanhaResult.rows[0];

    if (campanha.status === "em_andamento") {
      return res.status(400).json({ erro: "Campanha já está em andamento" });
    }

    // Registrar atividade
    await req.pool.query(
      `INSERT INTO atividades (tipo, descricao, dados_adicionais)
       VALUES ($1, $2, $3)`,
      ["campanha_iniciada", `Campanha "${campanha.nome}" iniciada`, { campanha_id: campanha.id }],
    );

    // Iniciar processamento assíncrono sem bloquear a resposta
    if (filaDisparo) {
      console.log(`[✓] Iniciando processamento da campanha #${id}`);
      filaDisparo.processar(id).catch((erro) => {
        console.error(`[✗] Erro ao processar campanha #${id}:`, erro);
      });
    } else {
      console.error("[✗] FilaDisparo não foi inicializada! Verifique se o WhatsApp está conectado.");
      return res.status(503).json({
        sucesso: false,
        mensagem: "WhatsApp não está conectado. Aguarde a conexão.",
      });
    }

    res.json({
      sucesso: true,
      mensagem: "Campanha iniciada com sucesso",
      campanha_id: id,
    });
  } catch (erro) {
    console.error("[✗] Erro ao iniciar campanha:", erro);
    res.status(500).json({ erro: erro.message });
  }
});

/**
 * POST /api/campanhas/:id/pausar
 * Pausa uma campanha em andamento
 */
router.post("/:id/pausar", async (req, res) => {
  try {
    const { id } = req.params;
    const filaDisparo = req.app.get("filaDisparo");

    // Pausar a fila
    if (filaDisparo && filaDisparo.campanhaAtiva === parseInt(id)) {
      filaDisparo.pausar();
    }

    // Atualizar status no banco
    const result = await req.pool.query(
      "UPDATE campanhas SET status = 'pausada', updated_at = NOW() WHERE id = $1 RETURNING *",
      [id],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ erro: "Campanha não encontrada" });
    }

    // Registrar atividade
    await req.pool.query(
      `INSERT INTO atividades (tipo, descricao, dados_adicionais)
       VALUES ($1, $2, $3)`,
      ["campanha_pausada", `Campanha "${result.rows[0].nome}" pausada`, { campanha_id: id }],
    );

    res.json({
      sucesso: true,
      mensagem: "Campanha pausada",
      campanha: result.rows[0],
    });
  } catch (erro) {
    console.error("[✗] Erro ao pausar campanha:", erro);
    res.status(500).json({ erro: erro.message });
  }
});

/**
 * POST /api/campanhas/:id/retomar
 * Retoma uma campanha pausada
 */
router.post("/:id/retomar", async (req, res) => {
  try {
    const { id } = req.params;
    const filaDisparo = req.app.get("filaDisparo");

    // Retomar a fila
    if (filaDisparo && filaDisparo.campanhaAtiva === parseInt(id)) {
      filaDisparo.retomar();
    }

    // Atualizar status
    const result = await req.pool.query(
      "UPDATE campanhas SET status = 'em_andamento', updated_at = NOW() WHERE id = $1 RETURNING *",
      [id],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ erro: "Campanha não encontrada" });
    }

    // Registrar atividade
    await req.pool.query(
      `INSERT INTO atividades (tipo, descricao, dados_adicionais)
       VALUES ($1, $2, $3)`,
      ["campanha_retomada", `Campanha "${result.rows[0].nome}" retomada`, { campanha_id: id }],
    );

    res.json({
      sucesso: true,
      mensagem: "Campanha retomada",
      campanha: result.rows[0],
    });
  } catch (erro) {
    console.error("[✗] Erro ao retomar campanha:", erro);
    res.status(500).json({ erro: erro.message });
  }
});

/**
 * DELETE /api/campanhas/:id
 * Deleta uma campanha
 */
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Buscar campanha antes de deletar
    const campanhaResult = await req.pool.query("SELECT * FROM campanhas WHERE id = $1", [id]);

    if (campanhaResult.rows.length === 0) {
      return res.status(404).json({ erro: "Campanha não encontrada" });
    }

    const campanha = campanhaResult.rows[0];

    // Verificar se está em andamento
    if (campanha.status === "em_andamento") {
      return res.status(400).json({
        erro: "Não é possível deletar campanha em andamento. Pause-a primeiro.",
      });
    }

    // Deletar campanha (cascata delete os contatos)
    await req.pool.query("DELETE FROM campanhas WHERE id = $1", [id]);

    // Registrar atividade
    await req.pool.query(
      `INSERT INTO atividades (tipo, descricao, dados_adicionais)
       VALUES ($1, $2, $3)`,
      ["campanha_deletada", `Campanha "${campanha.nome}" deletada`, { campanha_id: id }],
    );

    res.json({
      sucesso: true,
      mensagem: "Campanha deletada com sucesso",
    });
  } catch (erro) {
    console.error("[✗] Erro ao deletar campanha:", erro);
    res.status(500).json({ erro: erro.message });
  }
});

/**
 * PUT /api/campanhas/:id
 * Edita uma campanha (apenas rascunho ou agendada)
 */
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, descricao, template_id, intervalo_min, intervalo_max, limite_por_hora, contatos } = req.body;

    // Validar campanha
    const campanhaResult = await req.pool.query("SELECT * FROM campanhas WHERE id = $1", [id]);

    if (campanhaResult.rows.length === 0) {
      return res.status(404).json({ erro: "Campanha não encontrada" });
    }

    const campanha = campanhaResult.rows[0];

    // Não permite editar se em andamento ou concluída
    if (["em_andamento", "concluida", "erro"].includes(campanha.status)) {
      return res.status(400).json({
        erro: "Não é possível editar campanha neste status",
      });
    }

    // Atualizar campanha
    const updateResult = await req.pool.query(
      `UPDATE campanhas 
       SET nome = COALESCE($1, nome),
           descricao = COALESCE($2, descricao),
           template_id = COALESCE($3, template_id),
           intervalo_min = COALESCE($4, intervalo_min),
           intervalo_max = COALESCE($5, intervalo_max),
           limite_por_hora = COALESCE($6, limite_por_hora),
           updated_at = NOW()
       WHERE id = $7
       RETURNING *`,
      [nome, descricao, template_id, intervalo_min, intervalo_max, limite_por_hora, id],
    );

    // Atualizar contatos se fornecidos
    if (contatos && contatos.length > 0) {
      // Deletar contatos antigos
      await req.pool.query("DELETE FROM campanha_contatos WHERE campanha_id = $1", [id]);

      // Adicionar novos contatos
      for (const contatoId of contatos) {
        await req.pool.query(
          `INSERT INTO campanha_contatos (campanha_id, contato_id, status)
           VALUES ($1, $2, 'pendente')`,
          [id, contatoId],
        );
      }

      // Atualizar total_contatos
      await req.pool.query(
        "UPDATE campanhas SET total_contatos = $1 WHERE id = $2",
        [contatos.length, id],
      );
    }

    res.json({
      sucesso: true,
      mensagem: "Campanha atualizada com sucesso",
      campanha: updateResult.rows[0],
    });
  } catch (erro) {
    console.error("[✗] Erro ao atualizar campanha:", erro);
    res.status(500).json({ erro: erro.message });
  }
});

export default router;
