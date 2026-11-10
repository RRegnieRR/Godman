'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const T=global.THREE=require('../vendor/three.r128.min.js');require('../src/runtime/terrain-surface.js');require('../src/runtime/earth-ground.js');
const source=fs.readFileSync(require.resolve('../src/game.js'),'utf8');
const earth={r:637100,mesh:new T.Group()},crater={strength:0,center:new T.Vector3(-1,0,0)};
const context={shoulderFlashlight:{light:{castShadow:false}},THREE:T,window:global,earth,earthDetailRoot:earth.mesh,EARTH_SEA_LEVEL:.42,earthSurfaceTiles:{tiles:new Map(),lodSegments:[128,64,32,16],frame:0},
 fullScaleTerrain:false,worldFactor:1,V3:(x,y,z)=>new T.Vector3(x,y,z),sampleEarthElevationRaster:()=>100,
 earthCoastDistance:()=>Infinity,earthReefAt:()=>0,
 earthFineReliefLocal:n=>6*Math.sin(n.x*earth.r/24)+9*Math.cos(n.z*earth.r/37),
 earthCraterDispLocal:n=>-crater.strength*Math.exp(-((n.distanceTo(crater.center)*earth.r/60)**2)),
 sampleEarthMeltLocal:()=>({strength:crater.strength? .5:0,birth:0}),earthAlbedoLocal:(n,c)=>{c.setRGB(.15,.25,.1);return true;},
 sampleEarthRuggednessLocal:()=>0,earthValueNoise3:()=>.5,earthRockTint:new T.Color(),earthSnowTint:new T.Color(),earthTileMat:new T.MeshStandardMaterial(),earthWaterMat:new T.MeshBasicMaterial()};
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('  const terrainSurface=new '),source.indexOf('  function stitchEarthSurfaceTiles(){')),context);
const lonCells=Math.ceil(2*Math.PI*earth.r/480),latCells=Math.ceil(Math.PI*earth.r/480);
const coastPixels=new Uint8Array(8*4*4);
for(let i=0;i<32;i++)if(i%8>=4)coastPixels.fill(255,i*4,i*4+3);
const coast=GodmanTerrainSurface.coastField(coastPixels,8,4,earth.r);
const shore=u=>GodmanTerrainSurface.coastDistance(coast,u,.5);
assert.ok(shore(.49)>0&&shore(.51)<0,'The shore does not transition from land to water');
assert.ok(Math.abs(shore(.5))<1e-7&&shore(0)===shore(1),'The shore jumps at the waterline or date line');
const elevation=d=>GodmanTerrainSurface.coastElevation(d,65,20,.42,10);
assert.ok(Math.abs(elevation(-.01)-elevation(.01))<.01,'The beach has a cliff at sea level');
assert.ok(elevation(-300)<.42&&elevation(300)>.42&&elevation(5000)===85,'The coastal profile lost its seabed or inland relief');
// Globe and regional geometry use fixed Earth coordinates. Floating-origin
// shifts and planetary spin must not change clipping or texture phase.
earth.mesh.material=new T.MeshStandardMaterial();
context.earthRegionalAnchor={value:new T.Vector3()};
context.earthFallbackEye={value:new T.Vector3()};
context.earthFallbackBlend={value:new T.Vector2()};
context.worldSize=size=>size;
context.earthSurfaceCutaway={center:{value:new T.Vector3(1,0,0)},chordSq:{value:.02}};
vm.runInContext(source.slice(source.indexOf('  function setEarthTerrainCoverage('),source.indexOf('  const EARTH_MOUNTAIN_SITES=')),context);
const shader={uniforms:{},vertexShader:'#include <common>\n#include <begin_vertex>',
 fragmentShader:'#include <common>\n#include <clipping_planes_fragment>\n#include <logdepthbuf_fragment>'};
earth.mesh.material.onBeforeCompile(shader);
assert.equal(earth.mesh.material.stencilFunc,T.NotEqualStencilFunc,'The globe does not fill uncovered terrain pixels');
assert.equal(earth.mesh.material.stencilZPass,T.KeepStencilOp,'The globe modified terrain coverage');
for(const layer of ['detail','regional']){
 const material=new T.MeshStandardMaterial();
 context.setEarthTerrainCoverage(material,layer);
 assert.ok(material.stencilWrite);
 assert.equal(material.stencilRef,1);
 assert.equal(material.stencilFunc,layer==='detail'?T.AlwaysStencilFunc:T.NotEqualStencilFunc);
 assert.equal(material.stencilZPass,T.ReplaceStencilOp);
}
assert.ok(!shader.vertexShader.includes('modelMatrix'),'Terrain shading depends on the moving render origin');
context.fullScaleTerrain=true;
context.earthFlightGroundStrength={value:1};
context.earthCoastAtlas={value:null};context.earthCoastAtlasReady={value:0};
context.earthGroundDetail={value:null};
context.earthTilePlanetInverse={value:new T.Matrix3()};
for(const regional of [true,false]){
 const flightShader={uniforms:{},vertexShader:'#include <common>\n#include <begin_vertex>',
  fragmentShader:'#include <common>\n#include <clipping_planes_fragment>\n#include <roughnessmap_fragment>'};
 context.configureEarthSurfaceShader(flightShader,regional);
 assert.equal(flightShader.uniforms.earthFlightGroundStrength,context.earthFlightGroundStrength);
 assert.ok(flightShader.fragmentShader.includes('earthFlightAlbedo(diffuseColor.rgb'),'An Earth fallback lost its flight terrain material');
 assert.ok(flightShader.vertexShader.includes('varying vec3 vEarthSurfacePoint')&&
  flightShader.fragmentShader.includes('varying vec3 vEarthSurfacePoint'),'Fallback terrain position is missing from a shader stage');
 assert.ok(!flightShader.vertexShader.includes('modelMatrix'),'Flight texture phase moves with the render origin');
 assert.ok(!flightShader.fragmentShader.includes('discard'),'Fallback terrain can expose a gap even when finer meshes are missing');
 if(regional)assert.equal(flightShader.uniforms.earthRegionalAnchor,context.earthRegionalAnchor);
}
context.fullScaleTerrain=false;
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
  const radial=new T.Vector3().fromBufferAttribute(fine.mesh.geometry.attributes.earthDirection,i);
  const sharedRadial=new T.Vector3().fromBufferAttribute(coarse.mesh.geometry.attributes.earthDirection,other)
   .lerp(new T.Vector3().fromBufferAttribute(coarse.mesh.geometry.attributes.earthDirection,next),t);
  assert.ok(radial.distanceTo(sharedRadial)<1e-7,'Planet-local clipping changes across the shared edge');
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
earth.r=6371000;
context.fullScaleTerrain=true;
context.earthSurfaceTiles={tiles:new Map(),tileSize:1440,lodSegments:[256,128,64,32,16],frame:0};
const wideCols=Math.ceil(2*Math.PI*earth.r/1440),wideRows=Math.ceil(Math.PI*earth.r/1440);
const wideFine=context.buildEarthSurfaceTile(3200,4000,wideCols,wideRows,0);
const wideCoarse=context.buildEarthSurfaceTile(3201,4000,wideCols,wideRows,1);
context.earthSurfaceTiles.committedKeys=new Set([wideFine.key,wideCoarse.key]);
context.stitchEarthSurfaceTiles();
earth.mesh.updateMatrixWorld(true);
assert.equal(wideFine.N,257);
const landingSurface=new GodmanTerrainSurface(T,earth.r,()=>earth.r);
const middle=(wideFine.N>>1)*wideFine.N+(wideFine.N>>1);
const landingPoint=point(wideFine,middle);
const landingRadius=landingSurface.tileRadius(wideFine,.5,.5,landingPoint.clone().normalize());
assert.ok(Math.abs(landingRadius-landingPoint.length())<.001,'Ground collision missed the rendered landing surface');
for(let j=0;j<wideFine.N;j+=2){
 assert.ok(point(wideFine,j*wideFine.N+wideFine.N-1).distanceTo(point(wideCoarse,(j/2)*wideCoarse.N))<.0003,
  'Extended 1:1 tiles do not share an exact edge');
}
const shoreColumn=3203,shoreRow=4000,shoreAngle=(shoreColumn+.5)*2*Math.PI/wideCols;
context.earthCoastDistance=n=>(Math.atan2(n.z,-n.x)-shoreAngle)*earth.r;
context.earthFineReliefLocal=(n,base,d=context.earthCoastDistance(n))=>GodmanTerrainSurface.coastElevation(d,base,0,.42,10)-base;
const beachTile=context.buildEarthSurfaceTile(shoreColumn,shoreRow,wideCols,wideRows,3);
assert.ok(beachTile.waterMesh,'The crossing tile has no shoreline water');
assert.ok(Number.isFinite(beachTile.mesh.geometry.boundingSphere.radius),'The coast contains invalid terrain vertices');
const waterGeo=beachTile.waterMesh.geometry,waterDepth=waterGeo.attributes.earthWaterDepth;
assert.equal(waterGeo.attributes.earthCoast,beachTile.mesh.geometry.attributes.earthCoast);
let crossingTriangle=false;
for(let i=0;i<waterGeo.index.count;i+=3){
 const depths=[0,1,2].map(k=>waterDepth.getX(waterGeo.index.getX(i+k)));
 assert.ok(depths.some(depth=>depth>0),'A dry triangle was covered by the sea');
 if(depths.some(depth=>depth<=0))crossingTriangle=true;
}
assert.ok(crossingTriangle,'The water geometry stopped before reaching the shore contour');
// Every original triangle must appear exactly once, including both poles and
// the longitude seam. Sector bounds must contain all the indexed vertices.
const globe=new T.SphereGeometry(100,40,20);
const regional=GodmanTerrainSurface.buildRegionalPatch(T,globe,{x:-1,y:8,columns:3,rows:3},8,100,()=>10);
let regionalResult;
do{regionalResult=regional.next();}while(!regionalResult.done);
const {geometry:regionalGeometry,center:regionalCenter}=regionalResult.value;
const regionalPosition=regionalGeometry.attributes.position;
const globePosition=globe.attributes.position;
const border=new T.Vector3().fromBufferAttribute(regionalPosition,4).add(regionalCenter);
const baseEdge=new T.Vector3().fromBufferAttribute(globePosition,8*41+39)
 .lerp(new T.Vector3().fromBufferAttribute(globePosition,8*41+40),.5);
assert.ok(border.distanceTo(baseEdge)<1e-5,'Regional terrain separated from the globe at the date line');
assert.ok(Math.abs(new T.Vector3().fromBufferAttribute(regionalPosition,12*25+12).add(regionalCenter).length()-110)<1e-5,
 'Regional terrain failed to replace the coarse elevation in its interior');
assert.ok(new T.Vector3().fromBufferAttribute(regionalGeometry.attributes.normal,12*25+12).dot(regionalCenter)>0,
 'Regional terrain normals faced into the planet');
regionalGeometry.dispose();
const budget=new GodmanTerrainSurface.RegionalTerrainBudget();
for(let i=0;i<360;i++)budget.update(1/60,16.67,2);
assert.equal(budget.tier,1);
for(let i=0;i<60;i++)budget.update(1/60,24,2);
assert.equal(budget.tier,0);
for(let i=0;i<60;i++)budget.update(1/60,24,2);
assert.equal(budget.tier,0);
for(let i=0;i<200;i++)budget.update(1/60,16.67,2);
assert.equal(budget.tier,1);
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
 worldSize:size=>size,
 THREE:T,fullScaleTerrain:false,sampleEarthElevationLocal:()=>8,
 earthFallbackEye:{value:new T.Vector3()},earthFallbackBlend:{value:new T.Vector2()},
 earth:{r:100,center:new T.Vector3(),mesh:globeMesh},
 earthGlobe:{detail:globe,orbit:orbitGlobe,sections,maxRadius:100,view:new T.Vector3(),inverse:new T.Quaternion()},
 earthDetailRoot:new T.Group(),earthSurfaceCutaway:{chordSq:{value:.02}}
};
for(const section of sections)section.mesh=new T.Mesh(section.geometry);
vm.createContext(orbitFixture);
vm.runInContext(source.slice(source.indexOf('  function updateEarthGlobe('),source.indexOf('  function buildPermanentMountainPatches(')),orbitFixture);
orbitFixture.updateEarthGlobe(new T.Vector3(104,0,0));
assert.equal(orbitFixture.earthFallbackBlend.value.x,1,'Fallback terrain can sit above the camera');
assert.equal(globeMesh.layers.mask,0,'Near view submitted the entire globe as well as its sectors');
assert.ok(sections.some(s=>s.mesh.visible)&&sections.some(s=>!s.mesh.visible),'Ground view failed to select the visible sectors');
orbitFixture.updateEarthGlobe(new T.Vector3(1200,0,0));
assert.equal(orbitFixture.earthFallbackBlend.value.lengthSq(),0,'Orbital view warped the globe');
assert.equal(globeMesh.geometry,orbitGlobe);
assert.ok(!orbitFixture.earthDetailRoot.visible&&sections.every(s=>!s.mesh.visible));
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
