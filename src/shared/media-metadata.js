/* A finite, validated tag vocabulary shared by the UI, AI adapter and FFmpeg. */
(()=>{'use strict';const fields={title:{label:'Название',max:150},subtitle:{label:'Подзаголовок',max:200},description:{label:'Описание',max:1200},synopsis:{label:'Краткое содержание',max:600},keywords:{label:'Ключевые слова',max:500},genre:{label:'Жанр / категория',max:100},comment:{label:'Комментарий',max:500},language:{label:'Язык содержимого',max:80},artist:{label:'Автор / организация',max:150},copyright:{label:'Права / лицензия',max:250}};
 const aiFields=Object.keys(fields).filter(k=>!['artist','copyright'].includes(k));
 function normalize(raw={},required=false){if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Некорректные метаданные.');const out={};for(const [key,{max,label}]of Object.entries(fields)){const value=raw[key]??'';if(typeof value!=='string'||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))throw Error('Проверьте поле «'+label+'» (до '+max+' символов).');out[key]=value.normalize('NFC').replace(/\s+/gu,' ').trim();if(required&&aiFields.includes(key)&&!out[key])throw Error('ИИ не заполнил поле «'+label+'».');}return out;}
 function generateEnglish(mode, previous={}) {
  const pick=words=>words[Math.floor(Math.random()*words.length)];
  const collection=pick(['Amber','Aster','Cedar','Ember','Flint','Halo','Indigo','Juniper','Lumen','Marble','Nova','Onyx','Orchid','Quartz','Sable','Slate']);
  const edition=pick(['Cut','Edition','Export','Frame','Master','Mix','Pass','Release','Render','Sequence','Study','Take']);
  const serial=Array.from({length:6},()=>pick('23456789ABCDEFGHJKLMNPQRSTUVWXYZ')).join('');
  const variant=mode==='unique';
  return normalize({
   title:collection+' '+edition+' '+serial,
   subtitle:variant?'Creative variant '+serial:'Edited export '+serial,
   description:(variant?'A locally processed creative variant.':'A locally edited media export.')+' Reference '+serial+'.',
   synopsis:'Part of the '+collection+' export collection.',
   keywords:[collection.toLowerCase(),edition.toLowerCase(),variant?'creative variant':'edited export',serial.toLowerCase()].join(', '),
   genre:variant?'Creative Variants':'Edited Media',
   comment:'Local export reference: '+serial,
   artist:previous.artist??'',
   copyright:previous.copyright??'',
   language:previous.language??''
  });
 }
 const schema={type:'object',properties:Object.fromEntries(aiFields.map(k=>[k,{type:'string'}])),required:aiFields,additionalProperties:false};const api={fields,aiFields,normalize,schema,generateEnglish};if(typeof module==='object'&&module.exports)module.exports=api;else globalThis.MediaMetadata=api;
})();
