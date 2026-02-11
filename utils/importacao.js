// ==========================================
// UTILITÁRIOS DE IMPORTAÇÃO E VALIDAÇÃO
// ==========================================

import csv from "csv-parser";
import { Readable } from "stream";
import XLSX from "xlsx";

/**
 * Normaliza número de telefone brasileiro para o formato DDD + 8 dígitos
 * Remove o 9 adicional da Anatel para compatibilidade com WhatsApp
 */
function normalizarTelefone(telefone) {
  if (!telefone) return null;

  // Remove todos os caracteres não numéricos
  let numero = telefone.toString().replace(/\D/g, '');

  // Remove código do país (55) se presente
  if (numero.startsWith('55') && numero.length > 10) {
    numero = numero.substring(2);
  }

  // Remove zeros à esquerda
  numero = numero.replace(/^0+/, '');

  // Se tiver 11 dígitos (DDD + 9 + 8 dígitos)
  // Remove o 9 adicional da Anatel (terceiro dígito)
  if (numero.length === 11 && numero[2] === '9') {
    // Formato: XX 9 XXXX-XXXX -> XX XXXX-XXXX
    numero = numero.substring(0, 2) + numero.substring(3);
  }

  // Deve ter 10 dígitos no final (DDD + 8 dígitos)
  if (numero.length !== 10) {
    console.warn(`⚠️ Número com formato inesperado após normalização: ${telefone} -> ${numero}`);
    return null;
  }

  // Verificar se contém apenas números
  if (!/^\d+$/.test(numero)) {
    return null;
  }

  return numero;
}

/**
 * Valida estrutura de um email
 */
function validarEmail(email) {
  if (!email) return true; // email é opcional
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return regex.test(email);
}

/**
 * Processa um contato e retorna objeto normalizado ou erro
 * @param {Object} linhaObj - Objeto com os dados da linha (chave-valor)
 * @param {Number} grupoId - ID do grupo de importação (opcional)
 */
function processarContato(linhaObj, grupoId = null) {
  const contato = {};
  let temErros = [];

  // Processar cada campo do objeto
  for (const [chave, valorRaw] of Object.entries(linhaObj)) {
    const valor = (valorRaw || "").toString().trim();
    const chaveLower = chave.toLowerCase();

    // Mapear telefone
    if (["telefone", "phone", "celular", "whatsapp"].includes(chaveLower)) {
      contato.telefone = valor;
      contato.telefone_normalizado = normalizarTelefone(valor);
      if (!contato.telefone_normalizado) {
        temErros.push(`Telefone inválido: ${valor}`);
      }
    }
    // Mapear nome
    else if (["nome", "name", "contato"].includes(chaveLower)) {
      contato.nome = valor || null;
    }
    // Mapear empresa
    else if (["empresa", "company"].includes(chaveLower)) {
      contato.empresa = valor || null;
    }
    // Mapear cargo
    else if (["cargo", "position", "funcao", "função"].includes(chaveLower)) {
      contato.cargo = valor || null;
    }
    // Mapear email
    else if (["email", "e-mail"].includes(chaveLower)) {
      if (valor && !validarEmail(valor)) {
        temErros.push(`Email inválido: ${valor}`);
      }
      contato.email = valor || null;
    }
    // Mapear tags
    else if (["tags", "tag"].includes(chaveLower)) {
      contato.tags = valor ? valor.split(",").map((t) => t.trim()) : [];
    }
    // Ignorar outras colunas
  }

  return {
    contato: temErros.length === 0 ? contato : null,
    erros: temErros,
    valido: temErros.length === 0,
  };
}

/**
 * Processa upload de CSV
 * @param {Buffer} buffer - Conteúdo do arquivo
 * @param {Object} pool - Pool de conexão PostgreSQL
 * @param {Number} grupoId - ID do grupo de importação
 */
async function processarCSV(buffer, pool, grupoId = null) {
  return new Promise((resolve, reject) => {
    const resultados = {
      inseridos: 0,
      atualizados: 0,
      erros: [],
      detalhes: [],
    };

    const stream = Readable.from([buffer]);

    let linhaAtual = 0;

    // Detectar separador (vírgula ou ponto e vírgula)
    const primeiraLinha = buffer.toString('utf8').split('\n')[0];
    const separador = primeiraLinha.includes(';') ? ';' : ',';
    console.log(`🔍 Separador detectado: "${separador}"`);

    stream
      .pipe(csv({ separator: separador }))
      .on("headers", (headers) => {
        // Detectar colunas automaticamente
        console.log(`📋 Colunas detectadas: ${headers.join(", ")}`);
      })
      .on("data", async (linha) => {
        linhaAtual++;

        console.log(`📝 Linha ${linhaAtual}:`, linha);

        // Processar linha (csv-parser já retorna objeto mapeado)
        const { contato, erros, valido } = processarContato(linha);

        if (!valido) {
          resultados.erros.push({
            linha: linhaAtual,
            mensagem: erros.join("; "),
          });
          resultados.detalhes.push({
            linha: linhaAtual,
            status: "erro",
            motivo: erros.join("; "),
          });
          return;
        }

        try {
          // Verificar se contato já existe
          const existente = await pool.query(
            "SELECT id FROM contatos WHERE telefone_normalizado = $1",
            [contato.telefone_normalizado],
          );

          if (existente.rows.length > 0) {
            // Atualizar
            await pool.query(
              `UPDATE contatos 
               SET nome = COALESCE($1, nome),
                   email = COALESCE($2, email),
                   empresa = COALESCE($3, empresa),
                   cargo = COALESCE($4, cargo),
                   tags = CASE WHEN $5::text[] IS NOT NULL THEN $5::text[] ELSE tags END,
                   updated_at = NOW()
               WHERE telefone_normalizado = $6`,
              [
                contato.nome,
                contato.email,
                contato.empresa,
                contato.cargo,
                contato.tags && contato.tags.length > 0 ? contato.tags : null,
                contato.telefone_normalizado,
              ],
            );

            resultados.atualizados++;
            resultados.detalhes.push({
              linha: linhaAtual,
              status: "atualizado",
              telefone: contato.telefone_normalizado,
            });
          } else {
            // Inserir - garantir que telefone não seja nulo
            if (!contato.telefone || !contato.telefone_normalizado) {
              throw new Error('Telefone é obrigatório');
            }
            
            const insertResult = await pool.query(
              `INSERT INTO contatos (nome, telefone, telefone_normalizado, email, empresa, cargo, tags, grupo_importacao_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
               RETURNING id`,
              [
                contato.nome,
                contato.telefone,
                contato.telefone_normalizado,
                contato.email,
                contato.empresa,
                contato.cargo,
                contato.tags && contato.tags.length > 0 ? contato.tags : null,
                grupoId,
              ],
            );

            resultados.inseridos++;
            resultados.detalhes.push({
              linha: linhaAtual,
              status: "inserido",
              telefone: contato.telefone_normalizado,
              id: insertResult.rows[0].id,
            });
          }
        } catch (erro) {
          resultados.erros.push({
            linha: linhaAtual,
            telefone: contato.telefone_normalizado,
            mensagem: erro.message,
          });
          resultados.detalhes.push({
            linha: linhaAtual,
            status: "erro_banco",
            motivo: erro.message,
          });
        }
      })
      .on("end", () => {
        console.log(`\n📊 Importação concluída:`);
        console.log(`   ✅ Inseridos: ${resultados.inseridos}`);
        console.log(`   🔄 Atualizados: ${resultados.atualizados}`);
        console.log(`   ❌ Erros: ${resultados.erros.length}`);

        resolve(resultados);
      })
      .on("error", (erro) => {
        reject(erro);
      });
  });
}

/**
 * Processa upload de Excel
 * @param {Buffer} buffer - Conteúdo do arquivo
 * @param {Object} pool - Pool de conexão PostgreSQL
 * @param {Number} grupoId - ID do grupo de importação
 */
async function processarExcel(buffer, pool, grupoId = null) {
  try {
    // Ler arquivo
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    // Converter para JSON
    const linhas = XLSX.utils.sheet_to_json(sheet);

    if (linhas.length === 0) {
      return {
        inseridos: 0,
        atualizados: 0,
        erros: [{ mensagem: "Arquivo Excel vazio" }],
        detalhes: [],
      };
    }

    const resultados = {
      inseridos: 0,
      atualizados: 0,
      erros: [],
      detalhes: [],
    };

    console.log(`📋 Colunas detectadas: ${Object.keys(linhas[0]).join(", ")}`);

    for (let i = 0; i < linhas.length; i++) {
      const linha = linhas[i];
      console.log(`📝 Linha ${i + 2}:`, linha);
      
      // Processar linha (XLSX já retorna objeto mapeado)
      const { contato, erros, valido } = processarContato(linha);

      if (!valido) {
        resultados.erros.push({
          linha: i + 2, // +2 porque começa no 1 e Excel tem header
          mensagem: erros.join("; "),
        });
        resultados.detalhes.push({
          linha: i + 2,
          status: "erro",
          motivo: erros.join("; "),
        });
        continue;
      }

      try {
        // Verificar se existe
        const existente = await pool.query(
          "SELECT id FROM contatos WHERE telefone_normalizado = $1",
          [contato.telefone_normalizado],
        );

        if (existente.rows.length > 0) {
          // Atualizar
          await pool.query(
            `UPDATE contatos 
             SET nome = COALESCE($1, nome),
                 email = COALESCE($2, email),
                 empresa = COALESCE($3, empresa),
                 cargo = COALESCE($4, cargo),
                 tags = CASE WHEN $5::text[] IS NOT NULL THEN $5::text[] ELSE tags END,
                 updated_at = NOW()
             WHERE telefone_normalizado = $6`,
            [
              contato.nome,
              contato.email,
              contato.empresa,
              contato.cargo,
              contato.tags && contato.tags.length > 0 ? contato.tags : null,
              contato.telefone_normalizado,
            ],
          );

          resultados.atualizados++;
          resultados.detalhes.push({
            linha: i + 2,
            status: "atualizado",
            telefone: contato.telefone_normalizado,
          });
        } else {
          // Inserir - garantir que telefone não seja nulo
          if (!contato.telefone || !contato.telefone_normalizado) {
            throw new Error('Telefone é obrigatório');
          }
          
          const insertResult = await pool.query(
            `INSERT INTO contatos (nome, telefone, telefone_normalizado, email, empresa, cargo, tags, grupo_importacao_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id`,
            [
              contato.nome,
              contato.telefone,
              contato.telefone_normalizado,
              contato.email,
              contato.empresa,
              contato.cargo,
              contato.tags && contato.tags.length > 0 ? contato.tags : null,
              grupoId,
            ],
          );

          resultados.inseridos++;
          resultados.detalhes.push({
            linha: i + 2,
            status: "inserido",
            telefone: contato.telefone_normalizado,
            id: insertResult.rows[0].id,
          });
        }
      } catch (erro) {
        resultados.erros.push({
          linha: i + 2,
          telefone: contato.telefone_normalizado,
          mensagem: erro.message,
        });
        resultados.detalhes.push({
          linha: i + 2,
          status: "erro_banco",
          motivo: erro.message,
        });
      }
    }

    console.log(`\n📊 Importação concluída:`);
    console.log(`   ✅ Inseridos: ${resultados.inseridos}`);
    console.log(`   🔄 Atualizados: ${resultados.atualizados}`);
    console.log(`   ❌ Erros: ${resultados.erros.length}`);

    return resultados;
  } catch (erro) {
    console.error("❌ Erro ao processar Excel:", erro);
    throw erro;
  }
}

export { normalizarTelefone, validarEmail, processarContato, processarCSV, processarExcel };
