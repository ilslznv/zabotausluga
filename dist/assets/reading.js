(() => {
 'use strict';
 const key='zabota-web2-reading';
 const defaults={version:'normal',size:1,theme:'light',spacing:'normal',decoration:false,links:true};
 let settings={...defaults},chosen=false;
 try {
   const saved=JSON.parse(localStorage.getItem(key));
   if(saved && ['normal','accessible'].includes(saved.version)){
     settings={...defaults,...saved};chosen=true;
     if(![1,1.25,1.5,1.75,2].includes(settings.size))settings.size=1;
     if(!['light','dark','yellow'].includes(settings.theme))settings.theme='light';
     if(!['normal','wide','widest'].includes(settings.spacing))settings.spacing='normal';
   }
 } catch {}
 const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
 const panel=$('#reading-panel'),chooser=$('#version-dialog');
 const keepPosition=action=>{const x=window.scrollX,y=window.scrollY;action();window.scrollTo({left:x,top:y,behavior:'instant'});};
 let lastFocus=null;
 const save=()=>{try{localStorage.setItem(key,JSON.stringify(settings));}catch{}};
 const setPanel=open=>{
   panel.hidden=!open;
   $$('[data-accessibility]').forEach(b=>b.setAttribute('aria-expanded',String(open)));
 };
 function apply(){
   const active=settings.version==='accessible';
   const scale=active?settings.size:1;
   document.documentElement.style.setProperty('--font-scale',String(scale));
   document.body.classList.toggle('reading-mode',active);
   document.body.classList.toggle('reading-enlarged',active&&scale>1);
   document.body.classList.toggle('reading-large',active&&scale>=1.5);
   document.body.classList.toggle('hide-decoration',active&&!!settings.decoration);
   document.body.classList.toggle('underline-links',active&&!!settings.links);
   document.body.dataset.readingTheme=active?settings.theme:'normal';
   document.body.dataset.readingSpacing=active?settings.spacing:'normal';
   $('#reading-size').textContent=Math.round(scale*100)+'%';
   $('[data-size-down]').disabled=settings.size===1;
   $('[data-size-up]').disabled=settings.size===2;
   $('#reading-theme').value=settings.theme;$('#reading-spacing').value=settings.spacing;
   $('#reading-decoration').checked=!!settings.decoration;$('#reading-links').checked=!!settings.links;
   $$('[data-accessibility]').forEach(b=>{
     b.setAttribute('aria-label',active?'Настройки чтения':'Выбрать версию сайта');
     b.setAttribute('aria-controls',active?'reading-panel':'version-dialog');
     if(active)b.removeAttribute('aria-haspopup');else b.setAttribute('aria-haspopup','dialog');
     const label=b.querySelector('span');if(label)label.textContent=active?'Настройки чтения':'Версия для слабовидящих';
   });
   if(!active)setPanel(false);
 }
 function choose(version){
   settings.version=version;chosen=true;save();apply();
   chooser.close();
   if(version==='accessible'){setPanel(true);$('#reading-panel-title').focus({preventScroll:true});}
   else (lastFocus||$('[data-accessibility]'))?.focus({preventScroll:true});
 }
 function openChooser(){lastFocus=document.activeElement;chooser.showModal();document.body.classList.add('dialog-open');}
 chooser.addEventListener('cancel',event=>{event.preventDefault();choose('normal');});
 chooser.addEventListener('close',()=>document.body.classList.remove('dialog-open'));
 $$('[data-version]').forEach(b=>b.addEventListener('click',()=>choose(b.dataset.version)));
 $$('[data-accessibility]').forEach(b=>b.addEventListener('click',()=>{
   if(settings.version==='accessible')keepPosition(()=>{setPanel(panel.hidden);if(!panel.hidden)$('#reading-panel-title').focus({preventScroll:true});});
   else openChooser();
 }));
 $('[data-reading-close]').addEventListener('click',()=>keepPosition(()=>{setPanel(false);$('[data-accessibility]').focus({preventScroll:true});}));
 panel.addEventListener('keydown',event=>{if(event.key==='Escape')keepPosition(()=>{setPanel(false);$('[data-accessibility]').focus({preventScroll:true});});});
 $('[data-normal-version]').addEventListener('click',()=>{settings.version='normal';save();apply();$('[data-accessibility]').focus();});
 $('[data-size-down]').addEventListener('click',()=>{settings.size=Math.max(1,settings.size-.25);save();apply();});
 $('[data-size-up]').addEventListener('click',()=>{settings.size=Math.min(2,settings.size+.25);save();apply();});
 $('#reading-theme').addEventListener('change',e=>{settings.theme=e.target.value;save();apply();});
 $('#reading-spacing').addEventListener('change',e=>{settings.spacing=e.target.value;save();apply();});
 $('#reading-decoration').addEventListener('change',e=>{settings.decoration=e.target.checked;save();apply();});
 $('#reading-links').addEventListener('change',e=>{settings.links=e.target.checked;save();apply();});
 $('[data-reading-reset]').addEventListener('click',()=>{settings={...defaults,version:'accessible'};save();apply();});
 apply();
 // Keep anchors and focused controls clear of the header as it wraps or resizes.
 const observer=new ResizeObserver(entries=>{
   document.documentElement.style.setProperty('--header-offset',Math.ceil(entries[0].target.getBoundingClientRect().height)+16+'px');
 });
 observer.observe($('.site-header'));
 if(!chosen)openChooser();
})();
