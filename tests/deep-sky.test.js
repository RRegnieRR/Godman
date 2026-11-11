'use strict';

const assert = require('node:assert/strict');
const THREE = require('../vendor/three.r128.min.js');
global.window = global;
require('../src/runtime/deep-sky.js');

let panoramaRequests = 0;
class LocalPanoramaLoader {
  load(url, onLoad) {
    assert.equal(url, 'local-panorama.webp');
    panoramaRequests++;
    onLoad(new THREE.Texture());
  }
}
const sky = new GodmanDeepSkyRenderer({ ...THREE, TextureLoader: LocalPanoramaLoader });
const home = sky.createGalaxy({
  name: 'Milky Way',
  center: new THREE.Vector3(100, 200, 300),
  radius: 1000,
  homeGalaxy: true,
  panoramaUrl: 'local-panorama.webp',
  quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2),
  count: 12000000,
  initialCount: 2048
}, () => {});
const camera = new THREE.PerspectiveCamera(60, 1, .5, 1e23);
const eye = new THREE.Vector3(100, 700, 300);
const viewport = new THREE.Vector2(2000, 1400);
const volume = home.mesh.children[0];
const originalSeeds = home.mesh.geometry.attributes.randomSeed;

sky.update(0, eye, camera, 0, viewport);
assert.equal(panoramaRequests, 0, 'A bright atmosphere triggered an unnecessary sky image download');
let finishUpload;
sky.preparePanoramaTexture=(texture,ready)=>{
  assert.ok(texture.isTexture);
  finishUpload=ready;
};
sky.preloadHomePanorama();
sky.preloadHomePanorama();
assert.equal(panoramaRequests,1,'Preparing the panorama issued duplicate downloads');
assert.equal(volume.material.uniforms.galacticPanorama.value,null,'An unprepared panorama could enter the first space frame');
finishUpload();
sky.update(0, eye, camera, 0, viewport);
sky.update(0, eye, camera, 1, viewport);
assert.equal(volume.material.uniforms.panoramaMix.value,1,'The first orbital frame ray-marched a fallback behind the prepared photo');
for (let frame = 0; frame < 120; frame++) {
  sky.setDensityScale(frame % 2 ? .34 : 1);
  camera.rotation.y = frame * .01;
  sky.update(frame / 60, eye, camera, 1, viewport);
  assert.equal(home.mesh.geometry.drawRange.count, 2048, 'Changing render load dropped visible Milky Way stars');
  assert.equal(home.mesh.geometry.attributes.randomSeed, originalSeeds);
}
assert.ok(volume.material.uniforms.galaxyObserver.value.distanceTo(new THREE.Vector3(.5, 0, 0)) < 1e-10);
assert.equal(volume.material.depthTest, true);
assert.equal(volume.material.depthWrite, false);
assert.equal(volume.material.uniforms.diskMap.value.generateMipmaps, true);
assert.equal(volume.material.uniforms.panoramaMix.value, 1);
assert.equal(home.mesh.material.blending,THREE.AdditiveBlending,'Extinguished stars darken the background');
const photoStarVisibility=home.mesh.material.uniforms.visibility.value;
assert.equal(panoramaRequests, 1);
sky.update(2, new THREE.Vector3(100, 760, 300), camera, 1, viewport);
assert.ok(volume.material.uniforms.panoramaMix.value > 0 && volume.material.uniforms.panoramaMix.value < 1,
  'The Solar System panorama did not blend into the volume during travel');
assert.ok(home.mesh.material.uniforms.visibility.value>photoStarVisibility,'Live stars did not brighten as the photo receded');

sky.update(3, eye, camera, 0, viewport);
assert.equal(home.mesh.visible, false, 'The galaxy remained visible through a bright atmosphere');
sky.update(4, new THREE.Vector3(80_000, 0, 0), camera, 1, viewport);
assert.equal(volume.visible, false, 'The bright band followed the camera outside the galaxy');
assert.equal(volume.material.uniforms.panoramaMix.value, 0);
assert.equal(home.mesh.geometry.drawRange.count, 2048, 'Travel replaced the resolved star set');
console.log('PASS: stable Milky Way samples under changing load, galactic camera transform, atmospheric visibility and distance fade.');
