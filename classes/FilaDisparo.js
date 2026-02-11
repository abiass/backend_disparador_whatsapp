// ==========================================
// FILA INTELIGENTE DE DISPARO
// Sistema de anti-ban e controle de envios
// ==========================================

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FilaDisparo {
  constructor(wppClient, pool, io) {
    this.wppClient = wppClient;
    this.pool = pool;
    this.io = io;
    this.fila = [];
    this.pausada = false;
    this.campanhaAtiva = null;
    this.processando = false;

    this.estatisticas = {
      enviadosUltimaHora: 0,
      horaInicio: Date.now(),
      errosConsecutivos: 0,
      taxaErroAtual: 0,
      mensagensEnviadasHoje: 0,
      ultimoEnvio: null,
    };

    this.limites = {
      intervaloMin: 5,
      intervaloMax: 13,
      limitePorHora: 30,
      mensagensAntesDeParusa: 20,
      duracaoParusa: 10 * 60 * 1000, // 10 minutos
      taxaErroMaxima: 50, // 50%
      minimoEnviosParaVerificarErro: 20, // Só verifica taxa após 20 mensagens
    };
  }

  /**
   * Adiciona contatos à fila para processamento
   */
  async adicionarContatos(campanha, contatos, template) {
    console.log(
      `\n📋 Adicionando ${contatos.length} contatos à fila da campanha "${campanha.nome}"...`,
    );

    contatos.forEach((contato) => {
      this.fila.push({
        id: `${campanha.id}_${contato.id}`,
        campanhaId: campanha.id,
        contatoId: contato.id,
        nome: contato.nome,
        telefone: contato.telefone_normalizado,
        template: template.conteudo,
        variaveisContato: {
          nome: contato.nome,
          empresa: contato.empresa || "Não informado",
          telefone: contato.telefone,
          cargo: contato.cargo || "Não informado",
        },
        tentativas: 0,
        maxTentativas: 3,
      });
    });

    console.log(`✅ ${this.fila.length} itens na fila`);
  }

  /**
   * Retorna intervalo aleatório entre min e max
   */
  getIntervaloAleatorio(min, max) {
    return (Math.random() * (max - min) + min) * 1000;
  }

  /**
   * Verifica se pode enviar baseado no limite por hora
   */
  podeEnviar(limitePorHora) {
    const agora = Date.now();
    const umHora = 60 * 60 * 1000;

    // Reset a cada hora
    if (agora - this.estatisticas.horaInicio > umHora) {
      console.log(`\n🔄 Resetando contador de hora. Enviados: ${this.estatisticas.enviadosUltimaHora}`);
      this.estatisticas.enviadosUltimaHora = 0;
      this.estatisticas.horaInicio = agora;
    }

    return this.estatisticas.enviadosUltimaHora < limitePorHora;
  }

  /**
   * Verifica se está dentro do horário comercial
   */
  isHorarioComercial() {
    const agora = new Date();
    const hora = agora.getHours();
    const diaSemana = agora.getDay();

    // Domingo (0) não envia
    if (diaSemana === 0 && this.limites.pausarFimSemana) {
      return false;
    }

    // Fora do horário 9h-21h
    if (hora < 9 || hora >= 21) {
      return false;
    }

    return true;
  }

  /**
   * Normaliza número de telefone brasileiro para o formato DDD + 8 dígitos
   * Remove o 9 adicional da Anatel para compatibilidade com WhatsApp
   */
  normalizarTelefone(telefone) {
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

  /**
   * Formata número para uso no WhatsApp (com DDI 55 e sufixo @c.us)
   */
  formatarNumeroWhatsapp(telefone) {
    const numeroNormalizado = this.normalizarTelefone(telefone);

    if (!numeroNormalizado) {
      return null;
    }

    const numeroComDDI = `55${numeroNormalizado}`;
    const numeroFormatado = `${numeroComDDI}@c.us`;

    return {
      numeroNormalizado,
      numeroComDDI,
      numeroFormatado,
    };
  }

  /**
   * Personaliza a mensagem com dados do contato
   */
  personalizarMensagem(template, variaveisContato) {
    let mensagem = template;

    // Aplicar variacoes do tipo {{opcao1|opcao2|opcao3}}
    const variacaoRegex = /\{\{([^{}]+)\}\}/g;
    mensagem = mensagem.replace(variacaoRegex, (match, opcoesRaw) => {
      const opcoes = opcoesRaw
        .split("|")
        .map((op) => op.trim())
        .filter(Boolean);
      if (opcoes.length === 0) return "";
      const escolha = opcoes[Math.floor(Math.random() * opcoes.length)];
      return escolha;
    });

    Object.entries(variaveisContato).forEach(([chave, valor]) => {
      const regex = new RegExp(`{${chave}}`, "gi");
      mensagem = mensagem.replace(regex, valor || "");
    });

    return mensagem;
  }

  /**
   * Valida se número existe no WhatsApp
   */
  async validarNumero(telefone) {
    try {
      const infoNumero = this.formatarNumeroWhatsapp(telefone);

      if (!infoNumero) {
        console.error(`⚠️ Não foi possível normalizar o número: ${telefone}`);
        return false;
      }

      // Verifica se o número existe no WhatsApp
      const existe = await this.wppClient.isRegisteredUser(infoNumero.numeroFormatado);

      return existe;
    } catch (erro) {
      console.error(`⚠️ Erro ao validar número ${telefone}:`, erro.message);
      return false;
    }
  }

  /**
   * Envia mensagem via WhatsApp
   */
  async enviarMensagem(telefone, mensagem) {
    try {
      const infoNumero = this.formatarNumeroWhatsapp(telefone);

      if (!infoNumero) {
        throw new Error(`Não foi possível normalizar o número: ${telefone}`);
      }

      // Validar número antes
      const valido = await this.validarNumero(telefone);
      if (!valido) {
        throw new Error("Número não existe no WhatsApp");
      }

      // Enviar mensagem
      const resultado = await this.wppClient.sendMessage(infoNumero.numeroFormatado, mensagem);

      return {
        sucesso: true,
        id: resultado.id,
        timestamp: Date.now(),
      };
    } catch (erro) {
      return {
        sucesso: false,
        erro: erro.message,
        timestamp: Date.now(),
      };
    }
  }

  /**
   * Registra envio no banco de dados
   */
  async registrarEnvio(campanhaId, contatoId, telefone, nome, mensagem, status, erro = null) {
    try {
      const query = `
        INSERT INTO mensagens_enviadas 
        (campanha_id, contato_id, telefone, nome_contato, mensagem, status, erro, enviado_em)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        RETURNING id;
      `;

      const result = await this.pool.query(query, [campanhaId, contatoId, telefone, nome, mensagem, status, erro]);

      return result.rows[0];
    } catch (erro) {
      console.error("❌ Erro ao registrar envio:", erro);
      throw erro;
    }
  }

  /**
   * Atualiza estatísticas da campanha
   */
  async atualizarEstatisticasCampanha(campanhaId, campo) {
    try {
      const query = `
        UPDATE campanhas 
        SET ${campo} = ${campo} + 1, updated_at = NOW()
        WHERE id = $1
        RETURNING *;
      `;

      const result = await this.pool.query(query, [campanhaId]);
      return result.rows[0];
    } catch (erro) {
      console.error("❌ Erro ao atualizar estatísticas:", erro);
    }
  }

  /**
   * Notifica frontend via WebSocket
   */
  notificarProgresso(campanhaId, dados) {
    if (this.io) {
      this.io.emit("disparador:progresso", {
        campanhaId,
        timestamp: Date.now(),
        ...dados,
      });
    }
  }

  /**
   * Aguarda de forma assíncrona
   */
  async aguardar(ms) {
    return sleep(ms);
  }

  /**
   * Verifica se taxa de erro é muito alta
   */
  verificarTaxaErro(totalEnviados, falhas) {
    if (totalEnviados === 0) return false;

    // Só verifica taxa de erro após mínimo de envios
    if (totalEnviados < this.limites.minimoEnviosParaVerificarErro) {
      return false;
    }

    const taxa = (falhas / totalEnviados) * 100;
    this.estatisticas.taxaErroAtual = taxa;

    if (taxa > this.limites.taxaErroMaxima) {
      console.error(
        `\n🚨 TAXA DE ERRO CRÍTICA! ${taxa.toFixed(2)}% (${falhas}/${totalEnviados})`,
      );
      console.error(
        `⚠️ Limite: ${this.limites.taxaErroMaxima}% | Aguarde análise antes de retomar`,
      );
      return true;
    }

    return false;
  }

  /**
   * Pausa a fila automaticamente
   */
  pausar() {
    console.log("\n⏸️ Fila pausada pelo usuário");
    this.pausada = true;
  }

  /**
   * Retoma a fila
   */
  retomar() {
    console.log("\n▶️ Fila retomada");
    this.pausada = false;
  }

  /**
   * Esvazia a fila
   */
  limpar() {
    console.log("\n🗑️ Fila limpa");
    this.fila = [];
  }

  /**
   * Processa a fila com toda a lógica de segurança
   */
  async processar(campanhaId) {
    if (this.processando) {
      console.log("⚠️ Já existe um processamento em andamento. Campanha ativa:", this.campanhaAtiva);
      return;
    }

    this.processando = true;
    this.pausada = false;
    this.campanhaAtiva = campanhaId;

    try {
      console.log(`\n${"=".repeat(60)}`);
      console.log(`🚀 INICIANDO DISPARO DA CAMPANHA #${campanhaId}`);
      console.log(`${"=".repeat(60)}\n`);

      // Buscar dados da campanha
      const campanhaResult = await this.pool.query("SELECT * FROM campanhas WHERE id = $1", [campanhaId]);
      const campanha = campanhaResult.rows[0];

      if (!campanha) {
        throw new Error(`Campanha ${campanhaId} não encontrada`);
      }

      // Atualizar status para em andamento
      await this.pool.query("UPDATE campanhas SET status = $1, data_inicio = NOW() WHERE id = $2", [
        "em_andamento",
        campanhaId,
      ]);

      // Obter contatos da campanha
      const contatosResult = await this.pool.query(
        `SELECT c.* FROM contatos c
         INNER JOIN campanha_contatos cc ON c.id = cc.contato_id
         WHERE cc.campanha_id = $1 AND cc.status = 'pendente'`,
        [campanhaId],
      );

      const contatos = contatosResult.rows;
      console.log(`📞 Total de contatos: ${contatos.length}\n`);

      if (contatos.length === 0) {
        console.log("⚠️ Nenhum contato pendente encontrado!");
        await this.pool.query("UPDATE campanhas SET status = $1 WHERE id = $2", ["concluida", campanhaId]);
        return;
      }

      // Verificar se há mensagem personalizada ou buscar template
      let mensagemTemplate;
      
      if (campanha.mensagem_template) {
        // Usar mensagem personalizada da campanha
        mensagemTemplate = campanha.mensagem_template;
        console.log(`📝 Usando mensagem personalizada da campanha`);
      } else if (campanha.template_id) {
        // Buscar template (retrocompatibilidade)
        const templateResult = await this.pool.query("SELECT * FROM templates WHERE id = $1", [campanha.template_id]);
        const template = templateResult.rows[0];
        
        if (!template) {
          throw new Error(`Template ${campanha.template_id} não encontrado`);
        }
        
        mensagemTemplate = template.conteudo;
        console.log(`📋 Usando template: ${template.nome}`);
      } else {
        throw new Error('Campanha não possui mensagem ou template definido');
      }

      // Criar objeto template para compatibilidade
      const templateObj = {
        conteudo: mensagemTemplate
      };

      // Adicionar contatos à fila
      await this.adicionarContatos(campanha, contatos, templateObj);

      // Processar fila
      let enviados = 0;
      let falhas = 0;
      let contadorParusa = 0;

      while (this.fila.length > 0 && !this.pausada) {
        // Verificar horário comercial (DESATIVADO - permitir envio a qualquer hora)
        // if (!this.isHorarioComercial()) {
        //   console.log("⏸️ Fora do horário comercial. Aguardando 30 minutos...");
        //   await this.aguardar(30 * 60 * 1000);
        //   continue;
        // }

        // Verificar limite por hora
        if (!this.podeEnviar(campanha.limite_por_hora)) {
          console.log(`⚠️ Limite de ${campanha.limite_por_hora} msgs/hora atingido. Aguardando 10 minutos...`);
          this.notificarProgresso(campanhaId, {
            tipo: "aguardando",
            motivo: "limite_hora",
            mensagem: `Limite de ${campanha.limite_por_hora} mensagens/hora atingido`,
          });
          await this.aguardar(10 * 60 * 1000);
          continue;
        }

        // Pegar próximo item da fila
        const item = this.fila.shift();

        try {
          // Personalizar mensagem
          const mensagem = this.personalizarMensagem(item.template, item.variaveisContato);

          // Enviar
          const resultado = await this.enviarMensagem(item.telefone, mensagem);

          if (resultado.sucesso) {
            // Registra no banco
            await this.registrarEnvio(
              campanhaId,
              item.contatoId,
              item.telefone,
              item.nome,
              mensagem,
              "enviado",
            );

            // Atualiza estatísticas da campanha
            await this.atualizarEstatisticasCampanha(campanhaId, "enviados");

            // Atualiza contato no campanha_contatos
            await this.pool.query(
              `UPDATE campanha_contatos 
               SET status = 'enviado', enviado_em = NOW()
               WHERE campanha_id = $1 AND contato_id = $2`,
              [campanhaId, item.contatoId],
            );

            this.estatisticas.enviadosUltimaHora++;
            enviados++;
            contadorParusa++;
            this.estatisticas.errosConsecutivos = 0;

            console.log(`✅ [${enviados}/${contatos.length}] ${item.nome} (${item.telefone})`);

            this.notificarProgresso(campanhaId, {
              tipo: "sucesso",
              contato: item.nome,
              total: contatos.length,
              enviados: enviados,
              fila: this.fila.length,
            });

            // Intervalo aleatório
            const intervalo = this.getIntervaloAleatorio(
              campanha.intervalo_min || 5,
              campanha.intervalo_max || 13,
            );
            await this.aguardar(intervalo);

            // Pausa a cada N mensagens
            if (contadorParusa >= campanha.limite_por_hora) {
              console.log(
                `\n⏸️ Pausa automática após ${contadorParusa} mensagens. Aguardando 5 minutos...`,
              );
              this.notificarProgresso(campanhaId, {
                tipo: "pausa_automatica",
                motivo: "limite_mensagens",
              });
              await this.aguardar(5 * 60 * 1000);
              contadorParusa = 0;
            }
          } else {
            // Registro de falha
            await this.registrarEnvio(
              campanhaId,
              item.contatoId,
              item.telefone,
              item.nome,
              item.template,
              "falha",
              resultado.erro,
            );

            await this.atualizarEstatisticasCampanha(campanhaId, "falhas");

            await this.pool.query(
              `UPDATE campanha_contatos 
               SET status = 'falha', erro = $1, tentativas = tentativas + 1
               WHERE campanha_id = $2 AND contato_id = $3`,
              [resultado.erro, campanhaId, item.contatoId],
            );

            falhas++;
            this.estatisticas.errosConsecutivos++;

            console.error(`❌ ${item.nome}: ${resultado.erro}`);

            this.notificarProgresso(campanhaId, {
              tipo: "erro",
              contato: item.nome,
              erro: resultado.erro,
              falhas: falhas,
            });

            // Verificar taxa de erro
            if (this.verificarTaxaErro(enviados + falhas, falhas)) {
              console.error("\n🛑 PARANDO CAMPANHA: Taxa de erro muito alta!");
              this.pausada = true;
              break;
            }

            // Aguardar antes de tentar novamente
            await this.aguardar(2000);
          }
        } catch (erro) {
          console.error(`❌ Erro crítico ao processar contato:`, erro.message);
          falhas++;

          this.notificarProgresso(campanhaId, {
            tipo: "erro_critico",
            erro: erro.message,
          });

          // Recoloca na fila se ainda tiver tentativas
          if (item.tentativas < item.maxTentativas) {
            item.tentativas++;
            this.fila.push(item);
            console.log(`🔄 Recolocando ${item.nome} na fila (tentativa ${item.tentativas})`);
          }

          await this.aguardar(3000);
        }
      }

      // Finalizar campanha
      const statusFinal = this.pausada ? "pausada" : "concluida";
      await this.pool.query(
        "UPDATE campanhas SET status = $1, data_fim = NOW(), updated_at = NOW() WHERE id = $2",
        [statusFinal, campanhaId],
      );

      console.log(`\n${"=".repeat(60)}`);
      console.log(`📊 RESUMO DO DISPARO DA CAMPANHA #${campanhaId}`);
      console.log(`${"=".repeat(60)}`);
      console.log(`✅ Enviados: ${enviados}`);
      console.log(`❌ Falhas: ${falhas}`);
      console.log(`📚 Total: ${enviados + falhas}/${contatos.length}`);
      console.log(`📈 Taxa de sucesso: ${((enviados / (enviados + falhas)) * 100).toFixed(2)}%`);
      console.log(`Status: ${statusFinal}`);
      console.log(`${"=".repeat(60)}\n`);

      this.notificarProgresso(campanhaId, {
        tipo: "concluida",
        enviados: enviados,
        falhas: falhas,
        status: statusFinal,
      });
    } catch (erro) {
      console.error(`\n🚨 ERRO CRÍTICO NO DISPARO:`, erro.message);

      // Atualizar status da campanha para erro
      await this.pool.query("UPDATE campanhas SET status = $1 WHERE id = $2", ["erro", campanhaId]);

      this.notificarProgresso(campanhaId, {
        tipo: "erro_critico",
        erro: erro.message,
      });
    } finally {
      this.processando = false;
      this.campanhaAtiva = null;
    }
  }
}

export default FilaDisparo;
