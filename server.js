const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Proxy ElevenLabs
app.post('/api/speak', (req, res) => {
  const { text, voiceId, apiKey } = req.body;

  const data = JSON.stringify({
    text,
    model_id: 'eleven_multilingual_v2',
    voice_settings: {
      stability: 0.55,
      similarity_boost: 0.80,
      style: 0.25,
      use_speaker_boost: true
    }
  });

  const options = {
    hostname: 'api.elevenlabs.io',
    path: `/v1/text-to-speech/${voiceId}`,
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
      'Content-Length': Buffer.byteLength(data)
    }
  };

  const elReq = https.request(options, elRes => {
    console.log('ElevenLabs status:', elRes.statusCode);
    if(elRes.statusCode !== 200){
      let body = '';
      elRes.on('data', d => body += d);
      elRes.on('end', () => {
        console.log('ElevenLabs erro:', body);
        res.status(elRes.statusCode).json({ error: body });
      });
      return;
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    elRes.pipe(res);
  });

  elReq.on('error', err => {
    console.log('Erro request:', err.message);
    res.status(500).json({ error: err.message });
  });
  elReq.write(data);
  elReq.end();
});

app.get('*', (req, res) => {
  const files = fs.readdirSync(__dirname);
  const html = files.find(f => f.endsWith('.html'));
  if (html) res.sendFile(path.join(__dirname, html));
  else res.send('Arquivos: ' + files.join(', '));
});

app.listen(PORT, () => console.log('OK ' + PORT));
