// Local FFmpeg pipeline ported from CreoMaker v2/src/MediaProcessor.cs.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const {accessSync,constants,statSync}=require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const formats = { '9:16':[720,1280], '16:9':[1280,720], '1:1':[720,720], '4:5':[720,900], '4:3':[960,720] };
const videoExts = ['.mp4','.mov','.avi','.mkv','.webm'];
const imageExts = ['.jpg','.jpeg','.png','.webp','.bmp','.tiff'];
const audioExts = ['.mp3','.wav','.aac','.m4a','.ogg','.flac'];
const presets = ['ultrafast','superfast','veryfast','faster','fast','medium','slow'];
const M=require('../shared/media-metadata.js');
const P=require('../shared/creo-profiles.js');
const Verification = require('./creo-verification.cjs');
const defaults = { ...P.defaults, mode:'clean', acceleration:'auto', country:'', metadataTitle:'', metadataTopic:'', metadataLanguage:'', metadataTags:{}, nameTag:'', formats:['9:16','1:1'], scale:'crop', previewFormat:'', crf:26, preset:'faster', threads:0, noise:true, bitrateEnabled:false, bitrate:12000, tailmix:true, musicMix:true, tailSeconds:60, fade:1.5, copies:1, uniqueNoise:5, hue:2, saturation:1.02, contrast:1.03, brightness:0, speed:2, flip:true, metadata:true, jpeg:95, zoom:2, rotate:1.5, blur:1, pitch:15 };
function num(v,min,max,fallback) { const n=Number(v ?? fallback); if(!Number.isFinite(n)||n<min||n>max) throw Error(`Значение должно быть от ${min} до ${max}.`); return n; }
function config(raw={}) {
  const s={...defaults,...raw}; delete s.encoder;s.metadataTags=M.normalize(s.metadataTags);for(const [k,max]of [['metadataTopic',1000],['metadataLanguage',80]])if(typeof s[k]!=='string'||s[k].length>max)throw Error('Некорректный бриф метаданных.');
  if(!['auto','cpu','amd','nvidia','intel','apple'].includes(s.acceleration))throw Error('Неверный режим ускорения.');
  if(s.country!==''&&!require('../shared/countries.js').codes.includes(s.country))throw Error('Неверная страна метаданных.');
  if(typeof s.nameTag!=='string'||s.nameTag.length>64)throw Error('Метка имени — до 32 символов.');s.nameTag=P.safeTag(s.nameTag);
  if(typeof s.metadataTitle!=='string'||s.metadataTitle.length>150||/[\x00-\x1f]/.test(s.metadataTitle))throw Error('Название метаданных — до 150 символов.'); if(!['clean','unique'].includes(s.mode))throw Error('Неизвестный режим.');
  if(!Array.isArray(s.formats)||!s.formats.length||s.formats.some(f=>!formats[f]))throw Error('Выберите форматы кадра.'); s.formats=[...new Set(s.formats)];
  if(s.previewFormat&&!formats[s.previewFormat])throw Error('Неверный формат предпросмотра.');
  if(!['crop','letterbox','stretch'].includes(s.scale)||!presets.includes(s.preset))throw Error('Неверный режим масштабирования или кодирования.');
  for(const [key,min,max] of [['crf',0,51],['threads',0,32],['bitrate',10000,15000],['tailSeconds',1,1800],['fade',0,8],['copies',1,50],['uniqueNoise',0,15],['hue',0,10],['saturation',.95,1.1],['contrast',.95,1.1],['brightness',-.1,.1],['speed',0,5],['jpeg',80,100],['zoom',0,5],['rotate',0,5],['blur',0,5],['pitch',0,30]])s[key]=num(s[key],min,max,defaults[key]);
  for(const [key,,min,max] of P.fields)s[key]=num(s[key],min,max,P.defaults[key]);
  for(const key of ['colorShift','pixelation','outputFps'])s[key]=Math.round(s[key]);
  if(s.outputFps&&s.outputFps<12)throw Error('Частота кадров: 0 или от 12 до 60.');
  if(!Object.hasOwn(P.tones,s.tone))throw Error('Неверное тонирование.');
  for(const key of ['threads','copies','jpeg','uniqueNoise','crf'])s[key]=Math.round(s[key]);
  for(const key of ['noise','bitrateEnabled','tailmix','musicMix','flip','metadata','verifyResults','signalChange'])s[key]=Boolean(s[key]);
  // The web integration intentionally has no random/single media-selection modes.
  s.tailMode='all';s.musicMode='all';return s;
}
const f=n=>Number(n).toFixed(6).replace(/\.?0+$/,'')||'0';
const random=(a,b)=>a+crypto.randomInt(0,1000000)/1000000*(b-a);
function scale(mode,w,h){return mode==='stretch'?`scale=${w}:${h}`:mode==='letterbox'?`scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`:`scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;}
function editConfig(raw={},duration) {
  const start=num(raw.start,0,Math.max(0,duration-.01),0),end=num(P.trimEnd(raw.end,duration),0,duration,duration);
  if(end-start<Math.min(duration,.05)-1e-9)throw Error('Конец фрагмента должен быть позже начала хотя бы на 0,05 с.');
  const zones=raw.zones||[];if(!Array.isArray(zones)||zones.length>20)throw Error('Не более 20 зон размытия.');
  return {start,end,strength:num(raw.strength,4,40,18),zones:zones.map(z=>({x:num(z.x,0,1,0),y:num(z.y,0,1,0),w:num(z.w,.002,1,.1),h:num(z.h,.002,1,.1)}))};
}
function blurZones(vf,edit,w,h){let s=vf;for(const [i,z]of edit.zones.entries()){const x=Math.min(w-2,Math.floor(z.x*w)),y=Math.min(h-2,Math.floor(z.y*h)),bw=Math.max(2,Math.min(w-x,Math.floor(z.w*w))),bh=Math.max(2,Math.min(h-y,Math.floor(z.h*h)));s+=`,split[b${i}base][b${i}src];[b${i}src]crop=${bw}:${bh}:${x}:${y},gblur=sigma=${f(edit.strength)}[b${i}blur];[b${i}base][b${i}blur]overlay=${x}:${y}`;}return s;}
function uniqueFilter(s,image,seed) {
  let cursor=0;const rand=(a,b)=>seed? a+seed[(cursor++)%seed.length]*(b-a):random(a,b);const parts=[];
  if(s.uniqueNoise)parts.push(`noise=alls=${s.uniqueNoise}:all_seed=${Math.floor(rand(1,99999))}`);
  if(s.hue||s.saturation!==1)parts.push(`hue=s=${f(s.saturation)}:h=${f(rand(-s.hue,s.hue))}`);
  if(s.contrast!==1||s.brightness)parts.push(`eq=contrast=${f(s.contrast)}:brightness=${f(s.brightness)}`);
  if(s.flip&&rand(0,1)>.5)parts.push('hflip');
  if(s.blur){const b=rand(-s.blur,s.blur);if(b>.1)parts.push(`gblur=sigma=${f(b)}`);else if(b<-.1)parts.push(`unsharp=3:3:${f(-b)}`);}
  let zoom=1+s.zoom/100;
  if(s.rotate){const r=rand(-s.rotate,s.rotate);parts.push(`rotate=a=${f(r)}*PI/180:ow=iw:oh=ih:c=black`);zoom+=Math.abs(r)*.025;}
  if(zoom>1.001){const z=rand(1,zoom);parts.push(`scale=trunc(iw*${f(z)}/2)*2:trunc(ih*${f(z)}/2)*2,crop=trunc(iw/${f(z)}/2)*2:trunc(ih/${f(z)}/2)*2`);}
  if(s.gamma!==1&&s.gamma!=null)parts.push('eq=gamma='+f(s.gamma));
  if(s.tone==='warm')parts.push('colorbalance=rs=.06:bs=-.04');
  if(s.tone==='cool')parts.push('colorbalance=rs=-.04:bs=.06');
  if(s.tone==='mono')parts.push('hue=s=0');
  if(s.colorShift)parts.push('rgbashift=rh='+s.colorShift+':bh=-'+s.colorShift+':edge=smear');
  if(s.pixelation>1)parts.push("scale='max(1,trunc(iw/"+s.pixelation+"))':'max(1,trunc(ih/"+s.pixelation+"))':flags=neighbor",'scale=iw*'+s.pixelation+':ih*'+s.pixelation+':flags=neighbor');
  if(s.vignette)parts.push('vignette=angle='+f(s.vignette/100)+'*PI/4');
  const speed=!image&&s.speed?rand(1-s.speed/100,1+s.speed/100):1;
  if(speed!==1)parts.push(`setpts=${f(1/speed)}*(PTS-STARTPTS)`);
  if(!image&&s.outputFps)parts.push('fps='+s.outputFps);
  if(!image)parts.push('scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1');
  const pitch=s.pitch?rand(1-s.pitch/100,1+s.pitch/100):1;
  const audio=`aresample=44100,atempo=${f(speed)},asetrate=44100*${f(pitch)},aresample=44100,atempo=${f(1/pitch)}`;
  return {video:parts.join(',')||'null',audio,speed};
}
function toolPath(root,name){
  const override=process.env['CREO_'+name.toUpperCase()+'_PATH'];
  if(override)return path.resolve(override);
  const binary=name+(process.platform==='win32'?'.exe':'');
  const local=path.join(root,'tools',binary);
  const candidates=[local,...(process.env.PATH||'').split(path.delimiter).filter(path.isAbsolute).map(dir=>path.join(dir,binary))];
  return candidates.find(file=>{
    try{accessSync(file,constants.X_OK);return statSync(file).isFile();}catch{return false;}
  })||local;
}

function processingSettings(settings, probe) {
  const active = !probe.image && settings.signalChange && (settings.mode === 'unique' || settings.tailmix);
  const automaticFps = Math.abs(probe.frameRate - 30) < .1 ? 25 : 30;
  return { ...settings, signalChange: active, outputFps: settings.outputFps || (active ? automaticFps : 0) };
}

function compositionFilter(settings, width, height) {
  if (!settings.signalChange || !settings.signalCrop) return 'null';
  const ratio = 1 - settings.signalCrop * 2 / 100;
  return `crop=trunc(iw*${f(ratio)}/2)*2:trunc(ih*${f(ratio)}/2)*2,scale=${width}:${height}`;
}

function audioSignalFilter(settings) {
  if (!settings.signalChange) return 'anull';
  const ratio = 1 + settings.signalPitch / 100;
  return `asetrate=44100*${f(ratio)},aresample=44100,atempo=${f(1 / ratio)},volume=${f(settings.signalLevel / 100)}`;
}

function variantFilter(settings, probe, seed) {
  const filter = uniqueFilter(settings, probe.image, seed);
  if (!probe.image) {
    filter.coreAudio = filter.audio;
    filter.video += ',' + compositionFilter(settings, Math.max(2, probe.displayWidth - probe.displayWidth % 2), Math.max(2, probe.displayHeight - probe.displayHeight % 2));
    filter.audio += ',' + audioSignalFilter(settings);
  }
  return filter;
}
function preferredStream(streams,type,score){
  return streams.filter(stream=>stream.codec_type===type).sort((a,b)=>
    Number(a.disposition?.attached_pic||0)-Number(b.disposition?.attached_pic||0)||
    Number(b.disposition?.default||0)-Number(a.disposition?.default||0)||
    score(b)-score(a)
  )[0];
}
class Engine {
  constructor(root){this.texture=path.join(root,'src','server','assets','paper-texture.png');this.ffmpeg=toolPath(root,'ffmpeg');this.ffprobe=toolPath(root,'ffprobe');this.cache=new Map();}
  run(tool,args,{signal,progress,duration=1,threads=0}={}) {return new Promise((resolve,reject)=>{
    if(signal?.aborted)return reject(Error('Обработка остановлена.'));
    const ff=tool==='ffmpeg';if(ff){args=args.flatMap((v,i)=>v==='-i'&&args[i-1]!=='lavfi'?['-protocol_whitelist','file,pipe','-i']:[v]);}else args=['-protocol_whitelist','file,pipe',...args];
    const th=Number(threads)||0;
    const threadFlags=th>0?['-threads',String(th),'-filter_threads',String(th),'-filter_complex_threads',String(th)]:['-threads','0'];
    const all=ff?['-hide_banner','-nostdin','-loglevel','error',...threadFlags,...args.slice(0,-1),'-threads',String(th),'-progress','pipe:1','-nostats',args.at(-1)]:args;
    const child=spawn(ff?this.ffmpeg:this.ffprobe,all,{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});let output='',error='',line='';
    const abort=()=>child.kill();signal?.addEventListener('abort',abort,{once:true});
    child.stdout.on('data',b=>{if(!ff){output+=b;if(output.length>1000000)child.kill();return;}line+=b;const lines=line.split('\n');line=lines.pop();for(const l of lines){const m=/^out_time_us=(\d+)/.exec(l);if(m)progress?.(Math.min(.995,Number(m[1])/1000000/duration));}});
    child.stderr.on('data',b=>{error=(error+b).slice(-5000)});
    child.on('error',e=>{signal?.removeEventListener('abort',abort);reject(e)});
    child.on('close',code=>{signal?.removeEventListener('abort',abort);if(signal?.aborted)return reject(Error('Обработка остановлена.'));if(code!==0)return reject(Error('FFmpeg: '+(error.trim()||'ошибка '+code)));progress?.(1);resolve(output);});
  });}
  async probe(file, signal) {
    const stat = await fs.stat(file);
    const key = file + ':' + stat.size + ':' + stat.mtimeMs;
    if (this.cache.has(key)) return this.cache.get(key);
    const raw = JSON.parse(await this.run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { signal }));
    const streams=raw.streams||[];
    const video=preferredStream(streams,'video',stream=>(stream.width||0)*(stream.height||0));
    const audio=preferredStream(streams,'audio',stream=>stream.channels||0);
    const image = imageExts.includes(path.extname(file).toLowerCase());
    const duration = image ? 1 : Number(raw.format?.duration || video?.duration);
    if (!image && (!duration || !Number.isFinite(duration))) throw Error('Не удалось определить длительность медиа.');
    const rate = String(video?.avg_frame_rate || video?.r_frame_rate || '0/1').split('/').map(Number);
    const rotation = Number(video?.side_data_list?.find(item => item.rotation != null)?.rotation || 0);
    const sideways = Math.abs(rotation % 180) === 90;
    const result = {
      width: video?.width || 0, height: video?.height || 0,
      displayWidth: sideways ? video.height : video?.width || 0,
      displayHeight: sideways ? video.width : video?.height || 0,
      audio: Boolean(audio), duration, image, videoIndex:video?.index, audioIndex:audio?.index,
      videoDuration: Number(video?.duration) || duration,
      frameRate: rate[1] && rate[0] ? rate[0] / rate[1] : null,
      tags: raw.format?.tags || {}
    };
    this.cache.set(key, result);
    return result;
  }
  quality(s){return s.bitrateEnabled?['-b:v',s.bitrate+'k','-maxrate',s.bitrate+'k','-bufsize',s.bitrate*2+'k']:['-crf',String(s.crf)];}
  async hardware(){
    if(!this.hardwarePromise)this.hardwarePromise=(async()=>{
      const measured=[];
      const candidates=process.platform==='darwin'?['h264_videotoolbox']:process.platform==='win32'?['h264_nvenc','h264_amf','h264_qsv']:['h264_nvenc','h264_vaapi','h264_qsv'];
      for(const encoder of candidates){
        try{
          const start=performance.now();
          await this.run('ffmpeg',['-f','lavfi','-i','testsrc2=size=720x1280:rate=30','-frames:v','45',...this.codec({...defaults,encoder}),'-an','-f','null','-'],{signal:AbortSignal.timeout(6000)});
          measured.push({encoder,elapsed:performance.now()-start});
        }catch{}
      }
      const available=measured.sort((a,b)=>a.elapsed-b.elapsed).map(result=>result.encoder);
      return {available,preferred:available[0]||'libx264'};
    })();
    return this.hardwarePromise;
  }
  codec(s){
    if(s.encoder&&s.encoder!=='libx264'){
      let q;
      if(s.bitrateEnabled){
        q=['-b:v',s.bitrate+'k','-maxrate',s.bitrate+'k','-bufsize',s.bitrate*2+'k'];
      }else if(s.encoder==='h264_amf'){
        q=['-rc','cqp','-qp_i',String(s.crf),'-qp_p',String(s.crf)];
      }else if(s.encoder==='h264_nvenc'){
        q=['-rc','vbr','-cq',String(s.crf),'-b:v','0'];
      }else if(s.encoder==='h264_videotoolbox'){
        const vtQuality=Math.max(30,Math.min(95,Math.round(100-s.crf*1.5)));
        // VideoToolbox only supports constant quality on Apple Silicon.
        q=process.arch==='arm64'?['-q:v',String(vtQuality)]:['-b:v',s.bitrate+'k'];
      }else{
        q=['-global_quality',String(s.crf)];
      }
      const encoderPreset=s.encoder==='h264_amf'?['-quality','balanced']:s.encoder==='h264_nvenc'?['-preset','p4']:s.encoder==='h264_videotoolbox'?['-allow_sw','0']:['-preset','medium'];
      return ['-c:v',s.encoder,...q,...encoderPreset,'-pix_fmt','yuv420p','-c:a','aac','-b:a','192k'];
    }
    return ['-c:v','libx264',...this.quality(s),'-preset',s.preset,'-pix_fmt','yuv420p','-c:a','aac','-b:a','192k'];
  }
  metadata(s={metadata:true}){if(!s.metadata)return ['-map_metadata','0'];const tags={...M.normalize(s.metadataTags||{}),title:s.metadataTitle||'',country:s.country||'',country_name:require('../shared/countries.js').list.find(c=>c.code===s.country)?.name||'',creation_time:new Date().toISOString(),date:new Date().toISOString().slice(0,10),creomaker_processing_id:crypto.randomUUID()};if(!tags.comment)tags.comment='Prepared with CreoMaker'+(s.country?' | Region: '+s.country:'');return ['-map_metadata','-1','-map_metadata:s','-1',...Object.entries(tags).flatMap(([key,value])=>['-metadata',key+'='+value])];}
  uniqueArgs(s,p,filter,preview=false){
    const resize=preview?',scale=640:640:force_original_aspect_ratio=decrease':'';
    if(!s.textureOpacity)return ['-vf',filter.video+resize];
    const w=Math.max(2,Math.floor((p.displayWidth||p.width)/2)*2),h=Math.max(2,Math.floor((p.displayHeight||p.height)/2)*2);
    const graph='[0:'+p.videoIndex+']'+filter.video+',scale='+w+':'+h+',format=yuv420p,setsar=1[base];[1:v]scale='+w+':'+h+',format=yuv420p,setsar=1[paper];[base][paper]blend=all_mode=softlight:all_opacity='+f(s.textureOpacity/100)+':shortest=1'+resize+'[styled]';
    return ['-loop','1','-i',this.texture,'-filter_complex',graph,'-map','[styled]',...(!preview&&!p.image&&p.audio?['-map','0:'+p.audioIndex]:[])];
  }
  async preview(file,s,rawEdit,output,time=0,signal,seed){
    const p=await this.probe(file,signal);if(!p.width)throw Error('Файл не содержит изображения.');
    const end=Math.max(0,(p.videoDuration||p.duration)-Math.max(.08,2/(p.frameRate||30)));
    const target=p.image?0:Math.min(Math.max(0,time),end);
    let filters;if(s.mode==='unique'){const rendered=processingSettings(s,p);filters=this.uniqueArgs(rendered,p,variantFilter(rendered,p,seed),true);}
    else{const [w,h]=formats[s.previewFormat||s.formats[0]],e=editConfig(rawEdit,p.duration);filters=['-vf',blurZones(scale(s.scale,w,h),e,w,h)+',scale=960:960:force_original_aspect_ratio=decrease'];}
    return this.grab(file,p,target,filters,output,signal);
  }
  /** Unprocessed source frame at the same time for before/after comparison. Pixels only scaled down for display. */
  async sourceFrame(file,output,time=0,signal){
    const p=await this.probe(file,signal);if(!p.width)throw Error('Файл не содержит изображения.');
    const end=Math.max(0,(p.videoDuration||p.duration)-Math.max(.08,2/(p.frameRate||30)));
    return this.grab(file,p,p.image?0:Math.min(Math.max(0,time),end),['-vf','scale=960:960:force_original_aspect_ratio=decrease'],output,signal);
  }
  async grab(file,p,target,filters,output,signal){
    for(const seek of [...new Set([target,Math.max(0,target-.75),0])]){
      await fs.rm(output,{force:true});
      await this.run('ffmpeg',['-y',...(!p.image?['-ss',f(seek)]:[]),'-i',file,...filters,'-an','-frames:v','1','-q:v','3',output],{signal});
      const bytes=await fs.readFile(output).catch(()=>null);
      if(bytes?.length>4&&bytes[0]===255&&bytes[1]===216)return p;
      if(signal?.aborted)throw Error('Предпросмотр отменён.');
    }
    throw Error('Не удалось декодировать кадр. Выберите другое время или проверьте исходное видео.');
  }
  async timeline(file,s,output,signal){
    const p=await this.probe(file,signal),[w,h]=formats[s.previewFormat||s.formats[0]],frames=output+'.frames';await fs.mkdir(frames,{recursive:true});
    const vf=scale(s.scale,w,h)+',scale=80:60:force_original_aspect_ratio=decrease,pad=80:60:(ow-iw)/2:(oh-ih)/2';
    try{for(let i=0;i<12;i++)await this.run('ffmpeg',['-y','-ss',f(Math.min(Math.max(0,p.duration-.05),i*p.duration/12)),'-i',file,'-an','-vf',vf,'-frames:v','1','-q:v','5',path.join(frames,String(i).padStart(2,'0')+'.jpg')],{signal});
      await this.run('ffmpeg',['-y','-framerate','1','-i',path.join(frames,'%02d.jpg'),'-vf','tile=12x1','-frames:v','1','-q:v','5',output],{signal});
    }finally{await fs.rm(frames,{recursive:true,force:true});}
  }
  async process(request,resolveMedia,outDir,{signal,reportDir,onUpdate=()=>{}}={}) {
    const s=config(request.settings),inputs=request.inputs.map(resolveMedia);if(!inputs.length||inputs.length>200)throw Error('Добавьте от 1 до 200 файлов.');
    if(s.mode==='clean'&&inputs.some(i=>!videoExts.includes(path.extname(i.path).toLowerCase())))throw Error('Clean3 принимает только видео.');
    const tails=(request.tails||[]).map(resolveMedia),music=s.musicMix?(request.music||[]).map(t=>({...resolveMedia(t.id),volume:num(t.volume,0,200,8)/100})):[],tailMusic=s.tailmix&&s.musicMix?(request.tailMusic||[]).map(t=>({...resolveMedia(t.id),volume:num(t.volume,0,200,8)/100})):[];
    if(s.mode==='clean'&&s.tailmix&&!tails.length)throw Error('Добавьте хвосты или отключите Tailmix.');
    const hardware=s.acceleration==='cpu'?{available:[],preferred:'libx264'}:await this.hardware();s.encoder=s.acceleration==='cpu'?'libx264':s.acceleration==='auto'?hardware.preferred:({amd:'h264_amf',nvidia:'h264_nvenc',intel:'h264_qsv',apple:'h264_videotoolbox'})[s.acceleration]||'libx264';
    if(s.encoder!=='libx264'&&!hardware.available.includes(s.encoder))throw Error('Выбранный GPU-кодировщик недоступен. Выберите «Авто» или CPU.');
    await fs.mkdir(outDir,{recursive:true});
    const work=await fs.mkdtemp(path.join(path.dirname(outDir),'.creomaker-work-'));
    const outputs=[],total=inputs.length*(s.mode==='clean'?s.formats.length:s.copies);let done=0;
    const update=(label,fraction=0)=>onUpdate({label,progress:(done+fraction)/total,done,total,outputs:[...outputs]});
    const run=async(args,label,duration,from=0,weight=1)=>{update(label,from);const options={signal,threads:s.threads,duration,progress:v=>update(label,from+v*weight)};
      const codecIndex=args.indexOf('-c:v'),encoder=codecIndex<0?null:args[codecIndex+1];
      const decode=encoder&&encoder!=='libx264'&&!args.includes('lavfi');
      if(decode){
        const hwaccel=process.platform==='darwin'?'videotoolbox':process.platform==='win32'?'d3d11va':null;
        if(hwaccel){
          const accelerated=[...args],index=accelerated.indexOf('-i');accelerated.splice(index,0,'-hwaccel',hwaccel);
          try{await this.run('ffmpeg',accelerated,options);return;}catch(e){if(signal?.aborted)throw e;update('GPU-декодирование недоступно для фрагмента · '+encoder,from);}
        }
      }
      await this.run('ffmpeg',args,options);};
    const encoders=s.acceleration==='auto'?[...hardware.available,'libx264']:[s.encoder];
    let encoderIndex=0;
    const encode=async(settings,render)=>{
      for(;;){
        try{return await render({...settings,encoder:encoders[encoderIndex]});}
        catch(error){
          if(encoderIndex===encoders.length-1||signal?.aborted)throw error;
          const next=encoders[++encoderIndex];
          update('Кодировщик недоступен · повтор на '+(next==='libx264'?'CPU':next));
        }
      }
    };
    const encName=s.encoder==='h264_videotoolbox'?'Apple VideoToolbox (GPU)':s.encoder==='h264_nvenc'?'NVIDIA NVENC (GPU)':s.encoder==='h264_amf'?'AMD AMF (GPU)':s.encoder==='h264_qsv'?'Intel QSV (GPU)':'CPU (x264)';
    update('Кодирование: '+encName+' · потоков: '+(s.threads||'все ядра'));const cycleCache=new Map();
    const baselines = new Map();
    try{for(const [inputIndex,input]of inputs.entries()){
      if(signal?.aborted)throw Error('Обработка остановлена.');const probe=await this.probe(input.path,signal);if(!probe.width)throw Error('Нужен файл видео или изображения.');
      const rendered = processingSettings(s, probe);
      const requiresSignals = s.mode === 'unique' || s.tailmix;
      if (s.verifyResults && !probe.image) {
        update('Анализ исходника · ' + input.name);
        baselines.set(input.id, await Verification.inspect(this, input.path, signal));
      }
      for(const target of s.mode==='clean'?s.formats:Array.from({length:s.copies},(_,i)=>i+1)){
        const ext=s.mode==='unique'&&probe.image?path.extname(input.name).toLowerCase():'.mp4';const name=P.outputName({index:inputIndex,name:input.name,target,mode:s.mode,image:probe.image,tag:s.nameTag}),output=path.join(outDir,name),part=path.join(work,'output'+ext);
        if(s.mode==='unique'){
          const filter=variantFilter(rendered,probe),outDuration=probe.duration/filter.speed;
          if(!probe.image&&music.length){
            await encode(rendered,settings=>this.mixUnique(input.path,probe,settings,filter,music,part,outDuration,run,target,input.name));
          }else{
            const render=async settings=>{
              const args=['-y','-i',input.path,...this.uniqueArgs(rendered,probe,filter)];
              if(probe.image){args.push('-frames:v','1');if(['.jpg','.jpeg'].includes(ext))args.push('-q:v',String(Math.max(1,Math.round(31-s.jpeg*.3))));if(ext==='.webp')args.push('-quality','90');}
              else{args.push(...this.codec({...settings,bitrateEnabled:false}));if(probe.audio)args.push('-af',filter.audio);args.push('-movflags','+faststart+use_metadata_tags');}
              if(s.metadata)args.push(...this.metadata(s));args.push(part);await run(args,'Вариант '+target+' · '+input.name,outDuration);
            };
            if(probe.image)await render(s);else await encode(rendered,render);
          }
        }else{
          const [w,h]=formats[target],e=editConfig(request.edits?.[input.id],probe.duration);
          const color=`${s.noise?'noise=alls=2:all_seed='+crypto.randomInt(1,99999)+',':''}hue=s=${f(random(1,1.05))}:h=${f(random(-1.5,1.5))},eq=contrast=${f(random(1.01,1.05))},`;
          const vf=blurZones(color+scale(s.scale,w,h)+',setsar=1',e,w,h);
          let cycle=null;
          if(s.tailmix){
            const cycleKey = target + '@' + (rendered.outputFps || 30);
            cycle=cycleCache.get(cycleKey);
            if(!cycle){
              cycle=await encode(rendered,settings=>this.prepareCycle(tails,work,target,settings,run,signal));
              cycleCache.set(cycleKey,cycle);
            }
          }
          await encode(rendered,settings=>this.mix(input.path,cycle,music,tailMusic,part,settings,e,vf,probe,run,target));
        }
        await fs.rename(part,output);
        const finalProbe=await this.probe(output,signal);
        const entry = {name,input:input.id,target:String(target),size:(await fs.stat(output)).size,duration:finalProbe.image?null:finalProbe.duration,width:finalProbe.width,height:finalProbe.height};
        outputs.push(entry);
        if (s.verifyResults && !probe.image) {
          entry.verification = { status: 'pending' };
          update('Проверка изменений · ' + name, .98);
          try {
            const edit = s.mode === 'clean' ? editConfig(request.edits?.[input.id], probe.duration) : null;
            entry.verification = await Verification.verify(this, input.path, output, {
              reportDir,
              requireSignals: requiresSignals,
              requireAudio: requiresSignals || music.length > 0,
              metadataEnabled: s.metadata,
              mainDuration: edit ? edit.end - edit.start : probe.duration,
              tailSeconds: s.mode === 'clean' && s.tailmix ? s.tailSeconds : 0
            }, baselines.get(input.id), signal);
          } catch (error) {
            entry.verification = { status: 'unavailable', warnings: 1, error: error.message };
            update('Файл сохранён · проверка не завершена', .99);
            if (signal?.aborted) throw error;
          }
        }
        done++;update(entry.verification?.warnings ? 'Сохранено с замечаниями · ' + name : 'Готово · ' + name);
      }
    }}finally{await fs.rm(work,{recursive:true,force:true});}
    return outputs;
  }
  async prepareCycle(tails,work,target,s,run,signal){
    const [w,h]=formats[target],fps=s.outputFps||30,format=target.replace(':','_');
    const clips=[];
    let elapsed=0;
    // All selected tails form one ordered cycle; fixed target duration may trim its ending.
    for(const [index,tail] of tails.entries()){
      if(elapsed>=s.tailSeconds)break;
      const probe=await this.probe(tail.path,signal);
      if(!probe.width||probe.image)throw Error('Хвост должен быть видео.');
      const duration=Math.min(probe.duration,s.tailSeconds-elapsed);
      const clip='tail-'+format+'-'+index+'.mp4';
      const args=['-y','-i',tail.path];
      if(!probe.audio)args.push('-f','lavfi','-i','anullsrc=r=44100:cl=stereo');
      args.push('-map','0:'+probe.videoIndex,'-map',probe.audio?'0:'+probe.audioIndex:'1:a:0','-vf',scale('crop',w,h)+',fps='+fps+',format=yuv420p,setsar=1','-af','aresample=44100,aformat=channel_layouts=stereo,apad','-t',f(duration),...this.codec(s),path.join(work,clip));
      await run(args,`Хвост ${index+1}/${tails.length} · ${target}`,duration,index*.3/tails.length,.3/tails.length);
      clips.push(clip);
      elapsed+=duration;
    }
    const list=path.join(work,'cycle.txt');
    await fs.writeFile(list,clips.map(clip=>"file '"+clip+"'").join('\n'));
    const file=path.join(work,'cycle-'+format+'-'+fps+'.mp4');
    await run(['-y','-f','concat','-safe','1','-i',list,'-c','copy',file],'Сборка всех хвостов · '+target,elapsed,.3,.05);
    return file;
  }
  async mix(main,cycle,music,tailMusic,output,s,edit,videoFilter,probe,run,format){
    const duration=edit.end-edit.start,total=duration+(cycle?s.tailSeconds:0);
    const args=['-y','-ss',f(edit.start),'-t',f(duration),'-i',main],graph=[],audio=[];let input=1;
    if(cycle){args.push('-stream_loop','-1','-t',f(s.tailSeconds),'-i',cycle);input++;}
    const fade=cycle?Math.min(s.fade,Math.max(0,duration-.1)):0;
    const outputFps = s.outputFps || 30;
    graph.push(`[0:${probe.videoIndex}]${videoFilter},fps=${outputFps},format=yuv420p,setsar=1,setpts=PTS-STARTPTS${fade?`,fade=t=out:st=${f(duration-fade)}:d=${f(fade)}`:''}[mv]`);
    const af=`aresample=44100,aformat=channel_layouts=stereo,apad,atrim=duration=${f(duration)},asetpts=PTS-STARTPTS`;
    graph.push(probe.audio?`[0:${probe.audioIndex}]${af}${fade?`,afade=t=out:st=${f(duration-fade)}:d=${f(fade)}`:''}[ma]`:`anullsrc=r=44100:cl=stereo,atrim=duration=${f(duration)},asetpts=PTS-STARTPTS[ma]`);
    if(cycle){graph.push(`[1:v]trim=duration=${f(s.tailSeconds)},setpts=PTS-STARTPTS,fps=${outputFps},setsar=1[tv]`,`[1:a]aresample=44100,aformat=channel_layouts=stereo,apad,atrim=duration=${f(s.tailSeconds)},asetpts=PTS-STARTPTS[ta]`,'[mv][tv]concat=n=2:v=1:a=0[joinedv]','[ma][ta]concat=n=2:v=0:a=1[base]');}else graph.push('[mv]null[joinedv]','[ma]anull[base]');audio.push('[base]');
    for(const track of music){args.push('-stream_loop','-1','-t',f(total),'-i',track.path);const label='m'+input;graph.push(`[${input}:a]aresample=44100,aformat=channel_layouts=stereo,atrim=duration=${f(total)},asetpts=PTS-STARTPTS,volume=${f(track.volume)}[${label}]`);audio.push('['+label+']');input++;}
    if(cycle)for(const track of tailMusic){args.push('-stream_loop','-1','-t',f(s.tailSeconds),'-i',track.path);const label='t'+input;graph.push(`[${input}:a]aresample=44100,aformat=channel_layouts=stereo,atrim=duration=${f(s.tailSeconds)},asetpts=PTS-STARTPTS,volume=${f(track.volume)},adelay=${Math.round(duration*1000)}|${Math.round(duration*1000)}[${label}]`);audio.push('['+label+']');input++;}
    graph.push(audio.length>1?`${audio.join('')}amix=inputs=${audio.length}:duration=first:dropout_transition=2:normalize=0[mixeda]`:'[base]anull[mixeda]');
    const [width, height] = formats[format];
    graph.push('[joinedv]' + compositionFilter(s, width, height) + '[outv]');
    graph.push('[mixeda]' + audioSignalFilter(s) + '[outa]');
    args.push('-filter_complex',graph.join(';'),'-map','[outv]','-map','[outa]',...this.codec(s),...this.metadata(s),'-t',f(total),'-movflags','+faststart+use_metadata_tags',output);
    await run(args,'Финальная сборка · '+format,total,cycle?.35:0,cycle?.65:1);
  }
  async mixUnique(inputPath,probe,s,filter,music,output,duration,run,target,inputName){
    const args=['-y','-i',inputPath],graph=[],audio=['[basea]'];let input=1;
    if(s.textureOpacity){
      args.push('-loop','1','-i',this.texture);const tex=input++;
      const w=Math.max(2,Math.floor((probe.displayWidth||probe.width)/2)*2),h=Math.max(2,Math.floor((probe.displayHeight||probe.height)/2)*2);
      graph.push(`[0:${probe.videoIndex}]${filter.video},scale=${w}:${h},format=yuv420p,setsar=1[basev]`,`[${tex}:v]scale=${w}:${h},format=yuv420p,setsar=1[paper]`,`[basev][paper]blend=all_mode=softlight:all_opacity=${f(s.textureOpacity/100)}:shortest=1[outv]`);
    }else graph.push(`[0:${probe.videoIndex}]${filter.video}[outv]`);
    const baseAf=`aresample=44100,aformat=channel_layouts=stereo,apad,atrim=duration=${f(duration)},asetpts=PTS-STARTPTS`;
    graph.push(probe.audio?`[0:${probe.audioIndex}]${filter.coreAudio||filter.audio},${baseAf}[basea]`:`anullsrc=r=44100:cl=stereo,atrim=duration=${f(duration)},asetpts=PTS-STARTPTS[basea]`);
    for(const track of music){
      args.push('-stream_loop','-1','-t',f(duration),'-i',track.path);const label='m'+input;
      graph.push(`[${input}:a]aresample=44100,aformat=channel_layouts=stereo,atrim=duration=${f(duration)},asetpts=PTS-STARTPTS,volume=${f(track.volume)}[${label}]`);
      audio.push('['+label+']');input++;
    }
    graph.push(`${audio.join('')}amix=inputs=${audio.length}:duration=first:dropout_transition=2:normalize=0,${audioSignalFilter(s)}[outa]`);
    args.push('-filter_complex',graph.join(';'),'-map','[outv]','-map','[outa]',...this.codec({...s,bitrateEnabled:false}),...this.metadata(s),'-t',f(duration),'-movflags','+faststart+use_metadata_tags',output);
    await run(args,'Вариант '+target+' · '+inputName,duration);
  }
}
module.exports={Engine,config,editConfig,scale,blurZones,uniqueFilter,processingSettings,formats,defaults,videoExts,imageExts,audioExts};
