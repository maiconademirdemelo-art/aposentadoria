const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const PORT = process.env.PORT || 3000;

// ═════════════════════════════════════════════════════
// CONFIGURAÇÃO DE SEGURANÇA
// ═════════════════════════════════════════════════════
const PIN = process.env.WEALTH_PIN || '1943';
if(!process.env.WEALTH_PIN){
  console.warn('[security] WEALTH_PIN não definido em env! Usando fallback. RECOMENDAÇÃO: defina WEALTH_PIN no Railway para evitar exposição via código-fonte.');
}

const JWT_SECRET = process.env.JWT_SECRET || (() => {
  console.warn('[security] JWT_SECRET não definido em env! Tokens permanecerão válidos só durante a vida deste processo. RECOMENDAÇÃO: defina JWT_SECRET no Railway (string aleatória >= 32 chars).');
  return crypto.randomBytes(32).toString('hex');
})();

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
// AUTH (PIN do consultor) — JWT assinado HMAC-SHA256
// ═════════════════════════════════════════════════════
function b64url(buf){
  return (Buffer.isBuffer(buf) ? buf : Buffer.from(buf))
    .toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}
function b64urlDecode(s){
  // pad base64url back to standard
  s = s.replace(/-/g,'+').replace(/_/g,'/');
  while(s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}
function makeToken(){
  const header = b64url(JSON.stringify({alg:'HS256', typ:'JWT'}));
  const now = Math.floor(Date.now()/1000);
  const payload = b64url(JSON.stringify({
    iat: now,
    exp: now + 86400,  // 24 horas
    scope: 'consultor'
  }));
  const sig = b64url(crypto.createHmac('sha256', JWT_SECRET).update(header+'.'+payload).digest());
  return `${header}.${payload}.${sig}`;
}
function validToken(t){
  if(!t || typeof t !== 'string') return false;
  const parts = t.split('.');
  if(parts.length !== 3) return false;
  const [header, payload, sig] = parts;
  // Verifica assinatura com timing-safe compare
  const expectedSig = b64url(crypto.createHmac('sha256', JWT_SECRET).update(header+'.'+payload).digest());
  try {
    if(!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return false;
  } catch(e){ return false; }
  // Verifica expiração
  try {
    const data = JSON.parse(b64urlDecode(payload).toString());
    if(!data.exp || data.exp < Math.floor(Date.now()/1000)) return false;
    if(data.scope !== 'consultor') return false;
    return true;
  } catch(e){ return false; }
}

// ═════════════════════════════════════════════════════
// RATE LIMIT no /api/auth (5 tentativas em 15min → bloqueio 1h)
// ═════════════════════════════════════════════════════
const authRateLimit = new Map();
function checkAuthRateLimit(ip){
  const now = Date.now();
  const entry = authRateLimit.get(ip) || { tentativas: 0, primeiraTent: now, bloqueadoAte: 0 };

  // Se está bloqueado, nega
  if(entry.bloqueadoAte > now){
    const restante = Math.ceil((entry.bloqueadoAte - now) / 60000);
    return { ok: false, motivo: `Bloqueado por ${restante} minuto(s) devido a tentativas excessivas.` };
  }

  // Janela de 15 minutos expirou — reseta
  if(now - entry.primeiraTent > 15*60*1000){
    entry.tentativas = 0;
    entry.primeiraTent = now;
    entry.bloqueadoAte = 0;
  }

  entry.tentativas++;

  // 5 tentativas → bloqueia 1 hora
  if(entry.tentativas > 5){
    entry.bloqueadoAte = now + 60*60*1000;
    authRateLimit.set(ip, entry);
    return { ok: false, motivo: 'Tentativas excessivas. Conta bloqueada por 1 hora.' };
  }

  authRateLimit.set(ip, entry);
  return { ok: true, restante: 5 - entry.tentativas };
}
function resetAuthRateLimit(ip){
  authRateLimit.delete(ip);
}
setInterval(()=>{
  const now = Date.now();
  for(const [ip, e] of authRateLimit){
    if(e.bloqueadoAte < now && now - e.primeiraTent > 16*60*1000) authRateLimit.delete(ip);
  }
}, 30*60*1000);

const PIN_HTML = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WealthPlanning</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Segoe UI',system-ui,sans-serif;background:#080e1a;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center}.login{text-align:center;max-width:360px;padding:40px}.logo{font-size:28px;font-weight:800;margin-bottom:8px}.logo span{color:#4c8bf5}.sub{font-size:13px;color:#8b949e;margin-bottom:32px}.pin-row{display:flex;gap:12px;justify-content:center;margin-bottom:24px}.pi{width:56px;height:64px;background:rgba(255,255,255,.04);border:1.5px solid rgba(255,255,255,.1);border-radius:12px;color:#fff;font-size:24px;font-weight:700;text-align:center;outline:none;-webkit-text-security:disc}.pi:focus{border-color:#4c8bf5}.btn{width:100%;padding:16px;background:linear-gradient(135deg,#4c8bf5,#3a6fd8);border:none;border-radius:12px;color:#fff;font-size:15px;font-weight:700;cursor:pointer}.btn:disabled{opacity:.4}.err{color:#f07070;font-size:13px;margin-top:16px;min-height:20px;line-height:1.4}</style></head><body><div class="login"><div class="logo">Wealth<span>Planning</span></div><div class="sub">Área restrita do consultor</div><div class="pin-row"><input class="pi" type="tel" maxlength="1" inputmode="numeric" autofocus><input class="pi" type="tel" maxlength="1" inputmode="numeric"><input class="pi" type="tel" maxlength="1" inputmode="numeric"><input class="pi" type="tel" maxlength="1" inputmode="numeric"></div><button class="btn" id="b" disabled>Entrar</button><div class="err" id="e"></div></div><script>var ii=document.querySelectorAll(".pi"),b=document.getElementById("b"),e=document.getElementById("e");ii.forEach(function(n,i){n.addEventListener("input",function(){if(n.value.length===1&&i<3)ii[i+1].focus();ck()});n.addEventListener("keydown",function(ev){if(ev.key==="Backspace"&&n.value===""&&i>0)ii[i-1].focus();if(ev.key==="Enter")go()})});function ck(){b.disabled=Array.from(ii).map(function(n){return n.value}).join("").length<4}b.onclick=go;function go(){var p=Array.from(ii).map(function(n){return n.value}).join("");if(p.length<4)return;fetch("/api/auth",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({pin:p})}).then(function(r){return r.json().then(function(d){return{status:r.status,data:d}})}).then(function(o){if(o.data.ok){window.location.href="/painel?t="+o.data.token}else{e.textContent=o.data.error||"PIN incorreto";ii.forEach(function(n){n.value=""});ii[0].focus();setTimeout(function(){e.textContent=""},4000)}})}</script></body></html>`;

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
      analisado_em TIMESTAMPTZ,
      lgpd_aceito_em TIMESTAMPTZ,
      lgpd_ip TEXT
    );
  `);
  // Migration idempotente: garante colunas LGPD em bases pré-existentes
  await db.query(`ALTER TABLE submissoes ADD COLUMN IF NOT EXISTS lgpd_aceito_em TIMESTAMPTZ;`);
  await db.query(`ALTER TABLE submissoes ADD COLUMN IF NOT EXISTS lgpd_ip TEXT;`);
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
    // AUTH do consultor (PIN) — com rate-limit por IP
    // ───────────────────────────────────────────────────
    if(p==='/api/auth' && req.method==='POST'){
      const ip = req.socket.remoteAddress || (req.headers['x-forwarded-for']||'').split(',')[0].trim() || 'unknown';
      const rl = checkAuthRateLimit(ip);
      if(!rl.ok){
        console.warn('[auth] rate-limit hit', ip, rl.motivo);
        return sendErr(res, rl.motivo, 429);
      }
      const d = await readBody(req);
      if(d.pin === PIN){
        resetAuthRateLimit(ip);
        console.log('[auth] login OK', ip);
        return sendJson(res, {ok:true, token: makeToken()});
      }
      const restante = typeof rl.restante === 'number' ? rl.restante : 0;
      const sufixo = restante > 0 ? ` (${restante} tentativa${restante === 1 ? '' : 's'} restante${restante === 1 ? '' : 's'})` : '';
      console.warn('[auth] login FAIL', ip);
      return sendErr(res, 'PIN incorreto' + sufixo, 401);
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
      // LGPD: exige consentimento registrado no client
      const lgpdAceitoEm = d.lgpdAceitoEm ? new Date(d.lgpdAceitoEm) : null;
      if(!lgpdAceitoEm || isNaN(lgpdAceitoEm.getTime())){
        return sendErr(res, 'Aceite da Política de Privacidade não registrado.', 400);
      }
      const ipLgpd = req.socket.remoteAddress || (req.headers['x-forwarded-for']||'').split(',')[0].trim() || 'unknown';
      const id = novoId();
      try {
        await db.query(
          `INSERT INTO submissoes (id, nome, whatsapp, status, score, dados, lgpd_aceito_em, lgpd_ip)
           VALUES ($1, $2, $3, 'pendente', $4, $5, $6, $7)`,
          [id, String(d.nome).trim().slice(0,120), wa, Number(d.score)||null, d.dados, lgpdAceitoEm.toISOString(), ipLgpd]
        );
        // invalida sessão pra evitar duplo envio
        sessoes.delete(d.sessionToken);
        console.log('[submit] nova submissão', id, 'de', d.nome, wa, '· LGPD aceito em', lgpdAceitoEm.toISOString());
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
        return sendJson(res, {ok:true, submissao: r.rows[0]});
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

    // /mentoria → LP de mentoria (URL limpa)
    if(p==='/mentoria' || p==='/mentoria/'){
      return serve(res,'index-lp-mentoria-v2.html');
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
