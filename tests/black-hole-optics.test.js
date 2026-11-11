'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const T=require('../vendor/three.r128.min.js');
const source=fs.readFileSync(require.resolve('../src/game.js'),'utf8');
const critical=Number(source.match(/const float criticalImpact=([\d.]+)/)[1]);
assert.ok(Math.abs(critical-3*Math.sqrt(3)/2)<1e-12);

function trace(impact){
  const radius=24,b2=impact*impact;
  const p=new T.Vector3(0,0,radius);
  const v=new T.Vector3(impact/radius,0,-Math.sqrt(1-b2/radius**2*(1-1/radius)));
  const acceleration=point=>point.clone().multiplyScalar(-1.5*b2/point.length()**5);
  for(let i=0;i<172;i++){
    const r=p.length();
    if(r<=1)return 'captured';
    if(r>20&&p.dot(v)>0)return 'escaped';
    assert.ok(Math.abs(p.clone().cross(v).length()-impact)<1e-10,'The light ray lost angular momentum');
    assert.ok(Math.abs(v.lengthSq()-b2/r**3-1)<.01,'Excessive error in photon energy');
    const step=T.MathUtils.clamp((r-1.2)*.17,.04,1.8);
    v.addScaledVector(acceleration(p),step*.5);
    p.addScaledVector(v,step);
    v.addScaledVector(acceleration(p),step*.5);
  }
  throw new Error('The ray failed to resolve within the renderer budget');
}
assert.equal(trace(critical*.999),'captured');
assert.equal(trace(critical*1.001),'escaped');
assert.equal(trace(critical*1.5),'escaped');
assert.ok(source.includes('smoothstep(3.0,3.35,rr)'),'The disk starts inside the last stable circular orbit');
assert.ok(source.includes('if(available>0.0)'),'Offscreen rays sample the edge of the capture');
console.log('PASS: critical impact, captured and escaped rays, angular momentum, and bounded energy error.');
