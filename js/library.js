/* Album sources: the scanned albums/ folder (via library.json) and folders the user drops or picks.
   Both become "folder records"; buildAlbums() then groups tracks by their embedded tags, so messy
   libraries (Artist/Album, Artist/loose songs, Disc 1/Disc 2 folders, stray tracks) come out as real albums:
     - tagged with an album  -> grouped by (album artist || artist, album), wherever the files live
     - tagged, but no album  -> one "Singles" album per artist
     - no usable tags at all -> grouped by folder, named from the folder and file names */
import { readTags } from './tags.js';

const AUDIO_RE=/\.(mp3|m4a|aac|flac|wav|aiff?|ogg|oga|opus|webm)$/i;
const IMAGE_RE=/\.(jpe?g|png|webp|gif)$/i;
const COVER_NAMES=['cover','folder','front','album','art'];
const DISC_DIR=/^(?:disc|disk|cd|digital\s*media)\s*[-_.]?\s*(\d+)\b/i; // "Disc 1", "CD 02", "Digital Media 01"
const byName=(a,b)=>a.localeCompare(b,undefined,{numeric:true,sensitivity:'base'});
const stem=name=>name.replace(/\.[^.]+$/,'');
const fold=s=>String(s||'').normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().replace(/\s+/g,' ').trim();
const parentOf=dir=>dir.split('/').slice(0,-1).join('/');
const baseOf=dir=>dir.split('/').pop()||'';
/* An album's home folder: a "Disc N" folder belongs to its parent. */
const albumHome=dir=>DISC_DIR.test(baseOf(dir))?parentOf(dir):dir;

/* "03 - Song.mp3", "1-03. Song.flac", "03_Song.m4a", "Artist - Album - 03 - Song.flac" -> "Song" */
export function trackTitle(name){
  const base=stem(name);
  const named=base.match(/^.+? - (?:.+? - )?(?:\d+-)?\d{1,3} - (.+)$/); // "Artist - [Album - ]NN - Title"
  const s=(named?named[1]:base).replace(/^\s*(?:\d+-)?\d{1,3}(?:\s*[-._)]+\s*|\s+)/,'').replace(/_/g,' ').trim();
  return s||base;
}

/* "Artist - Album (2024)" -> {artist, title, year} */
export function parseAlbumFolder(name){
  let year=null;
  const ym=name.match(/\s*[\[(](\d{4})[\])]\s*$/);
  if(ym){year=+ym[1];name=name.slice(0,ym.index);}
  const m=name.match(/^(.+?)\s+-\s+(.+)$/);
  return m?{artist:m[1].trim(),title:m[2].trim(),year}:{artist:'Unknown artist',title:name.trim(),year};
}

/* Folder-name fallback for untagged files. "Artist/Album (2024)" layouts get the artist from the parent,
   unless the parent is just the library folder itself ("Music/Album"). */
const LIBRARY_DIR=/^(?:my )?(?:music|itunes(?: media)?|library|audio|songs|media|downloads|albums?|collection|mp3s?|flacs?)$/i;
function folderMeta(name,parentName){
  const m=parseAlbumFolder(name);
  if(m.artist==='Unknown artist'&&parentName&&!LIBRARY_DIR.test(parentName))m.artist=parentName;
  return m;
}
const leadingNumber=file=>{ const m=file.match(/^(?:\d+-)?(\d{1,3})(?=[\s._-])/);return m?+m[1]:undefined; };

/* A conventionally named image, or the only image in the folder, is taken as the cover (`named`).
   With several unnamed images (booklet scans etc.) embedded art wins and the first image is only a fallback. */
const THUMB=/(?:^albumartsmall$|_small$|thumb)/i; // Windows Media Player's 75px AlbumArtSmall.jpg etc.
function pickCover(images){
  if(!images.length)return null;
  const lower=f=>stem(f.name).toLowerCase();
  for(const n of COVER_NAMES){const hit=images.find(f=>lower(f)===n);if(hit)return{file:hit,named:true};}
  const large=images.find(f=>/^albumart_.*_large$/.test(lower(f)));
  if(large)return{file:large,named:true};
  const full=images.filter(f=>!THUMB.test(lower(f))).sort((a,b)=>byName(a.name,b.name));
  if(full.length)return{file:full[0],named:full.length===1};
  return{file:images.slice().sort((a,b)=>byName(a.name,b.name))[0],named:false}; // only thumbnails: last resort
}

/* Most common non-empty value (first seen wins ties, keeping the original spelling). */
function mode(values,key=v=>v){
  const counts=new Map();let best,n=0;
  for(const v of values){
    if(v==null||v==='')continue;
    const k=key(v),c=(counts.get(k)||0)+1;counts.set(k,c);
    if(c>n){n=c;best=v;}
  }
  return best;
}

export async function pool(items,limit,fn){
  const out=new Array(items.length);let next=0;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{ while(next<items.length){const i=next++;out[i]=await fn(items[i],i);} }));
  return out;
}

/* ---------- grouping, streamed ---------- */
/* folders: [{dir, meta:{artist,title,year}, cover:{src,named}|null, overrides,
              tracks:[{read: File|URL, src: URL, title, file}]}]
   Albums stream out as they're found: folders are read one album home at a time ("Disc N" folders
   travel with their parent), and onAlbum(album, 'add'|'update') fires as soon as a home's tracks are
   grouped. An album that gains tracks later (a Singles case, a stray album track elsewhere) fires
   'update' with the same object. Awaiting onAlbum applies backpressure.
   onProgress({tracksDone, tracksTotal, homesDone, homesTotal, albums}) is throttled to ~10/s. */
export async function buildAlbums(folders,{onProgress=()=>{},onAlbum=()=>{}}={}){
  const homes=new Map();
  for(const f of folders){ const h=albumHome(f.dir);if(!homes.has(h))homes.set(h,[]);homes.get(h).push(f); }
  const P={tracksDone:0,tracksTotal:0,homesDone:0,homesTotal:homes.size,albums:0};
  for(const f of folders)P.tracksTotal+=f.tracks.length;
  let lastTick=0;
  const tick=force=>{ const n=performance.now();if(force||n-lastTick>100){lastTick=n;onProgress({...P});} };
  tick(true);

  const groups=new Map();
  const publish=async G=>{
    const fresh=!G.album;
    const a=await albumFromGroup(G,fresh?undefined:G.album.cover); // keep the cover once chosen
    a.id=G.key;
    if(fresh){ G.album=a;P.albums++; }else Object.assign(G.album,a);
    await onAlbum(G.album,fresh?'add':'update');
  };
  await pool([...homes.values()],3,async fs=>{
    const items=[];
    for(const f of fs)for(const t of f.tracks)items.push({...t,folder:f});
    await pool(items,3,async it=>{ it.tags=await readTags(it.read,{picture:false});P.tracksDone++;tick(); });
    const touched=[];
    for(const g of groupItems(items).values()){
      let G=groups.get(g.key);
      if(G)G.items.push(...g.items); else{ G={...g,chain:Promise.resolve()};groups.set(g.key,G); }
      G.chain=G.chain.then(()=>publish(G)).catch(err=>console.warn('album failed',G.key,err));
      touched.push(G.chain);
    }
    await Promise.all(touched);
    P.homesDone++;tick(true);
  });
  tick(true);
  return [...groups.values()].map(g=>g.album).filter(Boolean)
    .sort((a,b)=>byName(a.artist+'\u0000'+a.title,b.artist+'\u0000'+b.title));
}

/* Group one batch of tagged items: album tag, else Singles per artist, else by folder. */
function groupItems(items){
  const groups=new Map();
  const add=(key,kind,it)=>{ let g=groups.get(key);if(!g){g={key,kind,items:[]};groups.set(key,g);}g.items.push(it); };
  for(const it of items){
    const t=it.tags;
    if(t.album)add(`album\u0000${fold(t.album)}\u0000${fold(t.albumArtist||t.artist)}`,'album',it);
    else if(t.title||t.artist)add(`singles\u0000${fold(t.artist||folderArtist(it.folder))}`,'singles',it);
    else add(`folder\u0000${albumHome(it.folder.dir)}`,'folder',it);
  }
  mergeCompilations(groups);
  return groups;
}

function folderArtist(folder){
  return folder.meta.artist!=='Unknown artist'?folder.meta.artist:(baseOf(albumHome(folder.dir))||'Unknown artist');
}

/* Compilations without an album-artist tag split by track artist; put them back together when the
   pieces share an album name and an album folder. */
function mergeCompilations(groups){
  const buckets=new Map();
  for(const g of groups.values()){
    if(g.kind!=='album'||g.items.some(it=>it.tags.albumArtist))continue;
    const homes=new Set(g.items.map(it=>albumHome(it.folder.dir)));
    if(homes.size!==1)continue;
    const k=fold(g.items[0].tags.album)+'\u0000'+[...homes][0];
    if(!buckets.has(k))buckets.set(k,[]);
    buckets.get(k).push(g);
  }
  for(const[first,...rest]of buckets.values())for(const g of rest){ first.items.push(...g.items);groups.delete(g.key); }
}

async function albumFromGroup(g,keepCover){
  const its=g.items,T=its.map(it=>it.tags);
  const folders=[...new Set(its.map(it=>it.folder))];
  const homes=new Set(folders.map(f=>albumHome(f.dir)));
  const oneHome=homes.size===1;
  let title,artist,year;
  if(g.kind==='album'){
    title=mode(T.map(t=>t.album),fold);
    const artists=new Set(T.map(t=>fold(t.artist)).filter(Boolean));
    artist=mode(T.map(t=>t.albumArtist),fold)||(artists.size>1?'Various Artists':mode(T.map(t=>t.artist)))||folders[0].meta.artist;
    year=mode(T.map(t=>t.year))||folders[0].meta.year;
  }else if(g.kind==='singles'){
    title='Singles';
    artist=mode(T.map(t=>t.artist),fold)||folderArtist(folders[0]);
    year=undefined;
  }else{
    ({title,artist,year}=folders[0].meta);
  }

  const tracks=its.map(it=>({
    title:it.tags.title||it.title,artist:it.tags.artist,src:it.src,
    number:it.tags.track??(g.kind==='folder'?leadingNumber(it.file):undefined),
    disc:it.tags.disc??(+(baseOf(it.folder.dir).match(DISC_DIR)?.[1])||undefined),
    _k:it.folder.dir+'/'+it.file,
  }));
  if(g.kind==='singles')tracks.sort((a,b)=>byName(a._k,b._k));
  else tracks.sort((a,b)=>(a.disc||1)-(b.disc||1)||(a.number??Infinity)-(b.number??Infinity)||byName(a._k,b._k));
  tracks.forEach(t=>delete t._k);

  // Cover: a named folder image, then embedded art, then any folder image. "Singles" mix albums, so
  // they only take a named image from their one folder, else a generated placeholder.
  let cover=keepCover??null;
  const named=folders.find(f=>f.cover?.named);
  if(keepCover!==undefined){
    // an update: the cover was settled when the album first appeared
  }else if(g.kind==='singles'){
    if(oneHome&&named)cover=named.cover.src;
  }else{
    if(named&&oneHome)cover=named.cover.src;
    if(!cover)cover=await embeddedCover(its);
    if(!cover)cover=(named||folders.find(f=>f.cover))?.cover.src||null;
  }

  const album={title,artist,year,genre:mode(T.map(t=>t.genre),fold),cover,tracks};
  if(g.kind==='singles')album.placeholderTitle=artist; // initials of the artist, not "S"
  // album.json overrides (library only) apply when the album is that folder's album
  const overrides=oneHome?folders.find(f=>f.overrides&&Object.keys(f.overrides).length)?.overrides:null;
  return overrides?{...album,...overrides}:album;
}

/* Embedded art from the first few tracks (album order), reading picture bytes only here. */
async function embeddedCover(its){
  for(const it of its.slice(0,3)){
    const t=await readTags(it.read,{picture:true});
    if(t.picture)return URL.createObjectURL(new Blob([t.picture.data],{type:t.picture.mime}));
  }
  return null;
}

/* ---------- sources ---------- */
export async function loadLibrary(opts){
  let recs;
  try{
    const res=await fetch('albums/library.json',{cache:'no-store'});
    if(!res.ok)return[];
    recs=(await res.json()).albums;
    if(!Array.isArray(recs)||!recs.length)return[];
  }catch{ return[]; }
  const folders=recs.map(r=>({
    dir:r.dir??'',
    meta:{artist:r.artist,title:r.title,year:r.year},
    cover:r.cover?{src:r.cover,named:!!r.coverNamed}:null,
    overrides:r.overrides||{},
    tracks:r.tracks.map(t=>({read:t.src,src:t.src,title:t.title,file:t.file||t.src})),
  }));
  return buildAlbums(folders,opts);
}

/* entries: [{file, path}] where path is relative ("Music/Artist/Album/01 Song.mp3"). */
export async function albumsFromEntries(entries,opts){
  const dirs=new Map();
  for(const{file,path}of entries){
    const parts=path.split('/').filter(Boolean);
    if(parts.some(p=>p.startsWith('.')))continue; // dotfiles, AppleDouble "._song.mp3", .Trashes…
    const dir=parts.slice(0,-1).join('/');
    let d=dirs.get(dir);if(!d){d={dir,audio:[],images:[]};dirs.set(dir,d);}
    if(AUDIO_RE.test(file.name))d.audio.push(file);
    else if(IMAGE_RE.test(file.name))d.images.push(file);
  }
  const folders=[];
  for(const d of dirs.values()){
    if(!d.audio.length)continue;
    const inDisc=DISC_DIR.test(baseOf(d.dir));
    // "Album/Disc 1": name and cover come from the album folder above
    const cover=pickCover(d.images)||(inDisc?pickCover(dirs.get(parentOf(d.dir))?.images||[]):null);
    const home=inDisc?parentOf(d.dir):d.dir;
    folders.push({
      dir:d.dir,
      meta:folderMeta(baseOf(home)||'Loose tracks',baseOf(parentOf(home))),
      cover:cover?{src:URL.createObjectURL(cover.file),named:cover.named}:null,
      overrides:{},
      tracks:d.audio.sort((a,b)=>byName(a.name,b.name)).map(f=>({read:f,src:URL.createObjectURL(f),title:trackTitle(f.name),file:f.name})),
    });
  }
  return buildAlbums(folders,opts);
}

export function entriesFromInput(fileList){
  return[...fileList].map(file=>({file,path:file.webkitRelativePath||file.name}));
}

async function walk(entry,out){
  if(entry.isFile){
    const file=await new Promise((res,rej)=>entry.file(res,rej));
    out.push({file,path:entry.fullPath.replace(/^\//,'')});
  }else if(entry.isDirectory){
    if(entry.name.startsWith('.'))return; // don't descend into .Trashes, .Spotlight-V100, …
    const reader=entry.createReader();let batch;
    do{
      batch=await new Promise((res,rej)=>reader.readEntries(res,rej));
      for(const e of batch)await walk(e,out);
    }while(batch.length);
  }
}

export async function entriesFromDrop(dt){
  // Grab entries synchronously: the DataTransfer is emptied once the handler yields.
  const roots=[...dt.items].map(i=>i.webkitGetAsEntry?.()).filter(Boolean);
  if(!roots.length)return[...dt.files].map(file=>({file,path:file.name}));
  const out=[];
  for(const e of roots)await walk(e,out);
  return out;
}
