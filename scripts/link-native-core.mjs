// Use the same built native fork for every DSH peer; manifests stay portable.
import { readFileSync, readdirSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = process.env.DSH_NATIVE_ROOT
if (!root) throw new Error('Set DSH_NATIVE_ROOT to the built native DSH checkout')
const here = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))
const wanted = new Set(Object.keys({...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies}).filter(n => n.startsWith('@deepseek-ai/')))
const found = new Map()
function scan(dir, depth) {
  try { const p=JSON.parse(readFileSync(join(dir,'package.json'),'utf8')); if(wanted.has(p.name)) found.set(p.name,dir) } catch {}
  if(depth) for(const entry of readdirSync(dir,{withFileTypes:true})) if(entry.isDirectory() && !['node_modules','.git','lib','dist'].includes(entry.name)) scan(join(dir,entry.name),depth-1)
}
for (const directory of ['vendor','packages','apps']) scan(join(root,directory),2)
for(const name of wanted) {
  const target=found.get(name)
  if(!target) throw new Error(`Missing ${name} in DSH_NATIVE_ROOT`)
  const link=join(here,'node_modules',name)
  mkdirSync(dirname(link),{recursive:true})
  rmSync(link,{recursive:true,force:true})
  symlinkSync(target,link,'dir')
}
console.log(`Linked ${wanted.size} native DSH dependencies`)
