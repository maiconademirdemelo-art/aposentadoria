const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 8080;

const dir = __dirname;

app.get('/', (req, res) => {
  const arquivo = path.join(dir, 'plano-futuro (2).html');
  if (fs.existsSync(arquivo)) {
    res.sendFile(arquivo);
  } else {
    res.send('Dir: ' + dir + '<br>Arquivos: ' + fs.readdirSync(dir).join('<br>'));
  }
});

app.listen(PORT, () => console.log('OK porta ' + PORT));
