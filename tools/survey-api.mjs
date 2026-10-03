import {readFile,writeFile,mkdir,rename,rm} from 'node:fs/promises';
import {randomBytes,randomUUID,createHmac,timingSafeEqual} from 'node:crypto';
import path from 'node:path';
import {decodeHtmlEntities} from './cms.mjs';
import {renderSitePage} from './site-render.mjs';

const DAY=86400000,COOKIE='zabota_survey',RETENTION=90*DAY;
const plain=html=>decodeHtmlEntities(html.replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim();
function fail(status,message){const error=new Error(message);error.status=status;throw error;}
export function surveyDefinition(content){
 const html=renderSitePage(content.data,'survey.html',content.overrides).html;
 return [...html.matchAll(/<fieldset\b[^>]*data-step="(\d+)"[^>]*>([\s\S]*?)<\/fieldset>/g)].map(match=>{
  const legend=match[2].match(/<legend\b[^>]*>([\s\S]*?)<\/legend>/)?.[1]||'';
  const question=plain(legend.replace(/<span\b[^>]*class="question-number"[^>]*>[\s\S]*?<\/span>/,'').replace(/<small\b[^>]*>[\s\S]*?<\/small>/g,''));
  const options=[...match[2].matchAll(/<input\b[^>]*type="radio"[^>]*value="([^"]*)"/g)].map(option=>decodeHtmlEntities(option[1]));
  return {id:Number(match[1])+1,question,options};
 });
}

export function createSurveyStore({projectRoot,stateDir=process.env.SURVEY_STATE_DIR||path.join(projectRoot,'.admin','surveys'),getContent,now=()=>Date.now()}={}){
 const file=path.join(stateDir,'responses.json'),keyFile=path.join(stateDir,'cookie-key');
 let queue=Promise.resolve(),keyPromise;
 const exclusive=work=>{const result=queue.then(work);queue=result.catch(()=>{});return result;};
 async function atomic(filename,value){await mkdir(stateDir,{recursive:true,mode:0o700});const temp=filename+'.'+randomUUID()+'.tmp';try{await writeFile(temp,value,{flag:'wx',mode:0o600});await rename(temp,filename);}finally{await rm(temp,{force:true});}}
 async function key(){
  keyPromise??=(async()=>{await mkdir(stateDir,{recursive:true,mode:0o700});try{return await readFile(keyFile);}catch(error){if(error.code!=='ENOENT')throw error;const value=randomBytes(32);try{await writeFile(keyFile,value,{flag:'wx',mode:0o600});return value;}catch(error){if(error.code!=='EEXIST')throw error;return readFile(keyFile);}}})();return keyPromise;
 }
 async function load(){
  let data;try{data=JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;data={version:1,total:0,counts:[{},{},{},{},{}],records:[],updatedAt:null};}
  if(data.version!==1||!Array.isArray(data.records)||!Array.isArray(data.counts)||data.counts.length!==5||!Number.isInteger(data.total)||data.total<0||data.counts.some(counts=>!counts||typeof counts!=='object'||Array.isArray(counts)||Object.values(counts).some(count=>!Number.isInteger(count)||count<0||count>data.total)))throw Error('Invalid survey storage');
  // Answer labels are editable content, so names such as "constructor" must
  // remain ordinary labels rather than inherited properties of Object.
  data.counts=data.counts.map(counts=>Object.assign(Object.create(null),counts));
  const retained=data.records.filter(record=>Date.parse(record.date)>now()-RETENTION);
  if(retained.length!==data.records.length){data.records=retained;await atomic(file,JSON.stringify(data,null,2)+'\n');}
  return data;
 }
 async function alreadyAnswered(req){
  const cookie=String(req.headers.cookie||'').split(';').map(p=>p.trim()).find(p=>p.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);
  if(!cookie||cookie.length>200)return false;
  const [payload,signature]=cookie.split('.');if(!/^[a-f\d]{32}-\d{13}$/.test(payload)||!/^[a-f\d]{64}$/.test(signature))return false;
  const actual=Buffer.from(signature,'hex'),expected=createHmac('sha256',await key()).update(payload).digest();
  if(!timingSafeEqual(actual,expected))return false;
  const time=Number(payload.slice(33));return time<=now()&&time>now()-DAY;
 }
 async function issueCookie(secure){const payload=randomBytes(16).toString('hex')+'-'+now();const signature=createHmac('sha256',await key()).update(payload).digest('hex');return `${COOKIE}=${payload}.${signature}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${secure?'; Secure':''}`;}
 async function save(payload,req){return exclusive(async()=>{
  if(await alreadyAnswered(req))fail(409,'Вы уже прошли опрос сегодня. Спасибо за участие.');
  if(!payload||payload.consent!==true||!Array.isArray(payload.answers)||payload.answers.length!==6)fail(400,'Ответьте на вопросы и подтвердите согласие на обработку данных.');
  if(payload.website)fail(400,'Не удалось принять ответ.');
  const definition=surveyDefinition(await getContent());if(definition.length!==6)throw Error('Invalid survey definition');
  const answers=definition.map((question,index)=>{
   const answer=payload.answers[index]?.answer;
   if(typeof answer!=='string'||answer.length>(index===5?3000:2000)||/[\u0000\u0008\u000b\u000c]/.test(answer))fail(400,'Некорректный ответ на вопрос.');
   if(index<5&&!question.options.includes(answer))fail(400,'Выберите ответы из списка. Если вопросы изменились, обновите страницу.');
   return {question:question.question,answer:answer.trim()};
  });
  const data=await load();for(let i=0;i<5;i++){const label=answers[i].answer;const counts=Object.assign(Object.create(null),data.counts[i]);counts[label]=(counts[label]||0)+1;data.counts[i]=counts;}
  const date=new Date(now()).toISOString();data.total++;data.updatedAt=date;data.records.unshift({id:randomUUID(),date,answers,consent:true,consentVersion:'2026-10-03'});
  // Compute the cookie before writing: a key/filesystem failure must not consume a vote.
  const cookie=await issueCookie(Boolean(req.socket.encrypted)||String(process.env.ADMIN_PUBLIC_ORIGIN||'').startsWith('https:'));
  await atomic(file,JSON.stringify(data,null,2)+'\n');return {saved:true,cookie};
 });}
 async function results(req){return exclusive(async()=>{
  const data=await load(),definition=surveyDefinition(await getContent());
  return {total:data.total,updatedAt:data.updatedAt,alreadyAnswered:await alreadyAnswered(req),questions:definition.slice(0,5).map((question,index)=>{
   const counts=data.counts[index],labels=[...new Set([...question.options,...Object.keys(counts)])];
   return {question:question.question,answers:labels.map(label=>{const count=Object.hasOwn(counts,label)?counts[label]:0;return {label,count,percent:data.total?Math.round(count*1000/data.total)/10:0};})};
  })};
 });}
 async function getResponses({page=1}={}){return exclusive(async()=>{const data=await load(),number=Math.max(1,Math.min(100000,Number.parseInt(page)||1));return {total:data.total,totalRecords:data.records.length,page:number,pageSize:25,retentionDays:90,records:data.records.slice((number-1)*25,number*25)};});}
 const purgeExpired=()=>exclusive(()=>load());
 return {save,results,getResponses,purgeExpired};
}

export function createSurveyApi({store,origin=process.env.ADMIN_PUBLIC_ORIGIN,now=()=>Date.now()}={}){
 const attempts=new Map();
 const send=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
 return async function handle(req,res,url){
  if(!['/api/survey','/api/survey/results'].includes(url.pathname))return false;
  try{
   const host=new URL('http://'+req.headers.host),expected=origin?new URL(origin).origin:(req.socket.encrypted?'https:':'http:')+'//'+host.host;
   if(origin&&host.host!==new URL(origin).host)fail(403,'Адрес запроса не совпадает с адресом сайта.');
   if(req.headers.origin&&req.headers.origin!==expected)fail(403,'Запрос разрешён только с этого сайта.');
   if(req.headers['sec-fetch-site']==='cross-site')fail(403,'Запрос разрешён только с этого сайта.');
   if(url.pathname==='/api/survey/results'){
    if(req.method!=='GET')fail(405,'Этот способ запроса не поддерживается.');send(res,200,await store.results(req));return true;
   }
   if(req.method!=='POST')fail(405,'Этот способ запроса не поддерживается.');
   const ip=req.socket.remoteAddress||'unknown',current=now();let entry=attempts.get(ip);
   if(!entry||entry.expires<current){if(attempts.size>=2048)attempts.delete(attempts.keys().next().value);entry={count:0,expires:current+3600000};attempts.set(ip,entry);}
   if(++entry.count>15)fail(429,'Слишком много попыток. Попробуйте позже.');
   if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))fail(415,'Некорректный формат запроса.');
   let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>20000)fail(413,'Ответ слишком длинный.');chunks.push(chunk);}
   let payload;try{payload=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail(400,'Некорректный ответ.');}
   const result=await store.save(payload,req);res.setHeader('Set-Cookie',result.cookie);send(res,201,{saved:true});
  }catch(error){send(res,error.status||500,{error:error.status?error.message:'Не удалось сохранить ответ. Попробуйте позже.'});}
  return true;
 };
}
