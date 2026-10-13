export class GameAudio {
  constructor(){this.context=null;this.ready=null;this.buffers=new Map();this.volume=.55;this.muted=false;this.events={shot:0,step:0};}
  init(){
    if(!this.context){
      const Ctx=window.AudioContext||window.webkitAudioContext;if(!Ctx)return Promise.resolve();
      this.context=new Ctx();const c=this.context;
      this.master=c.createGain();this.master.gain.value=this.muted?0:this.volume;
      const compressor=c.createDynamicsCompressor();compressor.threshold.value=-18;compressor.ratio.value=5;compressor.attack.value=.003;compressor.release.value=.15;
      this.mix=c.createGain();this.mix.connect(compressor);compressor.connect(this.master);this.master.connect(c.destination);
      this.room=c.createConvolver();const impulse=c.createBuffer(2,c.sampleRate*.42,c.sampleRate);
      for(let ch=0;ch<2;ch++){const data=impulse.getChannelData(ch);for(let i=0;i<data.length;i++)data[i]=(Math.random()*2-1)*Math.pow(1-i/data.length,3)*.23;}
      this.room.buffer=impulse;const wet=c.createGain();wet.gain.value=.18;this.room.connect(wet);wet.connect(this.mix);
      this.ready=Promise.all(['rifle-1','rifle-2','rifle-3','step-1','step-2','step-3'].map(async name=>{try{const r=await fetch(`/assets/audio/${name}.wav`);if(!r.ok)throw new Error(name);this.buffers.set(name,await c.decodeAudioData(await r.arrayBuffer()));}catch(error){console.warn('Audio sample unavailable',name);}}));
    }
    if(this.context.state==='suspended')this.context.resume().catch(()=>{});
    return this.ready;
  }
  setVolume(value){this.volume=Math.max(0,Math.min(1,value));if(this.master)this.master.gain.setTargetAtTime(this.muted?0:this.volume,this.context.currentTime,.02);}
  toggleMute(){this.muted=!this.muted;if(this.master)this.master.gain.setTargetAtTime(this.muted?0:this.volume,this.context.currentTime,.02);return this.muted;}
  listener(position,direction){if(!this.context)return;const l=this.context.listener;if(l.positionX){l.positionX.value=position.x;l.positionY.value=position.y;l.positionZ.value=position.z;l.forwardX.value=direction.x;l.forwardY.value=direction.y;l.forwardZ.value=direction.z;l.upX.value=0;l.upY.value=1;l.upZ.value=0;}else{l.setPosition(position.x,position.y,position.z);l.setOrientation(direction.x,direction.y,direction.z,0,1,0);}}
  play(name,volume,position,rate=1){
    const c=this.context,buffer=this.buffers.get(name);if(!c||c.state!=='running'||!buffer||this.muted)return;
    const src=c.createBufferSource();src.buffer=buffer;src.playbackRate.value=rate;const gain=c.createGain();gain.gain.value=volume;
    src.connect(gain);let output=gain,panner;
    if(position){panner=c.createPanner();panner.panningModel='HRTF';panner.distanceModel='inverse';panner.refDistance=3;panner.maxDistance=80;panner.rolloffFactor=1.3;panner.positionX.value=position.x;panner.positionY.value=position.y??1;panner.positionZ.value=position.z;gain.connect(panner);output=panner;}
    output.connect(this.mix);output.connect(this.room);src.onended=()=>{src.disconnect();gain.disconnect();panner?.disconnect();};src.start();
  }
  shot(position=null){this.events.shot++;this.play(`rifle-${1+Math.floor(Math.random()*3)}`,position?1.0:.82,position,.96+Math.random()*.08);}
  step(position=null,sprinting=false){this.events.step++;this.play(`step-${1+Math.floor(Math.random()*3)}`,position?.8:(sprinting?.43:.32),position,.94+Math.random()*.13);}
  click(){if(!this.context||this.context.state!=='running'||this.muted)return;const c=this.context,o=c.createOscillator(),g=c.createGain();o.type='triangle';o.frequency.setValueAtTime(280,c.currentTime);o.frequency.exponentialRampToValueAtTime(90,c.currentTime+.04);g.gain.setValueAtTime(.09,c.currentTime);g.gain.exponentialRampToValueAtTime(.001,c.currentTime+.05);o.connect(g);g.connect(this.mix);o.start();o.stop(c.currentTime+.05);o.onended=()=>{o.disconnect();g.disconnect();};}
}
