(function () {
  'use strict';
  const T=THREE, scene=new T.Scene();scene.background=new T.Color(0x20272e);
  document.getElementById('toggleControls').onclick=e=>{
    const collapsed=e.target.parentElement.classList.toggle('collapsed');
    e.target.textContent=collapsed?'Show controls':'Hide controls';e.target.setAttribute('aria-expanded',String(!collapsed));
  };
  const camera=new T.PerspectiveCamera(38,innerWidth/innerHeight,.02,100);
  const renderer=new T.WebGLRenderer({antialias:true,logarithmicDepthBuffer:true});renderer.setSize(innerWidth,innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.outputEncoding=T.sRGBEncoding;
  renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1.2;
  document.body.appendChild(renderer.domElement);
  scene.add(new T.HemisphereLight(0xe1efff,0x777166,1.1));
  const key=new T.DirectionalLight(0xffdfbb,2.4);key.position.set(-3,6,5);scene.add(key);
  const rim=new T.DirectionalLight(0x99cbff,2);rim.position.set(3,3,-4);scene.add(rim);
  const grid=new T.GridHelper(20,40,0x596169,0x363f47);grid.position.y=-.28;scene.add(grid);
  const player=new T.Group();player.scale.setScalar(.45);scene.add(player);
  const visual=new T.Group();visual.rotation.y=Math.PI;player.add(visual);
  const mode=document.getElementById('pose'),scrub=document.getElementById('scrub'),status=document.getElementById('status');
  const requestedMotion=new URLSearchParams(location.search).get('motion');
  if(Array.from(mode.options).some(option=>option.value===requestedMotion))mode.value=requestedMotion;
  const seek=document.getElementById('seek'),rate=document.getElementById('rate');
  let controller,mixer,idleAction,walkAction,time=0,paused=false,theta=Math.PI+.35,phi=1.35,distance=innerWidth<700?6.5:4.4;
  const effects=[],clock=new T.Clock(),q=new T.Quaternion(),v=new T.Vector3();
  const axis=new T.Vector3(0,-1,0),up=new T.Vector3(0,1,0),thrust=new T.Vector3(),velocity=new T.Vector3();
  let lastState={},travel=0;
  const gaitSettings=window.GodmanMotionSettings||{walkSpeed:1.8,runSpeed:4.4};
  const gravity=9.81,jumpHeight=1.1,jumpVelocity=Math.sqrt(2*gravity*jumpHeight),jumpDuration=2*jumpVelocity/gravity;
  const landingHeight=1.2,landingTime=Math.sqrt(2*landingHeight/gravity);
  const sequenceDuration=()=>['transitions','reverse'].includes(mode.value)?8:mode.value==='fall'?1.2:4;
  const ease=(a,b,t)=>T.MathUtils.smoothstep(t,a,b);
  function impactPulse(t){return t<0?0:Math.sin(Math.min(1,t/.14)*Math.PI/2)*Math.exp(-Math.max(0,t-.14)*5);}
  function stateAt(t){
    const m=mode.value,s={grounded:true,speed:0,charge:0,landing:0,space:0,airTime:0,powered:false,brake:0,height:0,verticalSpeed:0,impactSpeed:0};
    if(m==='walk'||m==='run')s.speed=m==='walk'?gaitSettings.walkSpeed:gaitSettings.runSpeed;
    if(m==='transitions'){
      const walk=gaitSettings.walkSpeed,run=gaitSettings.runSpeed;
      s.speed=t<1?0:t<2?walk*ease(1,2,t):t<3?walk:t<4?T.MathUtils.lerp(walk,run,ease(3,4,t)):t<6?run:t<7?run*(1-ease(6,7,t)):0;
      s.stage=t<1?'Idle':t<2?'Start walking':t<3?'Walking':t<4?'Accelerate':t<6?'Running':t<7?'Decelerate':'Stopped';
    }
    if(m==='charge')s.charge=.95;
    if(m==='jump'){
      const air=Math.max(0,Math.min(jumpDuration,t-1)),contact=1+jumpDuration;
      s.grounded=t<1||t>=contact;s.charge=t<1?ease(0,1,t):0;
      s.height=s.grounded?0:Math.max(0,jumpVelocity*air-.5*gravity*air*air);
      s.verticalSpeed=s.grounded?0:jumpVelocity-gravity*air;
      s.airTime=s.grounded?0:air;s.landing=impactPulse(t-contact);s.impactSpeed=t>=contact?jumpVelocity:0;
      s.stage=t<1?'Prepare':t>=contact?'Land / recover':s.verticalSpeed>0?'Ascent':'Descent';
    }
    if(m==='land'){
      s.grounded=t>=landingTime;s.airTime=s.grounded?0:t;s.height=s.grounded?0:landingHeight-.5*gravity*t*t;
      s.verticalSpeed=s.grounded?0:-gravity*t;s.landing=impactPulse(t-landingTime);s.impactSpeed=s.grounded?gravity*landingTime:0;
      s.stage=s.grounded?'Absorb / recover':'Approach ground';
    }
    if(['fall','coast','hover','cruise','turn','reverse','brake','swim'].includes(m)){s.grounded=false;s.airTime=t;s.height=.55;}
    if(m==='fall'){s.height=8-.5*gravity*t*t;s.verticalSpeed=-gravity*t;}
    if(['coast','hover','cruise','turn','reverse','brake'].includes(m))s.space=1;
    s.powered=['hover','cruise','turn','reverse'].includes(m);s.brake=m==='brake'?1:0;
    if(m==='reverse'){
      s.powered=t<6;s.brake=t>=6&&t<7?1:0;
      s.flightYaw=t<3?0:t<4?-Math.PI/2:t<5?Math.PI/2:Math.PI;
      s.flightTilt=t<1?0:Math.PI/3;
      s.stage=t<1?'Hover':t<3?'Forward thrust':t<4?'Turn left':t<5?'Reverse right':t<6?'Reverse thrust':t<7?'Brake':'Coast';
    }
    s.throttle=Number(document.getElementById('flightPower').value);s.powered=s.powered&&s.throttle>.01;
    s.turn=m==='turn'?Math.sin(t*1.7):0;s.water=m==='swim';return s;
  }
  function step(dt,t){
    const s=stateAt(t);lastState=s;
    const original=mode.value==='sourcewalk';
    if(walkAction){walkAction.enabled=original;idleAction.enabled=!original;walkAction.timeScale=2.15;}
    mixer.update(dt);
    const flying=['cruise','turn','brake','reverse'].includes(mode.value);
    const pitch=flying?(mode.value==='brake'?.7:-1.15):0;
    const yaw=Number(document.getElementById('flightYaw').value)*Math.PI/180+s.turn*.7+(s.flightYaw||0);
    const tilt=(s.flightTilt===undefined?-pitch:s.flightTilt)+Number(document.getElementById('flightPitch').value)*Math.PI/180;
    thrust.set(Math.sin(yaw)*Math.sin(tilt),Math.cos(tilt),-Math.cos(yaw)*Math.sin(tilt));
    if(mode.value==='reverse'){
      if(s.powered)velocity.lerp(v.copy(thrust).multiplyScalar(10),1-Math.exp(-dt*2));
      else if(s.brake)velocity.multiplyScalar(Math.exp(-dt*3));
    }else velocity.copy(thrust).multiplyScalar(-10);
    q.identity();
    controller.orient(dt,q,up,thrust,velocity,s.grounded,s.water,s.space);
    player.position.y=s.height;
    travel+=dt*s.speed;grid.position.z=travel%.5;
    if(!original)controller.update(dt,s);player.updateMatrixWorld(true);
    for(const e of effects){
      e.locator.getWorldPosition(e.fx.position);
      e.locator.parent.getWorldQuaternion(q);
      v.copy(e.locator.userData.exhaustAxis).applyQuaternion(q);e.fx.quaternion.setFromUnitVectors(axis,v);
      const strength=Math.max(controller.throttle,controller.brake*.65)*controller.nozzleShare(e.type==='leg'?'foot':'hand',e.locator.parent.name.startsWith('L')?1:-1);
      e.fx.visible=strength>.01;
      e.fx.userData.material.uniforms.strength.value=strength;
      e.fx.userData.material.uniforms.time.value=t;
    }
    const shown=cyclicMode()?t%sequenceDuration():t;
    status.textContent=(s.stage||mode.options[mode.selectedIndex].text)+' · '+shown.toFixed(2)+' / '+sequenceDuration().toFixed(1)+' s'+(s.speed?' · '+s.speed.toFixed(1)+' m/s':'');
  }
  new T.GLTFLoader().load('assets/character/rigged-astronaut.glb',gltf=>{
    const model=gltf.scene;
    model.traverse(o=>{if(o.isMesh){o.frustumCulled=false;for(const m of Array.isArray(o.material)?o.material:[o.material]){if(m.color&&m.map)m.color.set(0xc45a2a);m.transparent=false;m.opacity=1;m.side=T.FrontSide;}}});
    model.updateMatrixWorld(true);const box=new T.Box3().setFromObject(model),size=box.getSize(new T.Vector3());
    model.scale.setScalar(4.48/size.y);model.updateMatrixWorld(true);box.setFromObject(model);
    const center=box.getCenter(new T.Vector3());model.position.x-=center.x;model.position.z-=center.z;model.position.y+=-.62-box.min.y;
    visual.add(model);model.traverse(b=>{if(b.isBone)b.userData.motionBindQuaternion=b.quaternion.clone();});mixer=new T.AnimationMixer(model);
    const idle=gltf.animations.find(c=>c.name.toLowerCase()==='idle');if(idle)idleAction=mixer.clipAction(idle).play();mixer.update(0);
    const walk=gltf.animations.find(c=>c.name.toLowerCase()==='moon_walk');if(walk){walkAction=mixer.clipAction(walk).play();walkAction.enabled=false;}
    const bones={},all=[];model.traverse(o=>{if(o.isBone)all.push(o);});
    for(const name of ['L_Arm.10','L_Elbow.11','L_Wrist.12','R_Arm.44','R_Elbow.45','R_Wrist.46','L_Thigh.82','L_Knee.83','L_Ankle.84','R_Thigh.88','R_Knee.89','R_Ankle.90'])bones[name]=all.find(b=>b.name.startsWith(name.split('.')[0]));
    controller=new GodmanCharacterMotion(visual,bones);
    for(const c of controller.chains){const type=c.type==='arm'?'hand':'foot';const locator=GodmanRepulsorAnchor(visual,c.nodes[2],type);const fx=GodmanRepulsorPlume(type);scene.add(fx);effects.push({locator,fx,type:c.type});}
    document.getElementById('loading').textContent='Shared runtime '+window.GODMAN_MOTION_BUILD+' · model loaded';
    // Read-only diagnostic snapshot for the studio's UI and automated checks.
    window.motionStudioDiagnostics=()=>({build:window.GODMAN_MOTION_BUILD,time,duration:sequenceDuration(),state:{...lastState},
      bindings:{bones:all.length,chains:controller.chains.length,fingers:controller.runningFingers.length,spine:controller.groundTorso.length,
        sleeveHelpers:controller.chains.reduce((sum,c)=>sum+(c.segments||[]).length,0),kneeHelpers:controller.chains.filter(c=>c.kneeSupport).length},
      chains:controller.chains.map(c=>({type:c.type,side:c.side,reference:c.points.map(v=>v.toArray()),
        helpers:(c.segments||[]).map(s=>({name:s.bone.name,q:s.bone.quaternion.toArray()})),
        joints:c.nodes.map(n=>({q:n.quaternion.toArray(),position:visual.worldToLocal(n.getWorldPosition(new T.Vector3())).toArray()}))}))});
    reset();step(0,0);
  },undefined,e=>{document.getElementById('loading').textContent='Model failed to load';console.error(e);});
  function cyclicMode(){return !['jump','land','fall','transitions','reverse'].includes(mode.value);}
  function syncTime(){const shown=cyclicMode()?time%sequenceDuration():time;scrub.value=shown;seek.value=shown.toFixed(2);}
  function reset(){
    time=0;travel=0;velocity.set(0,0,0);scrub.max=seek.max=sequenceDuration();syncTime();
    if(controller){player.position.set(0,0,0);player.quaternion.identity();controller.reset();mixer.setTime(0);}
  }
  mode.onchange=()=>{reset();if(controller)step(0,0);};
  document.getElementById('replay').onclick=()=>{reset();if(controller)step(0,0);};
  document.getElementById('pause').onclick=()=>{paused=!paused;document.getElementById('pause').textContent=paused?'Play':'Pause';};
  document.getElementById('front').onclick=()=>{theta=Math.PI;phi=1.35;};
  document.getElementById('side').onclick=()=>{theta=Math.PI/2;phi=1.35;};
  function seekTo(target){
    paused=true;document.getElementById('pause').textContent='Play';
    target=Math.max(0,Math.min(sequenceDuration(),target));reset();
    if(controller){let simulated=0;while(simulated<target-1e-8){const h=Math.min(1/120,target-simulated);simulated+=h;step(h,simulated);}if(target===0)step(0,0);}
    time=target;syncTime();
  }
  scrub.oninput=()=>seekTo(Number(scrub.value));
  seek.oninput=e=>seekTo(Number(e.target.value)||0);
  rate.oninput=()=>{document.getElementById('rateValue').textContent=Number(rate.value).toFixed(1)+'×';};
  let drag=false,px=0,py=0;
  renderer.domElement.onpointerdown=e=>{drag=true;px=e.clientX;py=e.clientY;renderer.domElement.setPointerCapture(e.pointerId);};
  renderer.domElement.onpointerup=()=>drag=false;
  renderer.domElement.onpointermove=e=>{if(drag){theta-=(e.clientX-px)*.006;phi=T.MathUtils.clamp(phi+(e.clientY-py)*.004,.25,2.7);px=e.clientX;py=e.clientY;}};
  renderer.domElement.onwheel=e=>{distance=T.MathUtils.clamp(distance+e.deltaY*.003,2.5,9);};
  addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);});
  function frame(){requestAnimationFrame(frame);const dt=Math.min(clock.getDelta(),.05)*Number(rate.value);
    if(controller&&!paused){
      if(cyclicMode()){
        // A running cycle must not restart from idle whenever the four-second
        // inspection ruler wraps. Preserve the live gait and mixer phase.
        time+=dt;step(dt,time);
      }else{
      let remaining=dt;
      while(remaining>1e-8){
        const h=Math.min(remaining,sequenceDuration()-time);
        if(h>1e-8){time+=h;step(h,time);remaining-=h;}
        if(time>=sequenceDuration()-1e-8){reset();step(0,0);}
      }
      }
      syncTime();
    }
    const target=new T.Vector3(0,.75+player.position.y,0);
    camera.position.set(Math.sin(theta)*Math.sin(phi)*distance,Math.cos(phi)*distance,Math.cos(theta)*Math.sin(phi)*distance).add(target);camera.lookAt(target);renderer.render(scene,camera);}
  frame();
})();
