const fs=require('node:fs/promises'),path=require('node:path'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const fixtures=path.join(root,'test-results','creo-fixtures');
async function createFixtures(){await fs.mkdir(fixtures,{recursive:true});const ff=[path.join(root,'tools','ffmpeg.exe'),path.join(root,'Media Studio Standalone','tools','ffmpeg.exe'),path.join(root,'CreoMaker v2','assets','bin','windows-x64','ffmpeg.exe')].find(p=>require('node:fs').existsSync(p));if(!ff)throw Error('Local FFmpeg fixture runtime is missing.');
 const run=args=>new Promise((resolve,reject)=>{const p=spawn(ff,['-hide_banner','-nostdin','-loglevel','error','-y','-threads','1','-filter_threads','1',...args],{windowsHide:true});let error='';p.stderr.on('data',b=>error+=b);p.on('error',reject);p.on('close',code=>code?reject(Error(error)):resolve());});
 await run(['-f','lavfi','-i','testsrc2=size=320x240:rate=30:duration=2','-f','lavfi','-i','sine=frequency=220:duration=2','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-shortest',path.join(fixtures,'source.mp4')]);
 for(const [name,color]of [['tail-red','red'],['tail-blue','blue']])await run(['-f','lavfi','-i',`color=c=${color}:s=160x120:r=30:d=1`,'-c:v','libx264','-preset','ultrafast',path.join(fixtures,name+'.mp4')]);
 for(const [i,hz]of [440,660,880].entries())await run(['-f','lavfi','-i',`sine=frequency=${hz}:duration=1`,'-c:a','pcm_s16le',path.join(fixtures,'music-'+i+'.wav')]);
 await run(['-f','lavfi','-i','testsrc2=size=320x240:duration=1','-frames:v','1',path.join(fixtures,'image.png')]);
 return fixtures;
}
module.exports={createFixtures,fixtures,root};
