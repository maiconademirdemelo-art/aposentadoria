const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
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
      -- Adiciona celular se já existia a tabela sem ele
      ALTER TABLE cooperados ADD COLUMN IF NOT EXISTS celular VARCHAR(20) DEFAULT '';
    `);
    console.log('DB: tabela cooperados OK');
  } catch (e) {
    console.error('DB init error:', e.message);
  }
}
initDB();

app.use(express.json());
app.use(express.static(path.join(__dirname)));

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
    if (elRes.statusCode !== 200) {
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
  // Aceita via header Authorization ou via query param ?auth=
  let authB64 = null;
  const header = req.headers['authorization'];
  if (header && header.startsWith('Basic ')) {
    authB64 = header.split(' ')[1];
  } else if (req.query.auth) {
    authB64 = req.query.auth;
  }
  if (!authB64) {
    // Retorna 401 sem WWW-Authenticate para não abrir popup nativo
    return res.status(401).json({ error: 'unauthorized' });
  }
  const [user, pass] = Buffer.from(authB64, 'base64').toString().split(':');
  if (user === ADMIN_USER && pass === ADMIN_PASS) return next();
  res.status(401).json({ error: 'invalid credentials' });
}

// ── API ADMIN — listar cooperados ──
app.get('/admin/api/cooperados', checkAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT * FROM cooperados ORDER BY criado_em DESC LIMIT 500
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API ADMIN — deletar cooperado ──
app.delete('/admin/api/cooperados/:id', checkAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM cooperados WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PAINEL ADMIN HTML ──
app.get('/admin', checkAuth, (req, res) => {
  const authToken = req.query.auth || Buffer.from(ADMIN_USER+':'+ADMIN_PASS).toString('base64');
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Painel Unicred · WealthPlanning</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js"></script>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@400;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#080e1a;--surf:#0f1b2d;--surf2:#0d1726;--bdr:#1e3a5f;
  --accent:#4c8bf5;--green:#2ecc8a;--red:#f07070;--warn:#f5c842;
  --text:#ededed;--muted:#8a95a3;
}
body{font-family:'Bricolage Grotesque',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;overflow-x:hidden}

/* ── HEADER ── */
.hdr{position:sticky;top:0;z-index:100;background:rgba(8,14,26,.92);backdrop-filter:blur(16px);border-bottom:1px solid var(--bdr);padding:0 32px;height:64px;display:flex;align-items:center;justify-content:space-between}
.logo{display:flex;align-items:center;gap:10px;font-weight:800;font-size:18px;color:#fff}
.logo svg{flex-shrink:0}
.logo span{color:var(--accent)}
.hdr-right{display:flex;align-items:center;gap:16px}
.hdr-badge{background:rgba(76,139,245,.15);color:var(--accent);font-size:11px;font-weight:700;padding:4px 12px;border-radius:99px;border:1px solid rgba(76,139,245,.3);font-family:'JetBrains Mono',monospace;letter-spacing:.05em}
.hdr-time{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--muted)}

/* ── STATS ── */
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--bdr);border-bottom:1px solid var(--bdr)}
.stat{background:var(--surf);padding:20px 28px}
.stat-lbl{font-family:'JetBrains Mono',monospace;font-size:9px;color:var(--muted);letter-spacing:.15em;text-transform:uppercase;margin-bottom:10px}
.stat-val{font-size:26px;font-weight:800;letter-spacing:-.5px}
.stat-val.blue{color:var(--accent)}
.stat-val.green{color:var(--green)}
.stat-val.warn{color:var(--warn)}
.stat-sub{font-size:11px;color:var(--muted);margin-top:4px}

/* ── CONTROLES ── */
.controls{padding:20px 32px;display:flex;gap:10px;align-items:center;border-bottom:1px solid var(--bdr);background:var(--surf2)}
.search{flex:1;background:rgba(255,255,255,.04);border:1px solid var(--bdr);border-radius:8px;padding:10px 16px;color:var(--text);font-family:'Bricolage Grotesque',sans-serif;font-size:14px;outline:none;transition:border-color .2s}
.search:focus{border-color:var(--accent)}
.search::placeholder{color:var(--muted)}
.sel{background:rgba(255,255,255,.04);border:1px solid var(--bdr);border-radius:8px;padding:10px 14px;color:var(--text);font-family:'Bricolage Grotesque',sans-serif;font-size:13px;outline:none;cursor:pointer}
.btn{padding:10px 18px;border-radius:8px;font-family:'Bricolage Grotesque',sans-serif;font-size:13px;font-weight:700;cursor:pointer;border:none;transition:all .15s;display:flex;align-items:center;gap:6px}
.btn-primary{background:var(--accent);color:#fff}
.btn-primary:hover{background:#3a72e0}
.btn-ghost{background:rgba(255,255,255,.06);color:var(--text);border:1px solid var(--bdr)}
.btn-ghost:hover{background:rgba(255,255,255,.1)}
.count-badge{background:rgba(76,139,245,.15);color:var(--accent);font-family:'JetBrains Mono',monospace;font-size:11px;padding:4px 10px;border-radius:99px;margin-left:auto}

/* ── LISTA ── */
.list{padding:0}
.card{display:grid;grid-template-columns:48px 1fr auto auto auto auto 120px 40px;align-items:center;gap:0;padding:0 32px;height:72px;border-bottom:1px solid rgba(30,58,95,.5);transition:background .15s;cursor:pointer}
.card:hover{background:rgba(76,139,245,.05)}
.card-rank{font-family:'JetBrains Mono',monospace;font-size:13px;color:var(--muted);font-weight:600}
.card-rank.top{color:var(--warn)}
.card-name{font-weight:700;font-size:15px;color:#fff}
.card-date{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--muted);margin-top:2px}
.card-col{text-align:right;padding:0 20px}
.card-col-lbl{font-family:'JetBrains Mono',monospace;font-size:9px;color:var(--muted);letter-spacing:.1em;text-transform:uppercase;margin-bottom:4px}
.card-col-val{font-size:14px;font-weight:700}
.card-col-val.green{color:var(--green)}
.card-col-val.blue{color:var(--accent)}
.perfil-tag{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:99px;font-size:10px;font-weight:700;text-transform:uppercase;font-family:'JetBrains Mono',monospace}
.perfil-tag.conservador{background:rgba(46,204,138,.1);color:var(--green);border:1px solid rgba(46,204,138,.2)}
.perfil-tag.moderado{background:rgba(76,139,245,.1);color:var(--accent);border:1px solid rgba(76,139,245,.2)}
.perfil-tag.arrojado{background:rgba(245,200,66,.1);color:var(--warn);border:1px solid rgba(245,200,66,.2)}
.bar-wrap{width:100px;height:4px;background:rgba(255,255,255,.08);border-radius:99px;overflow:hidden}
.bar-fill{height:100%;border-radius:99px;background:var(--accent);transition:width .6s ease}
.arrow{color:var(--muted);font-size:18px;transition:transform .15s}
.card:hover .arrow{color:var(--accent);transform:translateX(3px)}
.empty{text-align:center;padding:80px 32px;color:var(--muted)}
.empty-icon{font-size:40px;margin-bottom:16px;opacity:.4}

/* ── MODAL DASH ── */
.modal-overlay{position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.75);backdrop-filter:blur(8px);display:none;align-items:flex-start;justify-content:center;overflow-y:auto;padding:24px}
.modal-overlay.show{display:flex}
.modal{background:var(--surf);border:1px solid var(--bdr);border-radius:16px;width:100%;max-width:900px;margin:auto;overflow:hidden;animation:modalIn .25s ease;max-height:90vh;overflow-y:auto}
@keyframes modalIn{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
.modal-hdr{padding:24px 28px;border-bottom:1px solid var(--bdr);display:flex;align-items:center;justify-content:space-between}
.modal-name{font-size:22px;font-weight:800;color:#fff}
.modal-sub{font-size:12px;color:var(--muted);margin-top:3px;font-family:'JetBrains Mono',monospace}
.modal-close{width:36px;height:36px;background:rgba(255,255,255,.06);border:1px solid var(--bdr);border-radius:8px;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:18px;color:var(--muted);transition:all .15s}
.modal-close:hover{background:rgba(255,255,255,.12);color:#fff}
.modal-body{padding:28px}
.modal-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px}
.mkpi{background:rgba(255,255,255,.03);border:1px solid var(--bdr);border-radius:10px;padding:16px}
.mkpi-lbl{font-family:'JetBrains Mono',monospace;font-size:9px;color:var(--muted);letter-spacing:.1em;text-transform:uppercase;margin-bottom:8px}
.mkpi-val{font-size:20px;font-weight:800}
.mkpi-val.green{color:var(--green)}
.mkpi-val.blue{color:var(--accent)}
.mkpi-val.red{color:var(--red)}
.mkpi-sub{font-size:11px;color:var(--muted);margin-top:4px}
.modal-section{margin-bottom:20px}
.modal-section-title{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--muted);letter-spacing:.15em;text-transform:uppercase;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid var(--bdr)}
.info-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.info-item{background:rgba(255,255,255,.03);border-radius:8px;padding:12px 14px}
.info-lbl{font-size:10px;color:var(--muted);margin-bottom:4px}
.info-val{font-size:14px;font-weight:700;color:#fff}
.banner-modal{border-radius:10px;padding:16px 20px;display:flex;align-items:center;gap:14px;margin-bottom:20px}
.banner-modal.ok{background:rgba(46,204,138,.08);border:1px solid rgba(46,204,138,.2)}
.banner-modal.warn{background:rgba(245,200,66,.08);border:1px solid rgba(245,200,66,.2)}
.banner-ico{font-size:24px}
.banner-txt .b1{font-weight:700;font-size:15px}
.banner-txt .b2{font-size:12px;color:var(--muted);margin-top:3px}
.modal-actions{display:flex;gap:10px;padding:20px 28px;border-top:1px solid var(--bdr);background:rgba(0,0,0,.2)}
.btn-del-modal{background:rgba(240,112,112,.1);color:var(--red);border:1px solid rgba(240,112,112,.25);padding:10px 18px;border-radius:8px;font-family:'Bricolage Grotesque',sans-serif;font-size:13px;font-weight:700;cursor:pointer;transition:all .15s}
.btn-del-modal:hover{background:rgba(240,112,112,.2)}

/* LOADING */
.loading-wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:80px;gap:16px;color:var(--muted)}
.spinner{width:32px;height:32px;border:3px solid rgba(76,139,245,.2);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

@media(max-width:900px){
  .stats{grid-template-columns:1fr 1fr}
  .card{grid-template-columns:36px 1fr auto 40px;height:auto;padding:16px 20px;gap:8px}
  .card-col:not(:last-child){display:none}
  .modal-kpis{grid-template-columns:1fr 1fr}
  .info-grid{grid-template-columns:1fr 1fr}
  .hdr{padding:0 20px}
  .controls{padding:16px 20px;flex-wrap:wrap}
  .list .card{padding:14px 20px}
}
</style>
</head>
<body>

<header class="hdr">
  <div class="logo">
    <svg width="28" height="28" viewBox="0 0 22 22" fill="none"><path d="M11 2L19.5 7V15L11 20L2.5 15V7L11 2Z" stroke="#4c8bf5" stroke-width="1.5" fill="none"/><circle cx="11" cy="11" r="3" fill="#4c8bf5"/></svg>
    Wealth<span>Planning</span>
  </div>
  <div class="hdr-right">
    <div class="hdr-badge">PAINEL UNICRED</div>
    <div class="hdr-time" id="hdr-time">—</div>
  </div>
</header>

<div class="stats">
  <div class="stat">
    <div class="stat-lbl">Cooperados</div>
    <div class="stat-val blue" id="s-total">—</div>
    <div class="stat-sub">diagnósticos realizados</div>
  </div>
  <div class="stat">
    <div class="stat-lbl">Patrimônio Médio Futuro</div>
    <div class="stat-val green" id="s-pat">—</div>
    <div class="stat-sub">na aposentadoria</div>
  </div>
  <div class="stat">
    <div class="stat-lbl">Renda Média Mensal</div>
    <div class="stat-val" id="s-renda">—</div>
    <div class="stat-sub">projetada</div>
  </div>
  <div class="stat">
    <div class="stat-lbl">Maior Patrimônio</div>
    <div class="stat-val warn" id="s-top">—</div>
    <div class="stat-sub" id="s-top-name">—</div>
  </div>
</div>

<div class="controls">
  <input class="search" id="search" placeholder="Buscar cooperado por nome..." oninput="filtrar()">
  <select class="sel" id="f-perfil" onchange="filtrar()">
    <option value="">Todos os perfis</option>
    <option value="conservador">Conservador</option>
    <option value="moderado">Moderado</option>
    <option value="arrojado">Arrojado</option>
  </select>
  <select class="sel" id="f-estrat" onchange="filtrar()">
    <option value="">Todas estratégias</option>
    <option value="renda">Viver de renda</option>
    <option value="consumo">Consumir patrimônio</option>
  </select>
  <button class="btn btn-ghost" onclick="exportCSV()">⬇ CSV</button>
  <button class="btn btn-primary" onclick="carregar()">↻ Atualizar</button>
  <span class="count-badge" id="count-badge">0 cooperados</span>
</div>

<div class="list" id="list">
  <div class="loading-wrap"><div class="spinner"></div><div>Carregando cooperados...</div></div>
</div>

<!-- MODAL PLANEJAMENTO COMPLETO -->
<div class="modal-overlay" id="modal" onclick="fecharModal(event)">
  <div class="modal" id="modal-box">
    <div class="modal-hdr">
      <div>
        <div class="modal-name" id="m-nome">—</div>
        <div class="modal-sub" id="m-sub">—</div>
      </div>
      <div class="modal-close" onclick="fecharModal(null,true)">✕</div>
    </div>
    <div class="modal-body">
      <!-- Banner status -->
      <div class="banner-modal" id="m-banner">
        <div class="banner-ico" id="m-bico">—</div>
        <div class="banner-txt"><div class="b1" id="m-bt">—</div><div class="b2" id="m-bd">—</div></div>
        <div id="m-bval" style="font-size:18px;font-weight:800;margin-left:auto;white-space:nowrap">—</div>
      </div>
      <!-- 4 KPIs -->
      <div class="modal-kpis" id="m-kpis"></div>
      <!-- Gráfico -->
      <div class="modal-section">
        <div class="modal-section-title" id="m-chart-title">Projeção Patrimonial</div>
        <div style="position:relative;height:220px;margin-bottom:8px">
          <canvas id="m-chart"></canvas>
        </div>
        <div style="display:flex;gap:16px;justify-content:flex-end;font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--muted)" id="m-legend"></div>
      </div>
      <!-- Dados do cooperado -->
      <div class="modal-section">
        <div class="modal-section-title">Dados do Cooperado</div>
        <div class="info-grid" id="m-info"></div>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn-del-modal" id="m-del-btn">🗑 Excluir</button>
      <div style="margin-left:auto;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--muted);display:flex;align-items:center" id="m-id">—</div>
    </div>
  </div>
</div>

<script>
let dados = [];
let modalId = null;

function fmtR(v){ return 'R$ ' + Number(v).toLocaleString('pt-BR'); }
function fmtK(v){ const n=Number(v); return n>=1000000?'R$ '+(n/1000000).toFixed(1)+'M':n>=1000?'R$ '+(n/1000).toFixed(0)+'K':fmtR(n); }
function fmtDate(d){ return new Date(d).toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',year:'2-digit',hour:'2-digit',minute:'2-digit'}); }
function fmtDateLong(d){ return new Date(d).toLocaleDateString('pt-BR',{day:'2-digit',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit'}); }

// Atualiza hora no header
function tick(){ document.getElementById('hdr-time').textContent = new Date().toLocaleTimeString('pt-BR'); }
tick(); setInterval(tick, 1000);

async function carregar(){
  document.getElementById('list').innerHTML = '<div class="loading-wrap"><div class="spinner"></div><div>Carregando cooperados...</div></div>';
  try{
    const authToken = new URLSearchParams(window.location.search).get('auth') || '';
    const r = await fetch('/admin/api/cooperados', {
      headers: authToken ? { 'Authorization': 'Basic ' + authToken } : {}
    });
    if(!r.ok) throw new Error('Erro '+r.status);
    // Ordena por patrimônio futuro decrescente
    dados = (await r.json()).sort((a,b) => Number(b.patrimonio_futuro) - Number(a.patrimonio_futuro));
    renderStats();
    renderLista(dados);
  }catch(e){
    document.getElementById('list').innerHTML = '<div class="empty"><div class="empty-icon">⚠️</div>Erro ao carregar: '+e.message+'</div>';
  }
}

function renderStats(){
  document.getElementById('s-total').textContent = dados.length;
  if(!dados.length){ ['s-pat','s-renda','s-top','s-top-name'].forEach(id=>document.getElementById(id).textContent='—'); return; }
  const patMed = Math.round(dados.reduce((a,b)=>a+Number(b.patrimonio_futuro),0)/dados.length);
  const rendMed = Math.round(dados.reduce((a,b)=>a+Number(b.renda_mensal),0)/dados.length);
  document.getElementById('s-pat').textContent = fmtK(patMed);
  document.getElementById('s-renda').textContent = fmtR(rendMed);
  document.getElementById('s-top').textContent = fmtK(dados[0].patrimonio_futuro);
  document.getElementById('s-top-name').textContent = dados[0].nome;
}

function renderLista(lista){
  const el = document.getElementById('list');
  document.getElementById('count-badge').textContent = lista.length + ' cooperado' + (lista.length!==1?'s':'');
  if(!lista.length){
    el.innerHTML = '<div class="empty"><div class="empty-icon">👥</div>Nenhum cooperado encontrado</div>';
    return;
  }
  const maxPat = Math.max(...lista.map(c=>Number(c.patrimonio_futuro)));
  el.innerHTML = lista.map((c,i) => {
    const rank = dados.indexOf(c)+1;
    const barW = Math.round((Number(c.patrimonio_futuro)/maxPat)*100);
    const isRenda = c.estrategia==='renda';
    return \`
    <div class="card" onclick="abrirModal(\${c.id})">
      <div class="card-rank\${rank<=3?' top':''}">
        \${rank<=3?['🥇','🥈','🥉'][rank-1]:'#'+rank}
      </div>
      <div>
        <div class="card-name">\${c.nome}</div>
        <div class="card-date">\${c.celular ? c.celular + ' · ' : ''}\${fmtDate(c.criado_em)}</div>
      </div>
      <div class="card-col">
        <div class="card-col-lbl">Patrimônio Futuro</div>
        <div class="card-col-val green">\${fmtK(c.patrimonio_futuro)}</div>
        <div style="margin-top:6px"><div class="bar-wrap"><div class="bar-fill" style="width:\${barW}%"></div></div></div>
      </div>
      <div class="card-col">
        <div class="card-col-lbl">Renda Mensal</div>
        <div class="card-col-val blue">\${fmtR(c.renda_mensal)}</div>
      </div>
      <div class="card-col">
        <div class="card-col-lbl">Perfil</div>
        <div><span class="perfil-tag \${c.perfil}">\${c.perfil}</span></div>
      </div>
      <div class="card-col">
        <div class="card-col-lbl">Estratégia</div>
        <div style="font-size:13px;color:var(--muted)">\${isRenda?'Viver de renda':'Consumir'}</div>
      </div>
      <div style="width:100px"></div>
      <div class="arrow">›</div>
    </div>
  \`;}).join('');
}

function filtrar(){
  const busca = document.getElementById('search').value.toLowerCase();
  const perfil = document.getElementById('f-perfil').value;
  const estrat = document.getElementById('f-estrat').value;
  renderLista(dados.filter(c=>
    (!busca || c.nome.toLowerCase().includes(busca)) &&
    (!perfil || c.perfil===perfil) &&
    (!estrat || c.estrategia===estrat)
  ));
}

function abrirModal(id){
  const c = dados.find(d=>d.id===id);
  if(!c) return;
  modalId = id;
  const isRenda = c.estrategia==='renda';
  const rank = dados.indexOf(c)+1;
  const CDI=0.105, INFL=0.045;
  const FAT={conservador:1.0,moderado:1.2,arrojado:1.7};
  const taxaBruta=CDI*FAT[c.perfil];
  const taxaAnual=((1+taxaBruta)/(1+INFL))-1;
  const taxaMes=taxaAnual/12;
  const anos=Number(c.idade_aposentadoria)-Number(c.idade);

  document.getElementById('m-nome').textContent = c.nome;
  document.getElementById('m-sub').textContent =
    (c.celular?c.celular+' · ':'')+'#'+c.id+' · '+fmtDateLong(c.criado_em)+' · Ranking #'+rank;

  // Banner
  const ok = isRenda || !c.esgota_em;
  const banner = document.getElementById('m-banner');
  banner.className = 'banner-modal '+(ok?'ok':'warn');
  document.getElementById('m-bico').textContent = ok?'💚':'⚠️';
  document.getElementById('m-bt').textContent = ok
    ? (isRenda?'Renda passiva vitalícia — principal preservado':'Patrimônio dura até os 99 anos')
    : 'Patrimônio se esgota aos '+c.esgota_em+' anos';
  document.getElementById('m-bd').textContent = isRenda
    ? 'Recebe '+fmtR(c.renda_mensal)+'/mês sem tocar no principal'
    : (ok?'Retira '+fmtR(c.renda_mensal)+'/mês até os 99 anos':'Considere aumentar o aporte ou ajustar a estratégia');
  document.getElementById('m-bval').textContent = fmtR(c.renda_mensal)+'/mês';

  // KPIs
  document.getElementById('m-kpis').innerHTML = [
    {lbl:'Patrimônio na Aposent.',val:fmtK(c.patrimonio_futuro),cls:'green',sub:'aos '+c.idade_aposentadoria+' anos'},
    {lbl:'Renda Mensal',val:fmtR(c.renda_mensal),cls:'blue',sub:isRenda?'sem tocar no principal':'por '+(99-c.idade_aposentadoria)+' anos'},
    {lbl:'Taxa Real Anual',val:Number(c.taxa_real_anual).toFixed(1)+'%',cls:'',sub:{conservador:'100% CDI',moderado:'120% CDI',arrojado:'170% CDI'}[c.perfil]},
    {lbl:c.esgota_em?'Esgota em':'Dura até',val:c.esgota_em?(c.esgota_em+' anos'):'99+ anos',cls:c.esgota_em?'red':'green',sub:c.esgota_em?'⚠ rever estratégia':'✓ dentro do plano'},
  ].map(k=>'<div class="mkpi"><div class="mkpi-lbl">'+k.lbl+'</div><div class="mkpi-val '+k.cls+'">'+k.val+'</div><div class="mkpi-sub">'+k.sub+'</div></div>').join('');

  // Info grid
  document.getElementById('m-info').innerHTML = [
    {lbl:'Celular',val:c.celular||'Não informado'},
    {lbl:'Idade Atual',val:c.idade+' anos'},
    {lbl:'Aposentadoria',val:c.idade_aposentadoria+' anos'},
    {lbl:'Anos p/ aposentar',val:anos+' anos'},
    {lbl:'Aporte Mensal',val:fmtR(c.aporte)},
    {lbl:'Patrimônio Atual',val:fmtR(c.patrimonio_atual)},
    {lbl:'Perfil',val:c.perfil.charAt(0).toUpperCase()+c.perfil.slice(1)},
    {lbl:'Estratégia',val:isRenda?'Viver de renda':'Consumir patrimônio'},
    {lbl:'Cadastrado em',val:fmtDateLong(c.criado_em)},
  ].map(i=>'<div class="info-item"><div class="info-lbl">'+i.lbl+'</div><div class="info-val">'+i.val+'</div></div>').join('');

  // Gráfico — reconstrói a série
  const series = [];
  let p = Number(c.patrimonio_atual);
  for(let age=Number(c.idade); age<=Number(c.idade_aposentadoria); age++){
    for(let m=0;m<12;m++) p=p*(1+taxaMes)+Number(c.aporte);
    series.push({age, patrimonio:Math.round(p), phase:'acc'});
  }
  const totalFut = Math.round(p);
  if(isRenda){
    for(let age=Number(c.idade_aposentadoria)+1; age<=95; age++){
      for(let m=0;m<12;m++) p=p*(1+taxaMes);
      series.push({age, patrimonio:Math.round(p), phase:'ben'});
    }
  } else {
    const renda = Number(c.renda_mensal);
    for(let age=Number(c.idade_aposentadoria)+1; age<=99; age++){
      for(let m=0;m<12;m++){ p=p*(1+taxaMes)-renda; if(p<0)p=0; }
      series.push({age, patrimonio:Math.round(p), phase:p<=0?'zero':'dec'});
      if(p<=0) break;
    }
  }

  const aposIdx = series.findIndex(s=>s.age===Number(c.idade_aposentadoria));
  const labels = series.map(s=>s.age+'a');
  const accData = series.map((s,i)=>i<=aposIdx?s.patrimonio:null);
  const benData = series.map((s,i)=>i>=aposIdx?s.patrimonio:null);

  document.getElementById('m-chart-title').textContent =
    isRenda?'Projeção · Renda Vitalícia':'Projeção · Consumo até 99 anos';
  document.getElementById('m-legend').innerHTML = [
    {c:'#4c8bf5',l:'Fase de acumulação'},
    isRenda?{c:'rgba(76,139,245,.5)',l:'Renda passiva'}:{c:'#f07070',l:'Consumo do patrimônio'}
  ].map(x=>'<div style="display:flex;align-items:center;gap:5px"><div style="width:10px;height:3px;background:'+x.c+';border-radius:2px"></div>'+x.l+'</div>').join('');

  // Destroi chart anterior se existir
  if(window._mChart){ window._mChart.destroy(); window._mChart=null; }
  setTimeout(()=>{
    const ctx = document.getElementById('m-chart').getContext('2d');
    const gA=ctx.createLinearGradient(0,0,0,220);gA.addColorStop(0,'rgba(76,139,245,.2)');gA.addColorStop(1,'rgba(76,139,245,.01)');
    const gD=ctx.createLinearGradient(0,0,0,220);gD.addColorStop(0,'rgba(240,112,112,.15)');gD.addColorStop(1,'rgba(240,112,112,.01)');
    window._mChart = new Chart(ctx,{type:'line',data:{labels,datasets:[
      {label:'Acumulação',data:accData,borderColor:'#4c8bf5',borderWidth:2,backgroundColor:gA,fill:true,tension:.38,pointRadius:0,spanGaps:false},
      {label:isRenda?'Renda':'Consumo',data:benData,borderColor:isRenda?'rgba(76,139,245,.5)':'#f07070',borderWidth:2,borderDash:isRenda?[]:[5,4],backgroundColor:isRenda?'rgba(76,139,245,.05)':gD,fill:true,tension:.38,pointRadius:0,spanGaps:false}
    ]},options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{enabled:true,mode:'index',intersect:false,
        callbacks:{label:item=>' '+fmtK(item.raw)}}},
      scales:{
        x:{grid:{color:'rgba(255,255,255,.04)'},border:{display:false},ticks:{color:'#8a95a3',font:{family:'JetBrains Mono',size:9},maxTicksLimit:8,maxRotation:0}},
        y:{position:'right',grid:{color:'rgba(255,255,255,.04)'},border:{display:false},ticks:{color:'#8a95a3',font:{family:'JetBrains Mono',size:9},callback:v=>fmtK(v),maxTicksLimit:4}}
      }
    },plugins:[{id:'aposLine',afterDraw(chart){
      const{ctx:cx,chartArea,scales:{x}}=chart;if(!chartArea)return;
      const xpx=x.getPixelForValue(aposIdx);
      cx.save();cx.setLineDash([4,3]);cx.strokeStyle='rgba(76,139,245,.4)';cx.lineWidth=1;
      cx.beginPath();cx.moveTo(xpx,chartArea.top);cx.lineTo(xpx,chartArea.bottom);cx.stroke();
      cx.setLineDash([]);cx.fillStyle='rgba(76,139,245,.8)';cx.font='9px JetBrains Mono,monospace';
      cx.fillText('Aposentadoria',xpx+4,chartArea.top+12);cx.restore();
    }}]});
  }, 50);

  document.getElementById('m-id').textContent = 'ID #'+c.id;
  document.getElementById('m-del-btn').onclick = () => deletar(id);
  document.getElementById('modal').classList.add('show');
  document.body.style.overflow = 'hidden';
}


function fecharModal(e, force){
  if(!force && e && document.getElementById('modal-box').contains(e.target)) return;
  document.getElementById('modal').classList.remove('show');
  document.body.style.overflow = '';
  modalId = null;
}

document.addEventListener('keydown', e => { if(e.key==='Escape') fecharModal(null,true); });

async function deletar(id){
  if(!confirm('Excluir este diagnóstico?')) return;
  const authTok = new URLSearchParams(window.location.search).get('auth') || '';
  await fetch('/admin/api/cooperados/'+id, {
    method:'DELETE',
    headers: authTok ? { 'Authorization': 'Basic ' + authTok } : {}
  });
  dados = dados.filter(c=>c.id!==id);
  fecharModal(null,true);
  renderStats();
  filtrar();
}

function exportCSV(){
  const cols=['ID','Nome','Celular','Data','Idade','Aposentadoria','Aporte','Patrimônio Atual','Perfil','Estratégia','Patrimônio Futuro','Renda Mensal','Taxa Real %','Esgota em'];
  const rows=dados.map(c=>[c.id,c.nome,c.celular||'',new Date(c.criado_em).toLocaleDateString('pt-BR'),c.idade,c.idade_aposentadoria,c.aporte,c.patrimonio_atual,c.perfil,c.estrategia,c.patrimonio_futuro,c.renda_mensal,Number(c.taxa_real_anual).toFixed(1),c.esgota_em||'99+']);
  const csv=[cols,...rows].map(r=>r.join(';')).join('\n');
  const a=document.createElement('a');
  a.href='data:text/csv;charset=utf-8,\uFEFF'+encodeURIComponent(csv);
  a.download='cooperados_'+new Date().toISOString().slice(0,10)+'.csv';
  a.click();
}

carregar();
setInterval(carregar, 60000);
</script>
</body>
</html>`);
});

// ── SERVIR HTML PRINCIPAL ──
app.get('*', (req, res) => {
  const files = fs.readdirSync(__dirname);
  const html = files.find(f => f.endsWith('.html'));
  if (html) res.sendFile(path.join(__dirname, html));
  else res.send('Arquivos: ' + files.join(', '));
});

app.listen(PORT, () => console.log('OK ' + PORT));
