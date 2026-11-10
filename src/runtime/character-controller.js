/* Authored walking, baked athletic running, and reactive flight.
 * Fitted suit coordinates: +Y up, +Z forward, 0.45 metres/unit.
 * Physics stays in the game; the rig adapter owns skin helpers and limits. */
(function(g){
  'use strict';
  const T=g.THREE,Rig=g.GodmanCharacterMotion,clamp=T.MathUtils.clamp;
  const smooth=(a,b,x)=>T.MathUtils.smoothstep(x,a,b);
  const damp=(a,b,k,h)=>T.MathUtils.lerp(a,b,1-Math.exp(-k*h));
  const Y=new T.Vector3(0,1,0),X=new T.Vector3(1,0,0),FACING=new T.Quaternion().setFromAxisAngle(Y,Math.PI);
  function frames(clip,phase,out){
    if(!clip)return false;
    const f=phase*(clip.frames.length-1),i=Math.floor(f);
    out.a=clip.frames[i];out.b=clip.frames[Math.min(i+1,clip.frames.length-1)];out.u=f-i;return true;
  }
  const value=(f,key,i)=>T.MathUtils.lerp(f.a[key][i],f.b[key][i],f.u);
  const scalar=(f,key)=>T.MathUtils.lerp(f.a[key],f.b[key],f.u);
  class BodyController extends Rig{
    constructor(frame,bones){
      super(frame,bones);
      this.legs=this.chains.filter(c=>c.type==='leg');
      this.legReach=this.legs[0].points[0].distanceTo(this.legs[0].points[1])+this.legs[0].points[1].distanceTo(this.legs[0].points[2]);
      this.floor=(this.legs[0].points[2].y+this.legs[1].points[2].y)*.5;
      this.intent=new T.Vector3(0,1,0);this.exhaust=new T.Vector3(0,-1,0);
      this.brakeTravel=new T.Vector3();this.brakeLocal=new T.Vector3();
      this.v=new T.Vector3();this.j=new T.Vector3();this.upperDir=new T.Vector3();this.lowerDir=new T.Vector3();this.knee=new T.Vector3();
      this.rawTarget=new T.Vector3();this.rawPole=new T.Vector3();
      this.bodyDelta=new T.Quaternion();this.bodyInverse=new T.Quaternion();this.poseQ=new T.Quaternion();this.tempQ=new T.Quaternion();
      this.worldQ=new T.Quaternion();this.parentQ=new T.Quaternion();this.exhaustFrameInverse=new T.Quaternion();this.walkFrames={};
      frame.updateWorldMatrix(true,true);frame.getWorldQuaternion(this.worldQ).invert();
      this.torso=this.groundTorso.concat(this.headJoints).map(t=>{
        const n=t.bone.name,source=/Spine_1/.test(n)?'Spine':/Spine_2/.test(n)?'Spine1':/Spine_3/.test(n)?'Spine2':/^neck/i.test(n)?'Neck':'Head';
        // Source deltas use a neutral pose, not the already hunched idle.
        const path=[];let node=t.bone;
        while(node&&node!==frame){path.push(node);node=node.parent;}
        const neutral=new T.Quaternion();
        for(let i=path.length-1;i>=0;i--)neutral.multiply(path[i].userData.motionBindQuaternion||path[i].quaternion);
        return {bone:t.bone,source,rest:t.rest.clone(),position:t.bone.position.clone(),scale:t.bone.scale.clone(),inFrame:neutral};
      });
      this.bodyAnchors=[];
      frame.traverse(b=>{
        if(b.isBone&&/^(Root|Center|Hip|[LR]_Clevicle)[._\d]/.test(b.name))this.bodyAnchors.push({bone:b,q:b.quaternion.clone(),p:b.position.clone(),s:b.scale.clone()});
      });
      this.chains.forEach(c=>{
        c.lengthA=c.points[0].distanceTo(c.points[1]);c.lengthB=c.points[1].distanceTo(c.points[2]);
        c.filtered=c.points[2].clone();c.targetVelocity=new T.Vector3();c.filteredPole=c.points[1].clone();c.origin=new T.Vector3();
        c.exhaust=new T.Vector3(0,-1,0);
      });
      this.running=new g.GodmanRunningGait(frame,this.chains);
      this.armClearance=new g.GodmanArmClearance();
      this.transitionPrevious=this.chains.flatMap(c=>c.nodes.map(n=>n.quaternion.clone()));
      this.transitionStep=0;
      this.gaitSpeed=this.ready=this.headExtension=this.contactOffset=this.hoverPose=this.brakePose=0;
      this.launchPose={weight:0,gather:0,tension:0,stance:0,strike:0,headBack:0,burst:false,age:99};
      this.launchAimWeight=0;
      this.soleFloor=-.62;this.cacheSoles();
    }
    cacheSoles(){
      // Bake rigid boot-sole samples once from the real skinned mesh. Toe
      // transforms stay fixed relative to each boot, so no per-frame skinning
      // or mesh-wide vertex scans are needed for contact.
      this.frame.updateWorldMatrix(true,true);
      for(const c of this.legs){
        const points=[];
        this.frame.traverse(mesh=>{
          if(!mesh.isSkinnedMesh)return;
          const p=mesh.geometry.attributes.position,ids=mesh.geometry.attributes.skinIndex,weights=mesh.geometry.attributes.skinWeight;
          if(!ids||!weights)return;
          const allowed=new Set();c.nodes[2].traverse(b=>{const i=mesh.skeleton.bones.indexOf(b);if(i>=0)allowed.add(i);});
          const get=['getX','getY','getZ','getW'];
          for(let i=0;i<p.count;i+=3){
            let weight=0;for(let k=0;k<4;k++)if(allowed.has(ids[get[k]](i)))weight+=weights[get[k]](i);
            if(weight<.90)continue;
            this.v.fromBufferAttribute(p,i);mesh.boneTransform(i,this.v);mesh.localToWorld(this.v);this.frame.worldToLocal(this.v);
            if(this.v.y>c.points[2].y-.15)continue;
            points.push(this.v.clone());
          }
        });
        const cells=new Map();
        for(const p of points){const key=Math.floor(p.x/.10)+':'+Math.floor(p.z/.12);if(!cells.has(key)||p.y<cells.get(key).y)cells.set(key,p);}
        c.soleSamples=Array.from(cells.values()).sort((a,b)=>a.y-b.y).slice(0,36).map(p=>c.nodes[2].worldToLocal(this.frame.localToWorld(p)));
      }
    }
    reset(){
      super.reset();this.brakeTravel.set(0,0,0);this.gaitSpeed=this.ready=this.headExtension=this.contactOffset=this.hoverPose=this.brakePose=0;
      for(const c of this.chains){c.filtered.copy(c.points[2]);c.targetVelocity.set(0,0,0);c.filteredPole.copy(c.points[1]);}
      for(const t of this.torso)t.bone.quaternion.copy(t.rest);
      this.rememberPose();
    }
    rememberPose(){
      let joint=0;
      for(const c of this.chains)for(const n of c.nodes)this.transitionPrevious[joint++].copy(n.quaternion);
    }
    update(dt,s){
      const total=clamp(dt,0,.05),count=Math.max(1,Math.ceil(total*120));
      for(let i=0;i<count;i++){
        this.advance(total/count,s);
        // The idle mixer writes these bones before each update. Only our
        // completed output is valid history for the next transition step.
        this.rememberPose();
      }
      if(this.coordinated&&!s.grounded&&!s.rocketLaunch&&!s.landingPose?.flare){
        this.flightRig.samplePose(this.chains,this.attitude,total);
      }
    }
    sampleDirections(c){
      const key=c.side+'_'+c.type,w=this.walkFrames;
      for(let i=0;i<3;i++){
        this.upperDir.setComponent(i,value(w,key,i));
        this.lowerDir.setComponent(i,value(w,key,i+3));
      }
      if(c.type==='arm')g.GodmanArmReference(g.GodmanWalkMotion,this.phase,c.side,this.upperDir,this.lowerDir);
      this.upperDir.normalize().applyQuaternion(this.bodyInverse);this.lowerDir.normalize().applyQuaternion(this.bodyInverse);
      this.knee.copy(c.origin).addScaledVector(this.upperDir,c.lengthA);
      this.v.copy(this.knee).addScaledVector(this.lowerDir,c.lengthB);
    }
    sampleRotation(key){
      const w=this.walkFrames;
      this.poseQ.fromArray(w.a.torso[key]).slerp(this.tempQ.fromArray(w.b.torso[key]),w.u);
    }
    applyRun(weight,s){
      this.running.apply(this.phase,weight,s.laser,weight<1?this.transitionPrevious:null,this.transitionStep);
      this.bodyDelta.copy(FACING).invert().multiply(this.frame.quaternion);
      this.bodyInverse.copy(this.bodyDelta).invert();
      for(const c of this.chains){
        this.frame.worldToLocal(c.nodes[0].getWorldPosition(c.origin));
        this.frame.worldToLocal(c.nodes[1].getWorldPosition(c.pole));
        this.frame.worldToLocal(c.nodes[2].getWorldPosition(c.goal));
      }
    }
    advance(h,s){
      this.time+=h;
      const launch=this.launchPose;
      if(g.GodmanLaunchSequence)g.GodmanLaunchSequence.sample(s.launchCharge||0,s.launchAge===undefined?99:s.launchAge,launch);
      this.launchAimWeight=launch.strike;
      this.hoverPose=damp(this.hoverPose,s.hoverHold?1:0,5,h);
      const hover=this.hoverPose;
      const braking=this.coordinated?clamp(s.brakeReach||0,0,1):0;
      this.brakePose=damp(this.brakePose,braking,braking>this.brakePose?13:6,h);
      const brakeReach=this.brakePose;
      const landing=s.landingPose;
      const flare=landing?.flare||0;
      const brace=landing&&s.grounded&&!s.water?(landing.strength||0)*(1-smooth(.16,.68,landing.age)):0;
      const rollAge=landing?.age??99;
      const rollTuck=this.rollFloor?1-smooth(.57,.94,rollAge):landing?.tuck||0;
      const landingWeight=landing?.roll?0:Math.max(flare,brace);
      const upperBodyWeight=Math.max(launch.weight,this.coordinated?this.air*Math.max(this.power,this.brake):0);

      const previousGround=this.move*(1-this.air);
      // Idle formerly kept moving Center/Hip and clavicles underneath the
      // controller. Own every structural ancestor, not just the limb joints.
      for(const b of this.bodyAnchors){b.bone.quaternion.copy(b.q);b.bone.position.copy(b.p);b.bone.scale.copy(b.s);}
      for(const b of this.bodyAnchors)if(upperBodyWeight>.001&&/Clevicle/.test(b.bone.name))b.bone.quaternion.slerp(b.bone.userData.motionBindQuaternion||b.q,upperBodyWeight);
      for(const t of this.torso){t.bone.position.copy(t.position);t.bone.scale.copy(t.scale);}
      this.air=damp(this.air,s.grounded?0:1,14,h);this.water=damp(this.water,s.water?1:0,6,h);
      this.power=damp(this.power,!s.grounded&&!s.water&&(s.powered||s.rocketLaunch)?1:0,9,h);
      this.brake=damp(this.brake,!s.grounded&&!s.water?s.brake||0:0,9,h);
      this.throttle=damp(this.throttle,s.powered&&!s.water?(s.throttle===undefined?1:s.throttle):0,10,h);
      this.crouch=damp(this.crouch,s.grounded&&!s.water?Math.max(s.charge||0,s.landing||0):0,12,h);
      this.gaitSpeed=damp(this.gaitSpeed,s.grounded&&!s.water?s.speed||0:0,10,h);
      this.move=damp(this.move,s.grounded&&!s.water?clamp(this.gaitSpeed/.8,0,1)*(1-this.crouch):0,12,h);
      this.run=damp(this.run,clamp((this.gaitSpeed-2)/2.4,0,1),8,h);
      const walk=g.GodmanWalkMotion;
      const cadence=T.MathUtils.lerp(1.10,this.running.cadence,this.run);
      this.phase=(this.phase+h*cadence*clamp(this.gaitSpeed/1.1,0,1))%1;
      const authored=frames(walk,this.phase,this.walkFrames);
      const ground=(1-this.air)*(1-this.water),locomotion=this.move*ground;
      this.transitionStep=(7.5+22.5*Math.max(previousGround,this.move*(1-this.air)))*h;
      const powered=Math.max(this.power,this.brake),free=this.air*(1-powered)*(1-this.water);
      const earthAir=free*(1-(s.space||0)),coast=free*(s.space||0);
      const vertical=s.verticalSpeed||0;
      const rising=smooth(.2,3,vertical),falling=smooth(.3,10,-vertical);
      const apex=1-smooth(.2,2.5,Math.abs(vertical));
      const tuck=earthAir*(rising*.65+apex*.25)*smooth(.04,.15,s.airTime||0);
      const impactTime=!s.grounded&&s.verticalSpeed<-.5&&Number.isFinite(s.height)?Math.max(0,s.height)/-s.verticalSpeed:Infinity;
      this.ready=damp(this.ready,(1-smooth(.08,.38,impactTime))*earthAir,10,h);
      const runWeight=this.run*locomotion;
      if(runWeight>.999&&!s.laser&&brace<.001&&rollTuck<.001){
        this.applyRun(1,s);return;
      }
      this.bodyDelta.identity();
      if(authored&&locomotion>.001){this.sampleRotation('Hips');this.bodyDelta.slerp(this.poseQ,locomotion);}
      this.frame.quaternion.copy(FACING).multiply(this.bodyDelta);
      this.q.setFromAxisAngle(X,-this.crouch*.26+this.water*.07+launch.tension*.16);this.frame.quaternion.multiply(this.q);
      this.bodyInverse.copy(this.bodyDelta).invert();
      this.v.copy(this.legs[0].points[0]).applyQuaternion(this.frame.quaternion);
      const pivotY=this.legs[0].points[0].y;
      this.frame.position.set(0,-this.crouch*.36+pivotY-this.v.y,this.crouch*.42);
      if(authored&&locomotion>.001&&this.walkFrames.a.pelvisHeight!==undefined){
        const walkY=this.floor+scalar(this.walkFrames,'pelvisHeight')*this.legReach-this.v.y;
        this.frame.position.y=T.MathUtils.lerp(this.frame.position.y,walkY,locomotion);
      }
      this.frame.position.y-=this.ready*.055+launch.tension*.28+launch.stance*.12*(1-launch.tension);
      this.frame.position.z+=launch.tension*.50;
      if(this.coordinated){
        this.frame.position.add(this.flightPivot);
        this.frame.position.x+=hover*.025*Math.sin(this.time*1.6);
      }
      this.frame.updateWorldMatrix(true,true);this.frame.getWorldQuaternion(this.worldQ);
      for(const t of this.torso){
        t.bone.quaternion.copy(t.rest);
        if(upperBodyWeight>.001)t.bone.quaternion.slerp(t.bone.userData.motionBindQuaternion||t.rest,upperBodyWeight);
        if(authored&&locomotion>.001){
          this.sampleRotation(t.source);this.poseQ.premultiply(this.bodyInverse);
          this.tempQ.copy(this.worldQ).multiply(this.poseQ).multiply(t.inFrame);
          t.bone.parent.getWorldQuaternion(this.parentQ).invert();this.tempQ.premultiply(this.parentQ);
          t.bone.quaternion.slerp(this.tempQ,locomotion);
        }
        if(t.source==='Spine1'){
          const breathe=Math.sin(this.time*1.8)*.002*(1-locomotion)*(1-this.water);
          this.q.setFromAxisAngle(X,breathe-rollTuck*.13);
          t.bone.quaternion.multiply(this.q);
        }
        t.bone.updateWorldMatrix(false,true);
      }
      this.headExtension=damp(this.headExtension,powered*this.lookExtension*.55-launch.tension*.4+launch.headBack*.9-rollTuck*.92,launch.burst?35:8,h);
      for(const head of this.headJoints){this.q.setFromAxisAngle(head.axis,-head.amount*this.headExtension);head.bone.quaternion.premultiply(this.q);}
      const curl=clamp(.16+.84*this.run*locomotion+coast*.08-this.power*.16+(s.hoverHold?.16:0),0,1)*(s.laser?0:1);
      for(const f of this.runningFingers)f.bone.quaternion.copy(f.rest).slerp(f.target,curl);
      if(launch.weight>.001)for(const f of this.runningFingers){
        f.bone.quaternion.slerp(this.tempQ.copy(f.rest).slerp(f.target,.20-.08*launch.strike),launch.weight);
        if(/_[1](?:[._]|\d)/.test(f.bone.name)){
          const spread=/index/.test(f.bone.name)?.06:/middle/.test(f.bone.name)?.02:/ring/.test(f.bone.name)?-.025:/pinky/.test(f.bone.name)?-.06:0;
          this.q.setFromAxisAngle(Y,spread*(f.bone.name.startsWith('L')?1:-1)*launch.weight);f.bone.quaternion.multiply(this.q);
        }
      }
      this.frame.updateWorldMatrix(true,true);
      this.q.copy(this.frame.quaternion).invert();this.intent.copy(this.flightLoad).applyQuaternion(this.q);
      if(this.intent.lengthSq()<.01)this.intent.set(0,1,0);this.intent.normalize();this.exhaust.copy(this.intent).negate();
      this.frame.getWorldQuaternion(this.exhaustFrameInverse).invert();
      if(braking>0&&s.brakeDirection?.lengthSq()>.001){
        // Exhaust points along travel during braking. Keep that direction
        // in world space while the torso pitches back toward upright.
        if(this.brakeTravel.lengthSq()<.01)this.brakeTravel.copy(s.brakeDirection);
        else this.brakeTravel.lerp(s.brakeDirection,1-Math.exp(-10*h)).normalize();
      }
      this.brakeLocal.copy(this.brakeTravel).applyQuaternion(this.exhaustFrameInverse);
      let slideX=0,slideZ=0;
      if(landingWeight>.001&&landing.travel){
        this.v.copy(landing.travel).applyQuaternion(this.exhaustFrameInverse).multiplyScalar(.11);
        slideX=clamp(this.v.x,-1,1);
        slideZ=clamp(this.v.z,-1,1);
      }
      for(const c of this.chains){
        c.nodes.forEach((n,i)=>{n.quaternion.copy(c.rest[i]);n.position.copy(c.positions[i]);n.scale.copy(c.scales[i]);});
        c.toes.forEach(t=>{t.bone.quaternion.copy(t.q);t.bone.position.copy(t.p);t.bone.scale.copy(t.s);});
        // Shoulder origins move with the spine; idle snapshots are not origins.
        this.frame.worldToLocal(c.nodes[0].getWorldPosition(c.origin));
        const origin=c.origin,reach=c.lengthA+c.lengthB;
        c.wristParticipation=undefined;
        c.goal.copy(c.points[2]);let endPitch=0;
        if(c.type==='leg'){
          this.v.copy(c.points[2]).applyQuaternion(FACING);this.frame.parent.localToWorld(this.v);this.frame.worldToLocal(this.v);
          c.goal.lerp(this.v,ground);c.pole.set(origin.x,origin.y-.5,origin.z+2);
          c.goal.y+=tuck*.22+coast*.13+earthAir*(.025+falling*.06);c.goal.z-=tuck*.10+coast*.10;
          c.goal.x+=c.sign*(coast*.025+this.ready*.025);c.footPlant=ground;
          const horizontal=Math.hypot(this.intent.x,this.intent.z);
          this.v.set(origin.x+c.sign*.06+this.exhaust.x*reach*.42,origin.y-reach*(.92-.22*horizontal),origin.z+this.exhaust.z*reach*.5);
          c.goal.lerp(this.v,this.air*powered);
          c.thrustShare=.04+.96*smooth(-.2,.85,this.intent.y);
          c.exhaust.copy(this.exhaust);
          if(this.coordinated){
            const kneeFloat=hover*(.045+.018*Math.sin(this.time*2+c.sign*.8));
            this.v.set(origin.x+c.sign*(.065+hover*.035),origin.y-reach*.96+kneeFloat,origin.z-.035-hover*.035);
            this.v.y+=reach*.14*brakeReach;
            this.v.z+=.32*brakeReach;
            c.goal.lerp(this.v,this.air*powered);c.thrustShare=1;
          }
        }else{
          const shoulder=.08,elbow=.35+coast*.35+earthAir*.16;
          this.v.set(c.sign*Math.max(.93,Math.abs(origin.x)+.26),origin.y-c.lengthA*Math.cos(shoulder)-c.lengthB*Math.cos(shoulder+elbow),origin.z+c.lengthA*Math.sin(shoulder)+c.lengthB*Math.sin(shoulder+elbow));
          c.goal.lerp(this.v,this.air);c.goal.y+=tuck*.38+this.ready*.16+earthAir*falling*.22;c.goal.z+=tuck*.18+this.ready*.12;
          c.goal.x+=c.sign*earthAir*falling*.15;
          c.pole.set(origin.x+c.sign*.22,origin.y-.65,origin.z-.9);
          const sideways=smooth(.05,.6,-c.sign*this.intent.x);
          const foreAft=smooth(.15,.7,Math.abs(this.intent.z));
          const downward=smooth(.05,.7,-this.intent.y);
          const drive=Math.max(sideways,foreAft,downward);
          c.thrustShare=.18+.82*drive;
          c.exhaust.copy(this.exhaust);
          this.v.set(origin.x+c.sign*.28,origin.y-reach*.76,origin.z+.22);
          this.j.copy(origin).addScaledVector(c.exhaust,reach*.94);
          this.j.x+=c.sign*(foreAft*.20+downward*.3);
          this.j.z=clamp(this.j.z,origin.z-.5,origin.z+.85);
          this.v.lerp(this.j,drive);
          this.v.z+=clamp(c.sign*this.angularVelocity.y*.10,-.16,.16);this.v.y+=clamp(c.sign*this.angularVelocity.z*.10,-.16,.16);
          if(this.coordinated){
            const steering=this.flightRig.steer,effort=this.flightRig.effort;
            const pitch=clamp(this.flightRig.controlTorque.x/2,-1,1);
            const roll=clamp(this.flightRig.controlTorque.z/2,-1,1);
            const lead=Math.max(0,-c.sign*steering);
            // Bent elbows move forward to steer; the opposing hand stays by
            // the belt. A reversal changes the jet couple, never an arm wrap.
            this.v.set(
              origin.x+c.sign*(.29+.18*effort+.24*lead),
              origin.y-reach*(.81-.11*effort-.04*lead)+.08*c.sign*roll,
              origin.z+clamp(.23-c.sign*steering*.34+pitch*.20,-.12,.80)
            );
            this.v.x+=c.sign*hover*.08;
            this.v.y+=hover*(.04+.026*Math.sin(this.time*1.8+c.sign*.65));
            this.v.z+=hover*.06;
            c.wristParticipation=effort;
            c.thrustShare=.08;
          }
          c.goal.lerp(this.v,this.air*powered);
          if(this.coordinated&&brakeReach>.001){
            // For prone flight, world-forward is toward the helmet in suit
            // coordinates. Reach in that direction with bent elbows instead
            // of using an upright pose that leaves the hands by the waist.
            const reachUp=clamp(this.brakeLocal.y*.95-.20,-.40,.73);
            const reachFront=clamp(this.brakeLocal.z*.65+.47,.36,.92);
            const reachAcross=clamp(this.brakeLocal.x*.24,-.18,.18);
            this.v.set(c.sign*.22+reachAcross,reachUp,reachFront).clampLength(0,.93);
            this.v.multiplyScalar(reach).add(origin);
            c.goal.lerp(this.v,brakeReach);
            this.v.set(origin.x+c.sign*.73,origin.y-reach*.47,origin.z+.20);
            c.pole.lerp(this.v,brakeReach);
            c.wristParticipation=Math.max(c.wristParticipation,brakeReach);
          }
        }
        if(this.coordinated&&this.flightRig.ports){
          const port=this.flightRig.ports.find(p=>p.type===(c.type==='arm'?'hand':'foot')&&p.side===c.sign);
          if(port){
            c.thrustShare=port.power;
            c.exhaust.copy(port.exhaust).applyQuaternion(this.flightRig.attitude).applyQuaternion(this.exhaustFrameInverse);
          }
          // Aim the palms during the brace, before the counter-jets light.
          // The small attitude-correction jets can point elsewhere.
          if(c.type==='arm'&&braking>0&&this.brakeLocal.lengthSq()>.01)c.exhaust.copy(this.brakeLocal);
          if(s.hoverHold&&c.type==='arm'){c.thrustShare=0;c.wristParticipation=0;}
        }
        c.launchTracking=launch.burst?launch.weight:0;
        if(launch.weight>.001&&c.type==='arm'){
          // One mirrored trajectory for both arms: gather at the chest,
          // then drive down beside the belt before the ignition marker.
          this.v.set(origin.x+c.sign*.28,origin.y-reach*.76,.15);
          this.j.set(c.sign*.50,origin.y-.08,.88);
          this.v.lerp(this.j,launch.gather);
          c.goal.lerp(this.v,launch.weight);
          this.v.set(origin.x+c.sign*.48,origin.y-.65,origin.z+.20-launch.strike*.5);
          c.pole.lerp(this.v,launch.weight);c.thrustShare=Math.max(c.thrustShare,launch.strike);
        }
        if(authored&&locomotion>.001){
          this.sampleDirections(c);
          c.goal.lerp(this.v,locomotion);c.pole.lerp(this.knee,locomotion);
          if(c.type==='leg'){
            const key=c.side+'_footForward',w=this.walkFrames;
            if(w.a[key]){
              this.v.set(value(w,key,0),value(w,key,1),value(w,key,2)).normalize();
              endPitch=clamp(Math.atan2(-this.v.y,Math.hypot(this.v.x,this.v.z)),-.55,.65)*locomotion;
            }
          }
        }
        if(this.water>.001){
          const stroke=this.time*(c.type==='leg'?3.2:2.0)+(c.side==='L'?0:Math.PI);
          if(c.type==='arm')this.v.set(c.sign*Math.max(.95,Math.abs(origin.x)+.38+.12*Math.sin(stroke)),origin.y-.67+.08*Math.sin(stroke),origin.z+.55+.20*Math.cos(stroke));
          else this.v.copy(c.points[2]).add(this.j.set(c.sign*.055*Math.sin(stroke),.24+.10*Math.cos(stroke),.12+.18*Math.sin(stroke)));
          c.goal.lerp(this.v,this.water);c.footPlant*=1-this.water;
        }
        if(rollTuck>.001){
          if(c.type==='leg'){
            this.v.set(origin.x+c.sign*.09,origin.y-reach*.48,origin.z+.64+(c.side==='L'?.12:0));
            c.goal.lerp(this.v,rollTuck);
            c.footPlant*=1-rollTuck;
          }else{
            const catchHand=c.side==='L'?(1-smooth(.08,.30,rollAge))*smooth(.1,.65,rollTuck):0;
            this.v.set(origin.x+c.sign*(.24+.16*catchHand),
              origin.y-.24-.60*catchHand,origin.z+.59+.22*catchHand);
            c.goal.lerp(this.v,rollTuck);
          }
        }
        if(landingWeight>.001){
          if(c.type==='leg'){
            this.v.copy(c.points[2]).applyQuaternion(FACING);
            // Lead with the downhill/travel-side foot and stagger on a skid.
            this.v.x+=c.sign*(.15+.08*Math.max(0,-c.sign*slideX))-.14*slideX;
            this.v.z-=.24*slideZ+c.sign*.14*Math.max(.35,Math.abs(slideX)+Math.abs(slideZ));
            this.frame.parent.localToWorld(this.v);
            this.frame.worldToLocal(this.v);
            c.goal.lerp(this.v,landingWeight);
            c.footPlant=Math.max(c.footPlant,brace);
          }else{
            this.v.set(origin.x+c.sign*(.57+.16*Math.max(0,c.sign*slideX)),
              origin.y-.67+.17*c.sign*slideX,origin.z+.40+.24*slideZ);
            c.goal.lerp(this.v,landingWeight);
          }
        }
        if(s.laser&&c.side==='R'&&c.type==='arm')c.goal.set(Math.max(.95,origin.x+.25),origin.y-.25,origin.z+1.3);
        if(c.type==='arm'&&!(s.laser&&c.side==='R')){
          if(locomotion>.001)this.armClearance.apply(origin,c.goal,c.pole,c.sign,locomotion*(1-this.run*locomotion));
          else if(c.goal.y>1.15&&c.goal.y<2.65){
            // Airborne steering still keeps gloves outside the torso.
            const z=(c.goal.z-.04)/.77;
            const clearance=.14+.78*Math.sqrt(Math.max(0,1-z*z));
            if(Math.abs(z)<1&&c.sign*c.goal.x<clearance)c.goal.x=c.sign*clearance;
          }
        }
        if(c.type==='arm'&&powered>.001){
          // Prevent the pole from crossing the hand ray without changing
          // the established pose when its elbow plane is already well defined.
          this.upperDir.copy(c.goal).sub(origin).normalize();
          this.lowerDir.set(c.sign,0,0).addScaledVector(this.upperDir,-c.sign*this.upperDir.x);
          const length=this.lowerDir.length();
          if(length>.001){
            this.lowerDir.divideScalar(length);this.v.copy(c.pole).sub(origin);
            const gap=.18-this.v.dot(this.lowerDir);
            const correction=.5*(gap+Math.sqrt(gap*gap+.0004))*smooth(.05,.35,length)*this.air*powered;
            c.pole.addScaledVector(this.lowerDir,correction);
          }
        }
        // Authored gait already has coordinated, smooth joint timing. Filter
        // changing state targets, not every foot/hand inside an established
        // stride; doing both discarded the original run's elbow/heel recovery.
        this.rawTarget.copy(c.goal);this.rawPole.copy(c.pole);
        const direct=Math.max(authored?smooth(.30,.90,locomotion):0,launch.weight,brace,rollTuck*.72);
        const omega=c.type==='leg'&&ground>.5?55:24,decay=Math.exp(-omega*h);
        this.v.copy(c.filtered).sub(c.goal);this.j.copy(c.targetVelocity).addScaledVector(this.v,omega);
        c.filtered.copy(c.goal).add(this.v.addScaledVector(this.j,h).multiplyScalar(decay));
        c.targetVelocity.addScaledVector(this.j,-omega*h).multiplyScalar(decay).clampLength(0,c.type==='leg'&&ground>.5?36:10);
        if(h>0){
          c.goal.copy(c.filtered).lerp(this.rawTarget,direct);c.filtered.copy(c.goal);
          c.filteredPole.lerp(this.rawPole,1-Math.exp(-24*h));
          c.pole.copy(c.filteredPole).lerp(this.rawPole,direct);c.filteredPole.copy(c.pole);
        }
        c.runTracking=0;
        this.solve(c,h,endPitch);
      }
      if(this.rollFloor){
        // Fit the tucked suit to the surface using the helmet, torso, joints,
        // and the same sampled boot soles used for planted walking.
        const parent=this.frame.parent;
        parent.getWorldPosition(this.j);
        const scale=parent.getWorldScale(this.v).y;
        let low=Infinity;
        for(const c of this.chains){
          for(const node of c.nodes){
            low=Math.min(low,node.getWorldPosition(this.v).sub(this.j).dot(this.rollUp)-scale*.22);
          }
          if(c.soleSamples)for(const point of c.soleSamples){
            low=Math.min(low,c.nodes[2].localToWorld(this.v.copy(point)).sub(this.j).dot(this.rollUp));
          }
        }
        for(const t of this.torso){
          const radius=t.source==='Head'?.48:.38;
          low=Math.min(low,t.bone.getWorldPosition(this.v).sub(this.j).dot(this.rollUp)-scale*radius);
        }
        const floorCorrection=this.soleFloor-low/scale;
        parent.getWorldQuaternion(this.parentQ).invert();
        this.frame.position.addScaledVector(this.v.copy(this.rollUp).applyQuaternion(this.parentQ),floorCorrection*(1-smooth(.77,.96,rollAge)));
        this.frame.updateWorldMatrix(true,true);
      }
      if(authored&&s.grounded&&locomotion>.05&&this.legs.every(c=>c.soleSamples&&c.soleSamples.length)){
        const w=this.walkFrames;
        let sourceClearance=Infinity,lowest=Infinity;
        this.frame.updateWorldMatrix(true,true);
        for(const c of this.legs){
          const clear=T.MathUtils.lerp(w.a.footClearance[c.side],w.b.footClearance[c.side],w.u);
          sourceClearance=Math.min(sourceClearance,clear);
          for(const point of c.soleSamples){c.nodes[2].localToWorld(this.v.copy(point));this.frame.parent.worldToLocal(this.v);lowest=Math.min(lowest,this.v.y);}
        }
        const contact=1-smooth(.015,.09,sourceClearance);
        const desired=clamp(this.soleFloor-lowest,-.22,.12)*contact*locomotion;
        this.contactOffset=damp(this.contactOffset,desired,30,h);
        this.frame.position.y+=Math.max(this.contactOffset,this.soleFloor-lowest);
        this.frame.updateWorldMatrix(true,true);
      }else this.contactOffset=damp(this.contactOffset,0,15,h);
      if(runWeight>.001)this.applyRun(runWeight,s);
    }
  }
  g.GodmanMotionSettings=Object.freeze({walkSpeed:1.8,runSpeed:4.4});
  g.GodmanCharacterMotion=BodyController;g.GODMAN_MOTION_BUILD='20261104.31.2';
})(typeof window==='undefined'?globalThis:window);
