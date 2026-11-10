/* Shared by the game and animation-lab.html. Positions are in the fitted suit's
 * coordinate frame (+Z forward), never guessed imported-bone Euler angles. */
(function (global) {
  'use strict';
  const T = global.THREE;
  const clamp = T.MathUtils.clamp;
  const smooth = (a, b, t) => T.MathUtils.smoothstep(t, a, b);
  const damp = (a, b, rate, dt) => T.MathUtils.lerp(a, b, 1 - Math.exp(-rate * dt));
  const X = new T.Vector3(1, 0, 0);
  const REST_FACING = new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 1, 0), Math.PI);

  // Use the reference's clean right-arm track for both sides. Its left take
  // crosses the suit at a different height, provoking a large clearance flare.
  // Reflect in the reference hips frame, BEFORE retargeting into the suit.
  function armReference(clip,phase,side,upper,lower){
    const p=(phase+(side==='L'?.5:0))%1,f=p*(clip.frames.length-1),i=Math.floor(f),u=f-i;
    const a=clip.frames[i].R_arm,b=clip.frames[Math.min(i+1,clip.frames.length-1)].R_arm;
    for(let k=0;k<3;k++){
      upper.setComponent(k,T.MathUtils.lerp(a[k],b[k],u));
      lower.setComponent(k,T.MathUtils.lerp(a[k+3],b[k+3],u));
    }
    if(side==='L'){upper.x*=-1;lower.x*=-1;}
    upper.normalize();lower.normalize();
  }
  global.GodmanArmReference=armReference;
  class ArmClearance{
    constructor(){this.v=new T.Vector3();this.q=new T.Quaternion();this.z=new T.Vector3(0,0,1);}
    apply(origin,goal,pole,sign,weight,allowance=.025){
      const z=(goal.z-.04)/.77,inside=1-z*z;
      // Round the front rim as well as the height limits. A hard height gate
      // used to switch the left shoulder sideways halfway through a walk.
      const chord=Math.sqrt(.5*(inside+Math.sqrt(inside*inside+.04**2)));
      const clearance=.14+.78*chord;
      this.v.copy(goal).sub(origin);
      const dx=sign*this.v.x,dy=this.v.y,radius=Math.hypot(dx,dy);
      const target=clearance-sign*origin.x;
      const angle=clamp(-Math.acos(clamp(target/Math.max(radius,.001),-1,1))-Math.atan2(dy,dx),0,.60);
      const height=smooth(1,1.2,goal.y)*(1-smooth(2.55,2.8,goal.y));
      const below=1-smooth(-.10,.10,goal.y-origin.y);
      const approach=1-smooth(1,1.32,Math.abs(z));
      this.q.setFromAxisAngle(this.z,sign*(angle*height*below*approach+allowance)*weight);
      goal.copy(this.v.applyQuaternion(this.q)).add(origin);pole.sub(origin).applyQuaternion(this.q).add(origin);
      this.q.setFromAxisAngle(X,-.065*weight);
      goal.sub(origin).applyQuaternion(this.q).add(origin);pole.sub(origin).applyQuaternion(this.q).add(origin);
    }
  }
  global.GodmanArmClearance=ArmClearance;

  // Contact, toe-off, heel recovery, forward swing, contact. Values are in
  // leg-length units so the same timing works on this suit's actual skeleton.
  const WALK_KEYS=[[0,.5,0,0],[.60,-.5,0,-.30],[.72,-.34,.09,-.10],[.86,.22,.08,.12],[1,.5,0,0]];
  const RUN_KEYS=[[0,.40,0,.06],[.26,-.50,0,-.48],[.43,-.45,.54,-.34],[.65,-.02,.36,.08],[.84,.47,.10,.16],[1,.40,0,.06]];
  function footCycle(keys,p,out){
    let i=0;while(i<keys.length-2&&p>keys[i+1][0])i++;
    const a=keys[i],b=keys[i+1],h=b[0]-a[0],u=clamp((p-a[0])/h,0,1);
    const prev=i?keys[i-1]:keys[keys.length-2];
    const next=i+2<keys.length?keys[i+2]:keys[1];
    const pt=i?prev[0]:prev[0]-1,nt=i+2<keys.length?next[0]:next[0]+1;
    for(let k=1;k<=3;k++){
      const m0=(b[k]-prev[k])/(b[0]-pt),m1=(next[k]-a[k])/(nt-a[0]);
      out[k-1]=(2*u*u*u-3*u*u+1)*a[k]+(u*u*u-2*u*u+u)*h*m0+(-2*u*u*u+3*u*u)*b[k]+(u*u*u-u*u)*h*m1;
    }
    // The stance portion has constant ground velocity and zero clearance.
    if(p<=keys[1][0]){out[0]=keys[0][1]+(keys[1][1]-keys[0][1])*p/keys[1][0];out[1]=0;}
    out[1]=Math.max(0,out[1]);return out;
  }

  class CharacterMotion {
    constructor(frame, bones) {
      this.frame = frame;
      this.bones = bones;
      this.phase = 0;
      this.time = 0;
      this.air = this.power = this.brake = this.water = this.crouch = this.move = this.run = 0;
      this.turn = 0;
      this.walkSample=[0,0,0];this.runSample=[0,0,0];
      this.rollUp=new T.Vector3();this.rollFloor=false;this.lookExtension = 0;this.flightPivot=new T.Vector3();this.coordinated=false;
      this.chains = [];
      this.q = new T.Quaternion();
      this.inverse = new T.Quaternion();
      this.localDirection = new T.Vector3();
      this.planted = new T.Vector3();
      this.attitude = frame.parent.quaternion.clone();
      this.attitudeTarget = new T.Quaternion();
      this.attitudeTilt = new T.Quaternion();
      this.attitudeIdentity = new T.Quaternion();
      this.force = new T.Vector3();
      this.angularVelocity=new T.Vector3();
      this.angularError=new T.Vector3();
      this.angularAcceleration=new T.Vector3();
      this.rotationStep=new T.Quaternion();
      this.flightLoad=new T.Vector3(0,1,0);
      this.flightEffort=0;
      this.throttle=0;
      this.headJoints = [];
      this.groundTorso=[];
      const allBones=[];frame.traverse(b=>{if(b.isBone)allBones.push(b);});
      // GLTFLoader sanitizes periods out of names: L_index_1.16 becomes
      // L_index_116. Accept both raw GLB and runtime names.
      this.runningFingers=allBones.filter(b=>/^[LR]_(thumb|index|middle|ring|pinky)_[123](?:[._]|\d)/i.test(b.name)).map(b=>{
        const match=b.name.match(/_(thumb|index|middle|ring|pinky)_([123])/i);
        const rest=(b.userData.motionBindQuaternion||b.quaternion).clone();
        const thumb=match[1].toLowerCase()==='thumb',joint=Number(match[2]);
        const target=rest.clone();
        // Thumb opposition is a different axis from finger flexion. Curling
        // it like an index finger left it sticking away from the running fist.
        if(thumb&&joint===1)target.multiply(new T.Quaternion().setFromAxisAngle(new T.Vector3(0,1,0),b.name.startsWith('L')?.4:-.4));
        target.multiply(new T.Quaternion().setFromAxisAngle(new T.Vector3(0,0,1),thumb?-.10:-[.95,1.15,.55][joint-1]));
        return {bone:b,rest,target,active:false};
      });
      frame.updateWorldMatrix(true, true);
      frame.traverse(b => {
        if(b.isBone&&/^Spine_[123](?:[._]|\d)/i.test(b.name))this.groundTorso.push({bone:b,rest:b.quaternion.clone()});
        if (b.isBone && /^(neck|head)[._0-9]/i.test(b.name)) {
          const axis = X.clone().applyQuaternion(frame.getWorldQuaternion(new T.Quaternion()))
            .applyQuaternion(b.parent.getWorldQuaternion(new T.Quaternion()).invert());
          this.headJoints.push({bone:b, rest:b.quaternion.clone(), axis, amount:b.name.startsWith('neck')?.48:.18});
        }
      });
      for (const side of ['L', 'R']) {
        for (const type of ['leg', 'arm']) {
          const names = type === 'leg'
            ? (side === 'L' ? ['L_Thigh.82', 'L_Knee.83', 'L_Ankle.84'] : ['R_Thigh.88', 'R_Knee.89', 'R_Ankle.90'])
            : (side === 'L' ? ['L_Arm.10', 'L_Elbow.11', 'L_Wrist.12'] : ['R_Arm.44', 'R_Elbow.45', 'R_Wrist.46']);
          const nodes = names.map(n => bones[n]);
          if (nodes.some(n => !n)) continue;
          const points = nodes.map(n => frame.worldToLocal(n.getWorldPosition(new T.Vector3())));
          const endQ = frame.getWorldQuaternion(new T.Quaternion()).invert()
            .multiply(nodes[2].getWorldQuaternion(new T.Quaternion()));
          const upperDirection=points[1].clone().sub(points[0]).normalize();
          const lowerDirection=points[2].clone().sub(points[1]).normalize();
          const hingeNormal=new T.Vector3().crossVectors(upperDirection,lowerDirection).normalize();
          const bindBasis=new T.Matrix4().makeBasis(upperDirection,new T.Vector3().crossVectors(hingeNormal,upperDirection).normalize(),hingeNormal);
          const upperInFrame=frame.getWorldQuaternion(new T.Quaternion()).invert().multiply(nodes[0].getWorldQuaternion(new T.Quaternion()));
          const upperBindOffset=new T.Quaternion().setFromRotationMatrix(bindBasis).invert().multiply(upperInFrame);
          const kneeSupport=type==='leg'?allBones.find(b=>b.name.startsWith(side+'_Knee_spo')):null;
          const segments=type==='arm'?allBones.filter(b=>b.name.startsWith(side+'_Arm_')||b.name.startsWith(side+'_Elbow_')).filter(b=>/_segment/.test(b.name)).map(b=>({
            bone:b,rest:(b.userData.motionBindQuaternion||b.quaternion).clone(),position:b.position.clone(),scale:b.scale.clone(),
            forearm:b.name.startsWith(side+'_Elbow_'),index:Number(b.name.match(/_(\d)_segment/)[1])
          })):[];
          const toes=type==='leg'?allBones.filter(b=>b.name.startsWith(side+'_Toe')).map(b=>({bone:b,q:b.quaternion.clone(),p:b.position.clone(),s:b.scale.clone()})):[];
          const neutralFoot=(nodes[2].userData.motionBindQuaternion||nodes[2].quaternion).clone();
          if(type==='leg'){neutralFoot.x=0;neutralFoot.y=0;neutralFoot.normalize();}
          this.chains.push({type, side, sign: Math.sign(points[0].x) || (side === 'L' ? 1 : -1),
            segments,kneeSupport,supportRest:kneeSupport?kneeSupport.quaternion.clone():null,
            supportPosition:kneeSupport?kneeSupport.position.clone():null,supportScale:kneeSupport?kneeSupport.scale.clone():null,toes,neutralFoot,
            positions:nodes.map(n=>n.position.clone()),scales:nodes.map(n=>n.scale.clone()),
            upperBindOffset,basis:new T.Matrix4(),normal:new T.Vector3(),basisY:new T.Vector3(),footPlant:1,
            nozzleAxis:new T.Vector3(0,-1,0).applyQuaternion(frame.getWorldQuaternion(new T.Quaternion())).applyQuaternion(nodes[2].getWorldQuaternion(new T.Quaternion()).invert()),
            nodes, points, endQ, rest: nodes.map(n => n.quaternion.clone()),
            previous: nodes.map(n => n.quaternion.clone()),
            goal: points[2].clone(), pole: new T.Vector3(),
            a: new T.Vector3(), b: new T.Vector3(), c: new T.Vector3(), target: new T.Vector3(),
            axis: new T.Vector3(), bend: new T.Vector3(), mid: new T.Vector3(),
            from: new T.Vector3(), to: new T.Vector3(), delta: new T.Quaternion(),
            worldQ: new T.Quaternion(), parentQ: new T.Quaternion(), endTarget: new T.Quaternion()});
        }
      }
    }

    reset(){
      this.coordinated=false;this.flightPivot.set(0,0,0);
      this.phase=this.time=this.air=this.power=this.brake=this.water=this.crouch=this.move=this.run=this.turn=0;
      this.frame.position.set(0,0,0);this.frame.rotation.set(0,Math.PI,0);
      this.attitude.copy(this.frame.parent.quaternion);
      this.angularVelocity.set(0,0,0);this.flightLoad.set(0,1,0);this.flightEffort=this.throttle=0;
      for(const c of this.chains){c.footPlant=1;c.nodes.forEach((n,i)=>{n.quaternion.copy(c.rest[i]);c.previous[i].copy(c.rest[i]);});}
    }

    orient(dt, base, up, thrust, velocity, grounded, water, space=0, sharedRig=null, landing=null) {
      this.flightRig=sharedRig;
      this.rollFloor=grounded&&!water&&!!landing?.roll&&landing.age<.96;
      if(this.rollFloor)this.rollUp.copy(up);
      this.coordinated=!!sharedRig&&!grounded&&!water;
      if(this.coordinated){
        this.attitude.copy(sharedRig.attitude);
        if(landing&&landing.flare>0)this.attitude.slerp(base,landing.flare);
        this.angularVelocity.copy(sharedRig.angularVelocity);
        this.frame.parent.quaternion.copy(this.attitude);this.inverse.copy(this.attitude).invert();
        this.flightLoad.copy(thrust).applyQuaternion(this.inverse);
        const pivot=this.chains[0].points[0].y;
        this.flightPivot.copy(up).applyQuaternion(this.inverse).multiplyScalar(pivot);this.flightPivot.y-=pivot;
        this.lookExtension=clamp(1-Math.abs(sharedRig.bodyUp.dot(up)),0,1);return;
      }
      dt=Math.min(dt,.05);
      this.attitudeTarget.copy(base);
      // Ground/water frames must not reuse the previous frame's body-up scratch
      // as if it were a newly requested thrust vector.
      this.force.copy(up);
      const drifting=!grounded&&!water&&space>.6&&Math.max(this.power,this.brake)<.015;
      if (!grounded && !water) {
        this.force.copy(thrust);
        if (this.brake > .1 && velocity.lengthSq() > 1) this.force.copy(velocity).normalize().negate();
        if (this.force.lengthSq() > .5) {
          this.attitudeTilt.setFromUnitVectors(up, this.force.normalize());
          const tilt=this.attitudeTilt.angleTo(this.attitudeIdentity);
          const limit=T.MathUtils.lerp(.28,.8,clamp(space,0,1));
          this.attitudeTilt.slerp(this.attitudeIdentity,1-Math.min(1,limit/Math.max(tilt,1e-6))*Math.max(this.power,this.brake*.85));
          this.attitudeTarget.premultiply(this.attitudeTilt);
        }
        // Damped attitude servo: turn acceleration and angular velocity persist
        // between frames. A reversal must brake the existing turn before it
        // accelerates in the opposite direction; it cannot switch pose instantly.
        const steps=Math.max(1,Math.ceil(dt*120)),h=dt/steps;
        for(let i=0;i<steps;i++){
          if(drifting)this.angularVelocity.multiplyScalar(Math.exp(-1.8*h));
          else{
            this.rotationStep.copy(this.attitude).invert().multiply(this.attitudeTarget).normalize();
            if(this.rotationStep.w<0)this.rotationStep.set(-this.rotationStep.x,-this.rotationStep.y,-this.rotationStep.z,-this.rotationStep.w);
            const sin=Math.hypot(this.rotationStep.x,this.rotationStep.y,this.rotationStep.z);
            const angle=2*Math.atan2(sin,this.rotationStep.w);
            this.angularError.set(this.rotationStep.x,this.rotationStep.y,this.rotationStep.z).multiplyScalar(angle/Math.max(sin,1e-8));
            this.angularAcceleration.copy(this.angularError).multiplyScalar(24).addScaledVector(this.angularVelocity,-9).clampLength(0,7);
            this.angularVelocity.addScaledVector(this.angularAcceleration,h).clampLength(0,2.4);
          }
          const rate=this.angularVelocity.length();
          if(rate>1e-7){this.angularError.copy(this.angularVelocity).divideScalar(rate);this.rotationStep.setFromAxisAngle(this.angularError,rate*h);this.attitude.multiply(this.rotationStep).normalize();}
        }
      } else {
        this.attitude.copy(base);
        if(this.rollFloor){
          // Turn around the axis across the travel path. Start from the
          // actual incoming pose, not the standing landing orientation.
          const progress=smooth(0,.77,landing.age);
          const pitch=Math.PI*.5+(Math.PI*1.5)*progress;
          this.angularError.crossVectors(up,landing.travel).normalize();
          this.attitudeTilt.setFromAxisAngle(this.angularError,pitch);
          this.attitude.premultiply(this.attitudeTilt);
          this.rotationStep.setFromAxisAngle(this.angularError,Math.PI*1.5*progress);
          this.attitude.slerp(this.rotationStep.multiply(landing.from),1-smooth(0,.24,landing.age));
          this.attitudeTilt.setFromAxisAngle(this.angularError.copy(landing.travel).normalize(),.19*Math.sin(Math.PI*progress));
          this.attitude.premultiply(this.attitudeTilt);
        }else if(grounded&&landing&&landing.from&&landing.age<.32){
          const remaining=1-smooth(0,.32,landing.age);
          const angle=this.attitude.angleTo(landing.from);
          this.attitude.slerp(landing.from,remaining*Math.min(1,.30/Math.max(angle,1e-6)));
        }
        this.angularVelocity.set(0,0,0);
      }
      this.frame.parent.quaternion.copy(this.attitude);
      this.inverse.copy(this.attitude).invert();
      this.flightLoad.copy(this.force).applyQuaternion(this.inverse);
      this.flightEffort=damp(this.flightEffort,this.angularVelocity.length()/2.4,8,dt);
      this.force.set(0,1,0).applyQuaternion(this.attitude);
      this.lookExtension=clamp(Math.acos(clamp(this.force.dot(up),-1,1))/1.3,0,1);
    }

    nozzleShare(type,side){
      const chain=this.chains.find(c=>c.type===(type==='hand'?'arm':'leg')&&c.sign===side);
      if(chain&&chain.thrustShare!==undefined)return chain.thrustShare;
      const roll=clamp(this.angularVelocity.z*.3+this.flightLoad.x*.25,-.35,.35);
      return type==='hand'?clamp(.30+this.flightEffort*.55+this.brake*.35+side*roll,.15,1)
        :clamp(.9-side*roll*.45,.6,1.1);
    }

    // Two-bone IK: a single, explicitly chosen bend plane. The knee always
    // bends toward the front; elbows bend out/back. Never reflect the hinge.
    solve(chain, dt, endPitch) {
      const c = chain, [upper, lower, end] = c.nodes;
      upper.updateWorldMatrix(true, true);
      upper.getWorldPosition(c.a); lower.getWorldPosition(c.b); end.getWorldPosition(c.c);
      const l1 = c.a.distanceTo(c.b), l2 = c.b.distanceTo(c.c);
      this.frame.localToWorld(c.target.copy(c.goal));
      c.axis.subVectors(c.target, c.a);
      const distance = clamp(c.axis.length(), Math.abs(l1 - l2) + .001, (l1 + l2) * .985);
      c.axis.normalize();
      c.target.copy(c.a).addScaledVector(c.axis, distance);
      this.frame.localToWorld(c.bend.copy(c.pole));
      c.bend.sub(c.a).addScaledVector(c.axis, -c.bend.dot(c.axis));
      if (c.bend.lengthSq() < 1e-8) c.bend.set(0, 0, 1).cross(c.axis);
      c.bend.normalize();
      const along = (l1 * l1 - l2 * l2 + distance * distance) / (2 * distance);
      c.mid.copy(c.a).addScaledVector(c.axis, along)
        .addScaledVector(c.bend, Math.sqrt(Math.max(0, l1 * l1 - along * along)));
      const aim = (bone, childPosition, target, origin) => {
        c.from.subVectors(childPosition, origin).normalize();
        c.to.subVectors(target, origin).normalize();
        c.delta.setFromUnitVectors(c.from, c.to);
        bone.getWorldQuaternion(c.worldQ);
        bone.parent.getWorldQuaternion(c.parentQ).invert();
        bone.quaternion.copy(c.parentQ).multiply(c.delta).multiply(c.worldQ);
        bone.updateWorldMatrix(false, true);
      };
      {
        // Match the full upper-limb frame, including the hinge axis. Merely
        // pointing the upper arm at the elbow leaves its axial twist free;
        // the elbow skin then rotates sideways as the shoulder swings.
        c.from.subVectors(c.mid,c.a).normalize();
        c.to.subVectors(c.target,c.mid).normalize();
        c.normal.crossVectors(c.from,c.to).normalize();
        c.basisY.crossVectors(c.normal,c.from).normalize();
        c.basis.makeBasis(c.from,c.basisY,c.normal);
        c.worldQ.setFromRotationMatrix(c.basis).multiply(c.upperBindOffset);
        upper.parent.getWorldQuaternion(c.parentQ).invert();
        upper.quaternion.copy(c.parentQ).multiply(c.worldQ);
        upper.updateWorldMatrix(false,true);
      }
      lower.getWorldPosition(c.b); end.getWorldPosition(c.c);
      aim(lower, c.c, c.target, c.b);
      if(c.type==='arm'){
        // A hand follows its forearm. Keeping the standing hand orientation
        // in world space produces the old limp/zombie wrist during arm swings.
        end.quaternion.copy(c.rest[2]);
        // Idle contains a deliberately bent relaxed wrist. During running,
        // use the neutral bind alignment so hand and forearm form one line.
        const running=this.move*this.run*(1-this.air)*(1-this.water);
        end.quaternion.slerp(end.userData.motionBindQuaternion||c.rest[2],Math.max(running,this.power,this.brake,this.launchAimWeight||0));
        this.frame.getWorldQuaternion(c.worldQ);
        end.parent.getWorldQuaternion(c.parentQ).invert();
        c.from.copy(X).applyQuaternion(c.worldQ).applyQuaternion(c.parentQ);
        c.endTarget.setFromAxisAngle(c.from,endPitch);
        end.quaternion.premultiply(c.endTarget);
      }else{
        // Plant against the upright ground frame, not the leaning visual root.
        // Otherwise crouching pitches both soles through the floor.
        this.frame.parent.getWorldQuaternion(c.worldQ);
        c.worldQ.multiply(REST_FACING);
        c.endTarget.setFromAxisAngle(X, endPitch);
        c.worldQ.multiply(c.endTarget).multiply(c.endQ);
        end.parent.getWorldQuaternion(c.parentQ).invert();
        c.endTarget.copy(c.parentQ).multiply(c.worldQ);
        // In flight the boot follows the shin, instead of remaining horizontal
        // while the lower leg folds away from it.
        end.quaternion.copy(c.neutralFoot).slerp(c.endTarget,(1-this.air)*c.footPlant);
        const footAim=this.air*Math.max(this.power,this.brake);
        if(footAim>.001&&c.exhaust){
          end.getWorldQuaternion(c.worldQ);
          c.from.copy(c.nozzleAxis).applyQuaternion(c.worldQ).normalize();
          this.frame.getWorldQuaternion(c.parentQ);c.to.copy(c.exhaust).applyQuaternion(c.parentQ).normalize();
          c.delta.setFromUnitVectors(c.from,c.to);
          const angle=c.delta.angleTo(this.attitudeIdentity);
          c.delta.slerp(this.attitudeIdentity,1-Math.min(1,.6/Math.max(angle,1e-6))*footAim);
          end.parent.getWorldQuaternion(c.parentQ).invert();
          end.quaternion.copy(c.parentQ).multiply(c.delta).multiply(c.worldQ);
        }
        // The IK contact target is not allowed to fold the boot into the calf.
        // These are conservative rig limits, not an attempt to force every
        // planted frame flat by exceeding the available ankle articulation.
        c.delta.copy(c.neutralFoot).invert().multiply(end.quaternion).normalize();
        if(c.delta.w<0)c.delta.set(-c.delta.x,-c.delta.y,-c.delta.z,-c.delta.w);
        const sin=Math.hypot(c.delta.x,c.delta.y,c.delta.z);
        const angle=2*Math.atan2(sin,c.delta.w);
        // The imported ankle axes differ between legs. Use a bind-relative
        // cone, not XYZ clamps that incorrectly clip normal dorsiflexion.
        // Ease into the running ankle limit instead of abruptly stopping its
        // angular velocity at the cone boundary. Sole adaptation otherwise
        // transfers that catch into the knee and thigh on the next solve.
        const u=clamp((angle-.5)/.3,0,1);
        const softBound=angle<=.5?angle:angle>=.8?.65:.5+.3*(u-u**3+.5*u**4);
        const bounded=T.MathUtils.lerp(Math.min(angle,.65),softBound,c.runTracking||0);
        c.from.set(c.delta.x,c.delta.y,c.delta.z).divideScalar(Math.max(sin,1e-8));
        c.delta.identity();if(bounded>1e-8)c.delta.setFromAxisAngle(c.from,bounded);
        end.quaternion.copy(c.neutralFoot).multiply(c.delta);
      }
      const runningHand=this.move*this.run*(1-this.air)*(1-this.water);
      const flightHand=Math.max(this.power,this.brake,this.launchAimWeight||0);
      if(c.type==='arm'&&flightHand>.001&&runningHand<=flightHand){
        // Suit wrists flex on a hinge; aiming must not roll the whole cuff.
        // Work in the neutral hand's local frame, with a continuous front
        // hemisphere target. A behind-palm target is left to the nozzle.
        this.frame.getWorldQuaternion(c.worldQ);
        c.to.copy(c.exhaust||this.exhaust).applyQuaternion(c.worldQ);
        end.getWorldQuaternion(c.parentQ).invert();c.to.applyQuaternion(c.parentQ);
        const participation=c.wristParticipation===undefined?(c.thrustShare===undefined?1:smooth(.18,.65,c.thrustShare)):c.wristParticipation;
        const bend=1.05*Math.tanh(Math.atan2(c.to.x,Math.max(.15,-c.to.y))/1.05)*flightHand*participation;
        c.delta.setFromAxisAngle(c.axis.set(0,0,1),bend);end.quaternion.multiply(c.delta);
      }else if(c.type==='arm'&&this.power+this.brake+runningHand>.001){
        const flightWeight=Math.max(this.power,this.brake);
        const weight=Math.max(flightWeight,runningHand);
        end.updateWorldMatrix(true,false);
        end.getWorldQuaternion(c.worldQ);
        c.from.set(0,-1,0).applyQuaternion(c.worldQ).normalize();
        this.frame.getWorldQuaternion(c.worldQ);
        if(runningHand>flightWeight)c.to.set(-c.sign,0,0).applyQuaternion(c.worldQ);
        else if(c.exhaust)c.to.copy(c.exhaust).applyQuaternion(c.worldQ);
        else if(this.exhaust)c.to.copy(this.exhaust).applyQuaternion(c.worldQ);
        else c.to.set(this.flightLoad.x*.35,-1,this.flightLoad.z*.35).normalize().applyQuaternion(c.worldQ);
        lower.getWorldPosition(c.b);end.getWorldPosition(c.c);
        c.axis.subVectors(c.c,c.b).normalize();
        c.bend.copy(c.from).projectOnPlane(c.axis).normalize();
        c.target.copy(c.to).projectOnPlane(c.axis).normalize();
        // Forearm pronation/supination aligns the palm first, with no change
        // to elbow position. The wrist supplies only the remaining small bend.
        const roll=clamp(Math.atan2(c.mid.crossVectors(c.bend,c.target).dot(c.axis),c.bend.dot(c.target)),-1.4,1.4)*weight;
        c.delta.setFromAxisAngle(c.axis,roll);
        // In this GLB Elbow is a pure hinge. Pronation belongs on Wrist and
        // the forearm deformation chain, not a twist of the entire elbow.
        // Source clips put ~1/3 of Wrist's axial twist on each of segments 2–4.
        end.getWorldQuaternion(c.worldQ);end.parent.getWorldQuaternion(c.parentQ).invert();
        end.quaternion.copy(c.parentQ).multiply(c.delta).multiply(c.worldQ);
        end.updateWorldMatrix(false,true);
        end.getWorldQuaternion(c.worldQ);
        c.from.set(0,-1,0).applyQuaternion(c.worldQ).normalize();
        c.delta.setFromUnitVectors(c.from,c.to);
        const angle=c.delta.angleTo(this.attitudeIdentity);
        // Running uses forearm rotation, keeping the wrist straight. Powered
        // flight may additionally flex the wrist within its aiming envelope.
        c.delta.slerp(this.attitudeIdentity,1-Math.min(1,.65/Math.max(angle,1e-6))*flightWeight);
        end.parent.getWorldQuaternion(c.parentQ).invert();
        end.quaternion.copy(c.parentQ).multiply(c.delta).multiply(c.worldQ);
      }
      // Smooth the solved rotation, NOT a correction accumulated every frame.
      // Fast contact motion must not be filtered like weightless flight.
      // Filter gait inputs, then track the contact curve promptly; otherwise
      // heel recovery arrives late and a running leg never finishes its swing.
      const groundResponse=this.move*(1-this.air);
      const runTracking=c.runTracking||0;
      const blend = T.MathUtils.lerp(1 - Math.exp(-(22+58*groundResponse) * dt),1,Math.max(runTracking,c.launchTracking||0));
      const jointRate=7.5+10.5*groundResponse+12*runTracking+20*(c.launchTracking||0);
      for (let i = 0; i < 3; i++) {
        const distance=c.previous[i].angleTo(c.nodes[i].quaternion);
        c.previous[i].rotateTowards(c.nodes[i].quaternion,Math.min(distance*blend,jointRate*dt));
        c.nodes[i].quaternion.copy(c.previous[i]);
      }
      if(c.kneeSupport){
        // The shipped skin assigns thousands of knee vertices to this sibling
        // helper. Its original clips drive it at HALF the knee's bend delta.
        // Leaving it on the idle clip creates a second, false knee in the mesh.
        c.delta.copy(c.rest[1]).invert().multiply(lower.quaternion);
        c.delta.slerp(this.attitudeIdentity,.5);
        c.kneeSupport.quaternion.copy(c.supportRest).multiply(c.delta);
        c.kneeSupport.position.copy(c.supportPosition);c.kneeSupport.scale.copy(c.supportScale);
      }
      if(c.type==='arm'){
        // The idle mixer animates these helpers independently. They skin most
        // of the sleeves, so letting idle keep ownership visibly corkscrews
        // the suit even when the three main joint positions are correct.
        let wristTwist=2*Math.atan2(end.quaternion.x,end.quaternion.w);
        wristTwist=T.MathUtils.euclideanModulo(wristTwist+Math.PI,2*Math.PI)-Math.PI;
        for(const segment of c.segments){
          segment.bone.quaternion.copy(segment.rest);
          if(segment.forearm&&segment.index>=2&&segment.index<=4){
            c.delta.setFromAxisAngle(X,wristTwist/3);
            segment.bone.quaternion.multiply(c.delta);
          }
          segment.bone.position.copy(segment.position);segment.bone.scale.copy(segment.scale);
        }
      }
      upper.updateWorldMatrix(false, true);
    }

    update(dt, s) {
      dt = Math.min(dt, .05);
      this.time += dt;
      this.air = damp(this.air, s.grounded ? 0 : 1, 12, dt);
      this.power = damp(this.power, !s.grounded && s.powered ? 1 : 0, 7, dt);
      this.throttle=damp(this.throttle,!s.grounded&&s.powered?(s.throttle===undefined?1:s.throttle):0,8,dt);
      this.brake = damp(this.brake, !s.grounded ? s.brake || 0 : 0, 6, dt);
      this.water = damp(this.water, s.water ? 1 : 0, 5, dt);
      this.crouch = damp(this.crouch, s.grounded ? Math.max(s.charge || 0, s.landing || 0) : 0, s.grounded ? 11 : 20, dt);
      this.move = damp(this.move, s.grounded && !s.water ? clamp((s.speed || 0) / .6, 0, 1) * (1 - this.crouch) : 0, 9, dt);
      this.run = damp(this.run, clamp(((s.speed || 0) - 2) / 3.5, 0, 1), 7, dt);
      this.turn = damp(this.turn, clamp(s.grounded?(s.turn||0):this.flightLoad.x+this.angularVelocity.z*.2, -1, 1), 5, dt);
      const cadence = T.MathUtils.lerp(1.15, 1.65, this.run);
      this.phase = (this.phase + dt * cadence * Math.min(1, (s.speed || 0) / 1.1)) % 1;
      const launch = this.air * (1 - smooth(.15, .65, s.airTime || 0)) * (1 - this.power);
      const groundLaunch=launch*(1-(s.space||0));
      const earthAir=this.air*(1-(s.space||0))*(1-this.power)*(1-this.water);
      const jumpTuck=earthAir*smooth(.08,.28,s.airTime||0)*(1-smooth(.45,.85,s.airTime||0));
      const relaxed = this.air * (1 - this.power) * (1 - launch);
      const fall = relaxed * (1 - (s.space || 0));
      const breath = Math.sin(this.time * 1.8) * .009;
      // COM is lowest at mid-support, highest in flight. The previous cosine
      // peaked at touchdown and kept the knees loaded through aerial recovery.
      const supportPhase=(this.phase% .5)*2;
      const bounce=this.move*T.MathUtils.lerp(.025*Math.sin(this.phase*Math.PI*4),
        .09*Math.cos((supportPhase-.76)*Math.PI*2),this.run);
      const legs=this.chains.filter(c=>c.type==='leg');
      const leg=legs[0],legReach=leg?leg.points[0].distanceTo(leg.points[1])+leg.points[1].distanceTo(leg.points[2]):1.68;
      const legHeight=leg?leg.points[0].y-leg.points[2].y:1.65;
      const stanceFraction=T.MathUtils.lerp(.60,.24,this.run);
      const strideDistance=(s.speed||0)/.45*stanceFraction/cadence;
      // Derive pelvis height from leg reach and requested stride. Previously
      // the upright pelvis forced the solver to shorten every step: shuffling.
      // A walk rises over the supporting leg at mid-stance. Using the longest
      // stride's required crouch for the ENTIRE cycle produced a bent-knee
      // shuffle. Only the feet currently in contact constrain pelvis height.
      let supportReach=0;
      for(const p of [this.phase,(this.phase+.5)%1]){
        if(p<stanceFraction)supportReach=Math.max(supportReach,Math.abs(strideDistance*(.5-p/stanceFraction)));
      }
      const supportDrop=clamp(legHeight-Math.sqrt(Math.max(.4,(legReach*.985)**2-supportReach**2))+.025,.025,.36);
      const runDrop=clamp(legHeight-Math.sqrt(Math.max(.4,(legReach*.985)**2-(strideDistance*.40)**2))+.015,.025,.28);
      const gaitDrop=T.MathUtils.lerp(supportDrop,runDrop,this.run);
      const lower = this.crouch * .34 + this.move * gaitDrop;
      const bodyPitch=-this.crouch*.28-this.move*this.run*.10;
      const pelvisPivot=leg?leg.points[0].y:1.38;
      // Lean about the pelvis, not the feet. Rotating the whole visual about
      // its origin used to swing the hips forward and undo the hip hinge.
      this.frame.position.y = -lower + bounce + breath+pelvisPivot*(1-Math.cos(bodyPitch));
      // Hip hinge: move the pelvis BACK as it lowers. A vertical-only squat
      // forces the tibia almost horizontal and folds the ankle into the boot.
      this.frame.position.z = this.crouch * .42-pelvisPivot*Math.sin(bodyPitch);
      this.frame.rotation.set(bodyPitch,
        Math.PI, this.turn * this.power * .10);
      this.frame.updateWorldMatrix(true, true);
      // Shoulders counter-rotate against the stride. Keeping the whole trunk
      // on an idle breathing clip made both gaits read as rigid puppets.
      const groundWeight=(1-this.air)*(1-this.water)*this.move;
      const handWeight=groundWeight*this.run*(s.laser?0:1);
      for(const f of this.runningFingers){
        if(handWeight>.001){f.bone.quaternion.copy(f.rest).slerp(f.target,handWeight);f.active=true;}
        else if(f.active){f.bone.quaternion.copy(f.rest);f.active=false;}
      }
      const strideWave=Math.sin(this.phase*Math.PI*2);
      for(const t of this.groundTorso){
        if(groundWeight>.001){
          this.q.setFromAxisAngle(this.localDirection.set(0,1,0),strideWave*(.035+.035*this.run)*groundWeight);
          t.bone.quaternion.copy(t.rest).multiply(this.q);t.active=true;
        }else if(t.active){
          t.bone.quaternion.copy(t.rest);t.active=false;
        }
      }
      this.frame.updateWorldMatrix(true,true);
      for (const h of this.headJoints) {
        this.q.setFromAxisAngle(h.axis, -h.amount * this.power * this.lookExtension);
        h.bone.quaternion.copy(h.rest).premultiply(this.q);
      }
      for (const c of this.chains) {
        c.nodes.forEach((n, i) => {n.quaternion.copy(c.rest[i]);n.position.copy(c.positions[i]);n.scale.copy(c.scales[i]);});
        c.toes.forEach(t=>{t.bone.quaternion.copy(t.q);t.bone.position.copy(t.p);t.bone.scale.copy(t.s);});
        c.goal.copy(c.points[2]);
        const hip = c.points[0], sidePhase = (this.phase + (c.side === 'L' ? 0 : .5)) % 1;
        let endPitch = 0;
        if (c.type === 'leg') {
          const runningGround=this.run*this.move*(1-this.air);
          // Idle is an asymmetric relaxed stance. Running contacts need a
          // common forward line and a narrow track below the hips.
          const contactZ=legs.reduce((sum,l)=>sum+l.points[2].z,0)/legs.length;
          c.goal.x=T.MathUtils.lerp(c.goal.x,hip.x+c.sign*.025,runningGround);
          c.goal.z=T.MathUtils.lerp(c.goal.z,contactZ,runningGround);
          // Feet stay on the floor during charge and impact, while pelvis drops.
          c.pole.set(hip.x, hip.y - .6, hip.z + 3);
          // Running has a shorter contact phase and a real flight phase;
          // increasing stride beyond leg reach makes a foot hover above ground.
          const stance = stanceFraction;
          const legLength=c.points[0].distanceTo(c.points[1])+c.points[1].distanceTo(c.points[2]);
          // Do not shrink stride again as the pelvis rises: that changes the
          // planted foot's ground speed halfway through a step (foot skating).
          const stride = Math.min(legLength*1.5, (s.speed || 0) / .45 * stance / cadence);
          const w=footCycle(WALK_KEYS,sidePhase,this.walkSample),r=footCycle(RUN_KEYS,sidePhase,this.runSample);
          c.goal.z+=this.move*stride*T.MathUtils.lerp(w[0],r[0],this.run);
          c.goal.y+=this.move*legLength*T.MathUtils.lerp(w[1],r[1],this.run);
          endPitch=this.move*T.MathUtils.lerp(w[2],r[2],this.run);
          const plantedWeight=sidePhase<stance?1-smooth(stance*.75,stance,sidePhase):smooth(.85,1,sidePhase);
          c.footPlant=damp(c.footPlant,1-this.move+this.move*plantedWeight,25,dt);
          // Convert the stance from an upright, unshifted body frame. This
          // cancels pelvis lean/bob instead of sliding feet with the torso.
          this.planted.copy(c.goal).applyQuaternion(REST_FACING);
          this.frame.parent.localToWorld(this.planted);
          this.frame.worldToLocal(this.planted);
          c.goal.lerp(this.planted, 1 - this.air);
          // Don't pull the ankles up to the pelvis to express weightlessness.
          // A slight unlocked knee reads as a relaxed human, not a seated squat.
          c.goal.y += relaxed * .07 + fall * .03;
          c.goal.z -= relaxed * .06;
          c.goal.x += c.sign * (relaxed * .02 + this.brake * .04);
          c.goal.y -= launch * .03;
          c.goal.z -= launch * .06;
          // A small trailing knee after push-off, not a crouch held in midair.
          c.goal.y+=groundLaunch*(c.side==='L'?.08:.16);
          c.goal.z-=groundLaunch*(c.side==='L'?.04:.12);
          // Recover after push-off, then extend for the descent. The previous
          // terrestrial jump kept the same nearly standing leg targets aloft.
          c.goal.y+=jumpTuck*(c.side==='L'?.30:.22);
          c.goal.z-=jumpTuck*.16;
          c.goal.z += this.power * (.02 + c.sign * this.turn * .025);
          c.goal.y -= this.power * .015;
          c.goal.y += this.brake * .08;
          c.goal.x+=this.power*c.sign*this.flightEffort*.04;
          c.goal.z+=this.power*clamp(this.flightLoad.z*.10+c.sign*this.angularVelocity.y*.04,-.14,.14);
          endPitch += this.power * -.10 + relaxed * .10;
          if (this.water > .01) {
            c.goal.y += this.water * (.25 + .14 * Math.sin(this.time * 5 + c.sign));
            c.goal.z += this.water * .35 * Math.sin(this.time * 5 + c.sign * Math.PI / 2);
          }
        } else {
          // Elbows behind/outside the torso, hands never pulled behind it.
          c.pole.set(hip.x + c.sign * 1.6, hip.y - .9, hip.z - 1.6);
          c.goal.x = hip.x + c.sign * (.13 + this.power * .17 + relaxed * .17 + this.brake * .25);
          c.goal.y = hip.y - 1.42 + this.crouch * .12;
          c.goal.z = hip.z + .12 - this.crouch * .20;
          // Left leg contacts forward at phase zero: left arm must be BACK.
          const swing = -Math.cos(this.phase * Math.PI * 2 + (c.side === 'L' ? 0 : Math.PI));
          c.goal.z += this.move * swing * (.35 + this.run * .36);
          c.goal.y += this.move * this.run * (.66+.10*swing);
          // Athletic arm carriage: the shoulder swings a bent elbow rather
          // than sending a mostly straight hand on a large forward/back arc.
          const upperArm=c.points[0].distanceTo(c.points[1]);
          const forearm=c.points[1].distanceTo(c.points[2]);
          const shoulderAngle=swing*.35+.12;
          const elbowAngle=1.55+.05*swing;
          const athletic=this.move*this.run*(1-this.air);
          c.pole.x=T.MathUtils.lerp(c.pole.x,hip.x+c.sign*.16,athletic);
          c.pole.z=T.MathUtils.lerp(c.pole.z,hip.z-.8,athletic);
          c.goal.y=T.MathUtils.lerp(c.goal.y,hip.y-upperArm*Math.cos(shoulderAngle)-forearm*Math.cos(shoulderAngle+elbowAngle),athletic);
          c.goal.z=T.MathUtils.lerp(c.goal.z,hip.z+upperArm*Math.sin(shoulderAngle)+forearm*Math.sin(shoulderAngle+elbowAngle),athletic);
          // Countermovement to a chest-height drive, not an overhead reach.
          c.goal.z-=this.crouch*.18;
          c.goal.y += launch * (c.side === 'L' ? 2.45 : 2.25)*(s.space||0)+groundLaunch*.95;
          c.goal.z += launch * .82*(s.space||0)+groundLaunch*.58;
          c.goal.y += relaxed * (.30 + (s.space || 0) * .22);
          c.goal.z += relaxed * .48;
          c.goal.y += this.power * (.12 + Math.max(0, c.sign * this.turn) * .20) + this.brake * .58;
          c.goal.z += this.power * .12 + this.brake * .60;
          // Stabilising hands respond to body-relative thrust demand and turn
          // rate, with more separation on the loaded side of a manoeuvre.
          c.goal.x+=c.sign*this.power*(this.flightEffort*.16+Math.max(0,c.sign*this.flightLoad.x)*.14);
          c.goal.y+=this.power*clamp(c.sign*this.angularVelocity.z*.16,-.20,.20);
          c.goal.z+=this.power*clamp(this.flightLoad.z*.25-c.sign*this.angularVelocity.y*.12,-.18,.35);
          if (s.laser && c.side === 'R') { c.goal.y = hip.y - .25; c.goal.z = hip.z + 1.3; }
          c.goal.y += this.water * (.65 + .28 * Math.sin(this.time * 2.8));
          c.goal.z += this.water * (.55 + .35 * Math.cos(this.time * 2.8));
          // Wrist targets need room for the *glove*, not just its joint point.
          // Keep the complete hand outside the torso/hip envelope throughout
          // the running swing, including its rear-most position beside the belt.
          if(c.goal.y<hip.y+.2){
            const clearance=.92+this.move*this.run*.02;
            c.goal.x=c.sign*Math.max(Math.abs(c.goal.x),clearance);
          }
          if(athletic>.01&&!s.laser){
            // Include lateral glove clearance in the reach budget. Applying
            // clearance AFTER the elbow pose used to straighten the whole arm.
            const reach=Math.sqrt(upperArm*upperArm+forearm*forearm+2*upperArm*forearm*Math.cos(1.35));
            this.localDirection.copy(c.goal).sub(hip);
            const length=this.localDirection.length();
            if(length>reach){
              const lateral=c.goal.x-hip.x;
              const available=Math.sqrt(Math.max(.01,reach*reach-lateral*lateral));
              const sagittal=Math.hypot(this.localDirection.y,this.localDirection.z);
              const correction=T.MathUtils.lerp(1,Math.min(1,available/Math.max(sagittal,.001)),athletic);
              c.goal.y=hip.y+this.localDirection.y*correction;
              c.goal.z=hip.z+this.localDirection.z*correction;
            }
          }
          endPitch = this.brake * -.40;
        }
        this.solve(c, dt, endPitch);
      }
    }
  }

  // A soft, tapering jet, rooted at the nozzle. No inverted solid cones and
  // no time-random flicker: flow travels away from the emitter along -Y.
  function createRepulsorPlume(type) {
    const foot = type === 'foot';
    const material = new T.ShaderMaterial({transparent: true, depthWrite: false,
      blending: T.CustomBlending, blendSrc: T.OneFactor, blendDst: T.OneMinusSrcAlphaFactor, side: T.DoubleSide,
      uniforms: {strength: {value: 0}, time: {value: 0}, heat: {value: 0}},
      vertexShader: `varying vec2 vUv; varying float facing; uniform float strength;
        #include <common>
        #include <logdepthbuf_pars_vertex>
        void main(){vUv=uv;vec3 p=position;p.y*=.35+.9*sqrt(clamp(strength,0.,1.));
        vec4 view=modelViewMatrix*vec4(p,1.);facing=abs(dot(normalize(normalMatrix*normal),normalize(-view.xyz)));
        gl_Position=projectionMatrix*view;
        #include <logdepthbuf_vertex>
        }`,
      fragmentShader: `varying vec2 vUv; varying float facing; uniform float strength,time,heat;
        #include <common>
        #include <logdepthbuf_pars_fragment>
        void main(){
          #include <logdepthbuf_fragment>
          float t=1.-vUv.y;
          float edge=pow(facing,.65);
          float fade=pow(1.-t,1.7);
          float diamonds=pow(.5+.5*cos(t*58.-time*3.),8.)*exp(-t*2.);
          float flow=.94+.06*sin(t*45.-time*26.);
          vec3 col=mix(vec3(.10,.42,1.4),vec3(3.,3.8,4.),exp(-t*9.));
          col+=diamonds*vec3(.4,.8,1.3);
          vec3 hot=mix(vec3(1.45,.42,.04),vec3(2.6,1.45,.39),exp(-t*9.));
          vec3 depleted=mix(vec3(1.2,.018,.008),vec3(2.4,.16,.036),exp(-t*9.));
          col=mix(mix(col,hot,smoothstep(0.,.62,heat)),depleted,smoothstep(.42,1.,heat));
          gl_FragColor=vec4(col,edge*fade*strength*flow*.65);
          #include <tonemapping_fragment>
          #include <encodings_fragment>
          // Keep full-power jets additive. Warm exhaust also occludes a
          // little of the background, so it reads as red against snow.
          gl_FragColor.rgb*=gl_FragColor.a;
          gl_FragColor.a*=smoothstep(.22,1.,heat);
        }`});
    // Concentric closed jets give a continuous silhouette from every angle.
    const group = new T.Group();
    const length = foot ? 1.05 : .62, radius = foot ? .052 : .036;
    for (let layer = 0; layer < 2; layer++) {
      const geometry=new T.CylinderGeometry(radius*(layer?.40:1),radius*.015,length*(layer?.60:1),12,16,true);
      geometry.translate(0,-length*(layer?.60:1)/2,0);
      group.add(new T.Mesh(geometry,material));
    }
    group.userData.material = material;
    return group;
  }
  function createRepulsorAnchor(frame,bone,type){
    const locator=new T.Object3D();
    const axis=new T.Vector3(0,-1,0);
    if(type==='foot'){
      frame.updateWorldMatrix(true,true);
      const p=frame.worldToLocal(bone.getWorldPosition(new T.Vector3()));
      p.y-=.32;p.z+=.12;
      locator.position.copy(bone.worldToLocal(frame.localToWorld(p)));
      axis.applyQuaternion(frame.getWorldQuaternion(new T.Quaternion()))
        .applyQuaternion(bone.getWorldQuaternion(new T.Quaternion()).invert());
    }else locator.position.set(12,-3,0);
    locator.userData.exhaustAxis=axis;
    bone.add(locator);return locator;
  }
  global.GodmanCharacterMotion = CharacterMotion;
  global.GodmanRepulsorPlume = createRepulsorPlume;
  global.GodmanRepulsorAnchor = createRepulsorAnchor;
  const aimWorld=new T.Quaternion(),aimTurn=new T.Quaternion(),aimIdentity=new T.Quaternion(),aimTarget=new T.Vector3();
  global.GodmanRepulsorAim=function(frame,bone,axis,desired,out){
    bone.getWorldQuaternion(aimWorld);out.copy(axis).applyQuaternion(aimWorld).normalize();
    frame.getWorldQuaternion(aimWorld);aimTarget.copy(desired).applyQuaternion(aimWorld).normalize();
    aimTurn.setFromUnitVectors(out,aimTarget);
    const angle=aimTurn.angleTo(aimIdentity);
    // A bounded nozzle gimbal finishes the aim without breaking the wrist or
    // ankle. Poorly aligned emitters fade instead of firing across the suit.
    aimTurn.slerp(aimIdentity,1-Math.min(1,.65/Math.max(angle,1e-6)));
    out.applyQuaternion(aimTurn).normalize();
    return Math.max(0,out.dot(aimTarget))**2;
  };
  global.GODMAN_MOTION_BUILD = '20261101.5';
})(typeof window === 'undefined' ? globalThis : window);
