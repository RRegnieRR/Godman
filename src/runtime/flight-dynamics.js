/* Shared flight forces. World-space inputs; velocity is relative to the
 * current co-rotating frame. Surface lift and steering use the same force
 * vector supplied to the character's repulsor controller. */
(function(g){
  'use strict';
  const T=g.THREE,damp=(a,b,k,dt)=>T.MathUtils.lerp(a,b,1-Math.exp(-k*dt));
  class FlightDynamics{
    constructor(){
      this.spool=0;this.throttle=0;this.brake=0;this.powered=false;this.acceleration=0;this.fuelUsed=0;
      this.force=new T.Vector3();this.direction=new T.Vector3(0,1,0);
      this.previousVelocity=new T.Vector3();this.relative=new T.Vector3();
      this.desired=new T.Vector3();this.turn=new T.Quaternion();this.identity=new T.Quaternion();
    }
    reset(){this.spool=this.throttle=this.brake=this.acceleration=this.fuelUsed=0;this.powered=false;this.force.set(0,0,0);}
    update(dt,s){
      const v=s.velocity;this.previousVelocity.copy(v);
      const wants=!!s.thrust&&s.fuel>0&&!s.braking;
      const previousSpool=this.spool,target=wants?1:0,rate=wants?4.5:s.braking?10:6;
      this.spool=damp(this.spool,target,rate,dt);
      // Integrate the spool curve, rather than using its end-of-frame value.
      // Thrust and fuel consumption then agree at different frame rates.
      const meanSpool=dt>0?target+(previousSpool-target)*(-Math.expm1(-rate*dt))/(rate*dt):previousSpool;
      this.brake=damp(this.brake,s.braking?1:0,s.braking?5.5:7.5,dt);
      this.force.set(0,0,0);this.fuelUsed=0;this.throttle=0;
      if(s.fuel>0&&meanSpool>.00001){
        this.relative.copy(v).sub(s.frameVelocity);
        const surface=T.MathUtils.clamp(s.surface,0,1);
        const speed=this.relative.length();
        // Aim is authoritative, including downwards. Surface authority is
        // sufficient to arrest a fall when aimed up; cruise retains its speed
        // growth without letting a large charged jump multiply surface thrust.
        const local=T.MathUtils.clamp(Math.max(56,s.gravity.length()*2.6),56,80);
        const cruise=Math.min(s.nearBlackhole?2.2e6:2.4e21,Math.max(64,speed*.72));
        const requested=T.MathUtils.lerp(cruise,local,surface);
        const limit=80*surface+Math.max(80,cruise)*(1-surface);
        if(previousSpool<.001)this.acceleration=requested;
        else this.acceleration=damp(this.acceleration,requested,4,dt);
        this.acceleration=Math.min(this.acceleration,limit);
        if(wants){
          this.desired.copy(s.aim).normalize();
          if(this.desired.lengthSq()>.5){
            if(previousSpool<.001)this.direction.copy(this.desired);
            else{
              this.turn.setFromUnitVectors(this.direction,this.desired);
              const angle=this.turn.angleTo(this.identity);
              this.turn.slerp(this.identity,1-Math.min(1,4.5*dt/Math.max(angle,1e-8)));
              this.direction.applyQuaternion(this.turn).normalize();
            }
          }
        }
        // Twice the previous endurance. The final few percent ease out
        // instead of dropping full thrust abruptly when the tank empties.
        const burn=T.MathUtils.lerp(2,10,surface);
        this.fuelUsed=Math.min(s.fuel,burn*meanSpool*dt);
        const pressure=T.MathUtils.smoothstep(s.fuel-this.fuelUsed*.5,0,4);
        this.throttle=this.spool*pressure;
        this.force.copy(this.direction).multiplyScalar(this.acceleration*meanSpool*pressure*(1-this.brake));
      }else if(s.fuel<=0){this.spool=0;}
      v.addScaledVector(s.gravity,dt).addScaledVector(this.force,dt);
      // No invisible WASD acceleration during a ballistic jump.
      if(this.brake>.001){
        this.relative.copy(v).sub(s.frameVelocity).multiplyScalar(Math.exp(-this.brake*3*dt));
        v.copy(s.frameVelocity).add(this.relative);
      }
      this.powered=this.throttle>.015&&this.force.lengthSq()>.0001;
      return this;
    }
    integrate(position,velocity,dt){
      position.addScaledVector(this.previousVelocity,dt*.5).addScaledVector(velocity,dt*.5);
    }
    jumpStage(charge){return Math.max(1,Math.min(16,Math.floor(T.MathUtils.clamp(charge,0,1)*16+1e-9)));}
    jumpDirection(aim,up,out){
      out.copy(aim).normalize();
      // Keep the viewed heading while clearing the surface when the
      // crosshair points into the ground. Upward aim is followed directly.
      const elevation=out.dot(up);
      if(elevation<.2)out.addScaledVector(up,.2-elevation).normalize();
      return out;
    }
    jumpHeight(charge){return 1.2*2**(this.jumpStage(charge)-1);}
    jumpVelocity(charge,gravity=9.81,radius=637100){
      const height=this.jumpHeight(charge);
      // Energy for a radial ballistic arc under inverse-square gravity.
      return Math.sqrt(2*gravity*radius*height/(radius+height));
    }
    jumpImpulse(aim,up,charge,gravity,radius,out){
      this.jumpDirection(aim,up,out);
      const stage=this.jumpStage(charge),speed=this.jumpVelocity(charge,gravity,radius);
      const elevation=out.dot(up);
      // Small jumps need leg-driven lift even when looking along the ground.
      // Additional charge can extend the aimed leap without lowering its arc.
      const lift=this.jumpVelocity(Math.min(stage,3)/16,gravity,radius);
      const forward=T.MathUtils.lerp(.45,1,T.MathUtils.smoothstep(stage,1,6));
      out.addScaledVector(up,-elevation).multiplyScalar(speed*forward);
      return out.addScaledVector(up,Math.max(speed*elevation,lift));
    }
  }
  g.GodmanFlightDynamics=FlightDynamics;
})(typeof window==='undefined'?globalThis:window);
