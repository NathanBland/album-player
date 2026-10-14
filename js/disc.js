import { rgb } from './palette.js';

function fitCanvas(c){
  const dpr=Math.min(2,window.devicePixelRatio||1),w=c.clientWidth||150,h=c.clientHeight||150;
  const pw=Math.round(w*dpr),ph=Math.round(h*dpr);
  if(c.width!==pw||c.height!==ph){c.width=pw;c.height=ph;}
  const g=c.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);return{g,w,h};
}

const TAU=Math.PI*2;

/* A printed CD: the cover covers the whole top side, leaving only a thin outer rim and the clear center ring. */
export function drawDisc(c,a,pal,rot,glossT,level){
  const{g,w,h}=fitCanvas(c);g.clearRect(0,0,w,h);
  const R=Math.min(w,h)/2-1;
  const artR=R*.985,clearR=R*.3,holeR=R*.125;
  g.save();g.translate(w/2,h/2);

  // metallic rim just beyond the print
  g.fillStyle='#c6cdd1';g.beginPath();g.arc(0,0,R,0,TAU);g.fill();

  // the print rotates with the disc; the center ring is left unprinted
  g.save();g.rotate(rot);
  g.beginPath();g.arc(0,0,artR,0,TAU);g.moveTo(clearR,0);g.arc(0,0,clearR,0,TAU);g.clip('evenodd');
  g.drawImage(a.art,-artR,-artR,artR*2,artR*2);
  // gentle falloff toward the edge and around the hub, so it reads as a curved, lacquered surface
  const shade=g.createRadialGradient(0,0,clearR,0,0,artR);
  shade.addColorStop(0,'rgba(0,0,0,.18)');shade.addColorStop(.18,'rgba(0,0,0,0)');shade.addColorStop(.85,'rgba(0,0,0,0)');shade.addColorStop(1,'rgba(0,0,0,.22)');
  g.fillStyle=shade;g.fillRect(-artR,-artR,artR*2,artR*2);
  g.restore();

  // light catching the lacquer: fixed to the light, not the disc, and a touch brighter with the music
  g.save();g.beginPath();g.arc(0,0,artR,0,TAU);g.moveTo(clearR,0);g.arc(0,0,clearR,0,TAU);g.clip('evenodd');
  const gx=Math.cos(glossT)*R*1.3,gy=Math.sin(glossT)*R*1.3;
  const sweep=g.createLinearGradient(gx-R*.5,gy-R*.5,gx+R*.5,gy+R*.5);
  sweep.addColorStop(0,'rgba(255,255,255,0)');sweep.addColorStop(.5,`rgba(255,255,255,${.12+level*.18})`);sweep.addColorStop(1,'rgba(255,255,255,0)');
  g.fillStyle=sweep;g.fillRect(-R,-R,R*2,R*2);
  g.restore();
  g.strokeStyle='rgba(0,0,0,.35)';g.lineWidth=1;g.beginPath();g.arc(0,0,artR,0,TAU);g.stroke();

  // clear plastic center: tinted faintly by the cover, with the stacking ring and spindle hole
  const ring=g.createRadialGradient(0,0,holeR,0,0,clearR);
  ring.addColorStop(0,'rgba(225,233,238,.42)');ring.addColorStop(1,rgb(pal[0],.22));
  g.fillStyle=ring;g.beginPath();g.arc(0,0,clearR,0,TAU);g.fill();
  g.strokeStyle='rgba(255,255,255,.4)';g.lineWidth=1;
  g.beginPath();g.arc(0,0,clearR-.5,0,TAU);g.stroke();
  g.beginPath();g.arc(0,0,(clearR+holeR)/2,0,TAU);g.stroke();
  // punch the spindle hole through, so whatever is underneath (tray hub, deck) shows
  g.save();g.globalCompositeOperation='destination-out';g.beginPath();g.arc(0,0,holeR,0,TAU);g.fill();g.restore();
  g.strokeStyle='rgba(255,255,255,.18)';g.beginPath();g.arc(0,0,holeR,0,TAU);g.stroke();

  g.strokeStyle='rgba(0,0,0,.4)';g.beginPath();g.arc(0,0,R-.5,0,TAU);g.stroke();
  g.restore();
}
