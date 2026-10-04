import assert from 'node:assert/strict'
import {calibratePlan,measureDistance} from '../src/editor/calibration.js'
import {serializePlan,deserializePlan,planDocument,normalizePlanData} from '../src/editor/history.js'
const floor={walls:[{id:1,closed:false,points:[{x:0,y:0},{x:80,y:0}]}],cameras:[{x:40,y:20,distance:8,hFov:90}],objects:[{presetId:'safe',x:20,y:20,width:.45,height:.4},{presetId:'window',wallId:1,segmentIndex:0,t1:.25,t2:.5}],wires:[{points:[{x:0,y:0},{x:80,y:0}]}]}
const plan={floors:[floor,structuredClone(floor)],activeFloor:1}
const next=calibratePlan(plan,0,1,0,2)
assert.equal(measureDistance(...next.floors[0].walls[0].points),2)
assert.equal(next.floors[1].cameras[0].x,80)
assert.equal(next.floors[1].cameras[0].distance,8)
assert.equal(next.floors[0].objects[0].width,.45)
assert.equal(next.floors[0].objects[1].x,60)
assert.equal(next.floors[0].wires[0].points[1].x,160)
console.log('✓ calibration rescales every floor and attachments without changing physical camera/object dimensions')
assert.deepEqual(deserializePlan(serializePlan(next)).calibration,next.calibration)
assert.deepEqual(normalizePlanData(JSON.parse(JSON.stringify(planDocument(next)))).calibration,next.calibration)
console.log('✓ calibration survives timeline and saved-document round trips')
for(const bad of [0,-1,'nope',Infinity])assert.throws(()=>calibratePlan(plan,0,1,0,bad))
assert.equal(plan.floors[0].walls[0].points[1].x,80)
console.log('✓ invalid lengths are rejected and the original snapshot is untouched')
