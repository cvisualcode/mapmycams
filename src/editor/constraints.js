export function constrainPoint(start, point, enabled) {
  if (!start || !enabled) return point
  const dx=point.x-start.x, dy=point.y-start.y
  const length=Math.hypot(dx,dy)
  const angle=Math.round(Math.atan2(dy,dx)/(Math.PI/4))*(Math.PI/4)
  return {x:start.x+length*Math.cos(angle),y:start.y+length*Math.sin(angle)}
}
export function canCloseWall(wall) {
  const points=wall?.points || []
  if (new Set(points.map(p=>`${p.x},${p.y}`)).size<3) return false
  let area=0
  for(let i=0;i<points.length;i++){const a=points[i],b=points[(i+1)%points.length];area+=a.x*b.y-b.x*a.y}
  return Math.abs(area)>0.01
}
