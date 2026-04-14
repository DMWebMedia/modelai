const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3456;

app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// ── Nano Banana 2 — submit to queue ──────────────────────────────────
app.post('/api/fal/submit', async (req, res) => {
  const auth = req.headers['authorization'];
  if (!auth) return res.status(401).json({ error: 'Missing fal.ai key' });
  try {
    const r = await fetch('https://queue.fal.run/fal-ai/nano-banana-2/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': auth },
      body: JSON.stringify(req.body)
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Poll queue status ─────────────────────────────────────────────────
app.get('/api/fal/status/:requestId', async (req, res) => {
  const auth = req.headers['authorization'];
  if (!auth) return res.status(401).json({ error: 'Missing fal.ai key' });
  try {
    const r = await fetch(`https://queue.fal.run/fal-ai/nano-banana-2/edit/requests/${req.params.requestId}/status`, {
      headers: { 'Authorization': auth }
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Get result ────────────────────────────────────────────────────────
app.get('/api/fal/result/:requestId', async (req, res) => {
  const auth = req.headers['authorization'];
  if (!auth) return res.status(401).json({ error: 'Missing fal.ai key' });
  try {
    const r = await fetch(`https://queue.fal.run/fal-ai/nano-banana-2/edit/requests/${req.params.requestId}`, {
      headers: { 'Authorization': auth }
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Upload image to fal storage so Nano Banana can access it ─────────
app.post('/api/fal/upload', async (req, res) => {
  const auth = req.headers['authorization'];
  if (!auth) return res.status(401).json({ error: 'Missing fal.ai key' });

  const { base64, mimeType } = req.body;
  if (!base64) return res.status(400).json({ error: 'No image data' });

  try {
    // Convert base64 to buffer and upload as multipart
    const buf = Buffer.from(base64, 'base64');
    const FormData = require('form-data');
    const form = new FormData();
    form.append('file', buf, { filename: 'product.jpg', contentType: mimeType || 'image/jpeg' });

    const r = await fetch('https://rest.alpha.fal.ai/storage/upload/initiate', {
      method: 'POST',
      headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_name: 'product.jpg', content_type: mimeType || 'image/jpeg' })
    });
    const { upload_url, file_url } = await r.json();

    // Upload the actual file
    await fetch(upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': mimeType || 'image/jpeg' },
      body: buf
    });

    res.json({ url: file_url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n✅  Fashion AI Studio — Nano Banana 2`);
  console.log(`👉  http://localhost:${PORT}\n`);
});
