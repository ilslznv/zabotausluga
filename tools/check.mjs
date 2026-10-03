import {readFile,readdir,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {routes} from './pages.mjs';
const root=path.resolve(fileURLToPath(new URL('../dist/',import.meta.url)));
const workspace=path.resolve(root,'../..');
const files=(await readdir(root)).filter(f=>f.endsWith('.html'));
const contents=new Map(await Promise.all(files.map(async f=>[f,await readFile(path.join(root,f),'utf8')])));
const failures=[];
let refs=0;
for(const [file,html] of contents){
 if((html.match(/<h1[ >]/g)||[]).length!==1)failures.push(`${file}: expected one main heading`);
 if(!html.includes('<html lang="ru">'))failures.push(`${file}: missing language`);
 if(/tilda|t390|t-align|#popup:/.test(html))failures.push(`${file}: editor dependency`);
 for(const match of html.matchAll(/(?:href|src)="([^"]+)"/g)){
   let ref=match[1].replaceAll('&amp;','&');
   if(/^(https?:|mailto:|tel:|data:)/.test(ref))continue;
   refs++;
   const [pathname,hash]=ref.split('#');
   const target=pathname||file;
   const full=path.resolve(root,decodeURIComponent(target));
   try{await stat(full);}catch{failures.push(`${file}: missing ${ref}`);continue;}
   if(hash&&target.endsWith('.html')){
     const targetHtml=contents.get(target)||await readFile(full,'utf8');
     if(!targetHtml.includes(`id="${hash}"`))failures.push(`${file}: missing anchor ${ref}`);
   }
 }
 const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
 // Template headings are inert and receive the same accessible dialog ID when opened.
 const duplicates=ids.filter((id,i)=>ids.indexOf(id)!==i&&id!=='dialog-title');
 if(duplicates.length)failures.push(`${file}: duplicate IDs ${duplicates}`);
}
const data=JSON.parse(await readFile(path.resolve(root,'../content.json'),'utf8'));
for(const [key,doc] of Object.entries(data.documents)){
 const original=await readFile(path.join(workspace,doc.source));
 const copied=await readFile(path.join(root,doc.src));
 const hash=b=>createHash('sha256').update(b).digest('hex');
 if(hash(original)!==hash(copied))failures.push(`Document ${key}: copy differs from source`);
}
const css=await readFile(path.join(root,'assets/site.css'),'utf8');
for(const ref of css.matchAll(/url\(['"]?([^'")]+)['"]?\)/g)){
 try{await stat(path.resolve(root,'assets',ref[1]));}catch{failures.push(`CSS: missing asset ${ref[1]}`);}
}
if(files.length!==routes.length)failures.push(`Expected ${routes.length} pages, found ${files.length}`);
if(failures.length){console.error(failures.join('\n'));process.exitCode=1;}
else console.log(`PASS: ${routes.length} pages, ${refs} local references, all section anchors, ${Object.keys(data.documents).length} byte-identical documents, local Onest font.`);
