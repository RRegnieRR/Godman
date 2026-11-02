/* Body controller v2. The rig adapter supplies calibration, bounded two-bone
 * solving and skin helpers; this module owns all movement targets. */
(function(g){
  'use strict';
  const T=g.THREE, Rig=g.GodmanCharacterMotion, clamp=T.MathUtils.clamp;
  const blend=(a,b,k,dt)=>T.MathUtils.lerp(a,b,1-Math.exp(-k*dt));
  class BodyController extends Rig{
    constructor(frame,bones){
      super(frame,bones);
      this.intent=new T.Vector3(0,1,0);
      this.exhaust=new T.Vector3(0,-1,0);
      this.velocityScratch=new T.Vector3();
      this.localQ=new T.Quaternion();
      this.emitterDirections=new Map();
      this.chains.forEach(c=>{
        c.filtered=c.points[2].clone();c.targetVelocity=new T.Vector3();
        c.emitter=new T.Vector3(0,-1,0);this.emitterDirections.set(c,c.emitter);
      });
      this.gaitSpeed=0;
    }
    reset(){super.reset();this.gaitSpeed=0;for(const c of this.chains){c.filtered.copy(c.points[2]);c.targetVelocity.set(0,0,0);}}
    update(dt,s){
      // Fixed small steps make damping and contact changes consistent at
      // different rendering rates. Physics remains owned by the game.
      const count=Math.max(1,Math.ceil(Math.min(dt,.05)*120));
      for(let i=0;i<count;i++)this.advance(Math.min(dt,.05)/count,s);
    }
    advance(dt,s){
      this.time+=dt;
      this.air=blend(this.air,s.grounded?0:1,14,dt);
      this.power=blend(this.power,!s.grounded&&s.powered?1:0,9,dt);
      this.brake=blend(this.brake,!s.grounded?s.brake||0:0,9,dt);
      this.throttle=blend(this.throttle,s.powered?(s.throttle===undefined?1:s.throttle):0,10,dt);
      this.water=blend(this.water,s.water?1:0,6,dt);
      this.crouch=blend(this.crouch,s.grounded?Math.max(s.charge||0,s.landing||0):0,12,dt);
      this.gaitSpeed=blend(this.gaitSpeed,s.grounded?s.speed||0:0,10,dt);
      this.move=blend(this.move,s.grounded?clamp(this.gaitSpeed/.8,0,1)*(1-this.crouch):0,12,dt);
      this.run=blend(this.run,clamp((this.gaitSpeed-2)/3.2,0,1),8,dt);
      this.turn=blend(this.turn,s.turn||0,8,dt);
      const cadence=T.MathUtils.lerp(1.12,1.62,this.run);
      this.phase=(this.phase+dt*cadence*clamp(this.gaitSpeed/1.1,0,1))%1;
      const ground=(1-this.air)*(1-this.water),powered=Math.max(this.power,this.brake);
      const legs=this.chains.filter(c=>c.type==='leg');
      const reach=legs[0].points[0].distanceTo(legs[0].points[1])+legs[0].points[1].distanceTo(legs[0].points[2]);
      const stance=T.MathUtils.lerp(.60,.28,this.run);
      const travel=Math.min(reach*1.25,this.gaitSpeed/.45*stance/cadence);
      const pulse=Math.cos(this.phase*4*Math.PI);
      const drop=this.move*(.045+.10*this.run+.045*this.run*pulse)+this.crouch*.36;
      const pitch=-.26*this.crouch-.12*this.move*this.run;
      const hipHeight=legs[0].points[0].y;
      this.frame.position.set(0,-drop+hipHeight*(1-Math.cos(pitch)),this.crouch*.42-hipHeight*Math.sin(pitch));
      this.frame.rotation.set(pitch,Math.PI,.025*this.move*Math.sin(this.phase*2*Math.PI));
      // Turn demand is transformed into the actual visual body frame, not
      // assumed to be straight down after a flight pose has been selected.
      this.localQ.copy(this.frame.quaternion).invert();
      this.intent.copy(this.flightLoad).applyQuaternion(this.localQ);
      if(this.intent.lengthSq()<.01)this.intent.set(0,1,0);this.intent.normalize();
      this.exhaust.copy(this.intent).negate();
      this.frame.updateWorldMatrix(true,true);
      for(const t of this.groundTorso){
        t.bone.quaternion.copy(t.rest);
        this.q.setFromAxisAngle(this.localDirection.set(0,1,0),ground*this.move*Math.sin(this.phase*2*Math.PI)*.045);
        t.bone.quaternion.multiply(this.q);
      }
      for(const f of this.runningFingers)f.bone.quaternion.copy(f.rest).slerp(f.target,this.run*this.move*ground*(s.laser?0:1));
      this.frame.updateWorldMatrix(true,true);
      const tuck=this.air*(1-powered)*(1-(s.space||0))*Math.sin(Math.min(1,(s.airTime||0)/.75)*Math.PI);
      for(const c of this.chains){
        c.nodes.forEach((n,i)=>{n.quaternion.copy(c.rest[i]);n.position.copy(c.positions[i]);n.scale.copy(c.scales[i]);});
        c.toes.forEach(t=>{t.bone.quaternion.copy(t.q);t.bone.position.copy(t.p);t.bone.scale.copy(t.s);});
        const hip=c.points[0],p=(this.phase+(c.side==='L'?0:.5))%1;
        const a=c.points[0].distanceTo(c.points[1]),b=c.points[1].distanceTo(c.points[2]);
        c.goal.copy(c.points[2]);let endPitch=0;
        if(c.type==='leg'){
          let z=0,lift=0;
          if(p<stance){z=travel*(.5-p/stance);endPitch=-.35*T.MathUtils.smoothstep(p/stance,.65,1);}
          else{
            const u=(p-stance)/(1-stance);
            z=travel*(-.5+u*u*(3-2*u));
            // Recovery occurs behind the hip, then opens toward touchdown.
            const recovery=Math.min(1,u/T.MathUtils.lerp(1,.78,this.run));
            lift=Math.sin(Math.PI*recovery)**2*T.MathUtils.lerp(.14,.68,this.run);
          }
          c.goal.x=T.MathUtils.lerp(c.goal.x,hip.x+c.sign*.04,this.move);
          c.goal.z+=z*this.move;c.goal.y+=lift*this.move;
          this.planted.copy(c.goal).applyAxisAngle(this.localDirection.set(0,1,0),Math.PI);
          this.frame.parent.localToWorld(this.planted);this.frame.worldToLocal(this.planted);
          c.goal.lerp(this.planted,ground);
          c.goal.y+=tuck*.20+this.air*.04;
          c.goal.z-=tuck*.10;
          // Feet carry the sustained load, but tilt only within the ankle
          // envelope; body attitude supplies the rest of a large manoeuvre.
          c.goal.addScaledVector(this.intent,powered*.06);
          c.pole.set(hip.x,hip.y-.5,hip.z+2);
          c.footPlant=ground*(p<stance?1:.15);
        }else{
          const swing=-Math.cos(2*Math.PI*this.phase+(c.side==='L'?0:Math.PI));
          const shoulder=.10+this.move*swing*T.MathUtils.lerp(.22,.36,this.run);
          const elbow=T.MathUtils.lerp(.35,1.5,this.run*this.move);
          c.goal.set(c.sign*Math.max(Math.abs(hip.x)+.25,.94),hip.y-a*Math.cos(shoulder)-b*Math.cos(shoulder+elbow),hip.z+a*Math.sin(shoulder)+b*Math.sin(shoulder+elbow));
          c.pole.set(hip.x+c.sign*.18,hip.y-.7,hip.z-.8);
          // Steering moves the shoulder/wrist target in the direction opposite
          // exhaust. Its moment arm responds to angular velocity as well as
          // translation; no cruise/left/right pose lookup is involved.
          const spread=.22+this.flightEffort*.16;
          this.velocityScratch.set(hip.x+c.sign*spread,hip.y-(a+b)*.80,hip.z+.22);
          this.velocityScratch.addScaledVector(this.intent,powered*.40);
          this.velocityScratch.z+=c.sign*this.angularVelocity.y*.10;
          this.velocityScratch.y+=c.sign*this.angularVelocity.z*.10;
          c.goal.lerp(this.velocityScratch,this.air*powered);
          c.goal.y+=tuck*.30;
          if(s.laser&&c.side==='R'){c.goal.y=hip.y-.25;c.goal.z=hip.z+1.3;}
        }
        if(this.water>.001){
          const stroke=this.time*(c.type==='leg'?4.5:2.6)+(c.side==='L'?0:Math.PI);
          c.goal.y+=this.water*(c.type==='leg'?.12*Math.sin(stroke):.35+.22*Math.sin(stroke));
          c.goal.z+=this.water*(c.type==='leg'?.32*Math.cos(stroke):.35+.35*Math.cos(stroke));
        }
        // Critically damped endpoint response with persistent velocity. This
        // makes reversals decelerate instead of switching between poses.
        const omega=c.type==='leg'&&ground>.5?48:18;
        this.velocityScratch.copy(c.filtered).sub(c.goal);
        const decay=Math.exp(-omega*dt);
        this.localDirection.copy(c.targetVelocity).addScaledVector(this.velocityScratch,omega);
        c.filtered.copy(c.goal).add(this.velocityScratch.addScaledVector(this.localDirection,dt).multiplyScalar(decay));
        c.targetVelocity.addScaledVector(this.localDirection,-omega*dt).multiplyScalar(decay);
        c.targetVelocity.clampLength(0,8);
        if(dt>0)c.goal.copy(c.filtered);
        this.solve(c,dt,endPitch);
      }
    }
  }
  g.GodmanCharacterMotion=BodyController;g.GODMAN_MOTION_BUILD='20261101.6';
})(typeof window==='undefined'?globalThis:window);
