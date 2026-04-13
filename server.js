const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https' );
const { Pool } = require('pg');
const app = express();
const PORT = process.env.PORT || 8080;

// ── BANCO DE DADOS ──
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Cria tabela se não existir
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cooperados (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(100) NOT NULL,
        celular VARCHAR(20) DEFAULT '',
        aporte INTEGER NOT NULL,
        patrimonio_atual INTEGER NOT NULL,
        idade INTEGER NOT NULL,
        idade_aposentadoria INTEGER NOT NULL,
        perfil VARCHAR(20) NOT NULL,
        estrategia VARCHAR(20) NOT NULL,
        patrimonio_futuro INTEGER NOT NULL,
        renda_mensal INTEGER NOT NULL,
        taxa_real_anual DECIMAL(5,2) NOT NULL,
        anos_acumulacao INTEGER NOT NULL,
        esgota_em INTEGER,
        simulacoes JSONB DEFAULT '[]',
        criado_em TIMESTAMP DEFAULT NOW(),
        atualizado_em TIMESTAMP DEFAULT NOW()
      );
      ALTER TABLE cooperados ADD COLUMN IF NOT EXISTS celular VARCHAR(20) DEFAULT '';
    `);
    console.log('DB: tabela cooperados OK');
  } catch (e) {
    console.error('DB init error:', e.message);
  }
}
initDB();

// Aumenta o limite para suportar o envio de PDFs em base64
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname)));

// ── EXTRAÇÃO DE PDF VIA ANTHROPIC ──
app.post('/api/extrair-pdf', async (req, res) => {
  const { pdfBase64 } = req.body;
  if (!pdfBase64) return res.status(400).json({ ok: false, error: 'PDF não enviado' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ ok: false, error: 'ANTHROPIC_API_KEY não configurada no Railway' });

  const prompt = `Extraia os dados desta simulação de crédito da Unicred e retorne APENAS um JSON puro, sem explicações, no seguinte formato:
{
  "ok": true,
  "dados": {
    "valorSolicitado": número,
    "iof": número,
    "valorLiquido": número,
    "parcelas": número,
    "taxaOperacao": número (apenas o valor percentual mensal, ex: 1.49),
    "primeiroVencimento": "DD/MM/AAAA",
    "ultimaParcela": "DD/MM/AAAA",
    "tabela": [
      { "n": 1, "venc": "DD/MM/AAAA", "juros": número, "valor": número, "seguro": número, "jurosIdx": 0 }
    ]
  }
}
Importante: 
1. valorLiquido = valorSolicitado - iof.
2. No array tabela, extraia todas as parcelas listadas.
3. jurosIdx deve ser sempre 0.
4. Certifique-se de que os números não tenham R$ ou pontos de milhar, use apenas ponto para decimais.`;

  const data = JSON.stringify({
    model: "claude-3-5-sonnet-20240620",
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: pdfBase64
            }
          },
          {
            type: "text",
            text: prompt
          }
        ]
      }
    ]
  });

  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data)
    }
  };

  const anthropicReq = https.request(options, (anthropicRes ) => {
    let body = '';
    anthropicRes.on('data', (chunk) => body += chunk);
    anthropicRes.on('end', () => {
      try {
        const response = JSON.parse(body);
        if (anthropicRes.statusCode !== 200) {
          console.error('Anthropic Error:', response);
          return res.status(anthropicRes.statusCode).json({ ok: false, error: 'Erro na API da Anthropic' });
        }
        
        const content = response.content[0].text;
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const finalJson = JSON.parse(jsonMatch[0]);
          res.json(finalJson);
        } else {
          res.status(500).json({ ok: false, error: 'Não foi possível extrair o JSON da resposta' });
        }
      } catch (e) {
        console.error('Parse Error:', e.message);
        res.status(500).json({ ok: false, error: 'Erro ao processar resposta da IA' });
      }
    });
  });

  anthropicReq.on('error', (err) => {
    console.error('Request Error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  });

  anthropicReq.write(data);
  anthropicReq.end();
});

// ── SALVAR DIAGNÓSTICO ──
app.post('/api/salvar', async (req, res) => {
  try {
    const {
      nome, celular, aporte, patrimonio_atual, idade, idade_aposentadoria,
      perfil, estrategia, patrimonio_futuro, renda_mensal,
      taxa_real_anual, anos_acumulacao, esgota_em, simulacoes
    } = req.body;

    const result = await pool.query(`
      INSERT INTO cooperados 
        (nome, celular, aporte, patrimonio_atual, idade, idade_aposentadoria, perfil, estrategia,
         patrimonio_futuro, renda_mensal, taxa_real_anual, anos_acumulacao, esgota_em, simulacoes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING id
    `, [nome, celular || '', aporte, patrimonio_atual, idade, idade_aposentadoria, perfil, estrategia,
        patrimonio_futuro, renda_mensal, taxa_real_anual, anos_acumulacao, esgota_em || null,
        JSON.stringify(simulacoes || [])]);

    res.json({ ok: true, id: result.rows[0].id });
  } catch (e) {
    console.error('Salvar error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── PROXY ELEVENLABS ──
app.post('/api/speak', (req, res) => {
  const { text, voiceId, apiKey } = req.body;
  const data = JSON.stringify({
    text,
    model_id: 'eleven_multilingual_v2',
    voice_settings: { stability: 0.55, similarity_boost: 0.80, style: 0.25, use_speaker_boost: true }
  });
  const options = {
    hostname: 'api.elevenlabs.io',
    path: `/v1/text-to-speech/${voiceId}`,
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
      'Content-Length': Buffer.byteLength(data)
    }
  };
  const elReq = https.request(options, elRes => {
    if (elRes.statusCode !== 200 ) {
      let body = '';
      elRes.on('data', d => body += d);
      elRes.on('end', () => res.status(elRes.statusCode).json({ error: body }));
      return;
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    elRes.pipe(res);
  });
  elReq.on('error', err => res.status(500).json({ error: err.message }));
  elReq.write(data);
  elReq.end();
});

// ── PAINEL ADMIN — autenticação ──
const ADMIN_USER = process.env.ADMIN_USER || 'unicred';
const ADMIN_PASS = process.env.ADMIN_PASS || 'unicred@2025';

function checkAuth(req, res, next) {
  let authB64 = null;
  const header = req.headers['authorization'];
  if (header && header.startsWith('Basic ')) {
    authB64 = header.split(' ')[1];
  } else if (req.query.auth) {
    authB64 = req.query.auth;
  }
  if (!authB64) return res.status(401).json({ error: 'unauthorized' });
  const [user, pass] = Buffer.from(authB64, 'base64').toString().split(':');
  if (user === ADMIN_USER && pass === ADMIN_PASS) return next();
  res.status(401).json({ error: 'invalid credentials' });
}

app.get('/admin/api/cooperados', checkAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM cooperados ORDER BY criado_em DESC LIMIT 500`);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/admin/api/cooperados/:id', checkAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM cooperados WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SERVIR HTML PRINCIPAL ──
app.get('*', (req, res) => {
  const files = fs.readdirSync(__dirname);
  const html = files.find(f => f.endsWith('.html'));
  if (html) res.sendFile(path.join(__dirname, html));
  else res.send('Arquivos: ' + files.join(', '));
});

app.listen(PORT, () => console.log('OK ' + PORT));
