'use strict';
const express  = require('express');
const fetch    = require('node-fetch');
const path     = require('path');
const archiver = require('archiver');
const { v4: uuidv4 } = require('uuid');

const app  = express();
const PORT = process.env.PORT || 3456;
app.use(express.json({ limit: '200mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const jobs={}, STYLES={}, MODELS={};
setInterval(()=>{ const c=Date.now()-4*60*60*1000; for(const id of Object.keys(jobs)){if(jobs[id].created<c)delete jobs[id];} },30*60*1000);

// ── fal helpers ────────────────────────────────────────────────────────
async function falReq(method,url,auth,body){
  const r=await fetch(url,{method,headers:{Authorization:auth,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  const t=await r.text();
  if(!t||!t.trim())return{};
  try{return JSON.parse(t);}catch{return{_raw:t};}
}
const falPost=(p,b,a)=>falReq('POST',`https://queue.fal.run${p}`,a,b);
const falGet= (p,a)  =>falReq('GET', `https://queue.fal.run${p}`,a,null);

async function uploadToFal(base64,mimeType,auth){
  const init=await falReq('POST','https://rest.alpha.fal.ai/storage/upload/initiate',auth,{
    file_name:`img_${Date.now()}_${Math.random().toString(36).slice(2,6)}.jpg`,
    content_type:mimeType||'image/jpeg'
  });
  if(!init.upload_url)throw new Error('upload initiate failed: '+JSON.stringify(init).slice(0,120));
  const put=await fetch(init.upload_url,{method:'PUT',headers:{'Content-Type':mimeType||'image/jpeg'},body:Buffer.from(base64,'base64')});
  if(!put.ok)throw new Error(`PUT failed ${put.status}`);
  return init.file_url;
}

const NB2={
  '1:1':'1:1','4:5':'4:5','3:4':'3:4','2:3':'2:3','9:16':'9:16',
  '4:3':'4:3','5:4':'5:4','3:2':'3:2','16:9':'16:9','21:9':'21:9'
};
const toAR=ar=>NB2[ar]||'3:4';

// ── Prompts ────────────────────────────────────────────────────────────
const CAT={
  sunglasses:'wearing the sunglasses, face visible',
  bags:'holding or wearing the bag',
  shirts:'wearing the shirt',
  dresses:'wearing the dress, full body',
  shoes:'wearing the shoes, feet visible',
  watches:'wearing the watch on wrist',
  jackets:'wearing the jacket, full body',
  pants:'wearing the pants, full body',
  jewelry:'wearing the jewelry',
  hats:'wearing the hat',
  outfit:'wearing the complete outfit with all garments and accessories, full body head to toe',
  other:'wearing or holding the product',
};
const STYLE={
  editorial:'high fashion editorial, Vogue, dramatic lighting',
  street:'street style, urban outdoor, candid',
  luxury:'luxury fashion, elegant, soft dramatic lighting',
  ecommerce:'clean ecommerce, neutral lighting',
  lifestyle:'lifestyle, casual, natural golden hour',
  minimal:'minimalist, clean neutral background',
  athletic:'athletic, sport, dynamic action',
  bohemian:'bohemian, earthy tones, natural textures',
  formal:'formal professional, corporate, polished',
  vintage:'vintage, retro color grade, film look',
  streetwear:'streetwear, urban, youthful energy',
  haute:'haute couture, avant-garde, artistic',
};
const BG={
  ai:'',
  white:'pure white seamless background',
  grey:'grey seamless studio background',
  lightgrey:'light grey seamless background',
  black:'black studio background',
  outdoor:'natural outdoor environment',
  street:'urban street environment',
  luxury:'luxury interior, marble floors',
  beach:'tropical beach background',
  forest:'lush green forest background',
  studio:'photography studio, soft box lighting',
  minimal_bg:'minimal gradient background',
  custom:'',
};
const SHOT={
  front:'front-facing pose, full body, facing camera',
  back:'back view, model facing away, full body rear',
  side:'side profile, full body',
  detail:'extreme close-up, product detail, texture visible',
  face:'portrait, head and shoulders',
  sitting:'model sitting, seated pose',
  walking:'walking pose, mid-stride',
  dynamic:'dynamic action pose, movement, energy',
  hands:'close-up hands and wrists',
  flat_lay:'flat lay, product on surface, overhead view, no model',
  mannequin:'ghost mannequin, clothing floating, no model',
  alone_white:'product on pure white background, no model',
  alone_grey:'product on grey background, no model',
  alone_natural:'product on natural wooden surface, no model',
  lookbook:'lookbook style, fashion editorial, lifestyle',
  street_life:'real street, urban lifestyle, candid city',
};
const REAL={
  ultra:'hyperrealistic photo, ultra sharp, natural skin texture, professional fashion photography',
  editorial:'high fashion editorial, Vogue quality, professional studio lighting',
  cinematic:'cinematic look, shallow depth of field, Kodak color grade',
  raw:'raw documentary photo, natural light, candid authentic',
};
const GENDER={female:'beautiful female model',male:'handsome male model',neutral:'androgynous model'};

// LOCK: injected into shots 2+ using previous shot output as visual anchor
const LOCK_HINT='same model as reference image, keep identical appearance';

function buildPrompt(userPrompt,shot,opts={}){
  const{category='other',styleKey='',bgOption='ai',bgCustom='',gender='female',realism='ultra',modelDesc='',isLocked=false}=opts;
  const parts=[
    userPrompt||'',
    isLocked ? LOCK_HINT : (modelDesc||GENDER[gender]||GENDER.female),
    CAT[category]||CAT.other,
    SHOT[shot]||SHOT.front,
    STYLE[styleKey]||'',
    bgOption==='custom'?bgCustom:(BG[bgOption]||''),
    REAL[realism]||REAL.ultra,
  ];
  const p=parts.filter(Boolean).join(', ');
  return p.length>450?p.slice(0,447)+'...':p;
}

function buildWebPrompt(userPrompt,shot,bgOption,bgCustom){
  const parts=[
    userPrompt||'professional product photo',
    SHOT[shot]||SHOT.alone_white,
    bgOption==='custom'?bgCustom:(BG[bgOption]||BG.white),
    'no model, product only, commercial product photography, ultra sharp, white seamless',
  ];
  const p=parts.filter(Boolean).join(', ');
  return p.length>400?p.slice(0,397)+'...':p;
}

// ── Item processor ─────────────────────────────────────────────────────
async function generate(item,auth,anchorUrls=[]){
  item.status='uploading';
  const productUrls=[];
  for(const img of item.productImages)
    productUrls.push(await uploadToFal(img.base64,img.mimeType,auth));

  const styleUrls=[];
  for(const s of (item.styleRefImages||[]))
    styleUrls.push(await uploadToFal(s.base64,s.mimeType,auth));

  // Order: product images → saved model anchor → auto-lock anchor → style refs
  const allUrls=[...productUrls,...anchorUrls,...styleUrls];

  item.status='generating';
  const sub=await falPost('/fal-ai/nano-banana-2/edit',{
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
    throw new Error('Submit failed: '+msg);
  }
  item.requestId=sub.request_id;
  item.statusUrl=sub.status_url;
  item.responseUrl=sub.response_url;

  for(let i=0;i<150;i++){
    await new Promise(r=>setTimeout(r,4000));
    const sp=item.statusUrl?item.statusUrl.replace('https://queue.fal.run',''):`/fal-ai/nano-banana-2/edit/requests/${item.requestId}/status`;
    const st=await falGet(sp,auth);
    if(st.status==='COMPLETED'){
      const rp=item.responseUrl?item.responseUrl.replace('https://queue.fal.run',''):`/fal-ai/nano-banana-2/edit/requests/${item.requestId}`;
      const res=await falGet(rp,auth);
      const url=res?.images?.[0]?.url||res?.output?.images?.[0]?.url||res?.image?.url||res?.output?.image?.url||res?.data?.images?.[0]?.url;
      if(!url)throw new Error('No image URL in result: '+JSON.stringify(res).slice(0,150));
      return url;
    }
    if(st.status==='FAILED')throw new Error(st.error||st.detail||'Generation failed');
  }
  throw new Error('Timed out');
}

async function processItem(batchId,itemId,auth){
  const batch=jobs[batchId]; if(!batch)return;
  const item=batch.items.find(i=>i.id===itemId); if(!item)return;
  try{
    let anchorUrls=[];

    // Priority 1: saved model selected by user → inject for ALL shots
    if(item.savedModelUrl && batch.type!=='website'){
      anchorUrls=[item.savedModelUrl];
      if(!item.prompt.includes(LOCK_HINT))
        item.prompt=LOCK_HINT+', '+item.prompt;

    // Priority 2: auto-lock — shots 2+ wait for shot 1 result of same product
    }else if(item.shotIndex>0 && batch.type!=='website'){
      const first=batch.items.find(i=>i.productKey===item.productKey&&i.shotIndex===0);
      if(first){
        item.status='waiting';
        for(let w=0;w<240;w++){
          if(first.status==='done'&&first.resultUrl)break;
          if(first.status==='error')break;
          await new Promise(r=>setTimeout(r,3000));
        }
        if(first.resultUrl){
          anchorUrls=[first.resultUrl];
          if(!item.prompt.includes(LOCK_HINT))
            item.prompt=LOCK_HINT+', '+item.prompt;
        }
      }
    }

    const url=await generate(item,auth,anchorUrls);
    item.resultUrl=url; item.status='done';
    batch.completedCount=(batch.completedCount||0)+1;
  }catch(err){
    item.status='error'; item.error=err.message;
    batch.completedCount=(batch.completedCount||0)+1;
    console.error(`[${itemId}]`,err.message);
  }
}

function runBatch(batchId,auth,concurrency=3){
  const q=[...jobs[batchId].items.filter(i=>i.status==='queued')];
  const next=async()=>{const it=q.shift();if(!it)return;await processItem(batchId,it.id,auth);await next();};
  Promise.all(Array.from({length:Math.min(concurrency,q.length||1)},next))
    .then(()=>{if(jobs[batchId])jobs[batchId].status='done';});
}

// ── Routes ─────────────────────────────────────────────────────────────
app.post('/api/batch/create',async(req,res)=>{
  const auth=req.headers['authorization'];
  if(!auth)return res.status(401).json({error:'Missing key'});
  const{type='model',products,globalPrompt,promptMode,category,styleKey,bgOption,bgCustom,
        gender,realism,resolution,aspectRatio,modelDesc,styleRefImages,shots,savedModelUrl}=req.body;
  if(!products?.length)return res.status(400).json({error:'No products'});
  if(products.length>100)return res.status(400).json({error:'Max 100'});

  const batchId=uuidv4();
  const items=[];
  const sharedStyleRefs=styleRefImages||[];

  for(let pi=0;pi<products.length;pi++){
    const prod=products[pi];
    const perPrompt=(promptMode==='individual'&&prod.prompt)?prod.prompt:globalPrompt;
    const productKey=`p${pi}`;
    const shotList=(shots&&shots.length)?shots:[{shotType:'front',label:'Photo',bg:bgOption||'ai',bgCustom:bgCustom||'',aspectRatio:aspectRatio||'3:4',styleKey:'',customPrompt:''}];

    for(let si=0;si<shotList.length;si++){
      const shot=shotList[si];
      const iBg=shot.bg||bgOption||'ai';
      const iBgC=shot.bgCustom||bgCustom||'';
      const extra=shot.customPrompt?', '+shot.customPrompt:'';
      const isLocked=si>0&&!savedModelUrl&&type!=='website';
      const prompt=type==='website'
        ?buildWebPrompt((perPrompt||'')+extra,shot.shotType||'alone_white',iBg,iBgC)
        :buildPrompt((perPrompt||'')+extra,shot.shotType||'front',{category,styleKey:shot.styleKey||styleKey,bgOption:iBg,bgCustom:iBgC,gender,realism,modelDesc:modelDesc||'',isLocked});
      items.push({
        id:uuidv4(),
        name:shotList.length>1?`${prod.name} — ${shot.label||shot.shotType}`:prod.name,
        productName:prod.name, shotLabel:shot.label||shot.shotType,
        shotIndex:si, productKey,
        savedModelUrl:savedModelUrl||null,
        productImages:prod.images,
        styleRefImages:sharedStyleRefs,
        prompt, aspectRatio:shot.aspectRatio||aspectRatio||'3:4',
        resolution:shot.resolution||resolution||'1K',
        status:'queued',requestId:null,resultUrl:null,error:null,
      });
    }
  }
  jobs[batchId]={type,status:'processing',created:Date.now(),completedCount:0,items};
  res.json({batchId,total:items.length});
  runBatch(batchId,auth,3);
});

app.get('/api/batch/:id/status',(req,res)=>{
  const b=jobs[req.params.id];
  if(!b)return res.status(404).json({error:'Not found'});
  res.json({status:b.status,type:b.type,total:b.items.length,completed:b.completedCount||0,
    items:b.items.map(({id,name,productName,shotLabel,shotIndex,status,resultUrl,error,aspectRatio})=>
      ({id,name,productName,shotLabel,shotIndex,status,resultUrl,error,aspectRatio}))});
});

app.post('/api/item/:bid/:iid/regenerate',async(req,res)=>{
  const auth=req.headers['authorization'];
  if(!auth)return res.status(401).json({error:'Missing key'});
  const b=jobs[req.params.bid];if(!b)return res.status(404).json({error:'Not found'});
  const item=b.items.find(i=>i.id===req.params.iid);if(!item)return res.status(404).json({error:'Not found'});
  const{prompt,category,styleKey,bgOption,bgCustom,gender,realism,resolution,aspectRatio,shotType,modelDesc}=req.body;
  if(prompt)item.prompt=b.type==='website'
    ?buildWebPrompt(prompt,shotType||'alone_white',bgOption||'white',bgCustom||'')
    :buildPrompt(prompt,shotType||'front',{category:category||'other',styleKey:styleKey||'',bgOption:bgOption||'ai',bgCustom:bgCustom||'',gender:gender||'female',realism:realism||'ultra',modelDesc:modelDesc||''});
  if(resolution)item.resolution=resolution;
  if(aspectRatio)item.aspectRatio=aspectRatio;
  item.status='queued';item.resultUrl=null;item.error=null;
  res.json({ok:true});
  processItem(req.params.bid,item.id,auth);
});

app.post('/api/batch/:id/edit',async(req,res)=>{
  const auth=req.headers['authorization'];
  if(!auth)return res.status(401).json({error:'Missing key'});
  const b=jobs[req.params.id];if(!b)return res.status(404).json({error:'Not found'});
  const{globalPrompt,category,styleKey,bgOption,bgCustom,gender,realism,resolution,modelDesc}=req.body;
  b.completedCount=0;b.status='processing';
  b.items.forEach(it=>{
    if(globalPrompt)it.prompt=b.type==='website'
      ?buildWebPrompt(globalPrompt,it.shotType||'alone_white',bgOption||'white',bgCustom||'')
      :buildPrompt(globalPrompt,it.shotType||'front',{category:category||'other',styleKey:styleKey||'',bgOption:bgOption||'ai',bgCustom:bgCustom||'',gender:gender||'female',realism:realism||'ultra',modelDesc:modelDesc||''});
    if(resolution)it.resolution=resolution;
    it.status='queued';it.resultUrl=null;it.error=null;
  });
  res.json({ok:true});
  runBatch(req.params.id,auth,3);
});

app.post('/api/item/:bid/:iid/upscale',async(req,res)=>{
  const auth=req.headers['authorization'];
  if(!auth)return res.status(401).json({error:'Missing key'});
  const item=jobs[req.params.bid]?.items.find(i=>i.id===req.params.iid);
  if(!item?.resultUrl)return res.status(400).json({error:'No image'});
  try{
    const sub=await falPost('/fal-ai/aura-sr',{image_url:item.resultUrl,upscaling_factor:4},auth);
    if(!sub.request_id)throw new Error('Upscale submit failed');
    for(let i=0;i<60;i++){
      await new Promise(r=>setTimeout(r,3000));
      const s=await falGet(`/fal-ai/aura-sr/requests/${sub.request_id}/status`,auth);
      if(s.status==='COMPLETED'){
        const r=await falGet(`/fal-ai/aura-sr/requests/${sub.request_id}`,auth);
        const url=r.image?.url||r.images?.[0]?.url||r.output?.image?.url;
        if(url){item.resultUrl=url;return res.json({url});}
      }
      if(s.status==='FAILED')throw new Error('Upscale failed');
    }
    throw new Error('Upscale timed out');
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/batch/:id/zip',async(req,res)=>{
  const b=jobs[req.params.id];if(!b)return res.status(404).json({error:'Not found'});
  const done=b.items.filter(i=>i.resultUrl);if(!done.length)return res.status(400).json({error:'No images'});
  res.setHeader('Content-Type','application/zip');
  res.setHeader('Content-Disposition',`attachment; filename="fashion-${req.params.id.slice(0,8)}.zip"`);
  const arc=archiver('zip',{zlib:{level:6}});arc.pipe(res);
  for(const it of done){
    try{
      if(!it.resultUrl)continue;
      const r=await fetch(it.resultUrl);
      arc.append(Buffer.from(await r.arrayBuffer()),{name:`${it.name.replace(/[^a-z0-9_\-]/gi,'_')}.jpg`});
    }catch(e){console.error('ZIP skip:',e.message);}
  }
  await arc.finalize();
});

// ── Models API ─────────────────────────────────────────────────────────
function uid(a){let h=0;for(let i=0;i<a.length;i++){h=(Math.imul(31,h)+a.charCodeAt(i))|0;}return Math.abs(h).toString(16);}

app.post('/api/models/save',(req,res)=>{
  const a=req.headers['authorization'];if(!a)return res.status(401).json({error:'Missing key'});
  const u=uid(a);const{name,imageUrl,description=''}=req.body;
  if(!name||!imageUrl)return res.status(400).json({error:'name and imageUrl required'});
  if(!MODELS[u])MODELS[u]={};
  const id='m'+Date.now();
  MODELS[u][id]={id,name,imageUrl,description,created:Date.now()};
  res.json({ok:true,id});
});
app.get('/api/models',(req,res)=>{
  const a=req.headers['authorization'];if(!a)return res.status(401).json({error:'Missing key'});
  res.json(Object.values(MODELS[uid(a)]||{}).sort((x,y)=>y.created-x.created));
});
app.delete('/api/models/:id',(req,res)=>{
  const a=req.headers['authorization'];if(!a)return res.status(401).json({error:'Missing key'});
  delete MODELS[uid(a)]?.[req.params.id];res.json({ok:true});
});

// ── Styles API ─────────────────────────────────────────────────────────
app.post('/api/styles/save',(req,res)=>{const a=req.headers['authorization'];if(!a)return res.status(401).json({error:'Missing key'});const u=uid(a);const{name,...rest}=req.body;if(!name)return res.status(400).json({error:'Name required'});if(!STYLES[u])STYLES[u]={};STYLES[u][name]={name,...rest,created:Date.now()};res.json({ok:true});});
app.get('/api/styles',(req,res)=>{const a=req.headers['authorization'];if(!a)return res.status(401).json({error:'Missing key'});res.json(Object.values(STYLES[uid(a)]||{}));});
app.delete('/api/styles/:name',(req,res)=>{const a=req.headers['authorization'];if(!a)return res.status(401).json({error:'Missing key'});delete STYLES[uid(a)]?.[req.params.name];res.json({ok:true});});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT,()=>console.log(`\n✅ Fashion AI Studio → http://localhost:${PORT}\n`));
