/* Shared CreoMaker logic for browser and engine: visual profiles, user presets, batch plan, output names, undo.
   Pure functions only. No platform-recognition guarantees; no account, vault or key data ever enters these structures. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.CreoProfiles=api;})(typeof globalThis!=='undefined'?globalThis:this,()=>{
 'use strict';
 const defaults={gamma:1,vignette:0,colorShift:0,pixelation:0,outputFps:0,textureOpacity:0,tone:'neutral',verifyResults:true,signalChange:true,signalLevel:94,signalPitch:2,signalCrop:1};
 const fields=[['gamma','Гамма',.5,1.8,.05],['vignette','Виньетка · %',0,100,5],['colorShift','Разведение RGB · пикс.',0,12,1],['pixelation','Пикселизация · размер блока',0,16,1],['outputFps','FPS · 0 = авто',0,60,1],['textureOpacity','Текстура васи · %',0,40,1],['signalLevel','Уровень звука · %',80,120,1],['signalPitch','Сдвиг спектра · %',0,5,.1],['signalCrop','Композиция · обрезка края %',0,4,.1]];
 const base={...defaults,uniqueNoise:0,hue:0,saturation:1,contrast:1,brightness:0,speed:0,flip:false,jpeg:95,zoom:0,rotate:0,blur:0,pitch:0,crf:23};
 const presets=[
  {id:'light',label:'Лёгкая уникализация',icon:'Ⅰ',description:'Мягкая цветокоррекция, небольшое зерно и бумажная фактура.',settings:{...base,uniqueNoise:2,hue:1,saturation:1.02,contrast:1.02,zoom:1,textureOpacity:8,vignette:10}},
  {id:'medium',label:'Средняя уникализация',icon:'Ⅱ',description:'Тёплое тонирование, виньетка, лёгкий поворот и изменение темпа.',settings:{...base,uniqueNoise:4,hue:3,saturation:1.04,contrast:1.05,zoom:2,rotate:.7,speed:1,blur:.3,gamma:1.05,vignette:25,textureOpacity:16,tone:'warm'}},
  {id:'heavy',label:'Тяжёлая уникализация',icon:'Ⅲ',description:'Холодный цвет, разделение RGB, заметная фактура и 24 кадра/с.',settings:{...base,uniqueNoise:8,hue:6,saturation:1.07,contrast:1.08,zoom:4,rotate:2,speed:3,blur:.8,pitch:4,gamma:.9,vignette:45,colorShift:2,outputFps:24,textureOpacity:25,tone:'cool'}},
  {id:'hardcore',label:'ABSOLUTE HARDCORE',icon:'Ⅳ',description:'Экспериментальная стилизация: монохром, крупное зерно, пикселизация, 18 кадров/с. Мелкий текст и голос заметно меняются.',settings:{...base,uniqueNoise:12,hue:8,saturation:1.1,contrast:1.1,zoom:5,rotate:4,speed:5,blur:1.5,pitch:8,gamma:.8,vignette:65,colorShift:5,pixelation:4,outputFps:18,textureOpacity:35,tone:'mono'}}
 ];
 const tones={neutral:'Без тонирования',warm:'Тёплый янтарь',cool:'Холодная сталь',mono:'Монохром'};
 function match(s){return presets.find(p=>Object.entries(p.settings).every(([k,v])=>s[k]===v));}

 /* ---------- Formats and output names (the engine uses the same functions) ---------- */
 const formats={'9:16':[720,1280],'16:9':[1280,720],'1:1':[720,720],'4:5':[720,900],'4:3':[960,720]};
 const imageRe=/\.(png|jpe?g|webp|bmp|tiff)$/i;
 const extOf=name=>{const m=/\.[^.\/]+$/.exec(String(name||''));return m?m[0].toLowerCase():'';};
 function safeBase(name){const n=String(name||''),e=extOf(n);return (e?n.slice(0,-e.length):n).replace(/[^\p{L}\p{N}._-]/gu,'_').slice(0,80)||'media';}
 function safeTag(tag){return String(tag||'').trim().replace(/[^\p{L}\p{N}_-]/gu,'_').replace(/_+/g,'_').replace(/^_|_$/g,'').slice(0,32);}
 /** index is 0-based position among processed inputs; target is a format key ('9:16') or copy number. */
 function outputName({index,name,target,mode,image=false,tag=''}){
  const ext=mode==='unique'&&image?extOf(name):'.mp4',t=safeTag(tag);
  return String(index+1).padStart(3,'0')+'_'+safeBase(name)+(t?'_'+t:'')+'_'+(mode==='clean'?String(target).replace(':','_'):'u'+target)+ext;
 }
 const isImage=m=>!!(m&&(m.image||m.probe?.image||imageRe.test(m.name||'')));

 /* ---------- Batch dry plan ---------- */
 /** inputs: [{id,name,image?,duration?}] in batch order. Returns exactly what a job with these settings would create. */
 function planBatch({settings,inputs,edits={},tails=[],music}){
  const s=settings||{},clean=s.mode!=='unique',items=[],warnings=[],names=new Set(),duplicates=[];let index=0,seconds=0;
  const targets=clean?(Array.isArray(s.formats)?s.formats.filter(f=>formats[f]):[]):Array.from({length:Math.max(0,Math.round(Number(s.copies)||0))},(_,i)=>i+1);
  for(const m of inputs||[]){
   const image=isImage(m);
   if(clean&&image){items.push({id:m.id,name:m.name,image,skipped:'Изображение: Clean3 работает только с видео',outputs:[]});continue;}
   const e=edits[m.id],dur=Number(m.duration)||0;let length=image?0:dur;
   if(clean&&e&&Number.isFinite(e.start)&&Number.isFinite(e.end))length=Math.max(0,e.end-e.start);
   if(clean&&s.tailmix)length+=Number(s.tailSeconds)||0;
   const outputs=targets.map(target=>{const n=outputName({index,name:m.name,target,mode:clean?'clean':'unique',image,tag:s.nameTag});if(names.has(n))duplicates.push(n);names.add(n);return n;});
   seconds+=length*outputs.length;items.push({id:m.id,name:m.name,image,outputs,length});index++;
  }
  const included=items.filter(i=>!i.skipped),skipped=items.filter(i=>i.skipped);
  if(clean&&!targets.length)warnings.push({level:'error',text:'Выберите хотя бы один формат.'});
  if(!included.length)warnings.push({level:'error',text:skipped.length?'В пакете нет видео для Clean3. Переключитесь на «Варианты» или выберите видео.':'Отметьте исходники для обработки.'});
  if(included.length>200)warnings.push({level:'error',text:'Не более 200 исходников в одной задаче.'});
  if(clean&&s.tailmix&&!tails.length)warnings.push({level:'error',text:'Хвосты включены, но не выбраны. Выберите хвосты или выключите их.'});
  if(s.musicMix&&Array.isArray(music)&&!music.length)warnings.push({level:'info',text:'Наложение аудио включено, но дорожки не выбраны — ролик сохранится с исходным звуком.'});
  if(skipped.length)warnings.push({level:'info',text:'Пропущено изображений: '+skipped.length+' — они обрабатываются только в режиме «Варианты».'});
  if(duplicates.length)warnings.push({level:'error',text:'Совпадают имена результатов: '+duplicates.slice(0,3).join(', ')});
  const total=included.reduce((n,i)=>n+i.outputs.length,0);
  return {items,included:included.map(i=>i.id),skipped:skipped.map(i=>i.id),total,formats:clean?targets:[],copies:clean?0:targets.length,seconds,warnings,blocking:warnings.some(w=>w.level==='error'),duplicates};
 }

 /* ---------- Per-source edits: copy to other sources independently ---------- */
 function trimEnd(value,duration){
  const end=Number(value);
  return end>duration&&(end===Math.round(duration)||end===Math.round(duration*100)/100)?duration:value;
 }
 function copyEdit(from,duration,{trim=true,zones=true}={},target){
  const round2=n=>Math.round((Number(n)||0)*100)/100;
  const d=Number(duration)||0,out=target?{...target,zones:(target.zones||[]).map(z=>({...z}))}:{start:0,end:d,strength:18,zones:[],time:0};
  if(trim&&from){let start=Math.max(0,round2(from.start)),end=Math.min(d,Number.isFinite(Number(from.end))?Number(from.end):d);if(end-start<Math.min(d,.05)-1e-9){start=0;end=d;}out.start=start;out.end=end;out.time=Math.min(d,round2(Math.max(out.time||0,0)));}
  if(zones&&from){out.zones=(from.zones||[]).slice(0,20).map(z=>({x:z.x,y:z.y,w:z.w,h:z.h}));out.strength=from.strength??18;}
  return out;
 }

 /* ---------- Named user presets ---------- */
 // Content-specific metadata texts and the preview-only format are deliberately not part of a processing preset.
 const settingKeys=['mode','acceleration','country','metadata','formats','scale','crf','preset','threads','noise','bitrateEnabled','bitrate','tailmix','musicMix','tailSeconds','fade','copies','uniqueNoise','hue','saturation','contrast','brightness','speed','flip','jpeg','zoom','rotate','blur','pitch','nameTag',...Object.keys(defaults)];
 const enums={mode:['clean','unique'],acceleration:['auto','cpu','amd','nvidia','intel','apple'],scale:['crop','letterbox','stretch'],preset:['ultrafast','superfast','veryfast','faster','fast','medium','slow'],tone:Object.keys(tones)};
 const bools=new Set(['metadata','noise','bitrateEnabled','tailmix','musicMix','flip','verifyResults','signalChange']),texts={country:2,nameTag:32};
 const idRe=/^[a-zA-Z0-9_-]{1,100}$/;
 function presetSettings(s){const out={};for(const k of settingKeys)if(s&&Object.hasOwn(s,k))out[k]=k==='formats'?[...s[k]]:s[k];return out;}
 function cleanName(name){const n=String(name??'').replace(/[\x00-\x1f]/g,'').replace(/\s+/g,' ').trim();if(!n)throw Error('Введите название пресета.');if(n.length>60)throw Error('Название пресета — до 60 символов.');return n;}
 function checkSettings(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Нет параметров пресета.');const s={};
  for(const k of settingKeys){if(!Object.hasOwn(raw,k))continue;const v=raw[k];
   if(enums[k]){if(!enums[k].includes(v))throw Error('Неверное значение «'+k+'».');s[k]=v;}
   else if(bools.has(k)){if(typeof v!=='boolean')throw Error('Неверное значение «'+k+'».');s[k]=v;}
   else if(k in texts){if(typeof v!=='string'||v.length>texts[k])throw Error('Неверное значение «'+k+'».');s[k]=k==='nameTag'?safeTag(v):v;}
   else if(k==='formats'){if(!Array.isArray(v)||!v.length||v.some(f=>!formats[f]))throw Error('Неверные форматы пресета.');s[k]=[...new Set(v)];}
   else{if(typeof v!=='number'||!Number.isFinite(v))throw Error('Неверное число «'+k+'».');s[k]=v;}
  }
  if(!Object.keys(s).length)throw Error('Нет параметров пресета.');return s;
 }
 function checkLibrary(raw){if(raw==null)return null;if(typeof raw!=='object')throw Error('Неверные слои пресета.');const out={};
  for(const k of ['tails','music','tailMusic']){const list=raw[k]??[];if(!Array.isArray(list)||list.length>100)throw Error('Неверные слои пресета.');
   out[k]=list.map(v=>{if(k==='tails'){if(!idRe.test(v))throw Error('Неверный хвост в пресете.');return v;}if(!v||!idRe.test(v.id)||typeof v.volume!=='number'||!(v.volume>=0&&v.volume<=200))throw Error('Неверная дорожка в пресете.');return {id:v.id,volume:v.volume};});}
  return out;}
 function normalizePreset(raw){if(!raw||typeof raw!=='object')throw Error('Неверный пресет.');if(!idRe.test(raw.id))throw Error('Неверный ID пресета.');
  const p={id:raw.id,name:cleanName(raw.name),settings:checkSettings(raw.settings),createdAt:typeof raw.createdAt==='string'?raw.createdAt.slice(0,40):'',updatedAt:typeof raw.updatedAt==='string'?raw.updatedAt.slice(0,40):''};
  const library=checkLibrary(raw.library);if(library)p.library=library;return p;}
 /** Invalid entries are reported and skipped individually, never resetting the remaining presets. */
 function normalizePresets(list){const presets=[],dropped=[];if(list==null)return {presets,dropped};if(!Array.isArray(list))return {presets,dropped:[{name:'?',error:'Список пресетов повреждён.'}]};
  for(const raw of list.slice(0,40)){try{const p=normalizePreset(raw);if(presets.some(x=>x.id===p.id||x.name.toLowerCase()===p.name.toLowerCase()))throw Error('Повтор названия или ID.');presets.push(p);}catch(e){dropped.push({name:String(raw?.name||'?').slice(0,60),error:e.message});}}
  if(list.length>40)dropped.push({name:'…',error:'Сохраняются первые 40 пресетов.'});return {presets,dropped};}
 function uniqueName(name,list,exceptId){const n=cleanName(name);if(list.some(p=>p.id!==exceptId&&p.name.toLowerCase()===n.toLowerCase()))throw Error('Пресет «'+n+'» уже есть. Выберите другое название.');return n;}
 const newId=()=>'p'+Date.now().toString(36)+Math.random().toString(36).slice(2,8);
 function createPreset(list,{name,settings,library,now=new Date().toISOString(),id=newId()}){if(list.length>=40)throw Error('Не более 40 пресетов. Удалите ненужные.');return normalizePreset({id,name:uniqueName(name,list),settings:presetSettings(settings),library:library||null,createdAt:now,updatedAt:now});}
 function renamePreset(list,id,name,now=new Date().toISOString()){if(!list.some(x=>x.id===id))throw Error('Пресет не найден.');const n=uniqueName(name,list,id);return list.map(x=>x.id===id?{...x,name:n,updatedAt:now}:x);}
 function updatePreset(list,id,settings,library,now=new Date().toISOString()){const p=list.find(x=>x.id===id);if(!p)throw Error('Пресет не найден.');const next=normalizePreset({...p,settings:presetSettings(settings),library:library===undefined?p.library:library,updatedAt:now});return list.map(x=>x.id===id?next:x);}
 function deletePreset(list,id){if(!list.some(x=>x.id===id))throw Error('Пресет не найден.');return list.filter(x=>x.id!==id);}
 /** Returns new settings/library; library IDs absent on this computer are dropped and counted. */
 function applyPreset(settings,preset,known=()=>true){const next={...settings,...structuredClone(preset.settings)};let library=null,missing=0;
  if(preset.library){library={};for(const k of ['tails','music','tailMusic']){library[k]=(preset.library[k]||[]).filter(v=>{const ok=known(typeof v==='string'?v:v.id);if(!ok)missing++;return ok;}).map(v=>typeof v==='string'?v:{...v});}}
  return {settings:next,library,missing};}
 const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 function matchUserPreset(settings,list){return (list||[]).find(p=>Object.entries(p.settings).every(([k,v])=>same(settings?.[k],v)));}

 /* ---------- Bounded undo history of serialisable snapshots ---------- */
 function createHistory(limit=50){const stack=[];return {push(label,state){stack.push({label,state:JSON.stringify(state)});if(stack.length>limit)stack.shift();},pop(){const e=stack.pop();return e?{label:e.label,state:JSON.parse(e.state)}:null;},peek(){return stack.at(-1)?.label||'';},clear(){stack.length=0;},get size(){return stack.length;}};}

 return {defaults,fields,presets,tones,match,formats,safeBase,safeTag,outputName,isImage,planBatch,trimEnd,copyEdit,settingKeys,presetSettings,normalizePreset,normalizePresets,createPreset,renamePreset,updatePreset,deletePreset,applyPreset,matchUserPreset,createHistory};
});

