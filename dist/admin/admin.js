(() => {
  'use strict';
  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
  const imageTypes = 'image/jpeg,image/png,image/webp,image/gif';
  const documentTypes = '.pdf,.docx,.txt,.rtf';
  const titles = {content:'Тексты и ссылки',tables:'Таблицы',documents:'Документы',images:'Изображения',galleries:'Галереи',blocks:'Дополнительные блоки',settings:'Настройки',surveys:'Ответы на опрос',versions:'История изменений'};
  let surveyPage=1;
  const imageNames = {logo:'Логотип',hero:'Цветы на первом экране',care:'Изображение «О нас»',registration:'Уведомление о регистрации',registry1:'ЕГРИП — первая страница',registry2:'ЕГРИП — вторая страница',cszn:'Центр социальной защиты',gosu:'Госуслуги',komitet:'Комитет по социальной защите',mintrud:'Министерство труда',socdef:'Социальная защита',qr:'QR-код оценки качества'};
  const linkNames = {research:'Опрос',researchSurvey:'Исследовательский опрос',survey:'Опрос',rental:'Пункты проката',rentals:'Пункты проката',rates2026:'Тарифы на 2026 год',decree2026:'Постановление на 2026 год',quality:'Оценка качества'};
  let csrf = '', state = null, dialogReturnFocus = null, activeUploads = 0, saving = false;

  function element(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null) continue;
      if (key === 'text') node.textContent = value;
      else if (key === 'class') node.className = value;
      else if (key === 'on') for (const [event, handler] of Object.entries(value)) node.addEventListener(event, handler);
      else if (key in node && !key.startsWith('aria-') && key !== 'form') node[key] = value;
      else node.setAttribute(key, value);
    }
    for (const child of [children].flat()) if (child != null) node.append(typeof child === 'string' ? document.createTextNode(child) : child);
    return node;
  }
  function status(message, type = '') {
    const target = $('#editor-status') || $('#login-status');
    target.textContent = message;
    target.className = `status ${type}`;
  }
  function assetURL(src) {
    if (!src) return '';
    if (/^https?:\/\//i.test(src) || src.startsWith('/')) return src;
    return `/${src.replace(/^\.\//, '')}`;
  }
  function sizeLabel(size) { return size >= 1024*1024 ? `${(size/1024/1024).toFixed(1).replace('.', ',')} МБ` : `${Math.max(1, Math.round((size || 0)/1024))} КБ`; }
  async function api(path, options = {}) {
    const headers = {...options.headers};
    if (options.body && !(options.body instanceof File) && !(options.body instanceof Blob)) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }
    if (options.method && options.method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;
    const response = await fetch(`/api/admin${path}`, {credentials:'same-origin',...options,headers});
    const type = response.headers.get('content-type') || '';
    const result = type.includes('application/json') ? await response.json() : await response.text();
    if (!response.ok) {
      if (response.status === 401 && document.body.dataset.adminScreen === 'editor') {
        state && (state.dirty = false);
        location.replace('/admin/login.html');
      }
      throw new Error(typeof result === 'object' ? result.error || result.message || `Ошибка ${response.status}` : result || `Ошибка ${response.status}`);
    }
    return result;
  }
  function markDirty() {
    if (!state) return;
    state.dirty = true;
    $('#save-state').textContent = 'Есть несохранённые изменения';
    $('#save-state').classList.add('dirty');
    $('#save-button').disabled = !!activeUploads || saving;
    if ($('#editor-status').classList.contains('success')) status('');
  }
  function markSaved() {
    state.dirty = false;
    $('#save-state').textContent = 'Все изменения сохранены';
    $('#save-state').classList.remove('dirty');
    $('#save-button').disabled = true;
  }
  function getOverride(id) { return state.content.overrides[id] || {}; }
  function clearOverridesMatching(test, properties) {
    for (const item of state.content.catalog.items || []) {
      if (!test(item)) continue;
      const patch=state.content.overrides[item.id];
      if(!patch)continue;
      for(const property of properties)delete patch[property];
      if(!Object.keys(patch).length)delete state.content.overrides[item.id];
    }
  }
  function replaceGlobalImage(key,src) {
    const oldSources=new Set([state.content.data.images[key],state.originalData.images[key]]);
    clearOverridesMatching(item=>(item.kind==='image'||item.kind==='link')&&oldSources.has(item.defaultValue),['src','href']);
    state.content.data.images[key]=src;markDirty();
  }
  function changeContact(key,value) {
    const originals=new Set([state.content.data[key],state.originalData[key]]);
    if(key==='phone')for(const phone of [...originals])originals.add('tel:'+String(phone).replace(/[^\d+]/g,''));
    if(key==='email')for(const email of [...originals])originals.add('mailto:'+email);
    clearOverridesMatching(item=>['text','link'].includes(item.kind)&&originals.has(item.defaultValue),['text','href']);
    state.content.data[key]=value;markDirty();
  }
  function changeGlobalLink(key,value) {
    const originals=new Set([state.content.data.links[key],state.originalData.links[key]]);
    clearOverridesMatching(item=>item.kind==='link'&&originals.has(item.defaultValue),['href']);
    state.content.data.links[key]=value;markDirty();
  }
  function valueFor(item, property) { return getOverride(item.id)[property] ?? (property === 'alt' ? item.defaultAlt ?? item.alt ?? '' : item.defaultValue ?? item.value ?? ''); }
  function setOverride(id, property, value) {
    state.content.overrides[id] = {...getOverride(id),[property]:value};
    markDirty();
  }
  function resetOverride(id, property) {
    const override = {...getOverride(id)};
    delete override[property];
    if (Object.keys(override).length) state.content.overrides[id] = override;
    else delete state.content.overrides[id];
    markDirty(); render();
  }
  function pageItems() { return (state.content.catalog.items || []).filter(item => item.page === state.page || item.page === 'shared'); }
  function makeInput(label, value, callback, options = {}) {
    const input = element(options.multiline ? 'textarea' : 'input', {value:value ?? '',...(!options.multiline?{type:options.type || 'text'}:{}),...(options.min != null ? {min:options.min} : {}),...(options.max != null ? {max:options.max} : {}),on:{input:event=>callback(event.target.value)}});
    const wrapper = element('label',{},[label,input]);
    return {wrapper,input};
  }
  function field(item, property, label, options = {}) {
    const inputId = `editor-${item.id}-${property}`;
    const {input} = makeInput(label,valueFor(item,property),value=>setOverride(item.id,property,value),options);
    input.id = inputId;
    const head = element('div',{class:'field-head'},[
      element('label',{htmlFor:inputId},[label,element('span',{class:'field-kind',text:options.note || (item.tag ? `<${item.tag}>` : '')})]),
      element('button',{type:'button',class:'reset-field',text:'Исходное',title:'Вернуть исходное значение',on:{click:()=>resetOverride(item.id,property)}})
    ]);
    return element('div',{class:'field'},[head,input]);
  }
  function uploadButton(label, accept, callback, multiple = false) {
    const fileInput = element('input',{type:'file',accept,multiple,ariaLabel:label});
    const button = element('label',{class:'upload-button'},[label,fileInput]);
    const output = element('p',{class:'upload-status',role:'status','aria-live':'polite'});
    fileInput.addEventListener('change',async()=>{
      const files = [...fileInput.files];
      if (!files.length) return;
      button.classList.add('busy'); fileInput.disabled = true; output.className = 'upload-status';activeUploads++;
      $('#save-button').disabled=true;$('#preview-button').disabled=true;
      try {
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          if (file.size > 25*1024*1024) throw new Error(`Файл «${file.name}» больше 25 МБ.`);
          output.textContent = files.length > 1 ? `Загружаем ${i + 1} из ${files.length}…` : 'Загружаем файл…';
          const extension=file.name.split('.').pop().toLowerCase();
          const uploadMime={pdf:'application/pdf',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',rtf:'application/rtf',txt:'text/plain',jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',gif:'image/gif'};
          const result = await api('/upload',{method:'POST',body:file,headers:{'Content-Type':uploadMime[extension] || file.type || 'application/octet-stream','X-File-Name':encodeURIComponent(file.name)}});
          callback(result,file);
        }
        output.textContent = 'Файл загружен. Сохраните изменения на сайте.';
      } catch (error) { output.classList.add('error'); output.textContent = error.message; }
      finally { button.classList.remove('busy');fileInput.disabled = false;fileInput.value = '';activeUploads--;$('#save-button').disabled=!state.dirty||!!activeUploads||saving;$('#preview-button').disabled=!!activeUploads||saving; }
    });
    return element('div',{class:'asset-actions'},[button,output]);
  }
  function section(title, children, actions) {
    return element('section',{class:'editor-section'},[
      element('div',{class:'section-heading'},[element('h2',{text:title}),actions]),...children
    ]);
  }
  function empty(text) { return element('p',{class:'empty-state',text}); }
  function renderContent() {
    const query = state.search.toLocaleLowerCase('ru');
    const items = pageItems().filter(item => !item.table && ['text','link','image'].includes(item.kind) && (!query || [item.label,item.sectionLabel,item.value,valueFor(item,item.kind === 'text' ? 'text' : item.kind === 'link' ? 'href' : 'src')].join(' ').toLocaleLowerCase('ru').includes(query)));
    if (!items.length) return [empty('Ничего не найдено. Выберите другую страницу или измените запрос.')];
    const groups = new Map();
    for (const item of items) {
      const group = item.page === 'shared' ? 'Общие элементы сайта' : item.sectionLabel || item.section || 'Страница';
      if (!groups.has(group)) groups.set(group,[]);
      if (item.kind === 'text') {
        const value = valueFor(item,'text');
        groups.get(group).push(field(item,'text',item.label || value.slice(0,80) || 'Текст',{multiline:value.length > 100 || value.includes('\n') || ['p','li','blockquote','figcaption'].includes(item.tag),note:'Текст на сайте'}));
      } else if (item.kind === 'link') {
        groups.get(group).push(field(item,'href',item.label || 'Ссылка',{note:'Адрес страницы, https://, mailto: или tel:'}));
      } else {
        const img = element('img',{class:'asset-preview',src:assetURL(valueFor(item,'src')),alt:item.alt || ''});
        groups.get(group).push(element('div',{class:'field'},[
          element('h3',{text:item.label || 'Изображение'}),img,
          field(item,'alt','Описание изображения',{note:'Для экранного диктора; у декоративного изображения можно оставить пустым'}),
          uploadButton('Заменить изображение',imageTypes,result=>{setOverride(item.id,'src',result.src);img.src=assetURL(result.src);})
        ]));
      }
    }
    return [...groups].map(([title,fields])=>section(title,fields));
  }
  function renderTables() {
    const tables = (state.content.catalog.tables || []).filter(table=>table.page===state.page || table.page==='shared');
    if (!tables.length) return [empty('На выбранной странице нет таблиц.')];
    return tables.map(table=>{
      const node = element('table',{class:'editable-table'});
      if (table.caption) node.append(element('caption',{text:table.caption}));
      const tbody = element('tbody');
      for (const [ri,row] of table.rows.entries()) {
        const tr = element('tr');
        for (const [ci,cell] of row.cells.entries()) {
          const value = getOverride(cell.id).text ?? cell.value;
          const multiline=String(value).length>36;
          const input = element(multiline ? 'textarea' : 'input',{...(!multiline?{type:'text'}:{}),value,disabled:!cell.id,ariaLabel:`${table.title || 'Таблица'}, строка ${ri+1}, столбец ${ci+1}`,on:{input:event=>cell.id&&setOverride(cell.id,'text',event.target.value)}});
          tr.append(element(cell.header?'th':'td',cell.header?{scope:ri===0?'col':'row'}:{},[input]));
        }
        tbody.append(tr);
      }
      node.append(tbody);
      const fields = [];
      if (table.captionId) fields.push(field({id:table.captionId,value:table.caption || '',tag:'caption'},'text','Подпись таблицы',{multiline:true,note:'Период или пояснение'}));
      fields.push(element('div',{class:'table-scroll'},[node]));
      return section(table.title || 'Таблица',fields);
    });
  }
  function renderDocuments() {
    const cards = Object.entries(state.content.data.documents || {}).map(([key,doc])=>{
      const fallback = state.content.catalog.documentTitles?.[key] || key;
      const title = makeInput('Название документа',doc.title || fallback,value=>{doc.title=value;markDirty();});
      const description = makeInput('Описание',doc.description || '',value=>{doc.description=value;markDirty();},{multiline:true});
      const info = element('p',{class:'path',text:`${doc.format || 'Файл'} · ${sizeLabel(doc.size)}`});
      const link = element('a',{class:'button small',text:'Открыть файл ↗',href:assetURL(doc.src),target:'_blank',rel:'noopener'});
      const upload = uploadButton('Заменить файл',documentTypes,result=>{Object.assign(doc,{src:result.src,size:result.size,format:result.format});info.textContent=`${doc.format} · ${sizeLabel(doc.size)}`;link.href=assetURL(doc.src);markDirty();});
      return element('section',{class:'asset-card'},[
        element('h2',{text:doc.title || fallback}),element('div',{class:'field'},[title.wrapper]),element('div',{class:'field'},[description.wrapper]),info,link,upload
      ]);
    });
    return [element('p',{class:'settings-help',text:'Документ заменится во всех местах сайта, где он используется. Новые документы можно добавить ссылкой в дополнительных блоках.'}),element('div',{class:'asset-grid'},cards)];
  }
  function renderImages() {
    const cards = Object.entries(state.content.data.images || {}).map(([key,src])=>{
      const preview = element('img',{class:'asset-preview',src:assetURL(src),alt:imageNames[key] || key});
      const path = element('p',{class:'path',text:src});
      return element('section',{class:'asset-card'},[
        element('h2',{text:imageNames[key] || key}),preview,path,
        uploadButton('Заменить изображение',imageTypes,result=>{replaceGlobalImage(key,result.src);preview.src=assetURL(result.src);path.textContent=result.src;})
      ]);
    });
    return [element('p',{class:'settings-help',text:'Загружайте JPEG, PNG, WebP или GIF до 25 МБ. Описание отдельных изображений можно изменить в разделе «Тексты и ссылки».'}),element('div',{class:'asset-grid'},cards)];
  }
  function renderGalleries() {
    return Object.entries(state.content.data.galleries || {}).map(([key,items])=>{
      const list = element('div',{class:'gallery-list'});
      const rebuild = ()=>{
        list.replaceChildren();
        for (const [index,item] of items.entries()) {
          const image = element('img',{src:assetURL(item.thumb || item.src),alt:item.alt || item.caption || ''});
          const caption = makeInput('Подпись',item.caption || '',value=>{item.caption=value;markDirty();},{multiline:true});
          const alt = makeInput('Описание изображения',item.alt || '',value=>{item.alt=value;image.alt=value;markDirty();});
          const controls = element('div',{class:'gallery-order'},[
            element('button',{class:'button small',text:'← Раньше',disabled:index===0,on:{click:()=>{[items[index-1],items[index]]=[items[index],items[index-1]];markDirty();rebuild();}}}),
            element('button',{class:'button small',text:'Позже →',disabled:index===items.length-1,on:{click:()=>{[items[index+1],items[index]]=[items[index],items[index+1]];markDirty();rebuild();}}}),
            element('button',{class:'button small danger',text:'Удалить',on:{click:()=>{items.splice(index,1);markDirty();rebuild();}}})
          ]);
          list.append(element('article',{class:'gallery-item'},[
            image,caption.wrapper,alt.wrapper,
            uploadButton('Заменить',imageTypes,result=>{item.src=result.src;delete item.thumb;image.src=assetURL(result.src);markDirty();}),controls
          ]));
        }
        if (!items.length) list.append(empty('В галерее пока нет изображений.'));
      };
      rebuild();
      return section(state.content.catalog.galleryTitles?.[key] || key,[
        uploadButton('Добавить изображения',imageTypes,result=>{items.push({src:result.src,caption:'',alt:''});markDirty();rebuild();},true),list
      ]);
    });
  }
  function renderBlocks() {
    const blocks = state.content.data.extraSections[state.page] || (state.content.data.extraSections[state.page]=[]);
    const result = [element('p',{class:'settings-help',text:'Блоки появятся в конце выбранной страницы перед подвалом. Можно добавить текст, изображение, ссылку или документ.'})];
    result.push(element('button',{class:'button primary',text:'Добавить блок',on:{click:()=>{blocks.push({id:`block-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`,title:'Новый блок',text:''});markDirty();render();}}}));
    if (!blocks.length) result.push(empty('На этой странице дополнительных блоков пока нет.'));
    for (const [index,block] of blocks.entries()) {
      const fields = element('div',{class:'block-fields'});
      for (const [property,label,multiline] of [['title','Заголовок',false],['text','Текст',true],['alt','Описание изображения',false],['href','Адрес ссылки или файла',false],['linkLabel','Текст кнопки',false]]) {
        fields.append(makeInput(label,block[property] || '',value=>{block[property]=value;markDirty();},{multiline}).wrapper);
      }
      const preview = element('img',{class:'asset-preview',src:block.image?assetURL(block.image):undefined,alt:block.alt || '',hidden:!block.image});
      const imageActions = element('div',{},[
        preview,uploadButton(block.image?'Заменить изображение':'Добавить изображение',imageTypes,result=>{block.image=result.src;preview.src=assetURL(result.src);preview.hidden=false;markDirty();}),
        element('button',{class:'button small',text:'Убрать изображение',hidden:!block.image,on:{click:()=>{delete block.image;markDirty();render();}}})
      ]);
      const fileUpload = uploadButton('Загрузить файл для ссылки',documentTypes,result=>{block.href=result.src;if (!block.linkLabel) block.linkLabel='Открыть документ';markDirty();render();});
      const controls = element('div',{class:'block-controls'},[
        element('button',{class:'button small',text:'↑ Выше',disabled:index===0,on:{click:()=>{[blocks[index-1],blocks[index]]=[blocks[index],blocks[index-1]];markDirty();render();}}}),
        element('button',{class:'button small',text:'↓ Ниже',disabled:index===blocks.length-1,on:{click:()=>{[blocks[index+1],blocks[index]]=[blocks[index],blocks[index+1]];markDirty();render();}}}),
        element('button',{class:'button small danger',text:'Удалить блок',on:{click:()=>{blocks.splice(index,1);markDirty();render();}}})
      ]);
      result.push(section(`Блок ${index+1}`,[fields,imageActions,fileUpload],controls));
    }
    return result;
  }
  function renderSettings() {
    const data = state.content.data;
    const contactFields = element('div',{class:'two-columns'},[
      makeInput('Электронная почта',data.email || '',value=>changeContact('email',value),{type:'email'}).wrapper,
      makeInput('Телефон',data.phone || '',value=>changeContact('phone',value),{type:'tel'}).wrapper
    ]);
    data.placeStats ||= {free:99,planned:200,actual:101,date:'2026-10-01'};
    const placeFields = element('div',{class:'two-columns'});
    for (const [key,label] of [['free','Свободных мест'],['planned','Плановая численность'],['actual','Фактическая численность']]) placeFields.append(makeInput(label,data.placeStats[key],value=>{data.placeStats[key]=value===''?'':Number(value);markDirty();},{type:'number',min:0,max:1000000}).wrapper);
    placeFields.append(makeInput('Дата сведений',data.placeStats.date,value=>{data.placeStats.date=value;markDirty();},{type:'date'}).wrapper);
    const links = Object.entries(data.links || {}).map(([key,value])=>element('div',{class:'field'},[makeInput(linkNames[key] || key,value,edited=>changeGlobalLink(key,edited)).wrapper]));
    return [section('Контакты',[contactFields]),section('Свободные места',[placeFields]),section('Внешние ссылки',links)];
  }
  async function renderVersions() {
    const workspace = $('#editor-workspace');
    workspace.replaceChildren(empty('Загрузка истории…'));
    try {
      const result = await api('/versions');
      if (state.tab !== 'versions') return;
      const versions = result.versions || [];
      if (!versions.length) {workspace.replaceChildren(empty('Сохранённые версии появятся после первого изменения сайта.'));return;}
      const rows = versions.map(version=>{
        const date = new Date(version.date || version.createdAt);
        return element('div',{class:'version-row'},[
          element('div',{},[element('time',{dateTime:version.date || version.createdAt,text:Number.isNaN(date.valueOf())?version.date || version.id:date.toLocaleString('ru-RU')}),element('div',{class:'version-id',text:version.id})]),
          element('button',{class:'button',text:'Восстановить',on:{click:()=>confirmRestore(version)}})
        ]);
      });
      workspace.replaceChildren(section('Сохранённые версии',[
        element('p',{text:'Восстановление опубликует выбранную версию на сайте.'}),...rows
      ]));
    } catch (error) {if(state.tab==='versions') workspace.replaceChildren(empty(error.message));}
  }
  async function renderResponses(){
    const workspace=$('#editor-workspace');workspace.replaceChildren(empty('Загрузка ответов…'));
    try{
      const result=await api('/surveys?page='+surveyPage);if(state.tab!=='surveys')return;
      const cards=result.records.map(record=>section(new Date(record.date).toLocaleString('ru-RU'),record.answers.map(answer=>element('div',{class:'survey-answer'},[element('h3',{text:answer.question}),element('p',{text:answer.answer||'Без пожеланий'})]))));
      const controls=element('div',{class:'asset-actions'},[
        element('button',{class:'button',text:'← Назад',disabled:surveyPage===1,on:{click:()=>{surveyPage--;renderResponses();}}}),
        element('span',{text:`Страница ${surveyPage} из ${Math.max(1,Math.ceil(result.totalRecords/result.pageSize))}`}),
        element('button',{class:'button',text:'Далее →',disabled:surveyPage*result.pageSize>=result.totalRecords,on:{click:()=>{surveyPage++;renderResponses();}}})
      ]);
      workspace.replaceChildren(section('Результаты опроса',[element('p',{text:`Всего ответов: ${result.total}. Отдельные анкеты и пожелания доступны за последние ${result.retentionDays} дней. На сайте публикуются только сводные результаты.`}),element('button',{class:'button',text:'Обновить',on:{click:()=>renderResponses()}})]),...(cards.length?cards:[empty('Ответов пока нет.')]),controls);
    }catch(error){if(state.tab==='surveys')workspace.replaceChildren(empty(error.message));}
  }
  function render() {
    if (!state) return;
    $('#pane-title').textContent = titles[state.tab];
    $('#page-name').textContent = state.content.catalog.pages.find(page=>page.file===state.page)?.title || 'Сайт';
    $('#content-search').closest('label').hidden = state.tab !== 'content';
    $('#page-select').disabled = ['documents','images','galleries','settings','versions','surveys'].includes(state.tab);
    $$('#editor-tabs button').forEach(button=>{if(button.dataset.tab===state.tab)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');});
    if (state.tab === 'versions') {renderVersions();return;}
    if (state.tab === 'surveys') {renderResponses();return;}
    const renderer = {content:renderContent,tables:renderTables,documents:renderDocuments,images:renderImages,galleries:renderGalleries,blocks:renderBlocks,settings:renderSettings}[state.tab];
    $('#editor-workspace').replaceChildren(...renderer());
  }
  function openDialog(title, children, preview = false) {
    const dialog = $('#admin-dialog');
    dialogReturnFocus = document.activeElement;
    if (dialog.open) dialog.close();
    $('#dialog-heading').textContent = title;
    $('#dialog-body').replaceChildren(...children);
    dialog.classList.toggle('preview-dialog',preview);
    dialog.showModal();
  }
  function closeDialog() { $('#admin-dialog').close(); }
  function confirmAction(title,text,confirmLabel,callback) {
    openDialog(title,[element('p',{text}),element('div',{class:'dialog-actions'},[
      element('button',{class:'button',text:'Отмена',on:{click:closeDialog}}),
      element('button',{class:'button primary',text:confirmLabel,on:{click:()=>{closeDialog();callback();}}})
    ])]);
  }
  async function confirmRestore(version) {
    if(activeUploads){status('Дождитесь окончания загрузки файлов.','error');return;}
    confirmAction('Восстановить версию?', 'На сайте будет опубликована выбранная версия. Несохранённые правки будут потеряны.', 'Восстановить',async()=>{
      status('Восстанавливаем версию…');
      try {await api('/restore',{method:'POST',body:{id:version.id}});await loadContent();status('Версия восстановлена и опубликована.','success');}
      catch(error){status(error.message,'error');}
    });
  }
  async function loadContent() {
    const result = await api('/content');
    result.data.extraSections ||= {};
    result.overrides ||= {};
    const old = state;
    state = {content:result,originalData:structuredClone(result.data),page:old?.page || result.catalog.pages[0]?.file || 'index.html',tab:old?.tab || 'content',search:old?.search || '',dirty:false};
    const select = $('#page-select');
    select.replaceChildren(...result.catalog.pages.map(page=>element('option',{value:page.file,text:page.title})));
    select.value = state.page;
    $('#content-search').disabled = false;
    $('#preview-button').disabled = false;
    markSaved();render();
  }
  async function save() {
    if (!state?.dirty || activeUploads || saving) return;
    const saveButton = $('#save-button');
    const main = $('#editor-main');
    const sidebar = $('.admin-sidebar');
    saving=true;saveButton.disabled=true;main.inert=true;sidebar.inert=true;$('#preview-button').disabled=true;$('#logout-button').disabled=true;
    status('Сохраняем изменения…');
    try {
      await api('/content',{method:'PUT',body:{revision:state.content.revision,data:state.content.data,overrides:state.content.overrides}});
      await loadContent();status('Изменения сохранены и опубликованы на сайте.','success');
    } catch(error) {status(error.message,'error');saveButton.disabled=false;}
    finally {saving=false;main.inert=false;sidebar.inert=false;$('#preview-button').disabled=false;$('#logout-button').disabled=false;saveButton.disabled=!state.dirty;}
  }
  async function preview() {
    const button=$('#preview-button');button.disabled=true;status('Готовим предпросмотр…');
    try {
      const result=await api('/preview',{method:'POST',body:{page:state.page,content:{revision:state.content.revision,data:state.content.data,overrides:state.content.overrides}}});
      const html=typeof result==='string'?result:result.html;
      if(!html)throw new Error('Сервер не вернул предпросмотр.');
      const frame=element('iframe',{class:'preview-frame',title:'Предпросмотр страницы',sandbox:'allow-same-origin',srcdoc:html});
      openDialog(`Предпросмотр — ${state.content.catalog.pages.find(page=>page.file===state.page)?.title || 'Страница'}`,[frame],true);status('');
    }catch(error){status(error.message,'error');}
    finally{button.disabled=false;}
  }
  async function logout() {
    const perform=async()=>{
      try{await api('/logout',{method:'POST',body:{}});state&&(state.dirty=false);location.href='/admin/login.html';}
      catch(error){status(error.message,'error');}
    };
    if(state?.dirty)confirmAction('Выйти из админки?','Несохранённые изменения будут потеряны.','Выйти',perform);else await perform();
  }
  async function initializeLogin() {
    const form=$('#login-form'), title=$('#login-title'), intro=$('#login-intro'), button=$('#login-submit');
    try{
      const session=await api('/session');csrf=session.csrf || '';
      if(session.authenticated){location.replace('/admin/index.html');return;}
      if(session.setupRequired && !session.setupAllowed){title.textContent='Создайте администратора';intro.textContent='Учётная запись ещё не настроена.';$('#setup-unavailable').hidden=false;status('');return;}
      const setup=!!session.setupRequired;
      if(setup){title.textContent='Создать администратора';intro.textContent='Задайте имя пользователя и пароль для управления сайтом.';button.textContent='Создать и войти';form.password.minLength=12;form.password.autocomplete='new-password';form.password.insertAdjacentElement('afterend',element('small',{text:'Не менее 12 символов.'}));}
      form.hidden=false;status('');
      $('#show-password').addEventListener('change',event=>{form.password.type=event.target.checked?'text':'password';});
      form.addEventListener('submit',async event=>{
        event.preventDefault();if(!form.reportValidity())return;button.disabled=true;status(setup?'Создаём администратора…':'Выполняем вход…');
        try{const result=await api(setup?'/setup':'/login',{method:'POST',body:{username:form.username.value.trim(),password:form.password.value}});csrf=result.csrf||csrf;form.password.value='';location.replace('/admin/index.html');}
        catch(error){status(error.message,'error');button.disabled=false;}
      });
    }catch(error){status(location.protocol==='file:'?'Для входа запустите сервер: npm start в папке WEB2. Админка работает через Node.js.':error.message,'error');}
  }
  async function initializeEditor() {
    if(location.protocol==='file:'){status('Админка работает через сервер Node.js. Запустите npm start в папке WEB2 и откройте /admin/login.html.','error');return;}
    $('#dialog-close').addEventListener('click',closeDialog);
    $('#admin-dialog').addEventListener('close',()=>{dialogReturnFocus?.focus();});
    $('#page-select').addEventListener('change',event=>{state.page=event.target.value;render();});
    $$('#editor-tabs button').forEach(button=>button.addEventListener('click',()=>{if(!state)return;state.tab=button.dataset.tab;status('');render();}));
    let searchTimer;
    $('#content-search').addEventListener('input',event=>{state.search=event.target.value;clearTimeout(searchTimer);searchTimer=setTimeout(render,150);});
    $('#save-button').addEventListener('click',save);$('#preview-button').addEventListener('click',preview);$('#logout-button').addEventListener('click',logout);
    window.addEventListener('beforeunload',event=>{if(state?.dirty||activeUploads){event.preventDefault();event.returnValue='';}});
    try{
      const session=await api('/session');
      if(!session.authenticated){location.replace('/admin/login.html');return;}
      csrf=session.csrf||'';await loadContent();status('');
    }catch(error){status(error.message,'error');}
  }
  document.body.dataset.adminScreen==='login'?initializeLogin():initializeEditor();
})();
