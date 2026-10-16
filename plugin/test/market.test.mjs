import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectPlugins, description, installedName, installationState } from '../www/market-model.js'

const fixtures = [
  { name: 'a', owner: 'one', url: 'https://github.com/one/a', category: ['tools', 'git'], stars: 2, downloads: 500, added: '2026-10-01', description: { zh: 'GitHub 工具' } },
  { name: 'b', owner: 'two', url: 'https://github.com/two/b', category: 'tools', stars: 100, downloads: 4, added: '2026-10-11', description: { zh: '视频切片' } },
  { name: 'c', owner: 'three', url: 'https://github.com/three/c', category: 'git', stars: null, downloads: 90, added: 'bad', description: { en: 'GitHub review' } },
]
test('market sorting defaults to actual stars and keeps missing metrics last', () => {
  assert.deepEqual(selectPlugins(fixtures).map(p => p.name), ['b', 'a', 'c'])
  assert.deepEqual(selectPlugins(fixtures, { sort: 'downloads' }).map(p => p.name), ['a', 'c', 'b'])
  assert.deepEqual(selectPlugins(fixtures, { sort: 'added' }).map(p => p.name), ['b', 'a', 'c'])
  assert.deepEqual(fixtures.map(p => p.name), ['a', 'b', 'c'], 'sort never mutates the catalogue')
})
test('Chinese search and multi-category filters combine, missing Chinese is explicit', () => {
  assert.deepEqual(selectPlugins(fixtures, { query: '视频', category: 'tools' }).map(p => p.name), ['b'])
  assert.deepEqual(selectPlugins(fixtures, { query: 'github', category: 'git' }).map(p => p.name), ['a', 'c'])
  assert.match(description(fixtures[2]), /暂未提供中文简介/)
})
test('runtime-only plugins are recognised and same repo basename cannot impersonate installation', () => {
  const plugin = { ...fixtures[0], npm: 'dsh-example' }
  const runtime = [{ moduleName: 'dsh-example', enabled: true, fiberPhase: 'active' }]
  assert.equal(installedName(plugin, {}, runtime), 'dsh-example')
  assert.equal(installationState('dsh-example', {}, runtime), '已启用')
  assert.equal(installedName(fixtures[0], { other: 'https://github.com/other/a' }), null)
  assert.equal(installedName(fixtures[0], { exact: fixtures[0].url }), 'exact')
  assert.equal(installationState('missing', { activation: { missing: { state: 'missing' } } }, []), '配置存在 · 缺少文件')
})
