'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const T=require('../vendor/three.r128.min.js');
const source=fs.readFileSync(require.resolve('../src/game.js'),'utf8');
const start=source.indexOf('  function updateEarthSurfaceTiles(){'),end=source.indexOf('\n  function horizDir()',start);
function fixture(code){
  const tiles={tiles:new Map(),tileSize:480,activeRadius:3,frame:0,committedKeys:new Set(),committedCenter:new T.Vector3(0,1,0),committedSignature:'',pendingKeys:new Set(),pendingCenter:new T.Vector3(0,1,0),pendingSignature:''};
  const earth={r:637100,center:new T.Vector3(),mesh:new T.Group()};
  let builds=0;
  const context={stitchEarthSurfaceTiles(){},THREE:T,earth,earthSurfaceTiles:tiles,earthElevation:{ready:true},pos:new T.Vector3(-earth.r,0,0).applyAxisAngle(new T.Vector3(0,1,0),.0004),earthTileQ:new T.Quaternion(),earthTileN:new T.Vector3(),earthTileCenterWorld:{value:new T.Vector3()},earthSurfaceCutaway:{center:{value:new T.Vector3()},cosRadius:{value:2}},performance:{now:()=>0},
    buildEarthSurfaceTile(ix,iy,lonCells,latCells,lod){
      const key=ix+':'+iy+':'+lod,tile={key,group:new T.Group(),lastUsed:0};builds++;tiles.tiles.set(key,tile);earth.mesh.add(tile.group);return tile;
    }};
  vm.createContext(context);vm.runInContext(code.slice(code.indexOf('  function updateEarthSurfaceTiles(){'),code.indexOf('\n  function horizDir()',code.indexOf('  function updateEarthSurfaceTiles(){'))),context);
  return {context,tiles,earth,tick:()=>context.updateEarthSurfaceTiles(),builds:()=>builds};
}
const r=fixture(source);
function settle(){let frames=0;do{r.tick();assert.ok(++frames<300,'Terrain never committed');}while(r.tiles.committedSignature!==r.tiles.pendingSignature);}
settle();const built=r.builds(),committed=r.tiles.committedKeys;
const oldWanted=r.tiles.pendingKeys;
for(let i=0;i<500;i++)r.tick();
assert.equal(r.builds(),built,'Stationary terrain rebuilt');
assert.equal(r.tiles.committedKeys,committed,'Stationary terrain replaced its committed set');
assert.equal(r.tiles.pendingKeys,oldWanted,'Stationary terrain reselected its ring');
const center=r.context.earthTileCenterWorld.value.clone();
r.earth.mesh.quaternion.setFromAxisAngle(new T.Vector3(0,1,0),1e-6);
r.tick();assert.ok(r.context.earthTileCenterWorld.value.distanceTo(center)>1e-8,'Cached terrain clipping stopped rotating');
// Crossing a cell retains the old complete ring until its replacement exists.
const oldPosition=r.context.pos.clone();
r.context.pos.applyAxisAngle(new T.Vector3(0,1,0),.002);
r.tick();assert.equal(r.tiles.committedKeys,committed,'Incomplete replacement removed the visible ring');
r.context.pos.copy(oldPosition);r.tick();
assert.equal(r.tiles.pendingSignature,r.tiles.committedSignature,'Reversing across a boundary kept stale pending terrain');
r.context.pos.applyAxisAngle(new T.Vector3(0,1,0),.002);settle();
assert.notEqual(r.tiles.committedKeys,committed);
for(const key of r.tiles.committedKeys)assert.ok(r.tiles.tiles.get(key).group.visible,'Committed terrain has a hole');
r.tiles.activeRadius=5;settle();assert.ok(r.tiles.committedKeys.size>committed.size,'Range setting did not invalidate terrain');
r.context.pos.set(0,r.earth.r,0);settle();assert.ok(r.tiles.committedKeys.size>0,'Polar selection failed');
assert.equal(new Set([...r.tiles.committedKeys].map(k=>k.split(':').slice(0,2).join(':'))).size,r.tiles.committedKeys.size,'Polar terrain renders overlapping LODs');
r.context.pos.multiplyScalar(2);r.tick();assert.equal(r.tiles.committedKeys.size,0);assert.equal(r.context.earthSurfaceCutaway.cosRadius.value,2);
assert.ok([...r.tiles.tiles.values()].every(t=>!t.group.visible),'Orbital view retained local tiles');
r.context.pos.set(-r.earth.r,0,0);settle();assert.ok(r.tiles.committedKeys.size>0,'Returning from orbit did not restore terrain');
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
