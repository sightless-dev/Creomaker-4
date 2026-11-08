const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const P=require('../src/shared/creo-profiles.js'),{Engine,config}=require('../src/server/creo-engine.cjs');
const {root,fixtures}=require('./creo-fixtures.cjs');
test('Visual profiles validate, preserve legacy defaults and detect manual changes',()=>{
 assert.equal(config().textureOpacity,0);assert.equal(config().gamma,1);
 for(const p of P.presets){const s=config({...p.settings,mode:'unique'});assert.equal(P.match(s).id,p.id);assert.equal(P.match({...s,zoom:.345}),undefined);assert.equal(s.flip,false);}
 for(const raw of [{textureOpacity:41},{colorShift:-1},{outputFps:5},{tone:'constructor'},{tone:'bad'},{gamma:0},{pixelation:17}])assert.throws(()=>config(raw));
});
test('Actual FFmpeg: all four visual profiles, texture preview, images and audio',{timeout:180000},async()=>{
 const engine=new Engine(root),folder=path.join(root,'test-results','creo-pro-'+crypto.randomUUID());await fs.mkdir(folder,{recursive:true});
 // Independent synthetic fixtures avoid concurrent writes by the existing suite.
 const source=path.join(folder,'source.mp4'),picture=path.join(folder,'image.png');
 await engine.run('ffmpeg',['-y','-f','lavfi','-i','testsrc2=size=320x240:rate=30:duration=0.6','-f','lavfi','-i','sine=frequency=440:duration=0.6','-c:v','libx264','-preset','ultrafast','-c:a','aac','-shortest',source]);
 await engine.run('ffmpeg',['-y','-i',source,'-frames:v','1',picture]);
 engine.hardwarePromise=Promise.resolve({available:[],preferred:'libx264'});
 for(const profile of P.presets){const s=config({...profile.settings,mode:'unique',copies:1,acceleration:'cpu',preset:'ultrafast'}),out=path.join(folder,profile.id);const outputs=await engine.process({settings:s,inputs:['video','image']},id=>({id,name:id==='video'?'source.mp4':'image.png',path:id==='video'?source:picture}),out);assert.equal(outputs.length,2);assert.ok((await engine.probe(path.join(out,outputs[0].name))).audio);assert.ok(outputs[0].duration<1);assert.ok(outputs.every(o=>o.size>100));await engine.preview(source,s,{},path.join(folder,profile.id+'.jpg'),.1,undefined,[.6,.4,.7]);}
 const s=config({...P.presets[3].settings,mode:'unique'});await engine.preview(picture,s,{},path.join(folder,'image-preview.jpg'));
 // Texture must change real output pixels, not just the settings or file tags.
 const seed=[.5,.5,.5];await engine.preview(picture,{...s,textureOpacity:0},{},path.join(folder,'no-texture.jpg'),0,undefined,seed);await engine.preview(picture,s,{},path.join(folder,'texture.jpg'),0,undefined,seed);assert.notDeepEqual(await fs.readFile(path.join(folder,'no-texture.jpg')),await fs.readFile(path.join(folder,'texture.jpg')));
});
