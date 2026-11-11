'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const game=fs.readFileSync(require.resolve('../src/game.js'),'utf8');
const listeners={};
const context=vm.createContext({
  addEventListener:(name,callback)=>{listeners[name]=callback;},
  gamePaused:()=>context.paused,paused:true,overview:false,earthEventsOpen:false,
  prepareEarthEventTerrain:()=>{context.prepared++;},prepared:0,
  earthEventAim:true,camDistTarget:8,overviewZoomTarget:400,
  worldSize:distance=>distance,loaderHidden:true,redrawPausedScene:false,
  clock:{getDelta:()=>.016},elapsed:0,profileEnabled:false,
  requestAnimationFrame:()=>{},scene:{},camera:{},
  renderer:{render:()=>{context.rendered++;}},rendered:0
});
const wheel=game.indexOf("  addEventListener('wheel', e => {");
vm.runInContext(game.slice(wheel,game.indexOf('  // ---------- Music',wheel)),context);
const frame=game.indexOf('  function animate() {');
vm.runInContext(game.slice(frame,game.indexOf('    elapsed += dt;',frame))+'elapsed += dt; }',context);
for(const overview of [false,true]){
  context.overview=overview;
  listeners.wheel({deltaY:500});
  assert.equal(context.camDistTarget,8,'Settings scroll zoomed the third-person view');
  assert.equal(context.overviewZoomTarget,400,'Settings scroll zoomed the overview');
  assert.equal(context.earthEventAim,true,'Settings scroll canceled event framing');
  context.animate();
  assert.equal(context.elapsed,0,'Game time advanced while a menu was open');
}
context.redrawPausedScene=true;
context.animate();
assert.equal(context.rendered,1,'A paused resize did not redraw the frozen backdrop');
assert.equal(context.elapsed,0);
context.earthEventsOpen=true;
context.animate();
assert.equal(context.prepared,1,'The paused event catalog did not prepare the destination');
assert.equal(context.elapsed,0,'Preparing the event site advanced game time');
context.earthEventsOpen=false;
context.paused=false;
listeners.wheel({deltaY:50});
assert.ok(context.overviewZoomTarget>400);
context.animate();
assert.equal(context.elapsed,.016);
console.log('PASS: menu scroll stays out of gameplay, the paused frame is stable, and game time resumes normally.');
