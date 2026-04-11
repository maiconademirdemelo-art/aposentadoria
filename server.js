const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname)));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  const options = [
    path.join(__dirname, 'plano-futuro.html'),
    path.join(__dirname, 'public', 'plano-futuro.html'),
    path.join(__dirname, 'public', 'index.html'),
  ];
  for (const file of options) {
    try {
      require('fs').accessSync(file);
      return res.sendFile(file);
    } catch(e) {}
  }
  res.status(404).send('Arquivo não encontrado');
});

app.listen(PORT, () => {
  console.log('Servidor rodando na porta ' + PORT);
});
