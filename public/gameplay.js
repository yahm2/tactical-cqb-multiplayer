export const MAX_HP = 200;
export const WEAPONS = Object.freeze({
  rifle: {name:'MK18 MOD 1 · 5.56 NATO', magazine:30, reserve:120, interval:84, body:34, head:100, reload:1250},
  pistol: {name:'P9 · 9MM · RED LASER', magazine:15, reserve:60, interval:200, body:26, head:75, reload:950}
});
export const BOUNDS = Object.freeze({minX:-24.25,maxX:24.25,minZ:-73.25,maxZ:35.25});
export const STEP_HEIGHT = .23;
export function overlaps(c,x,z,radius=.36){
  const dx=x-Math.max(c.minX,Math.min(x,c.maxX));
  const dz=z-Math.max(c.minZ,Math.min(z,c.maxZ));
  return dx*dx+dz*dz<radius*radius;
}
export function groundHeight(x,z,feet,colliders){
  let height=0;
  for(const c of colliders){
    if(x>=c.minX&&x<=c.maxX&&z>=c.minZ&&z<=c.maxZ&&c.maxY<=feet+STEP_HEIGHT)
      height=Math.max(height,c.maxY);
  }
  return height;
}
export function movementBlocked(x,z,feet,height,colliders,grounded){
  if(x<BOUNDS.minX||x>BOUNDS.maxX||z<BOUNDS.minZ||z>BOUNDS.maxZ)return true;
  const step=grounded?STEP_HEIGHT:.025;
  return colliders.some(c=>c.maxY>feet+step&&c.minY<feet+height-.03&&
    (c.stair?(x>=c.minX&&x<=c.maxX&&z>=c.minZ&&z<=c.maxZ):overlaps(c,x,z)));
}
export function tickStamina(state,wantsSprint,moving,dt){
  state.sprinting=!!(wantsSprint&&moving&&!state.exhausted&&state.stamina>0);
  if(state.sprinting){
    state.stamina=Math.max(0,state.stamina-dt/5*100);
    state.recoveryDelay=.9;
    if(state.stamina<=.001){state.stamina=0;state.exhausted=true;state.sprinting=false;}
  }else{
    state.recoveryDelay=Math.max(0,state.recoveryDelay-dt);
    if(state.recoveryDelay===0)state.stamina=Math.min(100,state.stamina+dt*20);
    if(state.stamina>=25)state.exhausted=false;
  }
}
export function tickVertical(state,dt,colliders,jump=false){
  const floor=groundHeight(state.x,state.z,state.y,colliders);
  if(state.grounded&&state.y-floor>.24)state.grounded=false;
  if(jump&&state.grounded){state.vy=5.9;state.grounded=false;}
  if(state.grounded){state.y=floor;state.vy=0;return;}
  const previous=state.y;
  state.vy-=16*dt;
  let next=previous+state.vy*dt;
  if(state.vy>0){
    for(const c of colliders){
      if(overlaps(c,state.x,state.z)&&previous+state.height<=c.minY+.01&&next+state.height>=c.minY){
        next=c.minY-state.height;state.vy=0;
      }
    }
  }else{
    let landing=0;
    for(const c of colliders){
      if(state.x>=c.minX&&state.x<=c.maxX&&state.z>=c.minZ&&state.z<=c.maxZ&&c.maxY<=previous+.025&&c.maxY>=next)
        landing=Math.max(landing,c.maxY);
    }
    if(next<=landing){next=landing;state.vy=0;state.grounded=true;}
  }
  state.y=Math.max(0,next);
}
