/* CreoMaker web workspace: sources → frame editor → output, plus job queue and results.
   Only media and settings use the local API; vault data, accounts and API keys never enter creoWorkspace. */
(() => {
 'use strict';
 const $=id=>document.getElementById(id),P=CreoProfiles;
 const workspaceStore = window.CreoWorkspaceStore || window.VaultStorage;
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const icon=name=>window.UIIcons?.icon(name)||'';
 const initial={...P.defaults,mode:'clean',acceleration:'auto',country:'',metadataTitle:'',metadataTopic:'',metadataLanguage:'',metadataTags:{},nameTag:'',formats:['9:16','1:1'],scale:'crop',previewFormat:'',crf:26,preset:'faster',threads:0,noise:true,bitrateEnabled:false,bitrate:12000,tailmix:true,musicMix:true,tailSeconds:60,fade:1.5,copies:1,uniqueNoise:5,hue:2,saturation:1.02,contrast:1.03,brightness:0,speed:2,flip:true,metadata:true,jpeg:95,zoom:2,rotate:1.5,blur:1,pitch:15};
 const formatLabels={'9:16':'Вертикаль','1:1':'Квадрат','16:9':'Широкий','4:5':'Лента','4:3':'Классика'};
 const scaleLabels={crop:'обрезка краёв',letterbox:'поля',stretch:'растяжение'};
 const statusLabels={queued:'В очереди',running:'В работе',completed:'Готово',failed:'Ошибка',cancelled:'Остановлена',interrupted:'Прервана'};
 const terminal=new Set(['completed','failed','cancelled','interrupted']);
 const rank=s=>terminal.has(s)?2:s==='running'?1:0;
 const blankWorkspace=()=>({settings:{...initial},selected:[],tails:[],music:[],tailMusic:[],edits:{},userPresets:[]});
 let platform='win32',libraryRefresh;
 let token=null,opening=null,loaded=false,source=null,media=[],jobs=[],workspace=blankWorkspace(),current=null,selectedJob=null,saveTimer,previewSerial=0,busy=false,drag=null,visible=false,available=true;
 let frameReady=false,previewQueue=Promise.resolve(),previewTimer,importTask=null,uploadController=null,settingsDirty=false,presetFormMode=null;
 const timelineCache=new Map(),sourceCache=new Map(),refs=new Map(),history=P.createHistory(60);let lastCheckpoint={key:'',time:0};

 /* ---------- Basics ---------- */
 let activeToast = null;
 function showToast(text, error = false) {
  const container = $('cm-toasts');
  if (!container || !text || !text.trim()) return;
  const isProgress = text.startsWith('Копирование') || text.startsWith('Сохраняем') || text.startsWith('Обновляем') || text.startsWith('Скачиваем');
  if (activeToast && activeToast.isConnected && !activeToast.classList.contains('is-leaving')) {
   const isSameKind = (activeToast.classList.contains('is-error') === !!error);
   const prevText = activeToast.querySelector('.cm-toast-body')?.textContent || '';
   if (prevText === text || (isProgress && isSameKind)) {
    const body = activeToast.querySelector('.cm-toast-body');
    if (body) body.textContent = text;
    activeToast.restartTimer?.(error ? 6500 : 4500);
    return;
   }
  }
  while (container.children.length >= 3) {
   container.firstElementChild?.remove();
  }
  const toast = document.createElement('div');
  toast.className = 'cm-toast ' + (error ? 'is-error' : 'is-info');
  toast.setAttribute('role', error ? 'alert' : 'status');
  toast.innerHTML = '<span class="cm-toast-icon" aria-hidden="true">' + icon(error ? 'alert' : 'info') + '</span><div class="cm-toast-body">' + esc(text) + '</div><button type="button" class="cm-toast-close" aria-label="Закрыть">' + icon('close') + '</button>';
  let timer = null;
  const dismiss = () => {
   if (toast.classList.contains('is-leaving')) return;
   toast.classList.add('is-leaving');
   clearTimeout(timer);
   setTimeout(() => {
    toast.remove();
    if (activeToast === toast) activeToast = null;
   }, 220);
  };
  const startTimer = (ms) => {
   clearTimeout(timer);
   timer = setTimeout(dismiss, ms);
  };
  toast.restartTimer = startTimer;
  toast.querySelector('.cm-toast-close')?.addEventListener('click', (e) => {
   e.stopPropagation();
   dismiss();
  });
  toast.addEventListener('mouseenter', () => clearTimeout(timer));
  toast.addEventListener('mouseleave', () => startTimer(2500));
  startTimer(error ? 6500 : 4500);
  container.appendChild(toast);
  activeToast = toast;
 }
 const status = (text, error = false) => {
  const el = $('cm-status');
  if (el) {
   el.textContent = text;
   el.classList.toggle('error', error);
  }
  if (text && text.trim()) {
   showToast(text, error);
  }
 };
 const on=(id,event,fn)=>{const el=$(id);if(!el)return;el.addEventListener(event,e=>{try{Promise.resolve(fn(e)).catch(err=>status(err.message,true));}catch(err){status(err.message,true);}});};
 async function api(route,{method='GET',data,body,signal,query=''}={}){
  const res=await fetch('/api/creo/'+route+query,{method,headers:{'X-Creo-Token':token,...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):body,signal});
  let out;try{out=await res.json();}catch{throw Error('Локальный обработчик вернул некорректный ответ ('+res.status+').');}
  if(!res.ok)throw Error(out.error||'Ошибка локального обработчика.');return out;
 }
 const mediaURL=id=>'/api/creo/media?id='+encodeURIComponent(id)+'&token='+token;
 const outputURL=(j,name,download=false)=>'/api/creo/output?job='+encodeURIComponent(j)+'&name='+encodeURIComponent(name)+'&token='+token+(download?'&download=1':'');
 const bytes=v=>v>1024**3?(v/1024**3).toFixed(2)+' ГБ':(v/1024**2).toFixed(1)+' МБ';
 const time=v=>Number.isFinite(Number(v))?Number(v).toFixed(2).replace('.',',')+' с':'—';
 const roundTime=v=>{const n=typeof v==='string'?Number(v.trim().replace(',','.')):Number(v);return Number.isFinite(n)?Math.round(n*100)/100:0;};
 const wholeTime=v=>Math.round(v)+' с';
 const plural=(n,one,few,many)=>{const a=Math.abs(n)%100,b=a%10;return n+' '+(a>10&&a<20?many:b===1?one:b>=2&&b<=4?few:many);};
 const askConfirm=(title,message,accept,danger)=>window.WorkspaceUI?.confirm?WorkspaceUI.confirm(title,message,{accept,danger}):Promise.resolve(window.confirm(title+'\n'+message));
 const previewAPI=(options,valid=()=>true)=>{const next=previewQueue.catch(()=>{}).then(()=>valid()?api('preview',options):null);previewQueue=next;return next;};

 /* ---------- Persistence and undo ---------- */
 function save(){settingsDirty=true;clearTimeout(saveTimer);setSaved('Сохраняем…');saveTimer=setTimeout(()=>persist().catch(e=>status('Настройки не сохранены: '+e.message,true)),450);}
 function setSaved(text,error=false){$('cm-saved').textContent=text;$('cm-saved').classList.toggle('error',error);}
 async function persist(){clearTimeout(saveTimer);try{await workspaceStore.setting('creoWorkspace',structuredClone(workspace));}catch(e){setSaved('Не сохранено',true);throw e;}settingsDirty=false;setSaved('Сохранено');}
 const snapshot=()=>({settings:workspace.settings,selected:workspace.selected,tails:workspace.tails,music:workspace.music,tailMusic:workspace.tailMusic,edits:workspace.edits,hiddenInputs:workspace.hiddenInputs||[]});
 /** Records the state BEFORE a change. Repeated keyboard nudges with the same key within 1.5 s form one undo step. */
 function checkpoint(label,key=''){const now=Date.now();if(key&&lastCheckpoint.key===key&&now-lastCheckpoint.time<1500){lastCheckpoint.time=now;return;}lastCheckpoint={key,time:now};history.push(label,snapshot());updateUndo();}
 function updateUndo(){const b=$('cm-undo');b.disabled=!history.size||busyEditing();const label=history.peek();b.setAttribute('aria-label',label?'Отменить: '+label:'Отменить последнее изменение');b.dataset.tooltip=(label?'Отменить: '+label:'Нечего отменять')+' · Ctrl+Z';}
 const busyEditing=()=>!!drag;
 async function undo(){const step=history.pop();if(!step){status('Нечего отменять.');return;}Object.assign(workspace,step.state);lastCheckpoint={key:'',time:0};settingsHTML();renderFiles();renderLibrary();updateMode();if(current&&refs.has(current.id))loadEditorValues();save();schedulePreview();updateUndo();status('Отменено: '+step.label+'.');}

 /* ---------- Derived state ---------- */
 const visibleInputs=()=>media.filter(m=>m.kind==='inputs'&&!(workspace.hiddenInputs||[]).includes(m.id));
 const selectedMedia=()=>workspace.selected.map(id=>refs.get(id)).filter(Boolean);
 const isImage=m=>P.isImage(m);
 const durationOf=m=>m?.probe?.duration;
 function edit(){if(!current?.probe)return null;const duration=current.probe.duration;const e=workspace.edits[current.id] ||= {start:0,end:duration,strength:18,zones:[],time:0};e.end=P.trimEnd(e.end,duration);return e;}
 const hasEdit=id=>{const e=workspace.edits[id],m=refs.get(id);if(!e)return false;const d=roundTime(durationOf(m));return e.zones?.length>0||roundTime(e.start)>0||(d&&roundTime(e.end)<d-.01);};
 function plan(){return P.planBatch({settings:workspace.settings,inputs:selectedMedia().map(m=>({id:m.id,name:m.name,image:isImage(m),duration:durationOf(m)})),edits:workspace.edits,tails:workspace.tails,music:workspace.music});}
 const matchedPreset=()=>P.matchUserPreset(workspace.settings,workspace.userPresets);

 /* ---------- Settings column ---------- */
 const settingIcons={
  uniqueNoise:'grain',hue:'palette',saturation:'drop',contrast:'contrast',brightness:'sun',speed:'gauge',
  jpeg:'scene',zoom:'zoom',rotate:'rotate',blur:'focus',pitch:'music',
  gamma:'curve',vignette:'vignette',colorShift:'channels',pixelation:'grid',textureOpacity:'texture',tone:'moon',
  outputFps:'film',signalLevel:'volume',signalPitch:'waveform',signalCrop:'crop',crf:'target',preset:'clock',threads:'layers'
 };
 const profileVectors={
  light:'<svg class="cm-profile-vec" viewBox="0 0 36 36" fill="none" aria-hidden="true"><rect x="1" y="1" width="34" height="34" rx="7" fill="currentColor" fill-opacity="0.04" stroke="currentColor" stroke-opacity="0.16"/><path d="M8 24c4-1.5 6.5-10 11.5-10 4 0 5.5 3.5 8.5-2" stroke="currentColor" stroke-opacity="0.8" stroke-width="1.5" stroke-linecap="round"/><circle cx="13" cy="14" r="2.2" stroke="currentColor" stroke-opacity="0.55" stroke-width="1.2"/></svg>',
  medium:'<svg class="cm-profile-vec" viewBox="0 0 36 36" fill="none" aria-hidden="true"><rect x="1" y="1" width="34" height="34" rx="7" fill="currentColor" fill-opacity="0.04" stroke="currentColor" stroke-opacity="0.16"/><rect x="8" y="9" width="20" height="18" rx="3" transform="rotate(-4 18 18)" stroke="currentColor" stroke-opacity="0.45" stroke-width="1.2"/><path d="M11 22l4.5-5 4.5 3.5 5.5-6.5" stroke="currentColor" stroke-opacity="0.85" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  heavy:'<svg class="cm-profile-vec" viewBox="0 0 36 36" fill="none" aria-hidden="true"><rect x="1" y="1" width="34" height="34" rx="7" fill="currentColor" fill-opacity="0.04" stroke="currentColor" stroke-opacity="0.16"/><rect x="7" y="10" width="17" height="16" rx="2.5" stroke="currentColor" stroke-opacity="0.3" stroke-width="1.2"/><rect x="12" y="10" width="17" height="16" rx="2.5" stroke="currentColor" stroke-opacity="0.75" stroke-width="1.3"/><path d="M15 21l3.5-4.5 3.5 3 4-5" stroke="currentColor" stroke-opacity="0.9" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  hardcore:'<svg class="cm-profile-vec" viewBox="0 0 36 36" fill="none" aria-hidden="true"><rect x="1" y="1" width="34" height="34" rx="7" fill="currentColor" fill-opacity="0.04" stroke="currentColor" stroke-opacity="0.16"/><g fill="currentColor"><rect x="8" y="8" width="5" height="5" rx="1" fill-opacity="0.75"/><rect x="15.5" y="8" width="5" height="5" rx="1" fill-opacity="0.25"/><rect x="23" y="8" width="5" height="5" rx="1" fill-opacity="0.55"/><rect x="8" y="15.5" width="5" height="5" rx="1" fill-opacity="0.25"/><rect x="15.5" y="15.5" width="5" height="5" rx="1" fill-opacity="0.8"/><rect x="23" y="15.5" width="5" height="5" rx="1" fill-opacity="0.3"/><rect x="8" y="23" width="11" height="4" rx="1" fill-opacity="0.65"/><rect x="21" y="23" width="7" height="4" rx="1" fill-opacity="0.35"/></g></svg>'
 };
 const metadataIcons={subtitle:'type',description:'list',synopsis:'book',keywords:'tag',genre:'flag',comment:'social',language:'globe',artist:'portrait',copyright:'lock'};
 const settingRow=(glyph,label,control)=>`<label class="cm-setting-row"><span class="cm-setting-label">${icon(glyph)}<span>${esc(label)}</span></span>${control}</label>`;
 $('cm-style-presets').innerHTML=P.presets.map(p=>`<button type="button" class="cm-style-preset" data-cm-profile="${p.id}" aria-pressed="false">${profileVectors[p.id]||''}<div class="cm-profile-info"><span aria-hidden="true">${p.icon}</span><strong>${p.label}</strong></div></button>`).join('');
 function syncCopyPills(){
  const c=workspace.settings.copies;
  document.querySelectorAll('[data-quick-copy]').forEach(b=>{const active=Number(b.dataset.quickCopy)===c;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
 }
 function syncScaleUI(){
  const s=workspace.settings.scale||'crop';
  document.querySelectorAll('[data-scale]').forEach(b=>{const active=b.dataset.scale===s;b.classList.toggle('active',active);b.setAttribute('aria-checked',String(active));});
  if($('cm-scale'))$('cm-scale').value=s;
 }
 function showTailDuration(seconds){
  const mins=Math.floor(seconds/60),rest=seconds%60;
  const label=mins?mins+' мин'+(rest?' '+rest+' с':''):rest+' с';
  $('cm-tail-duration-val').textContent=label;
  $('cm-tail-slider').setAttribute('aria-valuetext',label);
 }
 function syncTailPills(){
  const sec=workspace.settings.tailSeconds||60;
  document.querySelectorAll('[data-quick-tail]').forEach(b=>{
   const active=Number(b.dataset.quickTail)===sec;
   b.classList.toggle('active',active);
   b.setAttribute('aria-pressed',String(active));
  });
  $('cm-tail-slider').value=sec;
  showTailDuration(sec);
 }
 function configurePlatform(){
  const isMac=platform==='darwin'||/macintosh|mac os x/i.test(navigator.userAgent);
  document.documentElement.classList.toggle('is-mac',isMac);
  const select=$('cm-acceleration');
  for(const option of select.options){
    if(option.value==='auto'||option.value==='cpu'){
      option.hidden=false;option.disabled=false;
    }else if(option.value==='apple'){
      option.hidden=!isMac;option.disabled=!isMac;
    }else{
      option.hidden=isMac;option.disabled=isMac;
    }
  }
  $('cm-detect-gpu').hidden=false;
  $('cm-undo').dataset.tooltip=isMac?'Отменить · ⌘Z':'Отменить · Ctrl+Z';
  if(isMac){
    $('cm-hardware').textContent='Аппаратное ускорение Apple VideoToolbox (Apple Silicon / Intel)';
  }else{
    $('cm-hardware').textContent='Кодирование и аппаратное декодирование — GPU. Монтажные фильтры, звук и изображения — CPU.';
  }
 }
 function settingsHTML(){const s=workspace.settings;
  const number=(key,label,min,max,step=1)=>settingRow(settingIcons[key],label,`<input data-cm-setting="${key}" type="number" min="${min}" max="${max}" step="${step}" value="${esc(s[key])}">`);
  const select=(key,label,options)=>settingRow(settingIcons[key],label,`<select data-cm-setting="${key}">${options.map(([v,text])=>`<option value="${v}" ${s[key]===v?'selected':''}>${text}</option>`).join('')}</select>`);
  $('cm-pro-fields').innerHTML=P.fields.filter(([key])=>key!=='outputFps'&&!key.startsWith('signal')).map(args=>number(...args)).join('')+select('tone','Тонирование',Object.entries(P.tones));profileStatus();
  $('cm-verification-fields').innerHTML=P.fields.filter(([key])=>key==='outputFps'||key.startsWith('signal')).map(args=>number(...args)).join('');
  $('cm-signal-change').checked=s.signalChange;$('cm-verify-results').checked=s.verifyResults;
  $('cm-quality').innerHTML=number('crf','Качество CRF / QP · меньше = лучше',0,51)+select('preset','Скорость CPU-кодирования',['ultrafast','superfast','veryfast','faster','fast','medium','slow'].map(v=>[v,v]))+number('threads','Потоков процессора (0 = авто)',0,32);
  $('cm-formats').innerHTML=Object.entries(formatLabels).map(([key,label])=>{const [w,h]=P.formats[key]||[];return `<label class="cm-format"><input type="checkbox" data-format="${key}" ${s.formats.includes(key)?'checked':''}><span class="cm-ratio" data-ratio="${key}" aria-hidden="true"></span><strong>${key}</strong><small>${label}</small><em class="cm-format-dim">${w}×${h}</em></label>`;}).join('');
  $('cm-preview-format').value=s.previewFormat||'';if($('cm-scale'))$('cm-scale').value=s.scale;syncScaleUI();$('cm-noise').checked=s.noise;$('cm-bitrate-enabled').checked=s.bitrateEnabled;$('cm-bitrate').value=s.bitrate;$('cm-tailmix').checked=s.tailmix;$('cm-music-mix').checked=s.musicMix!==false;$('cm-tail-seconds').value=s.tailSeconds;$('cm-fade').value=s.fade;
  $('cm-unique-fields').innerHTML=[['uniqueNoise','Шум',0,15,1],['hue','Оттенок ±',0,10,.1],['saturation','Насыщенность',.95,1.1,.01],['contrast','Контраст',.95,1.1,.01],['brightness','Яркость',-.1,.1,.01],['speed','Скорость ± %',0,5,1],['jpeg','Качество JPEG',80,100,1],['zoom','Зум до %',0,5,.1],['rotate','Поворот ± °',0,5,.1],['blur','Размытие / резкость',0,5,.1],['pitch','Тон аудио ± %',0,30,1]].map(args=>number(...args)).join('');
  $('cm-copy-value').textContent=s.copies;syncCopyPills();$('cm-flip').checked=s.flip;$('cm-metadata').checked=s.metadata;$('cm-acceleration').value=s.acceleration||'auto';$('cm-name-tag').value=s.nameTag||'';
  $('cm-country').value=s.country;$('cm-metadata-title').value=s.metadataTitle;$('cm-meta-status').textContent='';metadataFields();
  updateTailFields();renderPresets();updateNameExample();
 }
 function profileStatus(){const p=P.match(workspace.settings),description=$('cm-profile-description');
  description.textContent=p?.description||'';description.hidden=workspace.settings.mode!=='unique'||!p;
  document.querySelectorAll('[data-cm-profile]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.cmProfile===p?.id)));}
 function updateTailFields(){const s=workspace.settings,unique=s.mode==='unique',off=unique||!s.tailmix,musicOn=s.musicMix!==false;
  for(const id of ['cm-tail-seconds','cm-fade'])$(id).disabled=off;$('cm-tail-fields').classList.toggle('is-off',off);
  if($('cm-tail-duration-control'))$('cm-tail-duration-control').hidden=off;
  syncTailPills();
  const sub=$('cm-music-mix-sub');if(sub)sub.textContent=off?'Только аудио поверх ролика, без видеохвостов':'Фоновая музыка поверх ролика и видеохвостов';
  const n=k=>workspace[k].length,seconds=s.tailSeconds;
  const length=seconds%60===0?seconds/60+' мин':seconds+' с';
  const parts=[];
  if(!unique)parts.push(s.tailmix?(n('tails')?'Хвосты '+length:'Хвосты: 0'):'Без хвостов');
  parts.push(musicOn?(off?'Только аудио: '+n('music'):'Музыка: '+n('music')):'Аудио выкл.');
  if(!unique&&s.tailmix&&musicOn&&n('tailMusic'))parts.push('для хвостов: '+n('tailMusic'));
  if($('cm-layers-summary'))$('cm-layers-summary').textContent=parts.join(' · ');}
 function updateNameExample(){const s=workspace.settings,m=current&&workspace.selected.includes(current.id)?current:selectedMedia()[0]||current;const unique=s.mode==='unique';
  $('cm-name-example').textContent=P.outputName({index:0,name:m?.name||'ролик.mp4',target:unique?1:(s.formats[0]||'9:16'),mode:s.mode,image:unique&&isImage(m),tag:s.nameTag});}
 function updateMode(){const unique=workspace.settings.mode==='unique';
  document.querySelectorAll('[data-cm-mode]').forEach(b=>{const active=b.dataset.cmMode===workspace.settings.mode;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
  $('cm-copy-control').hidden=!unique;$('cm-clean-settings').hidden=unique;$('cm-tailmix-row').hidden=unique;$('cm-unique-settings').hidden=!unique;$('cm-library').hidden=false;$('cm-preview-format').closest('label').hidden=unique;
  if($('cm-scale-box'))$('cm-scale-box').hidden=unique;
  $('cm-clean-extra').hidden=unique;$('cm-style-presets').hidden=!unique;profileStatus();syncCopyPills();syncScaleUI();syncTailPills();
  const ind=$('cm-mode-indicator');if(ind)ind.textContent=unique?'Стили и копии':'Форматы и слои';
  for(const id of ['cm-bitrate-row','cm-bitrate-field'])$(id).hidden=unique;
  $('creo-view').dataset.cmMode=workspace.settings.mode;renderFiles();updateStage();updateNameExample();updateEstimate();
 }

 on('cm-copy-count','click',()=>{
  const input=$('cm-copy-count-input');
  input.value=workspace.settings.copies;
  $('cm-copy-count-dialog').showModal();
  input.select();
 });
 on('cm-copy-count-cancel','click',()=>$('cm-copy-count-dialog').close());
 on('cm-copy-count-form','submit',event=>{
  event.preventDefault();
  const count=$('cm-copy-count-input').valueAsNumber;
  if(count!==workspace.settings.copies){
   checkpoint('количество копий');
   workspace.settings.copies=count;
   $('cm-copy-value').textContent=count;syncCopyPills();
   save();updateEstimate();
  }
  $('cm-copy-count-dialog').close();
 });
 on('cm-copy-control','click',event=>{
  const pill=event.target.closest('[data-quick-copy]');
  if(!pill)return;
  const count=Number(pill.dataset.quickCopy);
  if(count&&count!==workspace.settings.copies){
   checkpoint('количество копий');
   workspace.settings.copies=count;
   $('cm-copy-value').textContent=count;syncCopyPills();
   save();updateEstimate();
  }
 });

 /* ---------- User presets ---------- */
 function renderPresets(){const list=workspace.userPresets||[],sel=$('cm-user-preset'),chosen=list.find(p=>p.id===workspace.activePreset)?workspace.activePreset:'';
  sel.innerHTML='<option value="">— не выбран —</option>'+list.map(p=>`<option value="${esc(p.id)}">${esc(p.name)} · ${p.settings.mode==='unique'?'уник.':'Clean3'}${p.library?' · слои':''}</option>`).join('');sel.value=chosen;
  const has=!!chosen;
  $('cm-preset-bar').hidden=!list.length;$('cm-preset-manage').hidden=!has;
  for(const id of ['cm-preset-apply','cm-preset-update','cm-preset-rename','cm-preset-delete'])$(id).disabled=!has||!!presetFormMode;
  presetState();}
 function presetState(){const match=matchedPreset(),active=(workspace.userPresets||[]).find(p=>p.id===workspace.activePreset);
  $('cm-preset-state').textContent=active&&match?.id!==active.id?'Настройки отличаются от выбранного пресета.':'';}
 function openPresetForm(mode){presetFormMode=mode;const active=workspace.userPresets.find(p=>p.id===workspace.activePreset);$('cm-preset-form').hidden=false;$('cm-preset-error').textContent='';
  $('cm-preset-form-title').textContent=mode==='rename'?'Новое название':'Название пресета';$('cm-preset-library-label').hidden=mode==='rename';$('cm-preset-library').checked=false;
  $('cm-preset-name').value=mode==='rename'?active?.name||'':'Пресет '+(workspace.userPresets.length+1);$('cm-preset-confirm').textContent=mode==='rename'?'Переименовать':'Сохранить';renderPresets();$('cm-preset-name').focus();$('cm-preset-name').select();}
 function closePresetForm(){presetFormMode=null;$('cm-preset-form').hidden=true;renderPresets();}
 const layers=()=>({tails:[...workspace.tails],music:structuredClone(workspace.music),tailMusic:structuredClone(workspace.tailMusic)});
 async function submitPresetForm(){const name=$('cm-preset-name').value;let list;
  try{if(presetFormMode==='rename')list=P.renamePreset(workspace.userPresets,workspace.activePreset,name);else{const p=P.createPreset(workspace.userPresets,{name,settings:workspace.settings,library:$('cm-preset-library').checked?layers():null});list=[...workspace.userPresets,p];workspace.activePreset=p.id;}}
  catch(e){$('cm-preset-error').textContent=e.message;$('cm-preset-name').setAttribute('aria-invalid','true');$('cm-preset-name').focus();return;}
  $('cm-preset-name').removeAttribute('aria-invalid');const mode=presetFormMode;workspace.userPresets=list;closePresetForm();
  try{await persist();status(mode==='rename'?'Пресет переименован.':'Пресет «'+list.find(p=>p.id===workspace.activePreset).name+'» сохранён.');}catch(e){status('Пресет создан, но не сохранён на устройстве: '+e.message,true);}
 }
 function applyUserPreset(){const p=workspace.userPresets.find(x=>x.id===workspace.activePreset);if(!p)throw Error('Выберите пресет.');checkpoint('пресет «'+p.name+'»');
  const kinds={tails:'tails',music:'music',tailMusic:'tailMusic'};const r=P.applyPreset(workspace.settings,p,id=>refs.has(id));
  workspace.settings={...initial,...r.settings,previewFormat:workspace.settings.previewFormat};if(r.library)for(const k of Object.keys(kinds))workspace[k]=r.library[k].filter(v=>refs.get(typeof v==='string'?v:v.id)?.kind===k);
  settingsHTML();renderLibrary();updateMode();save();schedulePreview();status('Применён пресет «'+p.name+'»'+(r.missing?' · '+plural(r.missing,'слой отсутствует','слоя отсутствуют','слоёв отсутствуют')+' на этом компьютере':'')+'. Ctrl+Z — отменить.');}

 /* ---------- Sources ---------- */
 function renderFiles(){const clean=workspace.settings.mode==='clean',all=visibleInputs();
  $('cm-files').innerHTML=all.map(m=>{const image=isImage(m),skip=clean&&image,checked=workspace.selected.includes(m.id),active=current?.id===m.id;
   return `<div class="cm-file${active?' active':''}${skip&&checked?' is-skipped':''}" role="listitem" data-media-id="${m.id}"><input type="checkbox" aria-label="В пакет: ${esc(m.name)}" ${checked?'checked':''}><button type="button" class="cm-file-select" data-select-file aria-current="${active}"><strong>${esc(m.name)}</strong></button>${hasEdit(m.id)&&!image?`<span class="cm-file-flag" title="Есть обрезка или зоны размытия" aria-label="Есть монтаж">${icon('crop')}</span>`:''}${skip?'<span class="cm-badge" title="В режиме Clean3 изображения пропускаются">только уник.</span>':''}<button type="button" class="icon-button cm-file-remove" data-remove-file title="Удалить файл" aria-label="Удалить ${esc(m.name)}">${icon('close')}</button></div>`;}).join('');
  const hidden=media.filter(m=>m.kind==='inputs'&&(workspace.hiddenInputs||[]).includes(m.id)).length;
  const toggleBtn=$('cm-toggle-all-files');
  if(toggleBtn){toggleBtn.hidden=!all.length;const allChecked=all.length>0&&all.every(m=>workspace.selected.includes(m.id));toggleBtn.textContent=allChecked?'Снять все':'Выбрать все';}
  $('cm-source-actions').hidden=!all.length&&!hidden;
  $('cm-empty-list').disabled=!all.length;$('cm-restore-list').disabled=!hidden;
  $('cm-restore-list').lastChild.textContent='Вернуть из библиотеки'+(hidden?' · '+hidden:'');
  $('cm-drop').classList.toggle('is-empty',!all.length);
  updateEstimate();}
 async function upload(files,kind){if(importTask)throw Error('Дождитесь добавления предыдущих файлов.');uploadController=new AbortController();importTask=uploadFiles(files,kind,uploadController.signal).finally(()=>{importTask=null;uploadController=null;updateEstimate();});updateEstimate();return importTask;}
 async function uploadFiles(files,kind,signal){const exts=kind==='inputs'?/\.(mp4|mov|avi|mkv|webm|jpg|jpeg|png|webp|bmp|tiff)$/i:kind==='tails'?/\.(mp4|mov|avi|mkv|webm)$/i:/\.(mp3|wav|aac|m4a|ogg|flac)$/i;
  const selected=[...files].filter(f=>exts.test(f.name));if(!selected.length)throw Error('Нет подходящих медиафайлов.');let added=0,last=null;const failed=[];
  for(const file of selected){status(`Копирование на этот компьютер: ${added+failed.length+1}/${selected.length} · ${file.name}`);
   try{const m=await api('upload?kind='+kind+'&name='+encodeURIComponent(file.name),{method:'POST',body:file,signal});media.push(m);refs.set(m.id,m);added++;last=m;if(kind==='inputs')workspace.selected.push(m.id);else workspace[kind].push(kind==='tails'?m.id:{id:m.id,volume:8});await persist();}
   catch(e){if(signal.aborted)throw e;failed.push(file.name+': '+e.message);}}
  renderFiles();renderLibrary();
  if(failed.length)status('Добавлено '+added+' из '+selected.length+'. Не добавлены: '+failed.slice(0,3).join('; '),true);else status('');
  // The import ends here; the first preview renders independently and never holds the run button.
  if(kind==='inputs'&&last)selectFile(last.id).catch(e=>status(e.message,true));}

 /* ---------- Editor ---------- */
 const compactPreview=matchMedia('(max-width:600px)');
 function setCompactPreview(expanded){
  $('cm-editor').dataset.compactPreview=expanded?'open':'closed';
  const toggle=$('cm-preview-toggle'),label=expanded?'Свернуть предпросмотр':'Показать предпросмотр';
  toggle.setAttribute('aria-expanded',String(expanded));
  toggle.setAttribute('aria-label',label);toggle.title=label;
 }
 on('cm-preview-toggle','click',()=>setCompactPreview($('cm-editor').dataset.compactPreview!=='open'));
 const previewStatus=(message='')=>{$('cm-preview-status').textContent=message;};
 function updateStage(){const unique=workspace.settings.mode==='unique',image=current&&isImage(current),cleanImage=!unique&&image;
  $('cm-edit-controls').hidden=unique||!!image;$('cm-scrub').hidden=!!image;
  const qm=$('cm-quick-montage');if(qm)qm.hidden=unique||!!image;
  $('cm-compare').dataset.view=cleanImage?'source':workspace.view||'result';
  $('cm-image-note').hidden=!cleanImage;if(cleanImage)$('cm-image-note').innerHTML='Изображения не обрабатываются в Clean3 и будут пропущены. <button type="button" class="cm-text-button" data-switch-mode="unique">Перейти к уникализации</button>';
  document.querySelectorAll('[data-cm-view]').forEach(b=>{b.setAttribute('aria-pressed',String(b.dataset.cmView===(workspace.view||'result')));b.disabled=cleanImage;});
  $('cm-preview-empty').hidden=!!current;$('cm-stage').hidden=!current;
  if(!current){$('cm-selected-name').textContent='';setCompactPreview(false);previewStatus();}
  updateTrimUI();updateCropGuide();}
 function trimEndDisplay(end,duration){return end===duration&&duration>=1?Math.round(duration):roundTime(end);}
 function loadEditorValues(){const e=edit();if(!e)return;$('cm-start').value=roundTime(e.start);$('cm-end').value=trimEndDisplay(e.end,current.probe.duration);$('cm-strength').value=e.strength;$('cm-seek').value=e.time||0;$('cm-position').textContent=time(e.time||0);renderZones();updateTrimUI();}
 async function selectFile(id,{showEditor=false}={}){const serial=++previewSerial;frameReady=false;drag=null;closeCopyPanel();$('cm-zones').replaceChildren();$('cm-drawing').hidden=true;$('cm-frame').hidden=true;$('cm-source-frame').hidden=true;
  current=refs.get(id);if(!current)return;renderFiles();$('cm-selected-name').textContent=current.name;const selected=current;
  if(!selected.probe)selected.probe=await api('probe',{method:'POST',data:{id}});if(serial!==previewSerial)return;
  if(!current.probe.width)throw Error('Файл не содержит изображения.');
  const fps=current.probe.frameRate||30;$('cm-seek').max=current.probe.duration;$('cm-seek').step=String(Math.max(.001,Math.round(1000/fps)/1000));$('cm-seek').disabled=current.probe.image;
  loadEditorValues();updateStage();
  if(showEditor){if(compactPreview.matches)setCompactPreview(true);$('cm-editor').scrollIntoView({block:'nearest'});}
  if(!current.probe.image)$('cm-original').src=mediaURL(id);else{$('cm-original').pause();$('cm-original').removeAttribute('src');}
  $('cm-timeline').hidden=true;$('cm-original').hidden=current.probe.image;$('cm-original-image').hidden=!current.probe.image;if(current.probe.image)$('cm-original-image').src=mediaURL(id);
  updateNameExample();await preview();
  if(current?.id===id&&!current.probe.image&&workspace.settings.mode==='clean'&&!busy){try{const key=id+':'+(workspace.settings.previewFormat||workspace.settings.formats[0])+':'+workspace.settings.scale;let image=timelineCache.get(key);
   if(!image){const p=await previewAPI({method:'POST',data:{id,settings:structuredClone(workspace.settings),timeline:true}},()=>current?.id===id&&visible);if(!p)return;image=await readPreview(p.id);timelineCache.set(key,image);if(timelineCache.size>20)timelineCache.delete(timelineCache.keys().next().value);}
   if(current?.id===id&&token){$('cm-timeline').src=image;$('cm-timeline').hidden=false;}}catch(e){status(e.message,true);}}
 }
 async function readPreview(id){const res=await fetch('/api/creo/preview-image?id='+id+'&token='+token);if(!res.ok)throw Error('Кадр недоступен. Нажмите «Обновить кадр».');const blob=await res.blob();
  const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(blob);});const image=new Image();image.src=data;await image.decode();if(!image.naturalWidth)throw Error('Пустое изображение кадра');return data;}
 function schedulePreview(){clearTimeout(previewTimer);if(!current||busy)return;previewStatus('Обновляем кадр…');previewTimer=setTimeout(()=>preview().catch(e=>status(e.message,true)),350);}
 const targetFormat=()=>workspace.settings.previewFormat||workspace.settings.formats[0];
 async function preview(){
  if(!current||!current.probe)return;if(busy){previewStatus('Кадр обновится после обработки');return;}
  const id=current.id,serial=++previewSerial,t=edit()?.time||0,cleanImage=workspace.settings.mode==='clean'&&isImage(current);frameReady=false;
  previewStatus($('cm-frame').hidden?'Загружаем кадр…':'Обновляем кадр…');
  const valid=()=>serial===previewSerial&&current?.id===id&&!!token;
  try{
   if(!cleanImage){const r=await previewAPI({method:'POST',data:structuredClone({id,settings:workspace.settings,edit:edit(),time:t})},valid);if(!r||!valid())return;
    const image=await readPreview(r.id);if(!valid())return;$('cm-frame').src=image;$('cm-frame').hidden=false;
    const ratio=workspace.settings.mode==='clean'?targetFormat().split(':').map(Number):[current.probe.width,current.probe.height];$('cm-frame-wrap').style.setProperty('--ar',ratio[0]+'/'+ratio[1]);$('cm-frame-wrap').classList.toggle('cm-wide',ratio[0]>ratio[1]);
    frameReady=true;renderZones();}
   if(cleanImage||workspace.view==='split')await sourcePreview(id,t,valid);
   if(!valid())return;
   previewStatus();$('cm-position').textContent=time(t);updateCaptions();
  }catch(error){if(serial===previewSerial){previewStatus('Кадр недоступен');status(error.message,true);}throw error;}
 }
 async function sourcePreview(id,t,valid){let image;const m=refs.get(id);
  if(isImage(m))image=mediaURL(id);else{const key=id+':'+t.toFixed(3);image=sourceCache.get(key);if(!image){const r=await previewAPI({method:'POST',data:{id,settings:{},source:true,time:t}},valid);if(!r||!valid())return;image=await readPreview(r.id);sourceCache.set(key,image);if(sourceCache.size>30)sourceCache.delete(sourceCache.keys().next().value);}}
  if(!valid())return;$('cm-source-frame').src=image;$('cm-source-frame').hidden=false;$('cm-source-wrap').style.setProperty('--ar',m.probe.width+'/'+m.probe.height);updateCropGuide();}
 function updateCaptions(){if(!current?.probe)return;const s=workspace.settings,f=targetFormat(),[w,h]=P.formats[f]||[];
  $('cm-source-caption').textContent='До · '+current.probe.width+'×'+current.probe.height;
  $('cm-result-caption').textContent=s.mode==='unique'?'После · пример варианта':'После · '+f+' · '+w+'×'+h+' · '+scaleLabels[s.scale];}
 /** Shows on the original frame which area survives the selected format (crop) or that bars/stretch are used. */
 function updateCropGuide(){const g=$('cm-crop-guide');if(!current?.probe?.width||workspace.settings.mode!=='clean'){g.hidden=true;return;}
  const [fw,fh]=targetFormat().split(':').map(Number),W=current.probe.width,H=current.probe.height,target=fw/fh,src=W/H,s=workspace.settings.scale;g.hidden=false;g.dataset.scale=s;
  if(s==='crop'){let w=1,h=1;if(src>target)w=target/src;else h=src/target;Object.assign(g.style,{left:(1-w)/2*100+'%',top:(1-h)/2*100+'%',width:w*100+'%',height:h*100+'%'});g.textContent=Math.abs(w*h-1)<.005?'Кадр целиком':'Остаётся в кадре '+targetFormat();}
  else{Object.assign(g.style,{left:'0',top:'0',width:'100%',height:'100%'});g.textContent=s==='letterbox'?(Math.abs(src-target)<.01?'Кадр целиком':'Целиком + поля'):'Растягивается до '+targetFormat();}}
 function updateTrimUI(){const e=edit(),d=current?.probe?.duration;if(!e||!d||current.probe.image){$('cm-trim-length').textContent='';return;}
  Object.assign($('cm-trim-range').style,{left:e.start/d*100+'%',width:Math.max(0,(e.end-e.start)/d*100)+'%'});$('cm-playhead').style.left=Math.min(100,(e.time||0)/d*100)+'%';
  const len=e.end-e.start,s=workspace.settings,hasAudio=s.musicMix!==false&&workspace.music.length>0;
  $('cm-trim-length').textContent=s.mode==='unique'?'Длительность '+wholeTime(d)+(hasAudio?' · с аудио':''):'Фрагмент '+(e.start===0&&e.end===d&&d>=1?wholeTime(len):time(len))+(s.tailmix?' · с хвостами '+wholeTime(len+s.tailSeconds):hasAudio?' · только аудио':'');}
 function setTime(t){const e=edit();if(!e)return;const d=current.probe.duration;e.time=Math.max(0,Math.min(d,roundTime(t)));$('cm-seek').value=e.time;$('cm-position').textContent=time(e.time);updateTrimUI();save();schedulePreview();}
 function stepFrame(dir){if(!current?.probe||current.probe.image)return;setTime((edit().time||0)+dir/(current.probe.frameRate||30));}
 function setTrim(key,value){const e=edit(),d=current.probe.duration,rounded=roundTime(value),v=key==='end'?P.trimEnd(rounded,d):rounded;
  const start=key==='start'?v:e.start,end=key==='end'?v:e.end;
  if(v<0||v>d)throw Error('Время должно быть от 0 до '+time(d)+'.');
  if(end-start<Math.min(d,.05)-1e-9)throw Error(key==='start'?'Начало должно быть раньше конца хотя бы на 0,05 с.':'Конец должен быть позже начала хотя бы на 0,05 с.');
  checkpoint(key==='start'?'начало фрагмента':'конец фрагмента');e[key]=v;$('cm-'+key).value=key==='end'?trimEndDisplay(v,d):v;$('cm-'+key).setCustomValidity('');updateTrimUI();save();renderFiles();updatePlanIfOpen();}
 function renderZones(){const e=edit();$('cm-zones').replaceChildren();if(!e||workspace.settings.mode==='unique'||isImage(current))return;
  for(const [i,z]of e.zones.entries()){const rect=document.createElement('div');rect.className='cm-zone';rect.dataset.zone=i;rect.tabIndex=0;rect.setAttribute('role','group');rect.setAttribute('aria-label','Зона '+(i+1)+'. Перетаскивание или стрелки; Delete — удалить');rect.style.setProperty('--zone-color','hsl('+Math.round(i*137.5%360)+' 80% 65%)');
   rect.innerHTML='<span class="cm-zone-label">'+(i+1)+'</span><button type="button" class="cm-zone-remove" aria-label="Удалить зону '+(i+1)+'">×</button>'+['nw','ne','sw','se'].map(v=>'<span class="cm-zone-handle '+v+'" data-resize="'+v+'"></span>').join('');
   Object.assign(rect.style,{left:z.x*100+'%',top:z.y*100+'%',width:z.w*100+'%',height:z.h*100+'%'});rect.querySelector('button').onclick=event=>{event.stopPropagation();if(busy)return;checkpoint('удаление зоны');e.zones.splice(i,1);save();renderZones();renderFiles();schedulePreview();};$('cm-zones').append(rect);}
  $('cm-zone-count').textContent=plural(e.zones.length,'зона','зоны','зон');
  const qClear=$('cm-quick-clear-zones');if(qClear){qClear.hidden=!e.zones.length;qClear.lastChild.textContent='Очистить блюр ('+e.zones.length+')';}}

 /* ---------- Copy current edit to the batch ---------- */
 const copyTargets=()=>selectedMedia().filter(m=>m.id!==current?.id&&!isImage(m));
 function openCopyPanel(){if(!current)return;const targets=copyTargets();$('cm-copy-panel').hidden=false;$('cm-copy-edit').setAttribute('aria-expanded','true');
  $('cm-copy-targets').textContent=targets.length?'Изменятся '+plural(targets.length,'видео','видео','видео')+': '+targets.slice(0,4).map(m=>m.name).join(', ')+(targets.length>4?' и ещё '+(targets.length-4):'')+'. Монтаж других файлов не затрагивается.':'Отметьте в списке исходников другие видео — монтаж копируется только на них.';
  $('cm-copy-apply').disabled=!targets.length;$('cm-copy-trim').focus();}
 function closeCopyPanel(){$('cm-copy-panel').hidden=true;$('cm-copy-edit').setAttribute('aria-expanded','false');}
 async function applyCopy(){const trim=$('cm-copy-trim').checked,zones=$('cm-copy-zones').checked;if(!trim&&!zones)throw Error('Выберите, что копировать.');const from=structuredClone(edit()),targets=copyTargets();if(!targets.length)return;
  for(const m of targets)if(!m.probe)m.probe=await api('probe',{method:'POST',data:{id:m.id}});
  checkpoint('монтаж на '+plural(targets.length,'файл','файла','файлов'));for(const m of targets)workspace.edits[m.id]=P.copyEdit(from,m.probe.duration,{trim,zones},workspace.edits[m.id]);
  closeCopyPanel();save();renderFiles();updatePlanIfOpen();status('Монтаж применён к '+plural(targets.length,'видео','видео','видео')+'. Обрезка ограничена длиной каждого файла. Ctrl+Z — отменить.');}

 /* ---------- Library (tails/music) ---------- */
 const inlineAudio=new Audio();let playingTrackKey=null;
 const previewTrackVolume=pct=>{const v=Number(pct??8);return !Number.isFinite(v)?0.35:v<=0?0:Math.min(1,Math.max(0.25,v/100));};
 function syncPlayingButtons(){
  const lib=$('cm-library');if(!lib)return;
  for(const btn of lib.querySelectorAll('[data-play-track]')){
   const row=btn.closest('[data-track-id]');
   const active=!!row&&playingTrackKey===row.dataset.kind+':'+row.dataset.trackId&&!inlineAudio.paused;
   btn.classList.toggle('is-playing',active);
   btn.setAttribute('aria-pressed',String(active));
   btn.innerHTML=icon(active?'pause':'play');
  }
 }
 function stopInlineAudio(){
  playingTrackKey=null;
  inlineAudio.pause();
  inlineAudio.removeAttribute('src');
  inlineAudio.load();
  syncPlayingButtons();
 }
 function toggleInlineAudio(kind,id,url,rawVolume,name=''){
  const key=kind+':'+id;
  if(playingTrackKey===key&&!inlineAudio.paused){stopInlineAudio();status('');return;}
  if($('cm-player-dialog')?.open)$('cm-player-dialog').close();
  playingTrackKey=key;
  inlineAudio.volume=previewTrackVolume(rawVolume);
  inlineAudio.src=url;
  syncPlayingButtons();
  inlineAudio.play().then(()=>{
   syncPlayingButtons();
   if(name)status('Прослушивание: '+name+' (нажмите повторно для паузы или выберите другой трек)');
  }).catch(()=>{
   stopInlineAudio();
   status('Не удалось воспроизвести аудиофайл.',true);
  });
 }
 inlineAudio.addEventListener('ended',()=>{stopInlineAudio();status('');});
 inlineAudio.addEventListener('pause',()=>{if(!inlineAudio.ended)syncPlayingButtons();});
 inlineAudio.addEventListener('play',syncPlayingButtons);

 /* ---------- Assets Download Banner ---------- */
 function updateAssetsProgressUI(p){
  const banner=$('cm-assets-banner'),btn=$('cm-assets-download-btn'),lbl=$('cm-assets-download-label'),wrap=$('cm-assets-progress-wrap'),bar=$('cm-assets-progress-bar'),st=$('cm-assets-progress-status'),pct=$('cm-assets-progress-percent');
  if(!banner)return;
  if(!p||p.status==='idle'){wrap.hidden=true;if(btn)btn.disabled=false;if(lbl)lbl.textContent='Скачать библиотеку (1.2 ГБ)';return;}
  wrap.hidden=false;if(btn)btn.disabled=true;
  if(bar)bar.value=p.percent||0;
  if(pct)pct.textContent=(p.percent||0)+'%';
  if(st)st.textContent=p.message||(p.status==='extracting'?'Распаковка файлов в библиотеку…':'Скачивание библиотеки…');
  if(p.status==='ready'){
   setTimeout(()=>{wrap.hidden=true;banner.hidden=true;},1500);
   status('Библиотека успешно установлена и готова к работе!');
   refreshLibrary();
  }else if(p.status==='error'){
   if(btn)btn.disabled=false;
   if(st)st.textContent='Ошибка скачивания: '+(p.error||'сбой сети');
   status('Не удалось скачать библиотеку: '+(p.error||'сбой сети'),true);
  }
 }
 async function checkAssetsStatus(){
  const hasBuiltin=media.some(m=>m.builtin);
  const banner=$('cm-assets-banner');if(!banner)return;
  if(hasBuiltin){banner.hidden=true;return;}
  try{
   const s=await api('assets-status');
   if(s.installed){banner.hidden=true;return;}
   banner.hidden=false;
   if(s.downloading&&s.progress)updateAssetsProgressUI(s.progress);
  }catch{}
 }
 async function triggerAssetsDownload(){
  const btn=$('cm-assets-download-btn');if(btn)btn.disabled=true;
  updateAssetsProgressUI({status:'connecting',percent:0,message:'Подключение к GitHub…'});
  try{
   const r=await api('assets-download',{method:'POST',data:{}});
   if(r.progress)updateAssetsProgressUI(r.progress);
  }catch(e){
   if(btn)btn.disabled=false;
   updateAssetsProgressUI({status:'error',error:e.message});
  }
 }

 /* ---------- Output Directory Settings ---------- */
 let currentOutputRoot='',defaultOutputRoot='',isCustomOutput=false;
 function updateOutputDirUI(root,defRoot,isCustom){
  if(root)currentOutputRoot=root;
  if(defRoot)defaultOutputRoot=defRoot;
  if(typeof isCustom==='boolean')isCustomOutput=isCustom;
  else isCustomOutput=Boolean(currentOutputRoot&&defaultOutputRoot&&currentOutputRoot!==defaultOutputRoot);
  const text=$('cm-output-dir-text'),rootEl=$('cm-root-path'),resetBtn=$('cm-reset-dir-btn');
  if(text){text.textContent=currentOutputRoot;text.title=currentOutputRoot;}
  if(rootEl){
   const full=String(currentOutputRoot||''),parts=full.split(/[\\/]/).filter(Boolean);
   rootEl.textContent=parts.length>3?'…'+full.slice(full.length-parts.slice(-3).join('/').length-1):full;
   rootEl.title='Папка вывода: '+full;
   rootEl.dataset.full=full;
  }
  if(resetBtn)resetBtn.hidden=!isCustomOutput;
 }
 function openOutputDirDialog(){
  const dlg=$('cm-dir-dialog'),inp=$('cm-dir-input'),hint=$('cm-dir-hint'),err=$('cm-dir-error');
  if(!dlg)return;
  if(inp)inp.value=currentOutputRoot||'';
  if(hint)hint.textContent=defaultOutputRoot?'По умолчанию: '+defaultOutputRoot:'';
  if(err){err.hidden=true;err.textContent='';}
  dlg.showModal();
  inp?.focus();
 }
 function closeOutputDirDialog(){$('cm-dir-dialog')?.close();}
 async function setOutputDir(pathVal){
  const err=$('cm-dir-error');if(err)err.hidden=true;
  try{
   const r=await api('set-output-dir',{method:'POST',data:{path:pathVal}});
   updateOutputDirUI(r.outputRoot,r.defaultOutputRoot,r.isCustom);
   closeOutputDirDialog();
   status(r.isCustom?'Папка вывода сохранена: '+r.outputRoot:'Папка вывода сброшена по умолчанию.');
  }catch(e){
   if(err){err.hidden=false;err.textContent=e.message;}
   else status(e.message,true);
   throw e;
  }
 }
 async function browseOutputDir(){
  if(window.creoDesktop?.selectDirectory){
   const picked=await window.creoDesktop.selectDirectory(currentOutputRoot||defaultOutputRoot);
   if(picked){
    const inp=$('cm-dir-input');
    if(inp&&$('cm-dir-dialog')?.open)inp.value=picked;
    else await setOutputDir(picked);
   }
   return;
  }
  try{
   const r=await api('browse-output-dir',{method:'POST',data:{}});
   if(r.path){
    const inp=$('cm-dir-input');
    if(inp&&$('cm-dir-dialog')?.open)inp.value=r.path;
    else await setOutputDir(r.path);
    return;
   }
   if(r.canceled)return;
  }catch{}
  openOutputDirDialog();
 }
 async function openRootFolder(){
  try{
   if(window.creoDesktop?.openPath&&currentOutputRoot){
    await window.creoDesktop.openPath(currentOutputRoot);
    status('Папка открыта: '+currentOutputRoot);
    return;
   }
   const r=await api('open-root-folder',{method:'POST',data:{}});
   status('Папка открыта: '+r.path);
  }catch(e){
   status('Не удалось открыть папку: '+e.message,true);
  }
 }
 window.changeOutputDir=browseOutputDir;
 window.openOutputDir=openRootFolder;

 function renderLibrary(){for(const kind of ['tails','music','tailMusic']){const selected=workspace[kind];const files=media.filter(m=>m.kind===kind);const order=new Map(selected.map((v,i)=>[typeof v==='string'?v:v.id,i]));files.sort((a,b)=>(order.get(a.id)??10000)-(order.get(b.id)??10000));
  $('cm-'+kind+'-list').innerHTML=files.map(m=>{const found=selected.find(v=>(typeof v==='string'?v:v.id)===m.id);return `<div class="cm-track" data-track-id="${m.id}" data-kind="${kind}"><input type="checkbox" aria-label="Использовать ${esc(m.name)}" ${found?'checked':''}><span class="cm-track-name" title="${esc(m.source||'Добавленный файл')}">${esc(m.name)}<small>${m.builtin?'Из CreoMaker':'На устройстве'}</small></span>${kind==='tails'?`<button type="button" class="icon-button" data-order="-1" aria-label="Переместить хвост ${esc(m.name)} выше"><span class="cm-up">${icon('chevron')}</span></button><button type="button" class="icon-button" data-order="1" aria-label="Переместить хвост ${esc(m.name)} ниже"><span class="cm-down">${icon('chevron')}</span></button>`:`<label class="cm-volume"><input type="number" min="0" max="200" value="${found?.volume??8}" aria-label="Громкость ${esc(m.name)}, %">%</label>`}<button type="button" class="icon-button" data-play-track aria-label="Прослушать или посмотреть ${esc(m.name)}">${icon('play')}</button></div>`;}).join('')||'<p class="hint">Здесь пока нет файлов.</p>';
  $('cm-'+kind+'-count').textContent=selected.length+' / '+files.length;}
  syncPlayingButtons();updateTailFields();updateEstimate();checkAssetsStatus();}

 /* ---------- Batch plan, validation and launch ---------- */
 function runBlockers(p=plan()){if(!available)return 'FFmpeg не найден — обработка недоступна.';if(importTask)return 'Дождитесь окончания добавления файлов.';if(p.blocking)return p.warnings.find(w=>w.level==='error').text;return '';}
 function updateEstimate(){if(!loaded&&!opening)return;const p=plan(),s=workspace.settings,n=p.included.length,queued=jobs.filter(j=>j.status==='queued').length;
  $('cm-estimate').textContent=p.total?'На выходе: '+plural(p.total,'файл','файла','файлов'):'';
  $('cm-plan-line').textContent=n?(s.mode==='clean'?plural(n,'видео','видео','видео')+' × '+plural(p.formats.length,'формат','формата','форматов'):plural(n,'файл','файла','файлов')+' × '+plural(p.copies,'копия','копии','копий'))+(p.skipped.length?' · пропуск фото: '+p.skipped.length:''):'';
  const sel=selectedMedia();$('cm-input-count').hidden=!sel.length;$('cm-input-count').textContent=sel.length+' выбрано';
  const reason=runBlockers(p);$('cm-run').hidden=busy;$('cm-queue').hidden=!busy;$('cm-run').textContent=s.mode==='unique'?'Создать варианты':'Создать видео';
  if((s.mode==='unique'||p.formats.length)&&$('cm-status').textContent==='Нужен хотя бы один формат.')status('');
  $('cm-run').disabled=$('cm-queue').disabled=!!reason;if($('cm-plan-open'))$('cm-plan-open').disabled=!sel.length;
  $('cm-run-reason').textContent=reason&&available&&!importTask&&!sel.length?'Сначала добавьте и выберите файлы.':reason||(queued?'В очереди: '+queued:'');
  $('cm-run-reason').classList.toggle('is-blocked',!!reason&&!!sel.length);
  updateNameExample();updateTailFields();presetState();updatePlanIfOpen(p);}
 function renderPlan(p=plan()){const s=workspace.settings,preset=matchedPreset(),hasMusic=s.musicMix!==false&&workspace.music.length>0;
  $('cm-plan-totals').innerHTML=`<strong>${plural(p.total,'файл','файла','файлов')}</strong> · ${s.mode==='clean'?'Clean3: '+esc(p.formats.join(', '))+' · '+scaleLabels[s.scale]+(s.tailmix?' · хвосты '+s.tailSeconds+' с':hasMusic?' · только аудио':' · без хвостов'):'уникализация: '+plural(p.copies,'копия','копии','копий')+(hasMusic?' · только аудио':'')}${preset?' · пресет «'+esc(preset.name)+'»':''}${p.seconds?' · видео суммарно ≈ '+Math.round(p.seconds/60*10)/10+' мин':''}`;
  $('cm-plan-warnings').innerHTML=p.warnings.map(w=>`<li class="is-${w.level}">${esc(w.text)}</li>`).join('');
  $('cm-plan-list').innerHTML=p.items.map(i=>`<details class="cm-plan-item${i.skipped?' is-skipped':''}" ${p.items.length<=4&&!i.skipped?'open':''}><summary><span>${esc(i.name)}</span><small>${i.skipped?esc(i.skipped):plural(i.outputs.length,'файл','файла','файлов')+(i.length&&!i.image?' · '+time(i.length):'')}</small></summary>${i.outputs.length?'<ul>'+i.outputs.map(n=>'<li><code>'+esc(n)+'</code></li>').join('')+'</ul>':''}</details>`).join('')||'<p class="hint">Отметьте исходники слева.</p>';
  const reason=runBlockers(p);$('cm-plan-run').disabled=!!reason;$('cm-plan-run').textContent=busy?'В очередь':s.mode==='unique'?'Создать варианты':'Создать видео';}
 function updatePlanIfOpen(p){if($('cm-plan-dialog').open)renderPlan(p||plan());}
 function validateFields(){for(const input of $('creo-view').querySelectorAll('.cm-settings input[type=number],.cm-editor input[type=number],.cm-tracks input[type=number]')){if(input.disabled||input.closest('[hidden]'))continue;if(!input.checkValidity()){if(compactPreview.matches&&input.closest('.cm-editor'))setCompactPreview(true);for(let d=input.closest('details');d;d=d.parentElement.closest('details'))d.open=true;input.reportValidity();input.focus();return false;}}return true;}
 function runFeedback(message='',tone=''){
  const field=$('cm-run-feedback');field.textContent=message;field.dataset.tone=tone;
 }
 async function run(){if(!validateFields())return;stopInlineAudio();const p=plan(),reason=runBlockers(p);if(reason){renderPlan(p);if(!$('cm-plan-dialog').open)$('cm-plan-dialog').showModal();status(reason,true);return;}
  status('');runFeedback();clearTimeout(previewTimer);await previewQueue.catch(()=>{});try{await persist();}catch(e){status('Настройки не сохранены на устройстве, но задача будет запущена: '+e.message,true);}
  const ids=new Set(p.included),edits={};for(const id of ids)if(workspace.edits[id])edits[id]=structuredClone(workspace.edits[id]);
  const request={settings:structuredClone(workspace.settings),inputs:p.included,tails:[...workspace.tails],music:structuredClone(workspace.music),tailMusic:structuredClone(workspace.tailMusic),edits,presetName:matchedPreset()?.name||''};
  const queued=busy;const j=await api('jobs',{method:'POST',data:request,query:queued?'?queue=1':''});selectedJob=j.id;jobEvent(j);if($('cm-plan-dialog').open)$('cm-plan-dialog').close();}

 /* ---------- Jobs and results ---------- */
 function jobEvent(j){const i=jobs.findIndex(v=>v.id===j.id),previous=i<0?null:jobs[i];
  if(!previous){jobs.unshift(j);}
  else if(rank(j.status)<rank(previous.status)||previous.status===j.status&&previous.progress>j.progress)j=previous;
  else jobs[i]=j;
  const was=busy;busy=jobs.some(v=>v.status==='running');
  if(previous&&previous.status!==j.status&&terminal.has(j.status)){
   if(j.status==='completed')runFeedback('Готово · '+plural(j.outputs.length,'файл','файла','файлов'),'ready');
   else runFeedback(j.error||j.label,j.status==='cancelled'?'':'error');
  }
  $('cm-cancel').disabled=!busy;renderActive();updateEstimate();renderJobs();if(was&&!busy&&current)schedulePreview();}
 function renderActive(){const j=jobs.find(v=>v.status==='running');$('cm-launch-progress').hidden=!j;if(!j)return;$('cm-active-progress').value=Math.round(j.progress*100);$('cm-active-label').textContent=Math.round(j.progress*100)+'% · '+j.outputs.length+' из '+(j.total||'?')+' · '+j.label;}
 const jobTitle=j=>(j.mode==='unique'?'Варианты':'Clean3')+' · '+new Date(j.createdAt).toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
 function jobMeta(j){const s=j.summary;if(!s)return 'Задача из прежней версии · параметры доступны через «Взять настройки».';return [s.mode==='clean'?'Форматы '+s.formats.join(', ')+' · '+(scaleLabels[s.scale]||s.scale)+(s.tailmix?' · хвосты':s.music?' · только аудио':''):plural(s.copies,'копия','копии','копий')+(s.music?' · только аудио':''),j.sources?plural(j.sources.length,'исходник','исходника','исходников'):'',s.preset?'пресет «'+s.preset+'»':'',s.nameTag?'метка '+s.nameTag:''].filter(Boolean).join(' · ');}
 /** Groups outputs by source: new jobs carry input IDs; older jobs fall back to the NNN_ name prefix. */
 function groupOutputs(j){const groups=new Map(),sources=j.sources||[];
  for(const o of j.outputs){let key=o.input,name;if(!key){const n=Number(/^(\d{3})_/.exec(o.name)?.[1]);key=sources[n-1]?.id||'#'+(n||0);}name=sources.find(s=>s.id===key)?.name||refs.get(key)?.name||(key.startsWith('#')?'Исходник '+key.slice(1):'Исходник');
   if(!groups.has(key))groups.set(key,{id:key.startsWith('#')?null:key,name,outputs:[]});groups.get(key).outputs.push(o);}
  return [...groups.values()];}
 function verificationHTML(output, job) {
  const result = output.verification;
  if (!result) return '';
  const labels = {pending:'Проверяется',verified:'Изменения подтверждены',warning:'Есть совпадения',unavailable:'Проверка не завершена'};
  const states = {changed:'Изменено',same:'Совпало',na:'Не применяется',unavailable:'Не измерено'};
  const reportURL='/api/creo/verification?job='+encodeURIComponent(job.id)+'&name='+encodeURIComponent(output.name)+'&token='+token+'&download=1';
  return '<details class="cm-verification"><summary class="cm-verification-'+esc(result.status)+'">'+esc(labels[result.status]||result.status)+'</summary>'+
   (result.error?'<p class="error">'+esc(result.error)+'</p>':'')+
   '<ul>'+(result.checks||[]).map(check=>'<li><span class="cm-check-label">'+esc(check.label)+'</span><span class="cm-check-state '+esc(check.state)+'">'+esc(states[check.state])+'</span><small>'+esc(check.message)+'</small></li>').join('')+'</ul>'+
   (result.sourceSha256?'<p>SHA-256 исходника<code>'+esc(result.sourceSha256)+'</code></p><p>SHA-256 результата<code>'+esc(result.outputSha256)+'</code></p>':'')+
   (result.report?'<a class="button small quiet" href="'+esc(reportURL)+'" download>Скачать отчёт JSON</a>':'')+'</details>';
 }
 function renderJobs(){const chosen=jobs.find(j=>j.id===selectedJob)||jobs[0],queued=jobs.filter(j=>j.status==='queued').length;
  $('cm-delivery').hidden=!chosen;
  $('cm-queue-count').hidden=!queued;$('cm-queue-count').textContent='В очереди: '+queued;
  if($('cm-clear-jobs'))$('cm-clear-jobs').disabled=!jobs.some(j=>terminal.has(j.status));
  $('cm-jobs').innerHTML=jobs.map(j=>`<button type="button" class="cm-job ${chosen?.id===j.id?'active':''}" data-job="${j.id}" aria-pressed="${chosen?.id===j.id}"><strong>${esc(jobTitle(j))}</strong><small><span class="cm-state is-${j.status}">${esc(statusLabels[j.status]||j.status)}${j.status==='queued'&&j.queuePosition?' · '+j.queuePosition:''}</span> ${j.outputs.length}${j.total?' / '+j.total:''} файлов${j.summary?.preset?' · '+esc(j.summary.preset):''}</small></button>`).join('')||'<p class="hint">Здесь появятся задачи обработки.</p>';
  if(!chosen){$('cm-job-title').textContent='Пока нет задач';for(const id of ['cm-folder','cm-export-folder','cm-delete-job','cm-reuse-job','cm-retry-job'])$(id)&&($(id).disabled=true);$('cm-job-cancel').hidden=true;return;}
  selectedJob=chosen.id;const active=chosen.status==='running'||chosen.status==='queued';
  $('cm-job-title').textContent=jobTitle(chosen)+' · '+(statusLabels[chosen.status]||chosen.status);
  if($('cm-job-meta'))$('cm-job-meta').textContent=jobMeta(chosen);
  $('cm-progress').hidden=!active;$('cm-progress').value=chosen.progress*100;
  $('cm-progress-label').textContent=chosen.status==='queued'?'Ждёт своей очереди'+(chosen.queuePosition?' · позиция '+chosen.queuePosition:''):active?Math.round(chosen.progress*100)+'% · '+chosen.label:chosen.label;
  $('cm-job-error').hidden=!chosen.error;$('cm-job-error').textContent=chosen.error?'Ошибка: '+chosen.error:'';
  $('cm-log').textContent=(chosen.logs||[]).map(l=>new Date(l.time).toLocaleTimeString('ru-RU')+'  '+l.text).join('\n')+(chosen.error?'\n'+chosen.error:'');$('cm-output-path').textContent=chosen.outputDir;
  $('cm-results').innerHTML=groupOutputs(chosen).map(g=>`<section class="cm-result-group"><header><strong>${esc(g.name)}</strong><span class="hint">${plural(g.outputs.length,'файл','файла','файлов')}</span>${g.id&&refs.has(g.id)?`<button type="button" class="cm-text-button" data-open-source="${esc(g.id)}">Открыть в редакторе</button>`:''}</header>${g.outputs.map(o=>`<div class="cm-output"><div><strong>${esc(o.name)}</strong><small>${o.width} × ${o.height} · ${bytes(o.size)}${o.duration?' · '+time(o.duration):''}</small>${verificationHTML(o,chosen)}</div><button type="button" class="icon-button" data-preview-output="${esc(o.name)}" data-source="${esc(g.id||'')}" aria-label="Посмотреть ${esc(o.name)}">${icon('eye')}</button><a class="button small quiet" href="${esc(outputURL(chosen.id,o.name,true))}" download aria-label="Скачать ${esc(o.name)}">${icon('download')}Скачать</a></div>`).join('')}</section>`).join('')||(terminal.has(chosen.status)?'<p class="hint">Готовых файлов нет.</p>':'');
  $('cm-folder').disabled=chosen.status==='queued';$('cm-export-folder').hidden=!window.showDirectoryPicker;$('cm-export-folder').disabled=!chosen.outputs.length;
  if($('cm-delete-job'))$('cm-delete-job').disabled=active;
  $('cm-reuse-job').disabled=false;$('cm-retry-job').disabled=active;$('cm-retry-job').lastChild.textContent=busy?'Повторить в очереди':'Повторить';
  $('cm-job-cancel').hidden=!active;$('cm-job-cancel').textContent=chosen.status==='queued'?'Убрать из очереди':'Остановить';}
 function events(){source?.close();source=new EventSource('/api/creo/events?token='+token);source.addEventListener('job',e=>jobEvent(JSON.parse(e.data)));source.addEventListener('assets-progress',e=>updateAssetsProgressUI(JSON.parse(e.data)));source.onerror=()=>status('Связь с локальным обработчиком прервана. Проверьте, запущен ли start.cmd.',true);}
 async function reuseJob(){const r=await api('job-request?id='+encodeURIComponent(selectedJob));checkpoint('настройки задачи');const missing=[];
  const settings={...r.settings};delete settings.encoder;delete settings.tailMode;delete settings.musicMode;workspace.settings={...initial,...settings};
  const keep=(id,kind)=>{const ok=refs.get(id)?.kind===kind;if(!ok)missing.push(id);return ok;};
  workspace.selected=(r.inputs||[]).filter(id=>keep(id,'inputs'));workspace.hiddenInputs=(workspace.hiddenInputs||[]).filter(id=>!workspace.selected.includes(id));
  workspace.tails=(r.tails||[]).filter(id=>keep(id,'tails'));for(const k of ['music','tailMusic'])workspace[k]=(r[k]||[]).filter(v=>keep(v.id,k));
  for(const [id,e]of Object.entries(r.edits||{}))if(refs.has(id))workspace.edits[id]=e;
  settingsHTML();renderFiles();renderLibrary();updateMode();if(current)loadEditorValues();save();schedulePreview();
  status('Настройки задачи загружены в редактор'+(missing.length?' · отсутствуют '+plural(missing.length,'файл','файла','файлов'):'')+'. Проверьте план и запустите. Ctrl+Z — отменить.');}

 /* ---------- Open / close ---------- */
 async function open(){visible=true;if(opening)return opening;if(loaded){events();if(current)await preview();return;}
  opening=(async()=>{status('Подключаем локальный CreoMaker…');token=sessionStorage.getItem('creoToken');let catalog;
   if(token){try{catalog=await api('catalog');}catch{token=null;sessionStorage.removeItem('creoToken');}}
   if(!token){const res=await fetch('/api/creo/session');const auth=await res.json();if(!res.ok)throw Error(auth.error);token=auth.token;sessionStorage.setItem('creoToken',token);catalog=await api('catalog');}
   platform=catalog.platform||'win32';configurePlatform();media=catalog.media;refs.clear();media.forEach(m=>refs.set(m.id,m));jobs=catalog.jobs;busy=jobs.some(j=>j.status==='running');available=!!catalog.available;const saved=await workspaceStore.getSetting('creoWorkspace');let dropped=[];
   if(saved&&saved.settings){workspace={...blankWorkspace(),...saved,settings:{...initial,...saved.settings}};workspace.selected=workspace.selected.filter(id=>refs.has(id));for(const kind of ['tails','music','tailMusic'])workspace[kind]=(workspace[kind]||[]).filter(v=>refs.has(typeof v==='string'?v:v.id));
    const n=P.normalizePresets(saved.userPresets);workspace.userPresets=n.presets;dropped=n.dropped;if(dropped.length)workspace.rejectedPresets=[...(saved.rejectedPresets||[]),...(saved.userPresets||[]).filter(p=>!n.presets.some(x=>x.id===p?.id))].slice(-40);}
   else{workspace=blankWorkspace();workspace.selected=visibleInputs().map(m=>m.id);for(const kind of ['tails','music','tailMusic'])workspace[kind]=media.filter(m=>m.kind===kind).map(m=>kind==='tails'?m.id:{id:m.id,volume:8});}
   history.clear();loaded=true;$('cm-ffmpeg').textContent=available?'FFmpeg готов · локально':'FFmpeg не найден';updateOutputDirUI(catalog.outputRoot,catalog.defaultOutputRoot,catalog.isCustomOutput);
   settingsHTML();renderFiles();renderLibrary();updateMode();renderActive();renderJobs();$('cm-cancel').disabled=!busy;updateUndo();if(visible)events();
   status(!available?'FFmpeg не найден. Запустите CreoMaker через файл запуска.':dropped.length?'Повреждённые пресеты не загружены ('+dropped.map(d=>d.name).join(', ')+'). Остальные настройки восстановлены.':'',!available||!!dropped.length);
  })().catch(e=>{loaded=false;throw e;}).finally(()=>{opening=null;});return opening;}
 function setVisible(value){visible=value;if(!value){previewSerial++;frameReady=false;clearTimeout(previewTimer);stopInlineAudio();for(const id of ['cm-player-dialog','cm-plan-dialog','cm-copy-count-dialog'])if($(id).open)$(id).close();$('cm-original').pause();$('cm-player').pause();source?.close();source=null;}}
 async function close(){$('cm-meta-status').textContent='';$('cm-meta-fields').replaceChildren();
  uploadController?.abort();if(importTask)await importTask.catch(()=>{});if(opening)await opening.catch(()=>{});setVisible(false);if(!loaded&&!token)return;if(loaded)await persist().catch(()=>{});source?.close();
  if(token)await api('session',{method:'DELETE'}).catch(()=>{});token=null;previewSerial++;timelineCache.clear();sourceCache.clear();history.clear();sessionStorage.removeItem('creoToken');loaded=false;current=null;media=[];jobs=[];refs.clear();workspace=blankWorkspace();closePresetForm();closeCopyPanel();
  for(const id of ['cm-files','cm-results','cm-jobs','cm-log','cm-zones','cm-tails-list','cm-music-list','cm-tailMusic-list','cm-plan-list','cm-plan-warnings','cm-user-preset'])$(id).replaceChildren();
  for(const id of ['cm-original','cm-player','cm-frame','cm-original-image','cm-player-image','cm-timeline','cm-source-frame'])$(id).removeAttribute('src');$('cm-player-image').hidden=true;$('cm-player').hidden=true;
  for(const id of ['cm-selected-name','cm-player-name','cm-output-path','cm-root-path','cm-progress-label','cm-status','cm-job-title','cm-job-meta','cm-job-error','cm-preset-state','cm-run-reason','cm-active-label'])$(id).textContent='';
  $('cm-launch-progress').hidden=true;runFeedback();updateStage();renderJobs();}

 /* ---------- Event wiring ---------- */
 function refreshLibrary(){
  if(!loaded)return Promise.resolve();
  libraryRefresh??=api('library').then(bundled=>{
   if(!loaded)return;
   const known=media.filter(item=>item.builtin);
   if(known.length===bundled.length&&bundled.every(item=>refs.get(item.id)?.source===item.source))return;
   for(const [id,item] of refs)if(item.builtin)refs.delete(id);
   for(const item of bundled)refs.set(item.id,item);
   media=[...media.filter(item=>!item.builtin),...bundled].sort((a,b)=>a.name.localeCompare(b.name,'ru',{numeric:true}));
   let changed=false;
   for(const kind of ['tails','music','tailMusic']){
    const keep=workspace[kind].filter(item=>refs.has(typeof item==='string'?item:item.id));
    changed||=keep.length!==workspace[kind].length;
    workspace[kind]=keep;
   }
   renderLibrary();
   if(changed)save();
  }).finally(()=>{libraryRefresh=null;});
  return libraryRefresh;
 }
 on('cm-library-refresh','click',async()=>{
  const button=$('cm-library-refresh');
  button.disabled=true;
  try{await refreshLibrary();status('Библиотека обновлена.');}
  finally{button.disabled=false;}
 });
 on('cm-assets-download-btn','click',triggerAssetsDownload);
 document.querySelectorAll('[data-cm-mode]').forEach(b=>b.onclick=()=>switchMode(b.dataset.cmMode));
 function switchMode(mode){if(mode===workspace.settings.mode)return;checkpoint('режим');workspace.settings.mode=mode;save();updateMode();renderZones();if(current)preview().catch(e=>status(e.message,true));}
 on('cm-image-note','click',e=>{const b=e.target.closest('[data-switch-mode]');if(b)switchMode(b.dataset.switchMode);});
 on('cm-style-presets','click',e=>{const b=e.target.closest('[data-cm-profile]');if(!b)return;const p=P.presets.find(p=>p.id===b.dataset.cmProfile);if(!p)return;checkpoint('профиль «'+p.label+'»');Object.assign(workspace.settings,p.settings);settingsHTML();save();schedulePreview();updateEstimate();});
 for(const kind of ['inputs','tails','music','tailMusic']){on('cm-add-'+kind,'click',()=>$('cm-pick-'+kind).click());on('cm-pick-'+kind,'change',async e=>{const files=[...e.target.files];e.target.value='';await upload(files,kind);});}
 on('cm-add-folder','click',()=>$('cm-pick-folder').click());on('cm-pick-folder','change',async e=>{const files=[...e.target.files];e.target.value='';await upload(files,'inputs');});
 $('cm-drop').addEventListener('dragover',e=>{e.preventDefault();$('cm-drop').classList.add('drag-over');});$('cm-drop').addEventListener('dragleave',()=>$('cm-drop').classList.remove('drag-over'));$('cm-drop').addEventListener('drop',e=>{e.preventDefault();$('cm-drop').classList.remove('drag-over');upload(e.dataTransfer.files,'inputs').catch(err=>status(err.message,true));});
 on('cm-files','click',e=>{
  const row=e.target.closest('[data-media-id]');if(!row)return;
  const id=row.dataset.mediaId;
  if(e.target.closest('[data-remove-file]')){
   checkpoint('удаление файла');
   workspace.hiddenInputs=[...new Set([...(workspace.hiddenInputs||[]),id])];
   workspace.selected=workspace.selected.filter(v=>v!==id);
   if(current?.id===id){
    const remaining=visibleInputs().filter(m=>m.id!==id);
    current=remaining[0]||null;
    if(current)selectFile(current.id);
    else{
     previewSerial++;clearTimeout(previewTimer);
     $('cm-original').pause();$('cm-original').removeAttribute('src');
     $('cm-selected-name').textContent='Выберите исходник';
     updateStage();
    }
   }
   save();renderFiles();updateStage();
   status('Файл убран из списка. Его можно вернуть кнопкой «Вернуть из библиотеки».');
   return;
  }
  if(e.target.closest('[data-select-file]'))return selectFile(id,{showEditor:true});
 });
 on('cm-files','change',e=>{if(e.target.type!=='checkbox')return;const id=e.target.closest('[data-media-id]').dataset.mediaId;checkpoint('состав пакета','batch:'+id);workspace.selected=e.target.checked?[...new Set([...workspace.selected,id])]:workspace.selected.filter(v=>v!==id);save();renderFiles();});
 on('creo-view','change',e=>{
  const key=e.target.dataset.cmSetting;
  if(key){if(key==='outputFps')e.target.setCustomValidity(Number(e.target.value)>0&&Number(e.target.value)<12?'Укажите 0 или от 12 до 60 кадров/с.':'');if(!e.target.checkValidity()){e.target.reportValidity();return;}checkpoint('параметр','setting:'+key);workspace.settings[key]=e.target.type==='checkbox'?e.target.checked:e.target.tagName==='SELECT'?e.target.value:Number(e.target.value);profileStatus();save();updateEstimate();if(workspace.settings.mode==='unique')schedulePreview();}
  if(e.target.dataset.format){const next=[...$('cm-formats').querySelectorAll('input:checked')].map(c=>c.dataset.format);if(!next.length){e.target.checked=true;status('Нужен хотя бы один формат.',true);return;}status('');checkpoint('форматы');workspace.settings.formats=next;save();updateEstimate();updateCaptions();updateCropGuide();schedulePreview();}
 });
 for(const [id,key]of [['cm-scale','scale'],['cm-noise','noise'],['cm-bitrate-enabled','bitrateEnabled'],['cm-bitrate','bitrate'],['cm-tailmix','tailmix'],['cm-music-mix','musicMix'],['cm-tail-seconds','tailSeconds'],['cm-fade','fade'],['cm-flip','flip'],['cm-metadata','metadata'],['cm-acceleration','acceleration'],['cm-country','country'],['cm-metadata-title','metadataTitle']])
  on(id,'change',e=>{if(!e.target.checkValidity()){e.target.reportValidity();return;}checkpoint('параметр','setting:'+key);workspace.settings[key]=e.target.type==='checkbox'?e.target.checked:(e.target.tagName==='SELECT'||e.target.type==='text')?e.target.value:Number(e.target.value);profileStatus();save();updateEstimate();updateTrimUI();if(['tailmix','tailSeconds','fade'].includes(key)){updateTailFields();syncTailPills();}if(['scale','noise','flip'].includes(key)){updateCaptions();updateCropGuide();schedulePreview();}});
 on('cm-scale-box','click',e=>{
  const b=e.target.closest('[data-scale]');if(!b)return;
  const s=b.dataset.scale;if(!s||workspace.settings.scale===s)return;
  checkpoint('заполнение кадра','scale');workspace.settings.scale=s;
  syncScaleUI();save();updateEstimate();updateCaptions();updateCropGuide();schedulePreview();
 });
 function setTailDuration(sec){
  if(workspace.settings.tailSeconds===sec)return;
  checkpoint('длительность хвостов','tailSeconds');workspace.settings.tailSeconds=sec;
  $('cm-tail-seconds').value=sec;
  updateTailFields();save();updateEstimate();updateTrimUI();
 }
 on('cm-tail-slider','input',e=>showTailDuration(e.target.valueAsNumber));
 on('cm-tail-slider','change',e=>setTailDuration(e.target.valueAsNumber));
 on('cm-tail-duration-control','click',e=>{
  const b=e.target.closest('[data-quick-tail]');if(!b)return;
  setTailDuration(Number(b.dataset.quickTail));
 });
 on('cm-name-tag','change',e=>{const tag=P.safeTag(e.target.value);checkpoint('метка имени');workspace.settings.nameTag=tag;e.target.value=tag;save();updateEstimate();});
 on('cm-name-tag','input',e=>{$('cm-name-example').textContent=P.outputName({index:0,name:(selectedMedia()[0]||current)?.name||'ролик.mp4',target:workspace.settings.mode==='unique'?1:workspace.settings.formats[0],mode:workspace.settings.mode,image:workspace.settings.mode==='unique'&&isImage(selectedMedia()[0]||current),tag:e.target.value});});
 on('cm-goto-library','click',()=>{const l=$('cm-library');l.open=true;l.scrollIntoView({block:'start'});l.querySelector('summary').focus({preventScroll:true});});
 on('cm-library','change',e=>{const row=e.target.closest('[data-track-id]');if(!row)return;const {trackId:id,kind}=row.dataset;
  if(e.target.type==='checkbox'){checkpoint('слои');workspace[kind]=workspace[kind].filter(v=>(typeof v==='string'?v:v.id)!==id);if(e.target.checked)workspace[kind].push(kind==='tails'?id:{id,volume:Number(row.querySelector('input[type=number]')?.value??8)});renderLibrary();}
  else{const v=Number(e.target.value);if(!e.target.checkValidity()){e.target.reportValidity();return;}if(playingTrackKey===kind+':'+id)inlineAudio.volume=previewTrackVolume(v);const track=workspace[kind].find(t=>t.id===id);if(track){checkpoint('громкость','volume:'+id);track.volume=v;}}save();presetState();});
 on('cm-library','click',e=>{const all=e.target.closest('[data-library-all]');if(all){const kind=all.dataset.libraryAll;checkpoint('слои');workspace[kind]=media.filter(m=>m.kind===kind).map(m=>kind==='tails'?m.id:{id:m.id,volume:workspace[kind].find(t=>t.id===m.id)?.volume??8});renderLibrary();save();return;}
  const none=e.target.closest('[data-library-none]');if(none){checkpoint('слои');workspace[none.dataset.libraryNone]=[];renderLibrary();save();return;}
  const row=e.target.closest('[data-track-id]');if(!row)return;const m=refs.get(row.dataset.trackId);if(!m)return;
  if(e.target.closest('[data-play-track]')){const kind=row.dataset.kind;if(kind==='tails'){stopInlineAudio();openPlayer({url:mediaURL(m.id),name:m.name,audio:false,volume:1});}else{const volInput=row.querySelector('input[type=number]'),rawVol=volInput?Number(volInput.value):(workspace[kind].find(v=>v.id===m.id)?.volume??8);toggleInlineAudio(kind,m.id,mediaURL(m.id),rawVol,m.name);}return;}
  const move=e.target.closest('[data-order]');if(move){const list=workspace.tails,index=list.indexOf(m.id),target=index+Number(move.dataset.order);if(index>=0&&target>=0&&target<list.length){checkpoint('порядок хвостов');[list[index],list[target]]=[list[target],list[index]];renderLibrary();save();row.parentElement.querySelector(`[data-track-id="${m.id}"] [data-order="${move.dataset.order}"]`)?.focus();}}});
 on('cm-preview-format','change',e=>{workspace.settings.previewFormat=e.target.value;save();updateCaptions();updateCropGuide();schedulePreview();});
 on('cm-refresh-preview','click',()=>{sourceCache.clear();return preview();});
 document.querySelectorAll('[data-cm-view]').forEach(b=>b.addEventListener('click',()=>{workspace.view=b.dataset.cmView;save();updateStage();if(workspace.view==='split'&&current)preview().catch(e=>status(e.message,true));}));
 on('cm-seek','input',e=>{const ed=edit();if(!ed)return;ed.time=Number(e.target.value);$('cm-position').textContent=time(ed.time);updateTrimUI();});
 on('cm-seek','change',()=>{save();schedulePreview();});
 $('cm-seek').addEventListener('keydown',e=>{if(!e.shiftKey||!['ArrowLeft','ArrowRight'].includes(e.key)||!edit())return;e.preventDefault();setTime((edit().time||0)+(e.key==='ArrowLeft'?-1:1));});
 on('cm-frame-prev','click',()=>stepFrame(-1));on('cm-frame-next','click',()=>stepFrame(1));
 for(const key of ['start','end']){
  on('cm-'+key,'change',e=>{if(!current)return;try{setTrim(key,e.target.value);}catch(err){e.target.setCustomValidity(err.message);e.target.reportValidity();e.target.value=edit()[key];e.target.setCustomValidity('');throw err;}});
  on('cm-'+key,'blur',e=>{if(!current)return;const v=roundTime(e.target.value);if(Number.isFinite(v)&&e.target.value!==''&&String(v)!==e.target.value.trim().replace(',','.')){try{setTrim(key,v);}catch{e.target.value=edit()[key];}}});
  $('cm-'+key)?.addEventListener('invalid',e=>{if(e.target.validity.stepMismatch){e.preventDefault();const v=roundTime(e.target.value);e.target.value=v;try{setTrim(key,v);}catch{}}});
 }
 on('cm-strength','change',e=>{if(!current)return;if(!e.target.checkValidity()){e.target.reportValidity();return;}checkpoint('сила размытия');edit().strength=Number(e.target.value);save();schedulePreview();});
 on('cm-use-start','click',()=>{if(current)setTrim('start',roundTime(edit().time||0));});on('cm-use-end','click',()=>{if(current)setTrim('end',roundTime(edit().time||0));});
 on('cm-quick-in','click',()=>{if(current)setTrim('start',roundTime(edit().time||0));});on('cm-quick-out','click',()=>{if(current)setTrim('end',roundTime(edit().time||0));});
 on('cm-clear-blur','click',()=>{if(!current||!edit().zones.length)return;checkpoint('очистка зон');edit().zones=[];save();renderZones();renderFiles();return preview();});
 on('cm-quick-clear-zones','click',()=>{if(!current||!edit().zones.length)return;checkpoint('очистка зон');edit().zones=[];save();renderZones();renderFiles();return preview();});
 on('cm-empty-pick','click',()=>$('cm-pick-inputs').click());
 on('cm-toggle-all-files','click',()=>{
  const all=visibleInputs();if(!all.length)return;
  checkpoint('выбор всех файлов');
  const allChecked=all.every(m=>workspace.selected.includes(m.id));
  workspace.selected=allChecked?[]:all.map(m=>m.id);
  save();renderFiles();
 });
 on('cm-library-toggle-all','click',()=>{
  const panels=[...document.querySelectorAll('.cm-layers-grid > details')];
  const anyClosed=panels.some(d=>!d.open);
  panels.forEach(d=>{d.open=anyClosed;});
  $('cm-library-toggle-all').lastChild.textContent=anyClosed?'Свернуть списки':'Развернуть списки';
 });
 on('cm-reset-edit','click',()=>{if(!current)return;checkpoint('сброс монтажа');workspace.edits[current.id]={start:0,end:current.probe.duration,strength:18,zones:[],time:edit()?.time||0};loadEditorValues();save();renderFiles();schedulePreview();status('Монтаж файла сброшен. Ctrl+Z — вернуть.');});
 on('cm-copy-edit','click',()=>$('cm-copy-panel').hidden?openCopyPanel():closeCopyPanel());on('cm-copy-cancel','click',()=>{closeCopyPanel();$('cm-copy-edit').focus();});on('cm-copy-apply','click',applyCopy);
 $('cm-copy-panel').addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();closeCopyPanel();$('cm-copy-edit').focus();}});
 // Stage shortcuts: only when focus is not in a text/number field. Zones handle their own arrows.
 $('cm-stage').addEventListener('keydown',e=>{if(e.ctrlKey||e.metaKey||e.altKey||e.target.closest('[data-zone]')||/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)&&e.target.type!=='range')return;if(!current||isImage(current))return;
  const k=e.key.toLowerCase();try{if(k===','||k==='б'){stepFrame(-1);}else if(k==='.'||k==='ю'){stepFrame(1);}else if(workspace.settings.mode==='clean'&&(k==='i'||k==='ш')){setTrim('start',roundTime(edit().time||0));}else if(workspace.settings.mode==='clean'&&(k==='o'||k==='щ')){setTrim('end',roundTime(edit().time||0));}else return;e.preventDefault();}catch(err){e.preventDefault();status(err.message,true);}});
 $('creo-view').addEventListener('keydown',e=>{if(!(e.ctrlKey||e.metaKey)||e.shiftKey||e.key.toLowerCase()!=='z'&&e.key.toLowerCase()!=='я'||/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)&&!['checkbox','range','radio'].includes(e.target.type)||e.target.isContentEditable)return;e.preventDefault();undo().catch(err=>status(err.message,true));});
 on('cm-undo','click',undo);
 const point=e=>{const r=$('cm-frame-wrap').getBoundingClientRect();return {x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))};};
 const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
 $('cm-frame-wrap').addEventListener('pointerdown',event=>{
  if(event.button!==0||!current||busy||!frameReady||workspace.settings.mode!=='clean'||isImage(current)||event.target.closest('.cm-zone-remove'))return;
  const zone=event.target.closest('[data-zone]'),index=zone?Number(zone.dataset.zone):-1;if(index<0&&edit().zones.length>=20){status('Не более 20 зон размытия.',true);return;}
  event.preventDefault();drag={origin:point(event),index,resize:event.target.dataset.resize,original:index>=0?{...edit().zones[index]}:null,id:current.id,before:structuredClone(snapshot()),moved:false};$('cm-frame-wrap').setPointerCapture(event.pointerId);updateUndo();});
 $('cm-frame-wrap').addEventListener('pointermove',event=>{
  if(!drag||drag.id!==current?.id)return;const p=point(event),dx=p.x-drag.origin.x,dy=p.y-drag.origin.y;drag.moved=true;
  if(drag.index<0){const r=$('cm-drawing');r.hidden=false;Object.assign(r.style,{left:Math.min(drag.origin.x,p.x)*100+'%',top:Math.min(drag.origin.y,p.y)*100+'%',width:Math.abs(dx)*100+'%',height:Math.abs(dy)*100+'%'});return;}
  const z=drag.original;let next;
  if(!drag.resize)next={...z,x:clamp(z.x+dx,0,1-z.w),y:clamp(z.y+dy,0,1-z.h)};
  else{let left=z.x,top=z.y,right=z.x+z.w,bottom=z.y+z.h;if(drag.resize.includes('w'))left=clamp(z.x+dx,0,right-.01);else right=clamp(right+dx,left+.01,1);if(drag.resize.includes('n'))top=clamp(z.y+dy,0,bottom-.01);else bottom=clamp(bottom+dy,top+.01,1);next={x:left,y:top,w:right-left,h:bottom-top};}
  edit().zones[drag.index]=next;renderZones();});
 function finishZone(event,cancel=false){if(!drag)return;const d=drag;drag=null;$('cm-drawing').hidden=true;updateUndo();if(d.id!==current?.id)return;
  if(cancel){if(d.original)edit().zones[d.index]=d.original;renderZones();return;}
  let changed=d.moved&&d.index>=0;if(d.index<0){const p=point(event),z={x:Math.min(d.origin.x,p.x),y:Math.min(d.origin.y,p.y),w:Math.abs(p.x-d.origin.x),h:Math.abs(p.y-d.origin.y)};if(z.w>.005&&z.h>.005){edit().zones.push(z);changed=true;}}
  if(changed){history.push(d.index<0?'новая зона':'изменение зоны',d.before);lastCheckpoint={key:'',time:0};updateUndo();}renderZones();renderFiles();if(changed){save();schedulePreview();}}
 $('cm-frame-wrap').addEventListener('pointerup',e=>finishZone(e));$('cm-frame-wrap').addEventListener('pointercancel',e=>finishZone(e,true));
 $('cm-zones').addEventListener('keydown',event=>{const element=event.target.closest('[data-zone]');if(!element||busy)return;const i=Number(element.dataset.zone),z=edit().zones[i],delta=event.shiftKey?.025:.005;if(!z)return;
  const moves={ArrowLeft:['x',-1],ArrowRight:['x',1],ArrowUp:['y',-1],ArrowDown:['y',1]};
  if(event.key==='Delete'||event.key==='Backspace'){checkpoint('удаление зоны');edit().zones.splice(i,1);}
  else if(moves[event.key]){checkpoint('сдвиг зоны','zone:'+i);const [axis,sign]=moves[event.key];z[axis]=clamp(z[axis]+sign*delta,0,1-(axis==='x'?z.w:z.h));}
  else return;event.preventDefault();renderZones();renderFiles();$('cm-zones').querySelector('[data-zone="'+i+'"]')?.focus();save();schedulePreview();});
 on('cm-run','click',run);on('cm-queue','click',run);
 on('cm-plan-open','click',()=>{renderPlan();$('cm-plan-dialog').showModal();});on('cm-plan-run','click',run);
 on('cm-plan-close','click',()=>$('cm-plan-dialog').close());on('cm-plan-cancel','click',()=>$('cm-plan-dialog').close());
 on('cm-cancel','click',async()=>{const j=jobs.find(j=>j.status==='running');if(j){await api('cancel',{method:'POST',data:{id:j.id}});status('Останавливаем задачу… Уже готовые файлы сохранятся.');}});
 on('cm-job-cancel','click',async()=>{const j=jobs.find(v=>v.id===selectedJob);if(j&&(j.status==='running'||j.status==='queued'))await api('cancel',{method:'POST',data:{id:j.id}});});
 on('cm-jobs','click',e=>{const b=e.target.closest('[data-job]');if(b){selectedJob=b.dataset.job;renderJobs();}});
 on('cm-folder','click',async()=>{const r=await api('open-folder',{method:'POST',data:{id:selectedJob}});status('Папка передана Проводнику: '+r.path);});
 on('cm-change-dir-btn','click',browseOutputDir);
 on('cm-footer-change-dir','click',browseOutputDir);
 on('cm-open-root-btn','click',openRootFolder);
 on('cm-root-path','click',openRootFolder);
 on('cm-reset-dir-btn','click',()=>setOutputDir(''));
 on('cm-dir-browse-btn','click',async()=>{
  const inp=$('cm-dir-input');
  if(window.creoDesktop?.selectDirectory){
   const p=await window.creoDesktop.selectDirectory(inp?.value||currentOutputRoot);
   if(p&&inp)inp.value=p;
  }else{
   try{
    const r=await api('browse-output-dir',{method:'POST',data:{}});
    if(r.path&&inp)inp.value=r.path;
   }catch{}
  }
 });
 on('cm-dir-save-btn','click',()=>setOutputDir($('cm-dir-input')?.value||''));
 $('cm-dir-input')?.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();setOutputDir($('cm-dir-input')?.value||'');}});
 on('cm-dir-reset-btn','click',()=>setOutputDir(''));
 on('cm-dir-cancel-btn','click',closeOutputDirDialog);
 on('cm-dir-modal-close','click',closeOutputDirDialog);
 on('cm-copy-path','click',async()=>{const j=jobs.find(j=>j.id===selectedJob);await navigator.clipboard.writeText(j?.outputDir||$('cm-root-path').dataset.full||$('cm-root-path').textContent);status('Путь папки скопирован.');});
 on('cm-detect-gpu','click',async()=>{$('cm-detect-gpu').disabled=true;status('Проверяем аппаратное ускорение коротким тестом…');try{const h=await api('hardware');const readable=h.available.map(a=>a==='h264_videotoolbox'?'Apple VideoToolbox':a==='h264_nvenc'?'NVIDIA NVENC':a==='h264_amf'?'AMD AMF':a==='h264_qsv'?'Intel QSV':a);$('cm-hardware').textContent=readable.length?'Доступно: '+readable.join(', '):'Аппаратный кодировщик недоступен · CPU (x264)';status('Проверка завершена: '+(readable[0]||'CPU'));}finally{$('cm-detect-gpu').disabled=false;}});
 on('cm-empty-list','click',async()=>{if(busy||importTask)throw Error('Дождитесь обработки или загрузки.');checkpoint('скрытие списка');workspace.hiddenInputs=media.filter(m=>m.kind==='inputs').map(m=>m.id);workspace.selected=[];current=null;previewSerial++;clearTimeout(previewTimer);$('cm-original').pause();$('cm-original').removeAttribute('src');$('cm-selected-name').textContent='Выберите исходник';await persist();renderFiles();updateStage();status('Список очищен. Файлы остались в локальной библиотеке — их можно вернуть.');});
 const restore=async()=>{checkpoint('возврат списка');workspace.hiddenInputs=[];await persist();renderFiles();updateStage();status('Исходники снова показаны. Отметьте нужные для обработки.');};
 on('cm-restore-list','click',restore);
 on('cm-retry-job','click',async()=>{const request=await api('job-request?id='+encodeURIComponent(selectedJob));const j=await api('jobs',{method:'POST',data:request,query:busy?'?queue=1':''});selectedJob=j.id;jobEvent(j);status(j.status==='queued'?'Повтор задачи добавлен в очередь.':'Задача повторно запущена с сохранёнными параметрами.');});
 on('cm-reuse-job','click',reuseJob);
 on('cm-clear-jobs','click',async()=>{
  const finished=jobs.filter(j=>terminal.has(j.status));
  if(!finished.length){status('Нет завершённых задач для очистки.');return;}
  if(!await askConfirm('Очистить список задач?','Завершённые задачи ('+finished.length+') будут удалены из списка. Готовые файлы на диске останутся сохранены.','Очистить'))return;
  try{
   await api('clear-jobs',{method:'POST',data:{}});
   jobs=jobs.filter(j=>!terminal.has(j.status));
   selectedJob=jobs[0]?.id||null;
   renderJobs();
   status('Список задач очищен.');
  }catch(e){status('Не удалось очистить список: '+e.message,true);}
 });
 on('cm-delete-job','click',async()=>{
  if(!selectedJob)return;
  const j=jobs.find(x=>x.id===selectedJob);
  if(!j)return;
  if(j.status==='running'||j.status==='queued'){status('Нельзя удалить выполняющуюся задачу. Сначала остановите её.',true);return;}
  if(!await askConfirm('Удалить задачу?','Задача будет удалена из списка. Готовые файлы на диске останутся сохранены.','Удалить'))return;
  try{
   await api('delete-job',{method:'POST',data:{id:j.id}});
   jobs=jobs.filter(x=>x.id!==j.id);
   selectedJob=jobs[0]?.id||null;
   renderJobs();
   status('Задача удалена из списка.');
  }catch(e){status('Не удалось удалить задачу: '+e.message,true);}
 });
 on('cm-results','click',e=>{const src=e.target.closest('[data-open-source]');if(src){const id=src.dataset.openSource;workspace.hiddenInputs=(workspace.hiddenInputs||[]).filter(v=>v!==id);save();renderFiles();return selectFile(id,{showEditor:true});}
  const b=e.target.closest('[data-preview-output]');if(!b)return;const name=b.dataset.previewOutput;openPlayer({url:outputURL(selectedJob,name),name,image:/\.(png|jpg|jpeg|webp|bmp|tiff)$/i.test(name),source:b.dataset.source&&refs.has(b.dataset.source)?b.dataset.source:null});});
 /* Player: result ↔ source toggle keeps the playback position for a direct comparison. */
 let playerState=null;
 function openPlayer({url,name,image=false,audio=false,volume=1,source=null}){stopInlineAudio();playerState={url,name,image,source,showingSource:false};$('cm-player').classList.toggle('cm-audio',audio);$('cm-player-name').textContent=name;$('cm-player-compare').hidden=!source;$('cm-player-compare').setAttribute('aria-pressed','false');$('cm-player-compare').textContent='Показать исходник';$('cm-player-meta').textContent=source?'Результат · исходник: '+(refs.get(source)?.name||''):'';showMedia(url,image,volume);if(!$('cm-player-dialog').open)$('cm-player-dialog').showModal();}
 function showMedia(url,image,volume=1,at=0){if(image){$('cm-player').pause();$('cm-player').hidden=true;$('cm-player-image').src=url;$('cm-player-image').hidden=false;return;}$('cm-player-image').hidden=true;$('cm-player').volume=volume;$('cm-player').src=url;$('cm-player').hidden=false;if(at)$('cm-player').addEventListener('loadedmetadata',()=>{$('cm-player').currentTime=Math.min(at,$('cm-player').duration||at);},{once:true});$('cm-player').play().catch(()=>{});}
 on('cm-player-compare','click',()=>{if(!playerState?.source)return;const s=playerState,at=$('cm-player').hidden?0:$('cm-player').currentTime,srcMedia=refs.get(s.source);s.showingSource=!s.showingSource;
  if(s.showingSource)showMedia(mediaURL(s.source),isImage(srcMedia),1,at);else showMedia(s.url,s.image,1,at);
  $('cm-player-compare').setAttribute('aria-pressed',String(s.showingSource));$('cm-player-compare').textContent=s.showingSource?'Показать результат':'Показать исходник';$('cm-player-meta').textContent=(s.showingSource?'Исходник: '+srcMedia.name:'Результат · исходник: '+srcMedia.name);});
 $('cm-player-close').onclick=()=>{$('cm-player-dialog').close();};$('cm-player-dialog').addEventListener('close',()=>{$('cm-player').pause();$('cm-player').removeAttribute('src');$('cm-player').load();playerState=null;});
 for(const id of ['cm-player-dialog','cm-plan-dialog','cm-copy-count-dialog','cm-dir-dialog'])$(id)?.addEventListener('click',e=>{if(e.target===$(id))$(id).close();});
 on('cm-export-folder','click',async()=>{const dir=await window.showDirectoryPicker({mode:'readwrite'}),j=jobs.find(j=>j.id===selectedJob);const outputDir=await dir.getDirectoryHandle('CreoMaker-'+j.id,{create:true});let n=0;for(const file of j.outputs){status('Сохраняем '+(++n)+'/'+j.outputs.length+' · '+file.name);const response=await fetch(outputURL(j.id,file.name));if(!response.ok)throw Error('Не удалось прочитать результат '+file.name+'. Сохранено '+(n-1)+' из '+j.outputs.length+'.');const handle=await outputDir.getFileHandle(file.name,{create:true}),stream=await handle.createWritable();await response.body.pipeTo(stream);}status('Все результаты ('+n+') сохранены в папку CreoMaker-'+j.id.slice(0,8)+'….');});
 // Presets
 on('cm-user-preset','change',e=>{workspace.activePreset=e.target.value||undefined;save();renderPresets();});
 on('cm-preset-apply','click',applyUserPreset);on('cm-preset-save','click',()=>openPresetForm('create'));on('cm-preset-rename','click',()=>openPresetForm('rename'));
 on('cm-preset-form','submit',e=>{e.preventDefault();return submitPresetForm();});on('cm-preset-cancel','click',()=>{closePresetForm();$('cm-preset-save')?.focus();});
 $('cm-preset-form').addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();closePresetForm();$('cm-preset-save')?.focus();}});
 on('cm-preset-update','click',async()=>{const p=workspace.userPresets.find(x=>x.id===workspace.activePreset);if(!p)return;if(!await askConfirm('Перезаписать пресет «'+p.name+'»?','Текущие параметры обработки заменят сохранённые'+(p.library?' вместе с выбранными хвостами и музыкой':'')+'.','Перезаписать'))return;
  workspace.userPresets=P.updatePreset(workspace.userPresets,p.id,workspace.settings,p.library?layers():undefined);renderPresets();try{await persist();status('Пресет «'+p.name+'» обновлён.');}catch(e){status('Пресет обновлён, но не сохранён на устройстве: '+e.message,true);}});
 on('cm-preset-delete','click',async()=>{const p=workspace.userPresets.find(x=>x.id===workspace.activePreset);if(!p)return;if(!await askConfirm('Удалить пресет «'+p.name+'»?','Текущие настройки и прошлые результаты не изменятся.','Удалить',true))return;
  workspace.userPresets=P.deletePreset(workspace.userPresets,p.id);workspace.activePreset=undefined;renderPresets();try{await persist();status('Пресет удалён.');}catch(e){status('Пресет удалён, но изменение не сохранено: '+e.message,true);}});
 on('cm-original','error',()=>status('Браузер не воспроизводит этот контейнер. Покадровый предпросмотр и обработка через FFmpeg доступны.',true));
 window.addEventListener('beforeunload',e=>{if(settingsDirty||importTask){e.preventDefault();e.returnValue='';}});

 /* ---------- Metadata (explicit AI fill: only country/topic/language leave the device) ---------- */
 function metadataFields(){const t=MediaMetadata.normalize(workspace.settings.metadataTags||{});
  $('cm-meta-fields').innerHTML=Object.entries(MediaMetadata.fields).filter(([k])=>k!=='title')
   .map(([k,f])=>settingRow(metadataIcons[k],f.label,`<textarea data-meta-field="${k}" rows="${['description','synopsis'].includes(k)?3:2}" maxlength="${f.max}">${esc(t[k])}</textarea>`)).join('');}
 on('cm-metadata-title','input',e=>{workspace.settings.metadataTitle=e.target.value;save();});
 on('cm-meta-fields','input',e=>{const k=e.target.dataset.metaField;if(!k)return;workspace.settings.metadataTags={...workspace.settings.metadataTags,[k]:e.target.value};save();});
 on('cm-meta-generate','click',()=>{
  const s=workspace.settings,tags=MediaMetadata.generateEnglish(s.mode,s.metadataTags);
  checkpoint('метаданные');s.metadataTags=tags;s.metadataTitle=tags.title;s.metadata=true;
  $('cm-metadata-title').value=tags.title;$('cm-metadata').checked=true;
  $('cm-meta-status').textContent='Английские теги готовы.';
  metadataFields();save();updateEstimate();
 });

 /* ---------- GitHub Updater ---------- */
 let updatePending=null,updateResetTimer=null;
 async function installUpdate(){
  const btn=$('cm-update-btn'),lbl=$('cm-update-label');if(!btn)return;
  btn.disabled=true;if(lbl)lbl.textContent='Обновляем…';
  status('Скачиваем и устанавливаем обновление с GitHub…');
  try{
   if(source){source.onerror=null;source.close();source=null;}
   const r=await api('update-apply',{method:'POST',data:{}});
   updatePending=null;
   sessionStorage.removeItem('creoToken');
   if(lbl)lbl.textContent='Обновлено!';
   status('Обновление успешно установлено ('+plural(r.filesUpdated||0,'файл','файла','файлов')+'). Перезагружаем студию…');
   setTimeout(()=>window.location.reload(),600);
  }catch(e){
   events();
   btn.disabled=false;
   if(lbl)lbl.textContent=updatePending?'Установить обновление':'Проверить обновления';
   throw e;
  }
 }
 if($('cm-update-btn'))on('cm-update-btn','click',async()=>{
  clearTimeout(updateResetTimer);
  if(updatePending)return installUpdate();
  const btn=$('cm-update-btn'),lbl=$('cm-update-label');
  btn.disabled=true;if(lbl)lbl.textContent='Проверяем…';
  status('Проверяем наличие обновлений на GitHub…');
  try{
   const res=await api('update-check');
   btn.disabled=false;
   if(res.available){
    updatePending=res;
    btn.classList.remove('quiet');btn.classList.add('primary');
    if(lbl)lbl.textContent='Установить обновление';
    const verInfo=res.remoteVersion&&res.remoteVersion!==res.currentVersion?'v'+res.currentVersion+' → v'+res.remoteVersion:(res.remoteSha?'коммит '+res.remoteSha:'новая сборка');
    const msg='На GitHub доступна новая версия ('+verInfo+(res.message?' · '+res.message:'')+'). Ваши исходники, пресеты и результаты сохранятся. Установить обновление сейчас?';
    status('Доступно обновление на GitHub ('+verInfo+').');
    if(await askConfirm('Доступно обновление CreoMaker',msg,'Установить обновление'))await installUpdate();
   }else{
    updatePending=null;
    btn.classList.remove('primary');btn.classList.add('quiet');
    if(lbl)lbl.textContent='Актуальная версия';
    status('У вас установлена актуальная версия CreoMaker (v'+(res.currentVersion||'1.1.0')+(res.currentSha?' · '+res.currentSha:'')+').');
    updateResetTimer=setTimeout(()=>{if(!updatePending&&lbl)lbl.textContent='Проверить обновления';},4000);
   }
  }catch(e){
   btn.disabled=false;
   if(lbl)lbl.textContent='Проверить обновления';
   throw e;
  }
 });

 window.CreoMaker={open,setVisible,close,refreshLibrary};
})();

