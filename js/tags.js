/* Minimal embedded-metadata reader: ID3v2.2/2.3/2.4 + ID3v1 (mp3, and ID3 chunks in AIFF/WAV), FLAC Vorbis
   comments/PICTURE, MP4 ilst (m4a/aac), RIFF INFO (wav).
   Returns {title, artist, albumArtist, album, year, track, trackTotal, disc, genre, picture:{mime,data}|null}.
   Walks frame/atom/chunk headers and reads only the bodies it needs, so a multi-MB embedded cover is
   skipped entirely unless {picture:true}. Works on a Blob/File or a URL (via HTTP Range). */

/* ---------- byte sources: a cached window over a random-access read ---------- */
const WINDOW=65536;
function windowed(size,fetchRange,first=null){
  let wStart=0,wBuf=first||new Uint8Array(0);
  return{size,async read(start,len){
    len=Math.max(0,Math.min(len,size-start));
    if(start>=wStart&&start+len<=wStart+wBuf.length)return wBuf.subarray(start-wStart,start-wStart+len);
    if(len>WINDOW)return fetchRange(start,len); // big bodies (pictures) bypass the window
    wStart=start;wBuf=await fetchRange(start,Math.min(WINDOW,size-start));
    return wBuf.subarray(0,len);
  }};
}
function blobSource(blob){
  return windowed(blob.size,async(start,len)=>new Uint8Array(await blob.slice(start,start+len).arrayBuffer()));
}
async function urlSource(url){
  let size=0;
  const fetchRange=async(start,len)=>{
    const res=await fetch(url,{headers:{Range:`bytes=${start}-${start+len-1}`}});
    if(!res.ok)throw new Error(`HTTP ${res.status}`);
    const buf=new Uint8Array(await res.arrayBuffer());
    const cr=res.headers.get('Content-Range');
    size=cr?+cr.split('/')[1]:buf.length;
    // A server that ignores Range sends the whole file; slice it ourselves.
    return res.status===206?buf:buf.subarray(start,start+len);
  };
  const head=await fetchRange(0,WINDOW); // also learns the file size
  return windowed(size,fetchRange,head);
}

/* ---------- helpers ---------- */
const latin1=new TextDecoder('latin1'),utf8=new TextDecoder('utf-8'),utf16le=new TextDecoder('utf-16le'),utf16be=new TextDecoder('utf-16be');
const str=(b,s=0,e=b.length)=>latin1.decode(b.subarray(s,e));
const u32=(b,o)=>((b[o]<<24)|(b[o+1]<<16)|(b[o+2]<<8)|b[o+3])>>>0;
const u24=(b,o)=>(b[o]<<16)|(b[o+1]<<8)|b[o+2];
const u32le=(b,o)=>(b[o]|(b[o+1]<<8)|(b[o+2]<<16)|(b[o+3]<<24))>>>0;
const synchsafe=(b,o)=>(b[o]&127)<<21|(b[o+1]&127)<<14|(b[o+2]&127)<<7|(b[o+3]&127);
const clean=s=>(s||'').replace(/\u0000+$/,'').replace(/\u0000/g,' / ').trim()||undefined;
function numPair(s){ const m=String(s||'').match(/(\d+)(?:\s*\/\s*(\d+))?/);return m?[+m[1],m[2]?+m[2]:undefined]:[undefined,undefined]; }
function yearOf(s){ const m=String(s||'').match(/\d{4}/);return m?+m[0]:undefined; }
function unsync(b){ // ID3 unsynchronisation: drop the 0x00 that follows every 0xFF
  const out=new Uint8Array(b.length);let n=0;
  for(let i=0;i<b.length;i++){out[n++]=b[i];if(b[i]===0xFF&&b[i+1]===0)i++;}
  return out.subarray(0,n);
}

/* ---------- ID3v2 ---------- */
function decodeText(enc,b){
  if(enc===1){ // UTF-16 with BOM
    if(b[0]===0xFE&&b[1]===0xFF)return utf16be.decode(b.subarray(2));
    if(b[0]===0xFF&&b[1]===0xFE)return utf16le.decode(b.subarray(2));
    return utf16le.decode(b);
  }
  if(enc===2)return utf16be.decode(b);
  if(enc===3)return utf8.decode(b);
  return latin1.decode(b);
}
// Index just past a terminator for the given text encoding, starting at i.
function skipTerminated(b,i,enc){
  if(enc===1||enc===2){ for(;i+1<b.length;i+=2)if(b[i]===0&&b[i+1]===0)return i+2; return b.length; }
  for(;i<b.length;i++)if(b[i]===0)return i+1; return b.length;
}

const ID3_KEYS={
  TT2:'title',TIT2:'title',TP1:'artist',TPE1:'artist',TP2:'albumArtist',TPE2:'albumArtist',
  TAL:'album',TALB:'album',TRK:'track',TRCK:'track',TPA:'disc',TPOS:'disc',
  TYE:'year',TYER:'year',TDRC:'year',TOR:'origYear',TORY:'origYear',TDOR:'origYear',TCO:'genre',TCON:'genre',
};

function frameInto(out,pics,id,data){
  if(id[0]==='T'){
    const v=clean(decodeText(data[0],data.subarray(1)));
    if(v&&out[ID3_KEYS[id]]===undefined)out[ID3_KEYS[id]]=v;
    return;
  }
  const enc=data[0];let i,mime;
  if(id==='PIC'){ const fmt=str(data,1,4).toUpperCase();mime=fmt==='PNG'?'image/png':'image/jpeg';i=4; }
  else{ const e=skipTerminated(data,1,0);mime=str(data,1,e-1)||'image/jpeg';i=e;if(!mime.includes('/'))mime='image/'+mime.toLowerCase().replace('jpg','jpeg'); }
  const type=data[i];
  i=skipTerminated(data,i+1,enc);
  pics.push({type,mime,data:data.slice(i)});
}

/* Walk frame headers through `read`, fetching bodies only for wanted frames. */
async function walkId3(read,ver,flags,p,end,wantPicture){
  if(flags&0x40){ const h=await read(p,4);p+=ver===4?synchsafe(h,0):u32(h,0)+4; } // extended header
  const idLen=ver===2?3:4,hdrLen=ver===2?6:10;
  const out={},pics=[];
  while(p+hdrLen<=end){
    const h=await read(p,hdrLen);
    const id=str(h,0,idLen);
    if(!/^[A-Z0-9]+$/.test(id))break; // padding
    const size=ver===2?u24(h,3):ver===4?synchsafe(h,4):u32(h,4);
    const fflags=ver===2?0:h[9];
    const bodyStart=p+hdrLen;p=bodyStart+size;
    if(size<=0||p>end)break;
    const wanted=(id[0]==='T'&&ID3_KEYS[id])||(wantPicture&&(id==='APIC'||id==='PIC'));
    if(!wanted)continue;
    // skip compressed/encrypted frames; step over grouping byte / data length indicator
    let skip=0;
    if(ver===3){ if(fflags&0xC0)continue; if(fflags&0x20)skip=1; }
    if(ver===4){ if(fflags&0x0C)continue; if(fflags&0x40)skip+=1; if(fflags&0x01)skip+=4; }
    let data=await read(bodyStart,size);
    if(ver===4&&(fflags&0x02))data=unsync(data);
    frameInto(out,pics,id,data.subarray(skip));
  }
  if(pics.length)out.picture=pics.find(x=>x.type===3)||pics[0];
  return out;
}

/* ID3v2 tag at `base` (0 for mp3, or inside an AIFF/WAV chunk). */
async function readId3(src,base,wantPicture){
  const head=await src.read(base,10);
  if(head.length<10||str(head,0,3)!=='ID3')return null;
  const ver=head[3],flags=head[5],size=synchsafe(head,6);
  const end=base+10+size+((flags&0x10)?10:0);
  if(ver<2||ver>4)return{tags:{},end};
  let read=(s,l)=>src.read(s,l),start=base+10,stop=base+10+size;
  if(ver<4&&(flags&0x80)){ // whole-tag unsynchronisation: byte offsets aren't real until undone
    const body=unsync(await src.read(base+10,size));
    read=async(s,l)=>body.subarray(s,s+l);start=0;stop=body.length;
  }
  return{tags:await walkId3(read,ver,flags,start,stop,wantPicture),end};
}

async function readId3v1(src){
  if(src.size<128)return{};
  const b=await src.read(src.size-128,128);
  if(str(b,0,3)!=='TAG')return{};
  const f=(s,e)=>clean(latin1.decode(b.subarray(s,e)).replace(/\u0000.*$/,''));
  const out={title:f(3,33),artist:f(33,63),album:f(63,93),year:f(93,97)};
  if(b[125]===0&&b[126])out.track=String(b[126]);
  return out;
}

/* ---------- AIFF / WAV: an embedded ID3 chunk, or RIFF LIST/INFO ---------- */
const INFO_KEYS={INAM:'title',IART:'artist',IPRD:'album',ICRD:'year',IPRT:'track',ITRK:'track',IGNR:'genre'};
async function readRiff(src,wantPicture){
  const h=await src.read(0,12);
  if(h.length<12)return null;
  const form=str(h,0,4),kind=str(h,8,12);
  const le=form==='RIFF'&&kind==='WAVE';
  if(!le&&!(form==='FORM'&&(kind==='AIFF'||kind==='AIFC')))return null;
  const out={};
  for(let p=12;p+8<=src.size;){
    const c=await src.read(p,8);
    const id=str(c,0,4),size=le?u32le(c,4):u32(c,4);
    if(id==='ID3 '||id==='id3 '){
      const r=await readId3(src,p+8,wantPicture);
      if(r)Object.assign(out,r.tags,{...out}); // INFO values already found win
    }else if(le&&id==='LIST'&&str(await src.read(p+8,4))==='INFO'){
      const b=await src.read(p+12,size-4);
      for(let q=0;q+8<=b.length;){
        const sid=str(b,q,q+4),sl=u32le(b,q+4),key=INFO_KEYS[sid];
        if(key&&out[key]===undefined)out[key]=clean(utf8.decode(b.subarray(q+8,q+8+sl)));
        q+=8+sl+(sl&1);
      }
    }
    p+=8+size+(size&1);
  }
  return out;
}

/* ---------- FLAC ---------- */
const VORBIS_KEYS={TITLE:'title',ARTIST:'artist',ALBUMARTIST:'albumArtist','ALBUM ARTIST':'albumArtist',ALBUM:'album',
  TRACKNUMBER:'track',TRACKTOTAL:'trackTotal',TOTALTRACKS:'trackTotal',DISCNUMBER:'disc',DATE:'year',YEAR:'year',ORIGINALDATE:'origYear',GENRE:'genre'};

function parseVorbisComment(b,out){
  let p=4+u32le(b,0);const n=u32le(b,p);p+=4;
  for(let i=0;i<n&&p+4<=b.length;i++){
    const len=u32le(b,p);p+=4;
    const s=utf8.decode(b.subarray(p,p+len));p+=len;
    const eq=s.indexOf('=');if(eq<0)continue;
    const key=VORBIS_KEYS[s.slice(0,eq).toUpperCase()];
    if(key&&out[key]===undefined)out[key]=clean(s.slice(eq+1));
  }
}
function parseFlacPicture(b){
  let p=0;const type=u32(b,p);p+=4;
  const ml=u32(b,p);p+=4;const mime=str(b,p,p+ml);p+=ml;
  const dl=u32(b,p);p+=4+dl+16;
  const len=u32(b,p);p+=4;
  return{type,mime,data:b.slice(p,p+len)};
}
async function readFlac(src,start,wantPicture){
  if(str(await src.read(start,4))!=='fLaC')return null;
  const out={},pics=[];let p=start+4;
  for(;;){
    const h=await src.read(p,4);if(h.length<4)break;
    const last=h[0]&0x80,type=h[0]&0x7F,len=u24(h,1);
    if(type===4)parseVorbisComment(await src.read(p+4,len),out);
    else if(type===6&&wantPicture)pics.push(parseFlacPicture(await src.read(p+4,len)));
    p+=4+len;if(last)break;
  }
  if(pics.length)out.picture=pics.find(x=>x.type===3)||pics[0];
  return out;
}

/* ---------- MP4 / M4A ---------- */
const MP4_KEYS={'©nam':'title','©ART':'artist',aART:'albumArtist','©alb':'album','©day':'year','©gen':'genre'};
async function atomAt(src,p,end){
  if(p+8>end)return null;
  const h=await src.read(p,16);
  let size=u32(h,0),hdr=8;
  if(size===1){size=u32(h,8)*2**32+u32(h,12);hdr=16;}
  else if(size===0)size=end-p;
  if(size<hdr)return null;
  return{type:str(h,4,8),start:p,hdr,size,end:Math.min(end,p+size)};
}
async function findAtom(src,start,end,type){
  for(let p=start;;){
    const a=await atomAt(src,p,end);
    if(!a)return null;
    if(a.type===type)return a;
    p=a.start+a.size;
  }
}
async function readMp4(src,wantPicture){
  if(str(await src.read(4,4))!=='ftyp')return null;
  const out={};
  const moov=await findAtom(src,0,src.size,'moov');if(!moov)return out;
  const udta=await findAtom(src,moov.start+moov.hdr,moov.end,'udta');if(!udta)return out;
  const meta=await findAtom(src,udta.start+udta.hdr,udta.end,'meta');if(!meta)return out;
  // iTunes 'meta' is a full box (4 bytes version/flags first); QuickTime-style isn't
  let first=meta.start+meta.hdr;
  if(str(await src.read(first+4,4))!=='hdlr')first+=4;
  const ilst=await findAtom(src,first,meta.end,'ilst');if(!ilst)return out;
  for(let p=ilst.start+ilst.hdr;;){
    const item=await atomAt(src,p,ilst.end);if(!item)break;
    p=item.start+item.size;
    const t=item.type,wanted=MP4_KEYS[t]||t==='trkn'||t==='disk'||(t==='covr'&&wantPicture&&!out.picture);
    if(!wanted)continue;
    const b=await src.read(item.start+item.hdr,item.size-item.hdr);
    let data=null;
    for(let q=0;q+8<=b.length;){const sz=u32(b,q);if(sz<8)break;if(str(b,q+4,q+8)==='data'){data={start:q+8,end:Math.min(b.length,q+sz)};break;}q+=sz;}
    if(!data)continue;
    const kind=u32(b,data.start)&0xFFFFFF,payload=b.subarray(data.start+8,data.end);
    if(MP4_KEYS[t])out[MP4_KEYS[t]]=clean(utf8.decode(payload));
    else if(t==='trkn'&&payload.length>=6){out.track=String((payload[2]<<8)|payload[3]);const n=(payload[4]<<8)|payload[5];if(n)out.trackTotal=String(n);}
    else if(t==='disk'&&payload.length>=4)out.disc=String((payload[2]<<8)|payload[3]);
    else if(t==='covr')out.picture={mime:kind===14?'image/png':'image/jpeg',data:payload.slice()};
  }
  return out;
}

/* ---------- entry point ---------- */
function normalize(t){
  const[track,total]=numPair(t.track),[disc]=numPair(t.disc);
  return{
    title:t.title,artist:t.artist,albumArtist:t.albumArtist,album:t.album,genre:t.genre,
    year:yearOf(t.origYear)||yearOf(t.year),
    track,trackTotal:total||(t.trackTotal?+t.trackTotal:undefined),disc,
    picture:t.picture?.data?.length?{mime:t.picture.mime,data:t.picture.data}:null,
  };
}

export async function readTags(source,{picture=true}={}){
  try{
    const src=typeof source==='string'?await urlSource(source):blobSource(source);
    const id3=await readId3(src,0,picture);
    let raw=await readFlac(src,id3?id3.end:0,picture);
    if(!raw&&!id3)raw=(await readMp4(src,picture))??(await readRiff(src,picture));
    if(!raw){
      raw=id3?.tags||{};
      if(!raw.title&&!raw.artist&&!raw.album)raw={...(await readId3v1(src)),...raw};
    }
    return normalize(raw);
  }catch(err){
    console.warn('readTags failed',err);
    return normalize({});
  }
}
