'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const T=require('../vendor/three.r128.min.js');
require('../src/runtime/terrain-surface.js');
const source=fs.readFileSync(require.resolve('../src/game.js'),'utf8');
function fixture(code,worldFactor=1){
  const fullScaleTerrain=worldFactor===10;
  const tiles={tiles:new Map(),tileSize:fullScaleTerrain?1440:480,activeRadius:3,frame:0,committedKeys:new Set(),committedCenter:new T.Vector3(0,1,0),committedSignature:'',pendingKeys:new Set(),pendingCenter:new T.Vector3(0,1,0),pendingSignature:''};
  const earth={r:637100*worldFactor,center:new T.Vector3(),mesh:new T.Group()};
  let builds=0;
  const context={window:global,stitchEarthSurfaceTiles(){},THREE:T,worldFactor,earth,earthSurfaceTiles:tiles,earthElevation:{ready:true},pos:new T.Vector3(-earth.r,0,0).applyAxisAngle(new T.Vector3(0,1,0),.0004),earthTileQ:new T.Quaternion(),earthTileN:new T.Vector3(),earthSurfaceCutaway:{center:{value:new T.Vector3()},chordSq:{value:-1},detail:{value:1}},performance:{now:()=>0},
    earthDetailRoot:earth.mesh,fullScaleTerrain,earthHydrographyLoading:false,earthWaterLevelLocal:()=>null,sampleEarthElevationRaster:()=>fullScaleTerrain?8849:0,
    *createEarthSurfaceTile(...args){yield;return context.buildEarthSurfaceTile(...args);},
    buildEarthSurfaceTile(ix,iy,lonCells,latCells,lod){
      const key=ix+':'+iy+':'+lod,tile={key,group:new T.Group(),lastUsed:0};builds++;tiles.tiles.set(key,tile);earth.mesh.add(tile.group);return tile;
    }};
  vm.createContext(context);vm.runInContext(code.slice(code.indexOf('  function updateEarthCutaway('),code.indexOf('\n  function horizDir()',code.indexOf('  function updateEarthCutaway('))),context);
  return {context,tiles,earth,tick:speed=>context.updateEarthSurfaceTiles(speed),builds:()=>builds};
}
const r=fixture(source);
function settle(){let frames=0;do{r.tick();assert.ok(++frames<300,'Terrain never committed');}while(r.tiles.committedSignature!==r.tiles.pendingSignature);}
function checkCutawayCoverage(r){
 const cap=r.context.earthSurfaceCutaway;
 if(cap.chordSq.value<0)return;
 const center=r.tiles.committedCenter,tangent=new T.Vector3(0,1,0).cross(center).normalize();
 const bitangent=center.clone().cross(tangent).normalize(),radius=2*Math.asin(Math.sqrt(cap.chordSq.value)*.5);
 const size=r.tiles.tileSize/r.earth.r,cols=Math.ceil(Math.PI*2/size),rows=Math.ceil(Math.PI/size);
 const loaded=new Set([...r.tiles.committedKeys].map(k=>k.split(':').slice(0,2).join(':')));
 for(let i=0;i<96;i++){
  const angle=i*Math.PI*2/96;
  const point=center.clone().multiplyScalar(Math.cos(radius))
   .addScaledVector(tangent,Math.sin(radius)*Math.cos(angle))
   .addScaledVector(bitangent,Math.sin(radius)*Math.sin(angle));
  const lon=(Math.atan2(point.z,-point.x)+Math.PI*2)%(Math.PI*2);
  const lat=Math.asin(Math.max(-1,Math.min(1,point.y)));
  const key=Math.floor(lon/(Math.PI*2)*cols)+':'+Math.min(rows-1,Math.floor((lat+Math.PI*.5)/Math.PI*rows));
  assert.ok(loaded.has(key),'The terrain cutaway exposes sky beyond the loaded tiles: '+key);
 }
}
settle();checkCutawayCoverage(r);const built=r.builds(),committed=r.tiles.committedKeys;
const oldWanted=r.tiles.pendingKeys;
for(let i=0;i<500;i++)r.tick();
assert.equal(r.builds(),built,'Stationary terrain rebuilt');
assert.equal(r.tiles.committedKeys,committed,'Stationary terrain replaced its committed set');
assert.equal(r.tiles.pendingKeys,oldWanted,'Stationary terrain reselected its ring');
const center=r.context.earthSurfaceCutaway.center.value.clone();
r.earth.mesh.quaternion.setFromAxisAngle(new T.Vector3(0,1,0),1e-6);
r.tick();assert.ok(r.context.earthSurfaceCutaway.center.value.equals(center),'Planet-local clipping moved as Earth rotated');
const edge=fixture(source,10);
for(let i=0;i<120;i++)edge.tick();
const edgeSignature=edge.tiles.committedSignature;
const step=2*Math.PI/edge.tiles.committedGrid.lonCells;
const border=edge.tiles.planX+1;
for(let i=0;i<20;i++){
 const lon=(border+(i%2?.015:-.015))*step;
 edge.context.pos.set(-Math.cos(lon),0,Math.sin(lon)).multiplyScalar(edge.earth.r+8849);
 edge.tick();
 assert.equal(edge.tiles.pendingSignature,edgeSignature,'Hovering at a tile edge toggles terrain detail');
}
// Crossing a cell retains the old complete ring until its replacement exists.
const oldPosition=r.context.pos.clone();
r.context.pos.applyAxisAngle(new T.Vector3(0,1,0),.002);
r.tick();assert.equal(r.tiles.committedKeys,committed,'Incomplete replacement removed the visible ring');
const pendingPlan=r.tiles.pendingKeys;
r.tick();assert.equal(r.tiles.pendingKeys,pendingPlan,'Terrain rebuilt the same streaming plan on the next frame');
r.context.pos.copy(oldPosition);r.tick();
assert.equal(r.tiles.pendingSignature,r.tiles.committedSignature,'Reversing across a boundary kept stale pending terrain');
r.context.pos.applyAxisAngle(new T.Vector3(0,1,0),.002);settle();
assert.notEqual(r.tiles.committedKeys,committed);
for(const key of r.tiles.committedKeys)assert.ok(r.tiles.tiles.get(key).group.visible,'Committed terrain has a hole');
r.tiles.activeRadius=5;settle();checkCutawayCoverage(r);assert.ok(r.tiles.committedKeys.size>committed.size,'Range setting did not invalidate terrain');
r.context.pos.set(.035,.999,0).normalize().multiplyScalar(r.earth.r);settle();checkCutawayCoverage(r);
r.context.pos.set(0,r.earth.r,0);settle();checkCutawayCoverage(r);assert.ok(r.tiles.committedKeys.size>0,'Polar selection failed');
assert.equal(new Set([...r.tiles.committedKeys].map(k=>k.split(':').slice(0,2).join(':'))).size,r.tiles.committedKeys.size,'Polar terrain renders overlapping LODs');
r.context.pos.normalize().multiplyScalar(r.earth.r+4100);r.tick();
assert.ok(r.tiles.committedKeys.size>0,'Approach tiles were unloaded before the player descended');
assert.equal(r.context.earthSurfaceCutaway.chordSq.value,-1,'Detailed terrain still forms a disc in the orbital view');
assert.equal(r.context.earthSurfaceCutaway.detail.value,0,'Local snow color remains visible just before the orbital handoff');
r.context.pos.multiplyScalar(2);r.tick();assert.equal(r.tiles.committedKeys.size,0);assert.equal(r.context.earthSurfaceCutaway.chordSq.value,-1);
assert.ok([...r.tiles.tiles.values()].every(t=>!t.group.visible),'Orbital view retained local tiles');
r.context.pos.set(-r.earth.r,0,0);settle();assert.ok(r.tiles.committedKeys.size>0,'Returning from orbit did not restore terrain');
const fullScale=fixture(source,10);
fullScale.context.pos.set(-(fullScale.earth.r+8849),0,0);
for(let i=0;i<120;i++)fullScale.tick();
assert.ok(fullScale.tiles.committedKeys.size>0,'Full-scale mountains lost their detailed tiles above 5 km');
assert.ok(fullScale.context.earthSurfaceCutaway.chordSq.value>0,'Full-scale mountains did not cut away the coarse globe');
checkCutawayCoverage(fullScale);
const groundCap=fullScale.context.earthSurfaceCutaway.chordSq.value;
assert.ok(Math.sqrt(groundCap)*fullScale.earth.r>4500,'Full-scale terrain did not extend beyond the old footprint');
assert.equal(fullScale.context.earthSurfaceCutaway.detail.value,1,'Mountain peaks lost close-range texture');
assert.equal([...fullScale.tiles.committedKeys].filter(key=>key.endsWith(':0')).length,1,'Full-scale terrain used the finest mesh beyond the center tile');
// Near the altitude handoff, the old cosine uniform rounds to 1 in
// float32. The GPU must still distinguish the walking terrain boundary.
fullScale.context.pos.set(-(fullScale.earth.r+8849+3200),0,0);
fullScale.tick();
const cap=fullScale.context.earthSurfaceCutaway;
assert.equal(Math.fround(1-cap.chordSq.value*.5),1);
assert.ok(Math.fround(cap.chordSq.value)>0);
for(let i=0;i<120;i++)fullScale.tick(159);
assert.ok(fullScale.tiles.committedKeys.size>0,'Low flight discarded the complete terrain ring');
assert.ok([...fullScale.tiles.committedKeys].every(key=>Number(key.split(':').at(-1))>=3),
 'Low flight kept building walking-scale meshes');
const buildsBeforeFlight=fullScale.builds();
fullScale.tick(1000);
assert.equal(fullScale.builds(),buildsBeforeFlight,'Fast flight kept building walking-scale tiles');
assert.equal(cap.chordSq.value,-1,'Fast flight left a walking-scale cutaway in the globe');
fullScale.context.pos.set(-(fullScale.earth.r+8849),0,0);
for(let i=0;i<120;i++)fullScale.tick();
assert.ok(fullScale.tiles.committedKeys.size>0,'Returning to the ground did not restore walking terrain');
fullScale.context.pos.applyAxisAngle(new T.Vector3(0,1,0),.02);
fullScale.context.pos.setLength(fullScale.earth.r+8849+700);
for(let i=0;i<12;i++)fullScale.tick(650);
assert.ok(fullScale.tiles.committedSignature.endsWith(':contact'),'A fast descent did not stream the new landing area first');
assert.ok(fullScale.tiles.committedKeys.size<=15,'Landing waited for the wider terrain ring');
fullScale.context.pos.setLength(fullScale.earth.r+8849);
let focused=false;
for(let i=0;i<120;i++){
 fullScale.tick();
 if(fullScale.tiles.committedSignature.endsWith(':landing')&&[...fullScale.tiles.committedKeys].some(key=>key.endsWith(':1')))focused=true;
}
assert.ok(focused,'High-definition terrain did not appear at the landing point before the outer ring');
const paced=fixture(source,10);
let clock=0;
paced.context.performance.now=()=>clock+=3;
paced.tick();
assert.equal(paced.builds(),0,'The tile build overran the per-frame budget');
assert.equal(paced.tiles.committedKeys.size,0,'A partially built terrain tile was committed');
paced.tick();
assert.equal(paced.builds(),1,'The next frame did not resume the same tile build');
// Optional local benchmark compares the same fully populated ring and motion.
if(process.env.TERRAIN_BASELINE){
 const {performance}=require('node:perf_hooks');
 for(const [label,code] of [['before',fs.readFileSync(process.env.TERRAIN_BASELINE,'utf8')],['after',source]]){
   const b=fixture(code);for(let i=0;i<200;i++)b.tick();
   const t=performance.now();for(let i=0;i<10000;i++)b.tick();
   console.log(`${label}: ${((performance.now()-t)/10000).toFixed(4)} ms / stationary terrain update`);
 }
}
console.log('PASS: cached stationary terrain, rotating clipping, transactional boundary crossing, range changes, polar cells and orbit/re-entry.');
