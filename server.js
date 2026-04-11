const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  const files = [
    'plano-futuro.html',
    'plano-futuro',
    'index.html'
  ];
  
  for (const f of files) {
    const full = path.join(__dirname, f);
    if (fs.existsSync(full)) {
      return res.sendFile(full);
    }
  }
  
  res.send('Arquivos na raiz: ' + fs.readdirSync(__dirname).join(', '));
});

app.listen(PORT, () => console.log('OK porta ' + PORT));
