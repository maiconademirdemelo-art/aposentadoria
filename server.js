const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PIN = '1943';

const MIME = {
  '.html':'text/html','.css':'text/css','.js':'application/javascript',
  '.json':'application/json','.png':'image/png','.jpg':'image/jpeg',
  '.webp':'image/webp','.svg':'image/svg+xml','.ico':'image/x-icon'
};

// Tela de PIN
const PIN_HTML = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WealthPlanning</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Segoe UI',system-ui,sans-serif;background:#080e1a;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center}.login{text-align:center;max-width:360px;padding:40px}.logo{font-size:28px;font-weight:800;margin-bottom:8px}.logo span{color:#4c8bf5}.sub{font-size:13px;color:#8b949e;margin-bottom:32px}.pin-row{display:flex;gap:12px;justify-content:center;margin-bottom:24px}.pi{width:56px;height:64px;background:rgba(255,255,255,.04);border:1.5px solid rgba(255,255,255,.1);border-radius:12px;color:#fff;font-size:24px;font-weight:700;text-align:center;outline:none;-webkit-text-security:disc}.pi:focus{border-color:#4c8bf5}.btn{width:100%;padding:16px;background:linear-gradient(135deg,#4c8bf5,#3a6fd8);border:none;border-radius:12px;color:#fff;font-size:15px;font-weight:700;cursor:pointer}.btn:disabled{opacity:.4}.err{color:#f07070;font-size:13px;margin-top:16px;min-height:20px}</style></head><body><div class="login"><div class="logo">Wealth<span>Planning</span></div><div class="sub">Área restrita do consultor</div><div class="pin-row"><input class="pi" type="tel" maxlength="1" inputmode="numeric" autofocus><input class="pi" type="tel" maxlength="1" inputmode="numeric"><input class="pi" type="tel" maxlength="1" inputmode="numeric"><input class="pi" type="tel" maxlength="1" inputmode="numeric"></div><button class="btn" id="b" disabled>Entrar</button><div class="err" id="e"></div></div><script>var ii=document.querySelectorAll(".pi"),b=document.getElementById("b"),e=document.getElementById("e");ii.forEach(function(n,i){n.addEventListener("input",function(){if(n.value.length===1&&i<3)ii[i+1].focus();ck()});n.addEventListener("keydown",function(ev){if(ev.key==="Backspace"&&n.value===""&&i>0)ii[i-1].focus();if(ev.key==="Enter")go()})});function ck(){b.disabled=Array.from(ii).map(function(n){return n.value}).join("").length<4}b.onclick=go;function go(){var p=Array.from(ii).map(function(n){return n.value}).join("");if(p.length<4)return;fetch("/api/auth",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({pin:p})}).then(function(r){return r.json()}).then(function(d){if(d.ok){window.location.href="/painel?t="+d.token}else{e.textContent="PIN incorreto";ii.forEach(function(n){n.value=""});ii[0].focus();setTimeout(function(){e.textContent=""},2000)}})}</script></body></html>`;

function makeToken(){return Buffer.from(PIN+':'+Date.now()).toString('base64')}
function validToken(t){try{var d=Buffer.from(t,'base64').toString(),p=d.split(':');return p[0]===PIN&&(Date.now()-parseInt(p[1]))<86400000}catch(e){return false}}

http.createServer(function(req,res){
  var url=new URL(req.url,'http://'+req.headers.host);
  var p=url.pathname;

  // API auth
  if(p==='/api/auth'&&req.method==='POST'){
    var body='';req.on('data',function(c){body+=c});
    req.on('end',function(){
      try{var d=JSON.parse(body);
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify(d.pin===PIN?{ok:true,token:makeToken()}:{ok:false}));
      }catch(e){res.writeHead(400);res.end('bad')}
    });return;
  }

  // Raiz → LP se existe, senão plano-futuro
  if(p==='/'){
    if(fs.existsSync(path.join(__dirname,'raio-x.html')))
      return serve(res,'raio-x.html');
    return serve(res,'plano-futuro.html');
  }

  // /app → PIN
  if(p==='/app'){res.writeHead(200,{'Content-Type':'text/html'});res.end(PIN_HTML);return}

  // /painel → ferramenta protegida
  if(p==='/painel'){
    if(validToken(url.searchParams.get('t')))return serve(res,'plano-futuro.html');
    res.writeHead(302,{'Location':'/app'});res.end();return;
  }

  // Estáticos
  var ext=path.extname(p);
  if(ext&&MIME[ext])return serve(res,p.slice(1));

  // Fallback → raiz
  res.writeHead(302,{'Location':'/'});res.end();
}).listen(PORT,function(){console.log('WealthPlanning porta '+PORT)});

function serve(res,file){
  fs.readFile(path.join(__dirname,file),function(err,data){
    if(err){res.writeHead(404);res.end('404');return}
    res.writeHead(200,{'Content-Type':MIME[path.extname(file)]||'text/html'});
    res.end(data);
  });
}
