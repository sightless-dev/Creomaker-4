'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),https=require('node:https');
process.env.STATS_SCHEDULE='off';
Object.defineProperty(process,'loadEnvFile',{value:function ignoreEnvFiles(){},writable:false,configurable:false});
for(const key of Object.keys(process.env))if(/API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|WHYRAT_AI_KEY_|WHISPER_.*(?:KEY|TOKEN)/i.test(key))delete process.env[key];
const local=new Set(['127.0.0.1','localhost','[::1]','::1']);
function check(input,protocol){let host,port;try{if(typeof input==='string'||input instanceof URL){const u=new URL(input);host=u.hostname;port=Number(u.port||(u.protocol==='https:'?443:80));}else{host=input?.hostname||input?.host||'localhost';port=Number(input?.port||(protocol==='https:'?443:80));if(host.includes(':')&&!local.has(host)&&!host.startsWith('[')){const s=host.split(':');host=s[0];port=Number(s[1]||port);}if(input?.socketPath)host='socket';}}catch{host='invalid';}
 if(local.has(host)&&port!==4177&&port!==4188&&port!==4190&&port!==4191)return;
 fs.appendFileSync(path.join(__dirname,'network-blocks.jsonl'),JSON.stringify({host,port:port||null})+'\n');
 const error=new Error('Design sandbox blocks external network and production Dashboard ports.');error.code='WHYRAT_DESIGN_NETWORK_BLOCKED';throw error;
}
for(const [module,protocol]of [[http,'http:'],[https,'https:']])for(const method of ['request','get']){const original=module[method];module[method]=function(input,...args){check(input,protocol);return original.call(this,input,...args);};}
const originalFetch=globalThis.fetch;globalThis.fetch=function(input,...args){try{check(typeof input==='string'||input instanceof URL?input:input.url,'https:');}catch(error){return Promise.reject(error);}return originalFetch.call(this,input,...args);};


