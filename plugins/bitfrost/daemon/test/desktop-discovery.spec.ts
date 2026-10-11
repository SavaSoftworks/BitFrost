// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only

import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { bundledCodexPaths, desktopCodex, codexProvider } from '../providers/codex.ts'
import { resolveZCode } from '../providers/zcode.ts'
import type { ProviderEnv } from '../provider.ts'

function setEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-desktop-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const write = (file: string, executable = false) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, executable ? '#!/bin/sh\nexit 0\n' : '{}', { mode: executable ? 0o755 : 0o644 })
    return file
  }
  const env = (config = {}, bin: string | null = null): ProviderEnv => ({
    config, runDir: root, dataDir: path.join(root, 'data'), socket: path.join(root, 'socket'),
    log: () => {}, recorder: () => null, resolveBinary: () => bin,
  })
  for (const name of ['BITFROST_CODEX_BIN', 'BITFROST_ZCODE_DIR']) {
    const previous = process.env[name]
    setEnv(name, undefined)
    t.after(() => setEnv(name, previous))
  }
  return { root, write, env }
}

test('desktop Codex discovers the signed macOS CLI without a PATH installation', (t) => {
  const { root, write } = fixture(t)
  const apps = [path.join(root, 'System Applications'), path.join(root, 'User Applications')]
  const bundled = bundledCodexPaths(apps).filter((p) => p.startsWith(root))
  const resources = path.join(apps[1], 'ChatGPT.app', 'Contents', 'Resources')
  const signed = path.join(resources, 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex')
  const wrapper = path.join(resources, 'codex-cli', 'bin', 'codex')
  const nested = path.join(resources, 'codex-cli', 'codex')
  const legacy = path.join(resources, 'codex')
  write(legacy, true)
  write(nested, true)
  write(wrapper, true)
  write(signed, true)
  assert.equal(desktopCodex(root, bundled), signed)
  fs.chmodSync(signed, 0o644)
  assert.equal(desktopCodex(root, bundled), wrapper)
  fs.rmSync(wrapper)
  assert.equal(desktopCodex(root, bundled), nested)
  fs.rmSync(nested)
  assert.equal(desktopCodex(root, bundled), legacy)
  fs.rmSync(legacy)
  fs.mkdirSync(legacy)
  assert.equal(desktopCodex(root, bundled), null, 'a searchable directory is not a CLI')
})

test('Codex still prefers explicit configuration and the standalone CLI', (t) => {
  const { env } = fixture(t)
  const e = env({ bin: '/configured/codex' }, '/standalone/codex')
  setEnv('BITFROST_CODEX_BIN', '/override/codex')
  assert.equal(codexProvider.detect!(e), '/override/codex')
  assert.equal(codexProvider.create(e)!.location, '/override/codex')
  setEnv('BITFROST_CODEX_BIN', undefined)
  assert.equal(codexProvider.detect!(e), '/configured/codex')
  assert.equal(codexProvider.create(e)!.location, '/configured/codex')
  e.config = {}
  assert.equal(codexProvider.detect!(e), '/standalone/codex')
  assert.equal(codexProvider.create(e)!.location, '/standalone/codex')
})

test('ZCode discovers complete macOS bundles and skips incomplete installs', (t) => {
  const { root, write, env } = fixture(t)
  const apps = [path.join(root, 'System Applications'), path.join(root, 'User Applications')]
  write(path.join(apps[0], 'ZCode.app', 'Contents', 'Resources', 'glm', 'zcode.cjs'))
  const location = path.join(apps[1], 'ZCode.app')
  const electron = write(path.join(location, 'Contents', 'MacOS', 'ZCode'), true)
  const cli = write(path.join(location, 'Contents', 'Resources', 'glm', 'zcode.cjs'))
  const builtinProviderConfig = write(path.join(location, 'Contents', 'Resources', 'config', 'provider', 'zcode-builtin.json'))
  const expected = { location, electron, cli, builtinProviderConfig }
  assert.deepEqual(resolveZCode(env(), apps), expected)
  for (const dir of [location, path.join(location, 'Contents'), path.dirname(electron)]) {
    assert.deepEqual(resolveZCode(env({ dir }), []), expected)
  }
  const bin = path.join(root, 'bin', 'zcode')
  fs.mkdirSync(path.dirname(bin))
  fs.symlinkSync(electron, bin)
  assert.deepEqual(resolveZCode(env({}, bin), []), expected)
  fs.rmSync(electron)
  assert.equal(resolveZCode(env({}, bin), apps), null, 'a broken PATH symlink does not crash discovery')
})

test('ZCode retains Linux layouts and explicit override precedence', (t) => {
  const { root, write, env } = fixture(t)
  const install = (location: string) => ({
    location,
    electron: write(path.join(location, 'zcode'), true),
    cli: write(path.join(location, 'resources', 'glm', 'zcode.cjs')),
    builtinProviderConfig: write(path.join(location, 'resources', 'config', 'provider', 'zcode-builtin.json')),
  })
  const configured = install(path.join(root, 'configured'))
  const override = install(path.join(root, 'override'))
  assert.deepEqual(resolveZCode(env({ dir: configured.location }), []), configured)
  setEnv('BITFROST_ZCODE_DIR', override.location)
  assert.deepEqual(resolveZCode(env({ dir: configured.location }), []), override)
  fs.chmodSync(override.electron, 0o644)
  assert.deepEqual(resolveZCode(env({ dir: configured.location }), []), configured)
})

test('ZCode factory uses the macOS executable and resource paths it detected', (t) => {
  const { root, write } = fixture(t)
  const location = path.join(root, 'Applications', 'ZCode.app')
  const electron = write(path.join(location, 'Contents', 'MacOS', 'ZCode'), true)
  const cli = write(path.join(location, 'Contents', 'Resources', 'glm', 'zcode.cjs'))
  const catalog = path.join(location, 'Contents', 'Resources', 'config', 'provider', 'zcode-builtin.json')
  write(catalog)
  fs.writeFileSync(catalog, JSON.stringify({ config: {
    providerConfigRules: { providerRules: [{ providerId: 'account:zai-individual-coding-plan', providerName: 'Coding Plan', config: {
      api: { type: 'anthropic', baseUrl: 'https://example.test' }, builtinModelIds: ['GLM-test'],
    } }] },
    modelConfigRules: { modelRules: [], modelApiRules: [], providerSiteRules: [], builtinProviderModelRules: [] },
  } }))
  const providerURL = new URL('../providers/zcode.ts', import.meta.url).href
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { zcodeProvider } = await import(${JSON.stringify(providerURL)})
    const env = { config: { dir: ${JSON.stringify(location)} }, runDir: process.env.HOME,
      dataDir: process.env.HOME + '/data', socket: process.env.HOME + '/socket',
      log() {}, recorder() { return null }, resolveBinary() { return null } }
    const provider = zcodeProvider.create(env)
    console.log(JSON.stringify({ detected: zcodeProvider.detect(env), location: provider.location,
      watch: provider.watch, models: (await provider.listModels()).map((m) => m.model) }))
  `], { encoding: 'utf8', env: { ...process.env, HOME: root, XDG_DATA_HOME: root, BITFROST_ZCODE_DIR: location } })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { detected: location, location, watch: [electron, cli], models: ['GLM-test'] })
})
