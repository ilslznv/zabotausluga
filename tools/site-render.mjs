import {header,footer,renderPage,routes,escape} from './pages.mjs';
import {versionDialog} from './reading.mjs';
import {decorateHtml,mergeCatalogs,decodeHtmlEntities} from './cms.mjs';

export function extraSections(data,file){
 return (data.extraSections?.[file]||[]).map(block=>`<section class="section extra-section" data-extra-section="${escape(block.id)}" id="extra-${escape(block.id)}"><div class="container"><h2>${escape(block.title)}</h2>${block.text.split(/\n\s*\n/).filter(Boolean).map(text=>`<p>${escape(text).replace(/\n/g,'<br>')}</p>`).join('')}${block.image?`<img class="extra-image" src="${escape(block.image)}" alt="${escape(block.alt||'')}" loading="lazy">`:''}${block.href?`<a class="button button-outline" href="${escape(block.href)}" ${/^https?:|\.pdf(?:[?#]|$)/i.test(block.href)?'target="_blank" rel="noopener noreferrer"':''}>${escape(block.linkLabel||'Открыть')}</a>`:''}</div></section>`).join('');
}

export function renderSitePage(data,file,overrides={}, {preview=false}={}){
 const title=routes.find(route=>route[0]===file)?.[1];
 if(!title)throw new Error('Страница не найдена.');
 const description=file==='index.html'?'Социальная помощь на дому людям пожилого возраста и людям с инвалидностью в Пикалево. Услуги, тарифы, документы и контакты.':`${title} — Заботливая услуга, Пикалево.`;
 const raw=`<!doctype html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">${preview?'<base href="/">':''}<meta name="description" content="${escape(description)}"><meta name="theme-color" content="#578631"><title>${escape(file==='index.html'?'Заботливая услуга — помощь на дому в Пикалево':title+' · Заботливая услуга')}</title><link rel="icon" href="assets/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="assets/site.css">${preview?'':'<script defer src="assets/reading.js"></script><script defer src="assets/site.js"></script>'}</head><body data-page="${file}" data-email="${escape(data.email)}">${header(data,file)}<main id="main" tabindex="-1">${renderPage(data,file)}${extraSections(data,file)}</main>${footer(data)}<div id="dialog-root"></div>${versionDialog()}</body></html>`;
 const decorated=decorateHtml(raw,file,overrides);
 // Keep the editable caption IDs stable while showing the note outside the scrollable table.
 if(file==='services.html')decorated.html=decorated.html.replace(/(<div\b[^>]*\bid="(?:recipients|volume)-panel"[^>]*>[\s\S]*?<\/table><\/div>)/g,block=>{
  const caption=block.match(/<caption\b[^>]*>([\s\S]*?)<\/caption>/)?.[1];
  return caption?`${block}<p class="statistics-note">${caption}</p>`:block;
 });
 if(file==='index.html'&&decorated.items.some(item=>item.kind==='text'&&item.id.startsWith('index:hero:')&&item.value.length>item.defaultValue.length*1.15))decorated.html=decorated.html.replace('<body ','<body class="cms-custom-hero" ');
 const documentTitles={};
 for(const match of raw.matchAll(/<a\b[^>]*data-document="([^"]+)"[^>]*>[\s\S]*?<strong>([\s\S]*?)<\/strong>/g))documentTitles[match[1]]??=decodeHtmlEntities(match[2].replace(/<[^>]+>/g,''));
 return {...decorated,documentTitles};
}

export function renderSite(data,overrides={}){
 const rendered=routes.map(([file])=>({file,...renderSitePage(data,file,overrides)}));
 const catalog={...mergeCatalogs(rendered),pages:routes.map(([file,title])=>({file,title})),documentTitles:Object.assign({},...rendered.map(r=>r.documentTitles)),galleryTitles:{press:'Публикации в прессе',thanks:'Благодарности',poem:'Стихи',awards:'Дипломы и награды'}};
 return {rendered,catalog};
}
