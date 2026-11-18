const {spawn}=require('node:child_process');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {Engine,config,editConfig,formats}=require('../src/server/creo-engine.cjs');const {createFixtures,fixtures,root}=require('./creo-fixtures.cjs');
test('CreoMaker rejects invalid settings and always uses all selected media',()=>{assert.equal(config({tailMode:'random',musicMode:'random'}).musicMode,'all');assert.equal(config().tailMode,'all');for(const raw of [{tailSeconds:0},{threads:99},{formats:['bad']},{copies:51},{scale:'bad'},{pitch:31}])assert.throws(()=>config(raw));assert.throws(()=>editConfig({start:1,end:.5},2));assert.throws(()=>editConfig({zones:Array(21).fill({})},2));assert.equal(Object.keys(formats).length,5);});
test('tail duration supports 30 minutes and rounded full-length trims keep the actual endpoint', () => {
 assert.equal(config({tailSeconds:1800}).tailSeconds,1800);
 assert.throws(()=>config({tailSeconds:1801}));
 assert.equal(editConfig({end:172.27},172.267438).end,172.267438);
 assert.equal(editConfig({end:173},172.8).end,172.8);
 assert.equal(editConfig({end:172},172.267438).end,172);
 assert.throws(()=>editConfig({end:174},172.8));
});
test('automatic encoding retries available encoders and retains the default video stream', async () => {
 const dir=await fs.mkdtemp(path.join(require('node:os').tmpdir(),'creo-encoder-test-'));
 try{
  const engine=new Engine(root),source=path.join(dir,'multitrack.mp4');
  await engine.run('ffmpeg',['-y','-f','lavfi','-i','color=red:size=128x128:duration=0.25','-f','lavfi','-i','color=blue:size=64x64:duration=0.25','-map','0:v','-map','1:v','-disposition:v:0','0','-disposition:v:1','default','-c:v','libx264',source]);
  engine.hardwarePromise=Promise.resolve({available:['h264_nvenc','h264_qsv'],preferred:'h264_nvenc'});
  const run=engine.run.bind(engine),attempted=new Set();
  engine.run=async(tool,args,options)=>{
   const index=args.indexOf('-c:v');
   if(tool==='ffmpeg'&&index>=0){
    const encoder=args[index+1];
    attempted.add(encoder);
    if(encoder!=='libx264')throw Error('Test encoder failure');
    assert.match(args[args.indexOf('-filter_complex')+1],/^\[0:1\]/);
   }
   return run(tool,args,options);
  };
  const outputs=await engine.process({settings:{formats:['1:1'],tailmix:false,verifyResults:false,threads:1},inputs:['source']},id=>({id,name:'multitrack.mp4',path:source}),path.join(dir,'results'));
  assert.equal(outputs.length,1);
  assert.deepEqual([...attempted],['h264_nvenc','h264_qsv','libx264']);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('Actual FFmpeg: clean formats, blur, all tails/music, images, unique videos and cancellation',{timeout:180000},async()=>{
 await createFixtures();const engine=new Engine(root),outRoot=path.join(root,'test-results','creo-engine-'+crypto.randomUUID());await fs.mkdir(outRoot,{recursive:true});const entries=['source.mp4','tail-red.mp4','tail-blue.mp4','music-0.wav','music-1.wav','music-2.wav','image.png'].map((name,i)=>({id:String(i),name,path:path.join(fixtures,name)}));const resolve=id=>entries.find(e=>e.id===id);const before=crypto.createHash('sha256').update(await fs.readFile(entries[0].path)).digest('hex');
 const settings={formats:['1:1'],tailSeconds:2,fade:.2,preset:'ultrafast',crf:30,threads:1,signalChange:false,verifyResults:false};const edits={'0':{start:.2,end:1.2,strength:12,zones:[{x:.1,y:.1,w:.2,h:.2},{x:.8,y:.8,w:.2,h:.2}]}};
 await engine.preview(entries[0].path,config(settings),edits['0'],path.join(outRoot,'preview.jpg'),.4);assert.ok((await fs.stat(path.join(outRoot,'preview.jpg'))).size>100);
 await engine.timeline(entries[0].path,config(settings),path.join(outRoot,'timeline.jpg'));assert.ok((await fs.stat(path.join(outRoot,'timeline.jpg'))).size>100);
 const request={settings,inputs:['0'],tails:['1','2'],music:[{id:'3',volume:8},{id:'4',volume:8}],tailMusic:[{id:'5',volume:8}],edits};
 let updates=0;const labels=new Set();const outputs=await engine.process(request,resolve,path.join(outRoot,'clean'),{onUpdate:({label})=>{updates++;labels.add(label);}});assert.equal(outputs.length,1);assert.ok(updates>4);const probe=await engine.probe(path.join(outRoot,'clean',outputs[0].name));assert.equal(probe.width,720);assert.equal(probe.height,720);assert.ok(probe.audio);assert.ok(Math.abs(probe.duration-3)<.2,JSON.stringify(probe));
 assert.ok([...labels].every(label=>!label.startsWith('Подготовка 1:1')), 'the main clip should be encoded directly into the final video');
 const decode=args=>new Promise((resolve,reject)=>{const p=spawn(engine.ffmpeg,['-hide_banner','-nostdin','-loglevel','error',...args],{windowsHide:true});const buffers=[];let err='';p.stdout.on('data',b=>buffers.push(b));p.stderr.on('data',b=>err+=b);p.on('error',reject);p.on('close',c=>c?reject(Error(err)):resolve(Buffer.concat(buffers)));});
 const outputFile=path.join(outRoot,'clean',outputs[0].name);
 const red=await decode(['-ss','1.4','-i',outputFile,'-an','-frames:v','1','-vf','scale=1:1','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
 const blue=await decode(['-ss','2.4','-i',outputFile,'-an','-frames:v','1','-vf','scale=1:1','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
 assert.ok(red[0]>red[2]+100,'First tail must be red');assert.ok(blue[2]>blue[0]+100,'Second tail must be blue');
 const pcm=await decode(['-ss','1.4','-i',outputFile,'-t','0.5','-vn','-ac','1','-ar','8000','-f','f32le','pipe:1']);
 const energy=hz=>{let real=0,imaginary=0,n=pcm.length/4;for(let i=0;i<n;i++){const sample=pcm.readFloatLE(i*4),phase=2*Math.PI*hz*i/8000;real+=sample*Math.cos(phase);imaginary+=sample*Math.sin(phase);}return Math.hypot(real,imaginary)/n;};
 for(const hz of [440,660,880])assert.ok(energy(hz)>energy(1230)*10,'All music tracks must be audible together: '+hz);
 const mainPCM=await decode(['-ss','0.1','-i',outputFile,'-t','0.4','-vn','-ac','1','-ar','8000','-f','f32le','pipe:1']);
 const amplitude=(buf,hz)=>{let a=0,b=0,n=buf.length/4;for(let i=0;i<n;i++){const v=buf.readFloatLE(i*4);a+=v*Math.cos(2*Math.PI*hz*i/8000);b+=v*Math.sin(2*Math.PI*hz*i/8000);}return Math.hypot(a,b)/n;};
 assert.ok(amplitude(mainPCM,440)>amplitude(mainPCM,880)*10,'Tail-only music must not start during main video');
 // Other scale modes and all output aspect ratios; music also works without tails.
 for(const mode of ['letterbox','stretch']){const noTail=await engine.process({...request,settings:{...settings,tailmix:false,scale:mode,formats:mode==='letterbox'?['9:16','16:9']:['4:5','4:3']},edits:{'0':{start:0,end:.25}}},resolve,path.join(outRoot,mode));assert.equal(noTail.length,2);for(const o of noTail)assert.ok(o.duration<.5);}
 const unique=await engine.process({...request,inputs:['0','6'],settings:{...settings,mode:'unique',copies:2}},resolve,path.join(outRoot,'unique'));assert.equal(unique.length,4);assert.equal(unique.filter(o=>o.name.endsWith('.png')).length,2);assert.ok(unique.every(o=>o.size>100));
 const controller=new AbortController();controller.abort();await assert.rejects(engine.process(request,resolve,path.join(outRoot,'cancel'),{signal:controller.signal}),/остановлена/);assert.equal(crypto.createHash('sha256').update(await fs.readFile(entries[0].path)).digest('hex'),before);
 assert.equal(await fs.stat(path.join(outRoot,'clean','work')).catch(()=>null),null);
});
test('Actual FFmpeg: intro plays first with its own sound, music and tails start after it',{timeout:180000},async()=>{
 await createFixtures();const engine=new Engine(root),outRoot=path.join(root,'test-results','creo-intro-'+crypto.randomUUID());await fs.mkdir(outRoot,{recursive:true});
 const intro=path.join(outRoot,'intro-green.mp4'),silentIntro=path.join(outRoot,'intro-silent.mp4');
 await engine.run('ffmpeg',['-y','-f','lavfi','-i','color=c=green:s=200x100:r=30:d=1','-f','lavfi','-i','sine=frequency=300:duration=1','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-shortest',intro]);
 await engine.run('ffmpeg',['-y','-f','lavfi','-i','color=c=green:s=200x100:r=30:d=0.5','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',silentIntro]);
 const entries=[['source.mp4',path.join(fixtures,'source.mp4')],['tail-red.mp4',path.join(fixtures,'tail-red.mp4')],['music-0.wav',path.join(fixtures,'music-0.wav')],['music-2.wav',path.join(fixtures,'music-2.wav')],['intro.mp4',intro],['silent.mp4',silentIntro]].map(([name,file],i)=>({id:String(i),name,path:file}));
 const resolve=id=>entries.find(e=>e.id===id);
 const settings={formats:['1:1'],tailSeconds:1,fade:.2,preset:'ultrafast',crf:30,threads:1,signalChange:false,verifyResults:false,intro:true};
 const request={settings,inputs:['0'],tails:['1'],intros:['4'],music:[{id:'2',volume:50}],tailMusic:[{id:'3',volume:50}],edits:{'0':{start:0,end:1}}};
 const decode=args=>new Promise((ok,fail)=>{const p=spawn(engine.ffmpeg,['-hide_banner','-nostdin','-loglevel','error',...args],{windowsHide:true});const b=[];let err='';p.stdout.on('data',x=>b.push(x));p.stderr.on('data',x=>err+=x);p.on('error',fail);p.on('close',c=>c?fail(Error(err)):ok(Buffer.concat(b)));});
 const pixel=(file,t)=>decode(['-ss',String(t),'-i',file,'-an','-frames:v','1','-vf','scale=1:1','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
 const tones=async(file,t,d=.4)=>{const pcm=await decode(['-ss',String(t),'-i',file,'-t',String(d),'-vn','-ac','1','-ar','8000','-f','f32le','pipe:1']);
  return hz=>{let a=0,b=0,n=pcm.length/4;for(let i=0;i<n;i++){const v=pcm.readFloatLE(i*4);a+=v*Math.cos(2*Math.PI*hz*i/8000);b+=v*Math.sin(2*Math.PI*hz*i/8000);}return Math.hypot(a,b)/n;};};
 const check=async(file,{introSeconds,introTone,tails})=>{
  const probe=await engine.probe(file);assert.equal(probe.width,720);assert.equal(probe.height,720);
  assert.ok(Math.abs(probe.duration-(introSeconds+1+(tails?1:0)))<.2,'duration '+probe.duration);
  const g=await pixel(file,introSeconds/2);assert.ok(g[1]>g[0]+40&&g[1]>g[2]+40,'intro frame must be green first');
  const m=await pixel(file,introSeconds+.5);assert.ok(!(m[1]>m[0]+40&&m[1]>m[2]+40),'main video follows the intro');
  const during=await tones(file,.05,Math.min(.4,introSeconds-.1));
  if(introTone)assert.ok(during(300)>during(440)*10,'intro keeps its own sound');
  assert.ok(during(440)<.002,'background music must not overlap the intro: '+during(440));
  assert.ok(during(220)<.002,'main audio must not overlap the intro');
  const main=await tones(file,introSeconds+.2);assert.ok(main(440)>.005,'music starts with the main video');assert.ok(main(220)>.005,'main audio follows the intro');assert.ok(main(880)<main(440)/10,'tail music waits for the tails');
  if(tails){const r=await pixel(file,introSeconds+1.5);assert.ok(r[0]>r[2]+100,'tail follows main video');const t=await tones(file,introSeconds+1.3);assert.ok(t(880)>.005,'tail music plays over tails');}
 };
 const fast=await engine.process(request,resolve,path.join(outRoot,'fast'));
 await check(path.join(outRoot,'fast',fast[0].name),{introSeconds:1,introTone:true,tails:true});
 const onlyIntro=await engine.process({...request,settings:{...settings,tailmix:false}},resolve,path.join(outRoot,'only-intro'));
 await check(path.join(outRoot,'only-intro',onlyIntro[0].name),{introSeconds:1,introTone:true,tails:false});
 const silent=await engine.process({...request,intros:['5']},resolve,path.join(outRoot,'silent'));
 await check(path.join(outRoot,'silent',silent[0].name),{introSeconds:.5,introTone:false,tails:true});
 // The filter-graph fallback produces the same timeline.
 engine.mixFast=async()=>{throw Error('forced fallback');};const warn=console.warn;console.warn=()=>{};
 try{const legacy=await engine.process(request,resolve,path.join(outRoot,'legacy'));await check(path.join(outRoot,'legacy',legacy[0].name),{introSeconds:1,introTone:true,tails:true});}finally{console.warn=warn;}
 await assert.rejects(engine.process({...request,intros:[]},resolve,path.join(outRoot,'missing')),/Начальная вставка/);
 const off=await engine.process({...request,settings:{...settings,intro:false,tailmix:false}},resolve,path.join(outRoot,'off'));assert.ok(Math.abs(off[0].duration-1)<.2,'intro off leaves the video unchanged');
 await fs.rm(outRoot,{recursive:true,force:true});
});
test('HandBrake-based compression profiles encode on the CPU and keep tails stream-copied',{timeout:240000},async()=>{
 assert.equal(config().compression,'custom');assert.throws(()=>config({compression:'bad'}),/профиль сжатия/);
 await createFixtures();const engine=new Engine(root),outRoot=path.join(root,'test-results','creo-compression-'+crypto.randomUUID());
 engine.hardwarePromise=Promise.resolve({available:['h264_nvenc'],preferred:'h264_nvenc'});
 const entries=['source.mp4','tail-red.mp4'].map((name,i)=>({id:String(i),name,path:path.join(fixtures,name)})),resolve=id=>entries.find(e=>e.id===id);
 const run=engine.run.bind(engine),encoders=new Set();
 engine.run=async(tool,args,options)=>{const i=args.indexOf('-c:v');if(tool==='ffmpeg'&&i>=0)encoders.add(args[i+1]);return run(tool,args,options);};
 try{
  for(const [compression,codec,tag] of [['hq','h264','avc1'],['hevc','hevc','hvc1']]){
   encoders.clear();
   const outputs=await engine.process({settings:{compression,formats:['1:1'],tailSeconds:1,fade:.2,threads:1,signalChange:false,verifyResults:false},inputs:['0'],tails:['1'],edits:{'0':{start:0,end:1}}},resolve,path.join(outRoot,compression));
   assert.equal(outputs.length,1);assert.ok(!encoders.has('h264_nvenc'),compression+' must not use the GPU encoder');
   const info=JSON.parse(await run('ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream=codec_name,codec_tag_string','-of','json',path.join(outRoot,compression,outputs[0].name)]));
   assert.equal(info.streams[0].codec_name,codec);assert.equal(info.streams[0].codec_tag_string,tag);
   assert.ok(Math.abs(outputs[0].duration-2)<.25,JSON.stringify(outputs[0]));
  }
 }finally{await fs.rm(outRoot,{recursive:true,force:true});}
});
test('video volume and music normalisation settings are validated and built into the filters',()=>{
 const {videoGain,musicFilter}=require('../src/server/creo-engine.cjs');
 assert.equal(config().videoVolume,100);assert.equal(config().musicNormalize,false);
 assert.equal(config({videoVolume:150.4}).videoVolume,150);
 for(const v of [-1,201,'loud'])assert.throws(()=>config({videoVolume:v}));
 assert.equal(videoGain(config()),'');assert.equal(videoGain(config({videoVolume:0})),',volume=0');assert.equal(videoGain(config({videoVolume:150})),',volume=1.5');
 assert.doesNotMatch(musicFilter(config(),5,.08),/loudnorm/);
 const normalized=musicFilter(config({musicNormalize:true}),5,.08,1200);
 assert.match(normalized,/loudnorm=I=-14:TP=-1:LRA=11,aresample=44100.*volume=0\.08,adelay=1200\|1200$/);
});
test('Actual FFmpeg: video sound volume changes only the clip, normalised music stays audible',{timeout:180000},async()=>{
 await createFixtures();const engine=new Engine(root),outRoot=path.join(root,'test-results','creo-volume-'+crypto.randomUUID());await fs.mkdir(outRoot,{recursive:true});
 const entries=[['source.mp4'],['tail-red.mp4'],['music-0.wav']].map(([name],i)=>({id:String(i),name,path:path.join(fixtures,name)}));const resolve=id=>entries.find(e=>e.id===id);
 const decode=args=>new Promise((ok,fail)=>{const p=spawn(engine.ffmpeg,['-hide_banner','-nostdin','-loglevel','error',...args],{windowsHide:true});const b=[];let err='';p.stdout.on('data',x=>b.push(x));p.stderr.on('data',x=>err+=x);p.on('error',fail);p.on('close',c=>c?fail(Error(err)):ok(Buffer.concat(b)));});
 const tone=async(file,hz,t=.3,d=.5)=>{const pcm=await decode(['-ss',String(t),'-i',file,'-t',String(d),'-vn','-ac','1','-ar','8000','-f','f32le','pipe:1']);let a=0,b=0,n=pcm.length/4;for(let i=0;i<n;i++){const v=pcm.readFloatLE(i*4);a+=v*Math.cos(2*Math.PI*hz*i/8000);b+=v*Math.sin(2*Math.PI*hz*i/8000);}return Math.hypot(a,b)/n;};
 const base={formats:['1:1'],preset:'ultrafast',crf:30,threads:1,signalChange:false,verifyResults:false,tailmix:false,tailSeconds:1,fade:.2};
 const render=async(name,settings,extra={})=>{const out=await engine.process({settings:{...base,...settings},inputs:['0'],tails:[],music:[],tailMusic:[],edits:{'0':{start:0,end:1.5}},...extra},resolve,path.join(outRoot,name));return path.join(outRoot,name,out[0].name);};
 const normal=await render('normal',{}),loud=await render('loud',{videoVolume:200}),muted=await render('muted',{videoVolume:0});
 const n=await tone(normal,220),l=await tone(loud,220),m=await tone(muted,220);
 assert.ok(l>n*1.6,'200% must be about twice as loud: '+l+' vs '+n);assert.ok(m<n/50,'0% must mute the clip: '+m);
 // Unique mode applies the same clip volume.
 const unique=await render('unique',{mode:'unique',copies:1,videoVolume:0,speed:0,pitch:0});assert.ok(await tone(unique,220)<n/50,'unique mode must mute the clip too');
 // Normalised music: quiet clip, music still mixed in, tails path (mixFast) too.
 const music=[{id:'2',volume:50}];
 const mixed=await render('normalized',{musicNormalize:true,videoVolume:0},{music});
 assert.ok(await tone(mixed,440)>await tone(mixed,220)*10,'normalised music must be audible over the muted clip');
 const withTails=await render('normalized-tails',{musicNormalize:true,videoVolume:50,tailmix:true},{music,tails:['1']});
 const probe=await engine.probe(withTails);assert.ok(probe.audio);assert.ok(Math.abs(probe.duration-2.5)<.25,'duration '+probe.duration);
 assert.ok(await tone(withTails,440,1.8,.5)>0.01,'music keeps playing over the tails');
 await fs.rm(outRoot,{recursive:true,force:true});
});
