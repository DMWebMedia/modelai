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
setInterval(() => { const c=Date.now()-3*60*60*1000; for(const id of Object.keys(jobs)){if(jobs[id].created<c)delete jobs[id];} }, 30*60*1000);

// ── fal.ai helpers ────────────────────────────────────────────────────
async function falRequest(method, url, auth, body) {
  const opts = { method, headers:{ Authorization:auth, 'Content-Type':'application/json' } };
  if(body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  const text = await r.text();
  if(!text||!text.trim()) return {};
  try { return JSON.parse(text); } catch { return { _raw:text, _status:r.status }; }
}
const falPost = (p,b,a) => falRequest('POST',`https://queue.fal.run${p}`,a,b);
const falGet  = (p,a)   => falRequest('GET', `https://queue.fal.run${p}`,a,null);

async function uploadToFal(base64, mimeType, auth) {
  const init = await falRequest('POST','https://rest.alpha.fal.ai/storage/upload/initiate',auth,{
    file_name:`img_${Date.now()}.jpg`, content_type:mimeType||'image/jpeg'
  });
  if(!init.upload_url) throw new Error('fal upload initiate failed: '+JSON.stringify(init).slice(0,200));
  const buf = Buffer.from(base64,'base64');
  const put = await fetch(init.upload_url,{ method:'PUT', headers:{'Content-Type':mimeType||'image/jpeg'}, body:buf });
  if(!put.ok) throw new Error(`fal PUT failed: ${put.status}`);
  return init.file_url;
}

// Aspect ratio → NB2 valid string
const NB2_RATIOS = {
  '1:1':'1:1','4:5':'4:5','3:4':'3:4','2:3':'2:3','9:16':'9:16',
  '4:3':'4:3','5:4':'5:4','3:2':'3:2','16:9':'16:9','21:9':'21:9',
};
function toNBRatio(ar) { return NB2_RATIOS[ar]||'3:4'; }

// ── Prompt engineering ────────────────────────────────────────────────
const CAT_HINTS = {
  sunglasses:'person wearing sunglasses, face visible',
  bags:'person holding or wearing the bag elegantly',
  shirts:'person wearing the shirt',
  dresses:'person wearing the dress, full body',
  shoes:'person wearing the shoes, full body including feet',
  watches:'person wearing the watch on wrist',
  jackets:'person wearing the jacket, full body',
  pants:'person wearing the pants, full body',
  jewelry:'person wearing the jewelry, close detail',
  hats:'person wearing the hat',
  other:'person wearing or holding the product',
};

const STYLE_HINTS = {
  editorial:'high fashion editorial, Vogue magazine, dramatic studio lighting, high contrast',
  street:'street style, urban outdoor, candid, real environment',
  luxury:'luxury fashion, elegant, soft dramatic lighting, high-end',
  ecommerce:'clean ecommerce, white background, neutral lighting',
  lifestyle:'lifestyle photography, casual, natural golden hour, outdoor',
  minimal:'minimalist, clean neutral background, soft light',
  athletic:'athletic lifestyle, sport, dynamic action',
  bohemian:'bohemian, earthy tones, natural textures, relaxed',
  formal:'formal professional, corporate, polished',
  vintage:'vintage, retro color grade, film photography',
  streetwear:'streetwear, urban, graffiti, youthful energy',
  haute:'haute couture, avant-garde, artistic fashion',
};

const BG_HINTS = {
  ai:'',
  white:'pure white seamless studio background',
  grey:'professional grey seamless studio background, soft gradient',
  lightgrey:'very light grey seamless background, near white',
  black:'dramatic black studio background',
  outdoor:'natural outdoor environment, realistic location',
  street:'urban street city sidewalk, realistic environment',
  luxury:'luxury interior, marble floors, upscale boutique',
  beach:'tropical beach, golden sand, ocean in distance',
  forest:'lush green forest, dappled natural light',
  studio:'photography studio, soft box lighting setup',
  minimal_bg:'minimal gradient background, soft colors',
  custom:'',
};

const SHOT_PROMPTS = {
  front:       'front-facing pose, full body visible, facing camera directly, relaxed natural stance',
  back:        'back view, model facing away from camera, full body rear shot, elegant back pose',
  side:        'side profile view, model facing sideways, full body side shot',
  detail:      'close-up detail shot, extreme close-up of the product, fabric texture visible, macro detail',
  face:        'portrait shot, head and shoulders, face and upper body, close-up portrait',
  sitting:     'model sitting down, seated pose, relaxed sitting position',
  walking:     'walking pose, mid-stride dynamic walk, motion and energy',
  dynamic:     'dynamic action pose, movement, energy, fashion editorial dynamic',
  hands:       'hands and wrist detail shot, close-up of hands holding or wearing the item',
  flat_lay:    'flat lay product photo, product laid flat on clean surface, overhead aerial view, no model',
  mannequin:   'product on invisible ghost mannequin, clothing floating, no visible model',
  alone_white: 'product alone on pure white background, no model, professional product shot, clean commercial',
  alone_grey:  'product alone on grey background, no model, professional product photography',
  alone_natural:'product alone on natural wooden surface, lifestyle product shot, no model',
  lookbook:    'lookbook style, fashion editorial, lifestyle setting, storytelling composition',
  street_life: 'real street background, candid urban lifestyle, city life, authentic environment',
};

const REALISM_HINTS = {
  ultra:[
    'shot on Hasselblad H6D-100c','110mm f/2.2 lens','natural skin texture with realistic pores',
    'micro fabric detail visible','does NOT look AI generated','hyperrealistic photograph',
    'indistinguishable from real photo','ultra sharp focus','professional commercial photographer',
    'award-winning fashion photography','subtle natural film grain','true-to-life skin tones',
    'realistic subsurface skin scattering','photographic realism',
  ].join(', '),
  editorial:[
    'high fashion editorial','Vogue quality retouching','professional strobe studio lighting',
    'ultra sharp','commercial grade','world-class photographer',
  ].join(', '),
  cinematic:[
    'cinematic film look','anamorphic bokeh','shallow depth of field f/1.4',
    'Kodak film color grade','natural lens flare','ARRI Alexa cinema quality',
  ].join(', '),
  raw:[
    'raw unretouched photo','documentary photography','natural ambient light',
    'candid authentic look','film reportage style','Leica street photography',
  ].join(', '),
};

const GENDER_HINTS = { female:'beautiful female model, woman', male:'handsome male model, man', neutral:'androgynous model, non-binary' };

function buildModelPrompt(userPrompt, shot, opts={}) {
  const { category='other', styleKey='', bgOption='ai', bgCustom='', gender='female', realism='ultra' } = opts;
  const shotHint  = SHOT_PROMPTS[shot] || SHOT_PROMPTS.front;
  const catHint   = CAT_HINTS[category] || CAT_HINTS.other;
  const styleHint = STYLE_HINTS[styleKey] || '';
  const bgHint    = bgOption==='custom' ? bgCustom : (BG_HINTS[bgOption]||'');
  const genHint   = GENDER_HINTS[gender] || GENDER_HINTS.female;
  const realHint  = REALISM_HINTS[realism] || REALISM_HINTS.ultra;
  return [userPrompt, genHint, catHint, shotHint, styleHint, bgHint, realHint].filter(Boolean).join(', ');
}

function buildProductPhotoPrompt(userPrompt, shot, opts={}) {
  const { bgOption='white', bgCustom='' } = opts;
  const shotHint = SHOT_PROMPTS[shot] || SHOT_PROMPTS.front;
  const bgHint = bgOption==='custom' ? bgCustom : (BG_HINTS[bgOption]||BG_HINTS.white);
  return [
    userPrompt||'professional product photo',
    shotHint,
    bgHint,
    'no model, product only',
    'shot on Phase One XT camera, 120mm macro lens',
    'perfect studio lighting with soft boxes',
    'ultra sharp product detail, commercial grade',
    'zero shadows on background, professional color grading',
  ].filter(Boolean).join(', ');
}

// ── Job processor ─────────────────────────────────────────────────────
async function processItem(batchId, itemId, auth) {
  const batch = jobs[batchId];
  if(!batch) return;
  const item = batch.items.find(i=>i.id===itemId);
  if(!item) return;
  try {
    item.status='uploading';
    const imageUrl = await uploadToFal(item.base64, item.mimeType, auth);
    const refUrls  = [];
    if(item.refImages?.length) {
      for(const ref of item.refImages) refUrls.push(await uploadToFal(ref.base64,ref.mimeType,auth));
    }
    item.status='generating';
    const submitData = await falPost('/fal-ai/nano-banana-2/edit', {
      prompt: item.prompt,
      image_urls: [imageUrl,...refUrls],
      num_images: 1,
      aspect_ratio: toNBRatio(item.aspectRatio||'3:4'),
      output_format: 'jpeg',
      safety_tolerance: '4',
      resolution: item.resolution||'1K',
    }, auth);

    if(!submitData.request_id) {
      const msg = Array.isArray(submitData.detail)
        ? submitData.detail.map(d=>d.msg||d).join('; ')
        : (submitData.detail||submitData.error||JSON.stringify(submitData).slice(0,300));
      throw new Error('Submit failed: '+msg);
    }
    item.requestId   = submitData.request_id;
    item.statusUrl   = submitData.status_url;
    item.responseUrl = submitData.response_url;

    // Poll
    for(let i=0;i<150;i++) {
      await new Promise(r=>setTimeout(r,4000));
      const statusPath = item.statusUrl
        ? item.statusUrl.replace('https://queue.fal.run','')
        : `/fal-ai/nano-banana-2/edit/requests/${item.requestId}/status`;
      const st = await falGet(statusPath, auth);
      if(st.status==='COMPLETED') {
        const resultPath = item.responseUrl
          ? item.responseUrl.replace('https://queue.fal.run','')
          : `/fal-ai/nano-banana-2/edit/requests/${item.requestId}`;
        const res = await falGet(resultPath, auth);
        const url = res?.images?.[0]?.url || res?.output?.images?.[0]?.url
          || res?.image?.url || res?.output?.image?.url || res?.data?.images?.[0]?.url;
        if(!url) throw new Error('COMPLETED but no image URL: '+JSON.stringify(res).slice(0,200));
        item.resultUrl=url; item.status='done';
        batch.completedCount=(batch.completedCount||0)+1;
        return;
      }
      if(st.status==='FAILED') throw new Error(st.error||st.detail||'fal.ai generation failed');
    }
    throw new Error('Timed out after 10 minutes');
  } catch(err) {
    item.status='error'; item.error=err.message;
    batch.completedCount=(batch.completedCount||0)+1;
    console.error(`[${itemId}]`,err.message);
  }
}

function runBatch(batchId, auth, concurrency=3) {
  const queue = [...jobs[batchId].items.filter(i=>i.status==='queued')];
  const runNext = async()=>{ const item=queue.shift(); if(!item)return; await processItem(batchId,item.id,auth); await runNext(); };
  const workers = Array.from({length:Math.min(concurrency,queue.length)},runNext);
  Promise.all(workers).then(()=>{ if(jobs[batchId]) jobs[batchId].status='done'; });
}

// ── Routes ────────────────────────────────────────────────────────────
app.post('/api/batch/create', async(req,res)=>{
  const auth=req.headers['authorization'];
  if(!auth) return res.status(401).json({error:'Missing key'});
  const { type='model', items, globalPrompt, promptMode,
    category, styleKey, bgOption, bgMode, bgCustom, globalBgPrompts,
    gender, realism, resolution, aspectRatio,
    shots, // array of shot config objects [{type, bg, bgCustom, label}]
  } = req.body;

  if(!items?.length) return res.status(400).json({error:'No items'});
  if(items.length>100) return res.status(400).json({error:'Max 100 products'});

  const batchId = uuidv4();
  const builtItems = [];

  for(const it of items) {
    const perPrompt = promptMode==='individual'&&it.prompt ? it.prompt : globalPrompt;

    if(shots&&shots.length) {
      // Shot planner mode — one item per shot per product
      for(const shot of shots) {
        const itemBg = shot.bg||bgOption||'ai';
        const itemBgCustom = shot.bgCustom||bgCustom||'';
        const prompt = type==='website'
          ? buildProductPhotoPrompt(perPrompt||shot.customPrompt, shot.shotType||'front', {bgOption:itemBg,bgCustom:itemBgCustom})
          : buildModelPrompt(perPrompt||(shot.customPrompt||''), shot.shotType||'front', {category,styleKey:shot.styleKey||styleKey,bgOption:itemBg,bgCustom:itemBgCustom,gender,realism});
        builtItems.push({
          id:uuidv4(),
          name:`${it.name||'product'} — ${shot.label||shot.shotType}`,
          originalName:it.name||'product',
          shotType:shot.shotType,
          shotLabel:shot.label||shot.shotType,
          base64:it.base64,
          mimeType:it.mimeType||'image/jpeg',
          refImages:it.refImages||[],
          prompt,
          aspectRatio:shot.aspectRatio||aspectRatio||'3:4',
          resolution:shot.resolution||resolution||'1K',
          status:'queued',
          requestId:null,
          resultUrl:null,
          error:null,
        });
      }
    } else {
      // Legacy mode — single shot per product
      const bg = bgOption||'ai';
      const prompt = type==='website'
        ? buildProductPhotoPrompt(perPrompt,'front',{bgOption:bg,bgCustom:bgCustom||''})
        : buildModelPrompt(perPrompt,'front',{category,styleKey,bgOption:bg,bgCustom:bgCustom||'',gender,realism});
      builtItems.push({
        id:uuidv4(),
        name:it.name||'product',
        originalName:it.name||'product',
        base64:it.base64,
        mimeType:it.mimeType||'image/jpeg',
        refImages:it.refImages||[],
        prompt,
        aspectRatio:aspectRatio||'3:4',
        resolution:resolution||'1K',
        status:'queued',requestId:null,resultUrl:null,error:null,
      });
    }
  }

  jobs[batchId]={ type, status:'processing', created:Date.now(), completedCount:0, items:builtItems };
  res.json({ batchId, total:builtItems.length });
  runBatch(batchId, auth, 3);
});

app.get('/api/batch/:id/status',(req,res)=>{
  const b=jobs[req.params.id];
  if(!b) return res.status(404).json({error:'Not found'});
  res.json({ status:b.status, type:b.type, total:b.items.length, completed:b.completedCount||0,
    items:b.items.map(({id,name,originalName,shotType,shotLabel,status,resultUrl,error})=>({id,name,originalName,shotType,shotLabel,status,resultUrl,error})) });
});

app.post('/api/item/:bid/:iid/regenerate',async(req,res)=>{
  const auth=req.headers['authorization'];
  if(!auth) return res.status(401).json({error:'Missing key'});
  const b=jobs[req.params.bid]; if(!b) return res.status(404).json({error:'Batch not found'});
  const item=b.items.find(i=>i.id===req.params.iid); if(!item) return res.status(404).json({error:'Item not found'});
  const {prompt,category,styleKey,bgOption,bgCustom,gender,realism,resolution,aspectRatio,shotType}=req.body;
  if(prompt) item.prompt = b.type==='website'
    ? buildProductPhotoPrompt(prompt,shotType||item.shotType||'front',{bgOption:bgOption||item.bgOption||'white',bgCustom:bgCustom||''})
    : buildModelPrompt(prompt,shotType||item.shotType||'front',{category:category||'other',styleKey:styleKey||'',bgOption:bgOption||'ai',bgCustom:bgCustom||'',gender:gender||'female',realism:realism||'ultra'});
  if(resolution) item.resolution=resolution;
  if(aspectRatio) item.aspectRatio=aspectRatio;
  item.status='queued'; item.resultUrl=null; item.error=null;
  res.json({ok:true});
  processItem(req.params.bid,item.id,auth);
});

app.post('/api/batch/:id/edit',async(req,res)=>{
  const auth=req.headers['authorization'];
  if(!auth) return res.status(401).json({error:'Missing key'});
  const b=jobs[req.params.id]; if(!b) return res.status(404).json({error:'Not found'});
  const {globalPrompt,category,styleKey,bgOption,bgCustom,gender,realism,resolution}=req.body;
  b.completedCount=0; b.status='processing';
  b.items.forEach(item=>{
    if(globalPrompt) item.prompt = b.type==='website'
      ? buildProductPhotoPrompt(globalPrompt,item.shotType||'front',{bgOption:bgOption||'white',bgCustom:bgCustom||''})
      : buildModelPrompt(globalPrompt,item.shotType||'front',{category:category||'other',styleKey:styleKey||'',bgOption:bgOption||'ai',bgCustom:bgCustom||'',gender:gender||'female',realism:realism||'ultra'});
    if(resolution) item.resolution=resolution;
    item.status='queued'; item.resultUrl=null; item.error=null;
  });
  res.json({ok:true});
  runBatch(req.params.id,auth,3);
});

app.post('/api/item/:bid/:iid/upscale',async(req,res)=>{
  const auth=req.headers['authorization'];
  if(!auth) return res.status(401).json({error:'Missing key'});
  const item=jobs[req.params.bid]?.items.find(i=>i.id===req.params.iid);
  if(!item?.resultUrl) return res.status(400).json({error:'No image'});
  try {
    const sub=await falPost('/fal-ai/aura-sr',{image_url:item.resultUrl,upscaling_factor:4},auth);
    if(!sub.request_id) throw new Error('Upscale submit failed');
    for(let i=0;i<60;i++){
      await new Promise(r=>setTimeout(r,3000));
      const s=await falGet(`/fal-ai/aura-sr/requests/${sub.request_id}/status`,auth);
      if(s.status==='COMPLETED'){
        const r=await falGet(`/fal-ai/aura-sr/requests/${sub.request_id}`,auth);
        const url=r.image?.url||r.images?.[0]?.url||r.output?.image?.url;
        if(url){item.resultUrl=url;return res.json({url});}
      }
      if(s.status==='FAILED') throw new Error('Upscale failed');
    }
    throw new Error('Upscale timed out');
  } catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/batch/:id/zip',async(req,res)=>{
  const b=jobs[req.params.id]; if(!b) return res.status(404).json({error:'Not found'});
  const done=b.items.filter(i=>i.resultUrl); if(!done.length) return res.status(400).json({error:'No images'});
  res.setHeader('Content-Type','application/zip');
  res.setHeader('Content-Disposition',`attachment; filename="fashion-ai-${req.params.id.slice(0,8)}.zip"`);
  const archive=archiver('zip',{zlib:{level:6}}); archive.pipe(res);
  for(const item of done){
    try{ const r=await fetch(item.resultUrl); archive.append(await r.buffer(),{name:`${item.name.replace(/[^a-z0-9_-]/gi,'_')}.jpg`}); }catch{}
  }
  await archive.finalize();
});

function uid(a){let h=0;for(let i=0;i<a.length;i++){h=(Math.imul(31,h)+a.charCodeAt(i))|0;}return Math.abs(h).toString(16);}
app.post('/api/styles/save',(req,res)=>{const a=req.headers['authorization'];if(!a)return res.status(401).json({error:'Missing key'});const u=uid(a);const{name,...rest}=req.body;if(!name)return res.status(400).json({error:'Name required'});if(!STYLES[u])STYLES[u]={};STYLES[u][name]={name,...rest,created:Date.now()};res.json({ok:true});});
app.get('/api/styles',(req,res)=>{const a=req.headers['authorization'];if(!a)return res.status(401).json({error:'Missing key'});res.json(Object.values(STYLES[uid(a)]||{}));});
app.delete('/api/styles/:name',(req,res)=>{const a=req.headers['authorization'];if(!a)return res.status(401).json({error:'Missing key'});delete STYLES[uid(a)]?.[req.params.name];res.json({ok:true});});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT,()=>console.log(`\n✅  Fashion AI Studio → http://localhost:${PORT}\n`));
