import { PIXELS_PER_METER, openingSpan } from './plan-drawing.js'
export function calibratePlan(plan, floorIndex, wallId, segmentIndex, measuredMetres) {
  const wall=plan.floors[floorIndex]?.walls.find(w=>w.id===wallId)
  const a=wall?.points[segmentIndex], b=wall?.points[segmentIndex+1] || (wall?.closed !== false ? wall?.points[0] : null)
  const old=a&&b ? Math.hypot(b.x-a.x,b.y-a.y)/PIXELS_PER_METER : 0
  const metres=Number(measuredMetres)
  if (!old || !Number.isFinite(metres) || metres<=0 || metres>10000) throw new Error('Enter a positive wall length up to 10,000 m')
  const factor=metres/old
  const point=p=>({...p,x:p.x*factor,y:p.y*factor})
  const result={...plan,version:3,calibration:{wallId,floorIndex,segmentIndex,measuredMetres:metres},floors:plan.floors.map(floor=>{
    const walls=floor.walls.map(w=>({...w,points:w.points.map(point)}))
    return {...floor,walls,cameras:floor.cameras.map(point),wires:floor.wires.map(w=>({...w,points:w.points.map(point)})),objects:floor.objects.map(o=>{
      if(o.wallId!=null){const span=openingSpan(o,walls);return span?{...o,x:(span.a.x+span.b.x)/2,y:(span.a.y+span.b.y)/2}:o}
      return point(o)
    })}
  })}
  return result
}
export function measureDistance(a,b){return Math.hypot(b.x-a.x,b.y-a.y)/PIXELS_PER_METER}
