import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
export function installPlan(target, source = fileURLToPath(new URL('.', import.meta.url))) {
  if (!target || !path.isAbsolute(target)) throw Error('Provide an absolute, new --target directory');
  const root=path.resolve(target);
  if(fs.existsSync(root)) throw Error('Target already exists; choose a new directory (no overwrite)');
  const parent=path.dirname(root);
  if(!fs.existsSync(parent)||fs.realpathSync(parent).toLowerCase()!==parent.toLowerCase()) throw Error('Target parent must exist and must not be a symlink');
  return {root,source,packageName:'dsh-voice-mode',packageDirectory:path.join(root,'node_modules/dsh-voice-mode'),modelCache:path.join(root,'models'),host:pathToFileURL(path.join(root,'node_modules/dsh-voice-mode/lib/index.js')).href};
}
export function pluginConfig(plan) {
  return {id:'voice-mode',name:'dsh-voice-mode',config:{enabled:true,cacheDir:plan.modelCache,ttsEngine:'vits',voice:'fushiyu',rate:1.1}};
}
export function executeInstall(plan,npmCli) {
  if(!fs.existsSync(npmCli)) throw Error('npm CLI not found; pass --npm-cli /absolute/path/to/npm-cli.js');
  fs.mkdirSync(plan.root);
  fs.writeFileSync(path.join(plan.root,'package.json'),JSON.stringify({name:'dsh-pager-voice-runtime',version:'1.0.0',private:true},null,2));
  const run=args=>{const r=spawnSync(process.execPath,[npmCli,...args],{cwd:plan.root,stdio:'inherit',windowsHide:true});if(r.status!==0)throw Error('npm failed; incomplete target retained for inspection');};
  // Pack copies rather than a file: symlink, so dependencies resolve in target.
  run(['pack',plan.source,'--pack-destination',plan.root,'--ignore-scripts']);
  const tar=fs.readdirSync(plan.root).find(x=>/^dsh-voice-mode-.*\.tgz$/.test(x));
  if(!tar)throw Error('Package archive missing');
  run(['install',path.join(plan.root,tar),'--omit=dev','--ignore-scripts']);
  fs.writeFileSync(path.join(plan.root,'voice-plugin.example.json'),JSON.stringify(pluginConfig(plan),null,2)+'\n');
  fs.writeFileSync(path.join(plan.root,'voice-package-location.json'),JSON.stringify({packageName:plan.packageName,packageDirectory:plan.packageDirectory,hostEntryEvidence:plan.host,note:'Link packageDirectory into your chosen profile/node_modules/dsh-voice-mode before enabling the bare package name. No profile has been modified.'},null,2)+'\n');
  return plan;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const args=process.argv.slice(2),get=k=>args[args.indexOf(k)+1];
    const plan=installPlan(args.includes('--target')?get('--target'):null);
    if(args.includes('--install')){
      const npmCli=args.includes('--npm-cli')?get('--npm-cli'):(process.env.npm_execpath||path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'));
      executeInstall(plan,npmCli);
    }
    console.log(JSON.stringify({...plan,installed:args.includes('--install'),note:'No DSH profile changed. Review the generated plugin configuration before enabling.'},null,2));
  }catch(e){console.error(e.message);process.exitCode=1;}
}
