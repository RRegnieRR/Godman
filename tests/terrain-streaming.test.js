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
    earthDetailRoot:earth.mesh,fullScaleTerrain,worldMeters:m=>m*worldFactor/10,
    earthHydrographyLoading:false,earthWaterLevelLocal:()=>null,earthCoastDistance:()=>Infinity,
    sampleEarthInlandWater:()=>({kind:0}),earthFineReliefLocal:()=>0,sampleEarthElevationRaster:()=>fullScaleTerrain?8849:0,
    *createEarthSurfaceTile(...args){yield;return context.buildEarthSurfaceTile(...args);},
    buildEarthSurfaceTile(ix,iy,lonCells,latCells,lod){
      const key=ix+':'+iy+':'+lod,tile={key,group:new T.Group(),lastUsed:0};builds++;tiles.tiles.set(key,tile);earth.mesh.add(tile.group);return tile;
    }};
  vm.createContext(context);vm.runInContext(code.slice(code.indexOf('  function updateEarthCutaway('),code.indexOf('\n  function horizDir()',code.indexOf('  function updateEarthCutaway('))),context);
  return {context,tiles,earth,tick:(...args)=>context.updateEarthSurfaceTiles(...args),builds:()=>builds};
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
// Keep the same coverage when a flight path crosses the dry edge of a high lake.
for(const scale of [1,10]){
 const lake=fixture(source,scale),{context}=lake;
 const level=3400*scale/10,clearance=2300;
 context.sampleEarthElevationRaster=()=>level-2000*scale/10;
 context.earthFineReliefLocal=()=>2000*scale/10;
 context.earthWaterLevelLocal=()=>level;
 context.pos.set(-(lake.earth.r+level+clearance),0,0);
 for(let i=0;i<160;i++)lake.tick();
 const wetCap=context.earthSurfaceCutaway.chordSq.value;
 assert.ok(wetCap>0,'A high lake lost coverage while flying');
 context.earthWaterLevelLocal=()=>null;
 lake.tick();
 assert.equal(context.earthSurfaceCutaway.chordSq.value,wetCap,'Crossing the shore changed the terrain footprint at the same clearance');
}
const hovering=fixture(source,10);
const setClearance=metres=>hovering.context.pos.set(-(hovering.earth.r+8849+metres),0,0);
setClearance(1000);
for(let i=0;i<160;i++)hovering.tick(499);
const flightRing=hovering.tiles.committedKeys;
const flightCap=hovering.context.earthSurfaceCutaway.chordSq;
for(let i=0;i<20;i++){
 const last=flightCap.value;
 setClearance(i%2?951:949);
 hovering.tick(i%2?501:499);
 assert.equal(hovering.tiles.committedKeys,flightRing,'Small speed changes reselected the visible terrain');
 assert.ok(flightCap.value>0,'Terrain blinked out at the old fast-flight threshold');
 assert.ok(Math.abs(flightCap.value-last)<hovering.tiles.terrainChordSq*.08,'Terrain footprint jumped at the old fast-flight threshold');
}
setClearance(2000);
hovering.tick(650);
assert.equal(flightCap.value,-1,'Fast overflight rendered close terrain too far below');
assert.equal(hovering.tiles.committedKeys,flightRing,'Fast overflight discarded the cached terrain');
setClearance(700);
hovering.tick(650);
assert.ok(flightCap.value>0,'A cached ring failed to return on descent');
setClearance(65);
hovering.tick(150);
assert.equal(hovering.tiles.flightLod,true);
for(const altitude of [39,41,38,42]){
 setClearance(altitude);
 hovering.tick(150);
 assert.equal(hovering.tiles.flightLod,true,'Small altitude oscillations toggled mesh resolution');
}
const paced=fixture(source,10);
let clock=0;
paced.context.performance.now=()=>clock+=3;
paced.tick();
assert.equal(paced.builds(),0,'The tile build overran the per-frame budget');
assert.equal(paced.tiles.committedKeys.size,0,'A partially built terrain tile was committed');
paced.tick();
assert.equal(paced.builds(),1,'The next frame did not resume the same tile build');
const compactBudget=fixture(source);
let compactClock=0;
compactBudget.context.performance.now=()=>compactClock+=3;
compactBudget.tick();
assert.equal(compactBudget.builds(),0,'The compact scale built an entire tile in one frame');
compactBudget.tick();
assert.equal(compactBudget.builds(),1,'The compact scale did not resume its pending tile');
// An eclipse can prepare a distant ground view while the menu holds the current frame.
for(const scale of [1,10]){
 const event=fixture(source,scale);
 for(let i=0;i<160;i++)event.tick();
 const currentKeys=event.tiles.committedKeys;
 const cutaway=event.context.earthSurfaceCutaway;
 const currentCap=cutaway.chordSq.value;
 const currentPosition=event.context.pos.clone();
 const site={
  position:currentPosition.clone().applyAxisAngle(new T.Vector3(0,1,0),.04)
   .setLength(event.earth.r+(scale===10?8849:0)),
  publish:false
 };
 let ready=false;
 for(let i=0;i<160&&!ready;i++){
  ready=event.tick(0,7,site);
  assert.equal(event.tiles.committedKeys,currentKeys,'Warming an eclipse moved the visible terrain');
  assert.equal(cutaway.chordSq.value,currentCap,'Warming an eclipse changed the current cutaway');
  assert.ok(event.context.pos.equals(currentPosition),'Warming an eclipse moved the player');
 }
 assert.ok(ready,'Eclipse terrain did not become ready');
 const warmedKeys=event.tiles.pendingKeys;
 for(const key of warmedKeys)assert.equal(event.tiles.tiles.get(key).group.visible,false);
 const built=event.builds();
 site.publish=true;
 assert.ok(event.tick(0,7,site),'The event did not commit the preloaded site');
 assert.equal(event.builds(),built,'Starting the event built more terrain');
 assert.ok(event.tiles.committedSignature.endsWith(':viewing-site'));
 assert.deepEqual([...event.tiles.committedKeys],[...warmedKeys]);
 assert.ok([...warmedKeys].some(key=>key.endsWith(':1')),'The observation site has no detailed center tile');
 for(const key of warmedKeys)assert.ok(event.tiles.tiles.get(key).group.visible);
 checkCutawayCoverage(event);
 const visibleKeys=event.tiles.committedKeys;
 event.context.pos.copy(site.position);
 event.tick();
 assert.equal(event.tiles.committedKeys,visibleKeys,'Background streaming removed the viewing site before its replacement');
}
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
