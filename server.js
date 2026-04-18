const express = require('express');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 8080;

// ── BANCO DE DADOS ──
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// ── CRIAÇÃO DAS TABELAS ──
async function initDB() {
  try {
    // Verifica se a tabela cooperados tem estrutura antiga (coluna 'aporte')
    // Se sim, dropa tudo e recria com a estrutura nova
    try {
      const check = await pool.query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'cooperados' AND column_name = 'aporte'
      `);
      if (check.rows.length > 0) {
        console.log('⚠️ Estrutura antiga detectada. Recriando tabelas...');
        await pool.query('DROP TABLE IF EXISTS simulacoes_retirada CASCADE');
        await pool.query('DROP TABLE IF EXISTS sessoes CASCADE');
        await pool.query('DROP TABLE IF EXISTS dados_renda CASCADE');
        await pool.query('DROP TABLE IF EXISTS dados_imoveis CASCADE');
        await pool.query('DROP TABLE IF EXISTS simulacoes_pgbl CASCADE');
        await pool.query('DROP TABLE IF EXISTS simulacoes_holding CASCADE');
        await pool.query('DROP TABLE IF EXISTS diagnosticos_aposentadoria CASCADE');
        await pool.query('DROP TABLE IF EXISTS cooperados CASCADE');
        console.log('✅ Tabelas antigas removidas');
      }
    } catch(e) { /* tabela nem existe ainda, ok */ }

    // Tabela principal de cooperados
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cooperados (
        id SERIAL PRIMARY KEY,
        nome TEXT NOT NULL,
        celular TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Tabela de diagnósticos de aposentadoria
    await pool.query(`
      CREATE TABLE IF NOT EXISTS diagnosticos_aposentadoria (
        id SERIAL PRIMARY KEY,
        cooperado_id INTEGER REFERENCES cooperados(id) ON DELETE CASCADE,
        aporte_mensal NUMERIC(15,2),
        patrimonio_atual NUMERIC(15,2),
        idade INTEGER,
        idade_aposentadoria INTEGER,
        perfil TEXT,
        estrategia TEXT,
        patrimonio_futuro NUMERIC(15,2),
        renda_mensal NUMERIC(15,2),
        taxa_real_anual NUMERIC(6,2),
        anos_acumulacao INTEGER,
        esgota_em INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Tabela de dados de renda
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dados_renda (
        id SERIAL PRIMARY KEY,
        cooperado_id INTEGER REFERENCES cooperados(id) ON DELETE CASCADE,
        renda_mensal NUMERIC(15,2),
        renda_em_folha BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Tabela de dados de imóveis
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dados_imoveis (
        id SERIAL PRIMARY KEY,
        cooperado_id INTEGER REFERENCES cooperados(id) ON DELETE CASCADE,
        possui_imoveis BOOLEAN DEFAULT FALSE,
        possui_holding BOOLEAN,
        quantidade_imoveis INTEGER,
        valor_total_imoveis NUMERIC(15,2),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Tabela de simulações PGBL
    await pool.query(`
      CREATE TABLE IF NOT EXISTS simulacoes_pgbl (
        id SERIAL PRIMARY KEY,
        cooperado_id INTEGER REFERENCES cooperados(id) ON DELETE CASCADE,
        renda_bruta_anual NUMERIC(15,2),
        contribui_inss BOOLEAN DEFAULT TRUE,
        contribuicao_atual NUMERIC(15,2),
        imposto_devido NUMERIC(15,2),
        economia_potencial NUMERIC(15,2),
        aporte_necessario NUMERIC(15,2),
        horizonte_anos INTEGER,
        patrimonio_projetado NUMERIC(15,2),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Tabela de simulações Holding
    await pool.query(`
      CREATE TABLE IF NOT EXISTS simulacoes_holding (
        id SERIAL PRIMARY KEY,
        cooperado_id INTEGER REFERENCES cooperados(id) ON DELETE CASCADE,
        quantidade_imoveis INTEGER,
        valor_total_mercado NUMERIC(15,2),
        gera_aluguel BOOLEAN DEFAULT FALSE,
        renda_aluguel_mensal NUMERIC(15,2),
        horizonte_anos INTEGER,
        custo_total_pf NUMERIC(15,2),
        custo_total_holding NUMERIC(15,2),
        economia_total NUMERIC(15,2),
        economia_inventario NUMERIC(15,2),
        economia_itbi NUMERIC(15,2),
        recomendacao TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Tabela de sessões/atendimentos
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessoes (
        id SERIAL PRIMARY KEY,
        cooperado_id INTEGER REFERENCES cooperados(id) ON DELETE CASCADE,
        fluxo TEXT,
        modulos_visitados TEXT[],
        completou_raio_x BOOLEAN DEFAULT FALSE,
        consultor TEXT,
        notas TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        finalizada_at TIMESTAMP
      )
    `);

    // Índices
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cooperados_nome ON cooperados(nome)`).catch(()=>{});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cooperados_celular ON cooperados(celular)`).catch(()=>{});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_diagnosticos_cooperado ON diagnosticos_aposentadoria(cooperado_id)`).catch(()=>{});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sessoes_cooperado ON sessoes(cooperado_id)`).catch(()=>{});

    console.log('✅ Banco de dados inicializado com sucesso');
  } catch (err) {
    console.error('❌ Erro ao inicializar banco:', err.message);
  }
}

initDB();

// ── MIDDLEWARE ──
app.use(express.json({ limit: '20mb' }));

// Rota de teste - acesse /api/ping para confirmar que o server está rodando
app.get('/api/ping', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString(), version: '2.1' });
});

// Log de todas as requisições /api
app.use('/api', (req, res, next) => {
  console.log(`📡 ${req.method} ${req.originalUrl}`);
  next();
});

// ── AUTENTICAÇÃO ADMIN ──
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASS = process.env.ADMIN_PASS || '';

// Log para debug (remover depois)
console.log('🔐 ADMIN_USER configurado:', ADMIN_USER ? 'SIM (' + ADMIN_USER.substring(0,5) + '...)' : 'NÃO');
console.log('🔐 ADMIN_PASS configurado:', ADMIN_PASS ? 'SIM' : 'NÃO');

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    return res.status(401).json({ error: 'Não autorizado' });
  }
  const decoded = Buffer.from(auth.split(' ')[1], 'base64').toString();
  const colonIndex = decoded.indexOf(':');
  const user = decoded.substring(0, colonIndex);
  const pass = decoded.substring(colonIndex + 1);
  
  // Log para debug (remover depois)
  console.log('🔑 Tentativa de login:', user);
  
  if (!ADMIN_USER || !ADMIN_PASS) {
    console.log('❌ Variáveis de ambiente não configuradas!');
    return res.status(401).json({ error: 'Configuração de admin incompleta' });
  }
  
  if (user !== ADMIN_USER || pass !== ADMIN_PASS) {
    console.log('❌ Login falhou - user match:', user === ADMIN_USER, '| pass match:', pass === ADMIN_PASS);
    return res.status(401).json({ error: 'Credenciais inválidas' });
  }
  
  console.log('✅ Login bem-sucedido:', user);
  next();
}

// ══════════════════════════════════════════════════════════════
// API PÚBLICA (chamadas do frontend)
// ══════════════════════════════════════════════════════════════

// ── Salvar cooperado e diagnóstico completo ──
app.post('/api/salvar', async (req, res) => {
  console.log('💾 /api/salvar chamado! Body keys:', Object.keys(req.body || {}));
  const {
    nome, celular, fluxo,
    // Formato antigo (retrocompatibilidade)
    aporte, patrimonio_atual, idade, idade_aposentadoria,
    perfil, estrategia, patrimonio_futuro, renda_mensal,
    taxa_real_anual, anos_acumulacao, esgota_em,
    renda_mensal_atual, renda_em_folha,
    possui_imoveis, possui_holding, quantidade_imoveis, valor_total_imoveis,
    // Formato novo (tela final)
    aposentadoria, pgbl, holding, vgbl,
    qtd_imoveis, valor_imoveis
  } = req.body;

  try {
    // 1. Busca ou cria cooperado
    let cooperado;
    const existing = await pool.query(
      'SELECT id FROM cooperados WHERE nome = $1 AND celular = $2',
      [nome, celular || '']
    );

    if (existing.rows.length > 0) {
      cooperado = existing.rows[0];
      await pool.query(
        'UPDATE cooperados SET updated_at = CURRENT_TIMESTAMP WHERE id = $1',
        [cooperado.id]
      );
    } else {
      const result = await pool.query(
        'INSERT INTO cooperados (nome, celular) VALUES ($1, $2) RETURNING id',
        [nome, celular || '']
      );
      cooperado = result.rows[0];
    }

    // 2. Insere diagnóstico de aposentadoria (formato novo ou antigo)
    if (aposentadoria) {
      await pool.query(`
        INSERT INTO diagnosticos_aposentadoria 
        (cooperado_id, aporte_mensal, patrimonio_atual, idade, idade_aposentadoria, 
         perfil, estrategia, patrimonio_futuro, renda_mensal)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [
        cooperado.id, 
        aposentadoria.aporte_mensal || 0, 
        aposentadoria.patrimonio_atual || 0, 
        aposentadoria.idade || 0, 
        aposentadoria.idade_aposentadoria || 0,
        aposentadoria.perfil || 'moderado', 
        aposentadoria.estrategia || 'renda', 
        aposentadoria.patrimonio_futuro || 0, 
        aposentadoria.renda_mensal || 0
      ]);
    } else if (aporte !== undefined) {
      // Formato antigo
      await pool.query(`
        INSERT INTO diagnosticos_aposentadoria 
        (cooperado_id, aporte_mensal, patrimonio_atual, idade, idade_aposentadoria, 
         perfil, estrategia, patrimonio_futuro, renda_mensal, taxa_real_anual, 
         anos_acumulacao, esgota_em)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `, [
        cooperado.id, aporte, patrimonio_atual, idade, idade_aposentadoria,
        perfil, estrategia, patrimonio_futuro, renda_mensal, taxa_real_anual,
        anos_acumulacao, esgota_em
      ]);
    }

    // 3. Insere simulação PGBL (formato novo)
    if (pgbl) {
      await pool.query(`
        INSERT INTO simulacoes_pgbl 
        (cooperado_id, economia_potencial, aporte_necessario, horizonte_anos, patrimonio_projetado)
        VALUES ($1, $2, $3, $4, $5)
      `, [
        cooperado.id, 
        pgbl.economia_anual || 0,
        pgbl.aporte_sugerido || 0,
        pgbl.horizonte_anos || 15,
        pgbl.patrimonio_projetado || 0
      ]);
    }

    // 4. Insere simulação Holding (formato novo)
    if (holding) {
      await pool.query(`
        INSERT INTO simulacoes_holding 
        (cooperado_id, valor_total_mercado, economia_total, recomendacao)
        VALUES ($1, $2, $3, $4)
      `, [
        cooperado.id,
        holding.valor_imoveis || 0,
        holding.economia || 0,
        holding.recomenda ? 'holding' : 'pf'
      ]);
    }

    // 5. Insere/atualiza dados de renda
    const rendaVal = renda_mensal_atual !== undefined ? renda_mensal_atual : (req.body.renda_mensal || 0);
    const rendaFolha = renda_em_folha !== undefined ? renda_em_folha : false;
    if (rendaVal > 0 || rendaFolha) {
      try {
        await pool.query(`
          INSERT INTO dados_renda (cooperado_id, renda_mensal, renda_em_folha)
          VALUES ($1, $2, $3)
        `, [cooperado.id, rendaVal, rendaFolha]);
      } catch(e) { /* ignora duplicata */ }
    }

    // 6. Insere/atualiza dados de imóveis
    const temImoveis = possui_imoveis !== undefined ? possui_imoveis : false;
    const temHolding = possui_holding !== undefined ? possui_holding : false;
    const qtd = quantidade_imoveis || qtd_imoveis || 0;
    const val = valor_total_imoveis || valor_imoveis || 0;
    if (temImoveis || qtd > 0) {
      try {
        await pool.query(`
          INSERT INTO dados_imoveis (cooperado_id, possui_imoveis, possui_holding, quantidade_imoveis, valor_total_imoveis)
          VALUES ($1, $2, $3, $4, $5)
        `, [cooperado.id, temImoveis, temHolding, qtd, val]);
      } catch(e) { /* ignora duplicata */ }
    }

    // 7. Cria sessão
    if (fluxo) {
      const modulos = ['aposentadoria'];
      if (pgbl) modulos.push('pgbl');
      if (holding) modulos.push('holding');
      if (vgbl) modulos.push('vgbl');
      
      try {
        await pool.query(`
          INSERT INTO sessoes (cooperado_id, fluxo, modulos_visitados, completou_raio_x)
          VALUES ($1, $2, $3, $4)
        `, [cooperado.id, fluxo, modulos, fluxo === 'raioX']);
      } catch(e) { /* ignora erro */ }
    }

    res.json({ ok: true, cooperado_id: cooperado.id });
  } catch (err) {
    console.error('Erro ao salvar:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Salvar simulação PGBL ──
app.post('/api/salvar-pgbl', async (req, res) => {
  const {
    cooperado_id, renda_bruta_anual, contribui_inss, contribuicao_atual,
    imposto_devido, economia_potencial, aporte_necessario,
    horizonte_anos, patrimonio_projetado
  } = req.body;

  try {
    await pool.query(`
      INSERT INTO simulacoes_pgbl 
      (cooperado_id, renda_bruta_anual, contribui_inss, contribuicao_atual,
       imposto_devido, economia_potencial, aporte_necessario, horizonte_anos, patrimonio_projetado)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
      cooperado_id, renda_bruta_anual, contribui_inss, contribuicao_atual,
      imposto_devido, economia_potencial, aporte_necessario,
      horizonte_anos, patrimonio_projetado
    ]);

    // Atualiza sessão
    await pool.query(`
      UPDATE sessoes SET modulos_visitados = array_append(modulos_visitados, 'pgbl')
      WHERE cooperado_id = $1 AND finalizada_at IS NULL
      AND NOT ('pgbl' = ANY(modulos_visitados))
    `, [cooperado_id]);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Salvar simulação Holding ──
app.post('/api/salvar-holding', async (req, res) => {
  const {
    cooperado_id, quantidade_imoveis, valor_total_mercado, gera_aluguel,
    renda_aluguel_mensal, horizonte_anos, custo_total_pf, custo_total_holding,
    economia_total, economia_inventario, economia_itbi, recomendacao
  } = req.body;

  try {
    await pool.query(`
      INSERT INTO simulacoes_holding 
      (cooperado_id, quantidade_imoveis, valor_total_mercado, gera_aluguel,
       renda_aluguel_mensal, horizonte_anos, custo_total_pf, custo_total_holding,
       economia_total, economia_inventario, economia_itbi, recomendacao)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `, [
      cooperado_id, quantidade_imoveis, valor_total_mercado, gera_aluguel,
      renda_aluguel_mensal, horizonte_anos, custo_total_pf, custo_total_holding,
      economia_total, economia_inventario, economia_itbi, recomendacao
    ]);

    // Atualiza sessão
    await pool.query(`
      UPDATE sessoes SET modulos_visitados = array_append(modulos_visitados, 'holding')
      WHERE cooperado_id = $1 AND finalizada_at IS NULL
      AND NOT ('holding' = ANY(modulos_visitados))
    `, [cooperado_id]);

    // Se completou os 3 módulos no Raio X, marca como completo
    await pool.query(`
      UPDATE sessoes SET completou_raio_x = TRUE, finalizada_at = CURRENT_TIMESTAMP
      WHERE cooperado_id = $1 AND fluxo = 'raioX' AND finalizada_at IS NULL
      AND 'aposentadoria' = ANY(modulos_visitados)
      AND 'pgbl' = ANY(modulos_visitados)
      AND 'holding' = ANY(modulos_visitados)
    `, [cooperado_id]);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Salvar simulação de retirada customizada ──
app.post('/api/salvar-retirada', async (req, res) => {
  const { diagnostico_id, valor_retirada, dura_ate_idade } = req.body;
  try {
    await pool.query(`
      INSERT INTO simulacoes_retirada (diagnostico_id, valor_retirada, dura_ate_idade)
      VALUES ($1, $2, $3)
    `, [diagnostico_id, valor_retirada, dura_ate_idade]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// API ADMIN (protegida por autenticação)
// ══════════════════════════════════════════════════════════════

// ── Listar todos os cooperados com resumo ──
app.get('/admin/api/cooperados', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        c.id, c.nome, c.celular, c.created_at, c.updated_at,
        COUNT(DISTINCT d.id) as total_diagnosticos,
        COUNT(DISTINCT sp.id) as total_pgbl,
        COUNT(DISTINCT sh.id) as total_holding,
        MAX(d.created_at) as ultimo_diagnostico,
        MAX(s.created_at) as ultima_sessao,
        (SELECT fluxo FROM sessoes WHERE cooperado_id = c.id ORDER BY created_at DESC LIMIT 1) as ultimo_fluxo
      FROM cooperados c
      LEFT JOIN diagnosticos_aposentadoria d ON d.cooperado_id = c.id
      LEFT JOIN simulacoes_pgbl sp ON sp.cooperado_id = c.id
      LEFT JOIN simulacoes_holding sh ON sh.cooperado_id = c.id
      LEFT JOIN sessoes s ON s.cooperado_id = c.id
      GROUP BY c.id
      ORDER BY c.updated_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Detalhes completos de um cooperado ──
app.get('/admin/api/cooperados/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  try {
    // Dados básicos
    const cooperado = await pool.query('SELECT * FROM cooperados WHERE id = $1', [id]);
    if (cooperado.rows.length === 0) {
      return res.status(404).json({ error: 'Cooperado não encontrado' });
    }

    // Dados de renda
    const renda = await pool.query('SELECT * FROM dados_renda WHERE cooperado_id = $1', [id]);

    // Dados de imóveis
    const imoveis = await pool.query('SELECT * FROM dados_imoveis WHERE cooperado_id = $1', [id]);

    // Diagnósticos
    const diagnosticos = await pool.query(`
      SELECT * FROM diagnosticos_aposentadoria WHERE cooperado_id = $1 ORDER BY created_at DESC
    `, [id]);

    // Simulações PGBL
    const pgbl = await pool.query(`
      SELECT * FROM simulacoes_pgbl WHERE cooperado_id = $1 ORDER BY created_at DESC
    `, [id]);

    // Simulações Holding
    const holding = await pool.query(`
      SELECT * FROM simulacoes_holding WHERE cooperado_id = $1 ORDER BY created_at DESC
    `, [id]);

    // Sessões
    const sessoes = await pool.query(`
      SELECT * FROM sessoes WHERE cooperado_id = $1 ORDER BY created_at DESC
    `, [id]);

    res.json({
      cooperado: cooperado.rows[0],
      renda: renda.rows[0] || null,
      imoveis: imoveis.rows[0] || null,
      diagnosticos: diagnosticos.rows,
      simulacoes_pgbl: pgbl.rows,
      simulacoes_holding: holding.rows,
      sessoes: sessoes.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Deletar cooperado ──
app.delete('/admin/api/cooperados/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM cooperados WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Dashboard stats ──
app.get('/admin/api/stats', authMiddleware, async (req, res) => {
  console.log('📊 Requisição de stats recebida');
  try {
    // Query mais segura - verifica cada tabela individualmente
    const results = {};
    
    // Cooperados (tabela principal - sempre existe)
    try {
      const r = await pool.query('SELECT COUNT(*) as c FROM cooperados');
      results.total_cooperados = parseInt(r.rows[0].c) || 0;
    } catch(e) { results.total_cooperados = 0; }
    
    // Novos 7 dias
    try {
      const r = await pool.query("SELECT COUNT(*) as c FROM cooperados WHERE created_at > NOW() - INTERVAL '7 days'");
      results.novos_7_dias = parseInt(r.rows[0].c) || 0;
    } catch(e) { results.novos_7_dias = 0; }
    
    // Diagnósticos
    try {
      const r = await pool.query('SELECT COUNT(*) as c FROM diagnosticos_aposentadoria');
      results.total_diagnosticos = parseInt(r.rows[0].c) || 0;
    } catch(e) { results.total_diagnosticos = 0; }
    
    // PGBL
    try {
      const r = await pool.query('SELECT COUNT(*) as c FROM simulacoes_pgbl');
      results.total_pgbl = parseInt(r.rows[0].c) || 0;
    } catch(e) { results.total_pgbl = 0; }
    
    // Holding
    try {
      const r = await pool.query('SELECT COUNT(*) as c FROM simulacoes_holding');
      results.total_holding = parseInt(r.rows[0].c) || 0;
    } catch(e) { results.total_holding = 0; }
    
    // Sessões Raio X completo
    try {
      const r = await pool.query("SELECT COUNT(*) as c FROM sessoes WHERE completou_raio_x = TRUE");
      results.raio_x_completos = parseInt(r.rows[0].c) || 0;
    } catch(e) { results.raio_x_completos = 0; }
    
    // Renda em folha
    try {
      const r = await pool.query('SELECT COUNT(*) as c FROM dados_renda WHERE renda_em_folha = TRUE');
      results.total_renda_folha = parseInt(r.rows[0].c) || 0;
    } catch(e) { results.total_renda_folha = 0; }
    
    // Potenciais holding
    try {
      const r = await pool.query('SELECT COUNT(*) as c FROM dados_imoveis WHERE possui_imoveis = TRUE AND possui_holding = FALSE');
      results.potenciais_holding = parseInt(r.rows[0].c) || 0;
    } catch(e) { results.potenciais_holding = 0; }
    
    // Totais de investimentos
    try {
      const r = await pool.query('SELECT COALESCE(SUM(patrimonio_atual),0) as total FROM diagnosticos_aposentadoria');
      results.total_investimentos = parseFloat(r.rows[0].total) || 0;
    } catch(e) { results.total_investimentos = 0; }
    
    // Total imobilizado
    try {
      const r = await pool.query('SELECT COALESCE(SUM(valor_total_imoveis),0) as total FROM dados_imoveis WHERE possui_imoveis = TRUE');
      results.total_imobilizado = parseFloat(r.rows[0].total) || 0;
    } catch(e) { results.total_imobilizado = 0; }
    
    res.json(results);
  } catch (err) {
    console.error('Erro stats:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Exportar dados CSV ──
app.get('/admin/api/export/csv', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        c.nome, c.celular, c.created_at as data_cadastro,
        dr.renda_mensal, dr.renda_em_folha,
        di.possui_imoveis, di.possui_holding, di.quantidade_imoveis, di.valor_total_imoveis,
        d.aporte_mensal, d.patrimonio_atual, d.idade, d.idade_aposentadoria,
        d.perfil, d.estrategia, d.patrimonio_futuro, d.renda_mensal as renda_aposentadoria,
        d.created_at as data_diagnostico
      FROM cooperados c
      LEFT JOIN dados_renda dr ON dr.cooperado_id = c.id
      LEFT JOIN dados_imoveis di ON di.cooperado_id = c.id
      LEFT JOIN diagnosticos_aposentadoria d ON d.cooperado_id = c.id
      ORDER BY c.updated_at DESC
    `);

    let csv = 'Nome,Celular,Data Cadastro,Renda Mensal,Renda Folha,Possui Imóveis,Possui Holding,Qtd Imóveis,Valor Imóveis,Aporte,Patrimônio Atual,Idade,Idade Aposentadoria,Perfil,Estratégia,Patrimônio Futuro,Renda Aposentadoria,Data Diagnóstico\n';
    
    for (const row of result.rows) {
      csv += `"${row.nome || ''}","${row.celular || ''}","${row.data_cadastro || ''}","${row.renda_mensal || ''}","${row.renda_em_folha ? 'Sim' : 'Não'}","${row.possui_imoveis ? 'Sim' : 'Não'}","${row.possui_holding ? 'Sim' : 'Não'}","${row.quantidade_imoveis || ''}","${row.valor_total_imoveis || ''}","${row.aporte_mensal || ''}","${row.patrimonio_atual || ''}","${row.idade || ''}","${row.idade_aposentadoria || ''}","${row.perfil || ''}","${row.estrategia || ''}","${row.patrimonio_futuro || ''}","${row.renda_aposentadoria || ''}","${row.data_diagnostico || ''}"\n`;
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=cooperados_export.csv');
    res.send('\uFEFF' + csv); // BOM para Excel reconhecer UTF-8
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// SERVIR ARQUIVOS HTML
// ══════════════════════════════════════════════════════════════

// Painel admin
app.get('/admin', (req, res) => {
  const adminHtml = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin · WealthPlanning</title>
  <link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@400;600;800&family=JetBrains+Mono:wght@400;600&family=Instrument+Sans:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root{--bg:#080e1a;--surf:#0f1b2d;--bdr:#1e3a5f;--accent:#4c8bf5;--green:#2ecc8a;--gold:#f8d75e;--red:#f07070;--text:#ededed;--muted:#8a95a3}
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Instrument Sans',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;padding:24px}
    .container{max-width:1400px;margin:0 auto}
    h1{font-family:'Bricolage Grotesque',sans-serif;font-size:32px;font-weight:800;margin-bottom:8px}
    h1 span{color:var(--accent)}
    .subtitle{color:var(--muted);margin-bottom:32px}
    .stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:32px}
    .stat-card{background:var(--surf);border:1px solid var(--bdr);border-radius:12px;padding:20px}
    .stat-label{font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:6px}
    .stat-value{font-family:'Bricolage Grotesque',sans-serif;font-size:32px;font-weight:800;color:var(--text)}
    .stat-value.accent{color:var(--accent)}
    .stat-value.green{color:var(--green)}
    .stat-value.gold{color:var(--gold)}
    .toolbar{display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap;align-items:center}
    .btn{padding:10px 18px;border-radius:8px;font-family:'Bricolage Grotesque',sans-serif;font-weight:700;font-size:13px;cursor:pointer;transition:all .15s;border:none}
    .btn-primary{background:var(--accent);color:#fff}
    .btn-primary:hover{background:#3a72e0}
    .btn-outline{background:transparent;border:1.5px solid var(--bdr);color:var(--text)}
    .btn-outline:hover{border-color:var(--accent)}
    .btn-logout{background:transparent;border:1.5px solid var(--red);color:var(--red);margin-left:auto}
    .btn-logout:hover{background:var(--red);color:#fff}
    .search{flex:1;min-width:200px;padding:10px 16px;background:var(--surf);border:1.5px solid var(--bdr);border-radius:8px;color:var(--text);font-size:14px;outline:none}
    .search:focus{border-color:var(--accent)}
    .header-row{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:32px}
    .user-info{font-size:12px;color:var(--muted);display:flex;align-items:center;gap:8px}
    .user-info .avatar{width:32px;height:32px;background:var(--accent);border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;color:#fff}
    table{width:100%;border-collapse:collapse;background:var(--surf);border-radius:12px;overflow:hidden}
    th,td{text-align:left;padding:14px 16px;border-bottom:1px solid var(--bdr)}
    th{background:rgba(76,139,245,.08);font-family:'JetBrains Mono',monospace;font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--accent)}
    tr:hover td{background:rgba(76,139,245,.03)}
    .badge{display:inline-block;padding:3px 8px;border-radius:99px;font-size:10px;font-weight:600}
    .badge-raio{background:rgba(46,204,138,.15);color:var(--green)}
    .badge-pontual{background:rgba(76,139,245,.15);color:var(--accent)}
    .badge-holding{background:rgba(248,215,94,.15);color:var(--gold)}
    .btn-sm{padding:6px 12px;font-size:11px}
    .btn-danger{background:var(--red);color:#fff}
    .highlight-card{background:linear-gradient(135deg,rgba(76,139,245,.12),rgba(76,139,245,.04))!important;border-color:rgba(76,139,245,.3)!important}
    .highlight-card .stat-value{font-size:clamp(22px,3vw,28px)}
    .modal{position:fixed;inset:0;background:rgba(0,0,0,.8);display:none;align-items:center;justify-content:center;z-index:100}
    .modal.show{display:flex}
    .modal-content{background:var(--surf);border:1px solid var(--bdr);border-radius:16px;max-width:900px;width:95%;max-height:90vh;overflow:auto;padding:32px}
    .modal-close{position:absolute;top:16px;right:16px;background:none;border:none;color:var(--muted);font-size:24px;cursor:pointer}
    .detail-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:16px}
    .detail-card{background:rgba(255,255,255,.03);border:1px solid var(--bdr);border-radius:10px;padding:14px}
    .detail-label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px}
    .detail-value{font-family:'Bricolage Grotesque',sans-serif;font-size:16px;font-weight:700}
    .detail-section{margin-top:24px;padding-top:20px;border-top:1px solid var(--bdr)}
    .detail-section h3{font-family:'Bricolage Grotesque',sans-serif;font-size:15px;font-weight:700;margin-bottom:12px;display:flex;align-items:center;gap:8px}
    .login-required{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:60vh;text-align:center}
    .login-required h2{font-family:'Bricolage Grotesque',sans-serif;margin-bottom:16px;color:var(--red)}
    .login-required p{color:var(--muted);margin-bottom:24px}
    @media(max-width:768px){.detail-grid{grid-template-columns:1fr 1fr}}
  </style>
</head>
<body>
  <div class="container" id="main-content" style="display:none">
    <div class="header-row">
      <div>
        <h1>Painel <span>WealthPlanning</span></h1>
        <p class="subtitle">Gestão de clientes e diagnósticos</p>
      </div>
      <div class="user-info">
        <div class="avatar" id="user-avatar">A</div>
        <span id="user-email">admin</span>
      </div>
    </div>
    
    <div class="stats-grid" id="stats">
      <div class="stat-card highlight-card"><div class="stat-label">Total Investimentos</div><div class="stat-value green" id="s-invest">—</div></div>
      <div class="stat-card highlight-card"><div class="stat-label">Total Imobilizado</div><div class="stat-value gold" id="s-imob">—</div></div>
      <div class="stat-card highlight-card"><div class="stat-label">PL Total</div><div class="stat-value accent" id="s-pl">—</div></div>
      <div class="stat-card highlight-card"><div class="stat-label">Clientes</div><div class="stat-value" id="s-total">—</div></div>
      <div class="stat-card"><div class="stat-label">Diagnósticos</div><div class="stat-value" id="s-diag">—</div></div>
      <div class="stat-card"><div class="stat-label">Simulações PGBL</div><div class="stat-value gold" id="s-pgbl">—</div></div>
      <div class="stat-card"><div class="stat-label">Simulações Holding</div><div class="stat-value gold" id="s-holding">—</div></div>
      <div class="stat-card"><div class="stat-label">Raio X Completo</div><div class="stat-value green" id="s-raiox">—</div></div>
      <div class="stat-card"><div class="stat-label">Novos (7 dias)</div><div class="stat-value green" id="s-novos">—</div></div>
      <div class="stat-card"><div class="stat-label">Renda em Folha</div><div class="stat-value" id="s-folha">—</div></div>
    </div>
    
    <div class="toolbar">
      <input type="text" class="search" id="search" placeholder="Buscar cliente...">
      <button class="btn btn-outline" onclick="exportCSV()">📥 Exportar CSV</button>
      <button class="btn btn-primary" onclick="loadData()">🔄 Atualizar</button>
      <button class="btn btn-logout" onclick="logout()">🚪 Sair</button>
    </div>
    
    <table>
      <thead>
        <tr>
          <th>Nome</th>
          <th>Celular</th>
          <th>Diagnósticos</th>
          <th>PGBL</th>
          <th>Holding</th>
          <th>Último Fluxo</th>
          <th>Última Atividade</th>
          <th>Ações</th>
        </tr>
      </thead>
      <tbody id="table-body"></tbody>
    </table>
  </div>
  
  <!-- Tela de login requerido -->
  <div class="container login-required" id="login-required" style="display:none">
    <h2>🔒 Acesso Restrito</h2>
    <p>Você precisa fazer login para acessar o painel.</p>
    <button class="btn btn-primary" onclick="window.location.href='/'">Ir para Login</button>
  </div>
  
  <div class="modal" id="modal">
    <div class="modal-content" style="position:relative">
      <button class="modal-close" onclick="closeModal()">&times;</button>
      <h2 id="modal-title">Detalhes</h2>
      <div id="modal-body"></div>
    </div>
  </div>
  
  <script>
    const params = new URLSearchParams(location.search);
    const auth = params.get('auth') || '';
    console.log('Auth token presente:', auth ? 'SIM ('+auth.substring(0,20)+'...)' : 'NÃO');
    const headers = { 'Authorization': 'Basic ' + auth };
    
    // Verificar se está autenticado
    async function checkAuth(){
      if(!auth){
        console.log('Sem token, mostrando login required');
        document.getElementById('login-required').style.display = 'flex';
        document.getElementById('main-content').style.display = 'none';
        return false;
      }
      try{
        console.log('Verificando autenticação...');
        const r = await fetch('/admin/api/stats', {headers});
        console.log('Resposta:', r.status, r.ok);
        if(!r.ok){
          const errText = await r.text();
          console.log('Erro:', errText);
          document.getElementById('login-required').style.display = 'flex';
          document.getElementById('main-content').style.display = 'none';
          return false;
        }
        // Autenticado - mostrar painel
        console.log('Autenticado! Mostrando painel.');
        document.getElementById('main-content').style.display = 'block';
        document.getElementById('login-required').style.display = 'none';
        
        // Mostrar email do usuário
        try{
          const decoded = atob(auth);
          const email = decoded.split(':')[0];
          document.getElementById('user-email').textContent = email;
          document.getElementById('user-avatar').textContent = email.charAt(0).toUpperCase();
        }catch(e){console.log('Erro ao decodificar:', e)}
        
        return true;
      }catch(e){
        console.log('Exceção:', e);
        document.getElementById('login-required').style.display = 'flex';
        document.getElementById('main-content').style.display = 'none';
        return false;
      }
    }
    
    function logout(){
      if(confirm('Deseja sair do painel?')){
        window.location.href = '/';
      }
    }
    
    const fmtBRL = v => 'R$ ' + Number(v||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
    const fmtBRLi = v => 'R$ ' + Number(v||0).toLocaleString('pt-BR',{minimumFractionDigits:0,maximumFractionDigits:0});
    
    async function loadStats(){
      try{
        const r = await fetch('/admin/api/stats', {headers});
        if(!r.ok) throw new Error();
        const s = await r.json();
        document.getElementById('s-total').textContent = s.total_cooperados || 0;
        document.getElementById('s-diag').textContent = s.total_diagnosticos || 0;
        document.getElementById('s-pgbl').textContent = s.total_pgbl || 0;
        document.getElementById('s-holding').textContent = s.total_holding || 0;
        document.getElementById('s-raiox').textContent = s.raio_x_completos || 0;
        document.getElementById('s-novos').textContent = s.novos_7_dias || 0;
        document.getElementById('s-folha').textContent = s.total_renda_folha || 0;
        document.getElementById('s-invest').textContent = fmtBRLi(s.total_investimentos);
        document.getElementById('s-imob').textContent = fmtBRLi(s.total_imobilizado);
        document.getElementById('s-pl').textContent = fmtBRLi((s.total_investimentos||0)+(s.total_imobilizado||0));
      }catch(e){console.error(e)}
    }
    
    async function loadData(){
      loadStats();
      try{
        const r = await fetch('/admin/api/cooperados', {headers});
        if(!r.ok) throw new Error();
        const data = await r.json();
        renderTable(data);
      }catch(e){console.error('Erro ao carregar:', e)}
    }
    
    function renderTable(data){
      const tbody = document.getElementById('table-body');
      const search = document.getElementById('search').value.toLowerCase();
      const filtered = data.filter(c => c.nome.toLowerCase().includes(search) || (c.celular||'').includes(search));
      
      tbody.innerHTML = filtered.map(c => {
        const fluxoBadge = c.ultimo_fluxo === 'raioX' ? '<span class="badge badge-raio">Raio X</span>' : 
                          c.ultimo_fluxo === 'pontual' ? '<span class="badge badge-pontual">Pontual</span>' : '—';
        const dt = c.updated_at ? new Date(c.updated_at).toLocaleString('pt-BR') : '—';
        return \`<tr>
          <td><strong>\${c.nome}</strong></td>
          <td>\${c.celular || '—'}</td>
          <td>\${c.total_diagnosticos || 0}</td>
          <td>\${c.total_pgbl || 0}</td>
          <td>\${c.total_holding || 0}</td>
          <td>\${fluxoBadge}</td>
          <td>\${dt}</td>
          <td>
            <button class="btn btn-sm btn-outline" onclick="viewDetails(\${c.id})">Ver</button>
            <button class="btn btn-sm btn-danger" onclick="deleteCooperado(\${c.id})">🗑</button>
          </td>
        </tr>\`;
      }).join('');
    }
    
    async function viewDetails(id){
      try{
        const r = await fetch('/admin/api/cooperados/'+id, {headers});
        const d = await r.json();
        document.getElementById('modal-title').textContent = d.cooperado.nome;
        
        // ── DADOS PESSOAIS ──
        let html = '<div class="detail-section" style="border:none;margin:0;padding:0"><h3>📋 Dados Pessoais</h3><div class="detail-grid">';
        html += \`<div class="detail-card"><div class="detail-label">Celular</div><div class="detail-value">\${d.cooperado.celular||'—'}</div></div>\`;
        
        if(d.renda){
          html += \`<div class="detail-card"><div class="detail-label">Renda Mensal</div><div class="detail-value">\${fmtBRL(d.renda.renda_mensal)}</div></div>\`;
          html += \`<div class="detail-card"><div class="detail-label">Renda em Folha</div><div class="detail-value" style="color:\${d.renda.renda_em_folha?'#2ecc8a':'#f07070'}">\${d.renda.renda_em_folha?'✓ Sim':'✗ Não'}</div></div>\`;
        }
        
        if(d.diagnosticos.length){
          const u = d.diagnosticos[0];
          html += \`<div class="detail-card"><div class="detail-label">Idade</div><div class="detail-value">\${u.idade||'—'} anos</div></div>\`;
          html += \`<div class="detail-card"><div class="detail-label">Perfil de Investidor</div><div class="detail-value" style="text-transform:capitalize">\${u.perfil||'—'}</div></div>\`;
          html += \`<div class="detail-card"><div class="detail-label">Valor em Investimentos</div><div class="detail-value" style="color:#4c8bf5">\${fmtBRL(u.patrimonio_atual)}</div></div>\`;
        }
        
        if(d.imoveis){
          html += \`<div class="detail-card"><div class="detail-label">Possui Imóveis</div><div class="detail-value" style="color:\${d.imoveis.possui_imoveis?'#2ecc8a':'var(--muted)'}">\${d.imoveis.possui_imoveis?'✓ Sim':'Não'}</div></div>\`;
          if(d.imoveis.possui_imoveis){
            html += \`<div class="detail-card"><div class="detail-label">Qtd Imóveis</div><div class="detail-value">\${d.imoveis.quantidade_imoveis||0}</div></div>\`;
            html += \`<div class="detail-card"><div class="detail-label">Valor Imobilizado</div><div class="detail-value" style="color:#f8d75e">\${fmtBRL(d.imoveis.valor_total_imoveis)}</div></div>\`;
            html += \`<div class="detail-card"><div class="detail-label">Possui Holding</div><div class="detail-value" style="color:\${d.imoveis.possui_holding?'#2ecc8a':'#f07070'}">\${d.imoveis.possui_holding?'✓ Sim':'✗ Não'}</div></div>\`;
          }
        }
        html += '</div></div>';
        
        // ── DIAGNÓSTICO APOSENTADORIA ──
        if(d.diagnosticos.length){
          const u = d.diagnosticos[0];
          html += '<div class="detail-section"><h3 style="color:#4c8bf5">📊 Diagnóstico de Aposentadoria</h3><div class="detail-grid">';
          html += \`<div class="detail-card"><div class="detail-label">Aporte Mensal</div><div class="detail-value">\${fmtBRL(u.aporte_mensal)}</div></div>\`;
          html += \`<div class="detail-card"><div class="detail-label">Patrimônio Atual</div><div class="detail-value">\${fmtBRL(u.patrimonio_atual)}</div></div>\`;
          html += \`<div class="detail-card"><div class="detail-label">Aposentadoria aos</div><div class="detail-value">\${u.idade_aposentadoria||'—'} anos</div></div>\`;
          html += \`<div class="detail-card"><div class="detail-label">Patrimônio Projetado</div><div class="detail-value" style="color:#2ecc8a">\${fmtBRL(u.patrimonio_futuro)}</div></div>\`;
          html += \`<div class="detail-card"><div class="detail-label">Renda Mensal Projetada</div><div class="detail-value" style="color:#2ecc8a">\${fmtBRL(u.renda_mensal)}/mês</div></div>\`;
          html += \`<div class="detail-card"><div class="detail-label">Estratégia</div><div class="detail-value" style="text-transform:capitalize">\${u.estrategia==='renda'?'Viver de renda':'Consumir patrimônio'}</div></div>\`;
          html += '</div></div>';
        }
        
        // ── SIMULAÇÃO PGBL ──
        if(d.simulacoes_pgbl.length){
          const p = d.simulacoes_pgbl[0];
          html += '<div class="detail-section"><h3 style="color:#f8d75e">💰 Simulação PGBL</h3><div class="detail-grid">';
          html += \`<div class="detail-card"><div class="detail-label">Economia Anual IR</div><div class="detail-value" style="color:#f8d75e">\${fmtBRL(p.economia_potencial)}</div></div>\`;
          html += \`<div class="detail-card"><div class="detail-label">Aporte PGBL Sugerido</div><div class="detail-value">\${fmtBRL(p.aporte_necessario)}</div></div>\`;
          html += \`<div class="detail-card"><div class="detail-label">Patrimônio em \${p.horizonte_anos||15} anos</div><div class="detail-value" style="color:#4c8bf5">\${fmtBRL(p.patrimonio_projetado)}</div></div>\`;
          html += '</div></div>';
        }
        
        // ── SIMULAÇÃO HOLDING ──
        if(d.simulacoes_holding.length){
          const h = d.simulacoes_holding[0];
          const recOk = h.recomendacao==='holding';
          html += '<div class="detail-section"><h3 style="color:#f8d75e">🏢 Simulação Holding</h3><div class="detail-grid">';
          html += \`<div class="detail-card"><div class="detail-label">Recomendação</div><div class="detail-value" style="color:\${recOk?'#2ecc8a':'#f07070'}">\${recOk?'✓ Recomendado':'✗ Não recomendado'}</div></div>\`;
          html += \`<div class="detail-card"><div class="detail-label">Valor Mercado</div><div class="detail-value">\${fmtBRL(h.valor_total_mercado)}</div></div>\`;
          html += \`<div class="detail-card"><div class="detail-label">Economia Estimada</div><div class="detail-value" style="color:#f8d75e">\${fmtBRL(h.economia_total)}</div></div>\`;
          html += '</div></div>';
        }
        
        // ── SESSÕES ──
        if(d.sessoes.length){
          const s = d.sessoes[0];
          const fluxo = s.fluxo==='raioX'?'<span style="color:#2ecc8a">Raio X Completo</span>':'<span style="color:#4c8bf5">Pontual</span>';
          const modulos = (s.modulos_visitados||[]).join(', ');
          html += '<div class="detail-section"><h3>🔄 Última Sessão</h3><div class="detail-grid">';
          html += \`<div class="detail-card"><div class="detail-label">Fluxo</div><div class="detail-value">\${fluxo}</div></div>\`;
          html += \`<div class="detail-card"><div class="detail-label">Módulos</div><div class="detail-value" style="font-size:13px">\${modulos||'—'}</div></div>\`;
          html += \`<div class="detail-card"><div class="detail-label">Data</div><div class="detail-value" style="font-size:13px">\${new Date(s.created_at).toLocaleString('pt-BR')}</div></div>\`;
          html += '</div></div>';
        }
        
        document.getElementById('modal-body').innerHTML = html;
        document.getElementById('modal').classList.add('show');
      }catch(e){console.error(e);alert('Erro ao carregar detalhes')}
    }
    
    function closeModal(){document.getElementById('modal').classList.remove('show')}
    
    async function deleteCooperado(id){
      if(!confirm('Excluir este cooperado e todos os dados?')) return;
      try{
        await fetch('/admin/api/cooperados/'+id, {method:'DELETE',headers});
        loadData();
      }catch(e){alert('Erro ao excluir')}
    }
    
    function exportCSV(){
      window.open('/admin/api/export/csv?auth='+auth);
    }
    
    document.getElementById('search').addEventListener('input', loadData);
    
    // Verificar autenticação antes de carregar dados
    checkAuth().then(ok => {
      if(ok) loadData();
    });
  </script>
</body>
</html>`;
  res.send(adminHtml);
});

// Servir arquivos HTML da raiz
const htmlFiles = fs.readdirSync(__dirname).filter(f => f.endsWith('.html'));
htmlFiles.forEach(file => {
  const route = '/' + file.replace('.html', '');
  app.get(route, (req, res) => res.sendFile(path.join(__dirname, file)));
  if (file === 'plano-futuro.html') {
    app.get('/', (req, res) => res.sendFile(path.join(__dirname, file)));
  }
});

// Fallback
app.get('*', (req, res) => {
  const pf = path.join(__dirname, 'plano-futuro.html');
  if (fs.existsSync(pf)) res.sendFile(pf);
  else res.status(404).send('Not found');
});

// ── INICIAR SERVIDOR ──
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
});
