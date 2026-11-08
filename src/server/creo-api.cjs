// Same-origin localhost API. Media paths are opaque IDs; arbitrary paths are never accepted.
const fs=require('node:fs');const fsp=require('node:fs/promises');const path=require('node:path');const crypto=require('node:crypto');const {pipeline}=require('node:stream/promises');const {Transform}=require('node:stream');const {execFile,execFileSync,spawn}=require('node:child_process');
const {Engine,config,editConfig,defaults,formats,videoExts,imageExts,audioExts}=require('./creo-engine.cjs');
const Profiles=require('../shared/creo-profiles.js');
const {bundledLibrary}=require('./creo-library.cjs');
const Updater=require('./creo-updater.cjs');
const AssetsManager=require('./creo-assets-manager.cjs');
const mime={'.mp4':'video/mp4','.webm':'video/webm','.mov':'video/quicktime','.mp3':'audio/mpeg','.wav':'audio/wav','.m4a':'audio/mp4','.aac':'audio/aac','.ogg':'audio/ogg','.flac':'audio/flac','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.bmp':'image/bmp','.tiff':'image/tiff'};
const validId=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(v);
function createCreoAPI(root,{dataDir,engine:providedEngine,assetRoot=path.join(root,'assets'),onUpdated}={}){
 const dir=dataDir||path.join(root,'data','creomaker'),uploads=path.join(dir,'uploads'),defaultResults=path.join(dir,'results'),previews=path.join(dir,'previews');
 const configFile=path.join(dir,'config.json');
 let results=defaultResults;
 const engine=providedEngine||new Engine(root),media=new Map(),jobs=new Map(),tokens=new Map(),clients=new Set();let active=null,starting=false,queue=[],previewBusy=false,importCount=0,writeChain=Promise.resolve();
 const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
 const atomic=(file,value)=>{writeChain=writeChain.catch(()=>{}).then(async()=>{const temp=file+'.tmp';await fsp.writeFile(temp,JSON.stringify(value));await fsp.rename(temp,file);});return writeChain;};
 const saveConfig=cfg=>atomic(configFile,cfg);
 const publicMedia=m=>({id:m.id,name:m.name,kind:m.kind,size:m.size,builtin:!!m.builtin,source:m.source,probe:m.probe});
 const publicJob=j=>({id:j.id,status:j.status,progress:j.progress,label:j.label,logs:j.logs,outputs:j.outputs,createdAt:j.createdAt,mode:j.mode,error:j.error,outputDir:j.outputDir||path.join(results,j.id),total:j.total,sources:j.sources,summary:j.summary,queuePosition:j.status==='queued'?queue.findIndex(q=>q.job.id===j.id)+1:undefined});
 const saveMedia=()=>atomic(path.join(dir,'library.json'),[...media.values()].filter(m=>!m.builtin).map(m=>({...m,path:path.basename(m.path)})));
 const persistJob=j=>atomic(path.join(j.outputDir||path.join(results,j.id),'job.json'),publicJob(j));
 let scanning;
 function refreshLibrary(){
  scanning??=bundledLibrary(assetRoot).then(bundled=>{
   for(const [id,item] of media)if(item.builtin&&!bundled.has(id))media.delete(id);
   for(const [id,item] of bundled)media.set(id,item);
  }).finally(()=>{scanning=null;});
  return scanning;
 }
 function broadcast(j){const value='event: job\ndata: '+JSON.stringify(publicJob(j))+'\n\n';for(const c of clients)if(!c.write(value)){clients.delete(c);c.end();}}
 function broadcastAssets(p){const value='event: assets-progress\ndata: '+JSON.stringify(p)+'\n\n';for(const c of clients)if(!c.write(value)){clients.delete(c);c.end();}}
 const ready=(async()=>{
  try{
   const cfg=JSON.parse(await fsp.readFile(configFile,'utf8'));
   if(cfg&&typeof cfg.outputDir==='string'&&cfg.outputDir.trim())results=path.resolve(cfg.outputDir.trim());
  }catch{}
  if(process.env.CREO_OUTPUT_DIR)results=path.resolve(process.env.CREO_OUTPUT_DIR);
  await Promise.all([uploads,results,defaultResults,previews].map(d=>fsp.mkdir(d,{recursive:true})));
  try{const saved=JSON.parse(await fsp.readFile(path.join(dir,'library.json'),'utf8'));for(const m of saved){if(validId(m.id)&&path.basename(m.path)===m.path&&['inputs','tails','music','tailMusic'].includes(m.kind)){const full=path.join(uploads,m.path);if(fs.existsSync(full))media.set(m.id,{...m,path:full});}}}catch(e){if(e.code!=='ENOENT')throw Error('Не удалось прочитать библиотеку CreoMaker. Исходный файл сохранён.');}
  await refreshLibrary();
  const scanDir=async d=>{
   try{
    for(const ent of await fsp.readdir(d,{withFileTypes:true})){
     if(!ent.isDirectory()||!validId(ent.name))continue;
     try{
      const j=JSON.parse(await fsp.readFile(path.join(d,ent.name,'job.json'),'utf8'));
      if(j.id!==ent.name||jobs.has(j.id))continue;
      j.outputDir=path.join(d,ent.name);
      if(['running','queued'].includes(j.status)){
       j.status='interrupted';j.label='Сервер был остановлен. Готовые файлы сохранены.';
       for(const output of j.outputs||[])if(output.verification?.status==='pending')output.verification={status:'unavailable',warnings:1,error:'Проверка прервана остановкой сервера.'};
      }
      jobs.set(j.id,j);
     }catch{}
    }
   }catch{}
  };
  await scanDir(results);
  if(path.resolve(results)!==path.resolve(defaultResults))await scanDir(defaultResults);
 })();
 async function body(req){let data='';for await(const chunk of req){data+=chunk;if(data.length>2000000)throw Error('Запрос слишком большой.');}try{return JSON.parse(data||'{}')}catch{throw Error('Некорректный JSON.')}}
 function resolveMedia(id){if(!validId(id)||!media.has(id))throw Error('Файл не найден в библиотеке.');return media.get(id);}
 function authorize(req,url){const token=req.headers['x-creo-token']||url.searchParams.get('token');if(!tokens.has(token))return false;return true;}
 async function serve(req,res,file,download){const stat=await fsp.stat(file),headers={'Content-Type':mime[path.extname(file).toLowerCase()]||'application/octet-stream','Accept-Ranges':'bytes','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin'};
  if(download)headers['Content-Disposition']="attachment; filename*=UTF-8''"+encodeURIComponent(download);
  let start=0,end=stat.size-1,status=200;
  if(req.headers.range){const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);if(!match||(!match[1]&&!match[2])){res.writeHead(416,{'Content-Range':'bytes */'+stat.size});return res.end();}start=match[1]?Number(match[1]):Math.max(0,stat.size-Number(match[2]));end=match[1]&&match[2]?Math.min(end,Number(match[2])):end;if(start>end||start>=stat.size){res.writeHead(416,{'Content-Range':'bytes */'+stat.size});return res.end();}status=206;headers['Content-Range']=`bytes ${start}-${end}/${stat.size}`;}
  headers['Content-Length']=Math.max(0,end-start+1);res.writeHead(status,headers);if(req.method==='HEAD')return res.end();await pipeline(fs.createReadStream(file,{start,end}),res);
 }
 function startJob(job,request,folder){
   const ctrl=new AbortController();active={id:job.id,ctrl};job.status='running';job.label='Подготовка';let last=0,lastLog='';const verifiedStates=new Map();broadcast(job);
   engine.process(request,resolveMedia,folder,{signal:ctrl.signal,onUpdate:u=>{job.progress=Math.max(job.progress,u.progress);if(u.total)job.total=u.total;const completedFile=u.outputs.length>job.outputs.length;const checkChanged=u.outputs.some(output=>verifiedStates.get(output.name)!==output.verification?.status);for(const output of u.outputs)verifiedStates.set(output.name,output.verification?.status);job.outputs=u.outputs;if(completedFile||checkChanged)persistJob(structuredClone(job)).catch(e=>{job.error='Не удалось записать историю: '+e.message;ctrl.abort();});job.label=u.label;if(lastLog!==u.label){job.logs.push({time:new Date().toISOString(),text:u.label});job.logs=job.logs.slice(-250);lastLog=u.label;}if(Date.now()-last>300){last=Date.now();broadcast(job);}}})
   .then(outputs=>{job.outputs=outputs;job.status='completed';job.progress=1;const warnings=outputs.filter(output=>['warning','unavailable'].includes(output.verification?.status)).length;job.label=warnings?'Файлы сохранены. Проверка с замечаниями · '+warnings:'Готово. Все файлы сохранены локально.';})
   .catch(e=>{job.status=ctrl.signal.aborted&&!job.error?'cancelled':'failed';job.error=job.error||e.message;job.label=job.status==='cancelled'?'Остановлено. Завершённые файлы сохранены.':'Обработка завершилась с ошибкой. Готовые файлы сохранены.';job.logs.push({time:new Date().toISOString(),text:job.label});})
   .finally(async()=>{active=null;await persistJob(job).catch(()=>{});broadcast(job);drain();});
 }
 function drain(){if(active||starting||previewBusy||!queue.length)return;const next=queue.shift();startJob(next.job,next.request,next.folder);persistJob(next.job).catch(()=>{});for(const q of queue)broadcast(q.job);}
 async function handle(req,res,url){
  if(!url.pathname.startsWith('/api/creo/'))return false;
  try{
   await ready;
   const origin='http://'+req.headers.host;
   if(req.headers.origin&&req.headers.origin!==origin||req.headers['sec-fetch-site']&&!['same-origin','none'].includes(req.headers['sec-fetch-site'])){json(res,403,{error:'Разрешены только запросы локальной панели.'});return true;}
   const route=url.pathname.slice('/api/creo/'.length);
   if(route==='session'&&req.method==='GET'){
    if(tokens.size>64){json(res,429,{error:'Слишком много открытых сеансов. Перезапустите локальный сервер.'});return true;}
    const token=crypto.randomBytes(32).toString('hex');tokens.set(token,Date.now());json(res,200,{token});return true;
   }
   if(!authorize(req,url)){json(res,401,{error:'Откройте вкладку CreoMaker заново.'});return true;}
   if(route==='session'&&req.method==='DELETE'){tokens.delete(req.headers['x-creo-token']);json(res,200,{ok:true});return true;}
   if(route==='catalog'&&req.method==='GET'){await refreshLibrary();let ver='1.1.0';try{ver=JSON.parse(await fsp.readFile(path.join(root,'package.json'),'utf8')).version||ver;}catch{}json(res,200,{media:[...media.values()].sort((a,b)=>a.name.localeCompare(b.name,'ru',{numeric:true})).map(publicMedia),jobs:[...jobs.values()].map(publicJob).reverse(),defaults,formats,platform:process.platform,version:ver,outputRoot:results,defaultOutputRoot:defaultResults,isCustomOutput:path.resolve(results)!==path.resolve(defaultResults),available:fs.existsSync(engine.ffmpeg)&&fs.existsSync(engine.ffprobe)});return true;}
   if(route==='set-output-dir'&&req.method==='POST'){
    const b=await body(req);const raw=typeof b.path==='string'?b.path.trim():'';
    if(!raw||path.resolve(raw)===path.resolve(defaultResults)){
     results=defaultResults;await saveConfig({outputDir:null});
     json(res,200,{ok:true,outputRoot:results,defaultOutputRoot:defaultResults,isCustom:false});return true;
    }
    const target=path.resolve(raw);
    try{
     await fsp.mkdir(target,{recursive:true});
     const testFile=path.join(target,'.creo-write-test-'+Date.now());
     await fsp.writeFile(testFile,'creo');
     await fsp.unlink(testFile);
    }catch(err){throw Error('Не удалось получить доступ к папке ('+err.message+'). Проверьте путь и права записи.');}
    results=target;await saveConfig({outputDir:target});
    json(res,200,{ok:true,outputRoot:results,defaultOutputRoot:defaultResults,isCustom:true});return true;
   }
   if(route==='open-root-folder'&&req.method==='POST'){
    await fsp.mkdir(results,{recursive:true});
    const command={win32:'explorer.exe',darwin:'/usr/bin/open'}[process.platform]||'xdg-open';
    await new Promise((resolve,reject)=>{
     const child=spawn(command,[results],{windowsHide:false,detached:true,stdio:'ignore'});
     child.once('error',()=>reject(Error('Не удалось открыть папку. Скопируйте её путь.')));
     child.once('spawn',()=>{child.unref();resolve();});
    });
    json(res,200,{ok:true,path:results});return true;
   }
   if(route==='browse-output-dir'&&req.method==='POST'){
    let picked=null;
    if(process.platform==='darwin'){
     try{picked=execFileSync('osascript',['-e','POSIX path of (choose folder with prompt "Выберите папку для сохранения готовых креативов")'],{encoding:'utf8'}).trim()||null;}catch{}
    }else if(process.platform==='win32'){
     try{
      const ps="Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Выберите папку для вывода готовых роликов'; if($f.ShowDialog() -eq 'OK'){ $f.SelectedPath }";
      picked=execFileSync('powershell',['-NoProfile','-Command',ps],{encoding:'utf8'}).trim()||null;
     }catch{}
    }
    json(res,200,{ok:true,path:picked,canceled:!picked});return true;
   }
   if(route==='update-check'&&req.method==='GET'){json(res,200,await Updater.checkUpdate(root));return true;}
   if(route==='update-apply'&&req.method==='POST'){
    if(active||starting)throw Error('Дождитесь завершения текущей обработки перед установкой обновления.');
    const result=await Updater.applyUpdate(root);
    if(typeof onUpdated==='function')await onUpdated();
    json(res,200,result);
    return true;
   }
   if(route==='assets-status'&&req.method==='GET'){json(res,200,await AssetsManager.getStatus(assetRoot));return true;}
   if(route==='assets-download'&&req.method==='POST'){
    AssetsManager.startDownload(assetRoot,{
     onProgress:p=>broadcastAssets(p),
     onComplete:async()=>{await refreshLibrary();broadcastAssets({status:'ready',percent:100,message:'Библиотека готова'});},
     onError:err=>broadcastAssets({status:'error',error:err.message})
    }).catch(()=>{});
    json(res,202,await AssetsManager.getStatus(assetRoot));
    return true;
   }
   if(route==='library'&&req.method==='GET'){await refreshLibrary();json(res,200,[...media.values()].filter(item=>item.builtin).map(publicMedia));return true;}
   if(route==='hardware'&&req.method==='GET'){json(res,200,await engine.hardware());return true;}
   if(route==='upload'&&req.method==='POST'){
    if(importCount>=2){json(res,429,{error:'Дождитесь завершения предыдущей загрузки.'});return true;}
    const kind=url.searchParams.get('kind'),name=path.basename(url.searchParams.get('name')||'').replace(/[\x00-\x1f]/g,''),ext=path.extname(name).toLowerCase();
    const allowed=kind==='inputs'?[...videoExts,...imageExts]:kind==='tails'?videoExts:['music','tailMusic'].includes(kind)?audioExts:[];if(!allowed.includes(ext))throw Error('Этот тип файла не подходит для выбранной группы.');
    const id=crypto.randomUUID(),file=path.join(uploads,id+ext),temp=file+'.part';let size=0;importCount++;
    try{await pipeline(req,new Transform({transform(chunk,_,cb){size+=chunk.length;if(size>8*1024**3)return cb(Error('Один файл — максимум 8 ГБ.'));cb(null,chunk);}}),fs.createWriteStream(temp,{flags:'wx'}));await fsp.rename(temp,file);const probe=await engine.probe(file);if(['inputs','tails'].includes(kind)&&!probe.width||['music','tailMusic'].includes(kind)&&!probe.audio)throw Error('В файле нет нужного видео или аудио потока.');const m={id,name,kind,size,path:file,probe};media.set(id,m);await saveMedia();json(res,201,publicMedia(m));}
    catch(e){await fsp.unlink(temp).catch(()=>{});if(!media.has(id))await fsp.unlink(file).catch(()=>{});throw e;}finally{importCount--;}
    return true;
   }
   if(route==='probe'&&req.method==='POST'){const r=await body(req),m=resolveMedia(r.id);m.probe=await engine.probe(m.path);json(res,200,m.probe);return true;}
   if(route==='media'&&['GET','HEAD'].includes(req.method)){await serve(req,res,resolveMedia(url.searchParams.get('id')).path);return true;}
   if(route==='preview'&&req.method==='POST'){
    if(previewBusy||active||starting)throw Error('Обработка занята. Предпросмотр доступен после завершения текущей операции.');previewBusy=true;const ctrl=new AbortController();res.on('close',()=>{if(!res.writableEnded)ctrl.abort()});
    try{const r=await body(req),m=resolveMedia(r.id),s=config(r.settings),id=crypto.randomUUID(),file=path.join(previews,id+'.jpg');
     if(r.timeline)await engine.timeline(m.path,s,file,ctrl.signal);else if(r.source)await engine.sourceFrame(m.path,file,Number(r.time)||0,ctrl.signal);else await engine.preview(m.path,s,r.edit,file,Number(r.time)||0,ctrl.signal);
     const old=await Promise.all((await fsp.readdir(previews)).filter(n=>/^[\da-f-]+\.jpg$/.test(n)&&n!==id+'.jpg').map(async name=>({name,time:(await fsp.stat(path.join(previews,name))).mtimeMs})));old.sort((a,b)=>b.time-a.time);for(const entry of old.slice(49))await fsp.unlink(path.join(previews,entry.name)).catch(()=>{});
     json(res,200,{id});
    }finally{previewBusy=false;drain();}return true;
   }
   if(route==='preview-image'&&['GET','HEAD'].includes(req.method)){const id=url.searchParams.get('id');if(!validId(id))throw Error('Неверное превью.');await serve(req,res,path.join(previews,id+'.jpg'));return true;}
   if(route==='jobs'&&req.method==='POST'){
    // Without ?queue=1 the single-job reservation is unchanged: a second concurrent start is rejected before reading the body.
    const wantsQueue=url.searchParams.get('queue')==='1';
    if(previewBusy||!wantsQueue&&(active||starting))throw Error('Дождитесь текущей обработки или добавьте задачу в очередь.');
    if(wantsQueue&&queue.length>=20)throw Error('В очереди уже 20 задач. Дождитесь их выполнения.');
    if(!wantsQueue)starting=true;
    try{const request=await body(req);delete request.queue;request.settings=config(request.settings);
    if(!Array.isArray(request.inputs)||!request.inputs.length||request.inputs.length>200)throw Error('Добавьте от 1 до 200 исходников.');request.inputs=[...new Set(request.inputs)];if(request.settings.mode==='clean'&&request.inputs.some(id=>!videoExts.includes(path.extname(resolveMedia(id).path).toLowerCase())))throw Error('Clean3 принимает только видео. Изображения обрабатываются в уникализации.');request.inputs.forEach(id=>{if(resolveMedia(id).kind!=='inputs')throw Error('Нужен исходный файл.');});
    for(const key of ['tails','music','tailMusic']){if(!Array.isArray(request[key])||request[key].length>100)throw Error('В группе должно быть не более 100 файлов.');request[key].forEach(v=>{if(resolveMedia(key==='tails'?v:v.id).kind!==key)throw Error('Неверная группа медиа.');});}
    if(request.settings.mode==='clean'&&request.settings.tailmix&&!request.tails.length)throw Error('Хвосты включены, но не выбраны. Выберите хвосты или выключите их.');
    if(request.presetName!=null&&(typeof request.presetName!=='string'||request.presetName.length>60))throw Error('Неверное название пресета.');
    const s=request.settings,id=crypto.randomUUID();
    const job={id,status:'running',progress:0,label:'Подготовка',logs:[],outputs:[],createdAt:new Date().toISOString(),mode:s.mode,total:request.inputs.length*(s.mode==='clean'?s.formats.length:s.copies),
     sources:request.inputs.map(i=>({id:i,name:resolveMedia(i).name})),summary:{mode:s.mode,formats:s.mode==='clean'?s.formats:[],copies:s.mode==='unique'?s.copies:0,scale:s.scale,tailmix:s.mode==='clean'&&s.tailmix,music:Boolean(s.musicMix&&request.music?.length),nameTag:s.nameTag,preset:request.presetName||''}};
    const folder=path.join(results,id);job.outputDir=folder;await fsp.mkdir(folder,{recursive:true});await fsp.writeFile(path.join(folder,'request.json'),JSON.stringify(request,null,2));jobs.set(id,job);
    if(active||(wantsQueue&&starting)){job.status='queued';job.label='В очереди';queue.push({job,request,folder});await persistJob(job);broadcast(job);json(res,202,publicJob(job));return true;}
    await persistJob(job);startJob(job,request,folder);json(res,202,publicJob(job));return true;}finally{if(!wantsQueue)starting=false;drain();}
   }
   if(route==='validate-project'&&req.method==='POST'){const w=await body(req);w.settings=config(w.settings);if(!Array.isArray(w.selected)||w.selected.length>200||!w.edits||typeof w.edits!=='object')throw Error('Некорректный проект.');for(const id of w.selected)if(resolveMedia(id).kind!=='inputs')throw Error('Неверный исходник.');for(const key of ['tails','music','tailMusic']){if(!Array.isArray(w[key])||w[key].length>100)throw Error('Неверная группа '+key);for(const v of w[key]){if(resolveMedia(key==='tails'?v:v.id).kind!==key)throw Error('Неверная группа медиа.');if(key!=='tails'&&(!Number.isFinite(v.volume)||v.volume<0||v.volume>200))throw Error('Неверная громкость.');}}const edits={};for(const [id,e]of Object.entries(w.edits)){const m=resolveMedia(id);if(m.kind!=='inputs')throw Error('Неверный исходник монтажа.');const p=await engine.probe(m.path);edits[id]={...editConfig(e,p.duration),time:Math.max(0,Math.min(p.duration,Number(e.time)||0))};}const {presets:userPresets,dropped}=Profiles.normalizePresets(w.userPresets);for(const p of userPresets){try{config({...w.settings,...p.settings});}catch(e){throw Error('Пресет «'+p.name+'»: '+e.message);}}json(res,200,{settings:w.settings,selected:w.selected,tails:w.tails,music:w.music,tailMusic:w.tailMusic,edits,userPresets,droppedPresets:dropped});return true;}
   if(route==='job-request'&&req.method==='GET'){const j=jobs.get(url.searchParams.get('id'));if(!j)throw Error('Задача не найдена.');const request=JSON.parse(await fsp.readFile(path.join(j.outputDir||path.join(results,j.id),'request.json'),'utf8'));delete request.queue;json(res,200,request);return true;}
   if(route==='cancel'&&req.method==='POST'){const r=await body(req);if(active?.id===r.id)active.ctrl.abort();else{const i=queue.findIndex(q=>q.job.id===r.id);if(i>=0){const [{job}]=queue.splice(i,1);job.status='cancelled';job.label='Убрана из очереди до запуска.';job.logs.push({time:new Date().toISOString(),text:job.label});await persistJob(job).catch(()=>{});broadcast(job);for(const q of queue)broadcast(q.job);}}json(res,200,{ok:true});return true;}
   if(route==='events'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});res.write(': connected\n\n');clients.add(res);for(const j of jobs.values())res.write('event: job\ndata: '+JSON.stringify(publicJob(j))+'\n\n');req.on('close',()=>clients.delete(res));return true;}
    if(route==='verification'&&req.method==='GET'){
     const job=jobs.get(url.searchParams.get('job')),name=url.searchParams.get('name');
     const output=job?.outputs.find(item=>item.name===name);
     const report=output?.verification?.report;
     if(!report||path.basename(report)!==report)throw Error('Отчёт проверки не найден.');
     const file=path.join(job.outputDir||path.join(results,job.id),report);
     if(url.searchParams.has('download'))await serve(req,res,file,report);
     else json(res,200,JSON.parse(await fsp.readFile(file,'utf8')));
     return true;
    }
    if(route==='output'&&['GET','HEAD'].includes(req.method)){const job=jobs.get(url.searchParams.get('job')),name=url.searchParams.get('name');if(!job||!job.outputs.some(o=>o.name===name)||path.basename(name)!==name)throw Error('Результат не найден.');await serve(req,res,path.join(job.outputDir||path.join(results,job.id),name),url.searchParams.has('download')?name:null);return true;}
   if(route==='open-folder'&&req.method==='POST'){
    const r=await body(req),job=jobs.get(r.id);
    if(!job)throw Error('Задача не найдена.');
    const folder=path.resolve(job.outputDir||path.join(results,job.id));
    if(path.basename(folder)!==job.id)throw Error('Неверный путь результата.');
    await fsp.access(folder);
    const command={win32:'explorer.exe',darwin:'/usr/bin/open'}[process.platform]||'xdg-open';
    await new Promise((resolve,reject)=>{
     const child=spawn(command,[folder],{windowsHide:false,detached:true,stdio:'ignore'});
     child.once('error',()=>reject(Error('Не удалось открыть папку. Скопируйте её путь.')));
     child.once('spawn',()=>{child.unref();resolve();});
    });
    json(res,200,{ok:true,path:folder});return true;
   }
   json(res,404,{error:'Неизвестная операция CreoMaker.'});
  }catch(e){if(!res.headersSent&&!res.destroyed)json(res,400,{error:e.message});else if(!res.destroyed)res.end();}
  return true;
 }
 return {handle,ready,summaryJobs:()=>[...jobs.values()].map(j=>({id:'creo:'+j.id,kind:'creo',status:j.status})),close(){queue.length=0;active?.ctrl.abort();for(const c of clients)c.end();clients.clear();}};
}
module.exports={createCreoAPI};
