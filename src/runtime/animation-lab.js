(function () {
  'use strict';
  const T=THREE, scene=new T.Scene();scene.background=new T.Color(0x20272e);
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
  let controller,mixer,idleAction,walkAction,time=0,paused=false,theta=Math.PI+.35,phi=1.35,distance=innerWidth<700?6.5:4.4;
  const effects=[],clock=new T.Clock(),q=new T.Quaternion(),v=new T.Vector3();
  const axis=new T.Vector3(0,-1,0),up=new T.Vector3(0,1,0),thrust=new T.Vector3(),velocity=new T.Vector3();
  let lastState={};
  function stateAt(t){
    const m=mode.value,s={grounded:true,speed:0,charge:0,landing:0,space:0,airTime:2,powered:false,brake:0};
    if(m==='walk'||m==='run')s.speed=m==='walk'?1.8:6.2;
    if(m==='charge')s.charge=.95;
    if(m==='jump'){
      s.grounded=t<1||t>=2.5;s.charge=t<1?T.MathUtils.smoothstep(t,0,1):0;
      s.landing=t>=2.5?Math.sin(Math.min(1,(t-2.5)/.14)*Math.PI/2)*Math.exp(-Math.max(0,t-2.64)*5):0;
      s.airTime=Math.max(0,t-1);
    }
    if(m==='land'){s.grounded=t>=1;s.airTime=t;s.landing=t<1?0:Math.sin(Math.min(1,(t-1)/.18)*Math.PI/2)*Math.exp(-Math.max(0,t-1.18)*3.7);}
    if(['fall','coast','hover','cruise','turn','brake','swim'].includes(m))s.grounded=false;
    if(['coast','hover','cruise','turn','brake'].includes(m))s.space=1;
    s.powered=['hover','cruise','turn'].includes(m);s.brake=m==='brake'?1:0;
    s.throttle=Number(document.getElementById('flightPower').value);s.powered=s.powered&&s.throttle>.01;
    s.turn=m==='turn'?Math.sin(t*1.7):0;s.water=m==='swim';return s;
  }
  function step(dt,t){
    const s=stateAt(t);lastState=s;
    const original=mode.value==='sourcewalk';
    if(walkAction){walkAction.enabled=original;idleAction.enabled=!original;walkAction.timeScale=2.15;}
    mixer.update(dt);
    const flying=['cruise','turn','brake'].includes(mode.value);
    const pitch=flying?(mode.value==='brake'?.7:-1.15):0;
    const yaw=Number(document.getElementById('flightYaw').value)*Math.PI/180+s.turn*.7;
    const tilt=-pitch+Number(document.getElementById('flightPitch').value)*Math.PI/180;
    thrust.set(Math.sin(yaw)*Math.sin(tilt),Math.cos(tilt),-Math.cos(yaw)*Math.sin(tilt));
    velocity.copy(thrust).multiplyScalar(-10);q.identity();
    controller.orient(dt,q,up,thrust,velocity,s.grounded,s.water,s.space);
    const jumpTime=Math.max(0,Math.min(1.5,t-1));
    player.position.y=mode.value==='jump'?4*1.1*(jumpTime/1.5)*(1-jumpTime/1.5):mode.value==='land'?(t<1?(1-t)*1.2:0):s.grounded?0:.55;
    grid.position.z=(t*s.speed)%.5;
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
    status.textContent=mode.options[mode.selectedIndex].text+' · '+t.toFixed(2)+' s';
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
    window.motionStudioDiagnostics=()=>({state:lastState,chains:controller.chains.map(c=>({type:c.type,side:c.side,reference:c.points.map(v=>v.toArray()),joints:c.nodes.map(n=>({q:n.quaternion.toArray(),position:visual.worldToLocal(n.getWorldPosition(new T.Vector3())).toArray()}))}))});
  },undefined,e=>{document.getElementById('loading').textContent='Model failed to load';console.error(e);});
  function reset(){time=0;scrub.value=0;if(controller){player.quaternion.identity();controller.reset();mixer.setTime(0);}}
  mode.onchange=reset;document.getElementById('replay').onclick=reset;
  document.getElementById('pause').onclick=()=>{paused=!paused;document.getElementById('pause').textContent=paused?'Play':'Pause';};
  document.getElementById('front').onclick=()=>{theta=Math.PI;phi=1.35;};
  document.getElementById('side').onclick=()=>{theta=Math.PI/2;phi=1.35;};
  scrub.oninput=()=>{paused=true;document.getElementById('pause').textContent='Play';const target=Number(scrub.value);reset();time=target;scrub.value=target;if(controller)for(let t=0;t<target;t+=1/60)step(1/60,t);};
  document.getElementById('seek').oninput=e=>{scrub.value=Math.max(0,Math.min(4,Number(e.target.value)||0));scrub.oninput();};
  let drag=false,px=0,py=0;
  renderer.domElement.onpointerdown=e=>{drag=true;px=e.clientX;py=e.clientY;renderer.domElement.setPointerCapture(e.pointerId);};
  renderer.domElement.onpointerup=()=>drag=false;
  renderer.domElement.onpointermove=e=>{if(drag){theta-=(e.clientX-px)*.006;phi=T.MathUtils.clamp(phi+(e.clientY-py)*.004,.25,2.7);px=e.clientX;py=e.clientY;}};
  renderer.domElement.onwheel=e=>{distance=T.MathUtils.clamp(distance+e.deltaY*.003,2.5,9);};
  addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);});
  function frame(){requestAnimationFrame(frame);const dt=Math.min(clock.getDelta(),.05)*Number(document.getElementById('rate').value);
    if(controller&&!paused){time=(time+dt)%4;step(dt,time);scrub.value=time;}
    const target=new T.Vector3(0,.75+player.position.y*.3,0);
    camera.position.set(Math.sin(theta)*Math.sin(phi)*distance,Math.cos(phi)*distance,Math.cos(theta)*Math.sin(phi)*distance).add(target);camera.lookAt(target);renderer.render(scene,camera);}
  frame();
})();
