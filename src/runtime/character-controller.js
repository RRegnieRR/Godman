/* Authored locomotion, contact transitions and reactive flight.
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
      this.v=new T.Vector3();this.j=new T.Vector3();this.upperDir=new T.Vector3();this.lowerDir=new T.Vector3();this.knee=new T.Vector3();
      this.rawTarget=new T.Vector3();this.rawPole=new T.Vector3();
      this.bodyDelta=new T.Quaternion();this.bodyInverse=new T.Quaternion();this.poseQ=new T.Quaternion();this.tempQ=new T.Quaternion();
      this.worldQ=new T.Quaternion();this.parentQ=new T.Quaternion();this.walkFrames={};this.runFrames={};
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
      });
      this.gaitSpeed=this.ready=this.headExtension=this.contactOffset=0;
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
      super.reset();this.gaitSpeed=this.ready=this.headExtension=this.contactOffset=0;
      for(const c of this.chains){c.filtered.copy(c.points[2]);c.targetVelocity.set(0,0,0);c.filteredPole.copy(c.points[1]);}
      for(const t of this.torso)t.bone.quaternion.copy(t.rest);
    }
    update(dt,s){
      const total=clamp(dt,0,.05),count=Math.max(1,Math.ceil(total*120));
      for(let i=0;i<count;i++)this.advance(total/count,s);
    }
    sampleDirections(c){
      const key=c.side+'_'+c.type,w=this.walkFrames,r=this.runFrames;
      for(let i=0;i<3;i++){
        this.upperDir.setComponent(i,T.MathUtils.lerp(value(w,key,i),value(r,key,i),this.run));
        this.lowerDir.setComponent(i,T.MathUtils.lerp(value(w,key,i+3),value(r,key,i+3),this.run));
      }
      this.upperDir.normalize().applyQuaternion(this.bodyInverse);this.lowerDir.normalize().applyQuaternion(this.bodyInverse);
      this.knee.copy(c.origin).addScaledVector(this.upperDir,c.lengthA);
      this.v.copy(this.knee).addScaledVector(this.lowerDir,c.lengthB);
    }
    sampleRotation(key){
      const w=this.walkFrames,r=this.runFrames;
      this.poseQ.fromArray(w.a.torso[key]).slerp(this.tempQ.fromArray(w.b.torso[key]),w.u);
      this.q.fromArray(r.a.torso[key]).slerp(this.tempQ.fromArray(r.b.torso[key]),r.u);
      this.poseQ.slerp(this.q,this.run);
    }
    advance(h,s){
      this.time+=h;
      // Idle formerly kept moving Center/Hip and clavicles underneath the
      // controller. Own every structural ancestor, not just the limb joints.
      for(const b of this.bodyAnchors){b.bone.quaternion.copy(b.q);b.bone.position.copy(b.p);b.bone.scale.copy(b.s);}
      for(const t of this.torso){t.bone.position.copy(t.position);t.bone.scale.copy(t.scale);}
      this.air=damp(this.air,s.grounded?0:1,14,h);this.water=damp(this.water,s.water?1:0,6,h);
      this.power=damp(this.power,!s.grounded&&!s.water&&s.powered?1:0,9,h);
      this.brake=damp(this.brake,!s.grounded&&!s.water?s.brake||0:0,9,h);
      this.throttle=damp(this.throttle,s.powered&&!s.water?(s.throttle===undefined?1:s.throttle):0,10,h);
      this.crouch=damp(this.crouch,s.grounded&&!s.water?Math.max(s.charge||0,s.landing||0):0,12,h);
      this.gaitSpeed=damp(this.gaitSpeed,s.grounded&&!s.water?s.speed||0:0,10,h);
      this.move=damp(this.move,s.grounded&&!s.water?clamp(this.gaitSpeed/.8,0,1)*(1-this.crouch):0,12,h);
      this.run=damp(this.run,clamp((this.gaitSpeed-2)/2.4,0,1),8,h);
      const walk=g.GodmanWalkMotion||g.GodmanRunMotion,run=g.GodmanRunMotion||walk;
      const cadence=T.MathUtils.lerp(1.10,1.60,this.run);
      this.phase=(this.phase+h*cadence*clamp(this.gaitSpeed/1.1,0,1))%1;
      const authored=frames(walk,this.phase,this.walkFrames)&&frames(run,this.phase,this.runFrames);
      const ground=(1-this.air)*(1-this.water),locomotion=this.move*ground;
      const powered=Math.max(this.power,this.brake),free=this.air*(1-powered)*(1-this.water);
      const earthAir=free*(1-(s.space||0)),coast=free*(s.space||0);
      const tuck=earthAir*smooth(.10,.30,s.airTime||0)*(1-smooth(.45,.85,s.airTime||0));
      const impactTime=!s.grounded&&s.verticalSpeed<-.5&&Number.isFinite(s.height)?Math.max(0,s.height)/-s.verticalSpeed:Infinity;
      this.ready=damp(this.ready,(1-smooth(.08,.38,impactTime))*earthAir,10,h);
      this.bodyDelta.identity();
      if(authored&&locomotion>.001){this.sampleRotation('Hips');this.bodyDelta.slerp(this.poseQ,locomotion);}
      this.frame.quaternion.copy(FACING).multiply(this.bodyDelta);
      this.q.setFromAxisAngle(X,-this.crouch*.26+this.water*.07);this.frame.quaternion.multiply(this.q);
      this.bodyInverse.copy(this.bodyDelta).invert();
      this.v.copy(this.legs[0].points[0]).applyQuaternion(this.frame.quaternion);
      const pivotY=this.legs[0].points[0].y;
      this.frame.position.set(0,-this.crouch*.36+pivotY-this.v.y,this.crouch*.42);
      if(authored&&locomotion>.001&&this.walkFrames.a.pelvisHeight!==undefined){
        // One source floor for the whole clip preserves the run's flight phase.
        const height=T.MathUtils.lerp(scalar(this.walkFrames,'pelvisHeight'),scalar(this.runFrames,'pelvisHeight'),this.run)*this.legReach;
        this.frame.position.y=T.MathUtils.lerp(this.frame.position.y,this.floor+height-this.v.y,locomotion);
      }
      this.frame.position.y-=this.ready*.055;
      this.frame.updateWorldMatrix(true,true);this.frame.getWorldQuaternion(this.worldQ);
      for(const t of this.torso){
        t.bone.quaternion.copy(t.rest);
        if(authored&&locomotion>.001){
          this.sampleRotation(t.source);this.poseQ.premultiply(this.bodyInverse);
          this.tempQ.copy(this.worldQ).multiply(this.poseQ).multiply(t.inFrame);
          t.bone.parent.getWorldQuaternion(this.parentQ).invert();this.tempQ.premultiply(this.parentQ);
          t.bone.quaternion.slerp(this.tempQ,locomotion);
        }
        if(t.source==='Spine1'){this.q.setFromAxisAngle(X,Math.sin(this.time*1.8)*.002*(1-locomotion)*(1-this.water));t.bone.quaternion.multiply(this.q);}
        t.bone.updateWorldMatrix(false,true);
      }
      this.headExtension=damp(this.headExtension,powered*this.lookExtension*.55,8,h);
      for(const head of this.headJoints){this.q.setFromAxisAngle(head.axis,-head.amount*this.headExtension);head.bone.quaternion.premultiply(this.q);}
      const curl=clamp(.16+.84*this.run*locomotion+coast*.08-this.power*.16,0,1)*(s.laser?0:1);
      for(const f of this.runningFingers)f.bone.quaternion.copy(f.rest).slerp(f.target,curl);
      this.frame.updateWorldMatrix(true,true);
      this.q.copy(this.frame.quaternion).invert();this.intent.copy(this.flightLoad).applyQuaternion(this.q);
      if(this.intent.lengthSq()<.01)this.intent.set(0,1,0);this.intent.normalize();this.exhaust.copy(this.intent).negate();
      for(const c of this.chains){
        c.nodes.forEach((n,i)=>{n.quaternion.copy(c.rest[i]);n.position.copy(c.positions[i]);n.scale.copy(c.scales[i]);});
        c.toes.forEach(t=>{t.bone.quaternion.copy(t.q);t.bone.position.copy(t.p);t.bone.scale.copy(t.s);});
        // Shoulder origins move with the spine; idle snapshots are not origins.
        this.frame.worldToLocal(c.nodes[0].getWorldPosition(c.origin));
        const origin=c.origin,reach=c.lengthA+c.lengthB;
        c.goal.copy(c.points[2]);let endPitch=0;
        if(c.type==='leg'){
          this.v.copy(c.points[2]).applyQuaternion(FACING);this.frame.parent.localToWorld(this.v);this.frame.worldToLocal(this.v);
          c.goal.lerp(this.v,ground);c.pole.set(origin.x,origin.y-.5,origin.z+2);
          c.goal.y+=tuck*.22+coast*.13+earthAir*.025;c.goal.z-=tuck*.10+coast*.10;
          c.goal.x+=c.sign*(coast*.025+this.ready*.025);c.footPlant=ground;
        }else{
          const shoulder=.08,elbow=.35+coast*.35+earthAir*.16;
          this.v.set(c.sign*Math.max(.93,Math.abs(origin.x)+.26),origin.y-c.lengthA*Math.cos(shoulder)-c.lengthB*Math.cos(shoulder+elbow),origin.z+c.lengthA*Math.sin(shoulder)+c.lengthB*Math.sin(shoulder+elbow));
          c.goal.lerp(this.v,this.air);c.goal.y+=tuck*.38+this.ready*.16;c.goal.z+=tuck*.18+this.ready*.12;
          c.pole.set(origin.x+c.sign*.22,origin.y-.65,origin.z-.9);
          this.v.set(origin.x+c.sign*(.29+this.flightEffort*.12),origin.y-reach*.76,origin.z+.26);
          this.v.addScaledVector(this.intent,powered*.32);
          this.v.z+=clamp(c.sign*this.angularVelocity.y*.10,-.16,.16);this.v.y+=clamp(c.sign*this.angularVelocity.z*.10,-.16,.16);
          c.goal.lerp(this.v,this.air*powered);
        }
        if(authored&&locomotion>.001){
          this.sampleDirections(c);
          c.goal.lerp(this.v,locomotion);c.pole.lerp(this.knee,locomotion);
          if(c.type==='leg'){
            const key=c.side+'_footForward',w=this.walkFrames,r=this.runFrames;
            if(w.a[key]&&r.a[key]){
              this.v.set(T.MathUtils.lerp(value(w,key,0),value(r,key,0),this.run),T.MathUtils.lerp(value(w,key,1),value(r,key,1),this.run),T.MathUtils.lerp(value(w,key,2),value(r,key,2),this.run)).normalize();
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
        if(s.laser&&c.side==='R'&&c.type==='arm')c.goal.set(Math.max(.95,origin.x+.25),origin.y-.25,origin.z+1.3);
        if(c.type==='arm'&&c.goal.y>1.15&&c.goal.y<2.65){
          // A lateral thrust request must not pull the glove through the suit.
          // Allow hands toward the midline only once they are in front of it.
          const z=(c.goal.z-.04)/.77;
          const clearance=.14+.78*Math.sqrt(Math.max(0,1-z*z));
          if(Math.abs(z)<1&&c.sign*c.goal.x<clearance&&authored&&locomotion>.1&&c.goal.y<origin.y-.03){
            // Make room for the pressure suit by abducting the entire arm
            // around its shoulder. Pushing only the wrist outward changes
            // elbow flexion and destroys the source arm swing.
            this.v.copy(c.goal).sub(origin);
            const dx=c.sign*this.v.x,dy=this.v.y,radius=Math.hypot(dx,dy);
            const target=clearance-c.sign*origin.x;
            const angle=clamp(-Math.acos(clamp(target/Math.max(radius,.001),-1,1))-Math.atan2(dy,dx),0,.60);
            this.q.setFromAxisAngle(this.j.set(0,0,1),c.sign*angle);
            c.goal.copy(this.v.applyQuaternion(this.q)).add(origin);
            c.pole.sub(origin).applyQuaternion(this.q).add(origin);
          }else if(Math.abs(z)<1&&c.sign*c.goal.x<clearance)c.goal.x=c.sign*clearance;
        }
        if(c.type==='arm'&&authored&&locomotion>.1&&c.goal.y<origin.y-.1&&c.goal.y>1.15&&c.goal.y<2.65&&c.goal.z>.55){
          // At the front rim, glove fingers extend behind the wrist. Measured
          // skin contact here was only ~1.8mm; more sideways abduction moved
          // crossed fingers toward the torso. Add at most 1.15 degrees of
          // forward shoulder clearance, rotating elbow and hand together.
          const needed=.04+.77*Math.sqrt(Math.max(0,1-(c.goal.x/.92)**2));
          if(c.goal.z<needed){
            this.v.copy(c.goal).sub(origin);
            const radius=Math.hypot(this.v.y,this.v.z),ratio=(needed-origin.z)/Math.max(radius,.001);
            if(ratio<1){
              const angle=clamp(Math.PI-Math.asin(clamp(ratio,-1,1))-Math.atan2(this.v.z,this.v.y),-.02,0);
              this.q.setFromAxisAngle(X,angle);
              c.goal.copy(this.v.applyQuaternion(this.q)).add(origin);
              c.pole.sub(origin).applyQuaternion(this.q).add(origin);
            }
          }
        }
        // Authored gait already has coordinated, smooth joint timing. Filter
        // changing state targets, not every foot/hand inside an established
        // stride; doing both discarded the original run's elbow/heel recovery.
        this.rawTarget.copy(c.goal);this.rawPole.copy(c.pole);
        const direct=authored?smooth(.30,.90,locomotion):0;
        const omega=c.type==='leg'&&ground>.5?55:24,decay=Math.exp(-omega*h);
        this.v.copy(c.filtered).sub(c.goal);this.j.copy(c.targetVelocity).addScaledVector(this.v,omega);
        c.filtered.copy(c.goal).add(this.v.addScaledVector(this.j,h).multiplyScalar(decay));
        c.targetVelocity.addScaledVector(this.j,-omega*h).multiplyScalar(decay).clampLength(0,c.type==='leg'&&ground>.5?36:10);
        if(h>0){
          c.goal.copy(c.filtered).lerp(this.rawTarget,direct);c.filtered.copy(c.goal);
          c.filteredPole.lerp(this.rawPole,1-Math.exp(-24*h));
          c.pole.copy(c.filteredPole).lerp(this.rawPole,direct);c.filteredPole.copy(c.pole);
        }
        this.solve(c,h,endPitch);
      }
      if(authored&&s.grounded&&locomotion>.05&&this.legs.every(c=>c.soleSamples&&c.soleSamples.length)){
        const w=this.walkFrames,r=this.runFrames;
        let sourceClearance=Infinity,lowest=Infinity;
        this.frame.updateWorldMatrix(true,true);
        for(const c of this.legs){
          const clear=T.MathUtils.lerp(T.MathUtils.lerp(w.a.footClearance[c.side],w.b.footClearance[c.side],w.u),T.MathUtils.lerp(r.a.footClearance[c.side],r.b.footClearance[c.side],r.u),this.run);
          sourceClearance=Math.min(sourceClearance,clear);
          for(const point of c.soleSamples){c.nodes[2].localToWorld(this.v.copy(point));this.frame.parent.worldToLocal(this.v);lowest=Math.min(lowest,this.v.y);}
        }
        const contact=1-smooth(.015,.09,sourceClearance);
        const desired=clamp(this.soleFloor-lowest,-.22,.12)*contact*locomotion;
        this.contactOffset=damp(this.contactOffset,desired,30,h);
        // Hard non-penetration remains valid even during a source flight
        // phase; different boot proportions must never enter the floor.
        this.frame.position.y+=Math.max(this.contactOffset,this.soleFloor-lowest);
        this.frame.updateWorldMatrix(true,true);
      }else this.contactOffset=damp(this.contactOffset,0,15,h);
    }
  }
  g.GodmanMotionSettings=Object.freeze({walkSpeed:1.8,runSpeed:4.4});
  g.GodmanCharacterMotion=BodyController;g.GODMAN_MOTION_BUILD='20261102.5';
})(typeof window==='undefined'?globalThis:window);
