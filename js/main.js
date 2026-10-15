import { clamp, analyze, inkFor } from './palette.js';
import { drawDisc } from './disc.js';
import { demoAlbums, loadImage, squareArt, placeholderArt } from './art.js';
import { AudioEngine } from './audio.js';
import { loadLibrary, albumsFromEntries, entriesFromInput, entriesFromDrop, entriesFromHandle, pickFolderWithHandle, canPickHandles, relink, hasAudio, pool } from './library.js';
import { saveAlbum, loadAlbums, saveRoots, loadRoots, forgetAll } from './persist.js';
import { decodeToWav } from './decoders.js';

const $=(s,r=document)=>r.querySelector(s);
const el=(t,c,p)=>{const e=document.createElement(t);if(c)e.className=c;if(p)p.append(e);return e;};
const fmt=s=>{s=Math.max(0,Math.floor(s));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');};
const wait=ms=>new Promise(r=>setTimeout(r,ms));

/* ---------- albums ---------- */
const rgbStr=c=>`${c[0]|0},${c[1]|0},${c[2]|0}`;
async function prepAlbum(raw){
  let art=raw.art;
  if(!art&&raw.cover){ try{ art=squareArt(await loadImage(raw.cover)); }catch{} }
  if(!art)art=placeholderArt(raw.placeholderTitle||raw.title,raw.artist);
  const{pal,dominant}=analyze(art);
  // dom/ink: the cover's dominant color and a readable text color on it, for spines and liner notes
  return{bpm:90,...raw,art,url:art.toDataURL('image/jpeg',.9),pal,dom:rgbStr(dominant),ink:rgbStr(inkFor(dominant))};
}

/* Rack order: artist (ignoring a leading "The"), then year, then title. */
const collator=new Intl.Collator(undefined,{numeric:true,sensitivity:'base'});
const artistKey=a=>(a.artist||'').replace(/^the\s+/i,'');
const cmpAlbums=(a,b)=>collator.compare(artistKey(a),artistKey(b))||(a.year||0)-(b.year||0)||collator.compare(a.title,b.title);
const sortAlbums=list=>list.sort(cmpAlbums);

let ALBUMS=[];
const engine=new AudioEngine();

/* ---------- state ---------- */
const S={ai:0,ti:0,t:0,playing:false,wantPlay:false,decoding:false,clock:0,caseOpen:false,disc:'case'}; // disc: case | loading-in | player | loading-out
const alb=()=>ALBUMS[S.ai];
const track=()=>alb().tracks[S.ti];
const isDemo=()=>!!alb()?.demo;
const P={pal:[[140,160,190],[190,140,140],[210,190,140]]};
const A={level:0};

const now=()=>isDemo()?S.t:engine.time;
const length=()=>isDemo()?track().duration:(engine.duration||track().duration||0);

/* ---------- software decoding fallback ---------- */
// Albums the browser can't play natively get album.needsDecode; their tracks are decoded to WAV blobs.
const decoded=new Map(); // track -> Promise<blob URL>, most recently used last
const KEEP_DECODED=3;    // previous, current, next (~47 MB each for a 4½-minute stereo track)
function decodedUrl(t){
  let p=decoded.get(t);
  if(p){ decoded.delete(t);decoded.set(t,p);return p; }
  p=fetch(t.src).then(r=>r.arrayBuffer()).then(b=>decodeToWav(new Uint8Array(b))).then(r=>{t.codec=r.label;return URL.createObjectURL(r.blob);});
  p.catch(()=>decoded.delete(t));
  decoded.set(t,p);
  while(decoded.size>KEEP_DECODED){
    const[k,old]=decoded.entries().next().value;decoded.delete(k);
    old.then(u=>URL.revokeObjectURL(u),()=>{});
  }
  return p;
}
function prefetchNext(){
  const a=alb(),next=a.tracks[S.ti+1];
  if(a.needsDecode&&next)decodedUrl(next).catch(()=>{});
}

let cueToken=0; // bumped on every cue/eject so a slow decode can't load into the wrong track
async function cue(autoplay){
  S.t=0;S.wantPlay=autoplay;
  const token=++cueToken;
  markNowPlaying();
  if(isDemo()){ S.playing=autoplay;return; }
  const a=alb(),t=track();
  updateMediaSession();
  if(!a.needsDecode){
    engine.load(t.src);
    if(autoplay)play(); else engine.pause();
    return;
  }
  engine.pause();S.decoding=true;
  try{
    const url=await decodedUrl(t);
    if(token!==cueToken)return;
    engine.load(url);
    if(S.wantPlay)play();
    prefetchNext();
  }catch(err){
    if(token===cueToken)note(`Couldn't decode “${t.title}”: ${err.message}`);
  }finally{
    if(token===cueToken)S.decoding=false;
  }
}
function play(){
  if(isDemo()){S.playing=true;return;}
  engine.play().catch(err=>{
    // NotSupportedError is handled by the 'error' listener, which switches to software decoding.
    if(err.name!=='AbortError'&&err.name!=='NotSupportedError'){S.playing=false;note(`Couldn't play “${track().title}”: ${err.message}`);}
  });
}
function pause(){ if(isDemo())S.playing=false; else engine.pause(); }
function togglePlay(){
  if(S.disc!=='player')return;
  if(S.decoding){S.wantPlay=!S.wantPlay;return;}
  S.playing?pause():play();
}
function nextTrack(){ S.ti=(S.ti+1)%alb().tracks.length;cue(S.playing); }
function prevTrack(){
  if(now()>3){ isDemo()?(S.t=0):engine.seek(0);return; }
  S.ti=(S.ti-1+alb().tracks.length)%alb().tracks.length;cue(S.playing);
}
function seekFrac(f){
  const t=clamp(f,0,1)*length()*.999;
  isDemo()?(S.t=t):engine.seek(t);
}

engine.el.addEventListener('play',()=>{S.playing=true;});
engine.el.addEventListener('pause',()=>{S.playing=false;});
engine.el.addEventListener('ended',()=>{
  // Real albums stop after the last track, like a CD player; demo albums loop.
  if(S.ti<alb().tracks.length-1){S.ti++;cue(true);}
  else{S.ti=0;cue(false);}
});
engine.el.addEventListener('loadedmetadata',()=>{
  // fill in track lengths on the liner as they become known
  const t=track();
  if(t&&!t.duration&&engine.duration){
    t.duration=engine.duration;
    const d=liner.querySelector(`button[data-ti="${S.ti}"] .d`);if(d)d.textContent=fmt(t.duration);
  }
});
engine.el.addEventListener('error',()=>{
  if(!engine.el.getAttribute('src')||S.disc==='case'||S.disc==='loading-out')return;
  const a=alb(),code=engine.el.error?.code;
  // MEDIA_ERR_DECODE (3) / MEDIA_ERR_SRC_NOT_SUPPORTED (4): retry this album through a wasm decoder.
  if(!a.demo&&!a.needsDecode&&(code===3||code===4)){
    a.needsDecode=true;
    if(S.disc==='player')cue(S.wantPlay); // during loading-in, the cue at the end of the animation picks it up
    return;
  }
  note(`Couldn't load “${track().title}” — the browser may not support this format.`);
});

/* ---------- DOM wiring ---------- */
const frame=$('#frame'),caseArea=$('#caseArea'),caseEl=$('#case'),caseImg=$('#caseImg'),caseCdWrap=$('#caseCdWrap'),caseCd=$('#caseCd');
const liner=$('#liner'),trayCard=$('#trayCard'),traySpine=$('#traySpine');
const rackEl=$('#rack'),rackSearch=$('#rackSearch'),rackEmpty=$('#rackEmpty'),addBtn=$('#addBtn');
const toggleCaseBtn=$('#toggleCase'),loadBtn=$('#loadBtn');
const device=$('#device'),slotFeed=$('#slotFeed'),feedCd=$('#feedCd'),playerCdWrap=$('#playerCdWrap'),playerCd=$('#playerCd'),deckEmpty=$('#deckEmpty');
const lcdTitle=$('#lcdTitle'),lcdTime=$('#lcdTime'),lcdTrack=$('#lcdTrack'),lcdBars=$('#lcdBars');
const tot=$('#tot'),fill=$('#fill'),rail=$('#rail');
const playBtn=$('#play'),playicon=$('#playicon'),prevBtn=$('#prev'),nextBtn=$('#next'),ejectBtn=$('#eject');
const picker=$('#picker'),libNote=$('#libNote'),knob=$('#knob');

/* ---------- theme: System -> Light -> Dark, remembered per browser ---------- */
const THEME_KEY='album-player:theme',THEMES=['system','light','dark'],THEME_NAMES={system:'System',light:'Light',dark:'Dark'};
const themeBtn=$('#themeBtn'),themeLabel=$('#themeLabel');
function applyTheme(mode){
  if(mode==='system')delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme=mode;
  const next=THEMES[(THEMES.indexOf(mode)+1)%THEMES.length];
  themeBtn.dataset.mode=mode;themeLabel.textContent=THEME_NAMES[mode];
  themeBtn.setAttribute('aria-label',`Theme: ${THEME_NAMES[mode]}. Switch to ${THEME_NAMES[next]}`);
  themeBtn.title=`Switch to ${THEME_NAMES[next]} theme`;
}
{
  let saved='system';try{saved=localStorage.getItem(THEME_KEY)||'system';}catch{}
  applyTheme(THEMES.includes(saved)?saved:'system');
  themeBtn.addEventListener('click',()=>{
    const mode=THEMES[(THEMES.indexOf(themeBtn.dataset.mode)+1)%THEMES.length];
    applyTheme(mode);
    try{ mode==='system'?localStorage.removeItem(THEME_KEY):localStorage.setItem(THEME_KEY,mode); }catch{}
  });
}

/* ---------- volume knob: drag, wheel or arrow keys; 0..1 maps to -135°..135° ---------- */
const VOL_KEY='album-player:volume';
let volShownUntil=0; // the LCD shows "VOL nn" in place of the track counter for a moment after each turn
function setVolume(v,show=true){
  v=clamp(v,0,1);engine.setVolume(v);
  if(show)volShownUntil=performance.now()+1400;
  knob.style.setProperty('--rot',`${-135+v*270}deg`);
  knob.setAttribute('aria-valuenow',Math.round(v*100));
  try{localStorage.setItem(VOL_KEY,String(v));}catch{}
}
{
  let saved=NaN;try{saved=parseFloat(localStorage.getItem(VOL_KEY));}catch{}
  setVolume(Number.isFinite(saved)?saved:.8,false);
  let drag=null;
  knob.addEventListener('pointerdown',e=>{drag={y:e.clientY,v:engine.volume};try{knob.setPointerCapture(e.pointerId);}catch{}});
  knob.addEventListener('pointermove',e=>{ if(drag)setVolume(drag.v+(drag.y-e.clientY)/160); });
  knob.addEventListener('pointerup',()=>{drag=null;});
  knob.addEventListener('pointercancel',()=>{drag=null;});
  knob.addEventListener('wheel',e=>{e.preventDefault();setVolume(engine.volume-Math.sign(e.deltaY)*.05);},{passive:false});
  knob.addEventListener('keydown',e=>{
    const step={ArrowUp:.05,ArrowRight:.05,ArrowDown:-.05,ArrowLeft:-.05,PageUp:.2,PageDown:-.2}[e.key];
    if(step!==undefined){e.preventDefault();e.stopPropagation();setVolume(engine.volume+step);}
    else if(e.key==='Home'){e.preventDefault();setVolume(0);}
    else if(e.key==='End'){e.preventDefault();setVolume(1);}
  });
}

for(let i=0;i<16;i++)lcdBars.append(el('b'));
const bars=[...lcdBars.children];

function note(html){ libNote.innerHTML=html; }

/* ---------- LCD title: scrolls when it doesn't fit ---------- */
const reduceMotion=matchMedia('(prefers-reduced-motion: reduce)');
const MARQUEE_SPEED=30; // px per second
let lcdText=null;
function setLcdTitle(text){
  if(text===lcdText)return; // the render loop calls this every frame
  lcdText=text;lcdTitle.textContent='';
  el('span',null,el('span','lcd-marquee',lcdTitle)).textContent=text;
  fitLcdTitle();
}
function fitLcdTitle(){
  const m=lcdTitle.firstElementChild;if(!m)return;
  lcdTitle.classList.remove('scroll');m.children[1]?.remove();
  const text=m.firstElementChild;
  if(reduceMotion.matches||m.offsetWidth<=lcdTitle.clientWidth+1)return; // fits (or motion off: ellipsis)
  lcdTitle.classList.add('scroll'); // adds the gap after the text
  const copy=text.cloneNode(true);copy.setAttribute('aria-hidden','true');m.append(copy);
  const loop=text.offsetWidth; // text + gap: shifting by this lands the copy exactly where the original started
  lcdTitle.style.setProperty('--loop',`${loop}px`);
  lcdTitle.style.setProperty('--dur',`${(loop/MARQUEE_SPEED/.82).toFixed(2)}s`); // 18% of the cycle is the pause
  m.style.animation='none';void m.offsetWidth;m.style.animation=''; // restart from the start
}
new ResizeObserver(fitLcdTitle).observe(lcdTitle.parentElement);
reduceMotion.addEventListener?.('change',fitLcdTitle);

const nf=new Intl.NumberFormat();
/* Cover crops and palettes for a fixed set (the demo albums). */
const prepAll=raw=>pool(raw,4,prepAlbum);

/* ---------- the case: cover, tray card, insert spine, liner notes ---------- */
function syncCase(){
  const a=alb();
  caseImg.src=a.url;caseImg.alt=`${a.title} cover`;
  caseArea.style.setProperty('--dom',a.dom);caseArea.style.setProperty('--ink',a.ink);
  trayCard.style.backgroundImage=`linear-gradient(rgba(${a.dom},.6),rgba(${a.dom},.6)),url("${a.url}")`;
  traySpine.firstElementChild.textContent=`${a.artist} \u00b7 ${a.title}`;
  renderLiner();
}
function renderLiner(){
  const a=alb();liner.textContent='';
  const head=el('div','liner-head',liner);
  el('span','liner-artist',head).textContent=a.artist;
  el('span','liner-title',head).textContent=a.title;
  const ol=el('ol','liner-tracks',liner);
  a.tracks.forEach((t,i)=>{
    const b=el('button',null,el('li',null,ol));b.dataset.ti=i;
    b.setAttribute('aria-label',`Play track ${i+1}, ${t.title}`);
    el('span','n',b).textContent=String(t.number??i+1).padStart(2,'0');
    el('span','t',b).textContent=t.title;
    el('span','d',b).textContent=t.duration?fmt(t.duration):'';
  });
  const foot=el('div','liner-foot',liner);
  el('span',null,foot).textContent=`${a.tracks.length} tracks`;
  if(a.year)el('span',null,foot).textContent=`\u2117 ${a.year}`;
  markNowPlaying();
}
function markNowPlaying(){
  const active=S.disc==='player'||S.disc==='loading-in';
  let now=null;
  liner.querySelectorAll('button[data-ti]').forEach(b=>{const on=active&&+b.dataset.ti===S.ti;b.classList.toggle('now',on);if(on)now=b;});
  const ol=liner.querySelector('.liner-tracks');
  if(now&&ol){ // keep the current track in view without scrolling the page
    const top=now.offsetTop-ol.offsetTop,bottom=top+now.offsetHeight;
    if(top<ol.scrollTop)ol.scrollTop=top; else if(bottom>ol.scrollTop+ol.clientHeight)ol.scrollTop=bottom-ol.clientHeight;
  }
}
/* Clicking a track on the liner: load the disc if it's still in the case, then play from there. */
function playTrack(i){
  if(S.disc==='player'){ S.ti=i;cue(true);return; }
  if(S.disc==='case'&&S.caseOpen)loadDisc(i);
}
liner.addEventListener('click',e=>{ const b=e.target.closest('button[data-ti]');if(b)playTrack(+b.dataset.ti); });

function setCaseOpen(open){
  S.caseOpen=open;caseEl.classList.toggle('open',open);caseArea.classList.toggle('open',open);
  liner.inert=!open; // the liner faces away while closed
  toggleCaseBtn.textContent=open?'Close case':'Open case';
  updateButtons();
}
function updateButtons(){
  toggleCaseBtn.disabled=!ALBUMS.length; // nothing on the shelf yet
  caseArea.classList.toggle('empty',!ALBUMS.length); // no case to show until the first album arrives
  loadBtn.disabled=!(ALBUMS.length&&S.caseOpen&&S.disc==='case');
  ejectBtn.disabled=S.disc!=='player';
  const havePlayer=S.disc==='player';
  playBtn.disabled=!havePlayer;prevBtn.disabled=!havePlayer;nextBtn.disabled=!havePlayer;
  deckEmpty.classList.toggle('hide',S.disc!=='case');
  caseCdWrap.classList.toggle('gone',S.disc!=='case');
}
/* ---------- slot loader ----------
   One disc, drawn twice: the part still standing out of the slit (feedCd, clipped at the slit) and the part
   inside the deck window (playerCd). Both move by the same y, so the disc reads as one object sliding through.
   y = 0: resting in the slot, partly out. y = travel: centered in the deck. */
const MOTOR='cubic-bezier(.45,0,.2,1)',LIFT=18;
let slotTravel=0;
function measureSlot(){
  for(const n of[feedCd,playerCdWrap])n.getAnimations().forEach(a=>a.cancel());
  const f=feedCd.getBoundingClientRect(),d=playerCdWrap.getBoundingClientRect();
  slotTravel=(d.top+d.height/2)-(f.top+f.height/2);
}
function moveDisc(frames,opts){
  feedCd.animate(frames.map(({y,o=1})=>({transform:`translateY(${y}px)`,opacity:o})),opts);
  playerCdWrap.animate(frames.map(({y,o=1})=>({transform:`translate(-50%,calc(-50% + ${y-slotTravel}px))`,opacity:o})),opts);
}
function setFeeding(on){
  slotFeed.classList.toggle('feeding',on);device.classList.toggle('feeding',on);
  if(!on)for(const n of[feedCd,playerCdWrap])n.getAnimations().forEach(a=>a.cancel());
}
function loadDisc(start=0){
  if(!(S.caseOpen&&S.disc==='case'))return;
  engine.unlock(); // inside the click, so the delayed play() below is allowed
  if(!isDemo()&&!alb().tracks[start]?.src){ // remembered album, folder not connected yet
    pendingLoad=start;note('Reconnect your music folder to play this album.');reconnect();return;
  }
  S.disc='loading-in';S.ti=start;updateButtons();markNowPlaying();
  // start buffering (or decoding) while the motor draws the disc in
  if(!isDemo())alb().needsDecode?decodedUrl(track()).catch(()=>{}):engine.load(track().src);
  playerCdWrap.classList.add('shown');
  if(!reduceMotion.matches){
    measureSlot();setFeeding(true);
    moveDisc([{y:-LIFT,o:0},{y:0}],{duration:220,easing:'cubic-bezier(.16,1,.3,1)'});   // set into the slot
    moveDisc([{y:0},{y:slotTravel}],{duration:640,delay:240,easing:MOTOR,fill:'both'}); // drawn in and centered
    setTimeout(()=>setFeeding(false),900);
  }
  setTimeout(()=>{ S.disc='player';updateButtons();cue(true); },reduceMotion.matches?300:900);
}
function ejectDisc(){
  if(S.disc!=='player')return Promise.resolve();
  cueToken++;pause();S.playing=false;S.wantPlay=false;S.decoding=false;S.disc='loading-out';updateButtons();
  if(!isDemo())engine.unload();
  if(reduceMotion.matches){ playerCdWrap.classList.remove('shown'); }
  else{
    measureSlot();setFeeding(true);
    moveDisc([{y:slotTravel},{y:0}],{duration:580,easing:MOTOR,fill:'forwards'});            // pushed back out of the slot
    moveDisc([{y:0},{y:-LIFT,o:0}],{duration:200,delay:640,easing:'cubic-bezier(.5,0,.75,0)',fill:'forwards'}); // lifted away
    setTimeout(()=>{ playerCdWrap.classList.remove('shown');setFeeding(false); },840);
  }
  return wait(reduceMotion.matches?300:860).then(()=>{ S.disc='case';setCaseOpen(true);markNowPlaying();clearMediaSession(); });
}
/* Swap albums like a real shelf: eject, close the case, slide it back into the rack, pull the new one out. */
let switching=false;
async function selectAlbum(target){
  const a=typeof target==='number'?ALBUMS[target]:target;
  if(!a||switching||a===alb()||S.disc==='loading-in'||S.disc==='loading-out')return;
  switching=true;
  try{
    if(S.disc==='player'){ await ejectDisc(); await wait(20); }
    if(S.caseOpen){ setCaseOpen(false);await wait(650); }
    caseArea.classList.add('away');
    await wait(300);
    S.ai=ALBUMS.indexOf(a);S.ti=0;S.t=0;
    markRack();syncCase();
    caseArea.classList.remove('away');
    await wait(350);
  }finally{ switching=false; }
}

/* ---------- the rack ---------- */
const rowOf=new Map(),albumOf=new WeakMap(); // album <-> its spine row
const nudgeOf=a=>(a.title.length*7+a.artist.length*3)%7; // cases never sit perfectly flush
function fillRow(row,a){
  const off=isOffline(a);
  row.classList.toggle('offline',off);
  row.title=`${a.title} — ${a.artist}${off?' (folder not connected)':''}`;row.setAttribute('aria-label',`${a.title} by ${a.artist}${off?', folder not connected':''}`);
  const sp=row.firstElementChild;
  sp.style.setProperty('--dom',a.dom);sp.style.setProperty('--ink',a.ink);sp.style.setProperty('--nudge',`${nudgeOf(a)}px`);
  sp.children[0].textContent=a.title;sp.children[1].textContent=a.artist;sp.children[2].textContent=a.year||'';
}
function rowFor(a){
  let row=rowOf.get(a);if(row)return row;
  row=el('button','rack-row');
  const sp=el('span','spine',row);el('span','sp-title',sp);el('span','sp-artist',sp);el('span','sp-cat',sp);
  fillRow(row,a);rowOf.set(a,row);albumOf.set(row,a);
  return row;
}
function renderRack(){
  rackEl.textContent='';rowOf.clear();
  for(const a of ALBUMS)rackEl.append(rowFor(a));
  markRack();filterRack();
}
function markRack(){
  const cur=alb();
  for(const r of rackEl.children){ const out=albumOf.get(r)===cur;r.classList.toggle('out',out);r.setAttribute('aria-pressed',String(out)); }
}
const fold=s=>s.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase();
const matches=(a,q)=>!q||fold(`${a.title} ${a.artist} ${a.year||''}`).includes(q);
function filterRack(){
  const q=fold(rackSearch.value.trim());let shown=0;
  for(const r of rackEl.children){ const hit=matches(albumOf.get(r),q);r.hidden=!hit;if(hit)shown++; }
  rackEmpty.hidden=shown>0||!rackEl.children.length;
}
rackEl.addEventListener('click',e=>{ const r=e.target.closest('.rack-row');if(r)selectAlbum(albumOf.get(r)); });
rackSearch.addEventListener('input',filterRack);
addBtn.addEventListener('click',()=>pickFolder());

/* ---------- remembered library: relink on a later visit ---------- */
// A remembered album's tracks have paths but no src until its folder is picked (or re-granted) again.
const isOffline=a=>!a.demo&&a.tracks.some(t=>t.path&&!t.src);
const reconnectBar=$('#reconnectBar'),reconnectBtn=$('#reconnectBtn'),forgetBtn=$('#forgetBtn');
let pendingLoad=null; // a Load disc (track index) waiting on reconnection
function refreshOffline(){
  for(const a of ALBUMS){ const row=rowOf.get(a);if(row)fillRow(row,a); }
  const n=ALBUMS.filter(isOffline).length;
  reconnectBar.hidden=!n;
  reconnectBtn.textContent=canPickHandles?'Reconnect folder':'Choose folder';
  reconnectBtn.title=`${n} album${n===1?'':'s'} remembered from your last visit: ${canPickHandles?'grant access to your music folder again':'choose your music folder again'} to play them`;
}
/* Picked or dropped files: relink remembered tracks first, then import only what's new. */
async function importEntries(entries){
  if(entries.handles?.length)saveRoots(entries.handles);
  const{linked,rest}=relink(ALBUMS,entries);
  if(linked){
    refreshOffline();
    note(`Reconnected ${nf.format(linked)} track${linked===1?'':'s'}.`);
    if(pendingLoad!==null&&S.disc==='case'&&alb().tracks[pendingLoad]?.src){ const i=pendingLoad;pendingLoad=null;if(!S.caseOpen)setCaseOpen(true);loadDisc(i); }
  }
  if(hasAudio(rest))reportImport(await runImport(o=>albumsFromEntries(rest,o)));
  else if(!linked)reportImport(0);
}
/* The + key: Chromium's folder picker returns a handle we can remember; elsewhere the hidden input. */
function pickFolder(){
  if(!canPickHandles){ picker.click();return; } // synchronously, inside the click
  pickFolderWithHandle().then(entries=>{ if(entries?.length)return importEntries(entries); })
    .catch(err=>{ console.warn(err);picker.click(); });
}
/* Must run inside a click: permission prompts and pickers need the user's gesture. */
async function reconnect(){
  if(!canPickHandles){ picker.click();return; } // Firefox/Safari: re-pick the same folder
  let any=false;
  for(const{handle}of await loadRoots()){
    try{
      let perm=await handle.queryPermission({mode:'read'});
      if(perm!=='granted')perm=await handle.requestPermission({mode:'read'});
      if(perm!=='granted')continue;
      note(`Reading ${handle.name}\u2026`);
      await importEntries(await entriesFromHandle(handle));any=true;
    }catch(err){ console.warn('reconnect',handle.name,err); }
  }
  if(!any){ pickFolder();return; } // nothing remembered we can re-open: pick it again
  const left=ALBUMS.filter(isOffline).length;
  if(left)note(`${nf.format(left)} album${left===1?'':'s'} still need${left===1?'s':''} a folder (moved or from another folder). Use + to choose it.`);
}
reconnectBtn.addEventListener('click',reconnect);
forgetBtn.addEventListener('click',async()=>{
  if(!confirm('Forget the remembered albums? Your music files are not touched.'))return;
  await forgetAll();
  location.reload();
});

/* ---------- shelving: streamed-in albums slide into their slot ---------- */
// Batched every ~120 ms. FLIP keeps it cheap: measure, insert, then animate transforms only.
const shelfQueue=[];let shelfTimer=0;
function shelve(a){ shelfQueue.push(a);if(!shelfTimer)shelfTimer=setTimeout(flushShelf,120); }
function flushShelf(){
  clearTimeout(shelfTimer);shelfTimer=0;
  const batch=shelfQueue.splice(0);if(!batch.length)return;
  const animate=!reduceMotion.matches&&!document.hidden;
  const view=rackEl.getBoundingClientRect();
  const onScreen=b=>b.bottom>view.top-40&&b.top<view.bottom+40;
  // First: where the visible cases sit now
  const before=new Map();
  if(animate)for(const r of rackEl.children)if(!r.hidden){ const b=r.getBoundingClientRect();if(onScreen(b))before.set(r,b.top); }
  // insert each new case at its sorted slot
  const cur=alb(),q=fold(rackSearch.value.trim());
  for(const a of batch){
    let lo=0,hi=ALBUMS.length;
    while(lo<hi){ const m=(lo+hi)>>1;if(cmpAlbums(ALBUMS[m],a)<=0)lo=m+1;else hi=m; }
    ALBUMS.splice(lo,0,a);
    const row=rowFor(a);row.hidden=!matches(a,q);
    rackEl.insertBefore(row,rowOf.get(ALBUMS[lo+1])||null);
  }
  S.ai=Math.max(0,ALBUMS.indexOf(cur));
  markRack();
  rackEmpty.hidden=[...rackEl.children].some(r=>!r.hidden)||!rackEl.children.length;
  if(!animate)return;
  const ease='cubic-bezier(.22,.9,.3,1)';
  // Last, Invert, Play: the cases already shelved glide down to make room
  for(const[r,top]of before){
    const dy=top-r.getBoundingClientRect().top;
    if(Math.abs(dy)>.5)r.animate([{transform:`translateY(${dy}px)`},{transform:'none'}],{duration:320,easing:ease});
  }
  // new cases are pushed in from the rack's open side, overshoot a hair, settle, and catch the light
  const entering=batch.map(a=>rowOf.get(a)).filter(r=>!r.hidden&&!r.classList.contains('out')&&onScreen(r.getBoundingClientRect()));
  const step=Math.min(45,360/Math.max(1,entering.length)); // big batches: tighter stagger, same total time
  entering.forEach((r,k)=>{
    const n=nudgeOf(albumOf.get(r)),sp=r.firstElementChild,delay=k*step;
    sp.animate([
      {transform:'translateX(calc(100% + 24px))',opacity:0},
      {transform:`translateX(${n-4}px)`,opacity:1,offset:.72},
      {transform:`translateX(${n}px)`,opacity:1},
    ],{duration:460,delay,easing:ease,fill:'backwards'});
    sp.animate([{filter:'brightness(1.5)'},{filter:'brightness(1)'}],{duration:900,delay:delay+280,fill:'backwards'});
  });
}

/* ---------- streaming import with a progress plaque on the rack ---------- */
const shelving=$('#shelving'),shelvingMain=$('#shelvingMain'),shelvingSub=$('#shelvingSub'),shelvingBar=$('#shelvingBar'),rackBox=$('.rack');
const prepared=new Map(); // `${run}\0${album id}` -> Promise<prepared album>
let importRun=0,loopStarted=false,shelvingHide=0;
function ensureLoop(){ if(!loopStarted&&ALBUMS.length){ loopStarted=true;requestAnimationFrame(loop); } }
const secs=t=>t<60?`${Math.max(1,Math.round(t))} s`:`${Math.floor(t/60)} min ${String(Math.round(t%60)).padStart(2,'0')} s`;
function showProgress(p,t0,added){
  const frac=p.tracksTotal?p.tracksDone/p.tracksTotal:0;
  shelving.classList.toggle('indeterminate',!p.tracksTotal);
  shelvingBar.style.width=`${(frac*100).toFixed(1)}%`;
  shelvingMain.textContent=`Shelving ${nf.format(added)} album${added===1?'':'s'}`;
  let sub=p.tracksTotal?`${nf.format(p.tracksDone)} / ${nf.format(p.tracksTotal)} tracks`:'';
  const t=(performance.now()-t0)/1000;
  if(t>3&&frac>.03&&frac<1){ const left=t/frac-t;sub+=` · ~${left<60?Math.max(5,Math.ceil(left/5)*5)+' s':Math.round(left/60)+' min'} left`; }
  shelvingSub.textContent=sub;
  if(p.tracksTotal)note(`Reading tags ${nf.format(p.tracksDone)} / ${nf.format(p.tracksTotal)}…`);
}
/* The first album of an import: fills an empty shelf, or takes over from the demo set. */
async function placeFirst(a){
  if(!ALBUMS.length){
    ALBUMS=[a];S.ai=0;P.pal=a.pal.map(c=>c.slice());
    renderRack();syncCase();setCaseOpen(false);ensureLoop();
    return;
  }
  if(!ALBUMS.every(x=>x.demo)){ shelve(a);return; }
  while(switching)await wait(50);
  switching=true;
  try{
    if(S.disc==='loading-in'||S.disc==='loading-out')await wait(900);
    if(S.disc==='player'){ await ejectDisc();await wait(20); }
    if(S.caseOpen){ setCaseOpen(false);await wait(650); }
    caseArea.classList.add('away');
    if(!reduceMotion.matches)for(const r of rackEl.children)r.firstElementChild.animate([{opacity:1},{opacity:0,transform:'translateX(calc(100% + 24px))'}],{duration:260,easing:'ease-in',fill:'forwards'});
    await wait(300);
    ALBUMS=[a];S.ai=0;S.ti=0;S.t=0;
    renderRack();syncCase();updateButtons();
    caseArea.classList.remove('away');
  }finally{ switching=false; }
}
/* An album that gained tracks after it was shelved (a Singles case, a stray album track). */
function applyUpdate(p,raw){
  const playingSrc=p===alb()&&S.disc!=='case'?track()?.src:null;
  const known=new Map(p.tracks.map(t=>[t.src,t.duration]));
  Object.assign(p,{title:raw.title,artist:raw.artist,year:raw.year,genre:raw.genre,
    tracks:raw.tracks.map(t=>({...t,duration:t.duration??known.get(t.src)}))});
  if(playingSrc){ const i=p.tracks.findIndex(t=>t.src===playingSrc);if(i>=0)S.ti=i; }
  const row=rowOf.get(p);if(row)fillRow(row,p);
  if(p===alb())syncCase();
}
/* Run an import; start({onProgress,onAlbum}) is a library.js loader. Albums are shelved as they arrive.
   Resolves to the number of albums added. */
async function runImport(start){
  const run=++importRun,t0=performance.now();
  let added=0,lastP={tracksDone:0,tracksTotal:0},gate=null;
  clearTimeout(shelvingHide);
  shelving.hidden=false;shelving.classList.remove('done','fade');shelving.classList.add('indeterminate');
  shelvingMain.textContent='Looking for music…';shelvingSub.textContent='';shelvingBar.style.width='0%';
  rackBox.classList.add('loading');
  const onProgress=p=>{ lastP=p;if(p.tracksTotal)showProgress(p,t0,added); };
  const onAlbum=async(raw,kind)=>{
    const id=`${run}\u0000${raw.id}`;
    if(kind==='update'){ const p=await prepared.get(id);if(p){ applyUpdate(p,raw);saveAlbum(p); }return; }
    const pending=prepAlbum(raw);prepared.set(id,pending);
    const a=await pending;
    saveAlbum(a); // remembered for next visit (user folders only; no audio is stored)
    if(!gate)gate=placeFirst(a); else{ await gate;shelve(a); }
    await gate;
    added++;showProgress(lastP,t0,added);
  };
  try{ await start({onProgress,onAlbum}); }
  catch(err){ console.warn('import failed',err);note(`Import failed: ${err.message}`); }
  await gate;flushShelf();
  rackBox.classList.remove('loading');
  if(!added){ shelving.hidden=true;return 0; }
  shelving.classList.remove('indeterminate');shelving.classList.add('done');shelvingBar.style.width='100%';
  shelvingMain.textContent=`Shelved ${nf.format(added)} album${added===1?'':'s'}`;
  shelvingSub.textContent=`${nf.format(lastP.tracksTotal)} tracks · ${secs((performance.now()-t0)/1000)}`;
  shelvingHide=setTimeout(()=>{ shelving.classList.add('fade');shelvingHide=setTimeout(()=>{shelving.hidden=true;},450); },4000);
  return added;
}
function reportImport(n){ note(n?`Added ${nf.format(n)} album${n===1?'':'s'} to the rack.`:'No audio files found in that selection.'); }

toggleCaseBtn.addEventListener('click',()=>setCaseOpen(!S.caseOpen));
loadBtn.addEventListener('click',()=>loadDisc(0));
ejectBtn.addEventListener('click',ejectDisc);
playBtn.addEventListener('click',togglePlay);
nextBtn.addEventListener('click',()=>{ if(S.disc==='player')nextTrack(); });
prevBtn.addEventListener('click',()=>{ if(S.disc==='player')prevTrack(); });

const railFrac=e=>{const r=rail.getBoundingClientRect();return(e.clientX-r.left)/r.width;};
rail.addEventListener('pointerdown',e=>{
  if(S.disc!=='player')return;
  seekFrac(railFrac(e));
  try{rail.setPointerCapture(e.pointerId);}catch{}
});
rail.addEventListener('pointermove',e=>{ if(rail.hasPointerCapture(e.pointerId))seekFrac(railFrac(e)); });
rail.addEventListener('keydown',e=>{
  if(S.disc!=='player')return;
  const len=length();if(!len)return;
  const step={ArrowRight:5,ArrowUp:5,ArrowLeft:-5,ArrowDown:-5}[e.key];
  if(step!==undefined){e.preventDefault();e.stopPropagation();seekFrac((now()+step)/len);}
  else if(e.key==='Home'){e.preventDefault();seekFrac(0);}
  else if(e.key==='End'){e.preventDefault();seekFrac(1);}
});

picker.addEventListener('change',async()=>{ const files=entriesFromInput(picker.files);picker.value='';await importEntries(files); });

let dragDepth=0;
frame.addEventListener('dragenter',e=>{ if(![...e.dataTransfer.types].includes('Files'))return; e.preventDefault();dragDepth++;frame.classList.add('dragging'); });
frame.addEventListener('dragover',e=>{ if([...e.dataTransfer.types].includes('Files'))e.preventDefault(); });
frame.addEventListener('dragleave',()=>{ if(--dragDepth<=0){dragDepth=0;frame.classList.remove('dragging');} });
frame.addEventListener('drop',async e=>{
  e.preventDefault();dragDepth=0;frame.classList.remove('dragging');
  const found=entriesFromDrop(e.dataTransfer); // must start inside the event: the DataTransfer empties after it
  note('Reading folders\u2026');
  await importEntries(await found);
});

document.addEventListener('keydown',e=>{
  if(e.target.closest('button,input,textarea,select')||e.metaKey||e.ctrlKey||e.altKey)return;
  if(e.code==='Space'&&S.disc==='player'){e.preventDefault();togglePlay();}
  else if(e.code==='ArrowRight'&&S.disc==='player')nextTrack();
  else if(e.code==='ArrowLeft'&&S.disc==='player')prevTrack();
});

/* ---------- Media Session (hardware keys, lock screen, Control Center) ---------- */
const ms=navigator.mediaSession;
function updateMediaSession(){
  if(!ms||S.disc!=='player'||isDemo())return;
  const a=alb();
  ms.metadata=new MediaMetadata({title:track().title,artist:track().artist||a.artist,album:a.title,artwork:[{src:a.url,sizes:'512x512',type:'image/jpeg'}]});
}
function clearMediaSession(){ if(ms)ms.metadata=null; }
if(ms){
  const on=(k,f)=>{try{ms.setActionHandler(k,f);}catch{}};
  on('play',()=>{ if(S.disc==='player')play(); });
  on('pause',pause);
  on('nexttrack',()=>{ if(S.disc==='player')nextTrack(); });
  on('previoustrack',()=>{ if(S.disc==='player')prevTrack(); });
  on('seekto',d=>{ if(S.disc==='player'&&!isDemo())engine.seek(d.seekTime); });
}

/* ---------- loop ---------- */
let last=performance.now();
// The player's disc has inertia: it spins up when play starts and coasts down on pause (rad/s).
const SPIN_RATE=4.2,SPIN_UP=2.4,SPIN_DOWN=1.1;
let discAngle=0,discVel=0;
function loop(t){
  const dt=Math.min(.05,(t-last)/1000);last=t;
  const a=alb();
  const spin=S.playing&&S.disc==='player';
  if(spin){
    S.clock+=dt;
    if(a.demo){ S.t+=dt; if(S.t>=track().duration)nextTrack(); }
  }
  const k=Math.min(1,dt*5);
  for(let i=0;i<3;i++)for(let j=0;j<3;j++)P.pal[i][j]+=(a.pal[i][j]-P.pal[i][j])*k;

  let target=0,bands=null;
  if(spin){
    if(a.demo){ target=.35+.65*Math.pow(1-((S.clock*a.bpm/60)%1),3); }
    else{ target=engine.level(); bands=engine.bands(bars.length); }
  }
  A.level+=(target-A.level)*Math.min(1,dt*8);

  drawDisc(caseCd,a,P.pal,S.clock*0.3,t/1000*0.6,0.1);
  const spinTarget=spin?SPIN_RATE:0;
  if(S.disc!=='player'||reduceMotion.matches)discVel=spinTarget; // no coasting in or out of the slot
  else discVel+=(spinTarget-discVel)*Math.min(1,dt*(spin?SPIN_UP:SPIN_DOWN));
  if(discVel<.01&&!spin)discVel=0;
  discAngle=(discAngle+discVel*dt)%(Math.PI*2);
  drawDisc(playerCd,a,P.pal,discAngle,t/1000*0.6,A.level);
  if(slotFeed.classList.contains('feeding'))drawDisc(feedCd,a,P.pal,discAngle,t/1000*0.6,A.level);
  bars.forEach((b,i)=>{
    let v=.03;
    if(spin)v=bands?bands[i]:clamp(A.level*(.5+.5*(1-Math.abs(i-7.5)/7.5))+Math.sin(t/120+i)*.08,0,1);
    b.style.height=(8+v*92)+'%';
  });
  const root=document.documentElement.style;
  P.pal.forEach((c,i)=>root.setProperty(`--a${i+1}`,`${c[0]|0},${c[1]|0},${c[2]|0}`));

  const inPlayer=S.disc==='player';
  const cur=inPlayer?now():0,len=inPlayer?length():0;
  // like the firmware on a real deck: READING while the slot draws the disc in, OPEN while it ejects
  setLcdTitle(inPlayer?track().title:S.disc==='loading-in'?'READING':S.disc==='loading-out'?'OPEN':'\u2014');
  const trk=inPlayer?'TRK '+String(S.ti+1).padStart(2,'0')+'/'+String(a.tracks.length).padStart(2,'0'):'TRK --/--';
  lcdTrack.textContent=t<volShownUntil?'VOL '+String(Math.round(engine.volume*100)).padStart(3,'\u00a0')
    :S.decoding?trk+' \u00b7 DECODING':trk;
  lcdTitle.classList.toggle('blink',S.disc==='loading-in'||S.disc==='loading-out');
  lcdTime.classList.toggle('blink',inPlayer&&!spin&&!S.decoding&&cur>0); // paused, not stopped
  playBtn.classList.toggle('on',spin);
  lcdTime.textContent=!inPlayer?'00:00':S.decoding?'--:--':fmt(cur);
  tot.textContent=inPlayer&&len?fmt(len):'00:00';
  const pct=len?cur/len*100:0;
  fill.style.width=pct+'%';rail.setAttribute('aria-valuenow',Math.round(pct));
  playicon.setAttribute('d',spin?'M6 5h4v14H6zM14 5h4v14h-4z':'M7 4.5v15l12-7.5z');
  requestAnimationFrame(loop);
}

/* ---------- boot ---------- */
(async()=>{
  updateButtons();
  note('Loading library\u2026');
  const n=await runImport(o=>loadLibrary(o));
  // albums remembered from earlier visits (folders the user picked or dropped)
  const ids=new Set(ALBUMS.map(a=>a.id));
  const mem=sortAlbums(await prepAll((await loadAlbums()).filter(r=>!ids.has(r.id))));
  if(mem.length){
    const cur=n?alb():null;
    ALBUMS=sortAlbums(ALBUMS.concat(mem));
    S.ai=cur?ALBUMS.indexOf(cur):0;
    if(!cur)P.pal=ALBUMS[0].pal.map(c=>c.slice());
    renderRack();syncCase();setCaseOpen(false);
  }else if(!n){
    ALBUMS=sortAlbums(await prepAll(demoAlbums()));
    P.pal=ALBUMS[0].pal.map(c=>c.slice());
    renderRack();syncCase();setCaseOpen(false);
  }
  refreshOffline();
  const how=canPickHandles?'Reconnect your music folder':'Choose your music folder again';
  note(mem.length
    ?`${nf.format(mem.length)} album${mem.length>1?'s':''} remembered from last time. ${how} to play ${mem.length>1?'them':'it'}.`
    :n?`${nf.format(n)} album${n>1?'s':''} in your library. Drop more folders onto the player or use + above the rack.`
    :'Showing demo albums (no audio). Drop a music folder onto the player, or use + above the rack.');
  ensureLoop();
})();
