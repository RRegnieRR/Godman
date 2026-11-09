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
  for(const [value,label] of [['strafeleft','Repulsors · steer left'],['straferight','Repulsors · steer right'],['recovery','Fall → lift → climb'],['armsweep','Repulsors · arm sweep & release'],['descent','Repulsors · controlled descent'],['rocket','Boot thrusters · charged launch'],['hoverhold','Shift · stop and hold altitude'],['landlevel','Landing · forward flight'],['landside','Landing · sideways drift'],['landdive','Landing · head-first approach']])mode.add(new Option(label,value));
  if(Array.from(mode.options).some(option=>option.value===requestedMotion))mode.value=requestedMotion;
  const seek=document.getElementById('seek'),rate=document.getElementById('rate');
  let controller,mixer,idleAction,walkAction,time=0,paused=false,theta=Math.PI+.35,phi=1.35,distance=innerWidth<700?6.5:4.4;
  const effects=[],clock=new T.Clock(),q=new T.Quaternion(),v=new T.Vector3();
  const axis=new T.Vector3(0,-1,0),up=new T.Vector3(0,1,0),thrust=new T.Vector3(),velocity=new T.Vector3();
  const previewFlight=new GodmanFlightDynamics(),previewPosition=new T.Vector3(0,12,0),previewVelocity=new T.Vector3(0,-7,0);
  const previewGravity=new T.Vector3(0,-9.81,0),previewZero=new T.Vector3();
  const flightLandings=['landlevel','landside','landdive'];
  const landingPose={from:new T.Quaternion(),travel:new T.Vector3(),flare:0,age:99,strength:0,roll:false,tuck:0};
  let lastState={},travel=0,rocketStarted=false;
  const pressure=GodmanLaunchPressure();pressure.position.y=-.25;scene.add(pressure);
  const previewHeading=new T.Vector3(0,0,-1),previewCenter=new T.Vector3(0,-637100,0);
  const gaitSettings=window.GodmanMotionSettings||{walkSpeed:1.8,runSpeed:4.4};
  const gravity=9.81,jumpHeight=1.1,jumpVelocity=Math.sqrt(2*gravity*jumpHeight),jumpDuration=2*jumpVelocity/gravity;
  const landingHeight=1.2,landingTime=Math.sqrt(2*landingHeight/gravity);
  const sequenceDuration=()=>mode.value==='hoverhold'?12:mode.value==='rocket'?8:mode.value==='armsweep'?11:mode.value==='descent'?6:['transitions','reverse'].includes(mode.value)?8:mode.value==='fall'?1.2:4;
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
    if(flightLandings.includes(m)){
      const contact=2.4,remaining=Math.max(0,contact-t);
      s.grounded=t>=contact;s.airTime=t;s.powered=!s.grounded;
      s.height=remaining*3;s.verticalSpeed=s.grounded?0:-3;
      s.flightYaw=m==='landside'?Math.PI/2:0;
      s.flightTilt=m==='landdive'?2.58:Math.PI/2;
      s.landing=.8*impactPulse(t-contact);
      s.stage=s.grounded?(m==='landlevel'&&t<3.17?'Shoulder roll · recover':'Contact · recover'):remaining<.85?(m==='landlevel'?'Tuck for the roll':'Bring the boots down'):'Approach';
    }
    if(['fall','coast','hover','cruise','turn','reverse','brake','swim'].includes(m)){s.grounded=false;s.airTime=t;s.height=.55;}
    if(['strafeleft','straferight','recovery'].includes(m)){
      s.grounded=false;s.airTime=t;s.height=2;s.powered=m!=='recovery'||t>=.45;
      s.stage=m==='recovery'?(t<.45?'Falling':previewVelocity.y<0?'Arrest fall':'Climb'):m==='straferight'?'Left arm drives right':'Right arm drives left';
    }
    if(m==='rocket'){
      s.grounded=t<5.16;s.charge=0;s.rocketCharge=t<5?t/5:t<5.16?1:0;
      s.launchCharge=t<5?t/5:1;s.launchAge=t<5?-1:t-5;
      s.height=0;s.airTime=Math.max(0,t-5);s.stage=t<5?'Gather / brace':t<5.16?'Explosive arm drive':t<5.65?'Ignition / vertical lift-off':'Rocket ascent';
    }
    if(m==='descent'){s.grounded=false;s.airTime=t;s.height=2;s.powered=true;s.lookDown=1;s.verticalSpeed=-4;s.stage='Controlled descent';}
    if(m==='fall'){s.height=8-.5*gravity*t*t;s.verticalSpeed=-gravity*t;}
    if(['coast','hover','cruise','turn','reverse','brake'].includes(m))s.space=1;
    s.powered=s.powered||['hover','cruise','turn','reverse'].includes(m);s.brake=m==='brake'?1:0;
    if(m==='reverse'){
      s.powered=t<6;s.brake=t>=6&&t<7?1:0;
      s.flightYaw=t<3?0:t<4?-Math.PI/2:t<5?Math.PI/2:Math.PI;
      s.flightTilt=t<1?0:Math.PI/3;
      s.stage=t<1?'Hover':t<3?'Forward thrust':t<4?'Turn left':t<5?'Reverse right':t<6?'Reverse thrust':t<7?'Brake':'Coast';
    }
    s.throttle=Number(document.getElementById('flightPower').value);s.powered=s.powered&&s.throttle>.01;
    if(m==='armsweep'){
      s.grounded=false;s.airTime=t;s.height=2;
      s.throttle*=t<9?1-Math.exp(-4.5*t):Math.exp(-6*(t-9));s.powered=s.throttle>.015;
      s.flightYaw=Math.max(0,t-1)*Math.PI/4;s.flightTilt=Math.PI/2+.9;
      s.stage=t<9?'Steer through a full turn':'Ease off / settle';
    }
    if(m==='hoverhold'){
      s.grounded=false;s.airTime=t;s.height=10;s.powered=t<2.5&&s.throttle>.01;s.brake=t>=2.5&&t<9?1:0;
      s.flightTilt=Math.PI/2;s.stage=t<2.5?'Fly':t>=9?'Shift released · coast':'Shift held · altitude hold';
    }
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
    if(mode.value==='strafeleft'||mode.value==='straferight')thrust.set(mode.value==='straferight'?1:-1,0,0);
    if(mode.value==='descent')thrust.set(0,-1,-.12).normalize();
    if(mode.value==='rocket'&&t>=5&&!rocketStarted){
      previewPosition.set(0,0,0);previewVelocity.set(0,0,0);
      previewFlight.beginLaunch(1,up,up,gravity,637100);rocketStarted=true;
    }
    if(mode.value==='rocket'&&s.grounded&&rocketStarted&&previewFlight.prepareLaunch(Math.min(dt,Math.max(0,t-5))))s.grounded=false;
    const shared=!s.grounded&&!s.water&&!['jump','land','fall','sourcewalk'].includes(mode.value);
    if(shared){
      previewHeading.set(Math.sin(yaw),0,-Math.cos(yaw));
      previewFlight.update(dt,{velocity:previewVelocity,gravity:s.space?previewZero:previewGravity,up,aim:mode.value==='recovery'?up:thrust,heading:previewHeading,move:previewZero,frameVelocity:previewZero,surface:s.space?0:1,fuel:100,position:previewPosition,center:previewCenter,body:'studio',thrust:s.powered,braking:!!s.brake});
      if(mode.value==='recovery'||mode.value==='rocket'||mode.value==='hoverhold'){
        previewFlight.integrate(previewPosition,previewVelocity,dt);s.height=previewPosition.y;s.verticalSpeed=previewVelocity.y;
      }
      s.powered=previewFlight.powered;s.throttle=previewFlight.throttle;s.hoverHold=previewFlight.hoverLocked;s.brakeReach=previewFlight.brakeReach;s.brakeDirection=previewFlight.brakeDirection;s.rocketLaunch=previewFlight.launchAge<.85;
      if(mode.value==='hoverhold'&&s.brake){
        if(previewFlight.hoverLocked)s.stage='Shift held · altitude hold';
        else if(previewFlight.brakeForce.lengthSq()>1)s.stage='Counter-thrust · slowing down';
        else s.stage=previewFlight.brakeReach>.05?'Reach forward':'Settling into hover';
        s.speed=Math.hypot(previewVelocity.x,previewVelocity.z);
      }
      thrust.copy(previewFlight.direction);velocity.copy(previewVelocity);
    }else velocity.copy(thrust).multiplyScalar(-10);
    q.identity();
    if(flightLandings.includes(mode.value)){
      landingPose.travel.set(mode.value==='landside'?8:0,0,mode.value==='landside'?0:-9);
      landingPose.age=Math.max(0,t-2.4);landingPose.strength=.84;
      landingPose.flare=s.grounded?0:1-ease(.08,.85,2.4-t);
      landingPose.roll=mode.value==='landlevel'&&s.grounded;
      landingPose.tuck=mode.value==='landlevel'?landingPose.flare:0;
      if(mode.value==='landlevel')landingPose.flare=0;
      if(!s.grounded)landingPose.from.copy(controller.attitude);
      s.landingPose=landingPose;
    }
    controller.orient(dt,q,up,thrust,velocity,s.grounded,s.water,s.space,shared?previewFlight.rig:null,s.landingPose);
    player.position.y=s.height;
    if(mode.value==='landlevel'){
      const rollout=Math.min(t-2.4,.78);
      player.position.z=t<2.4?-3.5*(t-2.4):-rollout*(3.5-2.24*rollout);
    }
    travel+=dt*s.speed;grid.position.z=travel%.5;
    if(!original)controller.update(dt,s);player.updateMatrixWorld(true);
    for(const e of effects){
      e.locator.getWorldPosition(e.fx.position);
      e.locator.parent.getWorldQuaternion(q);
      v.copy(e.locator.userData.exhaustAxis).applyQuaternion(q);e.fx.quaternion.setFromUnitVectors(axis,v);
      const chain=controller.chains.find(c=>c.nodes[2]===e.locator.parent);
      const alignment=GodmanRepulsorAim(visual,e.locator.parent,e.locator.userData.exhaustAxis,chain.exhaust,v);
      e.fx.quaternion.setFromUnitVectors(axis,v);
      const pilot=e.type==='leg'?(s.rocketCharge||0)*.18:0;
      const burst=previewFlight.launchFlash*(e.type==='leg'?1:.65);
      const port=previewFlight.coordinated&&previewFlight.rig.ports.find(p=>p.type===(e.type==='leg'?'foot':'hand')&&p.side===(e.locator.parent.name.startsWith('L')?1:-1));
      const handJet=e.type!=='leg'&&port?Math.min(.85,Math.sqrt(port.force.length()/8))*alignment:0;
      const strength=s.grounded?pilot:Math.max(pilot,burst*.45,handJet,e.type==='leg'&&previewFlight.hoverLocked?.3:0,alignment*Math.max(controller.throttle,controller.brake*.65,previewFlight.steeringThrottle)*controller.nozzleShare(e.type==='leg'?'foot':'hand',e.locator.parent.name.startsWith('L')?1:-1));
      if(e.flash){e.flash.visible=pilot+burst+strength+(s.rocketCharge||0)>.01;e.flash.scale.setScalar(.6+burst*.8);e.flash.userData.material.uniforms.strength.value=pilot*1.5+(s.rocketCharge||0)*.3+burst*2.5+strength*.15;}
      e.fx.visible=strength>.01||burst>.01||(s.rocketCharge||0)>.05;
      e.fx.userData.material.uniforms.strength.value=strength;
      e.fx.userData.material.uniforms.time.value=t;
    }
    pressure.updateBurst(mode.value==='rocket'?t-5.16:-1,1);
    const shown=cyclicMode()?t%sequenceDuration():t;
    status.textContent=(s.stage||mode.options[mode.selectedIndex].text)+' · '+shown.toFixed(2)+' / '+sequenceDuration().toFixed(1)+' s'+(s.speed?' · '+s.speed.toFixed(1)+' m/s':'')+(mode.value==='hoverhold'?' · altitude '+s.height.toFixed(2)+' m':'');
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
    for(const c of controller.chains){const type=c.type==='arm'?'hand':'foot';const locator=GodmanRepulsorAnchor(visual,c.nodes[2],type);const fx=GodmanRepulsorPlume(type);scene.add(fx);const flash=GodmanPropulsorFlash();if(flash)fx.add(flash);effects.push({locator,fx,flash,type:c.type});}
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
  function cyclicMode(){return ![...flightLandings,'jump','land','fall','transitions','reverse','recovery','armsweep','rocket','hoverhold'].includes(mode.value);}
  function syncTime(){const shown=cyclicMode()?time%sequenceDuration():time;scrub.value=shown;seek.value=shown.toFixed(2);}
  function reset(){
    time=0;travel=0;rocketStarted=false;velocity.set(0,0,0);scrub.max=seek.max=sequenceDuration();syncTime();
    previewFlight.reset();previewPosition.set(0,12,0);previewVelocity.set(0,-7,0);
    if(mode.value==='hoverhold'){previewPosition.set(0,10,0);previewVelocity.set(0,4,-12);}
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
    const target=new T.Vector3(player.position.x,.75+player.position.y,player.position.z);
    camera.position.set(Math.sin(theta)*Math.sin(phi)*distance,Math.cos(phi)*distance,Math.cos(theta)*Math.sin(phi)*distance).add(target);camera.lookAt(target);renderer.render(scene,camera);}
  frame();
})();
