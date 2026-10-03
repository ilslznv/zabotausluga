"""Import supplied content without changing or depending on the original site."""
from pathlib import Path
from html.parser import HTMLParser
import html, json, re, shutil
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
WEB = ROOT / 'WEB'
ASSETS = WEB / 'dist' / 'assets'
images = ASSETS / 'images'
docs = ASSETS / 'documents'
images.mkdir(parents=True, exist_ok=True)
docs.mkdir(parents=True, exist_ok=True)

def copy(source, name, folder=images):
    p = ROOT / source
    shutil.copy2(p, folder / name)
    return f'assets/{folder.name}/{name}'

data = {'images': {}, 'documents': {}, 'galleries': {}, 'email': 'zabota-usluga72@mail.ru',
        'links': {'rentals': 'https://social.lenobl.ru/ru/v-pomosh-naseleniyu/punkty-prokata-tehnicheskih-sredstv-reabilitacii/', 'researchSurvey': 'https://research.rcsoc.spbu.ru/socservices',
        'quality': 'https://bus.gov.ru/qrcode/rate/789838',
        'rates2026': 'https://docs.google.com/spreadsheets/d/1FgCovLTgul7SkfWgDh0hHQEU38e2lPWV/edit?pli=1&gid=1262853759#gid=1262853759',
        'decree2026': 'https://drive.google.com/file/d/1WauJS5KsistEe6CREgCu90Hlby3Y8G8u/view?usp=drive_link'}}
for key, source, name in [
    ('logo','logo.png','logo.png'), ('hero','main/hero-image.png','flowers.png'),
    ('care','main/Group_9.png','care.png'), ('registration','page6/photo.jpg','registration.jpg'),
    ('registry1','page7/___1_.jpg','registry-1.jpg'), ('registry2','page7/___2_.jpg','registry-2.jpg')]:
    data['images'][key] = copy(source,name)
for p in (ROOT/'main/links-logo').glob('*.png'):
    data['images'][p.stem] = copy(p.relative_to(ROOT),p.name)

groups = {'press':ROOT/'main/slider-images', 'thanks':ROOT/'page3/1',
          'poem':ROOT/'page3/2', 'awards':ROOT/'page3/3'}
for key, folder in groups.items():
    files = sorted(folder.iterdir())
    if key == 'press':
        files.sort(key=lambda p: (p.name != '9Q312ZkBq5M.jpg',p.name))
    if key == 'thanks':
        files.sort(key=lambda p: (p.name != '___page-0001.jpg',p.name))
    if key == 'awards':
        files.sort(key=lambda p: (p.name != 'photo_2024-12-19_20-.png',p.name))
    data['galleries'][key] = [{'src':copy(p.relative_to(ROOT),f'{key}-{i+1}{p.suffix}'),
                             'name':p.name} for i,p in enumerate(files)]
    for i,p in enumerate(files):
        preview=Image.open(p).convert('RGB')
        preview.thumbnail((900,1100))
        name=f'{key}-{i+1}-preview.webp'
        preview.save(images/name,'WEBP',quality=85,method=6)
        data['galleries'][key][i]['thumb']=f'assets/images/{name}'

document_keys = [
    ('warning','main/Предостережение_о_недопустимости_нарушения_обязательных_требований.pdf','warning.pdf'),
    ('warningReport','main/Отчет_исполнения_Предостережения_№67_от_17_09_2024.pdf','warning-report-2024.pdf'),
    ('finance2023','main/Levkovich_USN_2023.pdf','declaration-2023.pdf'),
    ('finance2024','main/Декларация 2024.pdf','declaration-2024.pdf'),
    ('quality','page5/НОК_2023_с_планом_по_устанению_недостатков.pdf','quality-2023.pdf'),
    ('sampleContract','page2/Образец договора.docx','sample-contract.docx'),
    ('rules','page8/2_Pravila_vnutrennego_rasporyadka.docx','internal-rules.docx'),
    ('decree536','page9/ПП ЛО 536 от 29.07.2022 ОБ УТВЕРЖДЕНИИ ПОРЯДКА ПРЕДОСТАВЛЕНИЯ СОЦИАЛЬНЫХ УСЛУГ.pdf','decree-536.pdf')]
for key, pattern, name in [('contract','7_','contract-form.docx'),('law442','8_','federal-law-442.docx'),
                          ('application','9_','application-form.docx'),('decree606','10_','decree-606.rtf'),
                          ('law72','11_','regional-law-72.docx')]:
    source = next((ROOT/'page9').glob(pattern+'*')).relative_to(ROOT)
    document_keys.append((key,source,name))
for key,source,name in document_keys:
    path = ROOT/source
    data['documents'][key] = {'src':copy(source,name,docs),'size':path.stat().st_size,
                             'format':path.suffix[1:].upper(), 'source':str(source)}

class ContentParser(HTMLParser):
    """Retain text and semantic markup only, discarding editor wrappers."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts=[]
    def handle_starttag(self,tag,attrs):
        if tag in ('strong','u'):
            self.parts.append('<'+tag+'>')
        elif tag == 'a':
            href=dict(attrs).get('href','')
            if href.startswith(('https://','http://')):
                self.parts.append('<a href="'+html.escape(href,quote=True)+'" target="_blank" rel="noopener noreferrer">')
        elif tag in ('br','p'):
            self.parts.append('\n')
    def handle_endtag(self,tag):
        if tag in ('strong','u','a'):
            self.parts.append('</'+tag+'>')
        elif tag=='p': self.parts.append('\n')
    def handle_data(self,text):
        self.parts.append(html.escape(text.replace('\xa0',' ')))

for key, file in [('procedure','doc4.md'),('tariffs','doc5.md')]:
    source=(ROOT/'page2'/file).read_text(encoding='utf-8-sig')
    source=source[source.index('<div'):]
    parser=ContentParser(); parser.feed(source)
    segments=[s.strip() for s in ''.join(parser.parts).split('\n') if s.strip()]
    # The title is rendered separately as an accessible dialog heading.
    data[key] = ''.join('<p>'+s+'</p>' for s in segments[1:])

text=(ROOT/'page2/text2.md').read_text(encoding='utf-8-sig')
data['services']=[]
for line in text.splitlines():
    if not line.strip(): continue
    if line.startswith('* '): data['services'][-1]['items'].append(line[2:].strip())
    else: data['services'].append({'title':line.strip(),'items':[]})

text=(ROOT/'main/faq-popup-6.md').read_text(encoding='utf-8-sig')
data['faq']=[]
for line in text.splitlines():
    line=line.strip()
    if not line: continue
    if line.endswith('?'):
        data['faq'].append({'question':line,'answer':[]})
    elif data['faq']:
        data['faq'][-1]['answer'].append(line)

# Extract the supplied QR code; its pixels remain unchanged.
Image.open(ROOT/'page5/1.png').crop((880,139,1151,410)).save(images/'quality-qr.png')
data['images']['qr']='assets/images/quality-qr.png'
(WEB/'content.json').write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
print(f"Imported 9 page folders, {len(data['documents'])} documents and all supplied content images; original files preserved.")
