/**
 * A small, dependency-free content layer for the existing static renderer.
 * Only plain text and explicitly allowed URL/image attributes are editable.
 * Original element structure, SVG icons and inert popup templates are retained.
 */
const VOID = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
const RAW = new Set(['script','style']);
const EXCLUDED = new Set(['script','style','svg','noscript','head','option']);
const TEXT_TAGS = new Set('h1 h2 h3 h4 h5 h6 p summary label legend li dt dd a button span strong small em b i u div caption th td output'.split(' '));
const ENTITIES = {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:'\u00a0',ndash:'–',mdash:'—',laquo:'«',raquo:'»',hellip:'…',copy:'©',reg:'®',bull:'•',middot:'·',thinsp:'\u2009',ensp:'\u2002',emsp:'\u2003'};
export function escapeHtml(value){return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
export function decodeHtmlEntities(value){return String(value).replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z\d]+);/gi,(all,key)=>{
 if(key[0]==='#'){const number=key[1]?.toLowerCase()==='x'?parseInt(key.slice(2),16):Number(key.slice(1));return number>0&&number<=0x10ffff?String.fromCodePoint(number):all;}
 return Object.hasOwn(ENTITIES,key)?ENTITIES[key]:all;
});}

/** Reject active schemes, protocol-relative URLs, traversal and control bytes. */
export function isSafeUrl(value,type='href'){
 if(typeof value!=='string'||!value||value.length>4000||value!==value.trim())return false;
 let decoded=value;
 try{for(let i=0;i<3;i++){const next=decodeURIComponent(decoded);if(next===decoded)break;decoded=next;}}catch{return false;}
 if(/[\u0000-\u001f\u007f\\]/.test(decoded)||decoded.startsWith('//'))return false;
 if(/^https?:\/\//i.test(value)){
  try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!!url.hostname&&!url.username&&!url.password;}catch{return false;}
 }
 if(type==='src')return /^assets\/(?:images|uploads)\/[^?#]+$/i.test(decoded)&&!decoded.split('/').some(part=>part==='.'||part==='..')&&!/[<>"']/.test(decoded);
 if(/^mailto:/i.test(value))return /^mailto:[^\s@?<>"']+@[^\s@?<>"']+(?:\?[^<>"']*)?$/i.test(decoded);
 if(/^tel:/i.test(value))return /^tel:\+?[\d(). -]{3,40}$/i.test(decoded);
 if(/^#[\p{L}\p{N}_:.%-]+$/u.test(value))return true;
 if(/[:<>"']/.test(decoded)||decoded.startsWith('/')||decoded.split(/[/?#]/).some(part=>part==='.'||part==='..'))return false;
 const pathname=decoded.split(/[?#]/)[0];
 return /^assets\/(?:documents|images|uploads)\/.+/i.test(pathname)||/^[\p{L}\p{N}_-]+\.html$/u.test(pathname);
}

/** Validate at both save time and build time; never accept HTML from the editor. */
export function validateOverrides(input={}){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length>10000)throw new Error('Некорректные изменения содержимого.');
 const result=Object.create(null);
 for(const [id,patch] of Object.entries(input)){
  if(!/^[\p{L}\p{N}_:./~-]{1,500}$/u.test(id)||['__proto__','constructor','prototype'].includes(id)||!patch||typeof patch!=='object'||Array.isArray(patch))throw new Error('Некорректный идентификатор содержимого.');
  const clean={};
  for(const [field,value] of Object.entries(patch)){
   if(!['text','href','src','alt'].includes(field)||typeof value!=='string')throw new Error('Доступны только текст, адрес ссылки, изображение и его описание.');
   if(value.length>(field==='text'?30000:field==='alt'?2000:4000)||/[\u0000\u0008\u000b\u000c]/.test(value))throw new Error('Слишком длинное или некорректное значение.');
   if((field==='href'||field==='src')&&!isSafeUrl(value,field))throw new Error('Недопустимый адрес ссылки или изображения.');
   clean[field]=value;
  }
  result[id]=clean;
 }
 return result;
}

function endOfTag(html,start){
 let quote='';
 for(let i=start+1;i<html.length;i++){const c=html[i];if(quote){if(c===quote)quote='';}else if(c==='"'||c==="'")quote=c;else if(c==='>')return i+1;}
 return html.length;
}
function parseAttrs(raw,nameEnd){
 const attrs=[];
 const body=raw.slice(nameEnd,raw.length-(raw.endsWith('/>')?2:1));
 const pattern=/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
 for(const match of body.matchAll(pattern))attrs.push({name:match[1],key:match[1].toLowerCase(),value:match[2]??match[3]??match[4]??null});
 return attrs;
}
function attr(node,name){const found=node.attrs?.find(a=>a.key===name);return found?.value===null?'':found?decodeHtmlEntities(found.value):undefined;}
function hasClass(node,name){return (attr(node,'class')||'').split(/\s+/).includes(name);}
function setAttr(node,name,value){
 const found=node.attrs.find(a=>a.key===name);
 if(found)found.value=escapeHtml(value);else node.attrs.push({name,key:name,value:escapeHtml(value)});
 node.changed=true;
}
function parseHtml(html){
 const root={type:'root',children:[]};const stack=[root];let pos=0;
 const add=node=>{node.parent=stack.at(-1);node.parent.children.push(node);};
 while(pos<html.length){
  if(html[pos]!=='<'){let end=html.indexOf('<',pos);if(end<0)end=html.length;add({type:'text',raw:html.slice(pos,end)});pos=end;continue;}
  if(html.startsWith('<!--',pos)){let end=html.indexOf('-->',pos+4);end=end<0?html.length:end+3;add({type:'raw',raw:html.slice(pos,end)});pos=end;continue;}
  const end=endOfTag(html,pos),raw=html.slice(pos,end);
  if(/^<\//.test(raw)){
   const name=raw.match(/^<\/\s*([^\s>]+)/)?.[1]?.toLowerCase();
   const index=stack.findLastIndex(node=>node.tag===name);
   if(index>0){stack[index].close=raw;stack.length=index;}else add({type:'raw',raw});
   pos=end;continue;
  }
  const found=raw.match(/^<([a-z][\w:-]*)/i);
  if(!found){add({type:'raw',raw});pos=end;continue;}
  const node={type:'element',tag:found[1].toLowerCase(),name:found[1],attrs:parseAttrs(raw,found[0].length),open:raw,close:'',children:[],selfClosing:raw.endsWith('/>'),changed:false};
  add(node);pos=end;
  if(VOID.has(node.tag)||node.selfClosing)continue;
  if(RAW.has(node.tag)){
   const closing=new RegExp('</'+node.tag+'\\s*>','ig');closing.lastIndex=pos;const match=closing.exec(html);
   node.children.push({type:'raw',raw:html.slice(pos,match?.index??html.length),parent:node});node.close=match?.[0]||'';pos=match?match.index+match[0].length:html.length;
  }else stack.push(node);
 }
 return root;
}
function serialize(node){
 if(node.type==='root')return node.children.map(serialize).join('');
 if(node.type==='text'||node.type==='raw')return node.raw;
 const open=node.changed?'<'+node.name+node.attrs.map(a=>' '+a.name+(a.value===null?'':'="'+a.value+'"')).join('')+(node.selfClosing?'/>':'>'):node.open;
 return open+node.children.map(serialize).join('')+node.close;
}
function descendants(node,predicate){
 const found=[];function walk(n){for(const child of n.children||[])if(child.type==='element'){if(predicate(child))found.push(child);walk(child);}}walk(node);return found;
}
function textOf(node){return (node.children||[]).map(child=>child.type==='text'?decodeHtmlEntities(child.raw):child.type==='element'&&child.tag!=='svg'?textOf(child):'').join('').replace(/\s+/g,' ').trim();}
function slug(value){return String(value).replace(/[^\p{L}\p{N}_-]+/gu,'-').replace(/^-|-$/g,'').slice(0,120)||'block';}
function headingOf(node){return descendants(node,n=>/^h[1-6]$/.test(n.tag))[0];}
function nearest(node,predicate){for(let n=node;n?.type!=='root';n=n.parent)if(predicate(n))return n;return null;}

/**
 * @returns {{html:string, items:Array, sections:Array, tables:Array}}
 * Item contract: {id,kind,value,defaultValue,alt?,label,section,sectionLabel,page,tag}.
 * Shared header/footer use page="shared" and identical IDs on all nine pages.
 * Table cell IDs are the same IDs used in overrides[id].text.
 */
export function decorateHtml(html,page,overrides={}){
 const patches=validateOverrides(overrides),tree=parseHtml(String(html));
 const items=[],sections=[],tables=[],sectionMap=new Map(),tableNodes=[];
 const pageKey=slug(String(page).replace(/\.html$/,''));
 const systemIds=new Set(['reading-panel','version-dialog','dialog-root']);
 function section(id,title,scopePage){
  const key=scopePage+':'+id;
  if(!sectionMap.has(key)){const entry={id:key,key:id,page:scopePage,title};sectionMap.set(key,entry);sections.push(entry);}
  return sectionMap.get(key);
 }
 const initial={scope:pageKey+':page',path:'',section:section('page','Содержимое страницы',page),page};
 function walk(node,context,skip=false){
  if(node.type!=='element'&&node.type!=='root')return;
  const isExcluded=skip||EXCLUDED.has(node.tag)||systemIds.has(attr(node,'id'))||attr(node,'data-cms-ignore')!==undefined||attr(node,'data-document')!==undefined||attr(node,'data-extra-section')!==undefined||hasClass(node,'gallery-items')||(hasClass(node,'scan-stack')&&attr(node,'data-gallery')!==undefined);
  if(isExcluded)return;
  let ctx=context;
  if(node.tag==='header'||node.tag==='footer'){
   const id=node.tag;ctx={scope:'shared:'+id,path:'',section:section(id,node.tag==='header'?'Шапка и меню':'Подвал и контакты','shared'),page:'shared'};
  }else if(node.tag==='section'||node.tag==='template'){
   const id=attr(node,'id')||(['hero','page-heading'].find(name=>hasClass(node,name)))||'section-'+node.position;
   const title=node.tag==='template'?'Окно: '+(textOf(headingOf(node)||node)||id):textOf(headingOf(node)||node)||id;
   ctx={scope:pageKey+':'+slug(id),path:'',section:section(slug(id),title.slice(0,150),page),page};
  }
  const nodeId=ctx.scope+(ctx.path?':'+ctx.path:'');
  node.cmsId=nodeId;node.cmsContext=ctx;
  const common={page:ctx.page,section:ctx.section.id,sectionLabel:ctx.section.title,tag:node.tag};
  const label=textOf(node).slice(0,160)||attr(node,'aria-label')||attr(node,'alt')||node.tag;
  if(node.tag==='a'&&attr(node,'href')!==undefined){
   const original=attr(node,'href'),patch=patches[nodeId];
   if(patch?.href!==undefined){setAttr(node,'href',patch.href);if(/^https?:\/\//i.test(patch.href)||/\.pdf(?:[?#]|$)/i.test(patch.href)){setAttr(node,'target','_blank');setAttr(node,'rel','noopener noreferrer');}}
   setAttr(node,'data-cms-id',nodeId);
   items.push({...common,id:nodeId,kind:'link',value:attr(node,'href'),defaultValue:original,label});
  }else if(node.tag==='img'&&attr(node,'src')!==undefined){
   const original=attr(node,'src'),originalAlt=attr(node,'alt')||'',patch=patches[nodeId];
   if(patch?.src!==undefined)setAttr(node,'src',patch.src);
   if(patch?.alt!==undefined)setAttr(node,'alt',patch.alt);
   setAttr(node,'data-cms-id',nodeId);
   items.push({...common,id:nodeId,kind:'image',value:attr(node,'src'),defaultValue:original,alt:attr(node,'alt')||'',defaultAlt:originalAlt,label:originalAlt||nearest(node,n=>/^section$/.test(n.tag))?.cmsContext?.section.title||'Изображение'});
  }
  if(node.tag==='input'||node.tag==='textarea')for(const attribute of ['placeholder','aria-label']){
   const original=attr(node,attribute);if(original===undefined||!original)continue;
   const id=nodeId+':'+attribute,patch=patches[id];
   if(patch?.text!==undefined)setAttr(node,attribute,patch.text);
   setAttr(node,'data-cms-id',nodeId);
   items.push({...common,id,kind:'text',value:patch?.text??original,defaultValue:original,attr:attribute,label:(attribute==='placeholder'?'Подсказка в поле: ':'Название поля: ')+original});
  }
  if(node.tag==='table')tableNodes.push(node);
  let textIndex=0;const counters=new Map();
  for(const child of node.children||[]){
   if(child.type==='text'){
    textIndex++;
    const original=decodeHtmlEntities(child.raw),value=original.trim();
    if(!TEXT_TAGS.has(node.tag)||!value||!/[\p{L}\p{N}]/u.test(value))continue;
    const id=nodeId+':text:'+textIndex,patch=patches[id];
    child.cmsId=id;
    if(patch?.text!==undefined){const before=original.match(/^\s*/)?.[0]||'',after=original.match(/\s*$/)?.[0]||'';child.raw=escapeHtml(before+patch.text+after);}
    const cell=nearest(node,n=>n.tag==='th'||n.tag==='td');
    const item={...common,id,kind:'text',value:patch?.text??value,defaultValue:value,label:label||value};
    if(cell)item.table=true;
    items.push(item);
    // IDs are deliberately attached to the parent, not wrapped in spans:
    // inserting wrappers would alter existing CSS and native table semantics.
    const ids=(attr(node,'data-cms-text')||'').split(' ').filter(Boolean);if(!ids.includes(id))ids.push(id);setAttr(node,'data-cms-text',ids.join(' '));
   }else if(child.type==='element'){
    const count=(counters.get(child.tag)||0)+1;counters.set(child.tag,count);child.position=count;
    const childPath=(ctx.path?ctx.path+'/':'')+child.tag+count;
    walk(child,{...ctx,path:childPath});
   }
  }
 }
 walk(tree,initial);
 // Keep submitted answers aligned with their edited, visible labels.
 for(const label of descendants(tree,n=>n.tag==='label'&&hasClass(n,'radio-option'))){
  const radio=descendants(label,n=>n.tag==='input'&&attr(n,'type')==='radio')[0];
  const answer=label.children.find(n=>n.type==='element'&&n.tag==='span');
  if(radio&&answer&&descendants(label,n=>!!attr(n,'data-cms-text')).some(n=>(attr(n,'data-cms-text')||'').split(' ').some(id=>patches[id]?.text!==undefined)))setAttr(radio,'value',textOf(answer));
 }
 const itemMap=new Map(items.map(item=>[item.id,item]));
 for(const table of tableNodes){
  const rows=descendants(table,n=>n.tag==='tr'),caption=descendants(table,n=>n.tag==='caption')[0];
  const scope=nearest(table,n=>hasClass(n,'statistics-block'))||table.parent;
  const heading=headingOf(scope);
  tables.push({id:table.cmsId,page,section:table.cmsContext.section.id,title:textOf(heading||caption||table).slice(0,180),caption:caption?textOf(caption):'',captionId:caption?.children.find(n=>n.cmsId)?.cmsId,
   rows:rows.map((row,rowIndex)=>({cells:row.children.filter(n=>n.type==='element'&&(n.tag==='th'||n.tag==='td')).map((cell,column)=>{
    const textNodes=cell.children.filter(n=>n.type==='text'&&n.cmsId),id=textNodes[0]?.cmsId||descendants(cell,n=>!!attr(n,'data-cms-text'))[0]?.children.find(n=>n.cmsId)?.cmsId;
    const value=id?itemMap.get(id)?.value??textOf(cell):textOf(cell);
    return {id,value,header:cell.tag==='th',row:rowIndex,column};
   })}))});
 }
 return {html:serialize(tree),items,sections:sections.filter(s=>items.some(item=>item.section===s.id)),tables};
}

/** Deduplicate shared header/footer when combining page catalogs. */
export function mergeCatalogs(catalogs){
 const unique=(field)=>[...new Map(catalogs.flatMap(catalog=>catalog[field]||[]).map(item=>[item.id,item])).values()];
 return {items:unique('items'),sections:unique('sections'),tables:unique('tables')};
}
