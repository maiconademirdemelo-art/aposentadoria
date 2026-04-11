const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.static(path.join(__dirname)));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'plano-futuro.html'));
});

app.listen(PORT, () => console.log('OK na porta ' + PORT));
