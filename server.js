const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 8080;

// Mostra todos os arquivos disponíveis
const dir = __dirname;
console.log('Diretório atual:', dir);
console.log('Arquivos:', fs.readdirSync(dir));

app.get('/', (req, res) => {
  const arquivo = path.join(dir, 'plano-futuro.html');
  if (fs.existsSync(arquivo)) {
    res.sendFile(arquivo);
  } else {
    // Lista o que existe para debug
    res.send('Dir: ' + dir + '<br>Arquivos: ' + fs.readdirSync(dir).join('<br>'));
  }
});

app.listen(PORT, () => console.log('OK porta ' + PORT));
