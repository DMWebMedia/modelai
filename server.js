'use strict';
const express  = require('express');
const fetch    = require('node-fetch');
const path     = require('path');
const fs       = require('fs');
const archiver = require('archiver');
const { v4: uuidv4 } = require('uuid');

const app  = express();
const PORT = process.env.PORT || 3456;
app.use(express.json({ limit: '200mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Persistent storage ─────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, {recursive:true});
function loadStore(n){try{return JSON.parse(fs.readFileSync(path.join(DATA_DIR,n+'.json'),'utf8'));}catch{return{};}}
function saveStore(n,d){fs.writeFileSync(path.join(DATA_DIR,n+'.json'),JSON.stringify(d),'utf8');}

let MODELS    = loadStore('models');
let BGSAVED   = loadStore('bgsaved');
let TEMPLATES = loadStore('templates'); // NEW: prompt templates
const jobs = {};

setInterval(()=>{const c=Date.now()-6*60*60*1000;for(const id of Object.keys(jobs)){if(jobs[id].created<c)delete jobs[id];}},30*60*1000);

// ── fal helpers ─────────────────────────────────────────────────────────
async function falReq(method,url,auth,body){
  const r=await fetch(url,{method,headers:{Authorization:auth,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  const t=await r.text();
  if(!t||!t.trim())return{};
  try{return JSON.parse(t);}catch{return{_raw:t};}
}
const falQ   =(p,b,a)=>falReq('POST',`https://queue.fal.run${p}`,a,b);
const falGet =(p,a)  =>falReq('GET', `https://queue.fal.run${p}`,a,null);

async function uploadToFal(base64,mimeType,auth){
  const init=await falReq('POST','https://rest.alpha.fal.ai/storage/upload/initiate',auth,{
    file_name:`img_${Date.now()}_${Math.random().toString(36).slice(2,6)}.jpg`,
    content_type:mimeType||'image/jpeg'
  });
  if(!init.upload_url)throw new Error('Upload initiate failed: '+JSON.stringify(init).slice(0,120));
  const put=await fetch(init.upload_url,{method:'PUT',headers:{'Content-Type':mimeType||'image/jpeg'},body:Buffer.from(base64,'base64')});
  if(!put.ok)throw new Error(`PUT failed ${put.status}`);
  return init.file_url;
}

const AR_MAP={'1:1':'1:1','4:5':'4:5','3:4':'3:4','2:3':'2:3','9:16':'9:16','4:3':'4:3','5:4':'5:4','3:2':'3:2','16:9':'16:9','21:9':'21:9'};
const toAR=ar=>AR_MAP[ar]||'3:4';

// ── Smart Prompt System ─────────────────────────────────────────────────
// Category hints — specific, action-oriented
const CAT = {
  sunglasses: 'wearing the sunglasses, face clearly visible, glasses frames detailed',
  bags: 'carrying the bag naturally, bag clearly visible, strap detail visible',
  shirts: 'wearing the shirt, fabric texture visible, shirt clearly shown',
  dresses: 'wearing the dress, full body visible from head to toe, dress flowing naturally',
  shoes: 'wearing the shoes, feet visible, shoe detail and sole visible',
  watches: 'wearing the watch on left wrist, watch face clearly legible',
  jackets: 'wearing the jacket, full body visible, jacket open or closed naturally',
  pants: 'wearing the pants, full body visible, pants fit visible',
  jewelry: 'wearing the jewelry, jewelry piece in sharp detail focus',
  hats: 'wearing the hat, hat style clearly visible',
  outfit: 'wearing the complete styled outfit — all garments and accessories visible simultaneously, head-to-toe look, fully styled',
  other: 'wearing or holding the product, product clearly visible',
};

// Smart multi-product prompt builder for outfit groups
function buildSmartCategoryHint(category, productNames) {
  if(category === 'outfit' && productNames && productNames.length > 1) {
    return `wearing the complete look: ${productNames.join(', ')} — all pieces worn together simultaneously, full body styled outfit shot`;
  }
  return CAT[category] || CAT.other;
}

// Style hints — punchy, specific
const STYLE = {
  editorial: 'high fashion editorial photography, Vogue magazine quality, dramatic directional lighting, high contrast',
  street: 'street style photography, authentic urban outdoor environment, candid real environment',
  luxury: 'luxury fashion advertising, soft dramatic lighting, elegant upscale ambiance, high-end brand quality',
  ecommerce: 'clean ecommerce product shot, even neutral lighting, no distracting shadows',
  lifestyle: 'lifestyle photography, casual natural light, golden hour warmth, authentic real life',
  minimal: 'minimalist fashion photography, soft diffused studio light, clean neutral tones',
  athletic: 'athletic activewear photography, dynamic action energy, sport lifestyle',
  bohemian: 'bohemian aesthetic, earthy warm tones, natural textures, relaxed effortless vibe',
  formal: 'formal professional fashion, corporate polished look, even studio lighting',
  vintage: 'vintage film aesthetic, retro color grade, warm grain, nostalgic mood',
  streetwear: 'streetwear photography, urban graffiti environment, youthful bold energy',
  haute: 'haute couture fashion art, avant-garde composition, artistic fashion photography',
  campaign: 'advertising campaign photography, dramatic bold composition, hero product moment',
  beauty: 'beauty and skin photography, soft flattering light, glowing skin, makeup detail',
  catalog: 'clean commercial catalog, even shadowless lighting, neutral studio, product clarity',
  resort: 'resort wear, tropical vacation lifestyle, warm beach luxury atmosphere',
};

// Background descriptions — precise
const BG = {
  ai: '',
  white: 'pure white seamless studio background, no shadows',
  grey: 'professional mid-grey seamless studio background',
  lightgrey: 'soft light grey seamless background',
  black: 'dramatic dark black studio background',
  outdoor: 'natural outdoor environment, soft natural daylight',
  street: 'urban city street background, real environment',
  luxury: 'luxury interior, marble, soft upscale ambiance',
  beach: 'tropical beach, golden sand, turquoise ocean',
  forest: 'lush green forest, dappled natural light',
  studio: 'professional photo studio, soft box lighting setup',
  minimal_bg: 'minimal soft gradient background, subtle vignette',
  pink: 'soft blush pink pastel seamless background',
  cream: 'warm cream off-white seamless background',
  custom: '',
};

// Shot descriptions
const SHOT = {
  front: 'front-facing full body pose, directly facing camera, complete head-to-toe',
  back: 'full body back view, model facing away from camera',
  side: 'full body side profile view',
  threeq: 'three-quarter angle view, slightly turned',
  detail: 'extreme macro close-up, product texture and detail sharply in focus',
  face: 'portrait head and shoulders, face clearly visible',
  sitting: 'model in relaxed seated pose, natural sitting position',
  walking: 'model walking mid-stride, dynamic movement',
  dynamic: 'dynamic energetic pose, movement and personality',
  hands: 'tight close-up on hands and wrists with product',
  flat_lay: 'flat lay overhead aerial view, product arranged on surface, no model',
  mannequin: 'ghost invisible mannequin effect, clothing floating, no visible model',
  alone_white: 'product alone on pure white background, commercial product shot, no model',
  alone_grey: 'product on neutral grey background, no model',
  alone_natural: 'product on natural textured wooden surface, lifestyle mood, no model',
  lookbook: 'lookbook editorial lifestyle composition, storytelling image',
  street_life: 'candid street photography feel, real urban environment',
  banner: 'wide cinematic banner composition, advertising hero layout, much negative space',
  group: 'group composition with multiple elements in one scene',
};

// Realism
const REAL = {
  ultra: 'hyperrealistic photograph, ultra sharp detail, natural skin pores and texture, professional Hasselblad quality',
  editorial: 'high fashion editorial retouching, Vogue quality, precise studio lighting',
  cinematic: 'cinematic film look, shallow depth of field, Kodak color grade, anamorphic bokeh',
  raw: 'raw unretouched documentary style, natural ambient light, candid authentic',
};

const GENDER = {
  female: 'beautiful female model, woman',
  male: 'handsome male model, man',
  neutral: 'androgynous fashion model',
};

const LOCK_HINT = 'same exact model as in the reference photo — identical face features, identical hair color and length, identical skin tone, same person';

function buildPrompt(userPrompt, shot, opts={}) {
  const { category='other', styleKey='', bgOption='ai', bgCustom='',
          gender='female', realism='ultra', modelDesc='', isLocked=false,
          productNames=[] } = opts;
  const catHint = buildSmartCategoryHint(category, productNames);
  const parts = [
    userPrompt || '',
    isLocked ? LOCK_HINT : (modelDesc || (GENDER[gender] || GENDER.female)),
    catHint,
    SHOT[shot] || SHOT.front,
    STYLE[styleKey] || '',
    bgOption === 'custom' ? bgCustom : (BG[bgOption] || ''),
    REAL[realism] || REAL.ultra,
  ];
  const p = parts.filter(Boolean).join(', ');
  return p.length > 480 ? p.slice(0, 477) + '...' : p;
}

function buildWebPrompt(userPrompt, shot, bgOption, bgCustom) {
  const parts = [
    userPrompt || 'professional product photo',
    SHOT[shot] || SHOT.alone_white,
    bgOption === 'custom' ? bgCustom : (BG[bgOption] || BG.white),
    'no model, product only, commercial photography, ultra sharp resolution',
  ];
  const p = parts.filter(Boolean).join(', ');
  return p.length > 400 ? p.slice(0, 397) + '...' : p;
}

// ── Model endpoints ─────────────────────────────────────────────────────
// Support multiple AI models for better consistency
const ENDPOINTS = {
  'nb2': '/fal-ai/nano-banana-2/edit',
  'flux-pro': '/fal-ai/flux-pro/v1.1',  // Better quality, higher cost
  'auto': '/fal-ai/nano-banana-2/edit', // default
};

async function generate(item, auth, anchorUrls=[]) {
  item.status = 'uploading';
  const productUrls = [];
  for(const img of item.productImages)
    productUrls.push(await uploadToFal(img.base64, img.mimeType, auth));

  const styleUrls = [];
  for(const s of (item.styleRefImages || []))
    styleUrls.push(await uploadToFal(s.base64, s.mimeType, auth));

  // Product images first, then anchors (model refs), then style refs
  const allUrls = [...productUrls, ...anchorUrls, ...styleUrls];

  item.status = 'generating';
  const endpoint = ENDPOINTS[item.aiModel || 'nb2'] || ENDPOINTS.nb2;
  
  const sub = await falQ(endpoint, {
    prompt: item.prompt,
    image_urls: allUrls,
    num_images: 1,
    aspect_ratio: toAR(item.aspectRatio || '3:4'),
    output_format: 'jpeg',
    safety_tolerance: '4',
    resolution: item.resolution || '1K',
  }, auth);

  if(!sub.request_id) {
    const msg = Array.isArray(sub.detail) ? sub.detail.map(d=>d.msg||d).join('; ') : (sub.detail||sub.error||JSON.stringify(sub).slice(0,200));
    throw new Error('Submit failed: ' + msg);
  }
  item.requestId = sub.request_id;
  item.statusUrl = sub.status_url;
  item.responseUrl = sub.response_url;

  for(let i = 0; i < 150; i++) {
    await new Promise(r=>setTimeout(r, 4000));
    const sp = item.statusUrl ? item.statusUrl.replace('https://queue.fal.run','') : `${endpoint}/requests/${item.requestId}/status`;
    const st = await falGet(sp, auth);
    if(st.status === 'COMPLETED') {
      const rp = item.responseUrl ? item.responseUrl.replace('https://queue.fal.run','') : `${endpoint}/requests/${item.requestId}`;
      const res = await falGet(rp, auth);
      const url = res?.images?.[0]?.url || res?.output?.images?.[0]?.url || res?.image?.url || res?.output?.image?.url || res?.data?.images?.[0]?.url;
      if(!url) throw new Error('No image URL in result: ' + JSON.stringify(res).slice(0,150));
      return url;
    }
    if(st.status === 'FAILED') throw new Error(st.error || st.detail || 'Generation failed');
  }
  throw new Error('Timed out after 10 minutes');
}

async function processItem(batchId, itemId, auth) {
  const batch = jobs[batchId]; if(!batch) return;
  const item = batch.items.find(i=>i.id===itemId); if(!item) return;
  try {
    let anchorUrls = [];

    // Priority 1: per-product or batch-level saved model
    if(item.savedModelUrl && batch.type !== 'website') {
      anchorUrls = [item.savedModelUrl];
      if(!item.prompt.includes(LOCK_HINT)) item.prompt = LOCK_HINT + ', ' + item.prompt;
    }
    // Priority 2: auto-lock — shots 2+ wait for shot 1 of same product
    else if(item.shotIndex > 0 && batch.type !== 'website') {
      const first = batch.items.find(i => i.productKey === item.productKey && i.shotIndex === 0);
      if(first) {
        item.status = 'waiting';
        for(let w = 0; w < 240; w++) {
          if(first.status === 'done' && first.resultUrl) break;
          if(first.status === 'error') break;
          await new Promise(r=>setTimeout(r, 3000));
        }
        if(first.resultUrl) {
          anchorUrls = [first.resultUrl];
          if(!item.prompt.includes(LOCK_HINT)) item.prompt = LOCK_HINT + ', ' + item.prompt;
        }
      }
    }

    const url = await generate(item, auth, anchorUrls);
    item.resultUrl = url; item.status = 'done';
    batch.completedCount = (batch.completedCount||0) + 1;
  } catch(err) {
    item.status = 'error'; item.error = err.message;
    batch.completedCount = (batch.completedCount||0) + 1;
    console.error(`[${itemId}]`, err.message);
  }
}

function runBatch(batchId, auth, concurrency=3) {
  const q = [...jobs[batchId].items.filter(i=>i.status==='queued')];
  const next = async() => { const it=q.shift(); if(!it) return; await processItem(batchId,it.id,auth); await next(); };
  Promise.all(Array.from({length:Math.min(concurrency,q.length||1)}, next))
    .then(()=>{ if(jobs[batchId]) jobs[batchId].status='done'; });
}

// ── Batch create ────────────────────────────────────────────────────────
app.post('/api/batch/create', async(req, res) => {
  const auth = req.headers['authorization'];
  if(!auth) return res.status(401).json({error:'Missing key'});
  const { type='model', products, globalPrompt, promptMode,
          category, styleKey, bgOption, bgCustom,
          gender, realism, resolution, aspectRatio,
          modelDesc, shots, savedModelUrl, aiModel='nb2' } = req.body;

  if(!products?.length) return res.status(400).json({error:'No products'});
  if(products.length > 100) return res.status(400).json({error:'Max 100 products'});

  const batchId = uuidv4();
  const items = [];

  for(let pi = 0; pi < products.length; pi++) {
    const prod = products[pi];
    const perPrompt = (promptMode==='individual' && prod.prompt) ? prod.prompt : globalPrompt;
    const prodModelUrl = prod.savedModelUrl || savedModelUrl || null;
    const productKey = `p${pi}`;
    // Extract product names for smart prompt building
    const productNames = prod.componentNames || [];

    const shotList = (shots && shots.length) ? shots : [{
      shotType: 'front', label: 'Photo',
      bg: bgOption||'ai', bgCustom: bgCustom||'',
      aspectRatio: aspectRatio||'3:4', styleKey: '', customPrompt: '',
    }];

    for(let si = 0; si < shotList.length; si++) {
      const shot = shotList[si];
      const iBg = shot.bg || bgOption || 'ai';
      const iBgC = shot.bgCustom || bgCustom || '';
      const extra = shot.customPrompt ? ', ' + shot.customPrompt : '';
      const isLocked = si > 0 && !prodModelUrl && type !== 'website';
      const prompt = type === 'website'
        ? buildWebPrompt((perPrompt||'')+extra, shot.shotType||'alone_white', iBg, iBgC)
        : buildPrompt((perPrompt||'')+extra, shot.shotType||'front', {
            category: prod.category || category,
            styleKey: shot.styleKey || styleKey,
            bgOption: iBg, bgCustom: iBgC,
            gender: prod.gender || gender,
            realism, modelDesc: prod.modelDesc || modelDesc || '',
            isLocked, productNames,
          });

      items.push({
        id: uuidv4(),
        name: shotList.length>1 ? `${prod.name} — ${shot.label||shot.shotType}` : prod.name,
        productName: prod.name, productKey,
        shotLabel: shot.label || shot.shotType,
        shotIndex: si,
        savedModelUrl: prodModelUrl,
        productImages: prod.images,
        styleRefImages: [],
        prompt, aspectRatio: shot.aspectRatio || aspectRatio || '3:4',
        resolution: shot.resolution || resolution || '1K',
        aiModel: aiModel || 'nb2',
        status: 'queued', requestId: null, resultUrl: null, error: null,
      });
    }
  }

  jobs[batchId] = { type, status:'processing', created:Date.now(), completedCount:0, items };
  res.json({ batchId, total: items.length });
  runBatch(batchId, auth, 3);
});

app.get('/api/batch/:id/status', (req,res) => {
  const b = jobs[req.params.id];
  if(!b) return res.status(404).json({error:'Not found'});
  res.json({ status:b.status, type:b.type, total:b.items.length, completed:b.completedCount||0,
    items: b.items.map(({id,name,productName,shotLabel,shotIndex,productKey,status,resultUrl,error,aspectRatio,aiModel}) =>
      ({id,name,productName,shotLabel,shotIndex,productKey,status,resultUrl,error,aspectRatio,aiModel})) });
});

app.post('/api/item/:bid/:iid/regenerate', async(req,res) => {
  const auth = req.headers['authorization'];
  if(!auth) return res.status(401).json({error:'Missing key'});
  const b = jobs[req.params.bid]; if(!b) return res.status(404).json({error:'Not found'});
  const item = b.items.find(i=>i.id===req.params.iid); if(!item) return res.status(404).json({error:'Not found'});
  const {prompt,category,styleKey,bgOption,bgCustom,gender,realism,resolution,aspectRatio,shotType,modelDesc} = req.body;
  if(prompt) item.prompt = b.type==='website'
    ? buildWebPrompt(prompt,shotType||'alone_white',bgOption||'white',bgCustom||'')
    : buildPrompt(prompt,shotType||'front',{category:category||'other',styleKey,bgOption:bgOption||'ai',bgCustom:bgCustom||'',gender:gender||'female',realism:realism||'ultra',modelDesc:modelDesc||''});
  if(resolution) item.resolution=resolution;
  if(aspectRatio) item.aspectRatio=aspectRatio;
  item.status='queued'; item.resultUrl=null; item.error=null;
  res.json({ok:true});
  processItem(req.params.bid, item.id, auth);
});

app.post('/api/batch/:id/edit', async(req,res) => {
  const auth = req.headers['authorization'];
  if(!auth) return res.status(401).json({error:'Missing key'});
  const b = jobs[req.params.id]; if(!b) return res.status(404).json({error:'Not found'});
  const {globalPrompt,category,styleKey,bgOption,bgCustom,gender,realism,resolution,modelDesc} = req.body;
  b.completedCount=0; b.status='processing';
  b.items.forEach(it => {
    if(globalPrompt) it.prompt = b.type==='website'
      ? buildWebPrompt(globalPrompt,it.shotType||'alone_white',bgOption||'white',bgCustom||'')
      : buildPrompt(globalPrompt,it.shotType||'front',{category:category||'other',styleKey,bgOption:bgOption||'ai',bgCustom:bgCustom||'',gender:gender||'female',realism:realism||'ultra',modelDesc:modelDesc||''});
    if(resolution) it.resolution=resolution;
    it.status='queued'; it.resultUrl=null; it.error=null;
  });
  res.json({ok:true});
  runBatch(req.params.id, auth, 3);
});

app.post('/api/item/:bid/:iid/upscale', async(req,res) => {
  const auth = req.headers['authorization'];
  if(!auth) return res.status(401).json({error:'Missing key'});
  const item = jobs[req.params.bid]?.items.find(i=>i.id===req.params.iid);
  if(!item?.resultUrl) return res.status(400).json({error:'No image'});
  try {
    const sub = await falQ('/fal-ai/aura-sr',{image_url:item.resultUrl,upscaling_factor:4},auth);
    if(!sub.request_id) throw new Error('Upscale submit failed');
    for(let i=0;i<60;i++){
      await new Promise(r=>setTimeout(r,3000));
      const s = await falGet(`/fal-ai/aura-sr/requests/${sub.request_id}/status`,auth);
      if(s.status==='COMPLETED'){const r=await falGet(`/fal-ai/aura-sr/requests/${sub.request_id}`,auth);const url=r.image?.url||r.images?.[0]?.url||r.output?.image?.url;if(url){item.resultUrl=url;return res.json({url});}}
      if(s.status==='FAILED') throw new Error('Upscale failed');
    }
    throw new Error('Upscale timed out');
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/api/batch/:id/zip', async(req,res) => {
  const b = jobs[req.params.id]; if(!b) return res.status(404).json({error:'Not found'});
  const done = b.items.filter(i=>i.resultUrl); if(!done.length) return res.status(400).json({error:'No images'});
  res.setHeader('Content-Type','application/zip');
  res.setHeader('Content-Disposition',`attachment; filename="fashion-${req.params.id.slice(0,8)}.zip"`);
  const arc = archiver('zip',{zlib:{level:6}}); arc.pipe(res);
  for(const it of done){
    try{if(!it.resultUrl)continue;const r=await fetch(it.resultUrl);arc.append(Buffer.from(await r.arrayBuffer()),{name:`${it.name.replace(/[^a-z0-9_\-]/gi,'_')}.jpg`});}catch(e){console.error('ZIP skip:',e.message);}
  }
  await arc.finalize();
});

function uid(a){let h=0;for(let i=0;i<a.length;i++){h=(Math.imul(31,h)+a.charCodeAt(i))|0;}return Math.abs(h).toString(16);}

// Models
app.post('/api/models/save',(req,res)=>{const a=req.headers['authorization'];if(!a)return res.status(401).json({error:'Missing key'});const u=uid(a);const{name,imageUrl,description='',gender=''}=req.body;if(!name||!imageUrl)return res.status(400).json({error:'name+imageUrl required'});if(!MODELS[u])MODELS[u]={};const id='m'+Date.now();MODELS[u][id]={id,name,imageUrl,description,gender,created:Date.now()};saveStore('models',MODELS);res.json({ok:true,id});});
app.get('/api/models',(req,res)=>{const a=req.headers['authorization'];if(!a)return res.status(401).json({error:'Missing key'});res.json(Object.values(MODELS[uid(a)]||{}).sort((x,y)=>y.created-x.created));});
app.delete('/api/models/:id',(req,res)=>{const a=req.headers['authorization'];if(!a)return res.status(401).json({error:'Missing key'});const u=uid(a);delete MODELS[u]?.[req.params.id];saveStore('models',MODELS);res.json({ok:true});});

// Backgrounds
app.post('/api/backgrounds/save',(req,res)=>{const a=req.headers['authorization'];if(!a)return res.status(401).json({error:'Missing key'});const u=uid(a);const{name,bgOption,bgCustom='',description=''}=req.body;if(!name)return res.status(400).json({error:'name required'});if(!BGSAVED[u])BGSAVED[u]={};const id='bg'+Date.now();BGSAVED[u][id]={id,name,bgOption:bgOption||'custom',bgCustom,description,created:Date.now()};saveStore('bgsaved',BGSAVED);res.json({ok:true,id});});
app.get('/api/backgrounds',(req,res)=>{const a=req.headers['authorization'];if(!a)return res.status(401).json({error:'Missing key'});res.json(Object.values(BGSAVED[uid(a)]||{}).sort((x,y)=>y.created-x.created));});
app.delete('/api/backgrounds/:id',(req,res)=>{const a=req.headers['authorization'];if(!a)return res.status(401).json({error:'Missing key'});const u=uid(a);delete BGSAVED[u]?.[req.params.id];saveStore('bgsaved',BGSAVED);res.json({ok:true});});

// Templates (NEW)
app.post('/api/templates/save',(req,res)=>{const a=req.headers['authorization'];if(!a)return res.status(401).json({error:'Missing key'});const u=uid(a);const{name,...rest}=req.body;if(!name)return res.status(400).json({error:'name required'});if(!TEMPLATES[u])TEMPLATES[u]={};const id='t'+Date.now();TEMPLATES[u][id]={id,name,...rest,created:Date.now()};saveStore('templates',TEMPLATES);res.json({ok:true,id});});
app.get('/api/templates',(req,res)=>{const a=req.headers['authorization'];if(!a)return res.status(401).json({error:'Missing key'});res.json(Object.values(TEMPLATES[uid(a)]||{}).sort((x,y)=>y.created-x.created));});
app.delete('/api/templates/:id',(req,res)=>{const a=req.headers['authorization'];if(!a)return res.status(401).json({error:'Missing key'});const u=uid(a);delete TEMPLATES[u]?.[req.params.id];saveStore('templates',TEMPLATES);res.json({ok:true});});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT,()=>console.log(`\n✅ Fashion AI → http://localhost:${PORT}\n`));
