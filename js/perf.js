/* Diagnostics overlay, loaded only with ?perf in the URL. Shows live fps and frame-time percentiles,
   and logs anything that stutters: slow frames, long tasks (with the script responsible, where the
   browser reports it) and audio stalls. Works on phones, where there's no console to read.
   "Copy log" puts the whole log on the clipboard for sharing. */
export function startPerf(getMedia){
  const box=document.createElement('div');
  box.style.cssText='position:fixed;right:8px;bottom:8px;z-index:9999;width:min(360px,calc(100vw - 16px));max-height:45vh;overflow:auto;'+
    'font:11px/1.35 ui-monospace,Menlo,monospace;color:#9fe8b0;background:rgba(6,16,10,.92);border:1px solid rgba(159,232,176,.3);border-radius:6px;padding:8px';
  const head=document.createElement('div');head.style.cssText='display:flex;justify-content:space-between;gap:8px;margin-bottom:4px';
  const stats=document.createElement('span');
  const copy=document.createElement('button');copy.textContent='Copy log';copy.style.cssText='font:inherit;color:inherit;background:none;border:1px solid currentColor;border-radius:3px;cursor:pointer';
  const list=document.createElement('div');
  head.append(stats,copy);box.append(head,list);document.body.append(box);

  const t0=performance.now(),log=[];
  const add=(kind,msg)=>{
    const line=`${((performance.now()-t0)/1000).toFixed(1).padStart(6)}s ${kind.padEnd(6)} ${msg}`;
    log.push(line);console.log('[perf]',line);
    const d=document.createElement('div');d.textContent=line;
    if(kind!=='media')d.style.color=kind==='frame'?'#ffd27a':'#ff8f7a';
    list.prepend(d);while(list.children.length>60)list.lastChild.remove();
  };
  copy.onclick=()=>navigator.clipboard?.writeText(log.join('\n')).then(()=>{copy.textContent='Copied';setTimeout(()=>copy.textContent='Copy log',1200);});

  // frames
  const win=[];let last=0;
  const tick=t=>{
    if(last){
      const d=t-last;win.push(d);if(win.length>120)win.shift();
      if(d>50&&!document.hidden)add('frame',`${Math.round(d)} ms frame`);
    }
    last=t;requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  setInterval(()=>{
    if(!win.length)return;
    const s=[...win].sort((a,b)=>a-b),q=p=>s[Math.floor(p*(s.length-1))].toFixed(1);
    stats.textContent=`${(1000/(win.reduce((a,b)=>a+b,0)/win.length)).toFixed(0)} fps · p50 ${q(.5)} · p95 ${q(.95)} · max ${s.at(-1).toFixed(0)} ms`;
  },500);

  // long frames with script attribution (Chromium), else plain long tasks
  try{
    new PerformanceObserver(l=>{for(const e of l.getEntries()){
      const scripts=(e.scripts||[]).map(s=>`${(s.sourceURL||'').split('/').pop()}:${s.sourceFunctionName||s.invoker||'?'} ${Math.round(s.duration)}ms`).join(', ');
      const layout=e.styleAndLayoutStart?` style+layout ${Math.round(e.startTime+e.duration-e.styleAndLayoutStart)}ms`:'';
      add('loaf',`${Math.round(e.duration)} ms${layout}${scripts?' · '+scripts:''}`);
    }}).observe({type:'long-animation-frame'});
  }catch{
    try{ new PerformanceObserver(l=>{for(const e of l.getEntries())add('task',`${Math.round(e.duration)} ms long task`);}).observe({type:'longtask'}); }catch{}
  }

  // audio: anything that interrupts playback
  const watched=new WeakSet();
  setInterval(()=>{
    const el=getMedia();if(!el||watched.has(el))return;watched.add(el);
    for(const ev of['waiting','stalled','error','emptied'])el.addEventListener(ev,()=>{
      const b=el.buffered,ahead=b.length?(b.end(b.length-1)-el.currentTime).toFixed(1):'0';
      add(ev==='waiting'||ev==='stalled'?'audio':'media',`${ev} at ${el.currentTime.toFixed(1)} s (buffered ahead ${ahead} s)`);
    });
    el.addEventListener('playing',()=>add('media',`playing ${decodeURIComponent((el.currentSrc||'').split('/').pop()).slice(0,40)}`));
  },500);
  add('media','perf overlay on');
}
