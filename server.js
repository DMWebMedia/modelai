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

// ── Storage ────────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, {recursive:true});
function loadStore(n){try{return JSON.parse(fs.readFileSync(path.join(DATA_DIR,n+'.json'),'utf8'));}catch{return{};}}
function saveStore(n,d){fs.writeFileSync(path.join(DATA_DIR,n+'.json'),JSON.stringify(d),'utf8');}
let MODELS    = loadStore('models');
let BGSAVED   = loadStore('bgsaved');
let TEMPLATES = loadStore('templates');
const jobs    = {};
setInterval(()=>{const c=Date.now()-8*60*60*1000;for(const id of Object.keys(jobs)){if(jobs[id].created<c)delete jobs[id];}},30*60*1000);

// ── API key ────────────────────────────────────────────────────────────────
const FAL_KEY_SERVER     = process.env.FAL_KEY || '3ac08d82-1ead-4b6d-bd1e-284466179096:47b3486ef62f854276f4c2bf6fbfae09';
const ANTHROPIC_KEY      = process.env.ANTHROPIC_API_KEY || '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';
function resolveAuth(){ return 'Key ' + FAL_KEY_SERVER; }
function uid(){
  const key = 'Key ' + FAL_KEY_SERVER;
  let h = 0;
  for(let i=0;i<key.length;i++){h=(Math.imul(31,h)+key.charCodeAt(i))|0;}
  return Math.abs(h).toString(16);
}

// ── fal.ai helpers ─────────────────────────────────────────────────────────
async function falReq(method,url,auth,body){
  const r=await fetch(url,{method,headers:{Authorization:auth,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  const t=await r.text();
  if(!t||!t.trim())return{};
  try{return JSON.parse(t);}catch{return{_raw:t};}
}
const falQ   =(p,b,a)=>falReq('POST',`https://queue.fal.run${p}`,a,b);
const falGet =(p,a)  =>falReq('GET', `https://queue.fal.run${p}`,a,null);

const uploadCache=new Map();
async function uploadToFal(base64,mimeType,auth){
  const key=(mimeType||'img')+':'+base64.slice(0,128);
  if(uploadCache.has(key))return uploadCache.get(key);
  const init=await falReq('POST','https://rest.alpha.fal.ai/storage/upload/initiate',auth,{
    file_name:`img_${Date.now()}.jpg`,content_type:mimeType||'image/jpeg'
  });
  if(!init.upload_url)throw new Error('Upload failed: '+JSON.stringify(init).slice(0,120));
  const put=await fetch(init.upload_url,{method:'PUT',headers:{'Content-Type':mimeType||'image/jpeg'},body:Buffer.from(base64,'base64')});
  if(!put.ok)throw new Error('Upload PUT failed '+put.status);
  uploadCache.set(key,init.file_url);
  if(uploadCache.size>500)uploadCache.delete(uploadCache.keys().next().value);
  return init.file_url;
}

const AR_MAP={'1:1':'1:1','4:5':'4:5','3:4':'3:4','2:3':'2:3','9:16':'9:16','4:3':'4:3','5:4':'5:4','3:2':'3:2','16:9':'16:9','21:9':'21:9'};
const toAR=ar=>AR_MAP[ar]||'3:4';

// ── Prompt dictionaries ────────────────────────────────────────────────────
// CORE RULE: The product image is the SINGLE SOURCE OF TRUTH for the garment.
// Never add, invent, or change anything about the clothing.
// The garment in the output must be pixel-identical to the reference in terms of:
// length, shape, cut, color, fabric, details, accessories, hem, straps, patterns.

const GARMENT_LOCK = 'reproduce the exact garment from the reference image with 100% accuracy — same length, same cut, same fabric, same color, same every detail — do not add shoes, do not shorten, do not lengthen, do not add any item not visible in the reference';

const CAT={
  shirts:'wearing the exact shirt from the reference image',
  dresses:'wearing the exact dress from the reference image, preserve exact hemline and length',
  sunglasses:'wearing the exact sunglasses from the reference image',
  bags:'holding the exact bag from the reference image, same bag shape and hardware',
  shoes:'wearing the exact shoes from the reference image',
  watches:'wearing the exact watch from the reference image',
  jackets:'wearing the exact jacket from the reference image',
  pants:'wearing the exact pants from the reference image, preserve exact length',
  jewelry:'wearing the exact jewelry from the reference image',
  hats:'wearing the exact hat from the reference image',
  outfit:'wearing the exact complete outfit from the reference image, every piece identical',
  other:'wearing or holding the exact product from the reference image',
};

const SHOT={
  front:'model facing camera directly, full body visible from head to feet',
  back:'model facing away from camera, full body visible from head to feet, rear view',
  side:'model in side profile, full body visible from head to feet',
  threeq:'three-quarter angle view, slightly turned',
  detail:'extreme close-up, product texture and detail in sharp focus',
  face:'portrait, head and shoulders only',
  sitting:'model seated naturally',
  walking:'model mid-stride, walking',
  dynamic:'dynamic energetic pose',
  hands:'close-up on hands and wrists',
  flat_lay:'flat lay overhead, product on surface, no model',
  mannequin:'ghost mannequin effect, clothing only, no visible model',
  alone_white:'product only on pure white background, no model',
  alone_grey:'product only on neutral grey background, no model',
  alone_natural:'product on natural wood surface, no model',
  lookbook:'lookbook editorial lifestyle composition',
  street_life:'street photography, urban candid environment',
  banner:'wide cinematic banner, negative space on sides',
  group:'group composition, wide shot, all subjects visible',
};
const BG={
  white:'pure white seamless studio background',
  grey:'neutral grey seamless studio background',
  lightgrey:'soft light grey seamless background',
  black:'dramatic black studio background',
  outdoor:'outdoor natural environment, daylight',
  street:'urban city street',
  luxury:'luxury interior, marble, upscale setting',
  beach:'tropical beach, golden sand, ocean',
  forest:'lush green forest',
  studio:'professional photo studio',
  minimal_bg:'soft minimal gradient background',
  pink:'soft blush pink background',
  cream:'warm cream off-white background',
  ai:'',custom:'',
};
const STYLE={
  editorial:'Vogue editorial fashion photography, dramatic lighting, high contrast',
  street:'street style photography, authentic urban environment',
  luxury:'luxury fashion advertising, elegant soft lighting',
  ecommerce:'clean e-commerce shot, even lighting, neutral background',
  lifestyle:'lifestyle photography, natural golden light',
  minimal:'minimalist fashion photography, soft diffused light',
  athletic:'athletic activewear, dynamic action shot',
  bohemian:'bohemian aesthetic, earthy warm tones',
  formal:'formal professional fashion, polished studio',
  vintage:'vintage film look, warm grain, retro color',
  streetwear:'streetwear photography, urban bold energy',
  haute:'haute couture, avant-garde artistic fashion',
  campaign:'bold advertising campaign, hero product moment',
  beauty:'beauty photography, glowing skin, soft flattering light',
  catalog:'clean catalog shot, even shadowless lighting',
  resort:'resort wear, tropical luxury lifestyle',
};
const REAL={
  ultra:'hyperrealistic photograph, ultra sharp, professional camera quality',
  editorial:'high fashion editorial, Vogue retouching quality',
  cinematic:'cinematic film look, shallow depth of field, anamorphic bokeh',
  raw:'raw documentary style, natural ambient light, candid',
};
const GENDER={female:'beautiful female model',male:'handsome male model',neutral:'fashion model'};


// ── Claude Vision — analyze product image to extract exact garment description ──
// This runs once per product group before NB2 generation
// Cost: ~$0.003 per image (negligible vs $0.08 for NB2)
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL  = 'claude-sonnet-4-5';

// Analyze a single image with a specific angle context
async function analyzeOneImage(base64, mimeType, angleHint) {
  const body = {
    model: CLAUDE_MODEL,
    max_tokens: 250,
    messages: [{
      role: 'user',
      content: [
        { type:'image', source:{ type:'base64', media_type:mimeType||'image/jpeg', data:base64 } },
        {
          type: 'text',
          text: `This is a product photo (${angleHint}) for an AI fashion image generator.

Describe ONLY what is visible in THIS image. Be precise and specific.

For clothing: type, color, fabric, length, cut, neckline, straps, and any details VISIBLE IN THIS IMAGE ONLY.
For accessories: describe every bag, jewelry, bracelet, belt visible in this image.
For feet: ONLY mention if shoes/feet are clearly exposed. If dress covers feet write "feet covered".

Output: one dense paragraph, max 80 words. No model descriptions.`,
        },
      ],
    }],
  };

  const resp = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json();
  return data?.content?.[0]?.text?.trim() || null;
}

// Analyze garment by processing each image separately then combining
// This mirrors how a human would analyze: look at front, note what's there,
// look at back, note what's DIFFERENT, combine into structured description
async function analyzeGarment(imageBase64, mimeType, extraImages=[]) {
  try {
    const allImages = [
      { base64: imageBase64, mimeType: mimeType||'image/jpeg' },
      ...extraImages,
    ];

    // Determine angle labels based on image count and order
    // Typically: first image = front/main, subsequent = back/side/detail
    const angleLabels = ['front/main view', 'back view', 'side view', 'detail view', 'alternate view'];

    // Analyze each image individually
    const analyses = [];
    for(let i = 0; i < allImages.length; i++) {
      const label = angleLabels[i] || `angle ${i+1}`;
      const desc = await analyzeOneImage(allImages[i].base64, allImages[i].mimeType, label);
      if(desc) {
        analyses.push({ angle: label, desc });
        console.log(`[Claude vision] ${label}:`, desc.slice(0, 80) + '...');
      }
    }

    if(!analyses.length) throw new Error('No analyses returned');

    // If only one image, return its description directly
    if(analyses.length === 1) {
      return analyses[0].desc;
    }

    // Multiple images: ask Claude to combine them into a structured description
    // with front/back details clearly separated
    const combineBody = {
      model: CLAUDE_MODEL,
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: [{
          type: 'text',
          text: `I analyzed ${analyses.length} product photos of the SAME garment from different angles. Here are my observations:

${analyses.map(a => a.angle.toUpperCase() + ': ' + a.desc).join('\n\n')}

')}

Now combine these into ONE structured description for an AI image generator using EXACTLY this format:
"[garment base: type, color, fabric, length, silhouette, neckline, straps], front: [details ONLY visible from front], back: [details ONLY visible from back], accessories: [ALL accessories from ANY angle], feet: [feet/shoes status]"

Rules:
- NEVER put back-specific details in the front section or vice versa
- Include ALL accessories mentioned in any angle
- Max 150 words
- No model descriptions`,
        }],
      }],
    };

    const combineResp = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(combineBody),
    });

    const combineData = await combineResp.json();
    const combined = combineData?.content?.[0]?.text?.trim();
    if(!combined) throw new Error('No combined description');

    console.log('[Claude vision combined]', combined.slice(0, 120) + '...');
    return combined;

  } catch(err) {
    console.error('[Claude vision error]', err.message);
    return null;
  }
}

// Cache: base64 prefix → garment description (avoid re-analyzing same image)
const garmentCache = new Map();

async function getGarmentDescription(images) {
  if(!images?.length) return null;
  // Cache key = first 64 chars of ALL images combined
  const cacheKey = images.map(i=>i.base64.slice(0,32)).join('|');
  if(garmentCache.has(cacheKey)) {
    console.log('[Claude vision] cache hit');
    return garmentCache.get(cacheKey);
  }
  const desc = await analyzeGarment(images[0].base64, images[0].mimeType, images.slice(1));
  if(desc) {
    garmentCache.set(cacheKey, desc);
    if(garmentCache.size > 200) garmentCache.delete(garmentCache.keys().next().value);
  }
  return desc;
}


function buildPrompt(opts={}){
  const{
    userPrompt='', shotType='front', category='other',
    styleKey='', bgOption='ai', bgCustom='',
    gender='female', realism='ultra',
    modelDesc='', modelLocked=false,
    productNames=[], modelCount=1, multiModelDesc='',
    replaceModel=false,
  }=opts;

  const parts=[];

  // 1. GARMENT LOCK — always first, highest priority
  // This is the most important instruction — preserve the clothing exactly
  parts.push(GARMENT_LOCK);

  // 2. Shot angle — second priority so pose is respected
  parts.push(SHOT[shotType]||SHOT.front);

  // 3. Model identity
  if(modelLocked){
    parts.push('same model as the reference photo, identical face and hair');
  } else if(replaceModel){
    parts.push(modelDesc||GENDER[gender]||GENDER.female);
    parts.push('different person from the reference image');
  } else if(multiModelDesc){
    parts.push(multiModelDesc);
  } else if(modelDesc){
    parts.push(modelDesc);
  } else {
    parts.push(GENDER[gender]||GENDER.female);
  }

  // 4. Category — minimal, just enough for AI to understand the garment type
  if(modelCount>1 && productNames.length>1){
    parts.push(modelCount+' models each wearing different products: '+productNames.join(', '));
  } else {
    parts.push(CAT[category]||CAT.other);
  }

  // 5. User scene prompt (background/vibe)
  if(userPrompt) parts.push(userPrompt);

  // 6. Style
  if(styleKey && STYLE[styleKey]) parts.push(STYLE[styleKey]);

  // 7. Background
  const bg=bgOption==='custom'?bgCustom:(BG[bgOption]||'');
  if(bg) parts.push(bg);

  // 8. Quality
  parts.push(REAL[realism]||REAL.ultra);

  // Keep prompt tight — NB2 quality drops with long prompts
  const prompt=parts.filter(Boolean).join(', ');
  return prompt.length>420?prompt.slice(0,417)+'...':prompt;
}

function buildProductOnlyPrompt(opts={}){
  const{userPrompt='',shotType='alone_white',bgOption='white',bgCustom=''}=opts;
  const parts=[
    userPrompt||'professional product photography',
    SHOT[shotType]||SHOT.alone_white,
    bgOption==='custom'?bgCustom:(BG[bgOption]||BG.white),
    'no model, product only, commercial photography, ultra sharp',
  ];
  const p=parts.filter(Boolean).join(', ');
  return p.length>400?p.slice(0,397)+'...':p;
}

// ── Core generation ────────────────────────────────────────────────────────
async function generate(item,auth,modelAnchorUrls=[]){
  item.status='uploading';
  
  let imagesToUpload = item.productImages || [];
  
  // When replacing the model: send only the FIRST product image
  // Multiple angles = multiple faces = NB2 gets confused and blends them
  if(item.replaceModel && item.shotIndex === 0 && imagesToUpload.length > 1){
    imagesToUpload = [imagesToUpload[0]];
  }
  
  const productUrls=await Promise.all(
    imagesToUpload.map(img=>uploadToFal(img.base64,img.mimeType,auth))
  );
  // Product images first — define WHAT to wear
  // Model anchor after — define WHO wears it (or consistency reference)
  const allUrls=[...productUrls,...modelAnchorUrls];

  item.status='generating';
  const sub=await falQ('/fal-ai/nano-banana-2/edit',{
    prompt:item.prompt,
    image_urls:allUrls,
    num_images:1,
    aspect_ratio:toAR(item.aspectRatio||'3:4'),
    output_format:'jpeg',
    safety_tolerance:'4',
    resolution:item.resolution||'1K',
  },auth);

  if(!sub.request_id){
    const msg=Array.isArray(sub.detail)?sub.detail.map(d=>d.msg||d).join('; '):(sub.detail||sub.error||JSON.stringify(sub).slice(0,200));
    throw new Error('fal submit failed: '+msg);
  }
  item.requestId=sub.request_id;
  item.statusUrl=sub.status_url;
  item.responseUrl=sub.response_url;

  for(let i=0;i<150;i++){
    await new Promise(r=>setTimeout(r,3000));
    const sp=item.statusUrl?item.statusUrl.replace('https://queue.fal.run',''):`/fal-ai/nano-banana-2/edit/requests/${item.requestId}/status`;
    const st=await falGet(sp,auth);
    if(st.status==='COMPLETED'){
      const rp=item.responseUrl?item.responseUrl.replace('https://queue.fal.run',''):`/fal-ai/nano-banana-2/edit/requests/${item.requestId}`;
      const res=await falGet(rp,auth);
      const url=res?.images?.[0]?.url||res?.output?.images?.[0]?.url||res?.image?.url||res?.data?.images?.[0]?.url;
      if(!url)throw new Error('No image URL in result');
      return url;
    }
    if(st.status==='FAILED')throw new Error(st.error||st.detail||'Generation failed');
  }
  throw new Error('Timed out after 10 minutes');
}


// Build final NB2 prompt using Claude vision's precise garment description
function buildPromptWithGarment(item, garmentDesc){
  // Determine shot key once
  const shotKey = item.shotType || (item.shotLabel||'').toLowerCase().replace(' view','').replace(' ','_') || 'front';
  
  // Filter garment description to match shot angle
  // Removes opposite-angle details: front shot strips "back: [...]", back shot strips "front: [...]"
  let angleDesc = garmentDesc;
  if(shotKey === 'front' || shotKey === 'threeq') {
    angleDesc = garmentDesc.replace(/,?\s*back:\s*[^,]+(?:,|$)/gi, ' ').trim();
  } else if(shotKey === 'back') {
    angleDesc = garmentDesc.replace(/,?\s*front:\s*[^,]+(?:,|$)/gi, ' ').trim();
  }
  
  const parts = [];
  
  // 1. Hard lock — no inventions allowed
  parts.push('do not add, remove, or change any clothing item or accessory — reproduce only what is described below');
  // 2. Angle-specific garment description
  parts.push(angleDesc);
  
  // 3. Shot angle
  parts.push(SHOT[shotKey] || SHOT.front);
  
  // 3. Model identity
  if(item.modelLocked){
    // Shot 1+ consistency — use face from shot 0
    parts.push('same model as the reference photo, identical face and hair');
  } else if(item.replaceModel){
    // User wants a different model — ignore original product model completely
    const modelDesc = item.modelDescText || 'beautiful female model';
    parts.push(modelDesc + ', completely different person from the product reference image, ignore the person in the product photo');
  } else if(item.modelDescText){
    // User described a model in Step 2 — use that description
    // Also tell AI to ignore any person visible in the product reference
    parts.push(item.modelDescText + ', ignore any person visible in the product reference image, focus only on the clothing');
  } else {
    parts.push('beautiful female model');
  }

  // 4. Scene / background from user prompt
  if(item.userPrompt) parts.push(item.userPrompt);
  
  // 5. Background
  const bg = item.bgOption === 'custom' ? item.bgCustom : (BG[item.bgOption] || '');
  if(bg) parts.push(bg);
  
  // 6. Quality
  parts.push(REAL[item.realism] || REAL.ultra);

  const prompt = parts.filter(Boolean).join(', ');
  return prompt.length > 500 ? prompt.slice(0, 497) + '...' : prompt;
}



// GPT Image 2 uses image_size with specific enum values, not aspect_ratio
const GPT2_SIZE = {
  '1:1':  'square_hd',
  '4:5':  'portrait_4_3',   // closest to 4:5
  '3:4':  'portrait_4_3',
  '2:3':  'portrait_4_3',
  '9:16': 'portrait_16_9',
  '4:3':  'landscape_4_3',
  '3:2':  'landscape_4_3',
  '16:9': 'landscape_16_9',
  '21:9': 'landscape_16_9',
};
const toGPT2Size = ar => GPT2_SIZE[ar] || 'portrait_4_3';

// ── GPT Image 2 generation (via fal.ai) ───────────────────────────────────
async function generateGPT2(item, auth, modelAnchorUrls=[]) {
  item.status = 'uploading';

  // Upload product images
  let imagesToUpload = item.productImages || [];
  if(item.replaceModel && item.shotIndex === 0 && imagesToUpload.length > 1) {
    imagesToUpload = [imagesToUpload[0]];
  }
  const productUrls = await Promise.all(
    imagesToUpload.map(img => uploadToFal(img.base64, img.mimeType, auth))
  );

  const allUrls = [...productUrls, ...modelAnchorUrls];

  item.status = 'generating';

  // GPT Image 2 edit endpoint
  // Sanitize prompt for GPT2 — remove words that trigger content filters
  // "corset", "lace-up", "bodice" can get flagged even for normal fashion
  const safePrompt = item.prompt
    .replace(/corset/gi, 'structured waist')
    .replace(/lace-up/gi, 'ribbon-tied')
    .replace(/bodice/gi, 'fitted top')
    .replace(/plunging/gi, 'low')
    .replace(/revealing/gi, '')
    .replace(/exposed/gi, 'visible');

  const sub = await falQ('/openai/gpt-image-2/edit', {
    prompt: safePrompt,
    image_urls: allUrls,
    quality: item.gptQuality || 'medium',
    image_size: toGPT2Size(item.aspectRatio || '3:4'),
    content_moderation: 'permissive',
  }, auth);

  if(!sub.request_id) {
    const msg = Array.isArray(sub.detail)
      ? sub.detail.map(d => d.msg || d).join('; ')
      : (sub.detail || sub.error || JSON.stringify(sub).slice(0, 200));
    throw new Error('GPT Image 2 submit failed: ' + msg);
  }

  item.requestId   = sub.request_id;
  item.statusUrl   = sub.status_url;
  item.responseUrl = sub.response_url;

  for(let i = 0; i < 150; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const sp = item.statusUrl
      ? item.statusUrl.replace('https://queue.fal.run', '')
      : `/openai/gpt-image-2/edit/requests/${item.requestId}/status`;
    const st = await falGet(sp, auth);
    if(st.status === 'COMPLETED') {
      const rp = item.responseUrl
        ? item.responseUrl.replace('https://queue.fal.run', '')
        : `/openai/gpt-image-2/edit/requests/${item.requestId}`;
      const res = await falGet(rp, auth);
      // GPT Image 2 response: { images: [{ url: "..." }] }
      const url = res?.images?.[0]?.url
        || res?.output?.images?.[0]?.url
        || res?.image?.url
        || res?.data?.[0]?.url
        || res?.data?.images?.[0]?.url;
      if(!url){
        const errStr = JSON.stringify(res).slice(0,300);
        console.error('[GPT2 result]', errStr);
        throw new Error('GPT Image 2 returned no image. ' + errStr.slice(0,200));
      }
      return url;
    }
    if(st.status === 'FAILED') throw new Error(st.error || st.detail || 'GPT Image 2 generation failed');
  }
  throw new Error('GPT Image 2 timed out');
}


async function processItem(batchId,itemId,auth){
  const batch=jobs[batchId];if(!batch)return;
  const item=batch.items.find(i=>i.id===itemId);if(!item)return;
  try{

    // ── CLAUDE VISION: analyze garment on shot 0, reuse for shots 1+ ──────
    if(item.shotIndex===0 && batch.type!=='website' && item.productImages?.length){
      const garmentDesc = await getGarmentDescription(item.productImages);
      if(garmentDesc){
        // Store on the batch so all shots for this product reuse it
        if(!batch.garmentDescs) batch.garmentDescs = {};
        batch.garmentDescs[item.productKey] = garmentDesc;
        // Rebuild the prompt with the precise garment description
        item.prompt = buildPromptWithGarment(item, garmentDesc);
        console.log('[prompt rebuilt with Claude vision for', item.productName, ']');
      }
    } else if(item.shotIndex>0 && batch.garmentDescs?.[item.productKey]){
      // Shots 1+ reuse the garment description from shot 0
      item.prompt = buildPromptWithGarment(item, batch.garmentDescs[item.productKey]);
    }

    let modelAnchorUrls=[];
    if((item.savedModelUrls?.length||item.savedModelUrl)&&batch.type!=='website'){
      modelAnchorUrls=Array.isArray(item.savedModelUrls)&&item.savedModelUrls.length
        ?item.savedModelUrls:[item.savedModelUrl];
    } else if(item.shotIndex>0&&batch.type!=='website'){
      // Chain: shots 1+ wait for shot 0, use its result as face anchor
      const shot0=batch.items.find(i=>i.productKey===item.productKey&&i.shotIndex===0);
      if(shot0){
        item.status='waiting';
        for(let w=0;w<200;w++){
          if(shot0.status==='done'&&shot0.resultUrl)break;
          if(shot0.status==='error')break;
          await new Promise(r=>setTimeout(r,3000));
        }
        if(shot0.resultUrl){
          // Shot 0 succeeded — use its result as face anchor
          modelAnchorUrls=[shot0.resultUrl];
        } else if(shot0.status==='error'){
          // Shot 0 failed — generate this shot independently (no anchor)
          // This means face may differ slightly but at least we get an image
          console.log('[chain] Shot 0 failed, generating shot',item.shotIndex,'independently');
          modelAnchorUrls=[]; // no anchor, generate fresh
        }
      }
    }
    // Always use GPT Image 2 unless explicitly set to nb2
    let url;
    if(item.aiModel === 'nb2') {
      url = await generate(item, auth, modelAnchorUrls);
    } else {
      // Default: GPT Image 2
      url = await generateGPT2(item, auth, modelAnchorUrls);
    }
    item.resultUrl=url;item.status='done';
    batch.completedCount=(batch.completedCount||0)+1;
  }catch(err){
    item.status='error';item.error=err.message;
    batch.completedCount=(batch.completedCount||0)+1;
    console.error('['+itemId+']',err.message);
  }
}

function runBatch(batchId,auth,concurrency=5){
  const q=[...jobs[batchId].items.filter(i=>i.status==='queued')];
  const next=async()=>{const it=q.shift();if(!it)return;await processItem(batchId,it.id,auth);await next();};
  Promise.all(Array.from({length:Math.min(concurrency,q.length||1)},next))
    .then(()=>{if(jobs[batchId])jobs[batchId].status='done';});
}

// ── Batch create ───────────────────────────────────────────────────────────
app.post('/api/batch/create',async(req,res)=>{
  const auth=resolveAuth();
  const{type='model',products,globalPrompt,promptMode,category,styleKey,bgOption,bgCustom,
        gender,realism,resolution,aspectRatio,modelDesc,shots,savedModelUrl,
        aiModel='gpt2',gptQuality='medium',
        groupShot=false,groupShotModels=[],groupShotPrompt=''}=req.body;

  if(!products?.length)return res.status(400).json({error:'No products'});
  if(products.length>100)return res.status(400).json({error:'Max 100 products'});

  const batchId=uuidv4();const items=[];

  // GROUP SHOT
  if(groupShot){
    const allImages=products.flatMap(p=>p.images);
    const productNames=products.map(p=>p.name);
    const modelCount=groupShotModels.length||products.length;
    const multiDesc=groupShotModels.length
      ?groupShotModels.map((m,i)=>`Model ${i+1} (${m.name||'model'})`).join(', ')
      :`${modelCount} models`;
    const anchorUrls=groupShotModels.map(m=>m.imageUrl).filter(Boolean);
    const shotList=shots?.length?shots:[{shotType:'group',label:'Group Shot',bg:bgOption||'ai',bgCustom:bgCustom||'',aspectRatio:aspectRatio||'16:9'}];
    for(let si=0;si<shotList.length;si++){
      const shot=shotList[si];
      const prompt=buildPrompt({userPrompt:groupShotPrompt||globalPrompt||'',shotType:shot.shotType||'group',
        category,styleKey:shot.styleKey||styleKey||'',bgOption:shot.bg||bgOption||'ai',bgCustom:shot.bgCustom||bgCustom||'',
        gender,realism:realism||'ultra',modelDesc,productNames,modelCount,multiModelDesc:multiDesc});
      items.push({id:uuidv4(),name:`Group Shot${shotList.length>1?' — '+(shot.label||shot.shotType):''}`,
        productName:'Group Shot',productKey:'gs',shotLabel:shot.label||shot.shotType,shotIndex:si,
        savedModelUrl:anchorUrls[0]||savedModelUrl||null,savedModelUrls:anchorUrls,
        productImages:allImages,styleRefImages:[],prompt,
        aspectRatio:shot.aspectRatio||aspectRatio||'16:9',resolution:shot.resolution||resolution||'1K',
        replaceModel:false,status:'queued',requestId:null,resultUrl:null,error:null});
    }
    jobs[batchId]={type,status:'processing',created:Date.now(),completedCount:0,items};
    res.json({batchId,total:items.length});
    runBatch(batchId,auth,5);return;
  }

  // PER-PRODUCT
  for(let pi=0;pi<products.length;pi++){
    const prod=products[pi];
    const perPrompt=(promptMode==='individual'&&prod.prompt)?prod.prompt:(globalPrompt||'');
    const prodModelUrl=prod.savedModelUrl||savedModelUrl||null;
    const productKey=`p${pi}`;
    const productNames=prod.componentNames||[];
    const replaceModel=prod.replaceModel||false;
    const shotList=shots?.length?shots:[{shotType:'front',label:'Photo',bg:bgOption||'ai',bgCustom:bgCustom||'',aspectRatio:aspectRatio||'3:4'}];

    for(let si=0;si<shotList.length;si++){
      const shot=shotList[si];
      const iBg=shot.bg||bgOption||'ai';
      const iBgC=shot.bgCustom||bgCustom||'';
      const extra=shot.customPrompt?' '+shot.customPrompt:'';
      const modelLocked=si>0&&!prodModelUrl;
      const prompt=type==='website'
        ?buildProductOnlyPrompt({userPrompt:perPrompt+extra,shotType:shot.shotType||'alone_white',bgOption:iBg,bgCustom:iBgC})
        :buildPrompt({userPrompt:perPrompt+extra,shotType:shot.shotType||'front',
            category:prod.category||category||'other',styleKey:shot.styleKey||styleKey||'',
            bgOption:iBg,bgCustom:iBgC,gender:prod.gender||gender||'female',realism:realism||'ultra',
            modelDesc:prod.modelDesc||modelDesc||'',modelLocked,productNames,
            replaceModel:replaceModel&&si===0});  // only shot 0 replaces
      items.push({id:uuidv4(),
        name:shotList.length>1?`${prod.name} — ${shot.label||shot.shotType}`:prod.name,
        productName:prod.name,productKey,shotLabel:shot.label||shot.shotType,
        shotType:shot.shotType||'front',shotIndex:si,
        savedModelUrl:prodModelUrl,savedModelUrls:null,
        productImages:prod.images,styleRefImages:[],prompt,
        aspectRatio:shot.aspectRatio||aspectRatio||'3:4',resolution:shot.resolution||resolution||'1K',
        replaceModel,
        aiModel: aiModel || 'nb2',
        gptQuality: req.body.gptQuality || 'medium',
        // Extra fields for Claude-vision prompt rebuilding
        modelLocked:modelLocked,
        modelDescText:prod.modelDesc||modelDesc||'',  // includes hair/body desc from Step 2
        userPrompt:perPrompt+extra,
        bgOption:iBg, bgCustom:iBgC,
        realism:realism||'ultra',
        status:'queued',requestId:null,resultUrl:null,error:null});
    }
  }

  jobs[batchId]={type,status:'processing',created:Date.now(),completedCount:0,items};
  res.json({batchId,total:items.length});
  runBatch(batchId,auth,5);
});

app.get('/api/batch/:id/status',(req,res)=>{
  const b=jobs[req.params.id];if(!b)return res.status(404).json({error:'Not found'});
  res.json({status:b.status,type:b.type,total:b.items.length,completed:b.completedCount||0,
    items:b.items.map(({id,name,productName,shotLabel,shotIndex,productKey,status,resultUrl,error,aspectRatio})=>
      ({id,name,productName,shotLabel,shotIndex,productKey,status,resultUrl,error,aspectRatio}))});
});

app.post('/api/item/:bid/:iid/regenerate',async(req,res)=>{
  const auth=resolveAuth();
  const b=jobs[req.params.bid];if(!b)return res.status(404).json({error:'Not found'});
  const item=b.items.find(i=>i.id===req.params.iid);if(!item)return res.status(404).json({error:'Not found'});
  const{prompt,shotType,bgOption,bgCustom,resolution,aspectRatio}=req.body;
  if(prompt)item.prompt=b.type==='website'
    ?buildProductOnlyPrompt({userPrompt:prompt,shotType:shotType||'alone_white',bgOption:bgOption||'white',bgCustom:bgCustom||''})
    :buildPrompt({userPrompt:prompt,shotType:shotType||'front',bgOption:bgOption||'ai',bgCustom:bgCustom||''});
  if(resolution)item.resolution=resolution;
  if(aspectRatio)item.aspectRatio=aspectRatio;
  item.status='queued';item.resultUrl=null;item.error=null;
  res.json({ok:true});
  processItem(req.params.bid,item.id,auth);
});

app.post('/api/batch/:id/edit',async(req,res)=>{
  const auth=resolveAuth();
  const b=jobs[req.params.id];if(!b)return res.status(404).json({error:'Not found'});
  const{globalPrompt,bgOption,resolution}=req.body;
  b.completedCount=0;b.status='processing';
  b.items.forEach(it=>{
    if(globalPrompt)it.prompt=buildPrompt({userPrompt:globalPrompt,shotType:it.shotLabel||'front',bgOption:bgOption||'ai'});
    if(resolution)it.resolution=resolution;
    it.status='queued';it.resultUrl=null;it.error=null;
  });
  res.json({ok:true});
  runBatch(req.params.id,auth,5);
});

app.post('/api/item/:bid/:iid/upscale',async(req,res)=>{
  const auth=resolveAuth();
  const item=jobs[req.params.bid]?.items.find(i=>i.id===req.params.iid);
  if(!item?.resultUrl)return res.status(400).json({error:'No image'});
  try{
    const sub=await falQ('/fal-ai/aura-sr',{image_url:item.resultUrl,upscaling_factor:4},auth);
    if(!sub.request_id)throw new Error('Upscale submit failed');
    for(let i=0;i<60;i++){
      await new Promise(r=>setTimeout(r,3000));
      const s=await falGet(`/fal-ai/aura-sr/requests/${sub.request_id}/status`,auth);
      if(s.status==='COMPLETED'){const r=await falGet(`/fal-ai/aura-sr/requests/${sub.request_id}`,auth);const url=r.image?.url||r.images?.[0]?.url||r.output?.image?.url;if(url){item.resultUrl=url;return res.json({url});}}
      if(s.status==='FAILED')throw new Error('Upscale failed');
    }
    throw new Error('Upscale timed out');
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/batch/:id/zip',async(req,res)=>{
  const b=jobs[req.params.id];if(!b)return res.status(404).json({error:'Not found'});
  const done=b.items.filter(i=>i.resultUrl);if(!done.length)return res.status(400).json({error:'No images'});
  res.setHeader('Content-Type','application/zip');
  res.setHeader('Content-Disposition',`attachment; filename="fashion-ai-${req.params.id.slice(0,8)}.zip"`);
  const arc=archiver('zip',{zlib:{level:6}});arc.pipe(res);
  for(const it of done){try{const r=await fetch(it.resultUrl);arc.append(Buffer.from(await r.arrayBuffer()),{name:`${it.name.replace(/[^a-z0-9_\-]/gi,'_')}.jpg`});}catch(e){console.error('ZIP skip:',e.message);}}
  await arc.finalize();
});

// ── Library ────────────────────────────────────────────────────────────────
app.post('/api/models/save',(req,res)=>{const u=uid();const{name,imageUrl,description='',gender=''}=req.body;if(!name||!imageUrl)return res.status(400).json({error:'name+imageUrl required'});if(!MODELS[u])MODELS[u]={};const id='m'+Date.now();MODELS[u][id]={id,name,imageUrl,description,gender,created:Date.now()};saveStore('models',MODELS);res.json({ok:true,id});});
app.get('/api/models',(req,res)=>{const u=uid();res.json(Object.values(MODELS[u]||{}).sort((a,b)=>b.created-a.created));});
app.delete('/api/models/:id',(req,res)=>{const u=uid();delete MODELS[u]?.[req.params.id];saveStore('models',MODELS);res.json({ok:true});});

app.post('/api/backgrounds/save',(req,res)=>{const u=uid();const{name,bgOption,bgCustom='',description=''}=req.body;if(!name)return res.status(400).json({error:'name required'});if(!BGSAVED[u])BGSAVED[u]={};const id='bg'+Date.now();BGSAVED[u][id]={id,name,bgOption:bgOption||'custom',bgCustom,description,created:Date.now()};saveStore('bgsaved',BGSAVED);res.json({ok:true,id});});
app.get('/api/backgrounds',(req,res)=>{const u=uid();res.json(Object.values(BGSAVED[u]||{}).sort((a,b)=>b.created-a.created));});
app.delete('/api/backgrounds/:id',(req,res)=>{const u=uid();delete BGSAVED[u]?.[req.params.id];saveStore('bgsaved',BGSAVED);res.json({ok:true});});

app.post('/api/templates/save',(req,res)=>{const u=uid();const{name,...rest}=req.body;if(!name)return res.status(400).json({error:'name required'});if(!TEMPLATES[u])TEMPLATES[u]={};const id='t'+Date.now();TEMPLATES[u][id]={id,name,...rest,created:Date.now()};saveStore('templates',TEMPLATES);res.json({ok:true,id});});
app.get('/api/templates',(req,res)=>{const u=uid();res.json(Object.values(TEMPLATES[u]||{}).sort((a,b)=>b.created-a.created));});
app.delete('/api/templates/:id',(req,res)=>{const u=uid();delete TEMPLATES[u]?.[req.params.id];saveStore('templates',TEMPLATES);res.json({ok:true});});

app.get('/api/config',(req,res)=>res.json({hasServerKey:!!FAL_KEY_SERVER,version:'3.0'}));

// ── Model swap ─────────────────────────────────────────────────────────────
app.post('/api/item/swap-model',async(req,res)=>{
  const auth=resolveAuth();
  const{sourceImageUrl,sourceImageBase64,sourceImageMime,modelImageUrl,modelImageBase64,modelImageMime,
        modelDesc,gender='female',aspectRatio='3:4',resolution='1K',bgOption='ai',bgCustom=''}=req.body;
  try{
    const srcUrl=sourceImageUrl||await uploadToFal(sourceImageBase64,sourceImageMime||'image/jpeg',auth);
    const modelUrl=modelImageUrl||(modelImageBase64?await uploadToFal(modelImageBase64,modelImageMime||'image/jpeg',auth):null);
    const bgHint=bgOption==='custom'?bgCustom:(BG[bgOption]||'');
    const modelHint=modelUrl?'same model as the reference photo, identical face and hair':(modelDesc||(GENDER[gender]||GENDER.female));
    const prompt=[modelHint,'wearing the exact same clothing and products from the source image','keep all garments colors and styling identical, only replace the model',bgHint||'same background','hyperrealistic photograph, professional fashion photography'].filter(Boolean).join(', ');
    const imageUrls=modelUrl?[modelUrl,srcUrl]:[srcUrl];
    const sub=await falQ('/fal-ai/nano-banana-2/edit',{prompt,image_urls:imageUrls,num_images:1,aspect_ratio:toAR(aspectRatio),output_format:'jpeg',safety_tolerance:'4',resolution},auth);
    if(!sub.request_id)throw new Error(sub.detail||sub.error||'Submit failed');
    for(let i=0;i<60;i++){
      await new Promise(r=>setTimeout(r,4000));
      const sp=sub.status_url?sub.status_url.replace('https://queue.fal.run',''):`/fal-ai/nano-banana-2/edit/requests/${sub.request_id}/status`;
      const st=await falGet(sp,auth);
      if(st.status==='COMPLETED'){const rp=sub.response_url?sub.response_url.replace('https://queue.fal.run',''):`/fal-ai/nano-banana-2/edit/requests/${sub.request_id}`;const result=await falGet(rp,auth);const url=result?.images?.[0]?.url||result?.output?.images?.[0]?.url||result?.image?.url;if(url)return res.json({url});return res.status(500).json({error:'No image URL'});}
      if(st.status==='FAILED')return res.status(500).json({error:st.error||'Failed'});
    }
    res.status(500).json({error:'Timed out'});
  }catch(e){res.status(500).json({error:e.message});}
});

// ── Video ──────────────────────────────────────────────────────────────────
if(!global.videoJobs)global.videoJobs={};
app.post('/api/video/create',async(req,res)=>{
  const auth=resolveAuth();
  const{clips}=req.body;if(!clips?.length)return res.status(400).json({error:'No clips'});
  const jobId=uuidv4();
  global.videoJobs[jobId]={status:'processing',created:Date.now(),completedCount:0,
    clips:clips.map(c=>({...c,status:'queued',resultUrl:null,error:null,requestId:null}))};
  res.json({jobId,total:clips.length});
  const job=global.videoJobs[jobId];const queue=[...job.clips];
  const next=async()=>{
    const clip=queue.shift();if(!clip)return;
    try{
      clip.status='generating';
      let imageUrl=clip.imageUrl;
      if(!imageUrl&&clip.imageBase64&&clip.imageMime)imageUrl=await uploadToFal(clip.imageBase64,clip.imageMime,auth);
      if(!imageUrl)throw new Error('No image for clip');
      let sub=await falQ('/fal-ai/kling-video/v3/pro/image-to-video',{image_url:imageUrl,prompt:clip.prompt||'fashion model, smooth natural movement, cinematic',duration:clip.duration||'5',aspect_ratio:clip.aspectRatio||'9:16'},auth);
      if(!sub.request_id){sub=await falQ('/fal-ai/kling-video/v1.6/pro/image-to-video',{image_url:imageUrl,prompt:clip.prompt||'fashion model, smooth movement',duration:clip.duration||'5',aspect_ratio:clip.aspectRatio||'9:16'},auth);if(!sub.request_id)throw new Error(sub.detail||sub.error||'Video submit failed');}
      clip.requestId=sub.request_id;clip.statusUrl=sub.status_url;clip.responseUrl=sub.response_url;
      for(let i=0;i<180;i++){
        await new Promise(r=>setTimeout(r,5000));
        const sp=clip.statusUrl?clip.statusUrl.replace('https://queue.fal.run',''):`/fal-ai/kling-video/v3/pro/image-to-video/requests/${clip.requestId}/status`;
        const st=await falGet(sp,auth);
        if(st.status==='COMPLETED'){const rp=clip.responseUrl?clip.responseUrl.replace('https://queue.fal.run',''):`/fal-ai/kling-video/v3/pro/image-to-video/requests/${clip.requestId}`;const result=await falGet(rp,auth);const url=result?.video?.url||result?.output?.video?.url||result?.videos?.[0]?.url;if(!url)throw new Error('No video URL');clip.resultUrl=url;clip.status='done';break;}
        if(st.status==='FAILED')throw new Error(st.error||'Video generation failed');
      }
      if(!clip.resultUrl)throw new Error('Video timed out');
    }catch(err){clip.status='error';clip.error=err.message;console.error('[video]',err.message);}
    job.completedCount++;if(job.completedCount>=job.clips.length)job.status='done';
    await next();
  };
  Promise.all([next(),next()]);
});

app.get('/api/video/:id/status',(req,res)=>{
  const job=global.videoJobs?.[req.params.id];if(!job)return res.status(404).json({error:'Not found'});
  res.json({status:job.status,total:job.clips.length,completed:job.completedCount,
    clips:job.clips.map(({id,prompt,status,resultUrl,error,aspectRatio,duration})=>({id,prompt,status,resultUrl,error,aspectRatio,duration}))});
});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT,()=>console.log('\n✅ Fashion AI → http://localhost:'+PORT+'\n'));
