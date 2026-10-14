/* One <audio> element routed through an AnalyserNode so the disc and LCD can react to the real signal. */
export class AudioEngine{
  constructor(){
    this.el=new Audio();
    this.el.preload='auto';
    this.ctx=null;this.analyser=null;this.gain=null;this.freq=null;this.wave=null;
    this.volume=1;
  }
  /* Must be called from a user gesture: creates/resumes the AudioContext so later play() calls aren't blocked. */
  unlock(){
    if(!this.ctx){
      const AC=window.AudioContext||window.webkitAudioContext;
      if(!AC)return;
      this.ctx=new AC();
      const src=this.ctx.createMediaElementSource(this.el);
      this.analyser=this.ctx.createAnalyser();
      this.analyser.fftSize=1024;this.analyser.smoothingTimeConstant=.72;
      // analyser before gain: the meter shows the signal, not the volume setting
      this.gain=this.ctx.createGain();this.gain.gain.value=this.volume*this.volume;
      src.connect(this.analyser);this.analyser.connect(this.gain);this.gain.connect(this.ctx.destination);
      this.freq=new Uint8Array(this.analyser.frequencyBinCount);
      this.wave=new Uint8Array(this.analyser.fftSize);
    }
    if(this.ctx.state==='suspended')this.ctx.resume();
  }
  setVolume(v){
    this.volume=Math.max(0,Math.min(1,v));
    // perceptual curve; also works on iOS, which ignores <audio>.volume
    const g=this.volume*this.volume;
    if(this.gain)this.gain.gain.setTargetAtTime(g,this.ctx.currentTime,.02);
  }
  load(src){ if(this.el.getAttribute('src')!==src){this.el.src=src;this.el.load();} else this.el.currentTime=0; }
  unload(){ this.el.pause();this.el.removeAttribute('src');this.el.load(); }
  play(){ this.unlock();return this.el.play(); }
  pause(){ this.el.pause(); }
  get paused(){ return this.el.paused; }
  get time(){ return this.el.currentTime||0; }
  get duration(){ const d=this.el.duration;return Number.isFinite(d)?d:0; }
  seek(t){ if(this.duration)this.el.currentTime=Math.max(0,Math.min(this.duration-.05,t)); }

  /* 0..1 loudness from time-domain RMS. */
  level(){
    if(!this.analyser||this.el.paused)return 0;
    this.analyser.getByteTimeDomainData(this.wave);
    let sum=0;for(const v of this.wave){const x=(v-128)/128;sum+=x*x;}
    return Math.min(1,Math.sqrt(sum/this.wave.length)*3.2);
  }
  /* n log-spaced frequency bands, each 0..1. */
  bands(n){
    const out=new Array(n).fill(0);
    if(!this.analyser||this.el.paused)return out;
    this.analyser.getByteFrequencyData(this.freq);
    const lo=2,hi=Math.min(this.freq.length-1,420);
    for(let i=0;i<n;i++){
      const a=Math.floor(lo*Math.pow(hi/lo,i/n)),b=Math.max(a+1,Math.floor(lo*Math.pow(hi/lo,(i+1)/n)));
      let s=0;for(let k=a;k<b;k++)s+=this.freq[k];
      out[i]=Math.pow(s/(b-a)/255,1.4);
    }
    return out;
  }
}
