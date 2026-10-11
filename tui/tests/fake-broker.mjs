// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

import {appendFileSync} from 'node:fs';
import readline from 'node:readline';

import {settingsOf} from '../../plugins/bitfrost/daemon/tui-rpc.ts';

let revision = 'a'.repeat(64);
let generation = 0;
const discovered = new Set();
const timers = new Set();
const usage = new Map();
const notified = new Set();
let statsTimer = null;
let subagentsTimer = null;
let watchedAgents = null;
let settingsNotified = false;
let newSettings = Boolean(process.env.BITFROST_FAKE_NEW_SETTINGS);
function configurationPlan(draft = {})
{
    const answers = {};
    const steps = [
        ['previewAppearance', 'Preview appearance', ['Classic', 'Compact', 'Spacious']],
        ['previewNotifications', 'Preview notifications', ['None', 'Important only', 'All activity']],
        ['previewHistory', 'Preview history', ['By day', 'By project', 'By model']],
        ['previewStartup', 'Preview startup', ['Home', 'Models', 'Sessions']],
    ].map(([feature, title, choices]) => {
        const value = draft[feature]?.choice ?? choices[0];
        answers[feature] = {choice : value};
        return {feature, key : 'choice', title, label : title, prompt : 'Which option would you prefer?',
                help : 'Test setting only. This choice does not change BitFrost behavior.', value,
                options : choices.map(value => ({value, label : value}))};
    });
    return {revision, answers, steps : newSettings ? steps : []};
}
let agentStamp = 1;
let watchTicks = 0;
const startedAt = Date.now() - 3 * 3600000;
const sampleNow = Date.now();
function earlierDay(days)
{
    const date = new Date(sampleNow);
    date.setDate(date.getDate() - days);
    date.setHours(12, 0, 0, 0);
    return date.getTime();
}
function subagent(index, createdAt, running = false)
{
    return {
        id : 'subagent-' + index,
        harness : index % 2 ? 'codex' : 'opencode',
        harnessName : index % 2 ? 'Codex' : 'OpenCode',
        agent : index === 2 ? 'reviewer' : 'coding-agent-' + index,
        model : index % 2 ? 'gpt-6.1-sol' : 'kimi-k2.7-code',
        effort : 'high',
        title : index === 2 ? null
                : running   ? 'Build Status page'
                            : 'Review configuration ' + index,
        state : running ? 'running' : 'closed',
        running,
        createdAt,
        closedAt : running ? null : createdAt + (62 + index * 7) * 1000,
        closeReason : running ? null : 'completed',
        activeMs : (40 + index * 5) * 1000,
        turnStartedAt : running ? Date.now() - 12000 : null,
        tokens : 25620 + index * 3100,
        cachedTokens : 7200,
        turns : 4 + index,
        toolCalls : 6 + index,
        changedAt : agentStamp,
    };
}
const runningSubagents = [ subagent(1, sampleNow - 17000, true), subagent(2, sampleNow - 93000, true) ];
const dayOffsets = [ 0, 0, 1, 1, 2, 3, 5, 6, 7, 9, 12, 13, 14, 21, 45 ];
const earlierSubagents = Array
                             .from({length : 4998},
                                   (_, index) => {
                                       const day = index < 38 ? dayOffsets[index % dayOffsets.length] : 46 + index;
                                       return subagent(index + 3, day ? earlierDay(day) - index * 600000
                                                                      : sampleNow - 600000 - index * 600000);
                                   })
                             .sort((left, right) => right.createdAt - left.createdAt);
const allSubagents = [...runningSubagents, ...earlierSubagents].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
function cursor(row)
{
    return `${row.createdAt}:${row.id}`;
}
function compareCursor(row, key)
{
    const split = key.indexOf(':');
    return row.createdAt - Number(key.slice(0, split)) || row.id.localeCompare(key.slice(split + 1));
}
function agentPage(params)
{
    const limit = Math.max(1, Math.min(500, Math.floor(Number(params.limit) || 50)));
    let candidates = allSubagents;
    const reverse = Boolean(params.after || params.oldest);
    if (params.before)
        candidates = candidates.filter(row => compareCursor(row, params.before) < 0);
    if (params.after)
        candidates = candidates.filter(row => compareCursor(row, params.after) > 0);
    return {now : Date.now(), rows : reverse ? candidates.slice(-limit) : candidates.slice(0, limit), more : candidates.length > limit, total : allSubagents.length};
}
function overview()
{
    return {now : Date.now(), running : runningSubagents, recent : earlierSubagents.slice(0, 10)};
}
function watchSubagents(params)
{
    watchedAgents = params;
    if (subagentsTimer)
        return;
    subagentsTimer = setInterval(() => {
        const running = runningSubagents[0];
        if (watchedAgents.ids.includes(running.id))
        {
            running.tokens += 12300;
            running.toolCalls += 1;
            running.changedAt = ++agentStamp;
        }
        if (watchedAgents.top && ++watchTicks % 3 === 0)
        {
            const row = subagent(5000 + watchTicks, Date.now());
            row.changedAt = ++agentStamp;
            allSubagents.unshift(row);
            earlierSubagents.unshift(row);
        }
        const rows = allSubagents.filter(row => watchedAgents.ids.includes(row.id) && row.changedAt > (watchedAgents.since || 0));
        const newer = watchedAgents.top ? allSubagents.filter(row => compareCursor(row, watchedAgents.top) > 0).slice(0, 50) : [];
        if (rows.length || newer.length)
            emit({method : 'subagents.changed', params : {now : Date.now(), rows, newer}});
        watchedAgents.since = agentStamp;
    }, 2000);
    timers.add(subagentsTimer);
}
const today = new Date();
today.setUTCHours(0, 0, 0, 0);
const providers = [ 'codex', 'zcode', 'opencode', 'omp', 'gemini', 'crush' ].map(
    (id, index) => ({
        id,
        displayName : [ 'Codex', 'ZCode', 'OpenCode', 'OhMyPi', 'Gemini', 'Crush' ][index],
        detected : index !== 1,
        location : index === 1 ? null : '/usr/bin/' + id,
        enabled : index !== 5,
        optIn : index === 5,
        running : index !== 1 && index !== 5,
        mode : [ 'opencode', 'omp', 'crush' ].includes(id) ? 'allow' : 'deny',
    }));
const modelIds = [
    'opencode-go/deepseek-v4.1-flash', 'opencode-go/kimi-k2.7-code', 'opencode-go/glm-5.2',
    'opencode-go/glm-5', 'opencode-go/glm-4.7-flash', 'neuralwatt/glm-5.3', 'neuralwatt/glm-5.3-flash'
];
const modelMap = new Map(providers.map(
    p => [p.id, modelIds.map((model, i) => ({
                                 model : p.id === 'opencode' ? model
                                         : p.id === 'codex' && i >= 5 ? 'neuralwatt/model-' + (i + 1)
                                         : p.id + '/model-' + (i + 1),
                                 displayName : [
                                     'DeepSeek V4.1', 'Kimi K2.7', 'GLM 5.2', 'GLM 5', 'GLM 4.7', 'GLM 5.3',
                                     'GLM Flash'
                                 ][i],
                                 company : 'Example',
                                 description : 'A capable coding model',
                                 efforts : [ 'low', 'high' ],
                                 defaultEffort : 'high',
                                 isDefault : i === 0,
                                 enabled : i !== 5,
                                 offered : i !== 5,
                                 reason : i === 5 ? 'not_listed' : null,
                                 agent : i === 5 ? null : 'model-' + i,
                             }))]));
modelMap.get('opencode')
    .push(
        {
            ...modelMap.get('opencode')[0],
            model : 'opencode/claude-haiku-5-5',
            displayName : 'Claude Haiku',
            enabled : true,
            offered : false,
            reason : 'anthropic',
            agent : null
        },
        {
            ...modelMap.get('opencode')[0],
            model : 'opencode/claude-test',
            displayName : 'Claude Test',
            enabled : true,
            offered : false,
            reason : 'anthropic',
            agent : null
        },
    );
modelMap.get('opencode').push(...Array.from({length : 40}, (_, index) => ({
                                                               ...modelMap.get('opencode')[0],
                                                               model : 'opencode/page-model-' + (index + 1),
                                                               displayName : 'Page Model ' + (index + 1),
                                                           })));
for (const model of modelMap.get('gemini'))
{
    model.enabled = false;
    model.offered = false;
    model.reason = 'disabled';
}
// The real Settings page, built from sample answers, so this never drifts from it.
const sections = await settingsOf({
    allowedProfiles : [ '~/.claude', '~/.claude-work' ],
    handback : {enabled : true, model : 'sonnet', effort : 'low'},
    providers : {opencode : {enabled : true}},
}, {codex : '/usr/local/bin/codex', zcode : '/opt/ZCode', opencode : null,
    omp : '/usr/local/bin/pi', gemini : '/usr/local/bin/gemini', crush : null},
    newSettings ? '0.9.2' : '0.9.1');
function totals(sessions, turns, tokens)
{
    return {
        sessions,
        closedSessions : Math.max(0, sessions - 1),
        sessionMs : Math.max(0, sessions - 1) * 62 * 60000,
        turns,
        failedTurns : 1,
        requests : turns * 2,
        inputTokens : tokens * 0.8,
        outputTokens : tokens * 0.2,
        cachedTokens : tokens * 0.3,
        turnMs : turns * 17000
    };
}
function statsRows(provider)
{
    if (!usage.has(provider))
    {
        usage.set(provider,
                  (modelMap.get(provider) ?? [])
                      .filter(m => m.model !== 'opencode/page-model-40')
                      .map((m, i) => ({
                               model : m.model,
                               today : totals(2, 6, 96000),
                               total : totals(12 + i, 42 + i, 1500000 + i * 1000),
                               week : totals(4, 12, 350000),
                               month : totals(7, 56, 256200),
                               hourly : Array.from({length : 24},
                                                   (_, hour) => ({hour, tokens : (hour % 6) * 1600})),
                               daily : Array.from({length : 366},
                                                  (_, day) => ({
                                                      day : new Date(today.getTime() - (365 - day) * 86400000)
                                                                .toISOString()
                                                                .slice(0, 10),
                                                      sessions : day % 4,
                                                      tokens : ((day * 7 + i * 3) % 11) * 13000
                                                  })),
                               firstUsedAt : 1759000000000,
                               lastUsedAt : 1791500000000,
                           })));
    }
    return usage.get(provider);
}
function watchStats(provider, rows)
{
    if (statsTimer)
    {
        clearTimeout(statsTimer);
        timers.delete(statsTimer);
        statsTimer = null;
    }
    const key = provider + ':' + rows[0]?.model;
    if (notified.has(key) || !rows.length || rows[0].firstUsedAt === null)
        return;
    const timer = setTimeout(() => {
        timers.delete(timer);
        statsTimer = null;
        notified.add(key);
        for (const period of ['today', 'total', 'week', 'month'])
            rows[0][period].inputTokens += 256200;
        rows[0].hourly[12].tokens += 256200;
        rows[0].daily.at(-1).tokens += 256200;
        emit({method : 'stats.updated', params : {provider, rows}});
    }, 3000);
    statsTimer = timer;
    timers.add(timer);
}
function result(method, params)
{
    const provider = providers.find(p => p.id === params.provider);
    switch (method)
    {
    case 'hello':
        return {
            protocol : 1,
            version : '0.9.1',
            configPath : '/tmp/bitfrost-fake-config.json',
            revision,
            configError : null,
            settingsUpToDate : !newSettings,
            daemon : {up : true}
        };
    case 'providers.list':
        return {providers};
    case 'status.get':
        return {
            version : '0.9.1',
            pid : 4242,
            startedAt,
            socket : '/tmp/bitfrost-fake.sock',
            config : '/tmp/bitfrost-fake-config.json',
            configError : null,
            providers :
                providers.filter(p => p.running).map(p => ({
                                                         id : p.id,
                                                         location : p.location,
                                                         models :
                                                             modelMap.get(p.id).filter(m => m.offered).length
                                                     })),
            registryAt : sampleNow - 90000,
            leases : [
                {id : 'lease-1', host : 'workstation', profile : 'nick', expiresInMs : 65000},
                {id : 'lease-2', host : 'laptop', profile : 'review', expiresInMs : 42000}
            ],
            sessions : [],
        };
    case 'subagents.overview':
        return overview();
    case 'subagents.page':
        return agentPage(params);
    case 'subagents.watch':
        watchSubagents(params);
        return {ok : true};
    case 'unwatch':
    {
        const timer = params.what === 'subagents' ? subagentsTimer : statsTimer;
        if (timer)
        {
            clearTimeout(timer);
            timers.delete(timer);
        }
        if (params.what === 'subagents')
        {
            subagentsTimer = null;
            watchedAgents = null;
        }
        else if (params.what === 'stats')
            statsTimer = null;
        return {ok : true};
    }
    case 'models.list':
    {
        if (!provider)
            throw {code : 'unknown_provider', message : 'Unknown provider'};
        if (!provider.detected || !provider.enabled)
            return {
                provider : provider.id,
                at : 0,
                pending : false,
                error : provider.detected ? 'Provider is disabled' : 'App not detected on this machine',
                models : []
            };
        if (!discovered.has(provider.id))
        {
            discovered.add(provider.id);
            const timer = setTimeout(() => {
                timers.delete(timer);
                emit({method : 'models.updated', params : {provider : provider.id}});
            }, 100);
            timers.add(timer);
            return {provider : provider.id, at : 0, pending : true, error : null, models : []};
        }
        return {
            provider : provider.id,
            at : Date.now(),
            pending : false,
            error : null,
            models : modelMap.get(provider.id)
        };
    }
    case 'models.stats':
    {
        if (!params.model)
            throw {code : 'bad_request', message : 'models.stats needs a model'};
        const row = statsRows(params.provider).find(row => row.model === params.model);
        const zero = {
            sessions : 0, closedSessions : 0, sessionMs : 0, turns : 0, failedTurns : 0, requests : 0,
            inputTokens : 0, outputTokens : 0, cachedTokens : 0, turnMs : 0
        };
        const rows = [row ?? {
            model : params.model, today : zero, total : zero, week : zero, month : zero,
            daily : Array.from({length : 30}, (_, day) => ({
                day : new Date(today.getTime() - (29 - day) * 86400000).toISOString().slice(0, 10),
                sessions : 0, tokens : 0
            })),
            hourly : Array.from({length : 24}, (_, hour) => ({hour, tokens : 0})),
            firstUsedAt : null, lastUsedAt : null
        }];
        watchStats(params.provider, rows);
        return {rows};
    }
    case 'settings.pending':
        return configurationPlan(params.answers);
    case 'settings.configure':
        newSettings = false;
        revision = (++generation).toString(16).padStart(64, '0');
        return {ok : true, revision, warnings : []};
    case 'settings.get':
        if (!settingsNotified)
        {
            settingsNotified = true;
            const timer = setTimeout(() => {
                timers.delete(timer);
                const item = sections.flatMap(section => section.items).find(item => item.key === 'providers.codex.bin');
                if (item)
                    item.found = '/opt/detected/bin/codex';
                emit({method : 'settings.updated', params : {}});
            }, 1000);
            timers.add(timer);
        }
        return {revision, settingsUpToDate : !newSettings, sections};
    case 'update.check':
        return {current : process.env.BITFROST_PRETEND_VERSION || '0.9.2', latest : '0.9.2',
                available : Boolean(process.env.BITFROST_PRETEND_VERSION), error : null};
    case 'update.run':
    {
        // The sample broker never installs anything; every update here is simulated.
        const version = params.version;
        const platform = process.platform === 'darwin' ? 'darwin-universal'
                       : process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
        const steps = [
            {label : 'Release', detail : `bitfrost-${version}.tar.gz`},
            {label : 'Checksum', detail : `bitfrost-${version}.tar.gz`},
            {label : 'Unpacked', detail : `~/.local/share/bitfrost/versions/${version}`},
            {label : 'BitFrost TUI', detail : `bitfrost-tui-${version}-${platform}`},
            {label : 'Command', detail : '~/.local/bin/bitfrost'},
            {label : 'Kept your config', detail : '~/.config/bitfrost/config.json'},
            {label : 'Claude Code plugin', detail : 'bitfrost@bitfrost in ~/.claude'},
            {label : 'Helper', detail : 'restarted'},
        ];
        let index = 0;
        const advance = () => {
            if (index === steps.length)
            {
                emit({method : 'update.finished', params : {ok : true, version, simulated : true}});
                return;
            }
            const step = {index, total : steps.length, ...steps[index]};
            emit({method : 'update.step', params : {...step, state : 'running'}});
            const timer = setTimeout(() => {
                timers.delete(timer);
                emit({method : 'update.step', params : {...step, state : 'done'}});
                ++index;
                advance();
            }, 450 + (index % 3) * 450 * 0.6);
            timers.add(timer);
        };
        advance();
        return {ok : true, steps : steps.length, simulated : true};
    }
    case 'providers.set':
    case 'models.set':
    case 'settings.set':
    {
        if (params.revision !== revision)
            throw {code : 'conflict', message : 'Config changed; reload before saving'};
        if (method === 'providers.set')
        {
            if (!provider)
                throw {code : 'unknown_provider', message : 'Unknown provider'};
            provider.enabled = params.enabled;
        }
        else if (method === 'models.set')
        {
            const m = (modelMap.get(params.provider) ?? []).find(v => v.model === params.model);
            if (!m)
                throw {code : 'bad_request', message : 'Unknown model'};
            m.enabled = params.enabled;
            m.offered = params.enabled;
            m.reason = params.enabled ? null : 'disabled';
        }
        else
        {
            const item = sections.flatMap(s => s.items).find(v => v.key === params.key);
            if (!item)
                throw {code : 'unknown_key', message : 'Unknown setting'};
            if (item.type === 'number' && (typeof params.value !== 'number' || params.value < item.min))
                throw {code : 'config_invalid', message : 'Value is below the minimum'};
            item.value = params.value;
        }
        revision = (++generation).toString(16).padStart(64, '0');
        return {ok : true, revision, warnings : []};
    }
    default:
        throw {code : 'bad_request', message : 'Unknown method'};
    }
}
function emit(message)
{
    if (process.env.BITFROST_FAKE_EVENT_LOG)
        appendFileSync(process.env.BITFROST_FAKE_EVENT_LOG, JSON.stringify(message) + '\n');
    process.stdout.write(JSON.stringify(message) + '\n');
}
const input = readline.createInterface({input : process.stdin, crlfDelay : Infinity});
input.on('line', line => {
    let request;
    try
    {
        request = JSON.parse(line);
        if (process.env.BITFROST_FAKE_LOG)
            appendFileSync(process.env.BITFROST_FAKE_LOG, line + '\n');
        emit({id : request.id, result : result(request.method, request.params ?? {})});
    }
    catch (error)
    {
        emit({
            id : request?.id ?? null,
            error : {code : error.code ?? 'internal', message : error.message ?? 'Fake broker error'}
        });
    }
});
input.on('close', () => {
    for (const timer of timers)
        clearTimeout(timer);
    if (process.env.BITFROST_FAKE_EVENT_LOG)
        appendFileSync(process.env.BITFROST_FAKE_EVENT_LOG, JSON.stringify({method : 'fake.closed'}) + '\n');
});
