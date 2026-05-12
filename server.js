const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const PORT = process.env.PORT || 3000;
const PIN = '1943';

// Twilio (lidos do .env do Railway)
const TWILIO_SID    = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_VERIFY = process.env.TWILIO_VERIFY_SID;

const DATABASE_URL = process.env.DATABASE_URL;

const MIME = {
  '.html':'text/html','.css':'text/css','.js':'application/javascript',
  '.json':'application/json','.png':'image/png','.jpg':'image/jpeg',
  '.webp':'image/webp','.svg':'image/svg+xml','.ico':'image/x-icon'
};

// ═════════════════════════════════════════════════════
// AUTH (PIN do consultor)
// ═════════════════════════════════════════════════════
function makeToken(){return Buffer.from(PIN+':'+Date.now()).toString('base64')}
function validToken(t){try{var d=Buffer.from(t,'base64').toString(),p=d.split(':');return p[0]===PIN&&(Date.now()-parseInt(p[1]))<86400000}catch(e){return false}}

const PIN_HTML = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WealthPlanning</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Segoe UI',system-ui,sans-serif;background:#080e1a;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center}.login{text-align:center;max-width:360px;padding:40px}.logo{font-size:28px;font-weight:800;margin-bottom:8px}.logo span{color:#4c8bf5}.sub{font-size:13px;color:#8b949e;margin-bottom:32px}.pin-row{display:flex;gap:12px;justify-content:center;margin-bottom:24px}.pi{width:56px;height:64px;background:rgba(255,255,255,.04);border:1.5px solid rgba(255,255,255,.1);border-radius:12px;color:#fff;font-size:24px;font-weight:700;text-align:center;outline:none;-webkit-text-security:disc}.pi:focus{border-color:#4c8bf5}.btn{width:100%;padding:16px;background:linear-gradient(135deg,#4c8bf5,#3a6fd8);border:none;border-radius:12px;color:#fff;font-size:15px;font-weight:700;cursor:pointer}.btn:disabled{opacity:.4}.err{color:#f07070;font-size:13px;margin-top:16px;min-height:20px}</style></head><body><div class="login"><div class="logo">Wealth<span>Planning</span></div><div class="sub">Área restrita do consultor</div><div class="pin-row"><input class="pi" type="tel" maxlength="1" inputmode="numeric" autofocus><input class="pi" type="tel" maxlength="1" inputmode="numeric"><input class="pi" type="tel" maxlength="1" inputmode="numeric"><input class="pi" type="tel" maxlength="1" inputmode="numeric"></div><button class="btn" id="b" disabled>Entrar</button><div class="err" id="e"></div></div><script>var ii=document.querySelectorAll(".pi"),b=document.getElementById("b"),e=document.getElementById("e");ii.forEach(function(n,i){n.addEventListener("input",function(){if(n.value.length===1&&i<3)ii[i+1].focus();ck()});n.addEventListener("keydown",function(ev){if(ev.key==="Backspace"&&n.value===""&&i>0)ii[i-1].focus();if(ev.key==="Enter")go()})});function ck(){b.disabled=Array.from(ii).map(function(n){return n.value}).join("").length<4}b.onclick=go;function go(){var p=Array.from(ii).map(function(n){return n.value}).join("");if(p.length<4)return;fetch("/api/auth",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({pin:p})}).then(function(r){return r.json()}).then(function(d){if(d.ok){window.location.href="/painel?t="+d.token}else{e.textContent="PIN incorreto";ii.forEach(function(n){n.value=""});ii[0].focus();setTimeout(function(){e.textContent=""},2000)}})}</script></body></html>`;

// ═════════════════════════════════════════════════════
// POSTGRES
// ═════════════════════════════════════════════════════
let db;
async function initDb(){
  db = new Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  await db.connect();
  await db.query(`
    CREATE TABLE IF NOT EXISTS submissoes (
      id TEXT PRIMARY KEY,
      nome TEXT NOT NULL,
      whatsapp TEXT NOT NULL,
      status TEXT DEFAULT 'pendente',
      score INTEGER,
      dados JSONB NOT NULL,
      ia_consultiva JSONB,
      ia_institucional JSONB,
      criado_em TIMESTAMPTZ DEFAULT NOW(),
      analisado_em TIMESTAMPTZ
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_submissoes_criado ON submissoes(criado_em DESC);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_submissoes_status ON submissoes(status);`);
  console.log('[db] conectado · schema OK');
}

// ═════════════════════════════════════════════════════
// SESSÕES DE VERIFICAÇÃO (memória)
// Quando cliente valida código, gero um sessionToken e
// permito ele submeter dados nos próximos 60 minutos.
// ═════════════════════════════════════════════════════
const sessoes = new Map();
const SESSAO_TTL = 60 * 60 * 1000; // 1h

function novaSessao(whatsapp){
  const token = crypto.randomBytes(24).toString('base64url');
  sessoes.set(token, { whatsapp, expiresAt: Date.now() + SESSAO_TTL });
  return token;
}
function validarSessao(token, whatsapp){
  const s = sessoes.get(token);
  if(!s) return false;
  if(s.expiresAt < Date.now()){ sessoes.delete(token); return false; }
  if(s.whatsapp !== whatsapp) return false;
  return true;
}
// cleanup periódico
setInterval(()=>{
  const now = Date.now();
  let removed = 0;
  for(const [t, s] of sessoes){ if(s.expiresAt < now){ sessoes.delete(t); removed++; } }
  if(removed > 0) console.log('[sessao] limpou', removed, 'sessões expiradas');
}, 30*60*1000);

// ═════════════════════════════════════════════════════
// RATE LIMIT (memória) — máx 3 send-code por whatsapp/hora
// ═════════════════════════════════════════════════════
const rateLimit = new Map();
function checkRateLimit(whatsapp){
  const now = Date.now();
  const limit = rateLimit.get(whatsapp) || { count:0, resetAt: now + 3600*1000 };
  if(limit.resetAt < now){ limit.count = 0; limit.resetAt = now + 3600*1000; }
  limit.count++;
  rateLimit.set(whatsapp, limit);
  return limit.count <= 3;
}
setInterval(()=>{
  const now = Date.now();
  for(const [k, v] of rateLimit){ if(v.resetAt < now) rateLimit.delete(k); }
}, 30*60*1000);

// ═════════════════════════════════════════════════════
// TWILIO VERIFY (HTTPS nativo, sem npm package)
// ═════════════════════════════════════════════════════
function twilioRequest(urlPath, params){
  return new Promise((resolve, reject)=>{
    if(!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_VERIFY){
      return reject(new Error('Twilio não configurado (faltam variáveis de ambiente)'));
    }
    const auth = Buffer.from(TWILIO_SID + ':' + TWILIO_TOKEN).toString('base64');
    const body = Object.entries(params)
      .map(([k,v]) => encodeURIComponent(k)+'='+encodeURIComponent(v))
      .join('&');
    const opts = {
      hostname: 'verify.twilio.com',
      path: urlPath,
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + auth,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(opts, (res)=>{
      let data = '';
      res.on('data', c => data += c);
      res.on('end', ()=>{
        let json;
        try { json = JSON.parse(data); } catch(e){ return reject(new Error('Resposta inválida do Twilio')); }
        if(res.statusCode >= 400) return reject({status:res.statusCode, code:json.code, message:json.message||'erro Twilio'});
        resolve(json);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function twilioSendCode(whatsapp){
  return twilioRequest(
    `/v2/Services/${TWILIO_VERIFY}/Verifications`,
    { To: whatsapp, Channel: 'sms', Locale: 'pt-br' }
  );
}
function twilioCheckCode(whatsapp, code){
  return twilioRequest(
    `/v2/Services/${TWILIO_VERIFY}/VerificationCheck`,
    { To: whatsapp, Code: code }
  );
}

// ═════════════════════════════════════════════════════
// HELPERS DE HTTP
// ═════════════════════════════════════════════════════
function readBody(req){
  return new Promise((resolve)=>{
    let body = '';
    req.on('data', c => body += c);
    req.on('end', ()=>{
      try { resolve(JSON.parse(body || '{}')); }
      catch(e){ resolve({}); }
    });
  });
}
function sendJson(res, obj, status=200){
  res.writeHead(status, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
  res.end(JSON.stringify(obj));
}
function sendErr(res, message, status=400, code){
  sendJson(res, {ok:false, error:message, code:code||null}, status);
}
function getToken(req, url){
  // token vem como ?t=XXX ou header Authorization
  const q = url.searchParams.get('t');
  if(q) return q;
  const auth = req.headers.authorization || '';
  if(auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}
function requireAuth(req, res, url){
  const t = getToken(req, url);
  if(!t || !validToken(t)){
    sendErr(res, 'não autorizado', 401);
    return false;
  }
  return true;
}

// Normaliza WhatsApp para formato E.164 brasileiro: +55XXXXXXXXXXX
function normalizeWhatsapp(raw){
  if(!raw) return null;
  // remove tudo que não é dígito
  let digits = String(raw).replace(/\D/g,'');
  // se não começa com 55, adiciona
  if(!digits.startsWith('55')) digits = '55' + digits;
  // valida tamanho: 55 + DDD(2) + 9 dígitos = 13 caracteres
  if(digits.length < 12 || digits.length > 13) return null;
  return '+' + digits;
}

function novoId(){
  // ID curto, URL-safe, ~10 chars
  return crypto.randomBytes(8).toString('base64url').slice(0,10);
}

// ═════════════════════════════════════════════════════
// SERVIDOR HTTP
// ═════════════════════════════════════════════════════
const server = http.createServer(async function(req,res){
  const url = new URL(req.url, 'http://'+req.headers.host);
  const p = url.pathname;

  try {

    // ───────────────────────────────────────────────────
    // CORS preflight (qualquer endpoint /api/*)
    // ───────────────────────────────────────────────────
    if(req.method==='OPTIONS'){
      res.writeHead(204,{
        'Access-Control-Allow-Origin':'*',
        'Access-Control-Allow-Methods':'GET,POST,DELETE,OPTIONS',
        'Access-Control-Allow-Headers':'Content-Type,Authorization'
      });
      res.end();
      return;
    }

    // ───────────────────────────────────────────────────
    // AUTH do consultor (PIN) — endpoint existente
    // ───────────────────────────────────────────────────
    if(p==='/api/auth' && req.method==='POST'){
      const d = await readBody(req);
      return sendJson(res, d.pin===PIN ? {ok:true, token:makeToken()} : {ok:false});
    }

    // ───────────────────────────────────────────────────
    // PROXY ANTHROPIC — endpoint existente
    // ───────────────────────────────────────────────────
    if(p==='/api/analise-acoes/messages' && req.method==='POST'){
      let body = '';
      req.on('data', c => body += c);
      req.on('end', ()=>{
        const proxyReq = https.request({
          hostname: 'api.anthropic.com',
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type':'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version':'2023-06-01',
            'anthropic-beta':'web-search-2025-03-05'
          }
        }, function(pr){
          let data = '';
          pr.on('data', c => data += c);
          pr.on('end', ()=>{
            res.writeHead(pr.statusCode, {
              'Content-Type':'application/json',
              'Access-Control-Allow-Origin':'*'
            });
            res.end(data);
          });
        });
        proxyReq.on('error', function(e){
          res.writeHead(502,{'Content-Type':'application/json'});
          res.end(JSON.stringify({error:e.message}));
        });
        proxyReq.write(body);
        proxyReq.end();
      });
      return;
    }

    // ═══════════════════════════════════════════════════
    // NOVOS ENDPOINTS · /api/diag/*
    // ═══════════════════════════════════════════════════

    // ─── POST /api/diag/send-code · cliente solicita código ───
    if(p==='/api/diag/send-code' && req.method==='POST'){
      const d = await readBody(req);
      const wa = normalizeWhatsapp(d.whatsapp);
      if(!wa) return sendErr(res, 'WhatsApp inválido. Use o formato (47) 99999-9999.', 400);
      if(!checkRateLimit(wa)) return sendErr(res, 'Muitas tentativas. Aguarde 1 hora e tente novamente.', 429);
      try {
        const r = await twilioSendCode(wa);
        return sendJson(res, {ok:true, status:r.status, whatsapp:wa});
      } catch(err){
        console.error('[twilio send]', err);
        // erros comuns: 60200 (número inválido), 60410 (atingiu limite), 60203 (max attempts), 21608 (trial unverified)
        if(err.code === 21608) return sendErr(res, 'Em modo de testes, apenas números autorizados pelo consultor podem receber código. Entre em contato.', 400, 21608);
        if(err.code === 60200) return sendErr(res, 'Número de WhatsApp inválido.', 400, 60200);
        if(err.code === 60410) return sendErr(res, 'Muitas tentativas para esse número. Aguarde.', 429, 60410);
        return sendErr(res, 'Não foi possível enviar o código no momento.', 500);
      }
    }

    // ─── POST /api/diag/verify-code · cliente confirma código ───
    if(p==='/api/diag/verify-code' && req.method==='POST'){
      const d = await readBody(req);
      const wa = normalizeWhatsapp(d.whatsapp);
      const code = String(d.code||'').trim();
      if(!wa || !code) return sendErr(res, 'Informe WhatsApp e código.');
      if(!/^\d{4,8}$/.test(code)) return sendErr(res, 'Código inválido.');
      try {
        const r = await twilioCheckCode(wa, code);
        if(r.status === 'approved'){
          const sessionToken = novaSessao(wa);
          return sendJson(res, {ok:true, sessionToken, expiresIn: SESSAO_TTL/1000});
        }
        return sendErr(res, 'Código incorreto ou expirado.', 400);
      } catch(err){
        console.error('[twilio check]', err);
        if(err.code === 20404) return sendErr(res, 'Código expirado. Solicite um novo.', 400);
        return sendErr(res, 'Não foi possível verificar o código.', 500);
      }
    }

    // ─── POST /api/diag/submit · cliente envia dados do wizard ───
    if(p==='/api/diag/submit' && req.method==='POST'){
      const d = await readBody(req);
      const wa = normalizeWhatsapp(d.whatsapp);
      if(!wa) return sendErr(res, 'WhatsApp inválido.');
      if(!validarSessao(d.sessionToken, wa)){
        return sendErr(res, 'Sessão expirada. Verifique seu WhatsApp novamente.', 401);
      }
      if(!d.nome || !d.dados){
        return sendErr(res, 'Dados incompletos.');
      }
      const id = novoId();
      try {
        await db.query(
          `INSERT INTO submissoes (id, nome, whatsapp, status, score, dados)
           VALUES ($1, $2, $3, 'pendente', $4, $5)`,
          [id, String(d.nome).trim().slice(0,120), wa, Number(d.score)||null, d.dados]
        );
        // invalida sessão pra evitar duplo envio
        sessoes.delete(d.sessionToken);
        console.log('[submit] nova submissão', id, 'de', d.nome, wa);
        return sendJson(res, {ok:true, id});
      } catch(err){
        console.error('[submit]', err);
        return sendErr(res, 'Erro ao salvar.', 500);
      }
    }

    // ─── GET /api/diag/list · consultor lista submissões (PROTEGIDO) ───
    if(p==='/api/diag/list' && req.method==='GET'){
      if(!requireAuth(req, res, url)) return;
      try {
        const r = await db.query(
          `SELECT id, nome, whatsapp, status, score, criado_em, analisado_em
           FROM submissoes ORDER BY criado_em DESC LIMIT 200`
        );
        return sendJson(res, {ok:true, items: r.rows});
      } catch(err){
        console.error('[list]', err);
        return sendErr(res, 'Erro ao listar.', 500);
      }
    }

    // ─── GET /api/diag/get?id=X · consultor abre submissão (PROTEGIDO) ───
    if(p==='/api/diag/get' && req.method==='GET'){
      if(!requireAuth(req, res, url)) return;
      const id = url.searchParams.get('id');
      if(!id) return sendErr(res, 'Falta id.');
      try {
        const r = await db.query(`SELECT * FROM submissoes WHERE id=$1`, [id]);
        if(r.rows.length === 0) return sendErr(res, 'Submissão não encontrada.', 404);
        return sendJson(res, {ok:true, item: r.rows[0]});
      } catch(err){
        console.error('[get]', err);
        return sendErr(res, 'Erro ao buscar.', 500);
      }
    }

    // ─── POST /api/diag/save-ia?id=X · consultor cacheia IA gerada (PROTEGIDO) ───
    // body: { iaConsultiva?, iaInstitucional? }
    if(p==='/api/diag/save-ia' && req.method==='POST'){
      if(!requireAuth(req, res, url)) return;
      const id = url.searchParams.get('id');
      if(!id) return sendErr(res, 'Falta id.');
      const d = await readBody(req);
      const sets = [];
      const vals = [id];
      let i = 2;
      if(d.iaConsultiva !== undefined){ sets.push(`ia_consultiva=$${i++}`); vals.push(d.iaConsultiva); }
      if(d.iaInstitucional !== undefined){ sets.push(`ia_institucional=$${i++}`); vals.push(d.iaInstitucional); }
      if(sets.length === 0) return sendErr(res, 'Nada para salvar.');
      sets.push(`status='analisado'`);
      sets.push(`analisado_em=NOW()`);
      try {
        await db.query(`UPDATE submissoes SET ${sets.join(',')} WHERE id=$1`, vals);
        return sendJson(res, {ok:true});
      } catch(err){
        console.error('[save-ia]', err);
        return sendErr(res, 'Erro ao salvar IA.', 500);
      }
    }

    // ─── DELETE /api/diag/delete?id=X · consultor remove submissão (PROTEGIDO) ───
    if(p==='/api/diag/delete' && (req.method==='DELETE' || req.method==='POST')){
      if(!requireAuth(req, res, url)) return;
      const id = url.searchParams.get('id');
      if(!id) return sendErr(res, 'Falta id.');
      try {
        await db.query(`DELETE FROM submissoes WHERE id=$1`, [id]);
        return sendJson(res, {ok:true});
      } catch(err){
        console.error('[delete]', err);
        return sendErr(res, 'Erro ao deletar.', 500);
      }
    }

    // ═══════════════════════════════════════════════════
    // PÁGINAS HTML (mantém comportamento original)
    // ═══════════════════════════════════════════════════

    // Raiz → LP (raio-x.html) se existir, senão plano-futuro
    if(p==='/'){
      if(fs.existsSync(path.join(__dirname,'raio-x.html')))
        return serve(res,'raio-x.html');
      return serve(res,'plano-futuro.html');
    }

    // /app → tela de PIN
    if(p==='/app'){
      res.writeHead(200,{'Content-Type':'text/html'});
      res.end(PIN_HTML);
      return;
    }

    // /painel → ferramenta protegida
    if(p==='/painel'){
      if(validToken(url.searchParams.get('t'))) return serve(res,'plano-futuro.html');
      res.writeHead(302,{'Location':'/app'});res.end();return;
    }

    // Estáticos (qualquer .html, .css, .js, imagem na raiz)
    var ext = path.extname(p);
    if(ext && MIME[ext]) return serve(res, p.slice(1));

    // Fallback → raiz
    res.writeHead(302,{'Location':'/'});res.end();

  } catch(err){
    console.error('[server] erro não tratado', err);
    if(!res.headersSent) sendErr(res, 'Erro interno do servidor.', 500);
  }
});

server.listen(PORT, async function(){
  console.log('WealthPlanning porta '+PORT);
  try {
    await initDb();
  } catch(e){
    console.error('[db] falhou conectar:', e.message);
    console.error('[db] o servidor continua rodando, mas endpoints de diagnóstico não funcionarão.');
  }
});

function serve(res, file){
  fs.readFile(path.join(__dirname, file), function(err, data){
    if(err){ res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, {'Content-Type': MIME[path.extname(file)] || 'text/html'});
    res.end(data);
  });
}
