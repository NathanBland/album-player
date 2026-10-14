/* Cover art helpers: square-cropping real covers, placeholder art for coverless albums,
   and the generated demo albums shown when the library is empty. */
const SIZE=512;
const rnd=seed=>{let s=seed>>>0;return()=>(s=(s*1664525+1013904223)>>>0)/4294967296;};
const makeArt=draw=>{const c=document.createElement('canvas');c.width=c.height=SIZE;draw(c.getContext('2d'),SIZE);return c;};

export function loadImage(src){
  return new Promise((res,rej)=>{const i=new Image();i.decoding='async';i.onload=()=>res(i);i.onerror=rej;i.src=src;});
}

/* Center-crop any image to a square canvas so the case, disc label and palette all see the same pixels. */
export function squareArt(img){
  return makeArt((g,S)=>{
    const w=img.naturalWidth||img.width,h=img.naturalHeight||img.height,s=Math.min(w,h);
    g.drawImage(img,(w-s)/2,(h-s)/2,s,s,0,0,S,S);
  });
}

const hash=str=>{let h=2166136261;for(const ch of str){h^=ch.codePointAt(0);h=Math.imul(h,16777619);}return h>>>0;};

export function placeholderArt(title,artist=''){
  const h=hash(title+'\u0000'+artist),r=rnd(h),hue=h%360;
  return makeArt((g,S)=>{
    const gr=g.createLinearGradient(0,0,S,S);
    gr.addColorStop(0,`hsl(${hue} 55% 22%)`);gr.addColorStop(1,`hsl(${(hue+50)%360} 60% 48%)`);
    g.fillStyle=gr;g.fillRect(0,0,S,S);
    for(let i=0;i<7;i++){
      g.fillStyle=`hsla(${(hue+r()*90)%360} 70% 70% / ${.08+r()*.12})`;
      g.beginPath();g.arc(r()*S,r()*S,S*(.1+r()*.35),0,7);g.fill();
    }
    const initials=title.split(/\s+/).filter(Boolean).slice(0,2).map(w=>w[0]).join('').toUpperCase()||'?';
    g.fillStyle='rgba(255,255,255,.9)';g.font=`650 ${S*.3}px ui-sans-serif,system-ui,sans-serif`;
    g.textAlign='center';g.textBaseline='middle';g.fillText(initials,S/2,S/2);
  });
}

/* ---------- generated demo covers ---------- */
const artAlpenglow=(g,S)=>{
  const r=rnd(11);const gr=g.createLinearGradient(0,0,0,S);
  gr.addColorStop(0,'#241a4d');gr.addColorStop(.42,'#b5407a');gr.addColorStop(.74,'#f28c4b');gr.addColorStop(1,'#ffc46b');
  g.fillStyle=gr;g.fillRect(0,0,S,S);
  g.fillStyle='#ffe3a3';g.beginPath();g.arc(S*.64,S*.55,S*.09,0,7);g.fill();
  [['#7a3270',.5],['#4a2664',.62],['#291a4c',.75],['#130f2d',.88]].forEach(([col,y0],li)=>{
    g.fillStyle=col;g.beginPath();g.moveTo(0,S);
    for(let x=0;x<=S;x+=8){g.lineTo(x,S*y0-Math.pow(Math.abs(Math.sin(x*.011*(li+1)+li*2.1)),.8)*S*.2-r()*9);}
    g.lineTo(S,S);g.closePath();g.fill();
  });
};
const artTarn=(g,S)=>{
  const gr=g.createLinearGradient(0,0,0,S);
  gr.addColorStop(0,'#06202b');gr.addColorStop(.55,'#0f4c5c');gr.addColorStop(1,'#48a9ae');
  g.fillStyle=gr;g.fillRect(0,0,S,S);
  g.fillStyle='#e9fbf7';g.beginPath();g.arc(S*.5,S*.28,S*.065,0,7);g.fill();
  for(let i=1;i<=11;i++){g.strokeStyle=`rgba(200,245,242,${.5-i*.035})`;g.lineWidth=2;g.beginPath();g.ellipse(S*.5,S*.66,i*S*.042,i*S*.014,0,0,7);g.stroke();}
  g.fillStyle='#04141b';g.beginPath();g.moveTo(0,S*.62);g.lineTo(S*.18,S*.5);g.lineTo(S*.3,S*.58);g.lineTo(S*.44,S*.44);g.lineTo(S*.62,S*.6);g.lineTo(S*.8,S*.48);g.lineTo(S,S*.6);g.lineTo(S,S*.64);g.lineTo(0,S*.64);g.fill();
};
const artTimberline=(g,S)=>{
  const r=rnd(5);const gr=g.createLinearGradient(0,0,0,S);
  gr.addColorStop(0,'#efd27f');gr.addColorStop(1,'#d9974a');g.fillStyle=gr;g.fillRect(0,0,S,S);
  g.fillStyle='#fbeab0';g.beginPath();g.arc(S*.3,S*.3,S*.12,0,7);g.fill();
  ['#4d7f4e','#356443','#244a33','#16301f'].forEach((col,row)=>{
    const by=S*(.6+row*.115),h=S*(.17+row*.04);g.fillStyle=col;
    for(let x=-10;x<S+30;x+=S*(.085-row*.008)){const j=r()*S*.03;g.beginPath();g.moveTo(x-S*.05,by);g.lineTo(x,by-h-j);g.lineTo(x+S*.05,by);g.closePath();g.fill();}
    g.fillRect(0,by-1,S,S-by+1);
  });
};
const artEmber=(g,S)=>{
  const r=rnd(9);g.fillStyle='#150b0c';g.fillRect(0,0,S,S);
  g.fillStyle='#e2452a';g.beginPath();g.arc(S*.5,S*.45,S*.27,0,7);g.fill();
  g.fillStyle='#f4a64f';g.beginPath();g.arc(S*.5,S*.45,S*.14,0,7);g.fill();
  g.fillStyle='#150b0c';
  for(let y=S*.16;y<S*.75;y+=13){g.fillRect(0,y,S,r()*6);}
  const cols=['#e2452a','#8a1c1c','#f4a64f'];
  for(let i=0;i<26;i++){g.fillStyle=cols[i%3];g.fillRect(r()*S,S*.14+r()*S*.62,20+r()*90,2+r()*5);}
  for(let i=0;i<1800;i++){g.fillStyle=`rgba(255,220,200,${r()*.12})`;g.fillRect(r()*S,r()*S,2,2);}
};

const t=(title,duration)=>({title,duration});
/* Demo albums have no audio: playback is simulated on a clock so the page still works with an empty library. */
export function demoAlbums(){
  return [
    {title:'Alpenglow',artist:'Halden Rowe',year:2024,bpm:84,art:makeArt(artAlpenglow),demo:true,
     tracks:[t('First Light on the Ridge',252),t('Switchback',228),t('Treeline',321),t('Saddle',177),t('Cornice',280),t('Alpenglow',365)]},
    {title:'Tarn',artist:'Ostra Vale',year:2023,bpm:62,art:makeArt(artTarn),demo:true,
     tracks:[t('Still Water',211),t('Glacial Polish',258),t('Reflection Pool',302),t('Outflow',206),t('Cold Lake',284)]},
    {title:'Timberline',artist:'Juniper & Ash',year:2025,bpm:104,art:makeArt(artTimberline),demo:true,
     tracks:[t('Bristlecone',219),t('Needle Ice',196),t('Switchgrass',248),t('Old Growth',334),t('Duff',187),t('Sap',241),t('Canopy Gap',262)]},
    {title:'Ember Static',artist:'Low Orbit Choir',year:2022,bpm:122,art:makeArt(artEmber),demo:true,
     tracks:[t('Re-entry',233),t('Sodium Hymn',271),t('Burnrate',204),t('Signal Loss',318),t('Afterglow Protocol',296)]},
  ];
}
