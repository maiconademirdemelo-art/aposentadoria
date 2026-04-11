const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 8080;

app.get('/', (req, res) => {
  const files = fs.readdirSync(__dirname);
  const html = files.find(f => f.endsWith('.html'));
  if (html) {
    res.sendFile(path.join(__dirname, html));
  } else {
    res.send('Arquivos: ' + files.join(', '));
  }
});

app.listen(PORT, () => console.log('OK ' + PORT));
