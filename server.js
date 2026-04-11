const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.sendFile(path.resolve('plano-futuro.html'));
});

app.use(express.static('.'));

app.listen(PORT, () => console.log('OK porta ' + PORT));
