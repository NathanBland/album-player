/* Software decoding fallback for audio the browser can't play natively (e.g. MPEG Layer II in Chromium).
   The matching wasm-audio-decoders build is loaded on first use only, decodes in a Web Worker,
   and the PCM is wrapped as a WAV blob so the normal <audio> path (seek, analyser, media keys) still applies. */

// To support another codec: vendor its dist build into vendor/, add an entry here, and teach sniff() to recognize it.
const DECODERS={
  mpeg:        {script:'vendor/mpg123-decoder.min.js',     global:'mpg123-decoder',     worker:'MPEGDecoderWebWorker',      call:'decode'},
  flac:        {script:'vendor/flac-decoder.min.js',       global:'flac-decoder',       worker:'FLACDecoderWebWorker',      call:'decodeFile'},
  'ogg-vorbis':{script:'vendor/ogg-vorbis-decoder.min.js', global:'ogg-vorbis-decoder', worker:'OggVorbisDecoderWebWorker', call:'decodeFile'},
  'ogg-opus':  {script:'vendor/ogg-opus-decoder.min.js',   global:'ogg-opus-decoder',   worker:'OggOpusDecoderWebWorker',   call:'decodeFile'},
};

const synchsafe=(b,o)=>(b[o]&127)<<21|(b[o+1]&127)<<14|(b[o+2]&127)<<7|(b[o+3]&127);
const has=(b,s,at)=>{for(let i=0;i<s.length;i++)if(b[at+i]!==s.charCodeAt(i))return false;return true;};

/* Identify the codec from the first bytes: {codec, label, offset} where offset skips any leading ID3v2 tag. */
export function sniff(b){
  if(has(b,'FORM',0)&&(has(b,'AIFF',8)||has(b,'AIFC',8)))return{codec:'aiff',label:has(b,'AIFC',8)?'AIFF-C':'AIFF',offset:0};
  let o=0;
  if(has(b,'ID3',0))o=10+synchsafe(b,6)+((b[5]&0x10)?10:0);
  while(o<b.length&&b[o]===0)o++; // padding after the tag
  if(has(b,'fLaC',o))return{codec:'flac',label:'FLAC',offset:o};
  if(has(b,'OggS',o)){
    const body=o+27+b[o+26]; // first page payload, past the segment table
    if(has(b,'\x01vorbis',body))return{codec:'ogg-vorbis',label:'Ogg Vorbis',offset:o};
    if(has(b,'OpusHead',body))return{codec:'ogg-opus',label:'Ogg Opus',offset:o};
    if(has(b,'\x7fFLAC',body))return{codec:'flac',label:'Ogg FLAC',offset:o};
    return null;
  }
  // MPEG audio: 11-bit frame sync, valid version/layer, bitrate index not 15, sample-rate index not 3.
  for(let i=o,end=Math.min(b.length-4,o+8192);i<end;i++){
    if(b[i]!==0xFF||(b[i+1]&0xE0)!==0xE0)continue;
    const ver=(b[i+1]>>3)&3,layer=(b[i+1]>>1)&3,br=b[i+2]>>4,sr=(b[i+2]>>2)&3;
    if(ver===1||layer===0||br===15||sr===3)continue;
    return{codec:'mpeg',label:`MPEG Layer ${['','III','II','I'][layer]}`,offset:i};
  }
  return null;
}

function loadScript(src){
  return new Promise((res,rej)=>{
    const s=document.createElement('script');
    s.src=src;s.charset='UTF-8'; // the builds embed WASM in a string that must be read as UTF-8
    s.onload=res;s.onerror=()=>rej(new Error(`couldn't load ${src}`));
    document.head.append(s);
  });
}

const workers=new Map(); // codec -> Promise<{decoder, queue}>
function getWorker(codec){
  if(!workers.has(codec)){
    const d=DECODERS[codec];
    const p=(async()=>{
      if(!window[d.global])await loadScript(d.script);
      const decoder=new window[d.global][d.worker]();
      await decoder.ready;
      return{decoder,queue:Promise.resolve()};
    })();
    p.catch(()=>workers.delete(codec)); // allow a retry after a failed load
    workers.set(codec,p);
  }
  return workers.get(codec);
}

/* Decode a whole file's bytes to a WAV blob. Decodes on the same codec run one at a time. */
export async function decodeToWav(bytes){
  const info=sniff(bytes);
  if(!info)throw new Error('unrecognized audio format');
  if(info.codec==='aiff')return{blob:aiffToWav(bytes),label:info.label}; // plain PCM: no WASM needed
  const w=await getWorker(info.codec);
  const job=w.queue.then(async()=>{
    await w.decoder.reset();
    return w.decoder[DECODERS[info.codec].call](bytes.subarray(info.offset));
  });
  w.queue=job.catch(()=>{});
  const{channelData,samplesDecoded,sampleRate}=await job;
  if(!samplesDecoded)throw new Error(`${info.label} decoder produced no audio`);
  return{blob:encodeWav(channelData,samplesDecoded,sampleRate),label:info.label};
}

function encodeWav(channels,n,rate){
  const ch=channels.length,dataBytes=n*ch*2,buf=new ArrayBuffer(44+dataBytes),v=new DataView(buf);
  const tag=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));};
  tag(0,'RIFF');v.setUint32(4,36+dataBytes,true);tag(8,'WAVE');
  tag(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,ch,true);
  v.setUint32(24,rate,true);v.setUint32(28,rate*ch*2,true);v.setUint16(32,ch*2,true);v.setUint16(34,16,true);
  tag(36,'data');v.setUint32(40,dataBytes,true);
  const out=new Int16Array(buf,44,n*ch);
  for(let i=0,k=0;i<n;i++)for(let c=0;c<ch;c++){
    const s=Math.max(-1,Math.min(1,channels[c][i]));
    out[k++]=s<0?s*32768:s*32767;
  }
  return new Blob([buf],{type:'audio/wav'});
}

/* ---------- AIFF / AIFF-C: big-endian PCM, rewritten as a WAV with the same samples ---------- */
const u16be=(b,o)=>(b[o]<<8)|b[o+1];
const u32be=(b,o)=>((b[o]<<24)|(b[o+1]<<16)|(b[o+2]<<8)|b[o+3])>>>0;
const fourcc=(b,o)=>String.fromCharCode(b[o],b[o+1],b[o+2],b[o+3]);
function ext80(b,o){ // IEEE 754 80-bit extended (AIFF sample rate)
  const exp=((b[o]&0x7F)<<8|b[o+1])-16383,hi=u32be(b,o+2),lo=u32be(b,o+6);
  return(b[o]&0x80?-1:1)*(hi*2**(exp-31)+lo*2**(exp-63));
}
function aiffToWav(b){
  let ch=0,bits=0,rate=0,comp='NONE',data=null,len=0;
  for(let p=12;p+8<=b.length;){
    const id=fourcc(b,p),size=u32be(b,p+4),body=p+8;
    if(id==='COMM'){
      ch=u16be(b,body);bits=u16be(b,body+6);rate=Math.round(ext80(b,body+8));
      if(size>=22)comp=fourcc(b,body+18);
    }else if(id==='SSND'){
      const offset=u32be(b,body);data=body+8+offset;len=Math.min(size-8-offset,b.length-data);
    }
    p=body+size+(size&1);
  }
  if(!ch||!rate||data===null)throw new Error('AIFF without sound data');
  const float=/^fl(32|64)$/i.test(comp),swap=comp!=='sowt'; // sowt is already little-endian
  if(!float&&!/^(NONE|twos|sowt|in(16|24|32))$/i.test(comp))throw new Error(`unsupported AIFF-C compression "${comp}"`);
  if(float)bits=/64/.test(comp)?64:32;
  const bps=Math.ceil(bits/8),frames=Math.floor(len/(bps*ch)),dataBytes=frames*bps*ch;
  const buf=new ArrayBuffer(44+dataBytes),v=new DataView(buf),out=new Uint8Array(buf,44);
  const tag=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));};
  tag(0,'RIFF');v.setUint32(4,36+dataBytes,true);tag(8,'WAVE');
  tag(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,float?3:1,true);v.setUint16(22,ch,true);
  v.setUint32(24,rate,true);v.setUint32(28,rate*ch*bps,true);v.setUint16(32,ch*bps,true);v.setUint16(34,bps*8,true);
  tag(36,'data');v.setUint32(40,dataBytes,true);
  const src=b.subarray(data,data+dataBytes);
  if(bps===1)for(let i=0;i<dataBytes;i++)out[i]=(src[i]+128)&255; // AIFF 8-bit is signed, WAV 8-bit unsigned
  else if(!swap)out.set(src);
  else for(let i=0;i<dataBytes;i+=bps)for(let k=0;k<bps;k++)out[i+k]=src[i+bps-1-k];
  return new Blob([buf],{type:'audio/wav'});
}
