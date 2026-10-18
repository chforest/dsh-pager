export function pluginTag(source) {
  return source?.kind==='plugin' ? source.plugin : typeof source?.kind==='string'&&source.kind.startsWith('plugin:') ? source.kind.slice(7) : null
}
export const pluginSource = (tag, modern=false) => modern ? {kind:'plugin:'+tag} : {kind:'plugin',plugin:tag}
export const eventsOf = session => typeof session?.snapshotEvents==='function' ? session.snapshotEvents() : session?.events || []
export function taskRecordType(event) {
  const type=event?.type
  if(type==='automatic-task/start'||type==='automatic-task/goal')return type
  if(event?.ignorable!==true)return type
  for(const name of ['start','goal'])if(type==='plugin:dsh-tasks/'+name||type==='plugin:automatic-task/'+name)return 'automatic-task/'+name
  return type
}
