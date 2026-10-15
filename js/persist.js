/* Remembers the rack between visits, without storing any music.
   IndexedDB (not localStorage: a few hundred covers overflow its ~5 MB) keeps, per imported album,
   its names, a 512px cover JPEG and each track's path relative to the folder it came from. In
   Chromium it also keeps the picked/dropped folder handles, so a single click re-grants access.
   Everywhere else the user re-picks the same folder and tracks are relinked by path. */
const DB='album-player',VERSION=1;
let dbp=null;
function db(){
  dbp??=new Promise((res,rej)=>{
    const r=indexedDB.open(DB,VERSION);
    r.onupgradeneeded=()=>{
      r.result.createObjectStore('albums',{keyPath:'id'});
      r.result.createObjectStore('roots',{keyPath:'name'});
    };
    r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);
  });
  return dbp;
}
async function tx(store,mode,fn){
  const d=await db();
  return new Promise((res,rej)=>{
    const t=d.transaction(store,mode),s=t.objectStore(store);
    const out=fn(s);
    t.oncomplete=()=>res(out?.result??out);t.onerror=()=>rej(t.error);t.onabort=()=>rej(t.error);
  });
}
const safe=async(fn,fallback)=>{ try{ return await fn(); }catch(err){ console.warn('persist:',err);return fallback; } };

/* Only albums imported from the user's own folders are remembered (their tracks have paths). */
export const isRememberable=a=>!a.demo&&a.tracks.length&&a.tracks.every(t=>t.path);

function coverBlob(art){
  return new Promise(res=>art.toBlob(b=>res(b),'image/jpeg',.85));
}

export async function saveAlbum(a){
  if(!isRememberable(a))return;
  const cover=a.art?await coverBlob(a.art):null;
  const rec={
    id:a.id,title:a.title,artist:a.artist,year:a.year??null,genre:a.genre??null,
    placeholderTitle:a.placeholderTitle??null,cover,
    tracks:a.tracks.map(t=>({title:t.title,artist:t.artist??null,number:t.number??null,disc:t.disc??null,duration:t.duration??null,path:t.path})),
    savedAt:Date.now(),
  };
  await safe(()=>tx('albums','readwrite',s=>s.put(rec)));
}

/* Remembered albums as raw albums for prepAlbum: tracks have paths but no src until relinked. */
export async function loadAlbums(){
  const recs=await safe(()=>tx('albums','readonly',s=>s.getAll()),[]);
  return(recs||[]).map(r=>({
    id:r.id,title:r.title,artist:r.artist,year:r.year??undefined,genre:r.genre??undefined,
    placeholderTitle:r.placeholderTitle??undefined,
    cover:r.cover?URL.createObjectURL(r.cover):null,
    tracks:r.tracks.map(t=>({...t,number:t.number??undefined,disc:t.disc??undefined,duration:t.duration??undefined,src:undefined})),
  }));
}

export async function saveRoots(handles){
  for(const h of handles)if(h?.kind==='directory')await safe(()=>tx('roots','readwrite',s=>s.put({name:h.name,handle:h})));
}
export async function loadRoots(){
  return(await safe(()=>tx('roots','readonly',s=>s.getAll()),[]))||[];
}
export async function forgetAll(){
  await safe(()=>tx('albums','readwrite',s=>s.clear()));
  await safe(()=>tx('roots','readwrite',s=>s.clear()));
}
