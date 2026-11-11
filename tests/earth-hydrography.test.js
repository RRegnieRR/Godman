'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
require('../src/runtime/earth-hydrography.js');

const source=new GodmanEarthHydrography();
for(const record of source.read(fs.readFileSync(require.resolve('../assets/earth/hydrography.bin')))){}
assert.ok(source.paths.length>1500);
const sample=(lon,lat)=>source.sample(lon,lat,{});
for(const [lon,lat] of [[-87.5,47.6],[33,-1],[108,53.6],[-120,39.1]]){
  const lake=sample(lon,lat);
  assert.equal(lake.kind,1);
  assert.ok(lake.bank<0&&lake.level>0);
}
assert.equal(sample(-87.5,47.6).level,sample(-88.2,47.9).level,'Lake Superior water surface is uneven');
for(const [lon,lat] of [[31.225,30.025],[-60.075,-3.3]]){
  const river=sample(lon,lat);
  assert.equal(river.kind,2);
  assert.ok(river.bank<0&&Number.isFinite(river.level));
}
assert.equal(sample(12,25).kind,0,'Water appeared in an unmapped part of the Sahara');
assert.equal(sample(-152,6).kind,0,'Open ocean was classified as an inland feature');

const {width,height}=source.coastMask;
const coastalPixels=new Uint8Array(width*height*4).fill(255);
source.removeMappedLakes(coastalPixels,width,height);
function coastPixel(lon,lat){
  const column=Math.floor((lon+180)/360*width),row=Math.floor((90-lat)/180*height);
  return coastalPixels[(row*width+column)*4];
}
assert.equal(coastPixel(-87.5,47.6),0,'The coarse ocean mask still covers Lake Superior');
assert.equal(coastPixel(-152,6),255,'Removing mapped lakes changed the Pacific');

const dateLine=new GodmanEarthHydrography();
dateLine.addLake(150,[
  [179.8,10,180.2,10,180.2,10.4,179.8,10.4,179.8,10],
  [179.95,10.14,180.05,10.14,180.05,10.26,179.95,10.26,179.95,10.14]
]);
assert.ok(dateLine.sample(179.9,10.2,{}).bank<0);
assert.ok(dateLine.sample(-179.9,10.2,{}).bank<0);
assert.ok(dateLine.sample(-179.98,10.2,{}).bank>0,'Island hole was flooded');
dateLine.addRiver(120,[179.99,12,80,180.01,12,70]);
assert.ok(dateLine.sample(-179.999,12,{}).bank<0);
assert.ok(dateLine.sample(179.999,12,{}).level>dateLine.sample(-179.999,12,{}).level);
// A real Lake Mead junction previously changed by 479 m in about 35 m.
const mead=sample(-113.63567,35.83083),tributary=sample(-113.63542,35.83108);
assert.equal(mead.kind,1);
assert.equal(tributary.kind,2);
assert.ok(mead.bank<=0&&tributary.bank<=0);
assert.ok(Math.abs(mead.level-tributary.level)<1,'Lake and river no longer meet at a shared water level');
const floorAt=water=>GodmanEarthHydrography.bankElevation(water,1000,water.level,1);
assert.ok(Math.abs(floorAt(mead)-floorAt(tributary))<3,'Lake and river beds formed a ledge at their junction');
for(const kind of [1,2])for(const scale of [1,10]){
  const transition=kind===1?4200:3600,water=475/scale,ground=1250/scale;
  const height=bank=>GodmanEarthHydrography.bankElevation({kind,bank,transition},ground,water,scale);
  assert.equal(height(0),water);
  assert.equal(height(transition),ground);
  assert.ok(height(40)-water<4/scale,'Coarse relief created a wall immediately above the shoreline');
  assert.ok(height(-100)<water&&height(100)>water,'Terrain does not cross the water level at the mapped shore');
  for(let d=0;d<transition;d+=5){
    assert.ok((height(d+5)-height(d))*scale<2,'Bank grade changed too abruptly');
  }
}
const overlappingBanks={lakeDistance:1800,riverDistance:1800,lakeLevel:475,bank:1800};
const lakeSide=GodmanEarthHydrography.bankElevation({...overlappingBanks,kind:1,transition:4200},1250,475,1,750);
const riverSide=GodmanEarthHydrography.bankElevation({...overlappingBanks,kind:2,transition:3600},1250,750,1,750);
assert.equal(lakeSide,riverSide,'Changing the closest feature introduced a step on dry land');
console.log('PASS: mapped waterways, gradual banks, continuous lake and river junctions, islands and date-line continuity.');
