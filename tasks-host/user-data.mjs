import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import {fileURLToPath} from 'node:url'
export function defaultTaskDataDir(env=process.env,home=os.homedir()){return path.resolve(env.DSH_HOME||path.join(home,'.dsh'),'extensions','tasks')}
export function taskDataDir(config={}){
  if(config.dataDir)return path.resolve(config.dataDir)
  const legacy=fileURLToPath(new URL('../../自动任务插件-20261013/data/tasks.json',import.meta.url))
  if(fs.existsSync(legacy))throw Error('检测到旧任务存储，请显式配置 dataDir 或停用后手动迁移；不自动建立空任务库。')
  return defaultTaskDataDir()
}
