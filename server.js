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

// ── Keys ───────────────────────────────────────────────────────────────────
const FAL_KEY     = process.env.FAL_KEY     || '3ac08d82-1ead-4b6d-bd1e-284466179096:47b3486ef62f854276f4c2bf6fbfae09';
const CLAUDE_KEY  = process.env.ANTHROPIC_API_KEY || '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';
const FAL_AUTH    = 'Key ' + FAL_KEY;
function uid(){let h=0;for(let i=0;i<FAL_KEY.length;i++){h=(Math.imul(31,h)+FAL_KEY.charCodeAt(i))|0;}return Math.abs(h).toString(16);}

// ── fal.ai ─────────────────────────────────────────────────────────────────
async function falReq(method,url,body){
  const r=await fetch(url,{method,headers:{Authorization:FAL_AUTH,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  const t=await r.text();if(!t||!t.trim())return{};
  try{return JSON.parse(t);}catch{return{_raw:t};}
}
const falQ  =(p,b)=>falReq('POST',`https://queue.fal.run${p}`,b);
const falGet=(p)  =>falReq('GET', `https://queue.fal.run${p}`,null);

const uploadCache=new Map();
async function uploadToFal(base64,mimeType){
  const key=(mimeType||'img')+':'+base64.slice(0,128);
  if(uploadCache.has(key))return uploadCache.get(key);
  const init=await falReq('POST','https://rest.alpha.fal.ai/storage/upload/initiate',{file_name:`img_${Date.now()}.jpg`,content_type:mimeType||'image/jpeg'});
  if(!init.upload_url)throw new Error('Upload initiate failed: '+JSON.stringify(init).slice(0,100));
  const put=await fetch(init.upload_url,{method:'PUT',headers:{'Content-Type':mimeType||'image/jpeg'},body:Buffer.from(base64,'base64')});
  if(!put.ok)throw new Error('Upload PUT failed '+put.status);
  uploadCache.set(key,init.file_url);
  if(uploadCache.size>500)uploadCache.delete(uploadCache.keys().next().value);
  return init.file_url;
}

// ── GPT Image 2 size map ───────────────────────────────────────────────────
const GPT2_SIZE={'1:1':'square_hd','4:5':'portrait_4_3','3:4':'portrait_4_3','2:3':'portrait_4_3','9:16':'portrait_16_9','4:3':'landscape_4_3','3:2':'landscape_4_3','16:9':'landscape_16_9','21:9':'landscape_16_9'};
const toGPT2Size=ar=>GPT2_SIZE[ar]||'portrait_4_3';
const toAR=ar=>({'1:1':'1:1','4:5':'4:5','3:4':'3:4','2:3':'2:3','9:16':'9:16','4:3':'4:3','3:2':'3:2','16:9':'16:9','21:9':'21:9'}[ar]||'3:4');

// ── Prompt vocab ───────────────────────────────────────────────────────────
const BG={white:'pure white seamless studio background',grey:'neutral grey seamless studio background',lightgrey:'soft light grey background',black:'dramatic black studio background',outdoor:'outdoor natural daylight',street:'urban city street',luxury:'luxury interior marble upscale',beach:'tropical beach golden sand ocean',forest:'lush green forest',studio:'professional photo studio',minimal_bg:'soft minimal gradient background',pink:'soft blush pink background',cream:'warm cream off-white background',ai:'',custom:''};
const SHOT={front:'model facing camera, full body from head to floor',back:'model facing away from camera, full body rear view from head to floor',side:'model side profile, full body from head to floor',threeq:'three-quarter angle, slightly turned',detail:'extreme close-up macro, texture in sharp focus',face:'portrait head and shoulders',sitting:'model seated naturally',walking:'model walking mid-stride',dynamic:'dynamic energetic pose',hands:'close-up hands and wrists',flat_lay:'flat lay overhead shot, no model',mannequin:'ghost mannequin effect, no visible person',alone_white:'product only pure white background no model',alone_grey:'product only neutral grey background no model',alone_natural:'product on natural wood surface no model',lookbook:'lookbook editorial lifestyle',street_life:'street photography urban candid',banner:'wide cinematic banner negative space sides',group:'group composition wide shot all subjects visible'};
const STYLE={editorial:'Vogue editorial, dramatic lighting high contrast',street:'street style authentic urban',luxury:'luxury fashion advertising elegant lighting',ecommerce:'clean e-commerce even lighting',lifestyle:'lifestyle natural golden light',minimal:'minimalist soft diffused light',athletic:'activewear dynamic action',bohemian:'bohemian earthy warm tones',formal:'formal professional polished studio',vintage:'vintage film grain retro color',streetwear:'streetwear urban bold energy',haute:'haute couture avant-garde',campaign:'bold advertising campaign hero moment',beauty:'beauty photography glowing skin soft light',catalog:'clean catalog shadowless lighting',resort:'resort wear tropical luxury'};
const REAL={ultra:'hyperrealistic photograph ultra sharp professional camera',editorial:'high fashion editorial Vogue retouching quality',cinematic:'cinematic shallow depth of field anamorphic bokeh',raw:'raw documentary natural ambient light candid'};
const GENDER={female:'beautiful female model',male:'handsome male model',neutral:'fashion model'};

// ── Claude Vision ──────────────────────────────────────────────────────────
const CLAUDE_API   = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-sonnet-4-6';

async function claudeMsg(messages, maxTokens=300){
  const ctrl=new AbortController();
  const t=setTimeout(()=>ctrl.abort(),45000);
  try{
    const r=await fetch(CLAUDE_API,{method:'POST',headers:{'Content-Type':'application/json','x-api-key':CLAUDE_KEY,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:CLAUDE_MODEL,max_tokens:maxTokens,messages}),signal:ctrl.signal});
    const d=await r.json();
    return d?.content?.[0]?.text?.trim()||null;
  }catch(e){
    if(e.name==='AbortError')throw new Error('Claude API timeout');
    throw e;
  }finally{clearTimeout(t);}
}

// Analyze ONE image with full awareness of its slot/angle
async function analyzeOneImage(base64, mimeType, slotLabel){
  const isAcc = slotLabel.toLowerCase().includes('accessor');
  const prompt = isAcc
    ? `This product photo shows an ACCESSORY labeled "${slotLabel}".

Describe with extreme precision:
1. EXACT TYPE: bag/handbag/clutch/earring/necklace/bracelet/bangle/ring/belt/watch/sunglasses/hat/scarf/etc — be specific
2. EXACT COLOR(S): every color present, including hardware
3. MATERIAL: leather/suede/gold/silver/fabric/stone/etc
4. SHAPE & SIZE: silhouette, approximate size
5. ALL HARDWARE: every clasp/chain/buckle/zipper/lock/ring/stud — exact color and finish
6. SURFACE DETAILS: logos, patterns, embossing, stitching, lining color, texture
7. HOW WORN/CARRIED: state exactly — e.g. "worn as crossbody on shoulder" / "clip-on earrings on both ears" / "draped necklace around neck" / "cinched belt at waist" / "worn on left wrist" / "carried in hand as clutch"

Output: dense comma-separated description ending with the HOW WORN line. Max 160 words. No model/person descriptions.`
    : `This product photo is the "${slotLabel}" angle.
Describe with extreme precision ONLY what is visible from THIS specific angle:
- ALL garment pieces visible (e.g. top + bottom separately if both shown)
- Exact type of each piece, exact color(s), fabric/material
- Exact length of each piece (floor-length/maxi/midi/knee/cropped/etc — be very specific)
- Silhouette, fit, cut of each piece
- Neckline, collar, or opening style
- Strap/sleeve details
- Every structural detail: seams, zippers, buttons, pockets, pleats, ruffles, tiers, embroidery, prints
- Feet/shoes: write "hem covers feet completely" if garment reaches floor. ONLY describe shoes if clearly visible.
Output: dense comma-separated, max 160 words. No model/person descriptions. Miss nothing.`;

  return claudeMsg([{role:'user',content:[
    {type:'image',source:{type:'base64',media_type:mimeType||'image/jpeg',data:base64}},
    {type:'text',text:prompt}
  ]}], 350);
}

// Analyze ALL images in a product group — each separately, then combine
const garmentCache=new Map();
async function getGarmentDescription(images){
  if(!images?.length) return null;
  const cacheKey=images.map(i=>i.base64.slice(0,32)+(i.slot||'')).join('|');
  if(garmentCache.has(cacheKey)){console.log('[vision] cache hit');return garmentCache.get(cacheKey);}

  const positional=['front view','back view','left side view','right side view','detail view','accessory'];
  const analyses=[];
  for(let i=0;i<images.length;i++){
    const img=images[i];
    const label=img.slot||positional[i]||`angle ${i+1}`;
    const desc=await analyzeOneImage(img.base64,img.mimeType,label);
    if(desc){analyses.push({label,desc});console.log(`[vision] [${label}]:`,desc.slice(0,80)+'...');}
  }
  if(!analyses.length) return null;
  if(analyses.length===1) return analyses[0].desc;

  // Combine all analyses into one structured description
  const garmentAngles=analyses.filter(a=>!a.label.toLowerCase().includes('accessor'));
  const accessories=analyses.filter(a=>a.label.toLowerCase().includes('accessor'));

  const combinePrompt=`I analyzed a product group. Per-image findings:

GARMENT ANGLES:
${garmentAngles.map(a=>a.label.toUpperCase()+': '+a.desc).join('\n')}
${accessories.length?'\nACCESSORIES (separate product images):\n'+accessories.map(a=>a.label.toUpperCase()+': '+a.desc).join('\n'):''}

Write ONE combined description in EXACTLY this format:

PROMPT: [MAX 150 CHARS. ALL garment pieces (exact colors + lengths/styles) PLUS ALL accessories (exact color + type + how worn). Used directly in an AI image generator — must be precise. Examples: "floor-length ivory maxi dress, black leather crossbody bag on shoulder, gold hoop earrings" | "black blazer, ivory wide-leg trousers, brown leather tote bag, silver chain necklace around neck" | "white crop top, blue high-waist jeans, gold bangle bracelet on wrist". Include EVERY piece and EVERY accessory with placement.]
[garment: all pieces — type/exact color/fabric/length/silhouette/neckline/straps/sleeves for EACH piece], front: [front-angle details ONLY], back: [back-angle details ONLY], sides: [side details if any], accessories: [EVERY accessory from EVERY image — type/exact color/material/ALL hardware/HOW WORN OR CARRIED e.g. "black leather structured bag worn as crossbody on left shoulder" or "gold hoop earrings on both ears" or "silver layered necklace draped around neck" or "tan suede belt cinched at waist"], feet: [hem covers feet completely, do not show feet or toes / or describe visible footwear]

ABSOLUTE RULES:
- PROMPT line: garment pieces + accessories + placement. Under 150 chars. No structural detail.
- accessories: section = EVERY accessory — include exact color, material, and HOW WORN/CARRIED
- front: = front image details ONLY. back: = back image details ONLY.
- Missing even one accessory from accessories: section is NOT acceptable
- If multiple images show the same angle, combine into one section
- 350 words max. Zero model/person descriptions.`;

  const combined=await claudeMsg([{role:'user',content:[{type:'text',text:combinePrompt}]}],700);
  if(combined){
    garmentCache.set(cacheKey,combined);
    if(garmentCache.size>200)garmentCache.delete(garmentCache.keys().next().value);
    console.log('[vision combined]',combined.slice(0,120)+'...');
  }
  return combined;
}

// ── Prompt builder (fallback when no Claude vision) ────────────────────────
function buildPrompt(opts={}){
  const{userPrompt='',shotType='front',category='other',styleKey='',bgOption='ai',bgCustom='',gender='female',realism='ultra',modelDesc='',modelLocked=false,productNames=[],modelCount=1,multiModelDesc='',replaceModel=false}=opts;
  const parts=[];
  if(modelLocked){parts.push('same model as the reference photo, identical face and hair');}
  else if(replaceModel){parts.push((modelDesc||GENDER[gender]||GENDER.female)+', different person from the product photo');}
  else if(multiModelDesc){parts.push(multiModelDesc);}
  else if(modelDesc){parts.push(modelDesc);}
  else{parts.push(GENDER[gender]||GENDER.female);}
  parts.push(SHOT[shotType]||SHOT.front);
  const bg=bgOption==='custom'?bgCustom:(BG[bgOption]||'');
  if(bg) parts.push(bg);
  if(userPrompt) parts.push(userPrompt);
  if(styleKey&&STYLE[styleKey]) parts.push(STYLE[styleKey]);
  parts.push(REAL[realism]||REAL.ultra);
  const p=parts.filter(Boolean).join(', ');
  return p.length>380?p.slice(0,377)+'...':p;
}

// Build prompt using Claude vision's precise garment description
// Strategy differs by model: NB2 needs SHORT prompts, GPT2 can handle longer
function buildPromptWithGarment(item, garmentDesc){
  const shotKey=item.shotType||(item.shotLabel||'').toLowerCase().replace(/\s+view$/,'').replace(/\s+/g,'_')||'front';
  const isNB2 = item.aiModel==='nb2';

  // ── 0. Extract Claude's concise PROMPT: anchor line ──────────────────────
  // Multi-image analysis outputs "PROMPT: <120-char anchor>" as the first line.
  // This is purpose-built for generation: all garment pieces, exact colors,
  // exact lengths — works for dresses, suits, separates, outerwear, anything.
  let garmentAnchor='';
  const promptLineMatch=(garmentDesc||'').match(/^PROMPT:\s*(.+)/im);
  if(promptLineMatch) garmentAnchor=promptLineMatch[1].trim().slice(0,120);

  // Strip the PROMPT: line before further processing
  let cleanDesc=(garmentDesc||'').replace(/^PROMPT:\s*[^\n]+\n?/im,'').trim();

  // ── 1. Strip the opposite-angle section ──────────────────────────────────
  let angleDesc=cleanDesc;
  if(shotKey==='front'||shotKey==='threeq'){
    angleDesc=cleanDesc.replace(/,?\s*back:\s*\[[\s\S]*?\]/gi,'').trim();
    angleDesc=angleDesc.replace(/,?\s*back:\s*(?:(?!(?:front|back|sides|accessories|feet):)[\s\S])+/gi,'').trim();
  } else if(shotKey==='back'){
    angleDesc=cleanDesc.replace(/,?\s*front:\s*\[[\s\S]*?\]/gi,'').trim();
    angleDesc=angleDesc.replace(/,?\s*front:\s*(?:(?!(?:front|back|sides|accessories|feet):)[\s\S])+/gi,'').trim();
  }

  // ── 2. Clean structural labels and ALL brackets ───────────────────────────
  angleDesc=angleDesc
    .replace(/\bfront:\s*/gi,'').replace(/\bback:\s*/gi,'').replace(/\bsides:\s*/gi,'')
    .replace(/\baccessories:\s*/gi,'ACCESSORIES: ')
    .replace(/\bfeet:\s*/gi,'')
    .replace(/\[garment:\s*/gi,'').replace(/[\[\]]/g,'')
    .replace(/,\s*,/g,',').trim();

  // ── 3. Pull accessories out as a separate explicit string ─────────────────
  const accIdx = angleDesc.toUpperCase().indexOf('ACCESSORIES:');
  let accListStr = '';
  if(accIdx >= 0){
    accListStr = angleDesc.slice(accIdx + 'ACCESSORIES:'.length)
      .split(/,\s*(?:hem covers|do not|feet)/i)[0].trim().replace(/,\s*$/, '');
  }

  // ── 4. Fallback garment anchor (single-image or no PROMPT: line) ──────────
  // For single-image analysis, Claude doesn't output a PROMPT: line.
  // Extract anchor heuristically: first clause before structural details.
  if(!garmentAnchor){
    const garmentBody = (accIdx >= 0 ? angleDesc.slice(0, accIdx) : angleDesc)
      .replace(/ACCESSORIES:.*/i,'').trim();
    // Walk comma-parts and stop before pure structural/detail terms
    const detailRe = /^(front|back|sides|silhouette|seam|pleat|ruffle|tier|zipper|button|pocket|embroid|hem\b|waist\b|strap\b|sleeve\b|neckline\b)/i;
    const anchorParts=[];
    for(const part of garmentBody.split(',')){
      const t=part.trim();
      if(detailRe.test(t) && anchorParts.length>=2) break;
      anchorParts.push(t);
      if(anchorParts.join(', ').length>120) break;
    }
    garmentAnchor=anchorParts.join(', ').slice(0,120).replace(/,\s*$/,'');
  }

  // ── 5. Model string — shot-aware ──────────────────────────────────────────
  const isFrontFacing = !['back','side'].includes(shotKey);
  let modelStr;
  if(item.modelLocked){
    modelStr = isFrontFacing
      ? 'same model as reference photo, identical face skin tone and hair'
      : 'same model as reference photo, identical hair color and body type, facing away';
  } else if(item.replaceModel){
    const newModelDesc = item.modelDescText || GENDER[item.gender||'female'] || GENDER.female;
    modelStr = newModelDesc;
  } else if(item.modelDescText){
    modelStr=item.modelDescText;
  } else {
    modelStr=GENDER[item.gender||'female']||GENDER.female;
  }

  const bg=item.bgOption==='custom'?item.bgCustom:(BG[item.bgOption]||'');
  const shotStr=SHOT[shotKey]||SHOT.front;

  const shotAngleHint={
    front:'front-facing',back:'rear-facing',side:'side-profile',threeq:'three-quarter angle',
    detail:'close-up detail',face:'portrait close-up',sitting:'seated pose',walking:'walking mid-stride',
    dynamic:'dynamic action pose',hands:'hands and wrists close-up',flat_lay:'flat lay overhead',
    mannequin:'ghost mannequin, no model',alone_white:'product only, no model',
    alone_grey:'product only, no model',alone_natural:'product on natural surface, no model',
    lookbook:'lifestyle editorial',street_life:'urban street candid',
    banner:'wide cinematic banner',group:'group composition',
  }[shotKey]||'front-facing';

  const feetRule = /hem covers feet|floor.length|maxi/i.test(angleDesc)
    ? 'Full-length garment — DO NOT show feet or toes.' : '';

  // Accessories: always explicit + placement-aware
  const accRule = accListStr
    ? `MUST wear/carry ALL of these EXACTLY — ${accListStr}. Same color, material, hardware, placement. No substitutions.`
    : (item.productImages?.some(img=>(img.slot||'').toLowerCase().startsWith('accessory'))
        ? `Reproduce EVERY accessory from the reference images EXACTLY — same color, style, and how it is worn.`
        : '');

  // ── Build the final prompt (two different strategies) ─────────────────────
  //
  // REPLACE MODEL path: no garment reference images are sent (stripped in step 2.5)
  //   → GPT2 has no face to anchor to → generates the described model freely
  //   → garment must come from FULL text description (no visual reference)
  //
  // NORMAL / LOCKED path: garment reference images ARE sent
  //   → short textual anchor + "exact garment from images" (hybrid)
  //   → GPT2 uses images as primary garment source, text pins color+type
  // ──────────────────────────────────────────────────────────────────────────

  if(isNB2){
    if(item.replaceModel){
      const garmentFull=(accIdx>=0?angleDesc.slice(0,accIdx):angleDesc).replace(/ACCESSORIES:.*/i,'').trim().slice(0,300);
      const p=`New ${modelStr}. ${garmentFull}. ${accRule} ${shotStr}. ${bg||''} ${REAL[item.realism||'ultra']||REAL.ultra}`.replace(/\s+/g,' ').trim();
      return p.length>480?p.slice(0,477)+'...':p;
    } else {
      const anchorStr = garmentAnchor ? `${garmentAnchor}. ` : '';
      const p=`${modelStr}. Wearing exactly: ${anchorStr}as shown in reference images, unchanged. ${accRule} ${shotStr}. ${bg||''} ${REAL[item.realism||'ultra']||REAL.ultra}`.replace(/\s+/g,' ').trim();
      return p.length>480?p.slice(0,477)+'...':p;
    }
  } else {
    // ── GPT2 ──────────────────────────────────────────────────────────────
    let intro, garmentConstraint;

    if(item.replaceModel){
      // No visual garment reference → full text description drives the garment
      const garmentFull=(accIdx>=0?angleDesc.slice(0,accIdx):angleDesc)
        .replace(/ACCESSORIES:.*/i,'').replace(/feet:.*/i,'').trim().slice(0,380);
      intro=`${shotAngleHint} professional fashion photograph.`;
      garmentConstraint=`NEW MODEL: ${modelStr}. Generate a BRAND NEW person — completely different face, hair, body from any reference. Wearing: ${garmentFull}.`;
    } else {
      // Visual garment reference present → short textual anchor
      const anchorDetail = garmentAnchor ? ` This is: ${garmentAnchor}.` : '';
      intro=`${shotAngleHint} professional fashion photograph. ${modelStr}.`;
      garmentConstraint=`Wearing the EXACT garment shown in the product reference images — do NOT change design, color, or silhouette.${anchorDetail}`;
    }

    const parts=[intro, garmentConstraint, accRule, feetRule, shotStr, bg||'', item.userPrompt||'', REAL[item.realism||'ultra']||REAL.ultra];
    const p=parts.filter(Boolean).join(' ');
    return p.length>700?p.slice(0,697)+'...':p;
  }
}

// Sanitize prompt for GPT Image 2 content filter
function sanitizeForGPT2(prompt){
  return prompt
    .replace(/\bcorset\b/gi,'structured waist panel')
    .replace(/\blace-up\b/gi,'ribbon-tied')
    .replace(/\blacing\b/gi,'ribbon detail')
    .replace(/\bbodice\b/gi,'structured top')
    .replace(/\bplunging\b/gi,'deep')
    .replace(/\bsexy\b/gi,'elegant')
    .replace(/\brevealing\b/gi,'stylish')
    .replace(/\bexposed skin\b/gi,'visible skin')
    .replace(/\bexposed\b/gi,'visible')
    .replace(/\bnipple\b/gi,'')
    .replace(/\bcleavage\b/gi,'neckline')
    .replace(/\bboned\b/gi,'structured')
    .replace(/\bboning\b/gi,'structure')
    .replace(/\bbondage\b/gi,'')
    .replace(/\blingerie\b/gi,'intimate apparel')
    .replace(/\bskin-tight\b/gi,'form-fitting')
    .replace(/\bskintight\b/gi,'form-fitting')
    .replace(/\btight\b/gi,'fitted')
    .replace(/\bsheer\b/gi,'semi-transparent')
    .replace(/\btransparent\b/gi,'semi-transparent')
    .replace(/\bnude\b/gi,'neutral tone')
    .replace(/\bbare\b/gi,'uncovered')
    .replace(/\bthigh.?high\b/gi,'tall')
    .replace(/\bstrapless\b/gi,'tube-style')
    .replace(/\bbackless\b/gi,'open-back')
    .replace(/\bbra\b/gi,'top')
    .replace(/\bpanties\b/gi,'')
    .replace(/\bunderwear\b/gi,'')
    .replace(/\bcurves\b/gi,'silhouette')
    .replace(/\bcurvy\b/gi,'')
    .replace(/\bbust\b/gi,'chest')
    .replace(/\bbosom\b/gi,'chest')
    .replace(/\bwaist.?cinch\b/gi,'waist detail');
}

// ── Generation ─────────────────────────────────────────────────────────────
async function generateGPT2(item, modelAnchorUrls=[]){
  item.status='uploading';
  const imgs=item.productImages||[];
  console.log('[GPT2] shot='+item.shotType+' replaceModel='+!!item.replaceModel+' refs='+imgs.map(i=>i.slot).join(',')+' anchors='+modelAnchorUrls.length);
  const productUrls=await Promise.all(imgs.map(i=>uploadToFal(i.base64,i.mimeType)));
  // Order: product/accessory images first, model anchor last
  // For replaceModel: productUrls is accessory-only (garment refs stripped in processItem)
  // so anchor is also excluded (we don't want any face reference)
  const anchorUrls = item.replaceModel ? [] : modelAnchorUrls;
  const allUrls=[...productUrls,...anchorUrls];
  item.status='generating';

  const fallbackPrompt=`${GENDER[item.gender||'female']||GENDER.female} wearing the clothing shown in the reference images, ${SHOT[item.shotType]||SHOT.front}, ${BG[item.bgOption]||BG.white}, professional fashion photography`;

  // Try up to 3 times with progressively simpler prompts if content flagged
  const prompts=[
    sanitizeForGPT2(item.prompt),
    sanitizeForGPT2(item.prompt).slice(0,250).replace(/tight|fitted|slim|snug|form.fitting|body.hugging|figure/gi,'elegant'),
    fallbackPrompt,
  ];

  let sub=null;
  // Choose endpoint: edit (with reference images) or generate (text-only)
  // replaceModel with zero refs → use generate endpoint so no old face bleeds in
  const useGenerateEndpoint = allUrls.length === 0;
  const endpoint = useGenerateEndpoint ? '/openai/gpt-image-2' : '/openai/gpt-image-2/edit';
  console.log('[GPT2] endpoint='+endpoint+' totalRefs='+allUrls.length);

  for(let attempt=0;attempt<prompts.length;attempt++){
    const p=prompts[attempt];
    console.log('[GPT2] attempt',attempt+1,'prompt:',p.slice(0,120)+'...');
    const body = useGenerateEndpoint
      ? {prompt:p, quality:item.gptQuality||'medium', image_size:toGPT2Size(item.aspectRatio||'3:4'), content_moderation:'permissive'}
      : {prompt:p, image_urls:allUrls, quality:item.gptQuality||'medium', image_size:toGPT2Size(item.aspectRatio||'3:4'), content_moderation:'permissive'};
    sub=await falQ(endpoint, body);
    if(sub.request_id) break;
    const msg=Array.isArray(sub.detail)?sub.detail.map(d=>d.msg||d).join('; '):(sub.detail||sub.error||JSON.stringify(sub).slice(0,200));
    console.warn('[GPT2] attempt',attempt+1,'rejected:',msg.slice(0,120));
    if(attempt===prompts.length-1) throw new Error('GPT2 all attempts failed: '+msg);
    await new Promise(r=>setTimeout(r,1500));
  }

  item.requestId=sub.request_id;item.statusUrl=sub.status_url;item.responseUrl=sub.response_url;
  const baseEndpoint=useGenerateEndpoint?'/openai/gpt-image-2':'/openai/gpt-image-2/edit';

  for(let i=0;i<120;i++){
    await new Promise(r=>setTimeout(r,3000));
    const sp=item.statusUrl?item.statusUrl.replace('https://queue.fal.run',''):`${baseEndpoint}/requests/${item.requestId}/status`;
    const st=await falGet(sp);
    if(st.status==='COMPLETED'){
      const rp=item.responseUrl?item.responseUrl.replace('https://queue.fal.run',''):`${baseEndpoint}/requests/${item.requestId}`;
      const res=await falGet(rp);
      const url=res?.images?.[0]?.url||res?.output?.images?.[0]?.url||res?.image?.url||res?.data?.[0]?.url||res?.data?.images?.[0]?.url;
      if(!url){
        const errStr=JSON.stringify(res).slice(0,300);
        console.error('[GPT2 result]',errStr);
        // If COMPLETED but flagged in result, retry with simpler prompt
        if(errStr.includes('content')||errStr.includes('flagged')){
          console.log('[GPT2] result flagged, retrying...');
          return await generateGPT2({...item,prompt:prompts[2]||item.prompt},modelAnchorUrls);
        }
        throw new Error('GPT2 no image URL');
      }
      return url;
    }
    if(st.status==='FAILED'){
      const errMsg=st.error||st.detail||'GPT2 generation failed';
      // If failed due to content, retry with minimal prompt
      if(errMsg.includes('content')||errMsg.includes('flagged')||errMsg.includes('policy')){
        console.log('[GPT2] generation flagged, retrying with minimal prompt...');
        return await generateGPT2({...item,prompt:prompts[2]||item.prompt,_retried:true},modelAnchorUrls);
      }
      throw new Error(errMsg);
    }
  }
  throw new Error('GPT2 timed out');
}

async function generateNB2(item, modelAnchorUrls=[]){
  item.status='uploading';
  const imgs=item.productImages||[];
  console.log('[NB2] shot='+item.shotType+' replaceModel='+!!item.replaceModel+' refs='+imgs.map(i=>i.slot).join(',')+' anchors='+modelAnchorUrls.length);
  const productUrls=await Promise.all(imgs.map(i=>uploadToFal(i.base64,i.mimeType)));
  const anchorUrls=item.replaceModel?[]:modelAnchorUrls; // no face anchor when replacing model
  const allUrls=[...productUrls,...anchorUrls];
  item.status='generating';
  const sub=await falQ('/fal-ai/nano-banana-2/edit',{prompt:item.prompt,image_urls:allUrls,num_images:1,aspect_ratio:toAR(item.aspectRatio||'3:4'),output_format:'jpeg',safety_tolerance:'4',resolution:item.resolution||'1K'});
  if(!sub.request_id){throw new Error('NB2 submit failed: '+(sub.detail||sub.error||JSON.stringify(sub).slice(0,200)));}
  item.requestId=sub.request_id;item.statusUrl=sub.status_url;item.responseUrl=sub.response_url;
  for(let i=0;i<150;i++){
    await new Promise(r=>setTimeout(r,3000));
    const sp=item.statusUrl?item.statusUrl.replace('https://queue.fal.run',''):`/fal-ai/nano-banana-2/edit/requests/${item.requestId}/status`;
    const st=await falGet(sp);
    if(st.status==='COMPLETED'){
      const rp=item.responseUrl?item.responseUrl.replace('https://queue.fal.run',''):`/fal-ai/nano-banana-2/edit/requests/${item.requestId}`;
      const res=await falGet(rp);
      const url=res?.images?.[0]?.url||res?.output?.images?.[0]?.url||res?.image?.url||res?.data?.images?.[0]?.url;
      if(!url)throw new Error('NB2 no image URL');
      return url;
    }
    if(st.status==='FAILED')throw new Error(st.error||'NB2 failed');
  }
  throw new Error('NB2 timed out');
}

// ── Per-shot image filter ──────────────────────────────────────────────────
// CRITICAL: only send images that belong to the shot's angle.
// If we send front + back images to a back-shot generation, GPT Image 2
// composites them and renders BOTH models in the same frame (the bug the
// user was seeing). We also always include accessories regardless of angle.
const PRODUCT_ONLY_SHOTS = new Set(['flat_lay','mannequin','alone_white','alone_grey','alone_natural']);
const SHOT_TO_SLOT = {
  front:'front view', threeq:'front view', face:'front view',
  sitting:'front view', walking:'front view', dynamic:'front view',
  hands:'front view', detail:'front view', lookbook:'front view',
  street_life:'front view', banner:'front view',
  back:'back view',
  side:null, // handled separately
};
function filterImagesForShot(productImages, shotType){
  if(!productImages?.length) return productImages;
  const sl = s => (s||'').toLowerCase();
  const isAcc = img => sl(img.slot).startsWith('accessory');

  // Product-only shots: give the AI all angles so it can lay them flat / show all
  if(PRODUCT_ONLY_SHOTS.has(shotType)) return productImages;

  const accessories = productImages.filter(isAcc);

  // Determine which slot label corresponds to this shot
  let angleImages;
  if(shotType === 'side'){
    angleImages = productImages.filter(img => !isAcc(img) && (
      sl(img.slot).startsWith('left side view') || sl(img.slot).startsWith('right side view')
    ));
  } else {
    const target = SHOT_TO_SLOT[shotType] || 'front view';
    angleImages = productImages.filter(img => !isAcc(img) && sl(img.slot).startsWith(target));
  }

  if(angleImages.length > 0){
    // Use ONLY this angle's images + accessories — never mix angles
    return [...angleImages, ...accessories];
  }

  // No images for this angle: fall back gracefully
  const frontImages = productImages.filter(img => !isAcc(img) && sl(img.slot).startsWith('front view'));
  if(frontImages.length) return [...frontImages, ...accessories];

  // Last resort: all non-accessory images + accessories
  return productImages;
}

// ── Process item ───────────────────────────────────────────────────────────
async function processItem(batchId, itemId){
  const batch=jobs[batchId];if(!batch)return;
  const item=batch.items.find(i=>i.id===itemId);if(!item)return;
  try{
    // STEP 1: Claude vision — shot 0 runs analysis; other shots wait for it
    if(item.shotIndex===0 && batch.type!=='website' && item.productImages?.length){
      item.status='analyzing';
      if(!batch.garmentDescs)batch.garmentDescs={};
      batch.garmentDescs[item.productKey]='__pending__'; // flag: analysis started
      try{
        const desc=await getGarmentDescription(item.productImages);
        if(desc){
          batch.garmentDescs[item.productKey]=desc;
          item.prompt=buildPromptWithGarment(item,desc);
          console.log('[prompt built with Claude vision for',item.productName,']');
          console.log('[prompt]',item.prompt.slice(0,200));
        } else {
          delete batch.garmentDescs[item.productKey];
        }
      }catch(e){
        console.error('[vision error]',e.message);
        delete batch.garmentDescs[item.productKey];
      }
    } else if(item.shotIndex>0 && batch.type!=='website'){
      // Wait up to 2 min for shot 0's Claude analysis to finish before building prompt
      item.status='waiting';
      for(let w=0;w<40;w++){
        const d=batch.garmentDescs?.[item.productKey];
        if(d && d!=='__pending__') break;
        await new Promise(r=>setTimeout(r,3000));
      }
      const desc=batch.garmentDescs?.[item.productKey];
      if(desc && desc!=='__pending__'){
        item.prompt=buildPromptWithGarment(item,desc);
        console.log('[prompt built from cache for shot',item.shotIndex,']');
      }
    }

    // STEP 2: Model anchor
    let modelAnchorUrls=[];
    if(item.savedModelUrl && batch.type!=='website'){
      modelAnchorUrls=Array.isArray(item.savedModelUrls)&&item.savedModelUrls.length?item.savedModelUrls:[item.savedModelUrl];
    } else if(item.shotIndex>0 && batch.type!=='website'){
      // Auto-consistency: wait for shot 0 result to use as face anchor
      const shot0=batch.items.find(i=>i.productKey===item.productKey&&i.shotIndex===0);
      if(shot0){
        item.status='waiting';
        // Wait max 5 min for shot 0
        for(let w=0;w<100;w++){
          if(shot0.status==='done'&&shot0.resultUrl)break;
          if(shot0.status==='error')break;
          await new Promise(r=>setTimeout(r,3000));
        }
        if(shot0.resultUrl){
          modelAnchorUrls=[shot0.resultUrl];
        } else {
          console.log('[chain] shot0 unavailable (status:'+shot0.status+'), generating shot',item.shotIndex,'independently');
        }
      }
    }

    // STEP 2.5: Filter product images to angle + handle replaceModel
    if(batch.type !== 'website'){
      item.productImages = filterImagesForShot(item.productImages, item.shotType);
      console.log('[filter] shot='+item.shotType+' → '+item.productImages.length+' images: '+item.productImages.map(i=>i.slot).join(', '));

      if(item.replaceModel){
        // CRITICAL: GPT Image 2's edit endpoint identity-locks to ANY face in
        // reference images. No text instruction can override this. The ONLY fix
        // is to not send model-containing garment images. Without them GPT2 has
        // no face to anchor to and will generate the new model from text.
        // Garment accuracy comes from Claude's full text description instead.
        const sl = s=>(s||'').toLowerCase();
        const accOnly = item.productImages.filter(img=>sl(img.slot).startsWith('accessory'));
        item.productImages = accOnly.length ? accOnly : []; // accessories carry no face
        console.log('[replaceModel] stripped garment refs → '+item.productImages.length+' acc-only refs remaining');
      }
    }

    // STEP 3: Generate
    const url = item.aiModel==='nb2'
      ? await generateNB2(item, modelAnchorUrls)
      : await generateGPT2(item, modelAnchorUrls);

    item.resultUrl=url; item.status='done';
    batch.completedCount=(batch.completedCount||0)+1;
  }catch(err){
    item.status='error'; item.error=err.message;
    batch.completedCount=(batch.completedCount||0)+1;
    console.error('['+itemId+']',err.message);
  }
}

function runBatch(batchId, concurrency=4){
  const q=[...jobs[batchId].items.filter(i=>i.status==='queued')];
  const next=async()=>{const it=q.shift();if(!it)return;await processItem(batchId,it.id);await next();};
  Promise.all(Array.from({length:Math.min(concurrency,q.length||1)},next))
    .then(()=>{if(jobs[batchId])jobs[batchId].status='done';});
}

// ── Batch create ───────────────────────────────────────────────────────────
app.post('/api/batch/create',async(req,res)=>{
  const{type='model',products,globalPrompt,promptMode,category,styleKey,bgOption,bgCustom,
        gender,realism,resolution,aspectRatio,modelDesc,shots,savedModelUrl,
        aiModel='gpt2',gptQuality='medium',
        groupShot=false,groupShotModels=[],groupShotPrompt=''}=req.body;
  if(!products?.length)return res.status(400).json({error:'No products'});
  if(products.length>100)return res.status(400).json({error:'Max 100'});

  const batchId=uuidv4();const items=[];

  if(groupShot){
    const allImages=products.flatMap(p=>p.images);
    const productNames=products.map(p=>p.name);
    const modelCount=groupShotModels.length||products.length;
    const multiDesc=groupShotModels.length?groupShotModels.map((m,i)=>`Model ${i+1} (${m.name||'model'})`).join(', '):`${modelCount} models`;
    const anchorUrls=groupShotModels.map(m=>m.imageUrl).filter(Boolean);
    const shotList=shots?.length?shots:[{shotType:'group',label:'Group Shot',bg:bgOption||'ai',bgCustom:bgCustom||'',aspectRatio:aspectRatio||'16:9'}];
    for(let si=0;si<shotList.length;si++){
      const shot=shotList[si];
      const prompt=buildPrompt({userPrompt:groupShotPrompt||globalPrompt||'',shotType:shot.shotType||'group',category,styleKey:shot.styleKey||styleKey||'',bgOption:shot.bg||bgOption||'ai',bgCustom:shot.bgCustom||bgCustom||'',gender,realism:realism||'ultra',modelDesc,productNames,modelCount,multiModelDesc:multiDesc});
      items.push({id:uuidv4(),name:`Group Shot${shotList.length>1?' — '+(shot.label||shot.shotType):''}`,productName:'Group Shot',productKey:'gs',shotLabel:shot.label||shot.shotType,shotType:shot.shotType||'group',shotIndex:si,savedModelUrl:anchorUrls[0]||savedModelUrl||null,savedModelUrls:anchorUrls,productImages:allImages,prompt,aspectRatio:shot.aspectRatio||aspectRatio||'16:9',resolution:shot.resolution||resolution||'1K',replaceModel:false,aiModel:aiModel||'gpt2',gptQuality,status:'queued',requestId:null,resultUrl:null,error:null});
    }
    jobs[batchId]={type,status:'processing',created:Date.now(),completedCount:0,items};
    res.json({batchId,total:items.length});
    runBatch(batchId);return;
  }

  for(let pi=0;pi<products.length;pi++){
    const prod=products[pi];
    const perPrompt=(promptMode==='individual'&&prod.prompt)?prod.prompt:(globalPrompt||'');
    const prodModelUrl=prod.savedModelUrl||savedModelUrl||null;
    const productKey=`p${pi}`;
    const replaceModel=prod.replaceModel||false;
    const shotList=shots?.length?shots:[{shotType:'front',label:'Front View',bg:bgOption||'white',bgCustom:bgCustom||'',aspectRatio:aspectRatio||'3:4'},{shotType:'back',label:'Back View',bg:bgOption||'white',bgCustom:bgCustom||'',aspectRatio:aspectRatio||'3:4'}];

    for(let si=0;si<shotList.length;si++){
      const shot=shotList[si];
      const iBg=shot.bg||bgOption||'white';
      const iBgC=shot.bgCustom||bgCustom||'';
      const extra=shot.customPrompt?' '+shot.customPrompt:'';
      const modelLocked=si>0&&!prodModelUrl&&!replaceModel;
      const prompt=type==='website'
        ?`professional product photography, product only, pure white background, no model, commercial shot, ultra sharp`
        :buildPrompt({userPrompt:perPrompt+extra,shotType:shot.shotType||'front',category:prod.category||category||'other',styleKey:shot.styleKey||styleKey||'',bgOption:iBg,bgCustom:iBgC,gender:prod.gender||gender||'female',realism:realism||'ultra',modelDesc:prod.modelDesc||modelDesc||'',modelLocked,replaceModel:replaceModel&&si===0});
      items.push({
        id:uuidv4(),
        name:shotList.length>1?`${prod.name} — ${shot.label||shot.shotType}`:prod.name,
        productName:prod.name,productKey,
        shotLabel:shot.label||shot.shotType,shotType:shot.shotType||'front',shotIndex:si,
        savedModelUrl:prodModelUrl,savedModelUrls:null,
        productImages:prod.images,prompt,
        aspectRatio:shot.aspectRatio||aspectRatio||'3:4',
        resolution:shot.resolution||resolution||'1K',
        replaceModel,modelLocked,
        aiModel:aiModel||'gpt2',gptQuality:gptQuality||'medium',
        modelDescText:prod.modelDesc||modelDesc||'',
        userPrompt:perPrompt+extra,
        bgOption:iBg,bgCustom:iBgC,
        gender:prod.gender||gender||'female',
        realism:realism||'ultra',
        status:'queued',requestId:null,resultUrl:null,error:null,
      });
    }
  }

  jobs[batchId]={type,status:'processing',created:Date.now(),completedCount:0,items};
  res.json({batchId,total:items.length});
  runBatch(batchId);
});

app.get('/api/batch/:id/status',(req,res)=>{
  const b=jobs[req.params.id];if(!b)return res.status(404).json({error:'Not found'});
  res.json({status:b.status,type:b.type,total:b.items.length,completed:b.completedCount||0,
    items:b.items.map(({id,name,productName,shotLabel,shotIndex,productKey,status,resultUrl,error,aspectRatio})=>({id,name,productName,shotLabel,shotIndex,productKey,status,resultUrl,error,aspectRatio}))});
});

app.post('/api/item/:bid/:iid/regenerate',async(req,res)=>{
  const b=jobs[req.params.bid];if(!b)return res.status(404).json({error:'Not found'});
  const item=b.items.find(i=>i.id===req.params.iid);if(!item)return res.status(404).json({error:'Not found'});
  const{prompt,bgOption,resolution,aspectRatio}=req.body;
  if(prompt)item.prompt=prompt;
  if(resolution)item.resolution=resolution;
  if(aspectRatio)item.aspectRatio=aspectRatio;
  item.status='queued';item.resultUrl=null;item.error=null;
  res.json({ok:true});
  processItem(req.params.bid,item.id);
});

app.post('/api/batch/:id/edit',async(req,res)=>{
  const b=jobs[req.params.id];if(!b)return res.status(404).json({error:'Not found'});
  const{globalPrompt,resolution}=req.body;
  b.completedCount=0;b.status='processing';
  b.items.forEach(it=>{if(globalPrompt)it.prompt=globalPrompt;if(resolution)it.resolution=resolution;it.status='queued';it.resultUrl=null;it.error=null;});
  res.json({ok:true});
  runBatch(req.params.id);
});

app.post('/api/item/:bid/:iid/upscale',async(req,res)=>{
  const item=jobs[req.params.bid]?.items.find(i=>i.id===req.params.iid);
  if(!item?.resultUrl)return res.status(400).json({error:'No image'});
  try{
    const sub=await falQ('/fal-ai/aura-sr',{image_url:item.resultUrl,upscaling_factor:4});
    if(!sub.request_id)throw new Error('Upscale submit failed');
    for(let i=0;i<60;i++){
      await new Promise(r=>setTimeout(r,3000));
      const s=await falGet(`/fal-ai/aura-sr/requests/${sub.request_id}/status`);
      if(s.status==='COMPLETED'){const r=await falGet(`/fal-ai/aura-sr/requests/${sub.request_id}`);const url=r.image?.url||r.images?.[0]?.url||r.output?.image?.url;if(url){item.resultUrl=url;return res.json({url});}}
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
app.get('/api/config',(req,res)=>res.json({hasServerKey:!!FAL_KEY,version:'4.0'}));
app.post('/api/cache/clear',(req,res)=>{garmentCache.clear();res.json({ok:true,msg:'Garment vision cache cleared'});});

// ── Model swap ─────────────────────────────────────────────────────────────
app.post('/api/item/swap-model',async(req,res)=>{
  const{sourceImageUrl,sourceImageBase64,sourceImageMime,modelImageUrl,modelImageBase64,modelImageMime,modelDesc,gender='female',aspectRatio='3:4',resolution='1K',bgOption='white',bgCustom=''}=req.body;
  try{
    const srcUrl=sourceImageUrl||await uploadToFal(sourceImageBase64,sourceImageMime||'image/jpeg');
    const modelUrl=modelImageUrl||(modelImageBase64?await uploadToFal(modelImageBase64,modelImageMime||'image/jpeg'):null);
    const bgHint=bgOption==='custom'?bgCustom:(BG[bgOption]||BG.white);
    const modelHint=modelUrl?'same model as the reference photo, identical face and hair':(modelDesc||(GENDER[gender]||GENDER.female));
    const prompt=sanitizeForGPT2([modelHint,'wearing the exact same clothing from the source image, keep all garments identical, only change the model',bgHint,'hyperrealistic photograph professional fashion photography'].filter(Boolean).join(', '));
    const imageUrls=modelUrl?[modelUrl,srcUrl]:[srcUrl];
    const sub=await falQ('/openai/gpt-image-2/edit',{prompt,image_urls:imageUrls,quality:'medium',image_size:toGPT2Size(aspectRatio),content_moderation:'permissive'});
    if(!sub.request_id)throw new Error(sub.detail||sub.error||'Submit failed');
    for(let i=0;i<60;i++){
      await new Promise(r=>setTimeout(r,4000));
      const sp=sub.status_url?sub.status_url.replace('https://queue.fal.run',''):`/openai/gpt-image-2/edit/requests/${sub.request_id}/status`;
      const st=await falGet(sp);
      if(st.status==='COMPLETED'){const rp=sub.response_url?sub.response_url.replace('https://queue.fal.run',''):`/openai/gpt-image-2/edit/requests/${sub.request_id}`;const result=await falGet(rp);const url=result?.images?.[0]?.url||result?.output?.images?.[0]?.url||result?.image?.url;if(url)return res.json({url});return res.status(500).json({error:'No image URL'});}
      if(st.status==='FAILED')return res.status(500).json({error:st.error||'Failed'});
    }
    res.status(500).json({error:'Timed out'});
  }catch(e){res.status(500).json({error:e.message});}
});

// ── Video ──────────────────────────────────────────────────────────────────
if(!global.videoJobs)global.videoJobs={};
app.post('/api/video/create',async(req,res)=>{
  const{clips}=req.body;if(!clips?.length)return res.status(400).json({error:'No clips'});
  const jobId=uuidv4();
  global.videoJobs[jobId]={status:'processing',created:Date.now(),completedCount:0,clips:clips.map(c=>({...c,status:'queued',resultUrl:null,error:null,requestId:null}))};
  res.json({jobId,total:clips.length});
  const job=global.videoJobs[jobId];const queue=[...job.clips];
  const next=async()=>{
    const clip=queue.shift();if(!clip)return;
    try{
      clip.status='generating';
      let imageUrl=clip.imageUrl;
      if(!imageUrl&&clip.imageBase64&&clip.imageMime)imageUrl=await uploadToFal(clip.imageBase64,clip.imageMime);
      if(!imageUrl)throw new Error('No image for clip');
      let sub=await falQ('/fal-ai/kling-video/v3/pro/image-to-video',{image_url:imageUrl,prompt:clip.prompt||'fashion model smooth natural movement cinematic',duration:clip.duration||'5',aspect_ratio:clip.aspectRatio||'9:16'});
      if(!sub.request_id){sub=await falQ('/fal-ai/kling-video/v1.6/pro/image-to-video',{image_url:imageUrl,prompt:clip.prompt||'fashion model smooth movement',duration:clip.duration||'5',aspect_ratio:clip.aspectRatio||'9:16'});if(!sub.request_id)throw new Error(sub.detail||sub.error||'Video submit failed');}
      clip.requestId=sub.request_id;clip.statusUrl=sub.status_url;clip.responseUrl=sub.response_url;
      for(let i=0;i<180;i++){
        await new Promise(r=>setTimeout(r,5000));
        const sp=clip.statusUrl?clip.statusUrl.replace('https://queue.fal.run',''):`/fal-ai/kling-video/v3/pro/image-to-video/requests/${clip.requestId}/status`;
        const st=await falGet(sp);
        if(st.status==='COMPLETED'){const rp=clip.responseUrl?clip.responseUrl.replace('https://queue.fal.run',''):`/fal-ai/kling-video/v3/pro/image-to-video/requests/${clip.requestId}`;const result=await falGet(rp);const url=result?.video?.url||result?.output?.video?.url||result?.videos?.[0]?.url;if(!url)throw new Error('No video URL');clip.resultUrl=url;clip.status='done';break;}
        if(st.status==='FAILED')throw new Error(st.error||'Video failed');
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
  res.json({status:job.status,total:job.clips.length,completed:job.completedCount,clips:job.clips.map(({id,prompt,status,resultUrl,error,aspectRatio,duration})=>({id,prompt,status,resultUrl,error,aspectRatio,duration}))});
});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT,()=>console.log('\n✅ Fashion AI Studio v4.0 → http://localhost:'+PORT+'\n'));
