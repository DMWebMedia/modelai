'use strict';
const express  = require('express');
const fetch    = require('node-fetch');
const path     = require('path');
const archiver = require('archiver');
const { v4: uuidv4 } = require('uuid');

const app  = express();
const PORT = process.env.PORT || 3456;

app.use(express.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory job store ───────────────────────────────────────────────
// jobs[batchId] = { status, items: [{id, name, status, requestId, imageUrl, error, prompt}], created }
const jobs = {};
const STYLES = {}; // styles[userId][styleName] = styleObj  (userId = fal key hash for simplicity)

function cleanOldJobs() {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000; // 2 hours
  for (const id of Object.keys(jobs)) {
    if (jobs[id].created < cutoff) delete jobs[id];
  }
}
setInterval(cleanOldJobs, 30 * 60 * 1000);

// ── Style prompts per category ────────────────────────────────────────
const CATEGORY_HINTS = {
  sunglasses: 'person wearing sunglasses, face clearly visible, stylish eyewear shot',
  bags:       'person holding or wearing the bag, fashion editorial',
  shirts:     'person wearing the shirt, full body or upper body shot',
  dresses:    'person wearing the dress, full body, fashion editorial',
  shoes:      'person wearing the shoes, full body including feet',
  watches:    'person wearing the watch on wrist, close-up wrist detail',
  jackets:    'person wearing the jacket, full body',
  pants:      'person wearing the pants, full body',
  jewelry:    'person wearing the jewelry, close-up detail',
  hats:       'person wearing the hat, portrait or full body',
  other:      'person wearing or holding the product, fashion editorial',
};

const STYLE_ENHANCEMENTS = {
  editorial:   'editorial fashion photography, magazine quality, professional studio lighting, Vogue aesthetic',
  street:      'street style photography, urban outdoor environment, candid fashion',
  luxury:      'luxury fashion boutique, high-end elegant, soft dramatic lighting',
  ecommerce:   'clean ecommerce product shot, pure white background, studio lighting, product-focused',
  lifestyle:   'lifestyle photography, casual outdoor, natural golden hour light',
  minimal:     'minimalist photography, clean neutral background, soft light, modern aesthetic',
};

// ── Helpers ───────────────────────────────────────────────────────────
function hashKey(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) { h = (Math.imul(31, h) + key.charCodeAt(i)) | 0; }
  return Math.abs(h).toString(16);
}

async function falPost(falPath, body, auth) {
  const r = await fetch(`https://queue.fal.run${falPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify(body),
    timeout: 15000,
  });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { error: text }; }
}

// Map pixel W:H to nearest valid Nano Banana 2 aspect_ratio string
function toNBRatio(w, h) {
  const valid = [
    { r: '1:1',  v: 1 },
    { r: '4:5',  v: 4/5 },
    { r: '3:4',  v: 3/4 },
    { r: '2:3',  v: 2/3 },
    { r: '9:16', v: 9/16 },
    { r: '4:3',  v: 4/3 },
    { r: '3:2',  v: 3/2 },
    { r: '16:9', v: 16/9 },
    { r: '21:9', v: 21/9 },
    { r: '4:1',  v: 4/1 },
    { r: '1:4',  v: 1/4 },
    { r: '5:4',  v: 5/4 },
    { r: '1:8',  v: 1/8 },
    { r: '8:1',  v: 8/1 },
  ];
  if (!w || !h) return '3:4';
  const target = w / h;
  let best = '3:4', bestDiff = Infinity;
  for (const { r, v } of valid) {
    const diff = Math.abs(v - target);
    if (diff < bestDiff) { bestDiff = diff; best = r; }
  }
  return best;
}

async function falGet(falPath, auth) {
  const r = await fetch(`https://queue.fal.run${falPath}`, {
    headers: { Authorization: auth },
    timeout: 15000,
  });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { status: 'IN_QUEUE', _raw: text }; }
}

async function uploadBase64ToFal(base64, mimeType, auth) {
  // Use fal's initiate upload flow
  const initResp = await fetch('https://rest.alpha.fal.ai/storage/upload/initiate', {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_name: `product_${Date.now()}.jpg`, content_type: mimeType || 'image/jpeg' }),
    timeout: 15000,
  });
  const { upload_url, file_url } = await initResp.json();
  if (!upload_url) throw new Error('Could not get upload URL from fal.ai');

  const buf = Buffer.from(base64, 'base64');
  await fetch(upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': mimeType || 'image/jpeg' },
    body: buf,
    timeout: 30000,
  });
  return file_url;
}

function buildPrompt(userPrompt, category, styleKey, variant) {
  const catHint = CATEGORY_HINTS[category] || CATEGORY_HINTS.other;
  const styleHint = STYLE_ENHANCEMENTS[styleKey] || '';
  const poseHint = variant === 2 ? 'three-quarter angle, dynamic pose' : 'front-facing, relaxed natural stance';
  const extras = 'photorealistic, professional fashion photography, high resolution, sharp focus';
  return [userPrompt, catHint, styleHint, poseHint, extras].filter(Boolean).join(', ');
}

// ── Background job processor ──────────────────────────────────────────
async function processItem(batchId, itemId, auth) {
  const batch = jobs[batchId];
  if (!batch) return;
  const item = batch.items.find(i => i.id === itemId);
  if (!item) return;

  try {
    item.status = 'uploading';

    // Upload image
    const imageUrl = await uploadBase64ToFal(item.base64, item.mimeType, auth);
    item.imageUrl = null;

    item.status = 'generating';

    // Submit to Nano Banana 2 edit
    const submitData = await falPost('/fal-ai/nano-banana-2/edit', {
      prompt: item.prompt,
      image_urls: [imageUrl],
      num_images: 1,
      aspect_ratio: item.aspectRatio || '3:4',
      output_format: 'jpeg',
      safety_tolerance: '4',
      resolution: item.resolution || '1K',
    }, auth);

    if (!submitData.request_id) {
      const errMsg = Array.isArray(submitData.detail)
        ? submitData.detail.map(d => d.msg).join(', ')
        : (submitData.detail || submitData.error || 'No request_id returned');
      throw new Error(errMsg);
    }
    item.requestId = submitData.request_id;

    // Poll with 5-minute max
    const maxAttempts = 100;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 4000));
      const status = await falGet(`/fal-ai/nano-banana-2/edit/requests/${item.requestId}/status`, auth);

      if (status.status === 'COMPLETED') {
        const result = await falGet(`/fal-ai/nano-banana-2/edit/requests/${item.requestId}`, auth);
        if (!result.images?.[0]?.url) throw new Error('No image in result');
        item.resultUrl = result.images[0].url;
        item.status = 'done';
        batch.completedCount = (batch.completedCount || 0) + 1;
        return;
      }
      if (status.status === 'FAILED') throw new Error('Generation failed on fal.ai');
    }
    throw new Error('Timed out after 5 minutes');

  } catch (err) {
    item.status = 'error';
    item.error = err.message;
    batch.completedCount = (batch.completedCount || 0) + 1;
  }
}

// ── Routes ────────────────────────────────────────────────────────────

// Create batch job
app.post('/api/batch/create', async (req, res) => {
  const auth = req.headers['authorization'];
  if (!auth) return res.status(401).json({ error: 'Missing fal.ai key' });

  const { items, globalPrompt, promptMode, category, styleKey, resolution, width, height } = req.body;
  // items: [{id, name, base64, mimeType, prompt?}]
  if (!items?.length) return res.status(400).json({ error: 'No items provided' });
  if (items.length > 100) return res.status(400).json({ error: 'Max 100 products per batch' });

  const batchId = uuidv4();
  const aspectRatio = toNBRatio(parseInt(width) || 768, parseInt(height) || 1024);

  jobs[batchId] = {
    status: 'processing',
    created: Date.now(),
    completedCount: 0,
    items: items.map(it => ({
      id: it.id || uuidv4(),
      name: it.name || 'product',
      base64: it.base64,
      mimeType: it.mimeType || 'image/jpeg',
      prompt: buildPrompt(
        promptMode === 'individual' && it.prompt ? it.prompt : globalPrompt,
        category,
        styleKey,
        1
      ),
      aspectRatio,
      resolution: resolution || '1K',
      status: 'queued',
      requestId: null,
      resultUrl: null,
      error: null,
    })),
  };

  res.json({ batchId, total: items.length });

  // Process in background — max 3 concurrent
  const CONCURRENCY = 3;
  const queue = [...jobs[batchId].items];
  const runNext = async () => {
    const item = queue.shift();
    if (!item) return;
    await processItem(batchId, item.id, auth);
    await runNext();
  };
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, runNext);
  Promise.all(workers).then(() => { if (jobs[batchId]) jobs[batchId].status = 'done'; });
});

// Poll batch status
app.get('/api/batch/:batchId/status', (req, res) => {
  const batch = jobs[req.params.batchId];
  if (!batch) return res.status(404).json({ error: 'Batch not found' });
  res.json({
    status: batch.status,
    total: batch.items.length,
    completed: batch.completedCount || 0,
    items: batch.items.map(({ id, name, status, resultUrl, error }) => ({ id, name, status, resultUrl, error })),
  });
});

// Regenerate single item
app.post('/api/item/:batchId/:itemId/regenerate', async (req, res) => {
  const auth = req.headers['authorization'];
  if (!auth) return res.status(401).json({ error: 'Missing fal.ai key' });

  const batch = jobs[req.params.batchId];
  if (!batch) return res.status(404).json({ error: 'Batch not found' });
  const item = batch.items.find(i => i.id === req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  const { prompt, category, styleKey, resolution, aspectRatio } = req.body;
  if (prompt) item.prompt = buildPrompt(prompt, category || 'other', styleKey || '', 1);
  if (resolution) item.resolution = resolution;
  if (aspectRatio) item.aspectRatio = aspectRatio;

  item.status = 'queued';
  item.resultUrl = null;
  item.error = null;

  res.json({ ok: true });

  processItem(req.params.batchId, item.id, auth).then(() => {});
});

// Edit batch prompt & regenerate all
app.post('/api/batch/:batchId/edit', async (req, res) => {
  const auth = req.headers['authorization'];
  if (!auth) return res.status(401).json({ error: 'Missing fal.ai key' });

  const batch = jobs[req.params.batchId];
  if (!batch) return res.status(404).json({ error: 'Batch not found' });

  const { globalPrompt, category, styleKey, resolution } = req.body;
  batch.completedCount = 0;
  batch.status = 'processing';
  batch.items.forEach(item => {
    item.prompt = buildPrompt(globalPrompt, category || 'other', styleKey || '', 1);
    if (resolution) item.resolution = resolution;
    item.status = 'queued';
    item.resultUrl = null;
    item.error = null;
  });

  res.json({ ok: true });

  const CONCURRENCY = 3;
  const queue = [...batch.items];
  const runNext = async () => {
    const item = queue.shift();
    if (!item) return;
    await processItem(batch.id || req.params.batchId, item.id, auth);
    await runNext();
  };
  // Fix: attach batchId properly
  const batchId = req.params.batchId;
  const runNextFixed = async () => {
    const item = queue.shift();
    if (!item) return;
    await processItem(batchId, item.id, auth);
    await runNextFixed();
  };
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, runNextFixed);
  Promise.all(workers).then(() => { if (jobs[batchId]) jobs[batchId].status = 'done'; });
});

// Upscale single item via fal creative upscaler
app.post('/api/item/:batchId/:itemId/upscale', async (req, res) => {
  const auth = req.headers['authorization'];
  if (!auth) return res.status(401).json({ error: 'Missing fal.ai key' });

  const batch = jobs[req.params.batchId];
  const item = batch?.items.find(i => i.id === req.params.itemId);
  if (!item?.resultUrl) return res.status(400).json({ error: 'No image to upscale' });

  try {
    const submit = await falPost('/fal-ai/creative-upscaler', {
      image_url: item.resultUrl,
      scale: 2,
    }, auth);
    if (!submit.request_id) throw new Error('Upscale submit failed');

    // Poll
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const s = await falGet(`/fal-ai/creative-upscaler/requests/${submit.request_id}/status`, auth);
      if (s.status === 'COMPLETED') {
        const result = await falGet(`/fal-ai/creative-upscaler/requests/${submit.request_id}`, auth);
        return res.json({ url: result.image?.url || result.images?.[0]?.url });
      }
      if (s.status === 'FAILED') throw new Error('Upscale failed');
    }
    throw new Error('Upscale timed out');
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Download ZIP
app.get('/api/batch/:batchId/zip', async (req, res) => {
  const batch = jobs[req.params.batchId];
  if (!batch) return res.status(404).json({ error: 'Batch not found' });

  const doneItems = batch.items.filter(i => i.resultUrl);
  if (!doneItems.length) return res.status(400).json({ error: 'No completed images' });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="fashion-ai-${req.params.batchId.slice(0,8)}.zip"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.pipe(res);

  for (const item of doneItems) {
    try {
      const r = await fetch(item.resultUrl, { timeout: 30000 });
      const buf = await r.buffer();
      archive.append(buf, { name: `${item.name.replace(/[^a-z0-9]/gi,'_')}.jpg` });
    } catch { /* skip failed */ }
  }
  await archive.finalize();
});

// Style library — save
app.post('/api/styles/save', (req, res) => {
  const auth = req.headers['authorization'];
  if (!auth) return res.status(401).json({ error: 'Missing key' });
  const userId = hashKey(auth);
  const { name, prompt, styleKey, category } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  if (!STYLES[userId]) STYLES[userId] = {};
  STYLES[userId][name] = { name, prompt, styleKey, category, created: Date.now() };
  res.json({ ok: true });
});

// Style library — list
app.get('/api/styles', (req, res) => {
  const auth = req.headers['authorization'];
  if (!auth) return res.status(401).json({ error: 'Missing key' });
  const userId = hashKey(auth);
  res.json(Object.values(STYLES[userId] || {}));
});

// Style library — delete
app.delete('/api/styles/:name', (req, res) => {
  const auth = req.headers['authorization'];
  if (!auth) return res.status(401).json({ error: 'Missing key' });
  const userId = hashKey(auth);
  if (STYLES[userId]) delete STYLES[userId][req.params.name];
  res.json({ ok: true });
});

// Cost estimate
app.post('/api/cost', (req, res) => {
  const { count, resolution } = req.body;
  const rate = resolution === '2K' ? 0.12 : resolution === '4K' ? 0.16 : 0.08;
  res.json({ cost: (count * rate).toFixed(2), rate, count });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`\n✅  Fashion AI Studio v3 → http://localhost:${PORT}\n`));
