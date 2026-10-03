(() => {
 'use strict';
 const $=(s,root=document)=>root.querySelector(s);
 const $$=(s,root=document)=>[...root.querySelectorAll(s)];
 const closeMenus=()=>{$$('.nav-trigger').forEach(b=>{b.setAttribute('aria-expanded','false');b.nextElementSibling.hidden=true;});};
 $$('.nav-trigger').forEach(button=>button.addEventListener('click',()=>{const open=button.getAttribute('aria-expanded')!=='true';closeMenus();button.setAttribute('aria-expanded',String(open));button.nextElementSibling.hidden=!open;}));
 document.addEventListener('click',event=>{if(!event.target.closest('.nav-dropdown'))closeMenus();});
 document.addEventListener('keydown',event=>{if(event.key==='Escape'){const open=$('.nav-trigger[aria-expanded=true]');closeMenus();open?.focus();}});
 $('.mobile-menu')?.addEventListener('click',event=>{const button=event.currentTarget;const open=button.getAttribute('aria-expanded')!=='true';button.setAttribute('aria-expanded',String(open));button.setAttribute('aria-label',open?'Закрыть меню':'Открыть меню');$('#site-nav').classList.toggle('is-open',open);});
 $('#site-nav')?.addEventListener('click',event=>{if(event.target.closest('a')){closeMenus();$('#site-nav').classList.remove('is-open');$('.mobile-menu').setAttribute('aria-expanded','false');$('.mobile-menu').setAttribute('aria-label','Открыть меню');}});
 const svg=name=>{const paths={close:'m6 6 12 12 M6 18 18 6',left:'m14 6-6 6 6 6',right:'m10 6 6 6-6 6',zoom:'M15 11a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M11 8v6 M8 11h6 M21 21l-5-5 M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0',download:'M12 3v12 m-5-5 5 5 5-5 M5 17v4h14v-4'};return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name]}"/></svg>`;};
 const dialog=document.createElement('dialog');
 dialog.className='dialog';dialog.setAttribute('aria-labelledby','dialog-title');
 $('#dialog-root').append(dialog);
 let opener=null;
 function openDialog(content,cls=''){
   opener=document.activeElement;
   dialog.onkeydown=null;
   dialog.className='dialog '+cls;
   dialog.innerHTML=`<button class="icon-button dialog-close" aria-label="Закрыть окно">${svg('close')}</button><div class="dialog-inner">${content}</div>`;
   $('.dialog-close',dialog).addEventListener('click',()=>dialog.close());
   document.body.classList.add('dialog-open');
   dialog.showModal();dialog.scrollTop=0;
 }
 dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});
 dialog.addEventListener('close',()=>{document.body.classList.remove('dialog-open');opener?.focus({preventScroll:true});});
 $$('[data-dialog]').forEach(b=>b.addEventListener('click',()=>{const template=$('#dialog-'+b.dataset.dialog);if(template)openDialog(template.innerHTML);}));
 // Preserve direct links to images when JavaScript is unavailable.
 $$('[data-gallery]').forEach(gallery=>{
   const cards=$$('[data-image-index]',gallery);
   const track=$('.gallery-items',gallery);
   const scroll=direction=>{const width=cards[0]?.getBoundingClientRect().width||300;track?.scrollBy({left:direction*(width+23),behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});};
   $('[data-gallery-prev]',gallery)?.addEventListener('click',()=>scroll(-1));
   $('[data-gallery-next]',gallery)?.addEventListener('click',()=>scroll(1));
   const updateScrollButtons=()=>{
     const prev=$('[data-gallery-prev]',gallery),next=$('[data-gallery-next]',gallery);
     if(prev)prev.disabled=!track||track.scrollLeft<2;
     if(next)next.disabled=!track||track.scrollLeft+track.clientWidth>=track.scrollWidth-2;
   };
   track?.addEventListener('scroll',updateScrollButtons,{passive:true});
   window.addEventListener('resize',updateScrollButtons);updateScrollButtons();
   cards.forEach((card,start)=>card.addEventListener('click',event=>{
     event.preventDefault();let current=start;
     const content=`<h2 id="dialog-title"></h2><div class="lightbox-image-wrap"><img class="lightbox-image" alt=""></div><div class="lightbox-controls"><button class="icon-button" data-image-prev aria-label="Предыдущее изображение">${svg('left')}</button><span class="lightbox-counter" aria-live="polite"></span><button class="icon-button" data-image-next aria-label="Следующее изображение">${svg('right')}</button><button class="button button-outline lightbox-zoom" data-image-zoom aria-pressed="false">${svg('zoom')}Увеличить</button><a class="button button-outline lightbox-download" download>${svg('download')}Скачать</a></div>`;
     openDialog(content,'lightbox');
     const render=()=>{
       const item=cards[current];const caption=item.dataset.caption||'Изображение';
       $('#dialog-title',dialog).textContent=caption;
       $('.lightbox-image',dialog).src=item.href;$('.lightbox-image',dialog).alt=caption;
       $('.lightbox-counter',dialog).textContent=`${current+1} / ${cards.length}`;
       $('.lightbox-download',dialog).href=item.href;
       $('.lightbox-download',dialog).download=item.getAttribute('download')||item.getAttribute('href').split('/').pop();
       $('[data-image-prev]',dialog).disabled=cards.length<2;$('[data-image-next]',dialog).disabled=cards.length<2;
       dialog.classList.remove('is-zoomed');$('[data-image-zoom]',dialog).setAttribute('aria-pressed','false');
     };
     const previous=()=>{current=(current-1+cards.length)%cards.length;render();};
     const next=()=>{current=(current+1)%cards.length;render();};
     $('[data-image-prev]',dialog).addEventListener('click',previous);
     $('[data-image-next]',dialog).addEventListener('click',next);
     $('[data-image-zoom]',dialog).addEventListener('click',e=>{const zoomed=dialog.classList.toggle('is-zoomed');e.currentTarget.setAttribute('aria-pressed',String(zoomed));});
     dialog.onkeydown=e=>{if(e.key==='ArrowLeft'){e.preventDefault();previous();}else if(e.key==='ArrowRight'){e.preventDefault();next();}};
     render();
   }));
 });

 function formStatus(form,message,type=''){
   const node=$('[data-form-status]',form);
   node.textContent=message;node.hidden=!message;node.className='form-status'+(type?' is-'+type:'');
   return node;
 }
 function lockForm(form,additional=[]){
   form.setAttribute('aria-busy','true');
   const controls=[...$$('input,textarea,select,button',form),...additional];
   const disabled=controls.map(control=>control.disabled);
   controls.forEach(control=>{control.disabled=true;});
   return ()=>{controls.forEach((control,i)=>{control.disabled=disabled[i];});form.removeAttribute('aria-busy');};
 }
 async function sendForm(path,payload){
   if(location.protocol==='file:')throw new Error('Для отправки нужен запущенный сайт. Обратитесь к нам по указанному телефону.');
   let response;
   try{response=await fetch(path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});}
   catch{throw new Error('Не удалось связаться с сайтом. Проверьте соединение и повторите попытку.');}
   let result;
   try{result=await response.json();}catch{throw new Error('Не удалось получить подтверждение. Попробуйте позже.');}
   if(!response.ok){const error=new Error(result.error||result.message||'Не удалось отправить. Попробуйте позже.');error.status=response.status;throw error;}
   return result;
 }
 const feedback=$('#feedback-form');
 function phoneParts(raw,caret=String(raw).length){
   raw=String(raw);const digits=raw.replace(/\D/g,'');
   let prefix=/^\s*\+\s*[78]/.test(raw)?1:(digits.length>10&&/^[78]/.test(digits)?1:0);
   let national=digits.slice(prefix);
   if(prefix&&national.length>10&&/^[78]/.test(national)){national=national.slice(1);prefix++;}
   national=national.slice(0,10);
   let formatted='';
   if(national){
     formatted='+7 ('+national.slice(0,3);
     if(national.length>=3)formatted+=')';
     if(national.length>3)formatted+=' '+national.slice(3,6);
     if(national.length>6)formatted+='-'+national.slice(6,8);
     if(national.length>8)formatted+='-'+national.slice(8,10);
   }
   const before=Math.max(0,Math.min(national.length,raw.slice(0,caret).replace(/\D/g,'').length-prefix));
   let position=formatted?4:0;
   if(before){let seen=0;for(let i=2;i<formatted.length;i++)if(/\d/.test(formatted[i])&&++seen===before){position=i+1;break;}}
   return {national,formatted,position};
 }
 const feedbackPhone=$('#feedback-phone');
 function maskPhone(raw=feedbackPhone.value,caret=feedbackPhone.selectionStart??String(raw).length){
   const parts=phoneParts(raw,caret);feedbackPhone.value=parts.formatted;
   feedbackPhone.setSelectionRange(parts.position,parts.position);return parts;
 }
 function validatePhone(){
   const {national}=phoneParts(feedbackPhone.value),valid=!national||national.length===10;
   feedbackPhone.setCustomValidity(valid?'':'Введите полный номер телефона: +7 (921) 869-24-58.');
   feedbackPhone.setAttribute('aria-invalid',String(!valid));return valid;
 }
 if(feedbackPhone){
   feedbackPhone.addEventListener('input',()=>{maskPhone();feedbackPhone.setCustomValidity('');feedbackPhone.removeAttribute('aria-invalid');});
   feedbackPhone.addEventListener('blur',()=>{maskPhone();validatePhone();});
   feedbackPhone.addEventListener('invalid',validatePhone);
   feedbackPhone.addEventListener('beforeinput',event=>{
     if(event.isComposing||!event.cancelable)return;
     const start=feedbackPhone.selectionStart??0,end=feedbackPhone.selectionEnd??start;
     if(event.inputType==='insertText'&&event.data&&/[^\d]/.test(event.data)){event.preventDefault();return;}
     if(start!==end)return;
     if(event.inputType==='insertText'&&phoneParts(feedbackPhone.value).national.length===10&&!/^[78]/.test(phoneParts(feedbackPhone.value).national)){event.preventDefault();return;}
     if(!['deleteContentBackward','deleteContentForward'].includes(event.inputType))return;
     event.preventDefault();const value=feedbackPhone.value;
     const positions=[...value].map((char,index)=>index>=4&&/\d/.test(char)?index:-1).filter(index=>index>=0);
     const index=event.inputType==='deleteContentBackward'?positions.filter(index=>index<start).pop():positions.find(index=>index>=start);
     if(index===undefined)return;
     maskPhone(value.slice(0,index)+value.slice(index+1),index);
     feedbackPhone.dispatchEvent(new Event('input',{bubbles:true}));
   });
 }
 let feedbackPending=false;
 feedback?.addEventListener('submit',async event=>{
   event.preventDefault();
   if(feedbackPending)return;
   const name=$('#feedback-name').value.trim();const message=$('#feedback-message').value.trim();
   $('#feedback-name').setCustomValidity(name?'':'Укажите ваше имя.');
   $('#feedback-message').setCustomValidity(message?'':'Напишите сообщение.');
   const phone=maskPhone();validatePhone();
   if(!feedback.reportValidity())return;
   const payload={name,phone:phone.national?'+7'+phone.national:'',message,consent:$('[name=consent]',feedback).checked,website:$('[name=website]',feedback).value};
   feedbackPending=true;const unlock=lockForm(feedback);formStatus(feedback,'Отправляем сообщение…');
   try{
     const result=await sendForm('/api/contact',payload);
     if(result.sent!==true)throw new Error('Не удалось подтвердить отправку. Попробуйте позже.');
     feedback.reset();formStatus(feedback,'Сообщение отправлено.','success');
   }catch(error){
     const message=formStatus(feedback,error.message,'error');
     if(error.status===503){const phone=$('.feedback-phone'),link=document.createElement('a');if(phone){link.href=phone.href;link.textContent='Позвонить: '+phone.textContent;link.className='form-status-phone';message.append(document.createElement('br'),link);}}
   }
   finally{feedbackPending=false;unlock();}
 });
 feedback?.addEventListener('input',event=>{event.target.setCustomValidity?.('');});

 const form=$('#survey-form');
 let surveyComplete=false;
 function completeSurvey(message){
   if(!form)return;
   surveyComplete=true;form.hidden=true;$('.survey-view').hidden=true;
   const complete=$('#survey-complete');complete.textContent=message;complete.hidden=false;
 }
 if(form){
   form.noValidate=true;
   const fields=$$('.survey-step',form);let step=0,mode='steps',pending=false;
   const error=$('.survey-error',form),back=$('[data-survey-back]',form),next=$('[data-survey-next]',form),submit=$('[data-survey-submit]',form);
   function renderSurvey(){
     form.dataset.mode=mode;
     fields.forEach((f,i)=>{f.hidden=mode==='steps'&&i!==step;});
     $('.survey-progress',form).hidden=mode==='all';
     back.hidden=mode==='all'||step===0;next.hidden=mode==='all'||step===5;submit.hidden=mode==='steps'&&step!==5;
     $('.survey-send-note',form).hidden=mode==='steps'&&step!==5;
     $('[data-survey-consent]',form).hidden=mode==='steps'&&step!==5;
     $('#survey-counter').textContent=`Вопрос ${step+1} из ${fields.length}`;
     const progress=$('[role=progressbar]',form);progress.setAttribute('aria-valuenow',String(step+1));$('span',progress).style.width=((step+1)/fields.length*100)+'%';
     $$('[data-survey-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.surveyMode===mode)));
     error.hidden=true;
   }
   function validate(index){
     const f=fields[index],valid=index===5||!!$('input:checked',f);
     error.textContent='Выберите вариант ответа, чтобы продолжить.';
     f.setAttribute('aria-invalid',String(!valid));error.hidden=valid;return valid;
   }
   function focusQuestion(){const legend=$('legend',fields[step]);legend.tabIndex=-1;legend.focus({preventScroll:true});form.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});}
   next.addEventListener('click',()=>{if(!validate(step)){$('input',fields[step])?.focus({preventScroll:true});return;}step++;renderSurvey();focusQuestion();});
   back.addEventListener('click',()=>{step=Math.max(0,step-1);renderSurvey();focusQuestion();});
   $$('[data-survey-mode]').forEach(b=>b.addEventListener('click',()=>{mode=b.dataset.surveyMode;renderSurvey();}));
   form.addEventListener('change',event=>{event.target.closest('fieldset')?.setAttribute('aria-invalid','false');error.hidden=true;});
   form.addEventListener('submit',async event=>{
     event.preventDefault();
     if(pending||surveyComplete)return;
     const missing=fields.findIndex((f,i)=>i<5&&!$('input:checked',f));
     if(missing!==-1){step=missing;renderSurvey();validate(step);$('input',fields[step]).focus();return;}
     const consent=$('[name=consent]',form);
     if(!consent.checked){error.textContent='Подтвердите согласие на обработку персональных данных.';error.hidden=false;consent.focus();return;}
     const answers=fields.map((f,i)=>{
       const title=$('legend>span:last-child',f).childNodes[0].textContent.trim();
       const answer=i===5?$('textarea',f).value.trim():$('input:checked',f).value;
       return {question:title,answer};
     });
     const payload={answers,consent:true,website:$('[name=website]',form).value};
     pending=true;const unlock=lockForm(form,$$('[data-survey-mode]'));error.hidden=true;formStatus(form,'Отправляем ответы…');
     try{
       const result=await sendForm('/api/survey',payload);
       if(result.saved!==true)throw new Error('Не удалось подтвердить сохранение ответов. Попробуйте позже.');
       completeSurvey('Ответы сохранены. Спасибо за участие.');
       loadSurveyResults();
     }catch(error){formStatus(form,error.message,'error');}
     finally{pending=false;unlock();}
   });
   renderSurvey();
 }
 const resultsRoot=$('#survey-results');
 let resultsRequest=0;
 const make=(tag,text,className='')=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
 async function loadSurveyResults(){
   if(!resultsRoot)return;
   const request=++resultsRequest,status=$('[data-results-status]',resultsRoot),summary=$('[data-results-summary]',resultsRoot),questions=$('[data-results-questions]',resultsRoot),retry=$('[data-results-retry]',resultsRoot);
   status.hidden=false;status.textContent='Загрузка результатов…';status.className='form-status';retry.hidden=true;
   try{
     if(location.protocol==='file:')throw new Error('Результаты доступны на запущенном сайте.');
     const response=await fetch('/api/survey/results',{credentials:'same-origin',headers:{Accept:'application/json'},cache:'no-store'});
     if(!response.ok)throw new Error('Не удалось загрузить результаты. Попробуйте позже.');
     const result=await response.json();
     if(request!==resultsRequest)return;
     if(!Number.isInteger(result.total)||result.total<0||!Array.isArray(result.questions))throw new Error('Результаты пока недоступны.');
     if(result.alreadyAnswered===true&&!surveyComplete)completeSurvey('Вы уже отправили ответы. Повторно пройти опрос можно через 24 часа.');
     const rendered=[];
     // Only aggregate choices from the five closed questions are public.
     // Wishes from the sixth question are never rendered here.
     for(const [index,question] of result.questions.slice(0,5).entries()){
       if(typeof question.question!=='string'||!Array.isArray(question.answers))throw new Error('Результаты пока недоступны.');
       const article=make('article',undefined,'survey-result-question');
       const heading=make('h3',`${index+1}. ${question.question}`);heading.id=`survey-result-question-${index+1}`;
       const table=make('table',undefined,'data-table survey-result-table');table.setAttribute('aria-labelledby',heading.id);
       const thead=make('thead'),header=make('tr');
       for(const label of ['Ответ','Количество','Доля']){const cell=make('th',label);cell.scope='col';header.append(cell);}
       thead.append(header);table.append(thead);
       const tbody=make('tbody');
       for(const answer of question.answers){
         if(typeof answer.label!=='string'||!Number.isInteger(answer.count)||answer.count<0||!Number.isFinite(answer.percent)||answer.percent<0||answer.percent>100)throw new Error('Результаты пока недоступны.');
         const row=make('tr'),label=make('th',answer.label);label.scope='row';
         const count=make('td',String(answer.count)),share=make('td',undefined,'survey-result-share');
         share.append(make('span',`${answer.percent.toLocaleString('ru-RU',{maximumFractionDigits:1})}%`));
         const meter=make('meter');meter.min=0;meter.max=100;meter.value=answer.percent;meter.setAttribute('aria-hidden','true');
         share.append(meter);row.append(label,count,share);tbody.append(row);
       }
       table.append(tbody);const wrap=make('div',undefined,'table-wrap');wrap.append(table);article.append(heading,wrap);rendered.push(article);
     }
     $('[data-results-total]',resultsRoot).textContent=String(result.total);summary.hidden=false;
     const updated=$('[data-results-updated]',resultsRoot);updated.hidden=true;
     if(result.updatedAt){const date=new Date(result.updatedAt);if(Number.isFinite(date.valueOf())){updated.textContent=' · Обновлено '+date.toLocaleString('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit'});updated.hidden=false;}}
     questions.replaceChildren(...(result.total?rendered:[]));
     status.textContent=result.total?'':'Пока нет ответов.';status.hidden=!!result.total;retry.hidden=false;
   }catch(error){
     if(request!==resultsRequest)return;
     summary.hidden=true;questions.replaceChildren();status.textContent=error.message;status.className='form-status is-error';status.hidden=false;retry.hidden=false;
   }
 }
 $('[data-results-retry]',resultsRoot||document)?.addEventListener('click',loadSurveyResults);
 if(resultsRoot)loadSurveyResults();
})();
