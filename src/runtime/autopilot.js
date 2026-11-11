(function(g){
  'use strict';
  const T=g.THREE;
  class Autopilot{
    constructor(scale){
      this.scale=scale;
      this.direction=new T.Vector3();
      this.relative=new T.Vector3();
      this.command=new T.Vector3();
      this.desired=new T.Vector3();
      this.delta=new T.Vector3();
      this.acceleration=new T.Vector3();
      this.remaining=0;
      this.phase='';
    }

    plan({offset,velocity,arrivalRadius,landing,departure,speedLimit,surface,canAccelerate=true}){
      const distance=offset.length();
      this.direction.copy(offset).normalize();
      this.relative.copy(velocity);
      const remaining=this.remaining=distance-arrivalRadius;
      const room=Math.max(0,remaining);
      const speed=velocity.length();
      const terminal=landing?2.5:0;
      const localBrake=42;
      // Square-root braking near a world and a time reserve at cruise speeds.
      const envelope=Math.max(Math.sqrt(2*localBrake*room),room/3.3);
      const fuelLimit=canAccelerate||room<180?Infinity:speed;
      const goalSpeed=Math.min(speedLimit,fuelLimit,terminal+Math.min(envelope,room*.9));
      const closing=velocity.dot(this.direction);
      const slowing=!departure&&(closing>goalSpeed||speed>goalSpeed*1.2);
      this.phase=departure?'DEPARTURE':room<180?(landing?'LANDING':'STANDOFF'):
        closing>goalSpeed*.92?'BRAKING':'CRUISE';
      if(departure){
        this.desired.copy(departure).multiplyScalar(Math.min(fuelLimit,18000*this.scale,35+speed*1.35));
      }else{
        const retreat=landing?0:Math.min(40,Math.max(0,-remaining)*.55);
        this.desired.copy(this.direction).multiplyScalar(goalSpeed-retreat);
      }
      const driveAuthority=T.MathUtils.lerp(
        Math.max(420*this.scale,speed*.98),departure?120:105,surface
      );
      const authority=slowing?Math.max(driveAuthority,speed*1.75):driveAuthority;
      // Resolve the entire velocity vector, including sideways drift.
      const response=departure?1.8:slowing?4.2:room<180?3:1.35;
      this.command.copy(this.desired).sub(velocity).multiplyScalar(response).clampLength(0,authority);
      return this;
    }

    step(dt,out){
      const response=-Math.expm1(-dt*9);
      this.acceleration.lerp(this.command,response);
      this.delta.copy(this.desired).sub(this.relative);
      const limit=Math.min(this.delta.length(),this.acceleration.length()*dt);
      if(this.acceleration.dot(this.delta)>0){
        out.copy(this.relative).addScaledVector(this.acceleration,limit/Math.max(1e-12,this.acceleration.length()));
      }else out.copy(this.relative);
      return out;
    }

    reset(){
      this.phase='';
      this.acceleration.set(0,0,0);
    }
  }
  g.GodmanAutopilot=Autopilot;
})(typeof window==='undefined'?globalThis:window);
