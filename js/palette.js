export const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
export const rgb=(c,a=1)=>`rgba(${c[0]|0},${c[1]|0},${c[2]|0},${a})`;
export const mix=(a,b,t)=>[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t];
const lum=c=>.2126*c[0]+.7152*c[1]+.0722*c[2];
const sat=c=>{const mx=Math.max(...c),mn=Math.min(...c);return mx?(mx-mn)/mx:0;};
const dist=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);

/* Pull a three-color palette out of a cover: bucket pixels, favor saturated and non-black buckets, keep distinct ones. */
export function analyze(art){
  const N=48,t=document.createElement('canvas');t.width=t.height=N;
  const g=t.getContext('2d',{willReadFrequently:true});g.drawImage(art,0,0,N,N);
  const d=g.getImageData(0,0,N,N).data,map=new Map();
  for(let i=0;i<d.length;i+=4){
    const r=d[i],gr=d[i+1],b=d[i+2],key=(r>>5)<<6|(gr>>5)<<3|(b>>5);
    let o=map.get(key);if(!o){o={n:0,r:0,g:0,b:0};map.set(key,o);}o.n++;o.r+=r;o.g+=gr;o.b+=b;
  }
  const list=[...map.values()].map(o=>{const c=[o.r/o.n,o.g/o.n,o.b/o.n];return{c,score:o.n*(.35+sat(c)*1.4)*(lum(c)<45?.15:1)};}).sort((a,b)=>b.score-a.score);
  const pal=[];
  for(const it of list){if(pal.every(p=>dist(p,it.c)>70))pal.push(it.c);if(pal.length===3)break;}
  if(!pal.length)pal.push([140,160,190]);
  while(pal.length<3)pal.push(mix(pal[pal.length-1],[255,255,255],.25));
  // Dominant = the bucket covering the most area (no saturation bias), for spines and liner notes.
  const top=[...map.values()].sort((a,b)=>b.n-a.n)[0];
  const dominant=top?[top.r/top.n,top.g/top.n,top.b/top.n]:pal[0];
  return{pal,dominant};
}

/* Black or white text, whichever reads better on c (WCAG relative luminance). */
export function inkFor(c){
  const lin=v=>{v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4);};
  const L=.2126*lin(c[0])+.7152*lin(c[1])+.0722*lin(c[2]);
  return L>.33?[24,20,16]:[248,244,236];
}
