'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const T=global.THREE=require('../vendor/three.r128.min.js');require('../src/runtime/terrain-surface.js');
const source=fs.readFileSync(require.resolve('../src/game.js'),'utf8');
const earth={r:637100,mesh:new T.Group()},crater={strength:0,center:new T.Vector3(-1,0,0)};
const context={shoulderFlashlight:{light:{castShadow:false}},THREE:T,window:global,earth,EARTH_SEA_LEVEL:.42,earthSurfaceTiles:{tiles:new Map(),lodSegments:[128,64,32,16],frame:0},
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
context.earthSurfaceCutaway={center:{value:new T.Vector3(1,0,0)},cosRadius:{value:.99}};
vm.runInContext(source.slice(source.indexOf('  earth.mesh.material.onBeforeCompile='),source.indexOf('  const EARTH_MOUNTAIN_SITES=')),context);
const shader={uniforms:{},vertexShader:'#include <common>\n#include <begin_vertex>',fragmentShader:'#include <common>\n#include <clipping_planes_fragment>'};
earth.mesh.material.onBeforeCompile(shader);
assert.equal(shader.uniforms.earthSurfaceCenter,context.earthTileCenterWorld,'Mountain cutaway retained a mesh-local centre');
assert.equal(shader.uniforms.earthTileRenderCenter,context.earthTileRenderCenter,'Mountain cutaway does not follow floating origin');
assert.ok(shader.vertexShader.includes('modelMatrix*vec4(position,1.0)'),'Mountain cutaway ignores anchored mesh transforms');
const fine=context.buildEarthSurfaceTile(3200,2000,lonCells,latCells,0),coarse=context.buildEarthSurfaceTile(3201,2000,lonCells,latCells,1);
const surface=new GodmanTerrainSurface(T,earth.r,n=>earth.r+context.sampleEarthElevationRaster(n)+context.earthFineReliefLocal(n)+context.earthCraterDispLocal(n));
context.earthSurfaceTiles.committedKeys=new Set([fine.key,coarse.key]);
vm.runInContext(source.slice(source.indexOf('  function stitchEarthSurfaceTiles(){'),source.indexOf('  function updateEarthSurfaceTiles(){')),context);
context.stitchEarthSurfaceTiles();
assert.equal(fine.stitchSteps[1],2,'Committed neighbour lookup did not stitch the fine edge');
assert.equal(coarse.stitchSteps[0],1,'Coarse edge was incorrectly reduced');
earth.mesh.updateMatrixWorld(true);
function point(tile,index){return tile.mesh.localToWorld(new T.Vector3().fromBufferAttribute(tile.mesh.geometry.attributes.position,index));}
function normal(tile,index){return new T.Vector3().fromBufferAttribute(tile.mesh.geometry.attributes.normal,index).applyQuaternion(tile.group.quaternion).normalize();}
function checkBorder(){
 for(let j=0;j<fine.N;j++){
  const i=j*fine.N+fine.N-1,other=Math.floor(j/2)*coarse.N,t=j%2/2;
  const next=Math.min(coarse.N-1,Math.floor(j/2)+1)*coarse.N;
  assert.ok(point(fine,i).distanceTo(point(coarse,other).lerp(point(coarse,next),t))<.0001,'Fine/coarse borders do not share the exact edge');
  assert.ok(normal(fine,i).distanceTo(normal(coarse,other).lerp(normal(coarse,next),t).normalize())<1e-6,'Lighting changes across a shared edge');
 }
 const skirt=fine.skirtMesh.geometry.attributes;
 for(let e=0;e<fine.perimeter.length;e++){
  const i=fine.perimeter[e],p=fine.mesh.geometry.attributes.position,n=fine.mesh.geometry.attributes.normal;
  const q=new T.Vector3().fromBufferAttribute(skirt.position,e*2),v=new T.Vector3().fromBufferAttribute(p,i);
  assert.ok(q.distanceTo(v)<1e-6,'Crack-cover fence protrudes above the stitched edge');
  assert.ok(new T.Vector3().fromBufferAttribute(skirt.normal,e*2).distanceTo(new T.Vector3().fromBufferAttribute(n,i))<1e-6,'Crack cover has unrelated vertical lighting');
 }
}
checkBorder();
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
console.log('PASS: continuous slope lighting, exact mixed-LOD edges, all corner ratios, cover alignment, LOD changes and crater deformation across borders.');
