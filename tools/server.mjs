import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createContentStore} from './admin-content.mjs';
import {createAdminApi} from './admin-api.mjs';
import {createMailApi} from './mail-api.mjs';
import {createSurveyStore,createSurveyApi} from './survey-api.mjs';
const projectRoot=fileURLToPath(new URL('../',import.meta.url));
const distRoot=path.join(projectRoot,'dist');
const port=Number(process.env.PORT||4174),host=process.env.HOST||'127.0.0.1';
const store=createContentStore({projectRoot,distRoot});
await store.build();
const surveyStore=createSurveyStore({projectRoot,getContent:store.getContent});
await surveyStore.purgeExpired();
setInterval(()=>surveyStore.purgeExpired().catch(()=>console.error('Не удалось очистить устаревшие анкеты.')),15*60*1000).unref();
const surveyApi=createSurveyApi({store:surveyStore});
const mailApi=createMailApi();
const admin=createAdminApi({projectRoot,distRoot,...store,preview:(page,content)=>store.preview({page,content}),getSurveyResponses:surveyStore.getResponses});
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml','.ttf':'font/ttf','.woff2':'font/woff2','.pdf':'application/pdf','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.rtf':'application/rtf','.txt':'text/plain; charset=utf-8'};
http.createServer(async(req,res)=>{
 try{
  const requestUrl=new URL(req.url,'http://localhost');
  if(await admin(req,res,requestUrl))return;
  if(await mailApi(req,res,requestUrl))return;
  if(await surveyApi(req,res,requestUrl))return;
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{'Allow':'GET, HEAD'});res.end();return;}
  if(requestUrl.pathname==='/admin'||requestUrl.pathname==='/admin/'){res.writeHead(302,{'Location':'/admin/login.html','Cache-Control':'no-store'});res.end();return;}
  const pathname=decodeURIComponent(requestUrl.pathname);
  if(pathname.includes('\\')||pathname.includes('\0'))throw Error('invalid path');
  const file=path.resolve(distRoot,'.'+(pathname.endsWith('/')?pathname+'index.html':pathname));
  if(!file.startsWith(distRoot+path.sep)){res.writeHead(403);res.end();return;}
  const info=await stat(file);if(!info.isFile())throw Error('not a file');
  const headers={'Content-Type':types[path.extname(file).toLowerCase()]||'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin'};
  if(pathname.startsWith('/admin/')){headers['Cache-Control']='no-store';headers['X-Robots-Tag']='noindex, nofollow';headers['Content-Security-Policy']="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: http: data:; font-src 'self' data:; frame-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";}
  res.writeHead(200,headers);res.end(req.method==='HEAD'?undefined:await readFile(file));
 }catch(error){console.error('Request failed:',error.code||error.message);res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});res.end('Страница не найдена');}
}).listen(port,host,()=>console.log(`Сайт: http://${host}:${port}\nАдминка: http://${host}:${port}/admin/login.html`));
