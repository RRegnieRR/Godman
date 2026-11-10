'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const T=global.THREE=require('../vendor/three.r128.min.js');require('../src/runtime/terrain-surface.js');require('../src/runtime/earth-ground.js');
const source=fs.readFileSync(require.resolve('../src/game.js'),'utf8');
const earth={r:637100,mesh:new T.Group()},crater={strength:0,center:new T.Vector3(-1,0,0)};
const context={shoulderFlashlight:{light:{castShadow:false}},THREE:T,window:global,earth,earthDetailRoot:earth.mesh,EARTH_SEA_LEVEL:.42,earthSurfaceTiles:{tiles:new Map(),lodSegments:[128,64,32,16],frame:0},
 V3:(x,y,z)=>new T.Vector3(x,y,z),sampleEarthElevationRaster:()=>100,earthWaterLocal:()=>false,
 earthFineReliefLocal:n=>6*Math.sin(n.x*earth.r/24)+9*Math.cos(n.z*earth.r/37),
 earthCraterDispLocal:n=>-crater.strength*Math.exp(-((n.distanceTo(crater.center)*earth.r/60)**2)),
 sampleEarthMeltLocal:()=>({strength:crater.strength? .5:0,birth:0}),earthAlbedoLocal:(n,c)=>{c.setRGB(.15,.25,.1);return true;},
 sampleEarthRuggednessLocal:()=>0,earthValueNoise3:()=>.5,earthRockTint:new T.Color(),earthSnowTint:new T.Color(),earthTileMat:new T.MeshStandardMaterial(),earthWaterMat:new T.MeshBasicMaterial()};
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('  const terrainSurface=new '),source.indexOf('  function stitchEarthSurfaceTiles(){')),context);
const lonCells=Math.ceil(2*Math.PI*earth.r/480),latCells=Math.ceil(Math.PI*earth.r/480);
// The globe material is also used by anchored mountain overlays. Their
// local origins differ, so the cutaway must operate in shared world space.
earth.mesh.material=new T.MeshStandardMaterial();
context.earthTileCenterWorld={value:new T.Vector3(0,1,0)};
context.earthTileRenderCenter={value:new T.Vector3()};
context.earthSurfaceCutaway={center:{value:new T.Vector3(1,0,0)},cosRadius:{value:.99},orbitalCosRadius:{value:.991}};
vm.runInContext(source.slice(source.indexOf('  earth.mesh.material.onBeforeCompile='),source.indexOf('  const EARTH_MOUNTAIN_SITES=')),context);
const shader={uniforms:{},vertexShader:'#include <common>\n#include <begin_vertex>',fragmentShader:'#include <common>\n#include <clipping_planes_fragment>'};
earth.mesh.material.onBeforeCompile(shader);
assert.equal(shader.uniforms.earthSurfaceCenter,context.earthTileCenterWorld,'Mountain cutaway retained a mesh-local centre');
assert.equal(shader.uniforms.earthTileRenderCenter,context.earthTileRenderCenter,'Mountain cutaway does not follow floating origin');
assert.ok(shader.vertexShader.includes('modelMatrix*vec4(position,1.0)'),'Mountain cutaway ignores anchored mesh transforms');
const fine=context.buildEarthSurfaceTile(3200,2000,lonCells,latCells,0),coarse=context.buildEarthSurfaceTile(3201,2000,lonCells,latCells,1);
const surface=new GodmanTerrainSurface(T,earth.r,n=>earth.r+context.sampleEarthElevationRaster(n)+context.earthFineReliefLocal(n)+context.earthCraterDispLocal(n));
context.earthSurfaceTiles.committedKeys=new Set([fine.key,coarse.key]);
vm.runInContext(source.slice(source.indexOf('  function stitchEarthSurfaceTiles(){'),source.indexOf('  function updateEarthCutaway(')),context);
context.stitchEarthSurfaceTiles();
assert.equal(fine.stitchSteps[1],2,'Committed neighbour lookup did not stitch the fine edge');
assert.equal(coarse.stitchSteps[0],1,'Coarse edge was incorrectly reduced');
earth.mesh.updateMatrixWorld(true);
function point(tile,index){return tile.mesh.localToWorld(new T.Vector3().fromBufferAttribute(tile.mesh.geometry.attributes.position,index));}
function normal(tile,index){return new T.Vector3().fromBufferAttribute(tile.mesh.geometry.attributes.normal,index).applyQuaternion(tile.group.quaternion).normalize();}
function groundPosition(tile,index){
 const coordinates=tile.mesh.geometry.attributes.earthGround;
 return new T.Vector3().fromBufferAttribute(coordinates,index).add(tile.groundOrigin);
}
function checkBorder(){
 for(let j=0;j<fine.N;j++){
  const i=j*fine.N+fine.N-1,other=Math.floor(j/2)*coarse.N,t=j%2/2;
  const next=Math.min(coarse.N-1,Math.floor(j/2)+1)*coarse.N;
  assert.ok(point(fine,i).distanceTo(point(coarse,other).lerp(point(coarse,next),t))<.0001,'Fine/coarse borders do not share the exact edge');
  assert.ok(normal(fine,i).distanceTo(normal(coarse,other).lerp(normal(coarse,next),t).normalize())<1e-6,'Lighting changes across a shared edge');
  const sharedGround=groundPosition(coarse,other).lerp(groundPosition(coarse,next),t);
  assert.ok(groundPosition(fine,i).distanceTo(sharedGround)<.0002,'Wrapped texture slips across a shared tile edge');
  assert.ok(groundPosition(fine,i).distanceTo(point(fine,i))<.0002,'Texture lost its surface position');
 }
 const skirt=fine.skirtMesh.geometry.attributes;
 for(let e=0;e<fine.perimeter.length;e++){
  const i=fine.perimeter[e],p=fine.mesh.geometry.attributes.position,n=fine.mesh.geometry.attributes.normal;
  const q=new T.Vector3().fromBufferAttribute(skirt.position,e*2),v=new T.Vector3().fromBufferAttribute(p,i);
  assert.ok(q.distanceTo(v)<1e-6,'Crack-cover fence protrudes above the stitched edge');
  assert.ok(new T.Vector3().fromBufferAttribute(skirt.normal,e*2).distanceTo(new T.Vector3().fromBufferAttribute(n,i))<1e-6,'Crack cover has unrelated vertical lighting');
  const g=fine.mesh.geometry.attributes.earthGround;
  assert.equal(skirt.earthGround.getW(e*2),g.getW(i),'Crack cover lost the snowline altitude');
 }
}
checkBorder();
const probe=(fine.N>>1)*fine.N+(fine.N>>1);
const anchored=groundPosition(fine,probe);
for(let i=0;i<10;i++){
 earth.mesh.rotation.y+=.07;
 earth.mesh.position.set(-earth.r*Math.cos(i),0,earth.r*Math.sin(i));
 earth.mesh.updateMatrixWorld(true);
 const restored=earth.mesh.worldToLocal(point(fine,probe));
 assert.ok(restored.distanceTo(anchored)<.0002,'Texture drifts when Earth rotates or the render origin moves');
}
earth.mesh.rotation.y=0;earth.mesh.position.set(0,0,0);earth.mesh.updateMatrixWorld(true);
let slope=0;for(let j=0;j<fine.N;j+=8){const i=j*fine.N+fine.N-1;slope=Math.max(slope,normal(fine,i).angleTo(point(fine,i).normalize()));}
assert.ok(slope>.1,'Border lighting was flattened to the planet radial direction');
// Morph the boundary when the neighbouring LOD changes. All ratios must
// cover the tile without flipped triangles, holes, or a missing corner.
for(const steps of [[1,1,1,1],[2,2,2,2],[4,1,2,8],[8,8,8,8]]){
 surface.stitch(fine,steps);let area=0;const ids=fine.mesh.geometry.index.array,S=fine.N-1,N=fine.N;
 for(let i=0;i<ids.length;i+=3){
  const a=ids[i],b=ids[i+1],c=ids[i+2],ax=a%N,ay=Math.floor(a/N),bx=b%N,by=Math.floor(b/N),cx=c%N,cy=Math.floor(c/N);
  const twice=(bx-ax)*(cy-ay)-(by-ay)*(cx-ax);assert.ok(twice>=0,'Stitching inverted a corner triangle');area+=twice;
 }
 assert.equal(area,2*S*S,'Stitched triangles leave holes or overlap');
}
surface.stitch(fine,[1,2,1,1]);
crater.center.copy(point(fine,(fine.N>>1)*fine.N+fine.N-1)).normalize();crater.strength=12;
for(const tile of [fine,coarse])context.refreshEarthTileDeformation(tile,{n:crater.center,R:1000});
earth.mesh.updateMatrixWorld(true);checkBorder();
assert.ok(fine.baseRadii instanceof Float64Array||Object.prototype.toString.call(fine.baseRadii)==='[object Float64Array]','Planet radii lost precision during deformation');
for(const tile of [fine,coarse]){tile.mesh.geometry.dispose();tile.skirtMesh.geometry.dispose();}
// Every original triangle must appear exactly once, including both poles and
// the longitude seam. Sector bounds must contain all the indexed vertices.
const globe=new T.SphereGeometry(100,40,20);
const triangles=indices=>Array.from({length:indices.length/3},(_,i)=>Array.from(indices.subarray(i*3,i*3+3)).join(':')).sort();
const original=triangles(globe.index.array);
const sections=GodmanTerrainSurface.globeSections(T,globe,8),pointInSection=new T.Vector3();
const rebuilt=[];
for(const section of sections){
 const geometry=section.geometry;
 assert.equal(geometry.attributes.position,globe.attributes.position);
 assert.equal(geometry.attributes.normal,globe.attributes.normal);
 assert.equal(geometry.index.array.buffer,globe.index.array.buffer);
 rebuilt.push(...triangles(geometry.index.array));
 for(const index of geometry.index.array){
   pointInSection.fromBufferAttribute(geometry.attributes.position,index);
   assert.ok(geometry.boundingSphere.distanceToPoint(pointInSection)<1e-6);
   assert.ok(pointInSection.normalize().angleTo(section.center)<=section.angularRadius+1e-6);
 }
}
assert.deepEqual(rebuilt.sort(),original,'Globe sections changed the rendered triangles');
const orbitGlobe=new T.SphereGeometry(100,8,4),globeMesh=new T.Mesh(globe);
const orbitFixture={
 earth:{r:100,center:new T.Vector3(),mesh:globeMesh},
 earthGlobe:{detail:globe,orbit:orbitGlobe,sections,maxRadius:100,view:new T.Vector3(),inverse:new T.Quaternion()},
 earthDetailRoot:new T.Group(),earthSurfaceCutaway:{cosRadius:{value:.99},orbitalCosRadius:{value:.991}}
};
for(const section of sections)section.mesh=new T.Mesh(section.geometry);
vm.createContext(orbitFixture);
vm.runInContext(source.slice(source.indexOf('  function updateEarthGlobe('),source.indexOf('  function buildPermanentMountainPatches(')),orbitFixture);
orbitFixture.updateEarthGlobe(new T.Vector3(104,0,0));
assert.equal(globeMesh.layers.mask,0,'Near view submitted the entire globe as well as its sectors');
assert.ok(sections.some(s=>s.mesh.visible)&&sections.some(s=>!s.mesh.visible),'Ground view failed to select the visible sectors');
orbitFixture.updateEarthGlobe(new T.Vector3(1200,0,0));
assert.equal(globeMesh.geometry,orbitGlobe);
assert.ok(!orbitFixture.earthDetailRoot.visible&&sections.every(s=>!s.mesh.visible));
assert.equal(orbitFixture.earthSurfaceCutaway.orbitalCosRadius.value,2,'Overview opened a cutaway in the globe');
orbitFixture.updateEarthGlobe(new T.Vector3(104,0,0));
assert.equal(globeMesh.geometry,globe);
assert.ok(orbitFixture.earthDetailRoot.visible,'Returning from overview left walking terrain hidden');
orbitFixture.earth.craters=[{}];
orbitFixture.updateEarthGlobe(new T.Vector3(1200,0,0));
assert.equal(globeMesh.geometry,globe,'The distant mesh lost terrain deformation');
assert.equal(globeMesh.layers.mask,1);
const sampleHeight=GodmanTerrainSurface.sampleHeight;
const raster=new Uint8Array([
  4,12,8,1,0,
  8,36,26,4,3,
  17,70,41,11,2,
  31,110,64,20,1
]);
for(let y=0;y<4;y++)for(let x=0;x<5;x++){
 assert.equal(sampleHeight(raster,5,4,x,y,false),raster[y*5+x],'Interpolation changed a source height');
}
function slopeAtJoin(sample,x){
 const epsilon=1e-5,center=sample(x);
 const left=(center-sample(x-epsilon))/epsilon,right=(sample(x+epsilon)-center)/epsilon;
 assert.ok(Math.abs(left-right)<.005,'The slope jumps at the elevation raster join');
}
slopeAtJoin(x=>sampleHeight(raster,5,4,x,1.35,false),2);
slopeAtJoin(y=>sampleHeight(raster,5,4,1.7,y,false),2);
slopeAtJoin(x=>sampleHeight(raster,5,4,x,1.35,true),5);
for(let i=0;i<=100;i++)for(let j=0;j<=100;j++){
 const h=sampleHeight(raster,5,4,1+i/100,1+j/100,false);
 assert.ok(h>=26&&h<=70,'Interpolation produced a new peak or valley between elevation samples');
}
console.log('PASS: continuous slope lighting, exact mixed-LOD edges, all corner ratios, cover alignment, texture anchoring, LOD changes and crater deformation across borders.');
