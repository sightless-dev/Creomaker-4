const {spawn}=require('node:child_process');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {Engine,config,editConfig,formats}=require('../src/server/creo-engine.cjs');const {createFixtures,fixtures,root}=require('./creo-fixtures.cjs');
test('CreoMaker rejects invalid settings and always uses all selected media',()=>{assert.equal(config({tailMode:'random',musicMode:'random'}).musicMode,'all');assert.equal(config().tailMode,'all');for(const raw of [{tailSeconds:0},{threads:99},{formats:['bad']},{copies:51},{scale:'bad'},{pitch:31}])assert.throws(()=>config(raw));assert.throws(()=>editConfig({start:1,end:.5},2));assert.throws(()=>editConfig({zones:Array(21).fill({})},2));assert.equal(Object.keys(formats).length,5);});
test('Actual FFmpeg: clean formats, blur, all tails/music, images, unique videos and cancellation',{timeout:180000},async()=>{
 await createFixtures();const engine=new Engine(root),outRoot=path.join(root,'test-results','creo-engine-'+crypto.randomUUID());await fs.mkdir(outRoot,{recursive:true});const entries=['source.mp4','tail-red.mp4','tail-blue.mp4','music-0.wav','music-1.wav','music-2.wav','image.png'].map((name,i)=>({id:String(i),name,path:path.join(fixtures,name)}));const resolve=id=>entries.find(e=>e.id===id);const before=crypto.createHash('sha256').update(await fs.readFile(entries[0].path)).digest('hex');
 const settings={formats:['1:1'],tailSeconds:2,fade:.2,preset:'ultrafast',crf:30,threads:1,signalChange:false,verifyResults:false};const edits={'0':{start:.2,end:1.2,strength:12,zones:[{x:.1,y:.1,w:.2,h:.2},{x:.8,y:.8,w:.2,h:.2}]}};
 await engine.preview(entries[0].path,config(settings),edits['0'],path.join(outRoot,'preview.jpg'),.4);assert.ok((await fs.stat(path.join(outRoot,'preview.jpg'))).size>100);
 await engine.timeline(entries[0].path,config(settings),path.join(outRoot,'timeline.jpg'));assert.ok((await fs.stat(path.join(outRoot,'timeline.jpg'))).size>100);
 const request={settings,inputs:['0'],tails:['1','2'],music:[{id:'3',volume:8},{id:'4',volume:8}],tailMusic:[{id:'5',volume:8}],edits};
 let updates=0;const outputs=await engine.process(request,resolve,path.join(outRoot,'clean'),{onUpdate:()=>updates++});assert.equal(outputs.length,1);assert.ok(updates>4);const probe=await engine.probe(path.join(outRoot,'clean',outputs[0].name));assert.equal(probe.width,720);assert.equal(probe.height,720);assert.ok(probe.audio);assert.ok(Math.abs(probe.duration-3)<.2,JSON.stringify(probe));
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
