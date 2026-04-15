'use strict';
const express  = require('express');
const fetch    = require('node-fetch');
const path     = require('path');
const archiver = require('archiver');
const { v4: uuidv4 } = require('uuid');

const app  = express();
const PORT = process.env.PORT || 3456;
app.use(express.json({ limit: '150mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const jobs   = {};
const STYLES = {};

setInterval(() => {
  const cutoff = Date.now() - 3 * 60 * 60 * 1000;
  for (const id of Object.keys(jobs)) { if (jobs[id].created < cutoff) delete jobs[id]; }
}, 30 * 60 * 1000);

// ── fal.ai helpers ────────────────────────────────────────────────────
async function falRequest(method, url, auth, body) {
  const opts = {
    method,
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  const text = await r.text();
  if (!text || !text.trim()) return {};
  try { return JSON.parse(text); } catch { return { _raw: text, _status: r.status }; }
}

const falPost = (path, body, auth) =>
  falRequest('POST', `https://queue.fal.run${path}`, auth, body);

const falGet = (path, auth) =>
  falRequest('GET', `https://queue.fal.run${path}`, auth, null);

// Upload base64 image to fal storage, return public URL
async function uploadToFal(base64, mimeType, auth) {
  // Step 1: get presigned URL
  const init = await falRequest('POST', 'https://rest.alpha.fal.ai/storage/upload/initiate', auth, {
    file_name: `img_${Date.now()}.jpg`,
    content_type: mimeType || 'image/jpeg',
  });
  if (!init.upload_url) throw new Error('fal upload initiate failed: ' + JSON.stringify(init));

  // Step 2: PUT the file
  const buf = Buffer.from(base64, 'base64');
  const putResp = await fetch(init.upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': mimeType || 'image/jpeg' },
    body: buf,
  });
  if (!putResp.ok) throw new Error(`fal upload PUT failed: ${putResp.status}`);

  return init.file_url;
}

// Convert pixel W×H to nearest valid Nano Banana aspect_ratio string
function toNBRatio(w, h) {
  const VALID = [
    ['1:1',4/4],['4:5',4/5],['3:4',3/4],['2:3',2/3],['9:16',9/16],
    ['4:3',4/3],['5:4',5/4],['3:2',3/2],['16:9',16/9],['21:9',21/9],
    ['4:1',4/1],['1:4',1/4],['8:1',8/1],['1:8',1/8],
  ];
  if (!w || !h) return '3:4';
  const t = w / h;
  let best = '3:4', diff = Infinity;
  for (const [r, v] of VALID) { const d = Math.abs(v - t); if (d < diff) { diff = d; best = r; } }
  return best;
}

// ── Prompt building ───────────────────────────────────────────────────
const CAT_HINTS = {
  sunglasses: 'person wearing sunglasses, face clearly visible',
  bags:       'person holding or wearing the bag elegantly',
  shirts:     'person wearing the shirt, upper body or full body',
  dresses:    'person wearing the dress, full body',
  shoes:      'person wearing the shoes, full body including feet visible',
  watches:    'person wearing the watch on wrist, wrist detail visible',
  jackets:    'person wearing the jacket, full body',
  pants:      'person wearing the pants, full body',
  jewelry:    'person wearing the jewelry, close-up detail',
  hats:       'person wearing the hat',
  other:      'person wearing or holding the product',
};

const STYLE_HINTS = {
  editorial:   'high fashion editorial, Vogue magazine, dramatic studio lighting, high contrast',
  street:      'street style fashion, urban outdoor, candid, real environment',
  luxury:      'luxury fashion, elegant, soft dramatic lighting, high-end aesthetic',
  ecommerce:   'clean ecommerce shot, white background, product-focused, neutral lighting',
  lifestyle:   'lifestyle photography, casual, natural golden hour light, outdoor',
  minimal:     'minimalist, clean neutral background, soft light, modern',
  athletic:    'athletic lifestyle, sport, dynamic movement, action photography',
  bohemian:    'bohemian style, earthy tones, natural textures, relaxed vibe',
  formal:      'formal professional look, corporate setting, polished',
  vintage:     'vintage aesthetic, retro color grade, film photography look',
  streetwear:  'streetwear, urban, graffiti backdrop, youthful energy',
  haute:       'haute couture, avant-garde, artistic fashion photography',
};

const BG_HINTS = {
  ai:       '', // let AI choose based on prompt
  white:    'pure white seamless studio background, clean white backdrop',
  grey:     'professional grey seamless studio background, soft gradient',
  black:    'dramatic black studio background, dark backdrop',
  outdoor:  'natural outdoor environment, realistic location, natural light',
  street:   'urban street environment, city sidewalk, realistic',
  luxury:   'luxury interior, marble floors, upscale boutique ambiance',
  beach:    'tropical beach background, golden sand, ocean horizon',
  forest:   'lush green forest background, natural dappled light',
  studio:   'professional photography studio, soft box lighting setup',
  custom:   '', // user provides via prompt
};

const REALISM = {
  ultra: [
    'shot on Hasselblad H6D-100c', '110mm f/2.2 lens',
    'natural skin texture with realistic pores', 'micro fabric detail visible',
    'does NOT look AI generated', 'hyperrealistic photograph',
    'indistinguishable from real photo', 'ultra sharp focus',
    'professional commercial photographer', 'award-winning fashion photography',
    'subtle natural film grain', 'true-to-life skin tones',
    'realistic subsurface skin scattering', 'photographic realism',
  ].join(', '),
  editorial: [
    'high fashion editorial', 'Vogue quality retouching',
    'professional strobe studio lighting', 'ultra sharp', 'commercial grade',
  ].join(', '),
  cinematic: [
    'cinematic film look', 'anamorphic bokeh', 'shallow depth of field',
    'Kodak film color grade', 'natural lens flare', 'cinema camera quality',
  ].join(', '),
  raw: [
    'raw unretouched photo', 'documentary photography', 'natural ambient light',
    'candid authentic look', 'film reportage style',
  ].join(', '),
};

const GENDER_HINT = { female: 'female model, woman', male: 'male model, man', neutral: 'androgynous model' };
const IMAGES_HINT = { 1: '', 2: '', 3: '', 4: '', 5: '' };

function buildPrompt(userPrompt, opts = {}) {
  const { category = 'other', styleKey = '', bgOption = 'ai', gender = 'female',
          realism = 'ultra', bgCustom = '', variantHint = '' } = opts;

  const parts = [
    userPrompt,
    GENDER_HINT[gender] || GENDER_HINT.female,
    CAT_HINTS[category] || CAT_HINTS.other,
    STYLE_HINTS[styleKey] || '',
    bgOption === 'custom' ? bgCustom : (BG_HINTS[bgOption] || ''),
    variantHint,
    REALISM[realism] || REALISM.ultra,
  ];
  return parts.filter(Boolean).join(', ');
}

// Website photos prompt (product-only, white bg, no model)
function buildProductPhotoPrompt(userPrompt, bgCustom, refDesc) {
  return [
    userPrompt,
    refDesc || '',
    'professional product photography',
    'pure white seamless background',
    'shot on Phase One XT camera',
    '120mm macro lens',
    'perfect studio lighting with soft boxes',
    'ultra sharp product detail',
    'commercial grade product photo',
    'zero shadows on background',
    'professional color grading',
    'e-commerce ready',
    bgCustom || '',
  ].filter(Boolean).join(', ');
}

// ── Job processor ─────────────────────────────────────────────────────
async function processItem(batchId, itemId, auth) {
  const batch = jobs[batchId];
  if (!batch) return;
  const item = batch.items.find(i => i.id === itemId);
  if (!item) return;

  try {
    item.status = 'uploading';
    // Upload product image
    const imageUrl = await uploadToFal(item.base64, item.mimeType, auth);

    // Upload reference images if any
    const refUrls = [];
    if (item.refImages && item.refImages.length) {
      for (const ref of item.refImages) {
        const u = await uploadToFal(ref.base64, ref.mimeType, auth);
        refUrls.push(u);
      }
    }

    item.status = 'generating';
    const allImageUrls = [imageUrl, ...refUrls];

    // Determine endpoint based on batch type
    const endpoint = batch.type === 'website' ? '/fal-ai/nano-banana-2/edit' : '/fal-ai/nano-banana-2/edit';

    const submitBody = {
      prompt: item.prompt,
      image_urls: allImageUrls,
      num_images: 1,
      aspect_ratio: item.aspectRatio || '3:4',
      output_format: 'jpeg',
      safety_tolerance: '4',
      resolution: item.resolution || '1K',
    };

    const submitData = await falPost(endpoint, submitBody, auth);

    if (!submitData.request_id) {
      const msg = Array.isArray(submitData.detail)
        ? submitData.detail.map(d => d.msg || d).join('; ')
        : (submitData.detail || submitData.error || JSON.stringify(submitData).slice(0, 300));
      throw new Error('Submit failed: ' + msg);
    }

    item.requestId = submitData.request_id;
    item.statusUrl  = submitData.status_url;
    item.responseUrl = submitData.response_url;

    // ── Poll status then fetch result separately ───────────────────
    const maxAttempts = 150; // 10 minutes
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 4000));

      // Use the status_url from submit response if available
      const statusPath = item.statusUrl
        ? item.statusUrl.replace('https://queue.fal.run', '')
        : `/fal-ai/nano-banana-2/edit/requests/${item.requestId}/status`;

      const statusData = await falGet(statusPath, auth);

      if (statusData.status === 'COMPLETED') {
        // Fetch result via response_url or standard result endpoint
        const resultPath = item.responseUrl
          ? item.responseUrl.replace('https://queue.fal.run', '')
          : `/fal-ai/nano-banana-2/edit/requests/${item.requestId}`;

        const resultData = await falGet(resultPath, auth);

        // Extract image URL — try every possible location in the response
        const imgUrl =
          resultData?.images?.[0]?.url ||
          resultData?.output?.images?.[0]?.url ||
          resultData?.image?.url ||
          resultData?.output?.image?.url ||
          resultData?.data?.images?.[0]?.url ||
          null;

        if (!imgUrl) {
          throw new Error('COMPLETED but no image URL in result: ' + JSON.stringify(resultData).slice(0, 300));
        }

        item.resultUrl = imgUrl;
        item.status = 'done';
        batch.completedCount = (batch.completedCount || 0) + 1;
        return;
      }

      if (statusData.status === 'FAILED') {
        throw new Error(statusData.error || statusData.detail || 'fal.ai generation failed');
      }
      // IN_QUEUE or IN_PROGRESS — keep polling
    }
    throw new Error('Timed out after 10 minutes');

  } catch (err) {
    item.status = 'error';
    item.error  = err.message;
    batch.completedCount = (batch.completedCount || 0) + 1;
    console.error(`[Item ${itemId}] Error:`, err.message);
  }
}

// Run a batch's items with concurrency limit
function runBatch(batchId, auth, concurrency = 3) {
  const queue = [...jobs[batchId].items.filter(i => i.status === 'queued')];
  const runNext = async () => {
    const item = queue.shift();
    if (!item) return;
    await processItem(batchId, item.id, auth);
    await runNext();
  };
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, runNext);
  Promise.all(workers).then(() => {
    if (jobs[batchId]) jobs[batchId].status = 'done';
  });
}

// ── Routes ────────────────────────────────────────────────────────────

// Helper to build items list from request
function buildItems(items, opts) {
  const { globalPrompt, promptMode, category, styleKey, bgOption, bgMode,
          gender, realism, resolution, width, height,
          bgCustom, type, globalBgPrompts } = opts;
  const aspectRatio = toNBRatio(parseInt(width) || 768, parseInt(height) || 1024);

  return items.map((it, idx) => {
    // Background selection:
    // bgMode = 'same' → use bgOption for all
    // bgMode = 'different' → cycle through globalBgPrompts array or rotate presets
    // bgMode = 'per-product' → use it.bgOption
    let itemBg = bgOption || 'ai';
    let itemBgCustom = bgCustom || '';
    if (bgMode === 'different' && globalBgPrompts && globalBgPrompts.length) {
      itemBg = 'custom';
      itemBgCustom = globalBgPrompts[idx % globalBgPrompts.length];
    } else if (bgMode === 'per-product' && it.bgOption) {
      itemBg = it.bgOption;
      itemBgCustom = it.bgCustom || '';
    }

    // Images per product (1–5)
    const imgCount = Math.min(5, Math.max(1, parseInt(it.imageCount || opts.imagesPerProduct || 1)));

    // Build one item per image requested
    const variants = [];
    for (let v = 0; v < imgCount; v++) {
      const variantHint = imgCount > 1
        ? ['front-facing full body', 'three-quarter angle', 'side profile', 'close-up detail', 'dynamic pose'][v] || ''
        : '';

      let userPrompt = globalPrompt;
      if (promptMode === 'individual' && it.prompt) userPrompt = it.prompt;

      const prompt = type === 'website'
        ? buildProductPhotoPrompt(userPrompt, itemBgCustom, it.refDesc)
        : buildPrompt(userPrompt, { category, styleKey, bgOption: itemBg, gender, realism, bgCustom: itemBgCustom, variantHint });

      variants.push({
        id: uuidv4(),
        name: imgCount > 1 ? `${it.name || 'product'}-v${v + 1}` : (it.name || 'product'),
        originalName: it.name || 'product',
        base64: it.base64,
        mimeType: it.mimeType || 'image/jpeg',
        refImages: it.refImages || [],
        prompt,
        aspectRatio,
        resolution: resolution || '1K',
        bgOption: itemBg,
        gender,
        realism,
        status: 'queued',
        requestId: null,
        resultUrl: null,
        error: null,
      });
    }
    return variants;
  }).flat();
}

// Create batch
app.post('/api/batch/create', async (req, res) => {
  const auth = req.headers['authorization'];
  if (!auth) return res.status(401).json({ error: 'Missing fal.ai key' });
  const { items, type = 'model' } = req.body;
  if (!items?.length) return res.status(400).json({ error: 'No items' });
  if (items.length > 100) return res.status(400).json({ error: 'Max 100 products' });

  const batchId = uuidv4();
  const builtItems = buildItems(items, { ...req.body, type });

  jobs[batchId] = {
    type,
    status: 'processing',
    created: Date.now(),
    completedCount: 0,
    items: builtItems,
  };

  res.json({ batchId, total: builtItems.length });
  runBatch(batchId, auth, 3);
});

// Poll status
app.get('/api/batch/:batchId/status', (req, res) => {
  const batch = jobs[req.params.batchId];
  if (!batch) return res.status(404).json({ error: 'Batch not found' });
  res.json({
    status: batch.status,
    type: batch.type,
    total: batch.items.length,
    completed: batch.completedCount || 0,
    items: batch.items.map(({ id, name, originalName, status, resultUrl, error }) =>
      ({ id, name, originalName, status, resultUrl, error })),
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

  const { prompt, category, styleKey, bgOption, bgCustom, gender, realism, resolution } = req.body;
  if (prompt) {
    item.prompt = batch.type === 'website'
      ? buildProductPhotoPrompt(prompt, bgCustom || item.bgCustom)
      : buildPrompt(prompt, { category: category || 'other', styleKey: styleKey || '',
          bgOption: bgOption || item.bgOption || 'ai', gender: gender || item.gender || 'female',
          realism: realism || item.realism || 'ultra', bgCustom: bgCustom || item.bgCustom || '' });
  }
  if (resolution) item.resolution = resolution;
  item.status = 'queued'; item.resultUrl = null; item.error = null;
  res.json({ ok: true });
  processItem(req.params.batchId, item.id, auth);
});

// Edit entire batch
app.post('/api/batch/:batchId/edit', async (req, res) => {
  const auth = req.headers['authorization'];
  if (!auth) return res.status(401).json({ error: 'Missing fal.ai key' });
  const batch = jobs[req.params.batchId];
  if (!batch) return res.status(404).json({ error: 'Batch not found' });

  const { globalPrompt, category, styleKey, bgOption, bgCustom, gender, realism, resolution } = req.body;
  batch.completedCount = 0;
  batch.status = 'processing';
  batch.items.forEach(item => {
    item.prompt = batch.type === 'website'
      ? buildProductPhotoPrompt(globalPrompt, bgCustom)
      : buildPrompt(globalPrompt, { category: category || 'other', styleKey: styleKey || '',
          bgOption: bgOption || item.bgOption || 'ai', gender: gender || item.gender || 'female',
          realism: realism || item.realism || 'ultra', bgCustom: bgCustom || '' });
    if (resolution) item.resolution = resolution;
    item.status = 'queued'; item.resultUrl = null; item.error = null;
  });
  res.json({ ok: true });
  runBatch(req.params.batchId, auth, 3);
});

// Upscale
app.post('/api/item/:batchId/:itemId/upscale', async (req, res) => {
  const auth = req.headers['authorization'];
  if (!auth) return res.status(401).json({ error: 'Missing fal.ai key' });
  const item = jobs[req.params.batchId]?.items.find(i => i.id === req.params.itemId);
  if (!item?.resultUrl) return res.status(400).json({ error: 'No image to upscale' });
  try {
    const submit = await falPost('/fal-ai/aura-sr', { image_url: item.resultUrl, upscaling_factor: 4 }, auth);
    if (!submit.request_id) {
      // Try alternative upscaler
      const submit2 = await falPost('/fal-ai/esrgan', { image_url: item.resultUrl, upscaling_factor: 4 }, auth);
      if (!submit2.request_id) throw new Error('Upscale submit failed');
    }
    const reqId = submit.request_id || submit2?.request_id;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const s = await falGet(`/fal-ai/aura-sr/requests/${reqId}/status`, auth);
      if (s.status === 'COMPLETED') {
        const r = await falGet(`/fal-ai/aura-sr/requests/${reqId}`, auth);
        const url = r.image?.url || r.images?.[0]?.url || r.output?.image?.url;
        if (url) { item.resultUrl = url; return res.json({ url }); }
      }
      if (s.status === 'FAILED') throw new Error('Upscale failed');
    }
    throw new Error('Upscale timed out');
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ZIP download
app.get('/api/batch/:batchId/zip', async (req, res) => {
  const batch = jobs[req.params.batchId];
  if (!batch) return res.status(404).json({ error: 'Not found' });
  const done = batch.items.filter(i => i.resultUrl);
  if (!done.length) return res.status(400).json({ error: 'No completed images' });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="fashion-ai-${req.params.batchId.slice(0,8)}.zip"`);
  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.pipe(res);
  for (const item of done) {
    try {
      const r = await fetch(item.resultUrl);
      archive.append(await r.buffer(), { name: `${item.name.replace(/[^a-z0-9_-]/gi,'_')}.jpg` });
    } catch {}
  }
  await archive.finalize();
});

// Style library
function uid(auth) { let h=0; for(let i=0;i<auth.length;i++){h=(Math.imul(31,h)+auth.charCodeAt(i))|0;} return Math.abs(h).toString(16); }
app.post('/api/styles/save', (req,res)=>{ const a=req.headers['authorization']; if(!a) return res.status(401).json({error:'Missing key'}); const u=uid(a); const {name,prompt,styleKey,category,bgOption,gender,realism}=req.body; if(!name) return res.status(400).json({error:'Name required'}); if(!STYLES[u]) STYLES[u]={}; STYLES[u][name]={name,prompt,styleKey,category,bgOption,gender,realism,created:Date.now()}; res.json({ok:true}); });
app.get('/api/styles',(req,res)=>{ const a=req.headers['authorization']; if(!a) return res.status(401).json({error:'Missing key'}); res.json(Object.values(STYLES[uid(a)]||{})); });
app.delete('/api/styles/:name',(req,res)=>{ const a=req.headers['authorization']; if(!a) return res.status(401).json({error:'Missing key'}); delete STYLES[uid(a)]?.[req.params.name]; res.json({ok:true}); });

app.get('*', (req,res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`\n✅  Fashion AI Studio → http://localhost:${PORT}\n`));
