import assert from 'node:assert/strict'
import {wallOpeningIntervals, drawWall, lineOfSightBlocked, clickHitsWallShape} from '../src/editor/plan-drawing.js'
import {constrainPoint, canCloseWall} from '../src/editor/constraints.js'
const wall={id:1,closed:false,points:[{x:0,y:0},{x:1000,y:0},{x:1000,y:400}]}
const twin={id:2,closed:false,points:[{x:1000,y:0},{x:0,y:0}]}
const openings=[{presetId:'window',wallId:1,segmentIndex:0,t1:.401,t2:.399},{presetId:'door',wallId:1,segmentIndex:0,t1:.1,t2:.2,rotation:90},{presetId:'window',wallId:1,segmentIndex:0,t1:.15,t2:.25}]
assert.deepEqual(wallOpeningIntervals(wall.points[0],wall.points[1],[wall,twin],openings),[[.1,.25],[.399,.401]])
console.log('✓ mixed, overlapping and reversed openings merge in segment order')
assert.equal(wallOpeningIntervals(twin.points[0],twin.points[1],[wall,twin],openings).length,2)
console.log('✓ shared wall copy has the same narrow window cutout')
assert.equal(lineOfSightBlocked(400,-100,400,100,[wall,twin],openings),false)
assert.equal(lineOfSightBlocked(500,-100,500,100,[wall,twin],openings),true)
console.log('✓ narrow opening and adjacent wall agree with line of sight')
const segments=[]; let start
const ctx=new Proxy({}, {get(target,key){if(key==='moveTo')return (x,y)=>{start={x,y}};if(key==='lineTo')return (x,y)=>{segments.push([start,{x,y}]); start={x,y}};if(key==='measureText')return()=>({width:20});return target[key]||(()=>{})},set(target,key,value){target[key]=value;return true}})
drawWall(ctx,wall,{x:0,y:0},{x:0,y:0},1,[])
assert.equal(segments.filter(([a,b])=>a.x!==b.x || a.y!==b.y).some(([a,b])=>a.x===1000&&a.y===400&&b.x===0&&b.y===0),false)
console.log('✓ open L does not draw a diagonal closing wall')
assert.equal(clickHitsWallShape({x:500,y:200},wall.points,{x:0,y:0},{x:0,y:0},1,9,false),false)
assert.equal(canCloseWall(wall),true);assert.equal(canCloseWall({points:[{x:0,y:0},{x:10,y:0},{x:20,y:0}]}),false)
console.log('✓ open path has no phantom selection edge; degenerate paths cannot close')
const locked=constrainPoint({x:0,y:0},{x:100,y:10},true)
assert.equal(locked.y,0);assert(Math.abs(locked.x-Math.hypot(100,10))<1e-9)
console.log('✓ angle locking preserves length and uses the nearest 45-degree angle')
