import {readFile,writeFile,mkdir,rename,rm,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {renderSite,renderSitePage} from './site-render.mjs';
import {isSafeUrl,validateOverrides} from './cms.mjs';
import {galleryCaptions} from './sections.mjs';

const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
function bad(message){const error=new Error(message);error.status=400;throw error;}
function text(value,label,max=30000){if(typeof value!=='string'||value.length>max||/[\u0000\u0008\u000b\u000c]/.test(value))bad(`Некорректное значение: ${label}.`);return value;}
function url(value,label,kind='href'){text(value,label,4000);if(!isSafeUrl(value,kind))bad(`Недопустимый адрес: ${label}.`);return value;}
function keys(value,expected,label){if(!object(value)||Object.keys(value).some(key=>!expected.includes(key))||expected.some(key=>!Object.hasOwn(value,key)))bad(`Некорректный набор: ${label}.`);}
const clone=value=>structuredClone(value);

export function createContentStore({projectRoot=fileURLToPath(new URL('../',import.meta.url)),distRoot=path.join(projectRoot,'dist'),stateFile=process.env.CMS_STATE_FILE||path.join(projectRoot,'cms-content.json'),backupDir=process.env.CMS_BACKUP_DIR||path.join(projectRoot,'.admin','backups')}={}){
 let baselinePromise;
 let queue=Promise.resolve();
 const exclusive=work=>{const result=queue.then(work);queue=result.catch(()=>{});return result;};
 async function baseline(){
  baselinePromise??=readFile(path.join(projectRoot,'content.json'),'utf8').then(JSON.parse).then(data=>{
   data.phone='+7 (921) 869-24-58';data.placeStats={free:99,planned:200,actual:101,date:'2026-10-01'};data.extraSections={};
   for(const [key,items] of Object.entries(data.galleries))items.forEach((item,index)=>{item.caption=galleryCaptions[key]?.[index]||item.name||'Изображение';item.alt=item.caption;});
   return data;
  });
  return baselinePromise;
 }
 async function validateData(input){
  if(!object(input))bad('Некорректное содержимое сайта.');
  const base=await baseline(),data=clone(base);
  keys(input.images,Object.keys(base.images),'изображения');
  for(const key of Object.keys(base.images))data.images[key]=url(input.images[key],key,'src');
  keys(input.documents,Object.keys(base.documents),'документы');
  for(const [key,original] of Object.entries(base.documents)){
   const doc=input.documents[key];if(!object(doc))bad('Некорректный документ.');
   if(!['PDF','DOCX','RTF','TXT'].includes(doc.format)||!Number.isInteger(doc.size)||doc.size<1||doc.size>25*1024*1024)bad('Некорректный формат или размер документа.');
   const extension=doc.format.toLowerCase(),src=url(doc.src,'документ '+key);
   if(!new RegExp('\\.'+extension+'(?:[?#]|$)','i').test(src))bad('Формат документа не соответствует адресу файла.');
   data.documents[key]={...original,src,size:doc.size,format:doc.format};
   for(const field of ['title','description'])if(Object.hasOwn(doc,field))data.documents[key][field]=text(doc[field],field,4000);
  }
  keys(input.galleries,Object.keys(base.galleries),'галереи');
  for(const [key,items] of Object.entries(input.galleries)){
   if(!Array.isArray(items)||items.length>200)bad('Галерея может содержать до 200 изображений.');
   data.galleries[key]=items.map(item=>{
    if(!object(item))bad('Некорректное изображение галереи.');
    const clean={src:url(item.src,'изображение галереи','src')};
    if(item.thumb)clean.thumb=url(item.thumb,'миниатюра','src');
    for(const field of ['name','caption','alt'])if(Object.hasOwn(item,field))clean[field]=text(item[field],field,2000);
    return clean;
   });
  }
  keys(input.links,Object.keys(base.links),'внешние ссылки');
  for(const key of Object.keys(base.links))data.links[key]=url(input.links[key],key);
  data.email=text(input.email,'почта',254);
  if(!/^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(data.email))bad('Укажите корректную электронную почту.');
  data.phone=text(input.phone,'телефон',60);if(!/^\+?[\d ().-]{7,60}$/.test(data.phone))bad('Укажите корректный телефон.');
  if(!object(input.placeStats))bad('Укажите численность и дату сведений.');
  data.placeStats={};
  for(const key of ['free','planned','actual']){const value=input.placeStats[key];if(!Number.isInteger(value)||value<0||value>1000000)bad('Численность должна быть целым неотрицательным числом.');data.placeStats[key]=value;}
  const date=text(input.placeStats.date,'дата',10);if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)bad('Укажите корректную дату сведений.');data.placeStats.date=date;
  if(!object(input.extraSections)||Object.keys(input.extraSections).some(file=>!renderSite(base).catalog.pages.some(page=>page.file===file)))bad('Некорректные дополнительные блоки.');
  data.extraSections={};
  for(const [file,blocks] of Object.entries(input.extraSections)){
   if(!Array.isArray(blocks)||blocks.length>50)bad('На странице может быть до 50 дополнительных блоков.');
   const seen=new Set();
   data.extraSections[file]=blocks.map(block=>{
    if(!object(block)||!/^[a-zA-Z0-9_-]{1,100}$/.test(block.id)||seen.has(block.id))bad('Некорректный идентификатор блока.');seen.add(block.id);
    const clean={id:block.id,title:text(block.title,'заголовок',3000),text:text(block.text,'текст блока')};
    if(block.image)clean.image=url(block.image,'изображение блока','src');
    if(block.href)clean.href=url(block.href,'ссылка блока');
    for(const field of ['alt','linkLabel'])if(Object.hasOwn(block,field))clean[field]=text(block[field],field,2000);
    return clean;
   });
  }
  return data;
 }
 function validatePatches(data,input){
  let patches;try{patches=validateOverrides(input);}catch(error){bad(error.message);}
  const items=new Map(renderSite(data).catalog.items.map(item=>[item.id,item]));
  for(const [id,patch] of Object.entries(patches)){
   const item=items.get(id);if(!item)bad('Элемент страницы изменился. Обновите редактор и повторите правку.');
   const fields=item.kind==='text'?['text']:item.kind==='link'?['href']:['src','alt'];
   if(Object.keys(patch).some(field=>!fields.includes(field)))bad('Изменение не соответствует типу элемента.');
  }
  return patches;
 }
 async function load(){
  try{const model=JSON.parse(await readFile(stateFile,'utf8'));const data=await validateData(model.data);return {...model,data,overrides:validatePatches(data,model.overrides)};}
  catch(error){if(error.code!=='ENOENT')throw error;return {revision:'initial',data:clone(await baseline()),overrides:{},updatedAt:null};}
 }
 async function atomic(file,body){await mkdir(path.dirname(file),{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';try{await writeFile(temp,body,{flag:'wx'});await rename(temp,file);}finally{await rm(temp,{force:true});}}
 async function publish(model){
  const rendered=renderSite(model.data,model.overrides).rendered;
  const previous=await Promise.all(rendered.map(async page=>{try{return await readFile(path.join(distRoot,page.file));}catch(error){if(error.code==='ENOENT')return null;throw error;}}));
  try{
   for(const page of rendered)await atomic(path.join(distRoot,page.file),page.html);
   await atomic(stateFile,JSON.stringify(model,null,2)+'\n');
  }catch(error){for(let i=0;i<rendered.length;i++){if(previous[i])await atomic(path.join(distRoot,rendered[i].file),previous[i]);else await rm(path.join(distRoot,rendered[i].file),{force:true});}throw error;}
 }
 async function backup(model){await mkdir(backupDir,{recursive:true});const id=new Date().toISOString().replace(/[:.]/g,'-')+'_'+randomUUID();await atomic(path.join(backupDir,id+'.json'),JSON.stringify(model,null,2)+'\n');}
 async function getContent(){const model=await load();return {...model,catalog:renderSite(model.data,model.overrides).catalog};}
 async function saveContent(payload){return exclusive(async()=>{
  const current=await load();if(payload.revision!==current.revision){const error=new Error('Сайт уже изменён в другой вкладке. Обновите редактор перед сохранением.');error.status=409;throw error;}
  const data=await validateData(payload.data),overrides=validatePatches(data,payload.overrides);
  const model={revision:randomUUID(),updatedAt:new Date().toISOString(),data,overrides};
  await backup(current);await publish(model);return {saved:true,revision:model.revision};
 });}
 async function listVersions(){
  let files;try{files=await readdir(backupDir);}catch(error){if(error.code==='ENOENT')return [];throw error;}
  return Promise.all(files.filter(name=>/^[\dTZ-]+_[a-f0-9-]+\.json$/.test(name)).sort().reverse().map(async name=>{const model=JSON.parse(await readFile(path.join(backupDir,name),'utf8'));const timestamp=name.slice(0,24).replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3}Z)$/,'$1:$2:$3.$4');return {id:name.slice(0,-5),revision:model.revision,createdAt:model.updatedAt||timestamp,date:model.updatedAt||null};}));
 }
 async function restore(id){return exclusive(async()=>{
  if(typeof id!=='string'||!/^[\dTZ-]+_[a-f0-9-]+$/.test(id))bad('Некорректная версия.');
  let source;try{source=JSON.parse(await readFile(path.join(backupDir,id+'.json'),'utf8'));}catch(error){if(error.code==='ENOENT')bad('Версия не найдена.');throw error;}
  const current=await load(),data=await validateData(source.data),overrides=validatePatches(data,source.overrides);
  const model={revision:randomUUID(),updatedAt:new Date().toISOString(),data,overrides};await backup(current);await publish(model);return {saved:true,revision:model.revision};
 });}
 async function preview({page,content}){const data=await validateData(content.data),overrides=validatePatches(data,content.overrides);if(typeof page!=='string'||!renderSite(data).catalog.pages.some(item=>item.file===page))bad('Страница не найдена.');return renderSitePage(data,page,overrides,{preview:true}).html;}
 async function build(){const model=await load();for(const page of renderSite(model.data,model.overrides).rendered)await atomic(path.join(distRoot,page.file),page.html);}
 return {getContent,saveContent,listVersions,restore,preview,build};
}
