// CreoMaker workflow logic shared by browser and engine: user presets, dry batch plan, output names, edit copy, undo.
// Pure functions + engine config only; no FFmpeg, network or data directories.
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const P=require('../src/shared/creo-profiles.js'),{config,defaults}=require('../src/server/creo-engine.cjs');

const legacyName=(i,name,target,mode,image)=>{const base=path.basename(name,path.extname(name)).replace(/[^\p{L}\p{N}._-]/gu,'_').slice(0,80)||'media';const ext=mode==='unique'&&image?path.extname(name).toLowerCase():'.mp4';return `${String(i+1).padStart(3,'0')}_${base}_${mode==='clean'?target.replace(':','_'):'u'+target}${ext}`;};

test('output names without a tag are identical to the previous engine formula',()=>{
 for(const [name,target,mode,image]of [['Clip 01.MOV','9:16','clean',false],['промо (финал).mp4','4:5','clean',false],['photo.PNG',3,'unique',true],['a.b.c.webm',1,'unique',false],['x'.repeat(120)+'.mp4','1:1','clean',false]])
  assert.equal(P.outputName({index:4,name,target,mode,image}),legacyName(4,name,target,mode,image));
 assert.equal(P.outputName({index:0,name:'clip.mp4',target:'16:9',mode:'clean',tag:' PT / v2 '}),'001_clip_PT_v2_16_9.mp4');
 assert.equal(P.safeTag('../../evil'),'evil');assert.equal(P.safeTag('a'.repeat(50)).length,32);
});

test('engine config: nameTag is optional, sanitised and old saved settings stay valid',()=>{
 const legacy={...defaults};delete legacy.nameTag;assert.equal(config(legacy).nameTag,'');
 assert.equal(config({nameTag:'PT v2'}).nameTag,'PT_v2');
 assert.throws(()=>config({nameTag:'x'.repeat(65)}));assert.throws(()=>config({nameTag:5}));
});

test('dry plan: mixed batch, counts, skipped images, names and blocking reasons',()=>{
 const inputs=[{id:'v1',name:'one.mp4',duration:10},{id:'i1',name:'pic.png',image:true,duration:1},{id:'v2',name:'one.mov',duration:4}];
 const clean=P.planBatch({settings:{mode:'clean',formats:['9:16','1:1'],tailmix:false,tailSeconds:5},inputs,edits:{v1:{start:2,end:6}}});
 assert.equal(clean.total,4);assert.deepEqual(clean.included,['v1','v2']);assert.deepEqual(clean.skipped,['i1']);assert.equal(clean.blocking,false);
 assert.deepEqual(clean.items[0].outputs,['001_one_9_16.mp4','001_one_1_1.mp4']);
 assert.deepEqual(clean.items[2].outputs,['002_one_9_16.mp4','002_one_1_1.mp4'],'index counts processed inputs only, so same base names never collide');
 assert.equal(clean.items[0].length,4);assert.equal(clean.seconds,4*2+4*2);
 assert.ok(clean.warnings.some(w=>w.level==='info'&&/изображ/i.test(w.text)));
 const tails=P.planBatch({settings:{mode:'clean',formats:['9:16'],tailmix:true,tailSeconds:5},inputs:[inputs[0]],tails:[]});
 assert.equal(tails.blocking,true);assert.match(tails.warnings[0].text,/Хвосты/);
 assert.equal(P.planBatch({settings:{mode:'clean',formats:['9:16'],tailmix:true,tailSeconds:5},inputs:[inputs[0]],tails:['t']}).items[0].length,15,'no edit: full 10 s + 5 s tails');
 const onlyImages=P.planBatch({settings:{mode:'clean',formats:['9:16']},inputs:[inputs[1]]});assert.equal(onlyImages.blocking,true);assert.equal(onlyImages.total,0);
 const unique=P.planBatch({settings:{mode:'unique',copies:3,nameTag:'A'},inputs});
 assert.equal(unique.total,9);assert.deepEqual(unique.items[1].outputs,['002_pic_A_u1.png','002_pic_A_u2.png','002_pic_A_u3.png']);
 assert.equal(new Set(unique.items.flatMap(i=>i.outputs)).size,9);assert.equal(unique.duplicates.length,0);
 assert.equal(P.planBatch({settings:{mode:'unique',copies:2},inputs:[]}).blocking,true);
 assert.equal(P.planBatch({settings:{mode:'clean',formats:[]},inputs:[inputs[0]]}).blocking,true);
});

test('copying an edit is independent per file, clamps to each duration and preserves untouched parts',()=>{
 const from={start:2,end:9,strength:25,zones:[{x:.1,y:.1,w:.2,h:.2}],time:3};
 const short=P.copyEdit(from,4,{trim:true,zones:true});assert.equal(short.start,2);assert.equal(short.end,4);assert.equal(short.strength,25);
 short.zones[0].x=.9;assert.equal(from.zones[0].x,.1,'zones are copied, not shared');
 const tiny=P.copyEdit(from,1.5,{trim:true,zones:false});assert.deepEqual([tiny.start,tiny.end],[0,1.5],'impossible range falls back to the full file');
 const existing={start:.5,end:1,strength:10,zones:[{x:.5,y:.5,w:.1,h:.1}],time:.7};
 const zonesOnly=P.copyEdit(from,20,{trim:false,zones:true},existing);assert.deepEqual([zonesOnly.start,zonesOnly.end,zonesOnly.time],[.5,1,.7]);assert.equal(zonesOnly.zones.length,1);assert.equal(zonesOnly.zones[0].x,.1);
 assert.equal(existing.zones[0].x,.5,'target edit object is not mutated');
 const trimOnly=P.copyEdit(from,20,{trim:true,zones:false},existing);assert.deepEqual(trimOnly.zones,existing.zones);assert.equal(trimOnly.strength,10);
 const floatDur=P.copyEdit({start:1.2345,end:105.0012},105.0012,{trim:true,zones:false},{start:0,end:10,strength:18,zones:[],time:105.0012});
 assert.equal(floatDur.start,1.23);assert.equal(floatDur.end,105);assert.equal(floatDur.time,105);
});

test('user presets: create, duplicate-name rejection, rename, update, apply, delete',()=>{
 let list=[];const s={...defaults,mode:'clean',formats:['9:16','1:1'],crf:24,metadataTitle:'Private title',metadataTags:{description:'x'},previewFormat:'1:1'};
 const a=P.createPreset(list,{name:'  Reels   PT ',settings:s,now:'2026-11-06T00:00:00.000Z',id:'pa'});list=[a];
 assert.equal(a.name,'Reels PT');assert.equal(a.settings.crf,24);assert.deepEqual(a.settings.formats,['9:16','1:1']);
 for(const k of ['metadataTitle','metadataTags','metadataTopic','metadataLanguage','previewFormat'])assert.equal(k in a.settings,false,k+' is content-specific and stays out of presets');
 assert.throws(()=>P.createPreset(list,{name:'reels pt',settings:s}),/уже есть/);assert.throws(()=>P.createPreset(list,{name:'   ',settings:s}),/название/i);assert.throws(()=>P.createPreset(list,{name:'x'.repeat(61),settings:s}));
 const b=P.createPreset(list,{name:'Unique heavy',settings:{...s,mode:'unique',copies:7},library:{tails:['t1','gone'],music:[{id:'m1',volume:20}],tailMusic:[]},id:'pb'});list=[...list,b];
 assert.throws(()=>P.renamePreset(list,'pb','Reels PT'),/уже есть/);list=P.renamePreset(list,'pb','Heavy v2','2026-11-07T00:00:00.000Z');assert.equal(list[1].name,'Heavy v2');assert.equal(list[1].updatedAt,'2026-11-07T00:00:00.000Z');assert.equal(list[0].name,'Reels PT');
 list=P.updatePreset(list,'pa',{...s,crf:30});assert.equal(list[0].settings.crf,30);assert.equal(list[0].name,'Reels PT');
 const current={...defaults,mode:'clean',metadataTitle:'keep me',previewFormat:'4:3'};
 const r=P.applyPreset(current,list[1],id=>id!=='gone');assert.equal(r.settings.mode,'unique');assert.equal(r.settings.copies,7);assert.equal(r.settings.metadataTitle,'keep me');assert.equal(r.settings.previewFormat,'4:3');
 assert.deepEqual(r.library.tails,['t1']);assert.equal(r.missing,1);assert.deepEqual(r.library.music,[{id:'m1',volume:20}]);
 r.library.music[0].volume=99;assert.equal(list[1].library.music[0].volume,20,'applying never mutates the stored preset');
 assert.equal(P.matchUserPreset(r.settings,list).id,'pb');assert.equal(P.matchUserPreset({...r.settings,copies:8},list),undefined);
 list=P.deletePreset(list,'pa');assert.deepEqual(list.map(p=>p.id),['pb']);assert.throws(()=>P.deletePreset(list,'pa'));
 const many=Array.from({length:40},(_,i)=>({id:'p'+i,name:'n'+i,settings:{crf:20}}));assert.throws(()=>P.createPreset(many,{name:'one more',settings:s}),/40/);
});

test('preset normalisation drops only invalid entries and never smuggles unknown keys or secrets',()=>{
 const good={id:'ok1',name:'Good',settings:{crf:20,formats:['9:16'],scale:'crop',apiKey:'sk-should-not-survive'}};
 const {presets,dropped}=P.normalizePresets([good,{id:'../x',name:'bad id',settings:{crf:1}},{id:'b2',name:'Bad scale',settings:{scale:'zoom'}},{id:'b3',name:'Bad number',settings:{crf:'20'}},{id:'b4',name:'Bad tails',settings:{crf:2},library:{tails:['../../etc']}},{id:'ok2',name:'good',settings:{crf:3}},null]);
 assert.deepEqual(presets.map(p=>p.id),['ok1']);assert.equal(dropped.length,6);assert.equal('apiKey' in presets[0].settings,false);
 assert.deepEqual(P.normalizePresets(undefined),{presets:[],dropped:[]});assert.equal(P.normalizePresets('corrupt').dropped.length,1);
 // Every preset field that survives normalisation is a valid engine setting.
 assert.doesNotThrow(()=>config({...presets[0].settings}));
});

test('undo history is bounded, ordered and stores deep snapshots',()=>{
 const h=P.createHistory(3),state={edits:{a:{zones:[{x:.1}]}}};h.push('one',state);state.edits.a.zones[0].x=.9;
 for(const label of ['two','three','four'])h.push(label,{label});assert.equal(h.size,3);assert.equal(h.peek(),'four');
 assert.equal(h.pop().label,'four');assert.equal(h.pop().label,'three');assert.deepEqual(h.pop().state,{label:'two'});assert.equal(h.pop(),null);
 const h2=P.createHistory();h2.push('x',state);state.edits.a.zones[0].x=.2;assert.equal(h2.pop().state.edits.a.zones[0].x,.9);
});

test('updater validates safe paths and applies zip update atomically without touching data/',async()=>{
 const http=require('node:http'),os=require('node:os'),fs=require('node:fs/promises'),zlib=require('node:zlib');
 const Updater=require('../src/server/creo-updater.cjs');
 assert.equal(Updater.isSafeUpdatePath('public/index.html'),true);
 assert.equal(Updater.isSafeUpdatePath('src/server/creo-engine.cjs'),true);
 assert.equal(Updater.isSafeUpdatePath('package.json'),true);
 assert.equal(Updater.isSafeUpdatePath('../evil.js'),false);
 assert.equal(Updater.isSafeUpdatePath('data/creomaker/library.json'),false);
 assert.equal(Updater.isSafeUpdatePath('tools/ffmpeg.exe'),false);

 function makeZip(entries){
  const localParts=[],cdParts=[];let offset=0;
  for(const [name,content]of entries){
   const raw=Buffer.from(content,'utf8'),comp=zlib.deflateRawSync(raw),crc=zlib.crc32(raw)>>>0,nb=Buffer.from(name,'utf8');
   const lfh=Buffer.alloc(30+nb.length);lfh.writeUInt32LE(0x04034b50,0);lfh.writeUInt16LE(20,4);lfh.writeUInt16LE(8,8);lfh.writeUInt32LE(crc,14);lfh.writeUInt32LE(comp.length,18);lfh.writeUInt32LE(raw.length,22);lfh.writeUInt16LE(nb.length,26);nb.copy(lfh,30);
   const cd=Buffer.alloc(46+nb.length);cd.writeUInt32LE(0x02014b50,0);cd.writeUInt16LE(20,4);cd.writeUInt16LE(20,6);cd.writeUInt16LE(8,10);cd.writeUInt32LE(crc,16);cd.writeUInt32LE(comp.length,20);cd.writeUInt32LE(raw.length,24);cd.writeUInt16LE(nb.length,28);cd.writeUInt32LE(offset,42);nb.copy(cd,46);
   localParts.push(lfh,comp);cdParts.push(cd);offset+=lfh.length+comp.length;
  }
  const cdBuf=Buffer.concat(cdParts),eocd=Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50,0);eocd.writeUInt16LE(entries.length,8);eocd.writeUInt16LE(entries.length,10);eocd.writeUInt32LE(cdBuf.length,12);eocd.writeUInt32LE(offset,16);
  return Buffer.concat([...localParts,cdBuf,eocd]);
 }

 const tmpDir=await fs.mkdtemp(path.join(os.tmpdir(),'creomaker-upd-'));
 await fs.mkdir(path.join(tmpDir,'data'),{recursive:true});
 await fs.writeFile(path.join(tmpDir,'package.json'),JSON.stringify({name:'creomaker',version:'1.1.0'}));
 await fs.writeFile(path.join(tmpDir,'data','keep.txt'),'user-data');
 const zipBuf=makeZip([
  ['Creomaker-4-main/package.json',JSON.stringify({name:'creomaker',version:'1.2.0'})],
  ['Creomaker-4-main/public/hello.txt','updated-ui'],
  ['Creomaker-4-main/data/keep.txt','should-be-ignored']
 ]);
 const srv=http.createServer((req,res)=>{
  if(req.url.startsWith('/package.json'))res.end(JSON.stringify({version:'1.2.0'}));
  else if(req.url.startsWith('/commit-info.json'))res.end(JSON.stringify({sha:'abcdef1234567890',commit:{message:'New audio feature'}}));
  else if(req.url==='/archive.zip')res.end(zipBuf);
  else{res.statusCode=404;res.end();}
 });
 await new Promise(r=>srv.listen(0,'127.0.0.1',r));
 process.env.CREOMAKER_UPDATE_BASE_URL='http://127.0.0.1:'+srv.address().port;
 try{
  const check=await Updater.checkUpdate(tmpDir);
  assert.equal(check.available,true);assert.equal(check.remoteVersion,'1.2.0');assert.equal(check.remoteSha,'abcdef1');
  const applied=await Updater.applyUpdate(tmpDir);
  assert.equal(applied.ok,true);assert.equal(applied.version,'1.2.0');
  assert.equal(await fs.readFile(path.join(tmpDir,'public','hello.txt'),'utf8'),'updated-ui');
  assert.equal(await fs.readFile(path.join(tmpDir,'data','keep.txt'),'utf8'),'user-data');
  const checkAfter=await Updater.checkUpdate(tmpDir);
  assert.equal(checkAfter.available,false);
 }finally{
  delete process.env.CREOMAKER_UPDATE_BASE_URL;
  srv.close();
  await fs.rm(tmpDir,{recursive:true,force:true});
 }
});
