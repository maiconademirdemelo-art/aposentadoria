const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PIN = '1943';

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

const PIN_PAGE = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>WealthPlanning · Acesso</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',system-ui,sans-serif;background:#080e1a;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center}
.login{text-align:center;max-width:360px;padding:40px}
.logo{font-size:28px;font-weight:800;letter-spacing:-.02em;margin-bottom:8px}
.logo span{color:#4c8bf5}
.sub{font-size:13px;color:#8b949e;margin-bottom:32px}
.pin-row{display:flex;gap:12px;justify-content:center;margin-bottom:24px}
.pin-input{width:56px;height:64px;background:rgba(255,255,255,.04);border:1.5px solid rgba(255,255,255,.1);border-radius:12px;color:#fff;font-size:24px;font-weight:700;text-align:center;outline:none;transition:border-color .2s;-webkit-text-security:disc}
.pin-input:focus{border-color:#4c8bf5}
.btn{width:100%;padding:16px;background:linear-gradient(135deg,#4c8bf5,#3a6fd8);border:none;border-radius:12px;color:#fff;font-size:15px;font-weight:700;cursor:pointer;transition:opacity .2s}
.btn:hover{opacity:.9}
.btn:disabled{opacity:.4;cursor:not-allowed}
.error{color:#f07070;font-size:13px;margin-top:16px;min-height:20px}
.foot{margin-top:32px;font-size:11px;color:#444c56}
</style>
</head>
<body>
<div class="login">
  <div class="logo">Wealth<span>Planning</span></div>
  <div class="sub">Área restrita do consultor</div>
  <div class="pin-row">
    <input class="pin-input" type="tel" maxlength="1" inputmode="numeric" autofocus>
    <input class="pin-input" type="tel" maxlength="1" inputmode="numeric">
    <input class="pin-input" type="tel" maxlength="1" inputmode="numeric">
    <input class="pin-input" type="tel" maxlength="1" inputmode="numeric">
  </div>
  <button class="btn" id="btn-enter" disabled>Entrar</button>
  <div class="error" id="error"></div>
  <div class="foot">⬡ WealthPlanning · Acesso exclusivo</div>
</div>
<script>
(function(){
  var inputs=document.querySelectorAll('.pin-input');
  var btn=document.getElementById('btn-enter');
  var error=document.getElementById('error');
  inputs.forEach(function(inp,i){
    inp.addEventListener('input',function(){
      if(inp.value.length===1&&i<inputs.length-1)inputs[i+1].focus();
      checkComplete();
    });
    inp.addEventListener('keydown',function(e){
      if(e.key==='Backspace'&&inp.value===''&&i>0)inputs[i-1].focus();
      if(e.key==='Enter')tryLogin();
    });
    inp.addEventListener('paste',function(e){
      e.preventDefault();
      var data=(e.clipboardData||window.clipboardData).getData('text').replace(/\\\\D/g,'');
      for(var j=0;j<Math.min(data.length,inputs.length);j++)inputs[j].value=data[j];
      if(data.length>=inputs.length)inputs[inputs.length-1].focus();
      checkComplete();
    });
  });
  function checkComplete(){
    var pin=Array.from(inputs).map(function(i){return i.value}).join('');
    btn.disabled=pin.length<4;
  }
  btn.addEventListener('click',tryLogin);
  function tryLogin(){
    var pin=Array.from(inputs).map(function(i){return i.value}).join('');
    if(pin.length<4)return;
    fetch('/api/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:pin})})
      .then(function(r){return r.json()})
      .then(function(data){
        if(data.ok){
          sessionStorage.setItem('wp_token',data.token);
          window.location.href='/painel?t='+data.token;
        }else{
          error.textContent='PIN incorreto';
          inputs.forEach(function(i){i.value='';i.style.borderColor='#f07070'});
          inputs[0].focus();
          setTimeout(function(){inputs.forEach(function(i){i.style.borderColor=''});error.textContent='';},2000);
        }
      });
  }
})();
</script>
</body>
</html>`;

function makeToken(){return Buffer.from(PIN+':'+Date.now()).toString('base64');}
function validToken(t){
  try{
    const decoded=Buffer.from(t,'base64').toString();
    const[pin,ts]=decoded.split(':');
    if(pin!==PIN)return false;
    return(Date.now()-parseInt(ts))<24*60*60*1000;
  }catch{return false;}
}

const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://'+req.headers.host);
  const p=url.pathname;

  // API auth
  if(p==='/api/auth'&&req.method==='POST'){
    let body='';
    req.on('data',c=>body+=c);
    req.on('end',()=>{
      try{
        const data=JSON.parse(body);
        if(data.pin===PIN){
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:true,token:makeToken()}));
        }else{
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:false}));
        }
      }catch{
        res.writeHead(400,{'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:false}));
      }
    });
    return;
  }

  // RAIZ → LP pública
  if(p==='/'){return serveFile(res,'raio-x.html');}

  // /app → tela de PIN
  if(p==='/app'){
    res.writeHead(200,{'Content-Type':'text/html'});
    res.end(PIN_PAGE);
    return;
  }

  // /painel → ferramenta protegida
  if(p==='/painel'){
    const token=url.searchParams.get('t');
    if(validToken(token))return serveFile(res,'plano-futuro.html');
    res.writeHead(302,{'Location':'/app'});
    res.end();
    return;
  }

  // diagnostico.html → acessível (usado via iframe)
  if(p==='/diagnostico.html')return serveFile(res,'diagnostico.html');

  // Estáticos
  const ext=path.extname(p);
  if(ext&&MIME[ext])return serveFile(res,p.slice(1));

  // Qualquer outra rota → LP
  res.writeHead(302,{'Location':'/'});
  res.end();
});

function serveFile(res,filename){
  fs.readFile(path.join(__dirname,filename),(err,data)=>{
    if(err){res.writeHead(404);res.end('404');return;}
    res.writeHead(200,{'Content-Type':MIME[path.extname(filename)]||'application/octet-stream'});
    res.end(data);
  });
}

server.listen(PORT,()=>{
  console.log('WealthPlanning na porta '+PORT);
  console.log('  /         → LP (pública)');
  console.log('  /app      → Login PIN');
  console.log('  /painel   → Ferramenta (protegida)');
});
