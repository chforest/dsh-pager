import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {fileURLToPath} from 'node:url'
export function cliDataDir(config={},env=process.env,home=os.homedir()){
 if(config.dataDir)return path.resolve(config.dataDir)
 const legacy=fileURLToPath(new URL('./data/',import.meta.url))
 if(fs.existsSync(legacy)&&fs.readdirSync(legacy).length)throw Error('检测到旧CLI调用回执，请显式配置 dataDir 或停机迁移；不能丢弃未知操作回执。')
 return path.resolve(env.DSH_HOME||path.join(home,'.dsh'),'extensions','antigravity-cli')
}
