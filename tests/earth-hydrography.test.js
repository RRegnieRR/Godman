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
assert.equal(dateLine.sample(-179.98,10.2,{}).kind,0,'Island hole was flooded');
dateLine.addRiver(120,[179.99,12,80,180.01,12,70]);
assert.ok(dateLine.sample(-179.999,12,{}).bank<0);
assert.ok(dateLine.sample(179.999,12,{}).level>dateLine.sample(-179.999,12,{}).level);
console.log('PASS: real lake outlines, mapped river channels, dry land, islands and date-line continuity.');
