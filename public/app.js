/* «Дело в коробке» — складское приложение (клиентская часть). */
(function(){
"use strict";
const $=id=>document.getElementById(id);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const norm=s=>String(s??"").trim().toLowerCase().replace(/\s+/g," ");
const LOOK={"А":"A","В":"B","Е":"E","К":"K","М":"M","Н":"H","О":"O","Р":"P","С":"C","Т":"T","Х":"X","У":"Y"};
const normCell=s=>String(s??"").trim().toUpperCase().replace(/\s+/g,"").replace(/[АВЕКМНОРСТХУ]/g,c=>LOOK[c]);
/* сканер на русской раскладке печатает «Ф-01» вместо «A-01» */
const RU="ёйцукенгшщзхъфывапролджэячсмитьбю", EN="`qwertyuiop[]asdfghjkl;'zxcvbnm,.";
const fixLayout=s=>String(s).split("").map(c=>{const i=RU.indexOf(c.toLowerCase());if(i<0)return c;const e=EN[i];return c===c.toLowerCase()?e:e.toUpperCase()}).join("");
const pkey=(client,art)=>norm(client)+"|"+norm(art);
const BUF="PRIEM";
const ls={get(k){try{const v=localStorage.getItem("wms."+k);return v?JSON.parse(v):null}catch(e){return null}},set(k,v){try{localStorage.setItem("wms."+k,JSON.stringify(v))}catch(e){}}};
function plural(n,a,b,c){const m=n%10,h=n%100;if(m===1&&h!==11)return a;if(m>=2&&m<=4&&(h<12||h>14))return b;return c}
function fmtTs(iso){const d=new Date(iso);if(isNaN(d))return"";const p=n=>String(n).padStart(2,"0");return`${p(d.getDate())}.${p(d.getMonth()+1)}.${String(d.getFullYear()).slice(2)} ${p(d.getHours())}:${p(d.getMinutes())}`}
const addrHtml=(c,big)=>`<span class="addr${big?" big":""}${normCell(c)===BUF?" buf":""}">${esc(c)}</span>`;
const today=()=>new Date().toISOString().slice(0,10);
const isAdmin=()=>me&&me.role==="admin";

/* ---------- состояние ---------- */
let me=null,live=false,appVersion="";
const D={stock:new Map(),products:new Map(),pidx:new Map(),cells:new Set(),ops:[],receipts:[]};
let tab="rc";

/* ---------- обратная связь ---------- */
let actx=null;
function beep(good){try{actx=actx||new (window.AudioContext||window.webkitAudioContext)();const o=actx.createOscillator(),g=actx.createGain();o.frequency.value=good?1250:240;o.type=good?"sine":"square";g.gain.value=.06;o.connect(g);g.connect(actx.destination);o.start();o.stop(actx.currentTime+(good?.08:.3))}catch(e){}try{navigator.vibrate&&navigator.vibrate(good?30:[80,60,80])}catch(e){}}
function toast(msg,bad){const t=$("toast");t.textContent=msg;t.className=bad?"bad":"";t.hidden=false;clearTimeout(toast._t);toast._t=setTimeout(()=>t.hidden=true,bad?4200:2600)}
const fail=msg=>{beep(false);toast(msg,true)};
const okb=msg=>{beep(true);if(msg)toast(msg)};

/* ---------- сервер ---------- */
async function api(method,url,body){
  let r;
  try{r=await fetch(url,{method,headers:body?{"Content-Type":"application/json"}:{},body:body?JSON.stringify(body):undefined,credentials:"same-origin",cache:"no-store"})}
  catch(e){setOnline(false);throw new Error("Нет связи с сервером. Проверьте интернет.")}
  setOnline(true);
  let j=null;try{j=await r.json()}catch(e){}
  if(r.status===401&&url!=="/api/login"){showLogin(false);throw new Error("Сессия закончилась. Войдите снова.")}
  if(!r.ok)throw new Error((j&&j.error)||`Ошибка сервера (${r.status})`);
  return j;
}
function setOnline(on){$("offline").hidden=on;$("ptOffline").hidden=on}
let pending=new Set(),loadT=null;
function load(parts){parts.forEach(p=>pending.add(p));clearTimeout(loadT);return new Promise(res=>{loadT=setTimeout(async()=>{const ps=[...pending];pending.clear();try{await fetchParts(ps)}catch(e){}res()},60)})}
async function fetchParts(parts){
  const j=await api("GET","/api/data?parts="+parts.join(","));
  if(j.stock)D.stock=new Map(j.stock.map(r=>[String(r.id),{...r,id:String(r.id)}]));
  if(j.products){D.products=new Map(j.products.map(p=>[String(p.id),{...p,id:String(p.id)}]));D.pidx=new Map([...D.products.values()].map(p=>[pkey(p.client,p.article),p]))}
  if(j.cells)D.cells=new Set(j.cells);
  if(j.ops)D.ops=j.ops;
  if(j.receipts)D.receipts=j.receipts;
  live=true;refresh();
}
/* mode: "app" — складской интерфейс, "portal" — кабинет клиента (у клиента всегда, у сотрудника в режиме просмотра) */
let mode="app";
const ALL_PARTS=["stock","products","cells","ops","receipts"];
function reloadAll(parts){
  if(mode==="portal"){loadPortal();return}
  const data=(parts||ALL_PARTS).filter(p=>p!=="billing");if(data.length)load(data);
  if((tab==="svc"||tab==="bill")&&(!parts||parts.includes("billing")))loadBilling();
}
let es=null;
function connectEvents(){
  if(es)es.close();
  es=new EventSource("/api/events");
  es.addEventListener("change",e=>{try{reloadAll(JSON.parse(e.data).parts)}catch(err){}});
  es.onopen=()=>{setOnline(true);reloadAll()};
  es.onerror=()=>{setStatus(true);if(mode==="portal")ptOffline();if(es.readyState===2)setTimeout(recheck,5000)};
}
/* поток событий оборвался насовсем: проверяем, жива ли сессия, и переподключаемся */
async function recheck(){
  if(!me)return;
  try{const m=await api("GET","/api/me");if(!m.user){showLogin(false);return}connectEvents()}
  catch(e){setTimeout(recheck,10000)}
}
/* запасной вариант, если прокси хостинга режет живые обновления */
setInterval(()=>{if(me&&document.visibilityState==="visible"&&(!es||es.readyState!==1))reloadAll()},30000);
async function run(btn,busyText,fn){
  const prev=btn?btn.textContent:"";if(btn){btn.disabled=true;btn.textContent=busyText}
  try{return await fn()}catch(e){fail(e.message||String(e));return null}
  finally{if(btn){btn.disabled=false;btn.textContent=prev}}
}

/* ---------- поиск по коду ---------- */
/* одна компания — один пункт, даже если её писали в разном регистре или с лишними пробелами */
function clients(){const m=new Map();const add=c=>{const k=norm(c);if(k&&!m.has(k))m.set(k,String(c).trim().replace(/\s+/g," "))};D.stock.forEach(r=>add(r.client));D.products.forEach(p=>add(p.client));return[...m.values()].sort((a,b)=>a.localeCompare(b,"ru"))}
/* «ООО "АЙМОЛЛ"», «ООО «АЙМОЛЛ»», «ООО АЙМОЛЛ» и латинские двойники букв — для сервера это разные клиенты.
   looseKey их сближает, чтобы предупредить человека до того, как товар уйдёт не в тот кабинет. */
const LAT2CYR={a:"а",b:"в",c:"с",e:"е",h:"н",k:"к",m:"м",o:"о",p:"р",t:"т",x:"х",y:"у"};
const looseKey=s=>norm(s).replace(/[«»"'„“”`]/g,"").replace(/[abcehkmoptxy]/g,c=>LAT2CYR[c]).replace(/\s+/g," ").trim();
function similarClient(name){const k=norm(name),lk=looseKey(name);if(!k)return null;if(clients().some(c=>norm(c)===k))return null;return clients().find(c=>looseKey(c)===lk)||null}
/* расхождения приёмки: строки списка, где принято не столько, сколько ожидалось, плюс товар вне списка (если список был) */
const rcDiff=lines=>{const hasList=lines.some(l=>l.expected!=null);return lines.filter(l=>l.expected!=null?l.got!==l.expected:hasList&&l.got>0).length};
function allCells(){const m=new Map();D.cells.forEach(c=>m.set(c,{cell:c,doc:true,items:0,units:0}));
  D.stock.forEach(r=>{const k=normCell(r.cell);const c=m.get(k)||{cell:k,doc:false,items:0,units:0};c.items++;c.units+=r.qty;m.set(k,c)});return m}
function knownCell(c){if(!c)return false;if(c===BUF||D.cells.has(c))return true;for(const r of D.stock.values())if(r.cell===c)return true;return false}
function findItems(code){
  const raw=String(code).trim(),n=norm(code);const out=new Map();
  D.products.forEach(p=>{if((p.barcodes||[]).includes(raw)||norm(p.article)===n)out.set(pkey(p.client,p.article),{client:p.client,article:p.article,name:p.name})});
  D.stock.forEach(r=>{if(norm(r.article)===n){const k=pkey(r.client,r.article);if(!out.has(k))out.set(k,{client:r.client,article:r.article,name:r.name})}});
  return[...out.values()];
}
function resolve(code){
  for(const c of [code,fixLayout(code)]){
    const cell=normCell(c);if(knownCell(cell))return{type:"cell",cell};
    const items=findItems(c);if(items.length)return{type:"item",items,code:String(c).trim()};
  }
  return{type:"none",code:String(code).trim()};
}
const scanHandlers={};
function bindScan(inputId,btnId,handler){
  const inp=$(inputId);scanHandlers[inputId]=handler;
  const go=()=>{const v=inp.value.trim();inp.value="";if(v)handler(v);inp.focus()};
  inp.addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();go()}});
  $(btnId).addEventListener("click",go);
}

/* ---------- камера ---------- */
const CAM_ICON=`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2"/><path d="M7 8v8M10 8v8M13 8v8M16 8v8"/></svg>`;
document.querySelectorAll("[data-cam]").forEach(b=>{b.innerHTML=CAM_ICON;b.addEventListener("click",()=>openCam(b.dataset.cam))});
/* Поток с камеры берём сами и раз в 150 мс копируем кадр на canvas: по нему распознаём штрихкод
   (BarcodeDetector в Chrome/Android, ZXing в Safari и остальных) и замечаем чёрную картинку.
   Чёрный экран на телефонах обычно значит, что браузер выбрал не ту заднюю камеру (широкоугольную,
   макро, датчик глубины) — тогда помогает «Другая камера». Если живое видео недоступно совсем
   (встроенный браузер Telegram/WhatsApp, старый телефон), работает «Сфотографировать». */
const cam={stream:null,timer:null,handler:null,last:"",lastT:0,det:null,zx:null,devices:[],deviceId:"",canvas:null,ctx:null,n:0,dark:0,noFrame:0,warn:false,torch:false};
try{const c=ls.get("camCont");if(c===false)$("camCont").checked=false}catch(e){}
$("camCont").addEventListener("change",e=>ls.set("camCont",e.target.checked));
const CAM_TITLES={rcScan:"Приёмка",mvScan:"Размещение",pkScan:"Сборка",invScan:"Инвентаризация"};
const CAM_FORMATS=["ean_13","ean_8","code_128","code_39","code_93","upc_a","upc_e","itf","qr_code","data_matrix","codabar"];
const IN_APP=/Telegram|WhatsApp|Instagram|FBAN|FBAV|VKClient|; wv\)/i.test(navigator.userAgent);
function camStatus(text,bad){const s=$("camStatus");s.textContent=text||"";s.classList.toggle("bad",!!bad);cam.warn=!!bad}
async function camDecoder(){
  if(cam.det||cam.zx)return true;
  if("BarcodeDetector" in window){try{const f=await BarcodeDetector.getSupportedFormats();const want=CAM_FORMATS.filter(x=>f.includes(x));if(want.length)cam.det=new BarcodeDetector({formats:want})}catch(e){}}
  if(!cam.det&&window.ZXing&&ZXing.MultiFormatReader){const hints=new Map();hints.set(ZXing.DecodeHintType.TRY_HARDER,true);cam.zx=new ZXing.MultiFormatReader();cam.zx.setHints(hints)}
  return !!(cam.det||cam.zx);
}
async function decodeCanvas(c){
  if(cam.det){try{const r=await cam.det.detect(c);return r.length?r[0].rawValue:null}catch(e){return null}}
  if(cam.zx){try{return cam.zx.decodeWithState(new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(new ZXing.HTMLCanvasElementLuminanceSource(c)))).getText()}catch(e){return null}}
  return null;
}
function camErrorText(e){
  const n=e&&e.name;
  if(n==="NotAllowedError"||n==="SecurityError")return"Нет доступа к камере. Нажмите на значок замка в адресной строке, разрешите камеру для этого сайта и откройте сканер снова.";
  if(n==="NotReadableError"||n==="AbortError")return"Камера занята другим приложением. Закройте его и попробуйте снова.";
  if(n==="NotFoundError"||n==="OverconstrainedError")return"Камера не найдена.";
  return(e&&e.message)||"Камера недоступна.";
}
function camStopStream(){
  clearTimeout(cam.timer);
  if(cam.stream){cam.stream.getTracks().forEach(t=>t.stop());cam.stream=null}
  const v=$("camVideo");try{v.pause()}catch(e){}v.srcObject=null;
}
async function openCam(inputId){
  cam.handler=scanHandlers[inputId];cam.last="";
  if(!window.isSecureContext||!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){
    toast("Живое видео с камеры здесь недоступно. Сфотографируйте штрихкод.");$("camPhoto").click();return}
  $("camTitle").textContent="Сканирование · "+(CAM_TITLES[inputId]||"");$("camLast").textContent="";
  $("camSwitch").hidden=true;$("camTorch").hidden=true;$("camOv").hidden=false;
  camStatus("Разрешите доступ к камере, если браузер спросит");
  if(!await camDecoder()){camStatus("Не загрузился модуль распознавания. Обновите страницу.",true);return}
  await camStart(ls.get("camDevice"));
}
async function camStart(deviceId){
  camStopStream();
  const tries=[];
  if(deviceId)tries.push({deviceId:{exact:deviceId}});
  tries.push({facingMode:{ideal:"environment"}},true);
  let err=null;
  for(const video of tries){
    try{cam.stream=await navigator.mediaDevices.getUserMedia({video,audio:false});break}
    catch(e){err=e;if(e.name==="NotAllowedError"||e.name==="SecurityError")break}
  }
  if($("camOv").hidden){camStopStream();return}
  if(!cam.stream){camStatus(camErrorText(err)+(IN_APP?" Во встроенном браузере мессенджера камера часто не работает: откройте сайт в Chrome или Safari.":""),true);return}
  const v=$("camVideo");v.muted=true;v.setAttribute("playsinline","");v.setAttribute("autoplay","");v.srcObject=cam.stream;
  try{await v.play()}catch(e){}
  const track=cam.stream.getVideoTracks()[0];
  try{cam.deviceId=(track.getSettings&&track.getSettings().deviceId)||""}catch(e){cam.deviceId=""}
  try{cam.devices=(await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==="videoinput")}catch(e){cam.devices=[]}
  $("camSwitch").hidden=cam.devices.length<2;
  let caps={};try{caps=track.getCapabilities?track.getCapabilities():{}}catch(e){}
  cam.torch=false;$("camTorch").hidden=!caps.torch;$("camTorch").textContent="Фонарик";
  camStatus("Наведите камеру на штрихкод");
  cam.n=0;cam.dark=0;cam.noFrame=0;camLoop();
}
function camLoop(){
  const tick=async()=>{
    if(!cam.stream)return;
    const v=$("camVideo");
    if(v.videoWidth&&v.readyState>=2){
      cam.noFrame=0;
      const w=Math.min(800,v.videoWidth),h=Math.round(v.videoHeight*w/v.videoWidth);
      const c=cam.canvas||(cam.canvas=document.createElement("canvas"));
      if(c.width!==w||c.height!==h){c.width=w;c.height=h;cam.ctx=null}
      const ctx=cam.ctx||(cam.ctx=c.getContext("2d",{willReadFrequently:true}));
      ctx.drawImage(v,0,0,w,h);
      if(++cam.n%6===0){
        const d=ctx.getImageData(0,0,w,h).data;let s=0,k=0;
        for(let i=0;i<d.length;i+=4*101){s+=d[i]+d[i+1]+d[i+2];k++}
        const dark=s/k/3<8;cam.dark=dark?cam.dark+1:0;
        if(cam.dark===3)camStatus(cam.devices.length>1?"Картинка чёрная. Нажмите «Другая камера», пока не появится изображение.":"Картинка чёрная. Проверьте, не закрыт ли объектив, или нажмите «Сфотографировать».",true);
        else if(!dark&&cam.warn)camStatus("Наведите камеру на штрихкод");
      }
      const code=await decodeCanvas(c);
      if(code)camHit(code);
    }else if(++cam.noFrame===20)camStatus("Видео с камеры не приходит. Нажмите «Другая камера» или «Сфотографировать».",true);
    if(cam.stream)cam.timer=setTimeout(tick,150);
  };
  tick();
}
function camHit(code){
  const t=Date.now();if(code===cam.last&&t-cam.lastT<1500)return;cam.last=code;cam.lastT=t;
  $("camLast").textContent=code;
  if(cam.handler)cam.handler(code);
  if(!$("camCont").checked)closeCam();
}
function closeCam(){camStopStream();$("camOv").hidden=true;cam.last=""}
$("camClose").addEventListener("click",closeCam);
$("camSwitch").addEventListener("click",async()=>{
  if(!cam.devices.length)return;
  const i=(cam.devices.findIndex(d=>d.deviceId===cam.deviceId)+1)%cam.devices.length;
  const d=cam.devices[i];ls.set("camDevice",d.deviceId);
  camStatus(`Включаю камеру ${i+1} из ${cam.devices.length}…`);
  await camStart(d.deviceId);
  if(!cam.warn)camStatus(`Камера ${i+1} из ${cam.devices.length}${d.label?" · "+d.label:""}. Наведите на штрихкод`);
});
$("camTorch").addEventListener("click",async()=>{
  const t=cam.stream&&cam.stream.getVideoTracks()[0];if(!t)return;
  try{await t.applyConstraints({advanced:[{torch:!cam.torch}]});cam.torch=!cam.torch}catch(e){fail("Фонарик не включился")}
  $("camTorch").textContent=cam.torch?"Выключить фонарик":"Фонарик";
});
/* распознавание с фотографии: работает даже там, где живое видео недоступно */
$("camPhotoBtn").addEventListener("click",()=>$("camPhoto").click());
$("camPhoto").addEventListener("change",async e=>{
  const file=e.target.files[0];e.target.value="";if(!file)return;
  if(!await camDecoder()){fail("Не загрузился модуль распознавания. Обновите страницу.");return}
  let img;
  try{img=await new Promise((ok,no)=>{const i=new Image();i.onload=()=>ok(i);i.onerror=no;i.src=URL.createObjectURL(file)})}
  catch(err){fail("Не удалось открыть фото");return}
  const c=document.createElement("canvas");let code=null;
  for(const rot of [0,90]){
    const s=Math.min(1,1600/Math.max(img.naturalWidth,img.naturalHeight));
    const w=Math.round(img.naturalWidth*s),h=Math.round(img.naturalHeight*s);
    c.width=rot?h:w;c.height=rot?w:h;const ctx=c.getContext("2d");
    if(rot){ctx.translate(h,0);ctx.rotate(Math.PI/2)}
    ctx.drawImage(img,0,0,w,h);
    code=await decodeCanvas(c);if(code)break;
  }
  URL.revokeObjectURL(img.src);
  if(!code){fail("Штрихкод на фото не найден. Снимите ближе и ровнее, чтобы штрихкод занимал большую часть кадра.");return}
  if(!$("camOv").hidden)camHit(code);
  else{$("camLast").textContent=code;if(cam.handler)cam.handler(code)}
});
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&!$("camOv").hidden)closeCam()});

/* ---------- адреса и порядок обхода ---------- */
function toks(addr){return normCell(addr).split(/[-._/,:]+/).filter(Boolean).map(t=>/^\d+$/.test(t)?{n:+t,s:t}:{n:null,s:t})}
function cmpTok(a,b){
  if(!a&&!b)return 0;if(!a)return -1;if(!b)return 1;
  if(a.n!==null&&b.n!==null)return a.n-b.n;
  if(a.n!==null)return -1;if(b.n!==null)return 1;
  return a.s.localeCompare(b.s,"ru");
}
function cmpAddr(a,b){const x=toks(a),y=toks(b);for(let i=0;i<Math.max(x.length,y.length);i++){const c=cmpTok(x[i],y[i]);if(c)return c}return 0}
/* Порядок: зона → стеллаж → место вдоль стеллажа → ярус. «Змейка»: каждый второй стеллаж зоны проходится в обратную сторону. */
function routeSort(list,snake){
  const parts=list.map(s=>{const t=toks(s.cell);
    if(t.length>=4)return{s,zone:t[0],rack:t[1],pos:t[t.length-1],tier:t[2]};
    if(t.length===3)return{s,zone:t[0],rack:t[1],pos:t[2],tier:null};
    return{s,zone:t[0],rack:t[1]||null,pos:null,tier:null};});
  const rackIdx=new Map();
  if(snake){const byZone=new Map();
    parts.forEach(p=>{const z=p.zone?p.zone.s:"";if(!byZone.has(z))byZone.set(z,[]);const arr=byZone.get(z);if(p.rack&&!arr.some(r=>cmpTok(r,p.rack)===0))arr.push(p.rack)});
    byZone.forEach((arr,z)=>{arr.sort(cmpTok);arr.forEach((r,i)=>rackIdx.set(z+"|"+r.s,i))});}
  parts.sort((a,b)=>{
    let c=cmpTok(a.zone,b.zone);if(c)return c;
    c=cmpTok(a.rack,b.rack);if(c)return c;
    const rev=snake&&a.rack&&(rackIdx.get((a.zone?a.zone.s:"")+"|"+a.rack.s)%2===1);
    c=cmpTok(a.pos,b.pos);if(c)return rev?-c:c;
    c=cmpTok(a.tier,b.tier);if(c)return c;
    return cmpAddr(a.s.cell,b.s.cell)||norm(a.s.article).localeCompare(norm(b.s.article),"ru");
  });
  return parts.map(p=>p.s);
}

/* ---------- чтение Excel / CSV ---------- */
function parseCSV(text){
  text=text.replace(/^﻿/,"");
  const first=text.split(/\r?\n/,1)[0]||"";
  const cnt=ch=>first.split(ch).length;
  const d=[";","\t",","].sort((a,b)=>cnt(b)-cnt(a))[0];
  const rows=[];let row=[],f="",q=false;
  for(let i=0;i<text.length;i++){const c=text[i];
    if(q){if(c==='"'){if(text[i+1]==='"'){f+='"';i++}else q=false}else f+=c}
    else if(c==='"')q=true;
    else if(c===d){row.push(f);f=""}
    else if(c==="\n"){row.push(f);rows.push(row);row=[];f=""}
    else if(c!=="\r")f+=c;}
  if(f||row.length){row.push(f);rows.push(row)}
  return rows;
}
async function readMatrix(file){
  const buf=await file.arrayBuffer();
  if(/\.csv$/i.test(file.name)){
    let text;try{text=new TextDecoder("utf-8",{fatal:true}).decode(buf)}catch(e){text=new TextDecoder("windows-1251").decode(buf)}
    return parseCSV(text);
  }
  if(typeof XLSX==="undefined")throw new Error("Не загрузилась библиотека Excel. Обновите страницу.");
  const wb=XLSX.read(new Uint8Array(buf),{type:"array"});
  for(const name of wb.SheetNames){
    const m=XLSX.utils.sheet_to_json(wb.Sheets[name],{header:1,raw:false,defval:""});
    if(m.some(r=>r.some(v=>String(v).trim())))return m;
  }
  return [];
}
const PAT={
  bc:["штрихкод","штрих-код","баркод","barcode","ean","шк"],
  art:["артикул продавца","артикул поставщика","offer_id","offer id","артикул товара","vendor code","артикул"],
  qty:["количество","кол-во","кол.","qty","quantity"],
  name:["наименование","название","товар","name"],
  cell:["ячейка","адрес","место"],
  client:["клиент","продавец","селлер","владелец"]
};
function findCol(header,key,taken){
  const h=header.map(norm);
  for(const p of PAT[key]){const i=h.findIndex((v,idx)=>v&&!taken.includes(idx)&&(v===p||v.includes(p)));if(i>=0)return i}
  return -1;
}
function detect(matrix,need){
  for(let r=0;r<Math.min(matrix.length,25);r++){
    const hdr=matrix[r]||[];
    if(need.every(k=>findCol(hdr,k,[])>=0)){const cols={};const taken=[];
      for(const k of Object.keys(PAT)){const i=findCol(hdr,k,taken);cols[k]=i;if(i>=0)taken.push(i)}
      return{hdr:r,cols};}
  }
  return{hdr:0,cols:{bc:-1,art:-1,qty:-1,name:-1,cell:-1,client:-1}};
}
function num(v){const n=parseFloat(String(v).replace(/\s/g,"").replace(",","."));return isFinite(n)?n:NaN}
const cellv=(row,i)=>i>=0?String(row[i]??"").trim():"";

/* ---------- файлы и печать ---------- */
function saveFile(filename,blob){
  const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),4000);
}
function saveXlsx(filename,aoa,sheet){
  if(typeof XLSX==="undefined"){fail("Библиотека Excel не загрузилась. Обновите страницу.");return}
  const ws=XLSX.utils.aoa_to_sheet(aoa);ws["!cols"]=(aoa.find(r=>r.length>2)||aoa[0]).map(()=>({wch:18}));
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,sheet||"Лист1");
  saveFile(filename,new Blob([XLSX.write(wb,{bookType:"xlsx",type:"array"})],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}));
}
function printHtml(html){
  const old=$("printFrame");if(old)old.remove();
  const f=document.createElement("iframe");f.id="printFrame";f.title="Печать";f.style.cssText="position:fixed;right:0;bottom:0;width:0;height:0;border:0";
  f.onload=()=>setTimeout(()=>{try{f.contentWindow.focus();f.contentWindow.print()}catch(e){fail("Не удалось открыть печать. Скачайте файл и напечатайте его.")}},100);
  document.body.appendChild(f);f.srcdoc=html;
}

/* ---------- этикетки ---------- */
function barcodeSvg(text){
  if(typeof JsBarcode==="undefined"||!/^[\x20-\x7e]+$/.test(text))return"";
  const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");
  const o={displayValue:false,margin:0,height:60,width:2,background:"#ffffff",lineColor:"#000000"};
  try{JsBarcode(svg,text,{...o,format:/^\d{13}$/.test(text)?"EAN13":"CODE128"})}
  catch(e){try{JsBarcode(svg,text,{...o,format:"CODE128"})}catch(e2){return""}}
  svg.setAttribute("preserveAspectRatio","none");
  return svg.outerHTML;
}
function labelDoc(labels,size){
  const dims={"58x40":[58,40],"58x30":[58,30]}[size]||[70,37];
  const a4=size==="a4";
  const css=`*{box-sizing:border-box}body{margin:0;font-family:Arial,Helvetica,sans-serif;color:#000;background:#fff}
.hint{padding:12px;font-size:14px;background:#fff7cc;border-bottom:1px solid #e0c200}
@media print{.hint{display:none}}
${a4?`@page{size:A4;margin:0}.sheet{display:grid;grid-template-columns:repeat(3,70mm);grid-auto-rows:37mm}`:`@page{size:${dims[0]}mm ${dims[1]}mm;margin:0}`}
.l{width:${dims[0]}mm;height:${dims[1]}mm;padding:2mm 3mm;display:flex;flex-direction:column;justify-content:space-between;overflow:hidden;${a4?"":"page-break-after:always;break-after:page;"}}
.l svg{width:100%;height:${Math.round(dims[1]*.36)}mm;display:block}
.cell{font:700 ${Math.round(dims[1]*.22)}mm/1 Arial,sans-serif;text-align:center;letter-spacing:.5mm}
.nm{font-size:3.1mm;line-height:1.15;max-height:7.4mm;overflow:hidden}
.meta{display:flex;justify-content:space-between;gap:2mm;font-size:2.6mm}
.code{font:700 3mm/1 "Courier New",monospace;text-align:center}
.nobc{font-size:2.6mm;text-align:center;border:0.3mm dashed #000;padding:1mm}`;
  const body=labels.map(l=>{
    const bar=barcodeSvg(l.code)||`<div class="nobc">Штрихкод не печатается: в коде есть кириллица</div>`;
    if(l.kind==="cell")return`<div class="l"><div class="cell">${esc(l.code)}</div>${bar}<div class="meta"><span>Ячейка</span><span>Дело в коробке</span></div></div>`;
    return`<div class="l"><div class="nm">${esc(l.name||l.article)}</div><div class="meta"><b>${esc(l.article)}</b><span>${esc(l.client)}</span></div>${bar}<div class="code">${esc(l.code)}</div></div>`;
  }).join("");
  return`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Этикетки</title><style>${css}</style></head><body><div class="hint">Размер бумаги: ${a4?"A4, без полей":dims[0]+"×"+dims[1]+" мм"}, масштаб 100%.</div>${a4?`<div class="sheet">${body}</div>`:body}</body></html>`;
}
function outputLabels(labels,size,name,asFile){
  if(!labels.length){fail("Ничего не выбрано");return}
  if(typeof JsBarcode==="undefined")toast("Библиотека штрихкодов не загрузилась: на этикетках будет только текст",true);
  const html=labelDoc(labels,size);
  if(asFile)saveFile(`${name}-${today()}.html`,new Blob([html],{type:"text/html"}));else printHtml(html);
}

/* ======================================================
   ПРИЁМКА
   ====================================================== */
let rc=ls.get("rc")||{client:"",doc:"",cell:BUF,lines:[],unknown:null};
let rcLast=null;
const rcSave=()=>ls.set("rc",rc);
function rcFind(code){const raw=String(code).trim(),n=norm(code);return rc.lines.find(l=>norm(l.article)===n||(l.barcode&&l.barcode===raw))}
function rcAdd(it,q,barcode){
  let l=rc.lines.find(x=>norm(x.article)===norm(it.article));
  if(!l){l={article:it.article,name:it.name||"",barcode:barcode||"",expected:null,got:0};rc.lines.push(l)}
  if(barcode&&!l.barcode)l.barcode=barcode;
  l.got+=q;rc.last=l.article;rcSave();
  if(l.expected!=null&&l.got>l.expected){beep(false);toast(`${l.article}: принято ${l.got}, ожидалось ${l.expected}`,true)}else okb();
  renderRc();
}
function rcScan(code){
  const q=Math.max(1,parseInt($("rcQty").value,10)||1);
  rc.client=$("rcClient").value.trim();
  const r=resolve(code);
  if(r.type==="cell"){rc.cell=r.cell;$("rcCell").value=r.cell;rcSave();okb("Принимаем в ячейку "+r.cell);return}
  for(const c of [code,fixLayout(code)]){const l=rcFind(c);if(l){rcAdd(l,q,/^\d{8,}$/.test(c)?c:"");return}}
  if(r.type==="item"){
    let items=r.items;
    if(rc.client)items=items.filter(i=>norm(i.client)===norm(rc.client));
    else{const cs=[...new Set(items.map(i=>i.client))];if(cs.length===1){rc.client=cs[0];$("rcClient").value=cs[0]}else{fail("Этот товар есть у нескольких клиентов. Укажите клиента.");return}}
    if(items.length){rcAdd(items[0],q,"");return}
  }
  rc.unknown={code:r.code,qty:q};rcSave();beep(false);renderRc();
  if(!$("camOv").hidden)closeCam();
  setTimeout(()=>{const a=$("rcNewArt");a&&a.focus()},0);
}
function renderRc(){
  if(document.activeElement!==$("rcClient"))$("rcClient").value=rc.client||"";
  if(document.activeElement!==$("rcDoc"))$("rcDoc").value=rc.doc||"";
  if(document.activeElement!==$("rcCell"))$("rcCell").value=rc.cell||BUF;
  const u=$("rcUnknown");
  if(rc.unknown){u.hidden=false;u.innerHTML=`<div class="notice warn">Код <b class="mono">${esc(rc.unknown.code)}</b> не найден в справочнике. Привяжите его к артикулу, и дальше товар будет узнаваться по скану.</div>
    <div class="row"><label class="f">Артикул<input id="rcNewArt" value="${/^\d{8,}$/.test(rc.unknown.code)?"":esc(rc.unknown.code)}"></label><label class="f">Наименование<input id="rcNewName"></label>
    <button class="btn primary" id="rcBind" type="button" style="align-self:flex-end">Привязать и принять ${rc.unknown.qty} шт.</button><button class="btn ghost" id="rcSkip" type="button" style="align-self:flex-end">Пропустить</button></div>`}
  else{u.hidden=true;u.innerHTML=""}
  const box=$("rcTable");
  const has=rc.lines.length>0;
  const got=rc.lines.reduce((a,l)=>a+l.got,0),exp=rc.lines.reduce((a,l)=>a+(l.expected||0),0);
  $("rcState").textContent=has?`Принято ${got}${exp?" из "+exp:""} шт.`:"Новая";
  $("rcState").className="chip"+(has?(exp&&got===exp?" ok":" info"):"");
  const c=$("rcCommit");c.disabled=!rc.lines.some(l=>l.got>0);
  c.textContent=c.dataset.confirm?`Подтвердить: ${got} шт. в ${rc.cell||BUF}`:"Завершить приёмку";c.classList.toggle("danger",!!c.dataset.confirm);c.classList.toggle("primary",!c.dataset.confirm);
  renderRcHist();
  if(!has){box.innerHTML=`<div class="empty"><b>Сканируйте товар из коробки</b>Каждый скан добавляет указанное количество. Можно ввести артикул вручную и нажать OK.</div>`;return}
  const lines=[...rc.lines].sort((a,b)=>(a.article===rc.last?-1:b.article===rc.last?1:0));
  box.innerHTML=`<div class="table-wrap"><table><thead><tr><th>Артикул</th><th>Наименование</th><th class="num">Ожидалось</th><th class="num">Принято</th><th>Статус</th></tr></thead><tbody>${lines.map(l=>{
    const i=rc.lines.indexOf(l);let st;
    if(l.expected==null)st=`<span class="chip warn">нет в списке</span>`;
    else if(l.got===l.expected)st=`<span class="chip ok">сходится</span>`;
    else if(l.got>l.expected)st=`<span class="chip bad">излишек ${l.got-l.expected}</span>`;
    else st=`<span class="chip${l.got?" warn":""}">недостача ${l.expected-l.got}</span>`;
    return`<tr data-i="${i}"${l.article===rc.last?' class="hl"':""}><td class="mono wrap-any">${esc(l.article)}${l.barcode?`<br><span class="hint">${esc(l.barcode)}</span>`:""}</td><td>${esc(l.name)}</td><td class="num mono">${l.expected??"—"}</td>
    <td class="num"><span class="stepper"><button type="button" data-d="-1" aria-label="Минус один">−</button><span>${l.got}</span><button type="button" data-d="1" aria-label="Плюс один">+</button></span></td><td>${st}</td></tr>`}).join("")}</tbody></table></div>`;
}
function renderRcHist(){
  const box=$("rcHist");
  if(!D.receipts.length){box.innerHTML=`<p class="hint">Здесь появятся проведённые приёмки. По каждой можно скачать акт.</p>`;return}
  box.innerHTML=D.receipts.slice(0,15).map((r,i)=>{const got=r.lines.reduce((a,l)=>a+(l.got||0),0);const diff=rcDiff(r.lines);
    return`<div><span><b>${esc(r.client)}</b>${r.doc?" · "+esc(r.doc):""}<br><span class="hint">${fmtTs(r.ts)} · ${got} шт. · ${esc(r.user_name||"")}${diff?` · <span class="chip warn">расхождений ${diff}</span>`:""}</span></span><button class="btn sm" type="button" data-act="${i}">Акт</button></div>`}).join("");
}
function downloadAct(L){
  saveXlsx(`akt-priemki-${(L.ts||"").slice(0,10)||today()}${L.doc?"-"+L.doc.replace(/[^\wа-яё-]+/gi,"_").slice(0,40):""}.xlsx`,[["Акт приёмки товара","","","","",""],["Клиент",L.client],["Документ",L.doc||""],["Дата",fmtTs(L.ts)],["Ячейка",L.cell||""],["Принял",L.user_name||""],[],
    ["Артикул","Наименование","Штрихкод","Ожидалось","Принято","Расхождение"],
    ...L.lines.map(l=>[l.article,l.name,l.barcode||"",l.expected??"",l.got,l.expected==null?"нет в списке":l.got-l.expected])],"Акт");
}
$("rcHist").addEventListener("click",e=>{const b=e.target.closest("[data-act]");if(b)downloadAct(D.receipts[+b.dataset.act])});
$("rcUnknown").addEventListener("click",e=>{
  if(e.target.id==="rcSkip"){rc.unknown=null;rcSave();renderRc();$("rcScan").focus();return}
  if(e.target.id!=="rcBind")return;
  const art=$("rcNewArt").value.trim(),name=$("rcNewName").value.trim();
  rc.client=$("rcClient").value.trim();
  if(!rc.client){fail("Сначала укажите клиента");$("rcClient").focus();return}
  if(!art){fail("Укажите артикул");return}
  const code=rc.unknown.code,q=rc.unknown.qty;const isBc=code!==art;
  rc.unknown=null;rcAdd({article:art,name},q,isBc?code:"");$("rcScan").focus();
});
$("rcTable").addEventListener("click",e=>{const b=e.target.closest("[data-d]");if(!b)return;const l=rc.lines[+b.closest("tr").dataset.i];l.got=Math.max(0,l.got+(+b.dataset.d));
  if(!l.got&&l.expected==null)rc.lines.splice(rc.lines.indexOf(l),1);delete $("rcCommit").dataset.confirm;rcSave();renderRc()});
["rcClient","rcDoc"].forEach(id=>$(id).addEventListener("change",()=>{rc.client=$("rcClient").value.trim();rc.doc=$("rcDoc").value.trim();rcSave()}));
$("rcCell").addEventListener("change",()=>{rc.cell=normCell(fixLayout($("rcCell").value))||BUF;rcSave();renderRc()});
bindScan("rcScan","rcGo",rcScan);
$("rcFile").addEventListener("change",async e=>{
  const file=e.target.files[0];e.target.value="";if(!file)return;
  try{const m=await readMatrix(file);const d=detect(m,["art"]);
    if(d.cols.art<0){fail("Не нашёл столбец с артикулом");return}
    let n=0;
    for(let r=d.hdr+1;r<m.length;r++){const row=m[r]||[];const art=cellv(row,d.cols.art);if(!art)continue;
      const q=d.cols.qty>=0?num(row[d.cols.qty]):1;if(!(q>0))continue;
      let l=rc.lines.find(x=>norm(x.article)===norm(art));
      if(!l){l={article:art,name:cellv(row,d.cols.name),barcode:cellv(row,d.cols.bc),expected:0,got:0};rc.lines.push(l)}
      l.expected=(l.expected||0)+Math.round(q);if(!l.barcode)l.barcode=cellv(row,d.cols.bc);n++}
    if(!rc.doc)rc.doc=file.name.replace(/\.[^.]+$/,"");
    rcSave();renderRc();okb(`Ожидаемых позиций: ${n}`);
  }catch(err){fail("Не удалось прочитать файл: "+(err.message||err))}
});
$("rcCommit").addEventListener("click",async()=>{
  const c=$("rcCommit");
  rc.client=$("rcClient").value.trim();rc.doc=$("rcDoc").value.trim();rc.cell=normCell(fixLayout($("rcCell").value))||BUF;
  if(!rc.client){fail("Укажите клиента");$("rcClient").focus();return}
  const sim=similarClient(rc.client);
  if(sim&&c.dataset.simFor!==rc.client){c.dataset.simFor=rc.client;$("rcClient").focus();
    fail(`Похоже на клиента «${sim}». Если это он, выберите его в поле «Клиент», иначе товар попадёт в отдельный кабинет. Нажмите ещё раз, чтобы принять как «${rc.client}».`);return}
  if(!c.dataset.confirm){c.dataset.confirm="1";renderRc();return}
  delete c.dataset.confirm;delete c.dataset.simFor;
  const body={client:rc.client,doc:rc.doc,cell:rc.cell,lines:rc.lines.map(l=>({article:l.article,name:l.name,barcode:l.barcode||"",expected:l.expected,got:l.got}))};
  const res=await run(c,"Сохраняю…",()=>api("POST","/api/receive",body));
  if(!res){renderRc();return}
  rcLast={...body,ts:new Date().toISOString(),user_name:me.name};
  const got=body.lines.reduce((a,l)=>a+l.got,0),short=rcDiff(body.lines);
  rc={client:"",doc:"",cell:BUF,lines:[],unknown:null};rcSave();
  await load(["stock","products","ops","receipts","cells"]);
  $("rcDone").hidden=false;$("rcDone").innerHTML=`<div class="notice ok">Принято ${got} шт. от ${esc(rcLast.client)} в ячейку ${esc(rcLast.cell)}.${short?` Расхождений с ожидаемым: ${short}.`:""}</div>
    <div class="row"><button class="btn" id="rcAct" type="button">Скачать акт приёмки</button><button class="btn ghost" id="rcToMv" type="button">Перейти к размещению</button></div>`;
  renderRc();okb("Приёмка проведена");
});
$("rcDone").addEventListener("click",e=>{
  if(e.target.id==="rcToMv"){mv.from=rcLast?rcLast.cell:BUF;mv.take={};mvSave();setTab("mv");return}
  if(e.target.id==="rcAct"&&rcLast)downloadAct(rcLast);
});
$("rcReset").addEventListener("click",e=>{const b=e.currentTarget;
  if(!b.dataset.confirm&&rc.lines.length){b.dataset.confirm="1";b.textContent="Точно сбросить?";b.classList.add("danger");setTimeout(()=>{delete b.dataset.confirm;b.textContent="Сбросить";b.classList.remove("danger")},3000);return}
  delete b.dataset.confirm;b.textContent="Сбросить";b.classList.remove("danger");
  rc={client:"",doc:"",cell:BUF,lines:[],unknown:null};rcSave();$("rcDone").hidden=true;renderRc()});

/* ======================================================
   РАЗМЕЩЕНИЕ / ПЕРЕМЕЩЕНИЕ
   ====================================================== */
let mv=ls.get("mv")||{from:BUF,to:"",take:{}};
const mvSave=()=>ls.set("mv",mv);
function mvRows(){const out=[];D.stock.forEach(r=>{if(r.cell===mv.from)out.push(r)});return out.sort((a,b)=>norm(a.article).localeCompare(norm(b.article),"ru"))}
function mvScan(code){
  const r=resolve(code);
  if(r.type==="cell"){
    if(r.cell===mv.from){fail("Это ячейка-источник. Отсканируйте ячейку назначения.");return}
    mv.to=r.cell;mvSave();renderMv();okb("Назначение: "+r.cell);return}
  if(r.type==="item"){
    const rows=mvRows();const arts=new Set(r.items.map(i=>norm(i.article)));
    const cand=rows.filter(x=>arts.has(norm(x.article)));
    const row=cand.find(x=>(mv.take[x.id]||0)<x.qty);
    if(!cand.length){fail(`Товара ${r.items[0].article} нет в ячейке ${mv.from}`);return}
    if(!row){fail(`Больше ${r.items[0].article} в ячейке ${mv.from} нет`);return}
    mv.take[row.id]=(mv.take[row.id]||0)+1;mv.last=row.id;mvSave();renderMv();okb();return}
  const c=normCell(fixLayout(code));
  if(/^[A-Z0-9]+([-._][A-Z0-9]+)+$/.test(c)){mv.to=c;mvSave();renderMv();toast(`Ячейки ${c} нет в списке. Она будет создана при перемещении.`);beep(true);return}
  fail("Код не распознан: "+code);
}
function renderMv(){
  if(document.activeElement!==$("mvFrom"))$("mvFrom").value=mv.from;
  if(document.activeElement!==$("mvTo"))$("mvTo").value=mv.to||"";
  const rows=mvRows();
  if(live)Object.keys(mv.take).forEach(id=>{const r=rows.find(x=>x.id===id);if(!r||!(mv.take[id]>0))delete mv.take[id];else if(mv.take[id]>r.qty)mv.take[id]=r.qty});
  $("mvTitle").innerHTML=`Товар в ячейке ${addrHtml(mv.from)}`;
  const total=Object.values(mv.take).reduce((a,b)=>a+b,0);
  const c=$("mvCommit");c.disabled=!total||!mv.to;
  c.textContent=mv.to?`Переместить ${total} шт. → ${mv.to}`:"Отсканируйте ячейку назначения";
  const box=$("mvTable");
  if(!rows.length){box.innerHTML=`<div class="empty"><b>Ячейка ${esc(mv.from)} пуста</b>${mv.from===BUF?"Всё принятое уже размещено.":"Укажите другую ячейку в поле «Откуда»."}</div>`;return}
  box.innerHTML=`<div class="table-wrap"><table><thead><tr><th>Артикул</th><th>Наименование</th><th>Клиент</th><th class="num">В ячейке</th><th class="num">Переместить</th></tr></thead><tbody>${rows.map(r=>`<tr data-id="${r.id}"${mv.last===r.id?' class="hl"':""}>
    <td class="mono wrap-any">${esc(r.article)}</td><td>${esc(r.name)}</td><td>${esc(r.client)}</td><td class="num mono">${r.qty}</td>
    <td class="num"><span class="stepper"><button type="button" data-d="-1" aria-label="Минус один">−</button><span>${mv.take[r.id]||0}</span><button type="button" data-d="1" aria-label="Плюс один">+</button></span> <button class="btn sm ghost" type="button" data-all>все</button></td></tr>`).join("")}</tbody></table></div>`;
}
$("mvTable").addEventListener("click",e=>{const tr=e.target.closest("tr[data-id]");if(!tr)return;const id=tr.dataset.id;const r=D.stock.get(id);if(!r)return;
  if(e.target.closest("[data-all]"))mv.take[id]=r.qty;
  const b=e.target.closest("[data-d]");if(b)mv.take[id]=Math.min(r.qty,Math.max(0,(mv.take[id]||0)+(+b.dataset.d)));
  mvSave();renderMv()});
$("mvAll").addEventListener("click",()=>{mvRows().forEach(r=>mv.take[r.id]=r.qty);mvSave();renderMv()});
$("mvFrom").addEventListener("change",()=>{mv.from=normCell(fixLayout($("mvFrom").value))||BUF;mv.take={};mvSave();renderMv()});
$("mvTo").addEventListener("change",()=>{mv.to=normCell(fixLayout($("mvTo").value));mvSave();renderMv()});
$("mvClear").addEventListener("click",()=>{mv={from:BUF,to:"",take:{}};mvSave();renderMv()});
bindScan("mvScan","mvGo",mvScan);
$("mvCommit").addEventListener("click",async()=>{
  const items=Object.entries(mv.take).filter(([,q])=>q>0).map(([id,qty])=>({id:+id,qty}));
  const to=mv.to;
  const res=await run($("mvCommit"),"Перемещаю…",()=>api("POST","/api/move",{from:mv.from,to,items}));
  if(!res){await load(["stock"]);renderMv();return}
  mv.take={};mv.to="";mvSave();await load(["stock","ops","cells"]);renderMv();
  okb(`Перемещено ${res.units} шт. в ${to}`);
});

/* ======================================================
   СБОРКА
   ====================================================== */
let files=[];
let plan=ls.get("plan");
function renderFiles(){
  const box=$("files");
  box.innerHTML=files.map((f,fi)=>{
    const hdr=f.matrix[f.hdr]||[];
    const opts=sel=>`<option value="-1"${sel<0?" selected":""}>— нет</option>`+hdr.map((h,i)=>`<option value="${i}"${i===sel?" selected":""}>${esc(h||("Столбец "+(i+1)))}</option>`).join("");
    const lines=pickLines(f).length;
    return `<div class="file"><div class="file-h"><b>${esc(f.name)}</b><span>${lines} строк к сборке</span></div>
      <div class="row">
        <label class="f">Артикул<select data-f="${fi}" data-k="art" id="f${fi}art">${opts(f.cols.art)}</select></label>
        <label class="f">Штрихкод<select data-f="${fi}" data-k="bc" id="f${fi}bc">${opts(f.cols.bc)}</select></label>
        <label class="f">Количество<select data-f="${fi}" data-k="qty" id="f${fi}qty">${opts(f.cols.qty)}</select></label>
        <label class="f">Наименование<select data-f="${fi}" data-k="name" id="f${fi}name">${opts(f.cols.name)}</select></label>
      </div>
      ${f.cols.art<0&&f.cols.bc<0?'<div class="notice warn">Не нашёл столбец с артикулом или штрихкодом. Выберите его вручную.</div>':""}
      <div class="row" style="justify-content:flex-end"><button class="btn sm ghost" data-rm="${fi}" type="button">Убрать файл</button></div></div>`;
  }).join("");
  const has=files.length>0;
  $("pickOpts").hidden=!has;$("pickActions").hidden=!has;
  $("buildRoute").disabled=!files.some(f=>f.cols.art>=0||f.cols.bc>=0);
  $("pickEmpty").hidden=has||!!plan;
  $("uploadPanel").hidden=!!plan;$("routePanel").hidden=!plan;
}
function pickLines(f){
  const out=[];if(f.cols.art<0&&f.cols.bc<0)return out;
  for(let r=f.hdr+1;r<f.matrix.length;r++){const row=f.matrix[r]||[];
    let art=cellv(row,f.cols.art);let name=cellv(row,f.cols.name);
    if(!art){const bc=cellv(row,f.cols.bc);if(!bc)continue;const it=findItems(bc)[0];art=it?it.article:bc;if(!name&&it)name=it.name}
    const q=f.cols.qty>=0?num(row[f.cols.qty]):1;if(!(q>0))continue;
    out.push({art,qty:Math.round(q),name});}
  return out;
}
$("files").addEventListener("change",e=>{const s=e.target.closest("select");if(!s)return;files[+s.dataset.f].cols[s.dataset.k]=+s.value;renderFiles()});
$("files").addEventListener("click",e=>{const b=e.target.closest("[data-rm]");if(!b)return;files.splice(+b.dataset.rm,1);renderFiles()});
async function addPickFiles(list){
  for(const file of list){
    try{const m=await readMatrix(file);let d=detect(m,["art"]);if(d.cols.art<0)d=detect(m,["bc"]);files.push({name:file.name,matrix:m,hdr:d.hdr,cols:{art:d.cols.art,bc:d.cols.bc,qty:d.cols.qty,name:d.cols.name}})}
    catch(err){fail("Не удалось прочитать "+file.name+": "+(err.message||err))}
  }
  renderFiles();renderClientSelects();
}
$("pickFile").addEventListener("change",e=>{addPickFiles([...e.target.files]);e.target.value=""});
const drop=$("drop");
["dragenter","dragover"].forEach(t=>drop.addEventListener(t,e=>{e.preventDefault();drop.classList.add("over")}));
["dragleave","drop"].forEach(t=>drop.addEventListener(t,e=>{e.preventDefault();drop.classList.remove("over")}));
drop.addEventListener("drop",e=>{if(e.dataTransfer.files.length)addPickFiles([...e.dataTransfer.files])});
$("clearFiles").addEventListener("click",()=>{files=[];renderFiles()});

function buildPlan(){
  const need=new Map();
  files.forEach(f=>pickLines(f).forEach(l=>{const k=norm(l.art);const cur=need.get(k)||{art:l.art,qty:0,name:l.name};cur.qty+=l.qty;if(!cur.name)cur.name=l.name;need.set(k,cur)}));
  const client=$("pickClient").value;
  const byArt=new Map(),inBuf=new Map();
  D.stock.forEach(r=>{if(!(r.qty>0))return;if(client&&norm(r.client)!==norm(client))return;const k=norm(r.article);
    if(r.cell===BUF){inBuf.set(k,(inBuf.get(k)||0)+r.qty);return}
    if(!byArt.has(k))byArt.set(k,[]);byArt.get(k).push(r)});
  const snake=$("snake").checked;
  const stops=[],short=[],multiClient=[];
  need.forEach((n,k)=>{
    let cands=byArt.get(k)||[];
    if(!client){const cs=new Set(cands.map(c=>norm(c.client)));if(cs.size>1)multiClient.push(n.art)}
    cands=routeSort(cands,snake);
    let left=n.qty;const single=cands.find(c=>c.qty>=left);
    const order=single?[single]:[...cands].sort((a,b)=>b.qty-a.qty);
    for(const c of order){if(left<=0)break;const take=Math.min(c.qty,left);stops.push({id:c.id,cell:c.cell,client:c.client,article:c.article,name:c.name||n.name,have:c.qty,take,picked:0});left-=take}
    if(left>0)short.push({art:n.art,name:n.name,need:n.qty,miss:left,buf:inBuf.get(k)||0});
  });
  return{stops:routeSort(stops,snake),short,multiClient,doc:files.map(f=>f.name).join(", ")};
}
const savePlan=()=>ls.set("plan",plan);
$("buildRoute").addEventListener("click",()=>{
  plan=buildPlan();
  if(!plan.stops.length&&!plan.short.length){fail("В файлах не нашлось строк с артикулами");plan=null;return}
  savePlan();renderFiles();renderPlan();
  if(plan.multiClient.length)toast("Артикулы есть у нескольких клиентов: "+plan.multiClient.slice(0,3).join(", ")+". Выберите клиента.",true);
  setTimeout(()=>$("pkScan").focus(),0);
});
function renderPlan(){
  if(!plan)return;
  const units=plan.stops.reduce((a,s)=>a+s.picked,0),need=plan.stops.reduce((a,s)=>a+s.take,0);
  $("routeTitle").textContent=`Маршрут: ${plan.stops.length} ${plural(plan.stops.length,"остановка","остановки","остановок")}`;
  $("routeCount").textContent=`собрано ${units} из ${need} шт.`;
  $("prog").style.width=need?(units/need*100)+"%":"0";
  $("stops").innerHTML=plan.stops.map((s,i)=>{const cls=s.picked>=s.take?" done":s.picked?" part":"";return`<li class="stop${cls}${plan.flash===i?" flash":""}" data-i="${i}" tabindex="0" role="checkbox" aria-checked="${s.picked>=s.take}">
    <span class="n">${i+1}</span>${addrHtml(s.cell,true)}
    <span class="what"><b>${esc(s.article)}</b><span>${esc(s.name||"")}${s.name?" · ":""}${esc(s.client||"")}</span></span>
    <span class="take"><b>${s.picked?s.picked+"/":""}${s.take}</b><span>из ${s.have} в ячейке</span></span></li>`}).join("");
  $("shortPanel").hidden=!plan.short.length;
  $("short").innerHTML=plan.short.map(s=>`<div><span><b>${esc(s.art)}</b>${s.name?" · "+esc(s.name):""}</span><span class="row" style="gap:6px">${s.buf?`<span class="chip warn">${s.buf} шт. не размещено</span>`:""}<span class="chip bad">не хватает ${s.miss} из ${s.need}</span></span></div>`).join("");
  const c=$("commit");c.disabled=!units;
  c.textContent=c.dataset.confirm?`Подтвердить списание (${units} шт.)`:`Списать собранное (${units} шт.)`;
  c.classList.toggle("danger",!!c.dataset.confirm);c.classList.toggle("primary",!c.dataset.confirm);
}
function toggleStop(el){const i=+el.dataset.i;const s=plan.stops[i];s.picked=s.picked>=s.take?0:s.take;delete $("commit").dataset.confirm;savePlan();renderPlan();const nx=$("stops").querySelector(`[data-i="${i}"]`);nx&&nx.focus({preventScroll:true})}
$("stops").addEventListener("click",e=>{const el=e.target.closest(".stop");if(el)toggleStop(el)});
$("stops").addEventListener("keydown",e=>{if((e.key===" "||e.key==="Enter")&&e.target.classList.contains("stop")){e.preventDefault();toggleStop(e.target)}});
function flashStop(i){plan.flash=i;renderPlan();const el=$("stops").querySelector(`[data-i="${i}"]`);el&&el.scrollIntoView({block:"center",behavior:"smooth"})}
function pkScan(code){
  if(!plan)return;
  const r=resolve(code);
  if(r.type==="cell"){const i=plan.stops.findIndex(s=>normCell(s.cell)===r.cell&&s.picked<s.take);
    if(i<0){fail(`В ячейке ${r.cell} сейчас ничего брать не нужно`);return}
    plan.atCell=r.cell;flashStop(i);okb();return}
  if(r.type==="item"){
    const arts=new Set(r.items.map(i=>norm(i.article)));
    let i=plan.stops.findIndex(s=>arts.has(norm(s.article))&&s.picked<s.take&&(!plan.atCell||normCell(s.cell)===plan.atCell));
    if(i<0)i=plan.stops.findIndex(s=>arts.has(norm(s.article))&&s.picked<s.take);
    if(i<0){fail(plan.stops.some(s=>arts.has(norm(s.article)))?`${r.items[0].article} уже собран полностью`:`${r.items[0].article} нет в этом листе подбора`);return}
    const s=plan.stops[i];
    if(plan.atCell&&normCell(s.cell)!==plan.atCell)toast(`Внимание: по маршруту этот товар в ячейке ${s.cell}`,true);
    s.picked++;delete $("commit").dataset.confirm;savePlan();flashStop(i);
    if(s.picked>=s.take)okb(`${s.article}: ячейка ${s.cell} собрана`);else beep(true);
    return}
  fail("Код не распознан: "+code);
}
bindScan("pkScan","pkGo",pkScan);
$("cancelRoute").addEventListener("click",()=>{plan=null;savePlan();renderFiles()});
$("commit").addEventListener("click",async()=>{
  const c=$("commit");
  if(!c.dataset.confirm){c.dataset.confirm="1";renderPlan();return}
  delete c.dataset.confirm;
  const take=new Map();plan.stops.filter(s=>s.picked>0).forEach(s=>take.set(s.id,(take.get(s.id)||0)+s.picked));
  const res=await run(c,"Списываю…",()=>api("POST","/api/pick",{doc:plan.doc,items:[...take].map(([id,qty])=>({id:+id,qty}))}));
  if(!res){await load(["stock"]);renderPlan();return}
  await load(["stock","ops"]);
  const left=plan.stops.filter(s=>s.picked<s.take).map(s=>({...s,take:s.take-s.picked,picked:0}));
  okb(`Списано ${res.units} шт.`);
  if(left.length){plan.stops=left.map(s=>{const r=D.stock.get(s.id);return{...s,have:r?r.qty:s.have}});plan.flash=null;savePlan();renderPlan()}
  else{plan=null;files=[];savePlan();renderFiles()}
});
function renderClientSelects(){
  const cl=clients();
  const fill=(id,first)=>{const el=$(id),prev=el.value;el.innerHTML=`<option value="">${first}</option>`+cl.map(c=>`<option${c===prev?" selected":""}>${esc(c)}</option>`).join("")};
  fill("pickClient","Все клиенты");fill("fClient","Все клиенты");fill("pfClient","Все клиенты");fill("lClient","Все клиенты");
  $("clientList").innerHTML=cl.map(c=>`<option value="${esc(c)}">`).join("");
}

/* ======================================================
   ИНВЕНТАРИЗАЦИЯ
   ====================================================== */
let inv=ls.get("inv")||{cell:"",lines:[],reveal:false};
const invSave=()=>ls.set("inv",inv);
function invLoad(cell){
  inv={cell,lines:[],reveal:false};
  D.stock.forEach(r=>{if(r.cell===cell)inv.lines.push({client:r.client,article:r.article,name:r.name,expected:r.qty,counted:0})});
  invSave();renderInv();
}
function invScan(code){
  const r=resolve(code);
  if(r.type==="cell"){
    if(inv.cell&&inv.cell!==r.cell&&inv.lines.some(l=>l.counted>0)){fail(`Сначала примените или сбросьте пересчёт ячейки ${inv.cell}`);return}
    invLoad(r.cell);okb("Пересчёт ячейки "+r.cell);return}
  if(!inv.cell){fail("Сначала отсканируйте ячейку");return}
  if(r.type==="item"){
    const arts=new Set(r.items.map(i=>norm(i.article)));
    let l=inv.lines.find(x=>arts.has(norm(x.article)));
    if(!l){const it=r.items[0];l={client:it.client,article:it.article,name:it.name,expected:0,counted:0};inv.lines.push(l);toast(`${it.article} не числится в ${inv.cell}. Добавлен как излишек.`,true)}
    l.counted++;inv.last=l.article;invSave();renderInv();beep(true);return}
  fail("Код не распознан: "+code);
}
function renderInv(){
  const blind=$("invBlind").checked&&!inv.reveal;
  $("invHead").innerHTML=inv.cell?`Ячейка ${addrHtml(inv.cell,true)} <span class="hint">${inv.lines.length} ${plural(inv.lines.length,"позиция","позиции","позиций")} · посчитано ${inv.lines.reduce((a,l)=>a+l.counted,0)} шт.</span>`:"";
  const has=!!inv.cell;
  $("invReveal").disabled=!has||!blind;$("invApply").disabled=!has;
  const a=$("invApply");a.textContent=a.dataset.confirm?"Подтвердить: записать факт в остатки":"Применить пересчёт";a.classList.toggle("danger",!!a.dataset.confirm);a.classList.toggle("primary",!a.dataset.confirm);
  const box=$("invTable");
  if(!has){box.innerHTML=`<div class="empty"><b>Отсканируйте этикетку ячейки</b>Затем сканируйте каждый товар в ней по одному. Пустую ячейку можно сразу применить.</div>`;return}
  if(!inv.lines.length){box.innerHTML=`<div class="empty"><b>По учёту ячейка пуста</b>Сканируйте товары, если они там есть.</div>`;return}
  box.innerHTML=`<div class="table-wrap"><table><thead><tr><th>Артикул</th><th>Наименование</th><th>Клиент</th>${blind?"":'<th class="num">Учёт</th>'}<th class="num">Факт</th>${blind?"":"<th>Расхождение</th>"}</tr></thead><tbody>${inv.lines.map((l,i)=>{
    const d=l.counted-l.expected;
    return`<tr data-i="${i}"${inv.last===l.article?' class="hl"':""}><td class="mono wrap-any">${esc(l.article)}</td><td>${esc(l.name)}</td><td>${esc(l.client)}</td>${blind?"":`<td class="num mono">${l.expected}</td>`}
    <td class="num"><span class="stepper"><button type="button" data-d="-1" aria-label="Минус один">−</button><span>${l.counted}</span><button type="button" data-d="1" aria-label="Плюс один">+</button></span></td>
    ${blind?"":`<td>${d===0?'<span class="chip ok">сходится</span>':d>0?`<span class="chip warn">излишек ${d}</span>`:`<span class="chip bad">недостача ${-d}</span>`}</td>`}</tr>`}).join("")}</tbody></table></div>`;
}
$("invTable").addEventListener("click",e=>{const b=e.target.closest("[data-d]");if(!b)return;const l=inv.lines[+b.closest("tr").dataset.i];l.counted=Math.max(0,l.counted+(+b.dataset.d));delete $("invApply").dataset.confirm;invSave();renderInv()});
$("invBlind").addEventListener("change",renderInv);
$("invReveal").addEventListener("click",()=>{inv.reveal=true;invSave();renderInv()});
$("invReset").addEventListener("click",()=>{inv={cell:"",lines:[],reveal:false};invSave();renderInv()});
bindScan("invScan","invGo",invScan);
$("invApply").addEventListener("click",async()=>{
  const a=$("invApply");
  if(!a.dataset.confirm){a.dataset.confirm="1";inv.reveal=true;renderInv();return}
  delete a.dataset.confirm;
  const cell=inv.cell;
  const res=await run(a,"Записываю…",()=>api("POST","/api/inventory",{cell,lines:inv.lines.map(l=>({client:l.client,article:l.article,name:l.name,counted:l.counted}))}));
  if(!res){renderInv();return}
  inv={cell:"",lines:[],reveal:false};invSave();await load(["stock","ops"]);renderInv();
  okb(res.changed?`Ячейка ${cell}: исправлено позиций ${res.changed}`:`Ячейка ${cell}: расхождений нет`);
});

/* ======================================================
   ОСТАТКИ
   ====================================================== */
let stockMode="cell",pendingDel=null;
$("addForm").addEventListener("submit",async e=>{
  e.preventDefault();
  const cell=normCell(fixLayout($("aCell").value)),client=$("aClient").value.trim(),art=$("aArt").value.trim(),name=$("aName").value.trim(),q=parseInt($("aQty").value,10);
  if(!cell||!art||!q)return;
  const res=await run(e.submitter,"Провожу…",()=>api("POST","/api/adjust",{mode:"delta",cell,client,article:art,name,delta:q}));
  if(!res)return;
  await load(["stock","ops","cells"]);
  okb(`${q>0?"Добавлено":"Списано"}: ${art} × ${Math.abs(q)} · ${cell}`);$("aArt").value="";$("aName").value="";$("aQty").value="1";$("aArt").focus();
});
function renderStock(){
  let units=0;const cells=new Set(),arts=new Set();let buf=0;
  D.stock.forEach(r=>{units+=r.qty;cells.add(r.cell);arts.add(pkey(r.client,r.article));if(r.cell===BUF)buf+=r.qty});
  $("stockKv").innerHTML=`<div><span>Единиц</span><b>${units}</b></div><div><span>Товаров</span><b>${arts.size}</b></div><div><span>Занято ячеек</span><b>${cells.size}</b></div><div><span>Не размещено</span><b>${buf}</b></div>`;
  const q=norm($("q").value),fc=$("fClient").value;
  let rows=[...D.stock.values()].filter(r=>(!fc||norm(r.client)===norm(fc))&&(!q||[r.cell,r.article,r.name,r.client].some(v=>norm(v).includes(q))));
  const box=$("stockTable");
  if(!D.stock.size){box.innerHTML=`<div class="empty"><b>${live?"Склад пока пуст":"Загружаю остатки…"}</b>${live?"Примите первую поставку или загрузите раскладку из Excel.":""}</div>`;return}
  if(!rows.length){box.innerHTML=`<div class="empty"><b>Ничего не найдено</b>Измените поиск или клиента.</div>`;return}
  if(stockMode==="art"){
    const g=new Map();rows.forEach(r=>{const k=pkey(r.client,r.article);const x=g.get(k)||{client:r.client,article:r.article,name:r.name,qty:0,cells:[]};x.qty+=r.qty;x.cells.push(r);g.set(k,x)});
    const list=[...g.values()].sort((a,b)=>norm(a.article).localeCompare(norm(b.article),"ru"));
    box.innerHTML=`<div class="table-wrap"><table><thead><tr><th>Артикул</th><th>Наименование</th><th>Клиент</th><th class="num">Всего</th><th>Где лежит</th></tr></thead><tbody>${list.map(x=>`<tr><td class="mono wrap-any">${esc(x.article)}</td><td>${esc(x.name)}</td><td>${esc(x.client)}</td><td class="num mono"><b>${x.qty}</b></td><td>${routeSort(x.cells,false).map(c=>`${addrHtml(c.cell)} <span class="mono">${c.qty}</span>`).join(" ")}</td></tr>`).join("")}</tbody></table></div>`;
    return;
  }
  rows=routeSort(rows,false);
  const w=isAdmin();
  const shown=rows.slice(0,1500);
  box.innerHTML=`<div class="table-wrap"><table><thead><tr><th>Ячейка</th><th>Артикул</th><th>Наименование</th><th>Клиент</th><th class="num">Кол-во</th>${w?"<th></th>":""}</tr></thead><tbody>${
    shown.map(r=>`<tr data-id="${r.id}"><td>${addrHtml(r.cell)}</td><td class="mono wrap-any">${esc(r.article)}</td><td>${esc(r.name)}</td><td>${esc(r.client)}</td>
    <td class="num">${w?`<input class="qty-in" type="number" min="0" value="${r.qty}" id="q_${r.id}" aria-label="Количество">`:`<span class="mono">${r.qty}</span>`}</td>
    ${w?`<td class="num"><button class="btn sm ${pendingDel===r.id?"danger":"ghost"}" data-del type="button">${pendingDel===r.id?"Точно убрать?":"Убрать"}</button></td>`:""}</tr>`).join("")
  }</tbody></table></div>${rows.length>shown.length?`<p class="hint">Показаны первые ${shown.length} из ${rows.length}. Уточните поиск.</p>`:""}`;
}
$("stockTable").addEventListener("change",async e=>{
  const inp=e.target.closest(".qty-in");if(!inp)return;const id=inp.closest("tr").dataset.id;const r=D.stock.get(id);if(!r)return;
  const v=parseInt(inp.value,10);if(!(v>=0)){inp.value=r.qty;return}
  const res=await run(null,"",()=>api("POST","/api/adjust",{mode:"set",id:+id,qty:v,note:"правка в остатках"}));
  await load(["stock","ops"]);if(res)okb(`${r.article} в ${r.cell}: ${v} шт.`);
});
$("stockTable").addEventListener("click",async e=>{
  const b=e.target.closest("[data-del]");if(!b)return;const id=b.closest("tr").dataset.id;const r=D.stock.get(id);if(!r)return;
  if(pendingDel!==id){pendingDel=id;renderStock();return}
  pendingDel=null;
  const res=await run(b,"…",()=>api("POST","/api/adjust",{mode:"delete",id:+id}));
  await load(["stock","ops"]);if(res)toast("Строка удалена");
});
$("q").addEventListener("input",renderStock);$("fClient").addEventListener("change",renderStock);
$("stockMode").addEventListener("click",e=>{const b=e.target.closest("[data-m]");if(!b)return;stockMode=b.dataset.m;[...$("stockMode").children].forEach(x=>x.setAttribute("aria-pressed",String(x===b)));renderStock()});
$("stockFile").addEventListener("change",async e=>{
  const file=e.target.files[0];e.target.value="";if(!file)return;const msg=$("importMsg");
  try{
    const m=await readMatrix(file);const d=detect(m,["cell","art"]);
    if(d.cols.cell<0||d.cols.art<0){msg.innerHTML=`<div class="notice bad">Не нашёл столбцы «Ячейка» и «Артикул». Скачайте шаблон и заполните по нему.</div>`;return}
    const rows=[];let bad=0;
    for(let r=d.hdr+1;r<m.length;r++){const row=m[r]||[];const cell=normCell(row[d.cols.cell]),art=cellv(row,d.cols.art);
      if(!cell&&!art)continue;
      const q=d.cols.qty>=0?num(row[d.cols.qty]):1;
      if(!cell||!art||!(q>0)){bad++;continue}
      rows.push({cell,client:cellv(row,d.cols.client),article:art,name:cellv(row,d.cols.name),qty:Math.round(q),barcode:cellv(row,d.cols.bc)})}
    msg.innerHTML=`<div class="notice warn">Загружаю ${rows.length} строк…</div>`;
    const res=await api("POST","/api/import-stock",{file:file.name,rows});
    await load(["stock","products","ops","cells"]);
    msg.innerHTML=`<div class="notice ok">Добавлено строк: ${res.ok}, единиц: ${res.units}${bad?`. Пропущено (нет ячейки, артикула или количества): ${bad}`:""}${res.skippedBc?`. Штрихкодов пропущено (уже заняты другими товарами): ${res.skippedBc}`:""}.</div>`;
  }catch(err){msg.innerHTML=`<div class="notice bad">${esc(err.message||err)}</div>`}
});
$("tplBtn").addEventListener("click",()=>saveXlsx("raskladka-shablon.xlsx",[["Ячейка","Клиент","Артикул","Наименование","Количество","Штрихкод"],["A-01-1-01","ИП Пример","ART-001","Пример товара",10,"4600000000001"]],"Раскладка"));
$("exportBtn").addEventListener("click",()=>{const rows=routeSort([...D.stock.values()],false);
  saveXlsx(`ostatki-${today()}.xlsx`,[["Ячейка","Клиент","Артикул","Наименование","Количество"],...rows.map(r=>[r.cell,r.client,r.article,r.name,r.qty])],"Остатки")});

/* ======================================================
   ТОВАРЫ
   ====================================================== */
const pSel=new Set();
function prodRows(){
  const q=norm($("pq").value),fc=$("pfClient").value;const tot=new Map();
  D.stock.forEach(r=>{const k=pkey(r.client,r.article);tot.set(k,(tot.get(k)||0)+r.qty)});
  return[...D.products.values()].map(p=>({...p,total:tot.get(pkey(p.client,p.article))||0}))
    .filter(p=>(!fc||norm(p.client)===norm(fc))&&(!q||[p.article,p.name,p.client,...(p.barcodes||[])].some(v=>norm(v).includes(q))))
    .sort((a,b)=>norm(a.article).localeCompare(norm(b.article),"ru"));
}
function renderProd(){
  const rows=prodRows();const box=$("pTable");
  [...pSel].forEach(id=>{if(!D.products.has(id))pSel.delete(id)});
  $("pLabels").disabled=$("pLabelsFile").disabled=!pSel.size;$("pLabels").textContent=pSel.size?`Печать этикеток (${pSel.size})`:"Печать этикеток";
  let missing=0;const seen=new Set();D.stock.forEach(r=>{const k=pkey(r.client,r.article);if(!D.pidx.has(k)&&!seen.has(k)){seen.add(k);missing++}});
  $("pFromStock").textContent=missing?`Создать из остатков (${missing})`:"Создать из остатков";$("pFromStock").disabled=!missing;
  if(!D.products.size){box.innerHTML=`<div class="empty"><b>Справочник пуст</b>Карточки создаются сами при приёмке. Можно загрузить их из Excel или создать из текущих остатков.</div>`;return}
  if(!rows.length){box.innerHTML=`<div class="empty"><b>Ничего не найдено</b>Измените поиск или клиента.</div>`;return}
  const shown=rows.slice(0,1500);
  box.innerHTML=`<div class="table-wrap"><table><thead><tr><th></th><th>Артикул</th><th>Наименование</th><th>Клиент</th><th>Штрихкоды</th><th class="num">Остаток</th><th></th></tr></thead><tbody>${shown.map(p=>`<tr data-id="${p.id}">
    <td><input type="checkbox" id="ps_${p.id}" ${pSel.has(p.id)?"checked":""} aria-label="Выбрать для этикеток" style="width:20px;min-height:0"></td>
    <td class="mono wrap-any">${esc(p.article)}</td><td>${esc(p.name)}</td><td>${esc(p.client)}</td>
    <td class="mono wrap-any">${(p.barcodes||[]).map(esc).join("<br>")||'<span class="chip warn">нет</span>'}</td><td class="num mono">${p.total}</td>
    <td class="num"><button class="btn sm ghost" data-edit type="button">Изменить</button></td></tr>`).join("")}</tbody></table></div>${rows.length>shown.length?`<p class="hint">Показаны первые ${shown.length} из ${rows.length}. Уточните поиск.</p>`:""}`;
}
$("pTable").addEventListener("change",e=>{const cb=e.target.closest("input[type=checkbox]");if(!cb)return;const id=cb.closest("tr").dataset.id;cb.checked?pSel.add(id):pSel.delete(id);renderProd()});
$("pTable").addEventListener("click",e=>{if(!e.target.closest("[data-edit]"))return;const p=D.products.get(e.target.closest("tr").dataset.id);if(!p)return;
  $("pClient").value=p.client;$("pArt").value=p.article;$("pName").value=p.name||"";$("pBc").value=(p.barcodes||[]).join(", ");$("pName").focus();window.scrollTo({top:0,behavior:"smooth"})});
$("pSelAll").addEventListener("change",e=>{prodRows().forEach(p=>e.target.checked?pSel.add(p.id):pSel.delete(p.id));renderProd()});
$("pq").addEventListener("input",renderProd);$("pfClient").addEventListener("change",renderProd);
$("pForm").addEventListener("submit",async e=>{
  e.preventDefault();
  const client=$("pClient").value.trim(),art=$("pArt").value.trim();if(!client||!art)return;
  const res=await run(e.submitter,"Сохраняю…",()=>api("POST","/api/products",{client,article:art,name:$("pName").value.trim(),barcodes:$("pBc").value}));
  if(!res)return;
  await load(["products"]);okb("Карточка сохранена");["pArt","pName","pBc"].forEach(id=>$(id).value="");$("pArt").focus();
});
$("pFromStock").addEventListener("click",async e=>{
  const res=await run(e.currentTarget,"Создаю…",()=>api("POST","/api/products/from-stock",{}));
  if(res){await load(["products"]);okb(`Создано карточек: ${res.ok}`)}
});
$("pTpl").addEventListener("click",()=>saveXlsx("tovary-shablon.xlsx",[["Клиент","Артикул","Наименование","Штрихкод"],["ИП Пример","ART-001","Пример товара","4600000000001"]],"Товары"));
$("pFile").addEventListener("change",async e=>{
  const file=e.target.files[0];e.target.value="";if(!file)return;
  const msg=$("pMsg");
  try{const m=await readMatrix(file);const d=detect(m,["art"]);
    if(d.cols.art<0){msg.innerHTML=`<div class="notice bad">Не нашёл столбец «Артикул».</div>`;return}
    const def=$("pfClient").value;let skip=0;
    const rows=[];for(let r=d.hdr+1;r<m.length;r++){const row=m[r]||[];const art=cellv(row,d.cols.art);if(!art)continue;const client=cellv(row,d.cols.client)||def;if(!client){skip++;continue}rows.push({client,article:art,name:cellv(row,d.cols.name),barcode:cellv(row,d.cols.bc)})}
    msg.innerHTML=`<div class="notice warn">Загружаю ${rows.length} карточек…</div>`;
    const res=await api("POST","/api/products/bulk",{rows});
    await load(["products"]);
    msg.innerHTML=`<div class="notice ok">Загружено карточек: ${res.ok}${skip?`. Пропущено без клиента: ${skip} (добавьте столбец «Клиент» или выберите клиента в фильтре)`:""}${res.skippedBc?`. Штрихкодов пропущено (уже заняты другими товарами): ${res.skippedBc}`:""}.</div>`;
  }catch(err){msg.innerHTML=`<div class="notice bad">${esc(err.message||err)}</div>`}
});
function productLabels(){
  const n=Math.max(1,Math.min(500,parseInt($("pCopies").value,10)||1));const labels=[];
  [...pSel].forEach(id=>{const p=D.products.get(id);if(!p)return;const code=(p.barcodes||[])[0]||p.article;for(let i=0;i<n;i++)labels.push({kind:"item",code,article:p.article,name:p.name,client:p.client})});
  return labels;
}
$("pLabels").addEventListener("click",()=>outputLabels(productLabels(),$("pSize").value,"etiketki-tovary",false));
$("pLabelsFile").addEventListener("click",()=>outputLabels(productLabels(),$("pSize").value,"etiketki-tovary",true));

/* ======================================================
   ЯЧЕЙКИ
   ====================================================== */
const cSel=new Set();
function genList(){
  const z=normCell(fixLayout($("gZone").value))||"A";const r1=+$("gR1").value||1,r2=Math.max(r1,+$("gR2").value||r1),t=Math.max(1,+$("gT").value||1),p=Math.max(1,+$("gP").value||1);
  const out=[];for(let r=r1;r<=r2;r++)for(let ti=1;ti<=t;ti++)for(let pi=1;pi<=p;pi++)out.push(`${z}-${String(r).padStart(2,"0")}-${ti}-${String(pi).padStart(2,"0")}`);
  return out;
}
function renderGenPreview(){const l=genList();$("gPreview").innerHTML=l.length?`${l.length} ${plural(l.length,"ячейка","ячейки","ячеек")}: ${addrHtml(l[0])} … ${addrHtml(l[l.length-1])}`:""}
["gZone","gR1","gR2","gT","gP"].forEach(id=>$(id).addEventListener("input",renderGenPreview));
$("gCreate").addEventListener("click",async e=>{
  const l=genList().filter(c=>!D.cells.has(c));
  if(!l.length){toast("Все эти ячейки уже есть");return}
  if(l.length>5000){fail("Слишком много за раз. Создайте не больше 5000 ячеек.");return}
  const res=await run(e.currentTarget,"Создаю…",()=>api("POST","/api/cells",{cells:l}));
  if(res){await load(["cells"]);okb(`Создано ячеек: ${l.length}`)}
});
function cellRows(){
  const q=normCell($("cq").value),f=$("cFilter").value;
  let rows=[...allCells().values()].filter(c=>c.cell!==BUF||c.items);
  rows=rows.filter(c=>(!q||c.cell.includes(q))&&(!f||(f==="empty"?!c.items:c.items>0)));
  return routeSort(rows,false);
}
function renderCells(){
  renderGenPreview();
  const rows=cellRows();const box=$("cTable");const all=allCells();
  [...cSel].forEach(c=>{if(!all.has(c))cSel.delete(c)});
  $("cLabels").disabled=$("cLabelsFile").disabled=!cSel.size;$("cLabels").textContent=cSel.size?`Печать этикеток (${cSel.size})`:"Печать этикеток";
  const emptySel=[...cSel].filter(c=>{const x=all.get(c);return x&&x.doc&&!x.items});
  $("cDel").disabled=!emptySel.length;$("cDel").textContent=$("cDel").dataset.confirm?`Точно удалить ${emptySel.length}?`:"Удалить пустые";
  if(!rows.length){box.innerHTML=`<div class="empty"><b>Ячеек пока нет</b>Создайте их генератором выше. Ячейки из остатков появятся здесь сами.</div>`;return}
  const shown=rows.slice(0,600);
  box.innerHTML=`<div class="table-wrap"><table><thead><tr><th></th><th>Ячейка</th><th class="num">Позиций</th><th class="num">Единиц</th><th>Состояние</th></tr></thead><tbody>${shown.map(c=>`<tr data-c="${esc(c.cell)}">
    <td><input type="checkbox" id="cs_${esc(c.cell)}" ${cSel.has(c.cell)?"checked":""} aria-label="Выбрать" style="width:20px;min-height:0"></td><td>${addrHtml(c.cell)}</td>
    <td class="num mono">${c.items}</td><td class="num mono">${c.units}</td><td>${c.items?'<span class="chip info">занята</span>':'<span class="chip">пустая</span>'}${c.doc?"":' <span class="chip warn">нет в списке</span>'}</td></tr>`).join("")}</tbody></table></div>${rows.length>600?`<p class="hint">Показаны первые 600 из ${rows.length}. Уточните поиск.</p>`:""}`;
}
$("cTable").addEventListener("change",e=>{const cb=e.target.closest("input[type=checkbox]");if(!cb)return;const c=cb.closest("tr").dataset.c;cb.checked?cSel.add(c):cSel.delete(c);renderCells()});
$("cSelAll").addEventListener("change",e=>{cellRows().forEach(c=>e.target.checked?cSel.add(c.cell):cSel.delete(c.cell));renderCells()});
$("cq").addEventListener("input",renderCells);$("cFilter").addEventListener("change",renderCells);
const cellLabels=()=>routeSort([...cSel].map(c=>({cell:c})),false).map(x=>({kind:"cell",code:x.cell}));
$("cLabels").addEventListener("click",()=>outputLabels(cellLabels(),$("cSize").value,"etiketki-yacheyki",false));
$("cLabelsFile").addEventListener("click",()=>outputLabels(cellLabels(),$("cSize").value,"etiketki-yacheyki",true));
$("cDel").addEventListener("click",async()=>{
  const b=$("cDel");if(!b.dataset.confirm){b.dataset.confirm="1";renderCells();setTimeout(()=>{delete b.dataset.confirm;renderCells()},3000);return}
  delete b.dataset.confirm;const all=allCells();
  const list=[...cSel].filter(c=>{const x=all.get(c);return x&&x.doc&&!x.items});
  const res=await run(b,"Удаляю…",()=>api("POST","/api/cells/delete",{cells:list}));
  if(res){list.forEach(c=>cSel.delete(c));await load(["cells"]);okb(`Удалено ячеек: ${res.ok}`)}
});

/* ======================================================
   ЖУРНАЛ
   ====================================================== */
const OPN={receive:"Приёмка",putaway:"Размещение",move:"Перемещение",pick:"Сборка",inventory:"Инвентаризация",adjust:"Корректировка"};
const OPC={receive:"ok",putaway:"info",move:"info",pick:"warn",inventory:"bad",adjust:""};
function logRows(){
  const q=norm($("lq").value),t=$("lType").value,c=$("lClient").value;
  return D.ops.filter(o=>(!t||o.type===t)&&(!c||norm(o.client)===norm(c))&&(!q||[o.article,o.name,o.cell,o.from_cell,o.doc,o.note,o.user_name].some(v=>norm(v).includes(q))));
}
function renderLog(){
  const rows=logRows();const box=$("lTable");
  if(!D.ops.length){box.innerHTML=`<div class="empty"><b>Операций пока нет</b>Здесь появится каждая приёмка, перемещение, сборка, пересчёт и корректировка с временем и сотрудником.</div>`;return}
  if(!rows.length){box.innerHTML=`<div class="empty"><b>Ничего не найдено</b>Измените фильтры.</div>`;return}
  box.innerHTML=`<div class="table-wrap"><table><thead><tr><th>Когда</th><th>Операция</th><th>Артикул</th><th>Клиент</th><th>Ячейка</th><th class="num">Кол-во</th><th>Кто / документ</th></tr></thead><tbody>${rows.map(o=>`<tr>
    <td class="mono" style="white-space:nowrap">${fmtTs(o.ts)}</td><td><span class="chip ${OPC[o.type]||""}">${OPN[o.type]||esc(o.type)}</span></td>
    <td class="wrap-any"><span class="mono">${esc(o.article)}</span>${o.name?`<br><span class="hint">${esc(o.name)}</span>`:""}</td><td>${esc(o.client)}</td>
    <td style="white-space:nowrap">${o.from_cell?addrHtml(o.from_cell)+" → ":""}${o.cell?addrHtml(o.cell):""}</td>
    <td class="num mono">${o.qty>0&&(o.type==="inventory"||o.type==="adjust")?"+":""}${o.qty}</td>
    <td class="wrap-any"><b>${esc(o.user_name||"")}</b>${o.doc||o.note?`<br><span class="hint">${esc(o.doc||o.note)}</span>`:""}</td></tr>`).join("")}</tbody></table></div>`;
}
$("lq").addEventListener("input",renderLog);["lType","lClient"].forEach(id=>$(id).addEventListener("change",renderLog));
$("lExport").addEventListener("click",()=>saveXlsx(`zhurnal-${today()}.xlsx`,[["Дата","Операция","Клиент","Артикул","Наименование","Откуда","Куда / ячейка","Количество","Сотрудник","Документ","Примечание"],
  ...logRows().map(o=>[fmtTs(o.ts),OPN[o.type]||o.type,o.client,o.article,o.name,o.from_cell,o.cell,o.qty,o.user_name||"",o.doc,o.note])],"Журнал"));

/* ======================================================
   УПРАВЛЕНИЕ (администратор)
   ====================================================== */
let users=[];
async function loadUsers(){try{users=(await api("GET","/api/users")).users;renderUsers()}catch(e){fail(e.message)}}
function renderUsers(){
  const box=$("uTable");
  $("appVersion").textContent=appVersion?`Версия приложения ${appVersion}`:"";
  const pv=$("pvClient"),prev=pv.value;pv.innerHTML=clients().map(c=>`<option${c===prev?" selected":""}>${esc(c)}</option>`).join("")||`<option value="">Клиентов пока нет</option>`;
  $("pvOpen").disabled=!clients().length;
  if(!users.length){box.innerHTML=`<p class="hint">Загружаю…</p>`;return}
  const known=new Set(clients().map(norm));
  const roleSel=(u,val)=>`<select data-role id="ur_${u.id}" style="width:auto;min-height:36px;padding:4px 8px">${[["worker","Кладовщик"],["admin","Администратор"],["client","Клиент"]].map(([v,t])=>`<option value="${v}"${val===v?" selected":""}>${t}</option>`).join("")}</select>`;
  box.innerHTML=`<div class="table-wrap"><table><thead><tr><th>Имя</th><th>Логин</th><th>Роль и компания</th><th>Был в сети</th><th>Новый пароль</th><th></th></tr></thead><tbody>${users.map(u=>{
    const asClient=u.role==="client"||pendingClient.has(u.id);
    const sim=asClient&&u.client&&!known.has(norm(u.client))?similarClient(u.client):null;
    return`<tr data-id="${u.id}"${u.active?"":' style="opacity:.55"'}>
    <td><b>${esc(u.name)}</b>${u.id===me.id?' <span class="chip info">это вы</span>':""}</td><td class="mono">${esc(u.login)}</td>
    <td><div class="row" style="gap:6px">${roleSel(u,asClient?"client":u.role)}${asClient?`<input data-client id="uc_${u.id}" list="clientList" value="${esc(u.client)}" placeholder="компания" style="min-width:170px;flex:1 1 170px;min-height:36px;padding:4px 8px"><button class="btn sm" data-saveclient type="button">Сохранить</button>`:""}</div>
    ${asClient&&u.client&&!known.has(norm(u.client))?`<span class="chip warn">${sim?`нет товаров с таким клиентом, похоже на «${esc(sim)}»`:"нет товаров с таким клиентом"}</span>`:""}</td>
    <td class="mono">${u.last_seen?fmtTs(u.last_seen):"—"}</td>
    <td><span class="row" style="flex-wrap:nowrap"><input id="up_${u.id}" placeholder="не короче 6" style="min-width:120px;min-height:36px;padding:4px 8px"><button class="btn sm" data-pass type="button">Сменить</button></span></td>
    <td class="num">${u.id===me.id?"":`<button class="btn sm ${u.active?"ghost":"primary"}" data-active type="button">${u.active?"Отключить":"Включить"}</button>`}</td></tr>`}).join("")}</tbody></table></div>`;
}
/* сотрудника переводят в клиенты в два шага: выбрать роль «Клиент», указать компанию, «Сохранить» */
const pendingClient=new Set();
async function updUser(body,msg){const res=await run(null,"",()=>api("POST","/api/users/update",body));if(res){pendingClient.delete(body.id);okb(msg);await loadUsers()}else renderUsers()}
$("uTable").addEventListener("change",e=>{
  const s=e.target.closest("select[data-role]");if(!s)return;const id=+s.closest("tr").dataset.id;const u=users.find(x=>x.id===id);
  if(s.value==="client"){if(u.role!=="client"){pendingClient.add(id);renderUsers();const i=$("uc_"+id);i&&i.focus()}return}
  pendingClient.delete(id);updUser({id,role:s.value},u.role==="client"?`${u.name} теперь сотрудник склада`:"Роль изменена");
});
$("uTable").addEventListener("click",e=>{
  const tr=e.target.closest("tr[data-id]");if(!tr)return;const id=+tr.dataset.id;const u=users.find(x=>x.id===id);
  if(e.target.closest("[data-saveclient]")){const v=$("uc_"+id).value.trim();if(!v){fail("Укажите компанию клиента");return}
    updUser({id,role:"client",client:v},u.role==="client"?`Компания для ${u.name}: ${v}`:`${u.name} теперь клиент «${v}»`);return}
  if(e.target.closest("[data-pass]")){const p=$("up_"+id).value;if(p.length<6){fail("Пароль должен быть не короче 6 символов");return}updUser({id,password:p},`Пароль для ${u.name} изменён`)}
  if(e.target.closest("[data-active]"))updUser({id,active:!u.active},u.active?`${u.name} отключён`:`${u.name} снова может входить`);
});
$("uRole").addEventListener("change",()=>{const c=$("uRole").value==="client";$("uClientWrap").hidden=!c;$("uClient").required=c;if(c)$("uClient").focus()});
$("uForm").addEventListener("submit",async e=>{
  e.preventDefault();
  const body={name:$("uName").value.trim(),login:$("uLogin").value.trim(),password:$("uPass").value,role:$("uRole").value,client:$("uClient").value.trim()};
  if(body.role==="client"&&!clients().some(c=>norm(c)===norm(body.client))&&!$("uForm").dataset.confirm){
    const sim=similarClient(body.client);
    $("uForm").dataset.confirm="1";fail(sim?`Клиента «${body.client}» на складе нет, но есть похожий: «${sim}». Выберите его из списка или нажмите «Добавить» ещё раз.`:`Товаров клиента «${body.client}» на складе пока нет. Проверьте написание или нажмите «Добавить» ещё раз.`);return}
  delete $("uForm").dataset.confirm;
  const res=await run(e.submitter,"Добавляю…",()=>api("POST","/api/users",body));
  if(res){okb(`${body.role==="client"?"Доступ клиенту":"Сотрудник"} добавлен. Логин: ${body.login.toLowerCase()}`);["uName","uLogin","uPass","uClient"].forEach(id=>$(id).value="");await loadUsers()}
});
$("uClient").addEventListener("input",()=>delete $("uForm").dataset.confirm);
$("pvOpen").addEventListener("click",()=>{const c=$("pvClient").value;if(c)showPortal(c)});
$("backupBtn").addEventListener("click",()=>{const a=document.createElement("a");a.href="/api/backup";a.download="";document.body.appendChild(a);a.click();a.remove()});

/* ======================================================
   КАБИНЕТ КЛИЕНТА
   ====================================================== */
const P={data:null,bill:null,client:"",preview:false,tab:"stock"};
const PT_TABS=["stock","rc","ops","bill","pass"];
const PT_OPN={receive:"Поступление",pick:"Отгрузка",inventory:"Инвентаризация",adjust:"Корректировка"};
const PT_OPC={receive:"ok",pick:"warn",inventory:"bad",adjust:""};
let ptLoading=null,ptAgain=false;
function ptOffline(){const s=$("ptStatus");s.textContent="Нет связи";s.classList.add("off");$("ptOffline").hidden=false;$("ptUpdated").textContent=P.data&&P.data.updated?`Последние данные на ${fmtTs(P.data.updated)}`:""}
async function loadPortal(){
  if(ptLoading){ptAgain=true;return ptLoading}
  ptLoading=(async()=>{
    try{const j=await api("GET","/api/my"+(P.preview?"?client="+encodeURIComponent(P.client):""));P.data=j;renderPortal();loadPtBill()}
    catch(e){if(me)ptOffline();if(me&&!P.data)toast(e.message,true)}
    finally{ptLoading=null;if(ptAgain){ptAgain=false;loadPortal()}}
  })();
  return ptLoading;
}
function showPortal(previewClient){
  mode="portal";P.data=null;P.bill=null;P.preview=!!previewClient;P.client=previewClient||(me&&me.client)||"";
  $("app").hidden=true;$("login").hidden=true;$("portal").hidden=false;
  $("ptWho").textContent=me.name;
  $("ptPreview").hidden=!P.preview;$("ptPreviewText").textContent=P.preview?`Так кабинет видит клиент «${P.client}»`:"";
  $("ptLogout").hidden=P.preview;$("ptPassTab").hidden=P.preview;
  $("ptClient").textContent=P.client;$("ptUpdated").textContent="";$("ptStatus").textContent="Загрузка…";
  ["ptStockTable","ptRcList","ptOpsTable","ptKv","ptBillList","ptChTable"].forEach(id=>$(id).innerHTML="");
  setPtTab(P.preview&&ls.get("ptTab")==="pass"?"stock":(ls.get("ptTab")||"stock"));
  window.scrollTo(0,0);
  loadPortal();
}
function setPtTab(name){
  if(!PT_TABS.includes(name)||(name==="pass"&&P.preview))name="stock";P.tab=name;ls.set("ptTab",name);
  [...$("ptTabs").children].forEach(b=>b.setAttribute("aria-selected",String(b.dataset.pt===name)));
  PT_TABS.forEach(n=>$("pt-"+n).hidden=n!==name);
  renderPortal();
  const b=$("ptTabs").querySelector(`[data-pt="${name}"]`);b&&b.scrollIntoView({inline:"nearest",block:"nearest"});
}
$("ptTabs").addEventListener("click",e=>{const b=e.target.closest("[data-pt]");if(b)setPtTab(b.dataset.pt)});
$("ptBack").addEventListener("click",()=>{mode="app";P.data=null;$("portal").hidden=true;$("app").hidden=false;setTab("users");load(ALL_PARTS)});
$("ptLogout").addEventListener("click",async()=>{try{await api("POST","/api/logout",{})}catch(e){}showLogin(false)});
/* сводка по артикулу: на складе (в ячейках) и в приёмке (ещё не разложено) */
function ptItems(){
  const d=P.data;if(!d)return[];
  const m=new Map();
  const get=(art,name)=>{const k=norm(art);let x=m.get(k);if(!x){x={article:art,name:name||"",barcode:"",stock:0,recv:0};m.set(k,x)}if(!x.name&&name)x.name=name;return x};
  d.products.forEach(p=>{const x=get(p.article,p.name);x.barcode=(p.barcodes||[])[0]||""});
  d.stock.forEach(s=>{const x=get(s.article,s.name);if(normCell(s.cell)===BUF)x.recv+=s.qty;else x.stock+=s.qty});
  return[...m.values()].sort((a,b)=>norm(a.article).localeCompare(norm(b.article),"ru"));
}
function renderPortal(){
  if(mode!=="portal")return;
  const d=P.data;
  if(!d){$("ptKv").innerHTML="";return}
  $("ptClient").textContent=d.client;
  let units=0;d.stock.forEach(s=>units+=s.qty);
  $("ptStatus").innerHTML=`<b>${units}</b> шт. на складе`;$("ptStatus").classList.remove("off");$("ptOffline").hidden=true;
  $("ptUpdated").textContent=d.updated?`Остатки на ${fmtTs(d.updated)}, обновляются сами`:"";
  ({stock:renderPtStock,rc:renderPtRc,ops:renderPtOps,bill:renderPtBill,pass:()=>{}})[P.tab]();
}
/* «Всего» = в ячейках + в приёмке; эту же цифру показывает шапка */
function ptStockRows(){
  const q=norm($("ptQ").value),zero=$("ptZero").checked;
  return ptItems().filter(x=>(zero||x.stock+x.recv>0)&&(!q||[x.article,x.name,x.barcode].some(v=>norm(v).includes(q))));
}
function renderPtStock(){
  const items=ptItems();
  const inStock=items.filter(x=>x.stock+x.recv>0);
  const placed=inStock.reduce((a,x)=>a+x.stock,0),recv=inStock.reduce((a,x)=>a+x.recv,0);
  $("ptKv").innerHTML=`<div><span>Всего на складе, шт.</span><b>${placed+recv}</b></div><div><span>Разложено по ячейкам</span><b>${placed}</b></div><div><span>Ещё в приёмке</span><b>${recv}</b></div><div><span>Артикулов в наличии</span><b>${inStock.length}</b></div>`;
  const rows=ptStockRows(),zero=$("ptZero").checked;
  const box=$("ptStockTable");
  if(!items.length){box.innerHTML=`<div class="empty"><b>Ваших товаров на складе пока нет</b>Остатки появятся здесь, как только склад примет первую поставку.</div>`;return}
  if(!rows.length){box.innerHTML=`<div class="empty"><b>Ничего не найдено</b>${zero?"Измените поиск.":"Измените поиск или включите показ товаров, которых нет в наличии."}</div>`;return}
  box.innerHTML=`<div class="table-wrap"><table class="pt-table"><thead><tr><th>Артикул</th><th class="num">Всего</th><th class="num">В приёмке</th><th>Наименование</th></tr></thead><tbody>${rows.map(x=>{const t=x.stock+x.recv;return`<tr>
    <td class="mono wrap-any">${esc(x.article)}</td>
    <td class="num mono">${t?`<b>${t}</b>`:'<span class="chip">нет в наличии</span>'}</td>
    <td class="num mono">${x.recv?`<span class="chip warn">${x.recv}</span>`:'<span class="qty-zero">—</span>'}</td>
    <td class="wrap-any">${esc(x.name)}${x.barcode?`<br><span class="hint mono">${esc(x.barcode)}</span>`:""}</td></tr>`}).join("")}</tbody></table></div>`;
}
function renderPtRc(){
  const box=$("ptRcList"),list=P.data.receipts;
  if(!list.length){box.innerHTML=`<p class="hint">Принятых поставок пока нет. Когда склад примет вашу поставку, здесь появится акт приёмки с расхождениями, если они были.</p>`;return}
  box.innerHTML=list.map((r,i)=>{const got=r.lines.reduce((a,l)=>a+(l.got||0),0),exp=r.lines.reduce((a,l)=>a+(l.expected||0),0);
    const diff=rcDiff(r.lines);
    return`<div><span><b>${fmtTs(r.ts)}</b>${r.doc?" · "+esc(r.doc):""}<br><span class="hint">Принято ${got} шт.${exp?` из ${exp} ожидаемых`:""} · ${r.lines.length} ${plural(r.lines.length,"позиция","позиции","позиций")}</span>${diff?` <span class="chip warn">расхождений ${diff}</span>`:exp?' <span class="chip ok">без расхождений</span>':""}</span><button class="btn sm" type="button" data-ptact="${i}">Акт</button></div>`}).join("")
    +(P.data.rcMore?`<div style="justify-content:center;border-bottom:0"><button class="btn sm" type="button" id="ptRcMore">Показать более ранние поставки</button></div>`:"");
}
$("ptRcList").addEventListener("click",async e=>{
  if(e.target.id==="ptRcMore"){const list=P.data.receipts,last=list[list.length-1];
    const q=new URLSearchParams({rc_before:String(last.id)});if(P.preview)q.set("client",P.client);
    const res=await run(e.target,"Загружаю…",()=>api("GET","/api/my?"+q));
    if(res){P.data.receipts=list.concat(res.receipts);P.data.rcMore=res.rcMore;renderPtRc()}return}
  const b=e.target.closest("[data-ptact]");if(!b)return;const r=P.data.receipts[+b.dataset.ptact];downloadAct({...r,client:P.data.client,user_name:"склад «Дело в коробке»"})});
function ptOpsRows(){
  const q=norm($("ptOpsQ").value),t=$("ptOpsType").value;
  return P.data.ops.filter(o=>(!t||o.type===t)&&(!q||[o.article,o.name,o.doc].some(v=>norm(v).includes(q))));
}
const ptSigned=o=>o.type==="pick"?-Math.abs(o.qty):o.type==="receive"?Math.abs(o.qty):o.qty;
function renderPtOps(){
  const rows=ptOpsRows(),box=$("ptOpsTable");
  if(!P.data.ops.length){box.innerHTML=`<div class="empty"><b>Движений пока нет</b>Здесь будут поступления, отгрузки и результаты инвентаризаций по вашим товарам.</div>`;return}
  if(!rows.length){box.innerHTML=`<div class="empty"><b>Ничего не найдено</b>Измените фильтры.</div>`;return}
  box.innerHTML=`<div class="table-wrap"><table class="pt-table"><thead><tr><th>Когда</th><th>Артикул</th><th class="num">Кол-во</th><th>Операция</th><th>Документ</th></tr></thead><tbody>${rows.map(o=>{const n=ptSigned(o);return`<tr>
    <td class="mono">${fmtTs(o.ts)}</td>
    <td class="wrap-any"><span class="mono">${esc(o.article)}</span>${o.name?`<br><span class="hint">${esc(o.name)}</span>`:""}</td>
    <td class="num mono"><b>${n>0?"+":""}${n}</b></td><td><span class="chip ${PT_OPC[o.type]||""}">${PT_OPN[o.type]||esc(o.type)}</span></td>
    <td class="wrap-any hint">${esc(o.doc||(o.type==="inventory"?o.note:""))}</td></tr>`}).join("")}</tbody></table></div>`;
}
$("ptQ").addEventListener("input",renderPtStock);$("ptZero").addEventListener("change",renderPtStock);
$("ptOpsQ").addEventListener("input",renderPtOps);$("ptOpsType").addEventListener("change",renderPtOps);
$("ptExport").addEventListener("click",()=>{if(!P.data)return;const items=ptStockRows();
  saveXlsx(`ostatki-${today()}.xlsx`,[[`Остатки на складе «Дело в коробке» · ${P.data.client}`],[`На ${fmtTs(new Date().toISOString())}`],[],["Артикул","Наименование","Штрихкод","Всего","Разложено по ячейкам","В приёмке"],...items.map(x=>[x.article,x.name,x.barcode,x.stock+x.recv,x.stock,x.recv])],"Остатки")});
$("ptOpsExport").addEventListener("click",()=>{if(!P.data)return;
  saveXlsx(`dvizhenie-${today()}.xlsx`,[["Дата","Операция","Артикул","Наименование","Количество","Документ"],...ptOpsRows().map(o=>[fmtTs(o.ts),PT_OPN[o.type]||o.type,o.article,o.name,ptSigned(o),o.doc||(o.type==="inventory"?o.note:"")])],"Движение")});
$("ptPassForm").addEventListener("submit",async e=>{
  e.preventDefault();$("ptPassErr").textContent="";
  if($("ptNew").value!==$("ptNew2").value){$("ptPassErr").textContent="Новые пароли не совпадают";return}
  try{await api("POST","/api/password",{old:$("ptOld").value,password:$("ptNew").value});["ptOld","ptNew","ptNew2"].forEach(id=>$(id).value="");okb("Пароль изменён")}
  catch(err){$("ptPassErr").textContent=err.message}
});

/* ======================================================
   УСЛУГИ И СЧЕТА
   ====================================================== */
const BL={services:[],charges:[],invoices:[],summary:null,settings:null,draft:null};
const localDay=(d=new Date())=>d.toLocaleDateString("sv-SE");
const fmtRub=n=>Number(n||0).toLocaleString("ru-RU",{minimumFractionDigits:2,maximumFractionDigits:2})+" ₽";
const fmtQty=n=>Number(n||0).toLocaleString("ru-RU",{maximumFractionDigits:2});
const fmtDay=s=>s?String(s).slice(0,10).split("-").reverse().join("."):"";
const INV_ST={issued:["Выставлен","warn"],paid:["Оплачен","ok"],cancelled:["Отменён",""]};
const invChip=s=>{const[t,c]=INV_ST[s]||[s,""];return`<span class="chip ${c}">${t}</span>`};
let blLoading=null,blAgain=false;
async function loadBilling(){
  if(blLoading){blAgain=true;return blLoading}
  blLoading=(async()=>{
    try{
      const c=$("chfClient").value,qs=new URLSearchParams();if(c)qs.set("client",c);if($("chOpen").checked)qs.set("open","1");
      const[s,ch,inv,sum,set]=await Promise.all([api("GET","/api/billing/services"),api("GET","/api/billing/charges?"+qs),
        isAdmin()?api("GET","/api/billing/invoices"):null,isAdmin()?api("GET","/api/billing/summary"):null,isAdmin()&&!BL.settings?api("GET","/api/billing/settings"):null]);
      BL.services=s.services;BL.charges=ch.charges;if(inv)BL.invoices=inv.invoices;if(sum)BL.summary=sum;if(set){BL.settings=set.settings;fillReq()}
      if(tab==="svc")renderSvc();if(tab==="bill")renderBill();
    }catch(e){fail(e.message)}
    finally{blLoading=null;if(blAgain){blAgain=false;loadBilling()}}
  })();
  return blLoading;
}
function clientOptions(sel,withAll){const prev=sel.value;sel.innerHTML=(withAll?`<option value="">Все клиенты</option>`:"")+clients().map(c=>`<option${c===prev?" selected":""}>${esc(c)}</option>`).join("")||`<option value="">Клиентов пока нет</option>`}
function renderSvc(){
  const sel=$("chService"),prev=sel.value;
  sel.innerHTML=BL.services.filter(s=>s.active&&s.kind!=="storage").map(s=>`<option value="${s.id}"${String(s.id)===prev?" selected":""}>${esc(s.name)} · ${fmtRub(s.price)}/${esc(s.unit)}</option>`).join("");
  if(!$("chDay").value)$("chDay").value=localDay();
  clientOptions($("chfClient"),true);
  const rows=BL.charges,total=rows.reduce((a,c)=>a+c.amount,0),open=rows.filter(c=>!c.invoice_id).reduce((a,c)=>a+c.amount,0);
  $("chKv").innerHTML=`<div><span>Начислений</span><b>${rows.length}</b></div><div><span>На сумму</span><b>${fmtRub(total)}</b></div><div><span>Не выставлено в счёт</span><b>${fmtRub(open)}</b></div>`;
  const box=$("chTable");
  if(!rows.length){box.innerHTML=`<div class="empty"><b>Начислений нет</b>Они появятся после приёмки, сборки или когда вы добавите услугу вручную.</div>`;return}
  box.innerHTML=`<div class="table-wrap"><table><thead><tr><th>Дата</th><th>Клиент</th><th>Услуга</th><th class="num">Кол-во</th><th class="num">Цена</th><th class="num">Сумма</th><th>Комментарий</th><th>Счёт</th>${isAdmin()?"<th></th>":""}</tr></thead><tbody>${rows.map(c=>`<tr>
    <td class="mono" style="white-space:nowrap">${fmtDay(c.day)}</td><td>${esc(c.client)}</td><td>${esc(c.service)}</td>
    <td class="num mono">${fmtQty(c.qty)} ${esc(c.unit)}</td><td class="num mono">${fmtRub(c.price)}</td><td class="num mono"><b>${fmtRub(c.amount)}</b></td>
    <td class="wrap-any hint">${esc(c.note)}${c.user_name?` · ${esc(c.user_name)}`:""}</td>
    <td>${c.invoice_number?`<span class="mono">№ ${esc(c.invoice_number)}</span>`:'<span class="chip warn">не выставлено</span>'}</td>
    ${isAdmin()?`<td class="num">${c.invoice_id?"":`<button class="btn sm ghost" type="button" data-chdel="${c.id}">Удалить</button>`}</td>`:""}</tr>`).join("")}</tbody></table></div>`;
}
$("chForm").addEventListener("submit",async e=>{
  e.preventDefault();
  const body={client:$("chClient").value.trim(),service_id:$("chService").value,qty:$("chQty").value,day:$("chDay").value,note:$("chNote").value.trim()};
  if(!clients().some(c=>norm(c)===norm(body.client))&&!$("chForm").dataset.confirm){const sim=similarClient(body.client);$("chForm").dataset.confirm="1";
    fail(sim?`Клиента «${body.client}» нет, но есть похожий: «${sim}». Выберите его или нажмите «Добавить» ещё раз.`:`Клиента «${body.client}» на складе нет. Проверьте написание или нажмите «Добавить» ещё раз.`);return}
  delete $("chForm").dataset.confirm;
  const res=await run(e.submitter,"Добавляю…",()=>api("POST","/api/billing/charges",body));
  if(res){okb("Услуга добавлена");$("chNote").value="";$("chQty").value="1";loadBilling()}
});
$("chClient").addEventListener("input",()=>delete $("chForm").dataset.confirm);
["chfClient","chOpen"].forEach(id=>$(id).addEventListener("change",loadBilling));
$("chTable").addEventListener("click",async e=>{const b=e.target.closest("[data-chdel]");if(!b)return;
  if(!b.dataset.confirm){b.dataset.confirm="1";b.textContent="Точно удалить?";return}
  const res=await run(b,"Удаляю…",()=>api("POST","/api/billing/charges/delete",{id:+b.dataset.chdel}));if(res){okb("Начисление удалено");loadBilling()}});
$("chExport").addEventListener("click",()=>saveXlsx(`uslugi-${today()}.xlsx`,[["Дата","Клиент","Услуга","Количество","Ед.","Цена","Сумма","Комментарий","Счёт"],
  ...BL.charges.map(c=>[fmtDay(c.day),c.client,c.service,c.qty,c.unit,c.price,c.amount,c.note,c.invoice_number||"не выставлено"])],"Услуги"));

function linesTable(lines,total){
  return`<div class="table-wrap"><table><thead><tr><th>Услуга</th><th class="num">Кол-во</th><th class="num">Цена</th><th class="num">Сумма</th></tr></thead><tbody>${lines.map(l=>`<tr>
    <td>${esc(l.service)}</td><td class="num mono">${fmtQty(l.qty)} ${esc(l.unit)}</td><td class="num mono">${fmtRub(l.price)}</td><td class="num mono">${fmtRub(l.amount)}</td></tr>`).join("")}
    <tr><td colspan="3"><b>Итого</b></td><td class="num mono"><b>${fmtRub(total)}</b></td></tr></tbody></table></div>`;
}
function renderBill(){
  const s=BL.summary;
  $("billKv").innerHTML=s?`<div><span>Услуг за этот месяц</span><b>${fmtRub(s.month)}</b></div><div><span>Ждёт оплаты</span><b>${fmtRub(s.unpaid)}</b></div><div><span>Ещё не выставлено</span><b>${fmtRub(s.open)}</b></div>`:"";
  clientOptions($("biClient"));clientOptions($("cpClient"));
  if(!$("biFrom").value){const d=new Date();$("biFrom").value=localDay(new Date(d.getFullYear(),d.getMonth(),1));$("biTo").value=localDay(d)}
  const box=$("biTable"),list=BL.invoices;
  box.innerHTML=list.length?`<div class="table-wrap"><table><thead><tr><th>№</th><th>Клиент</th><th>Период</th><th class="num">Сумма</th><th>Статус</th><th></th></tr></thead><tbody>${list.map(i=>`<tr data-inv="${i.id}"${i.status==="cancelled"?' style="opacity:.55"':""}>
    <td class="mono">${esc(i.number)}</td><td>${esc(i.client)}</td><td class="mono" style="white-space:nowrap">${fmtDay(i.period_from)} — ${fmtDay(i.period_to)}</td>
    <td class="num mono"><b>${fmtRub(i.total)}</b></td><td>${invChip(i.status)}</td>
    <td class="num"><span class="row" style="flex-wrap:nowrap;justify-content:flex-end"><button class="btn sm" type="button" data-print>Печать</button>${i.status==="issued"?`<button class="btn sm" type="button" data-st="paid">Оплачен</button><button class="btn sm ghost" type="button" data-st="cancel">Отменить</button>`:i.status==="paid"?`<button class="btn sm ghost" type="button" data-st="issued">Не оплачен</button>`:""}</span></td></tr>`).join("")}</tbody></table></div>`
    :`<div class="empty"><b>Счетов пока нет</b>Выберите клиента и период выше и нажмите «Посчитать».</div>`;
  const tf=$("tfTable"),KIND={receive:"сама при приёмке",pick:"сама при сборке",storage:"по дням в счёте",manual:"вручную"};
  tf.innerHTML=`<div class="table-wrap"><table><thead><tr><th>Услуга</th><th>Ед.</th><th class="num">Цена, ₽</th><th>Начисляется</th><th>Активна</th><th></th></tr></thead><tbody>${BL.services.map(s=>`<tr data-svc="${s.id}">
    <td><input data-f="name" value="${esc(s.name)}" style="min-width:170px;min-height:36px;padding:4px 8px"></td>
    <td><input data-f="unit" value="${esc(s.unit)}" style="width:80px;min-height:36px;padding:4px 8px"></td>
    <td class="num"><input data-f="price" type="number" min="0" step="any" value="${s.price}" style="width:100px;min-height:36px;padding:4px 8px"></td>
    <td class="hint">${KIND[s.kind]||esc(s.kind)}</td><td><input data-f="active" type="checkbox"${s.active?" checked":""}></td>
    <td class="num"><button class="btn sm" type="button" data-save>Сохранить</button></td></tr>`).join("")}</tbody></table></div>`;
  loadClientPrices();
}
async function loadClientPrices(){
  const c=$("cpClient").value,box=$("cpTable");
  if(!c){box.innerHTML="";return}
  try{const{prices}=await api("GET","/api/billing/prices?client="+encodeURIComponent(c));
    box.innerHTML=`<div class="table-wrap"><table><thead><tr><th>Услуга</th><th class="num">По умолчанию</th><th class="num">Для клиента, ₽</th><th></th></tr></thead><tbody>${prices.map(p=>`<tr data-cp="${p.service_id}">
      <td>${esc(p.name)} <span class="hint">(${esc(p.unit)})</span></td><td class="num mono">${fmtRub(p.default_price)}</td>
      <td class="num"><input type="number" min="0" step="any" value="${p.client_price??""}" placeholder="как у всех" style="width:120px;min-height:36px;padding:4px 8px"></td>
      <td class="num"><button class="btn sm" type="button">Сохранить</button></td></tr>`).join("")}</tbody></table></div>`}
  catch(e){fail(e.message)}
}
$("cpClient").addEventListener("change",loadClientPrices);
$("cpTable").addEventListener("click",async e=>{const b=e.target.closest("button");const tr=e.target.closest("tr[data-cp]");if(!b||!tr)return;
  const res=await run(b,"…",()=>api("POST","/api/billing/prices",{client:$("cpClient").value,service_id:+tr.dataset.cp,price:tr.querySelector("input").value}));if(res)okb("Цена для клиента сохранена")});
$("tfTable").addEventListener("click",async e=>{const b=e.target.closest("[data-save]");if(!b)return;const tr=b.closest("tr");const f=n=>tr.querySelector(`[data-f="${n}"]`);
  const res=await run(b,"…",()=>api("POST","/api/billing/services/update",{id:+tr.dataset.svc,name:f("name").value,unit:f("unit").value,price:f("price").value,active:f("active").checked}));
  if(res){okb("Тариф сохранён");loadBilling()}});
$("tfForm").addEventListener("submit",async e=>{e.preventDefault();
  const res=await run(e.submitter,"Добавляю…",()=>api("POST","/api/billing/services",{name:$("tfName").value,unit:$("tfUnit").value,price:$("tfPrice").value}));
  if(res){okb("Услуга добавлена в тарифы");$("tfName").value="";$("tfPrice").value="";loadBilling()}});
function fillReq(){document.querySelectorAll("[data-req]").forEach(i=>i.value=(BL.settings||{})[i.dataset.req]||"")}
$("reqForm").addEventListener("submit",async e=>{e.preventDefault();const body={};document.querySelectorAll("[data-req]").forEach(i=>body[i.dataset.req]=i.value.trim());
  const res=await run(e.submitter,"Сохраняю…",()=>api("POST","/api/billing/settings",body));if(res){BL.settings=body;okb("Реквизиты сохранены")}});
const biParams=()=>({client:$("biClient").value,from:$("biFrom").value,to:$("biTo").value});
$("biPreview").addEventListener("click",async e=>{
  const p=biParams();if(!p.client){fail("Выберите клиента");return}
  const res=await run(e.currentTarget,"Считаю…",()=>api("GET","/api/billing/preview?"+new URLSearchParams(p)));
  if(!res)return;BL.draft={...p,total:res.total};
  $("biDraft").innerHTML=res.lines.length?`${linesTable(res.lines,res.total)}${res.storage?`<p class="hint">Хранение с ${fmtDay(res.storage.from)} по ${fmtDay(res.storage.to)}: ${fmtQty(res.storage.qty)} шт·сут.</p>`:""}
    <button class="btn primary" type="button" id="biCreate" style="align-self:flex-start">Выставить счёт на ${fmtRub(res.total)}</button>`
    :`<p class="hint">За этот период у «${esc(p.client)}» нет невыставленных услуг.</p>`;
});
$("biDraft").addEventListener("click",async e=>{if(e.target.id!=="biCreate"||!BL.draft)return;
  const res=await run(e.target,"Выставляю…",()=>api("POST","/api/billing/invoices",BL.draft));
  if(res){okb(`Счёт № ${res.number} на ${fmtRub(res.total)} выставлен`);$("biDraft").innerHTML="";BL.draft=null;await loadBilling();printInvoice(res.id)}});
["biClient","biFrom","biTo"].forEach(id=>$(id).addEventListener("change",()=>{$("biDraft").innerHTML="";BL.draft=null}));
$("biTable").addEventListener("click",async e=>{const tr=e.target.closest("tr[data-inv]");if(!tr)return;const id=+tr.dataset.inv;
  if(e.target.closest("[data-print]")){printInvoice(id);return}
  const b=e.target.closest("[data-st]");if(!b)return;
  if(b.dataset.st==="cancel"&&!b.dataset.confirm){b.dataset.confirm="1";b.textContent="Точно отменить?";return}
  const res=await run(b,"…",()=>api("POST","/api/billing/invoices/status",{id,action:b.dataset.st}));
  if(res){okb({paid:"Счёт отмечен оплаченным",cancel:"Счёт отменён, услуги снова можно выставить",issued:"Счёт снова ждёт оплаты"}[b.dataset.st]);loadBilling()}});

function rublesInWords(amount){
  const ones=[["","один","два","три","четыре","пять","шесть","семь","восемь","девять"],["","одна","две","три","четыре","пять","шесть","семь","восемь","девять"]];
  const teens=["десять","одиннадцать","двенадцать","тринадцать","четырнадцать","пятнадцать","шестнадцать","семнадцать","восемнадцать","девятнадцать"];
  const tens=["","","двадцать","тридцать","сорок","пятьдесят","шестьдесят","семьдесят","восемьдесят","девяносто"];
  const hund=["","сто","двести","триста","четыреста","пятьсот","шестьсот","семьсот","восемьсот","девятьсот"];
  const triad=(n,fem)=>{const w=[hund[Math.floor(n/100)]],r=n%100;if(r>=10&&r<20)w.push(teens[r-10]);else w.push(tens[Math.floor(r/10)],ones[fem?1:0][r%10]);return w.filter(Boolean).join(" ")};
  const groups=[[0,["рубль","рубля","рублей"]],[1,["тысяча","тысячи","тысяч"]],[0,["миллион","миллиона","миллионов"]],[0,["миллиард","миллиарда","миллиардов"]]];
  const cents=Math.round(Number(amount)*100);let rub=Math.floor(cents/100);const kop=cents%100,whole=rub,parts=[];
  if(!rub)parts.push("ноль");
  for(let i=0;rub>0&&i<groups.length;i++){const n=rub%1000;if(n)parts.unshift(i?`${triad(n,groups[i][0])} ${plural(n,...groups[i][1])}`:triad(n,false));rub=Math.floor(rub/1000)}
  const t=`${parts.join(" ")} ${plural(whole,...groups[0][1])} ${String(kop).padStart(2,"0")} ${plural(kop,"копейка","копейки","копеек")}`.replace(/\s+/g," ").trim();
  return t.charAt(0).toUpperCase()+t.slice(1);
}
async function printInvoice(id){
  let j;try{j=await api("GET","/api/billing/invoice?id="+id)}catch(e){fail(e.message);return}
  const i=j.invoice,s=j.supplier||{},row=(k,v)=>v?`<div><span>${k}:</span> ${esc(v)}</div>`:"";
  printHtml(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Счёт № ${esc(i.number)}</title><style>
    body{font:13px/1.45 Arial,sans-serif;color:#000;margin:18mm 14mm}h1{font-size:19px;border-bottom:2px solid #000;padding-bottom:6px;margin:0 0 12px}
    .p{margin:8px 0}.p span{color:#555}table{width:100%;border-collapse:collapse;margin-top:12px}th,td{border:1px solid #000;padding:5px 7px;text-align:left}
    th{background:#eee}td.n{text-align:right;white-space:nowrap}.st{color:#b00;font-weight:bold}.sign{margin-top:40px}</style></head><body>
    <h1>Счёт № ${esc(i.number)} от ${fmtDay(i.created&&localDay(new Date(i.created)))}</h1>
    ${i.status!=="issued"?`<p class="st">${INV_ST[i.status][0]}</p>`:""}
    <div class="p"><b>Исполнитель:</b> ${esc(s.company_name||"склад «Дело в коробке»")}${row("ИНН",s.company_inn)}${row("Адрес",s.company_address)}${row("Банк",s.bank_name)}${row("БИК",s.bank_bik)}${row("Р/с",s.bank_account)}${row("К/с",s.bank_corr_account)}</div>
    <div class="p"><b>Заказчик:</b> ${esc(i.client)}</div>
    <div class="p"><b>Основание:</b> услуги фулфилмента за период ${fmtDay(i.period_from)} — ${fmtDay(i.period_to)}</div>
    <table><thead><tr><th>№</th><th>Услуга</th><th>Кол-во</th><th>Ед.</th><th>Цена</th><th>Сумма</th></tr></thead><tbody>
    ${i.lines.map((l,n)=>`<tr><td>${n+1}</td><td>${esc(l.service)}</td><td class="n">${fmtQty(l.qty)}</td><td>${esc(l.unit)}</td><td class="n">${fmtRub(l.price)}</td><td class="n">${fmtRub(l.amount)}</td></tr>`).join("")}
    <tr><td colspan="5"><b>Итого</b></td><td class="n"><b>${fmtRub(i.total)}</b></td></tr></tbody></table>
    <p>Всего наименований ${i.lines.length}, на сумму ${fmtRub(i.total)}. ${esc(s.vat_note||"")}<br><b>${esc(rublesInWords(i.total))}</b></p>
    <div class="sign">Исполнитель ____________________</div></body></html>`);
}

/* кабинет клиента: счета и услуги, ещё не вошедшие в счёт */
async function loadPtBill(){
  const qs=P.preview?"?client="+encodeURIComponent(P.client):"";
  try{const[inv,ch]=await Promise.all([api("GET","/api/billing/invoices"+qs),api("GET","/api/billing/charges"+(qs?qs+"&":"?")+"open=1")]);P.bill={invoices:inv.invoices,charges:ch.charges};if(P.tab==="bill")renderPtBill()}
  catch(e){if(me&&!P.bill)toast(e.message,true)}
}
function renderPtBill(){
  const b=P.bill;if(!b){$("ptBillList").innerHTML=`<p class="hint">Загружаю…</p>`;$("ptChTable").innerHTML="";return}
  $("ptBillList").innerHTML=b.invoices.length?`<div class="table-wrap"><table class="pt-table"><thead><tr><th>№</th><th>Период</th><th class="num">Сумма</th><th>Статус</th><th></th></tr></thead><tbody>${b.invoices.map(i=>`<tr>
    <td class="mono">${esc(i.number)}</td><td class="mono">${fmtDay(i.period_from)} — ${fmtDay(i.period_to)}</td><td class="num mono"><b>${fmtRub(i.total)}</b></td><td>${invChip(i.status)}</td>
    <td class="num"><button class="btn sm" type="button" data-ptinv="${i.id}">Счёт</button></td></tr>`).join("")}</tbody></table></div>`
    :`<p class="hint">Счетов пока нет.</p>`;
  const rows=b.charges,total=rows.reduce((a,c)=>a+c.amount,0);
  $("ptChTable").innerHTML=rows.length?`<div class="table-wrap"><table class="pt-table"><thead><tr><th>Дата</th><th>Услуга</th><th class="num">Кол-во</th><th class="num">Сумма</th><th>Комментарий</th></tr></thead><tbody>${rows.map(c=>`<tr>
    <td class="mono">${fmtDay(c.day)}</td><td>${esc(c.service)}</td><td class="num mono">${fmtQty(c.qty)} ${esc(c.unit)}</td><td class="num mono">${fmtRub(c.amount)}</td><td class="wrap-any hint">${esc(c.note)}</td></tr>`).join("")}
    <tr><td colspan="3"><b>Итого без хранения</b></td><td class="num mono"><b>${fmtRub(total)}</b></td><td></td></tr></tbody></table></div>`
    :`<p class="hint">Новых услуг пока нет.</p>`;
}
$("ptBillList").addEventListener("click",e=>{const b=e.target.closest("[data-ptinv]");if(b)printInvoice(+b.dataset.ptinv)});

/* ---------- вкладки ---------- */
const TABS=["rc","mv","pick","inv","stock","prod","cells","log","users","svc","bill","admin"];
function setTab(name){
  if(!TABS.includes(name)||((name==="admin"||name==="bill"||name==="users")&&!isAdmin()))name="rc";tab=name;
  [...$("tabs").children].forEach(b=>b.setAttribute("aria-selected",String(b.dataset.tab===name)));
  TABS.forEach(n=>$("view-"+n).hidden=n!==name);
  ls.set("tab",name);renderActive();
  if(name==="users")loadUsers();
  if(name==="svc"||name==="bill")loadBilling();
  const sc={rc:"rcScan",mv:"mvScan",inv:"invScan",pick:plan?"pkScan":null}[name];
  if(sc&&window.matchMedia("(pointer:fine)").matches)setTimeout(()=>$(sc).focus(),0);
  const b=$("tabs").querySelector(`[data-tab="${name}"]`);b&&b.scrollIntoView({inline:"nearest",block:"nearest"});
}
$("tabs").addEventListener("click",e=>{const b=e.target.closest("[data-tab]");if(b)setTab(b.dataset.tab)});
document.addEventListener("click",e=>{const b=e.target.closest("[data-goto]");if(b)setTab(b.dataset.goto)});
function renderActive(){
  ({rc:renderRc,mv:renderMv,pick:()=>{renderFiles();renderPlan()},inv:renderInv,stock:renderStock,prod:renderProd,cells:renderCells,log:renderLog,users:renderUsers,svc:renderSvc,bill:renderBill,admin:()=>{$("appVersion").textContent=appVersion?`Версия приложения ${appVersion}`:""}})[tab]();
}
function setStatus(off){
  let units=0;const cells=new Set();D.stock.forEach(r=>{units+=r.qty;cells.add(r.cell)});
  const st=$("status");st.classList.toggle("off",!!off);
  st.innerHTML=off?"Нет связи":live?`<b>${cells.size}</b> ячеек · <b>${units}</b> шт.`:"Загрузка…";
}
let rT=null;
function refresh(){clearTimeout(rT);rT=setTimeout(()=>{setStatus(false);renderClientSelects();renderActive()},30)}

/* ---------- вход ---------- */
let setupMode=false;
function showLogin(needSetup){
  me=null;mode="app";P.data=null;P.bill=null;if(es){es.close();es=null}
  Object.assign(BL,{services:[],charges:[],invoices:[],summary:null,settings:null,draft:null});fillReq();
  ["chTable","chKv","billKv","biDraft","biTable","tfTable","cpTable","ptBillList","ptChTable"].forEach(id=>$(id).innerHTML="");
  ["chService","chfClient","biClient","cpClient"].forEach(id=>$(id).innerHTML="");
  // на общем телефоне или ТСД следующий вошедший (например, клиент) не должен получить данные предыдущего
  D.stock=new Map();D.products=new Map();D.pidx=new Map();D.cells=new Set();D.ops=[];D.receipts=[];users=[];live=false;pendingClient.clear();
  ["stockTable","lTable","uTable","pTable","cTable","rcHist","clientList","pvClient","stockKv","mvTable","invTable","rcTable","ptStockTable","ptRcList","ptOpsTable","ptKv"].forEach(id=>$(id).innerHTML="");
  ["pickClient","fClient","pfClient","lClient"].forEach(id=>$(id).innerHTML="");
  $("status").textContent="";$("whoName").textContent="";$("ptWho").textContent="";
  setupMode=!!needSetup;
  $("app").hidden=true;$("portal").hidden=true;$("login").hidden=false;
  $("loginTitle").textContent=setupMode?"Первый запуск":"Вход на склад";
  $("loginHint").hidden=!setupMode;$("lfName").hidden=!setupMode;$("lfPass2").hidden=!setupMode;
  $("lPass").autocomplete=setupMode?"new-password":"current-password";
  $("lBtn").textContent=setupMode?"Создать администратора":"Войти";
  $("lErr").textContent="";
  setTimeout(()=>$(setupMode?"lName":"lLogin").focus(),0);
}
$("loginForm").addEventListener("submit",async e=>{
  e.preventDefault();$("lErr").textContent="";
  const login=$("lLogin").value.trim(),password=$("lPass").value;
  try{
    if(setupMode){
      if(password!==$("lPass2").value){$("lErr").textContent="Пароли не совпадают";return}
      await api("POST","/api/setup",{login,password,name:$("lName").value.trim()});
    }else await api("POST","/api/login",{login,password});
    $("lPass").value="";$("lPass2").value="";
    await boot();
  }catch(err){$("lErr").textContent=err.message}
});
$("logout").addEventListener("click",async()=>{try{await api("POST","/api/logout",{})}catch(e){}showLogin(false)});

async function boot(){
  let m;
  try{m=await api("GET","/api/me")}catch(e){$("login").hidden=false;$("lErr").textContent=e.message;return}
  appVersion=m.version||"";
  if(!m.user){showLogin(m.needSetup);return}
  me=m.user;document.body.dataset.role=me.role;
  if(me.role==="client"){$("ptWho").textContent=me.name;showPortal(null);connectEvents();return}
  mode="app";
  $("whoName").textContent=me.name;
  $("login").hidden=true;$("portal").hidden=true;$("app").hidden=false;
  setTab(ls.get("tab")||"rc");
  load(ALL_PARTS);
  connectEvents();
}
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible"&&me)reloadAll()});
if("serviceWorker" in navigator&&location.protocol==="https:")navigator.serviceWorker.register("sw.js").catch(()=>{});
boot();
})();
