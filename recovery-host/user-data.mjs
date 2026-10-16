import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import {fileURLToPath} from 'node:url'
export function recoveryPaths(config={},env=process.env,home=os.homedir()){
  const root=path.resolve(env.DSH_HOME||path.join(home,'.dsh'),'extensions')
  const legacyState=fileURLToPath(new URL('./data/recovery.json',import.meta.url))
  const legacyTasks=fileURLToPath(new URL('../../自动任务插件-20261013/data/tasks.json',import.meta.url))
  if(!config.stateFile&&fs.existsSync(legacyState))throw Error('检测到旧恢复日志，请显式配置 stateFile 或停机后手动迁移；不自动恢复或合并旧日志。')
  if(!config.tasksFile&&fs.existsSync(legacyTasks))throw Error('检测到旧任务存储，请显式配置 tasksFile，避免恢复归属错配。')
  return{stateFile:path.resolve(config.stateFile||path.join(root,'recovery','recovery.json')),tasksFile:path.resolve(config.tasksFile||path.join(root,'tasks','tasks.json'))}
}
export function defaultRecoveryPaths(env=process.env,home=os.homedir()){
 const root=path.resolve(env.DSH_HOME||path.join(home,'.dsh'),'extensions')
 return{stateFile:path.join(root,'recovery','recovery.json'),tasksFile:path.join(root,'tasks','tasks.json')}
}
