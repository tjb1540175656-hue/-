import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createRequire } from 'node:module';

// No package.json/install required; the distributed JS is an ES module in ST.
const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const { createController, findDraw, safeImageUrl, generateWithSd, META_KEY, install } =
    await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function message(text = '故事前\n<draw>an apple tree, sunset</draw>\n故事后') {
    return { mes: text, is_user: false, swipe_id: 0, extra: { keep: 'user data' },
        swipes: [text], swipe_info: [{ extra: { keep: 'swipe data' } }] };
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function harness(messages = [message()], customGenerate) {
    const tasks = [];
    const statuses = [];
    const calls = [];
    const renders = [];
    const saves = [];
    const settings = { enabled: true };
    let context = { chat: messages, characterId: 1, groupId: null, chatId: 'chat-A',
        updateMessageBlock: (id, msg) => renders.push([id, msg.mes]),
        saveChat: async () => saves.push({ chat: context.chat, text: context.chat.map(m => m.mes) }) };
    const controller = createController({
        getContext: () => context, settings, baseUrl: 'http://phone:8000/',
        status: text => statuses.push(text), defer: fn => tasks.push(fn),
        generate: async (ctx, prompt) => {
            calls.push({ ctx, prompt });
            return customGenerate ? customGenerate(ctx, prompt) : '/user/images/a(b).png';
        },
    });
    function flush() { for (const fn of tasks.splice(0)) fn(); }
    function receive(index = 0, type = 'normal') {
        controller.onStarted(type);
        controller.onReceived(index, type);
        controller.onEnded();
        flush();
    }
    return { controller, settings, tasks, statuses, calls, renders, saves, flush, receive,
        get context() { return context; }, set context(value) { context = value; } };
}

test('extract only first body tag; ignore reasoning, code, empty/oversized/macros/reserved prompts', () => {
    assert.equal(findDraw('<think><draw>secret</draw></think><draw>visible scene</draw>').prompt, 'visible scene');
    assert.equal(findDraw('<think><draw>secret</draw>'), null);
    assert.equal(findDraw('```xml\n<draw>code sample</draw>\n```\n<draw>real scene</draw>').prompt, 'real scene');
    assert.equal(findDraw('`<draw>example</draw>`'), null);
    assert.equal(findDraw('<draw>one scene</draw><draw>two scene</draw>').prompt, 'one scene');
    for (const text of ['', ' '.repeat(3), 'x'.repeat(4001), 'scene', 'BACKGROUND', '{{getvar::key}}', '<draw>nested']) {
        assert.equal(findDraw(`<draw>${text}</draw>`).error, true);
    }
    assert.equal(findDraw('<draw>' + 'x'.repeat(4000) + '</draw>').prompt.length, 4000);
    assert.equal(findDraw('x'.repeat(200001)), null);
});

test('backend URLs accept relative/http(s), escape Markdown, reject executable/scheme-relative/credential paths', () => {
    assert.equal(safeImageUrl('/user/images/a(b).png', 'http://phone:8000'), '/user/images/a%28b%29.png');
    assert.match(safeImageUrl('user/images/a b.png', 'http://phone:8000/'), /a%20b\.png$/);
    assert.match(safeImageUrl('https://images.example/a.png?x=(test)', 'http://phone/'), /^https:\/\//);
    for (const path of ['', undefined, '//evil/a.png', 'javascript:alert(1)', 'data:image/png;base64,AA',
        'file:///a.png', 'https://user:pass@example/a.png', '/a\n.png', '\\evil\\a.png', '#hash']) {
        assert.throws(() => safeImageUrl(path, 'http://phone/'));
    }
    const injected = safeImageUrl('/a.png)![x](javascript:bad)', 'http://phone/');
    assert.ok(!/[()\[\]<>]/.test(injected));
});

test('real /sd registry callback invoked with literal text, never slash parsing or tools', async () => {
    const calls = [];
    const ctx = { SlashCommandParser: { commands: { sd: {
        source: 'stable-diffusion', isThirdParty: false,
        namedArgumentList: ['quiet', 'extend', 'edit'].map(name => ({ name })),
        callback: async (...args) => { calls.push(args); return '/user/images/test.png'; },
    } } }, executeSlashCommandsWithOptions: () => assert.fail('must not parse AI content') };
    const prompt = 'apple | /delete 0 "quotes" \\ and = text';
    assert.equal(await generateWithSd(ctx, prompt), '/user/images/test.png');
    assert.deepEqual(calls, [[{ quiet: 'true', extend: 'false', edit: 'false' }, prompt]]);
    ctx.SlashCommandParser.commands.sd.isThirdParty = true;
    await assert.rejects(generateWithSd(ctx, prompt));
    await assert.rejects(generateWithSd({}, prompt));
});

test('wait for end, persist Markdown and extra/swipe metadata; never use extra.image/media', async () => {
    const m = message();
    const h = harness([m]);
    h.controller.onStarted('normal');
    h.controller.onReceived(0, 'normal');
    h.flush();
    assert.equal(h.calls.length, 0);
    h.controller.onEnded();
    h.flush();
    await h.controller.whenIdle();
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].prompt, 'an apple tree, sunset');
    assert.match(m.mes, /故事前[\s\S]*!\[生成图片\]\(<\/user\/images\/a%28b%29\.png>\)[\s\S]*故事后/);
    assert.ok(!m.mes.includes('<draw>'));
    assert.equal(m.extra[META_KEY].status, 'done');
    assert.equal(m.extra.keep, 'user data');
    assert.equal(m.swipe_info[0].extra.keep, 'swipe data');
    assert.equal(m.swipes[0], m.mes);
    assert.deepEqual(m.swipe_info[0].extra[META_KEY], m.extra[META_KEY]);
    assert.equal(m.extra.image, undefined);
    assert.equal(m.extra.media, undefined);
    assert.equal(h.renders.length, 1);
    assert.equal(h.saves.length, 1);
});

test('end-before-received streaming order works; token events and duplicate endings do not duplicate images', async () => {
    const h = harness();
    h.controller.onStarted('normal');
    h.controller.onEnded();
    h.controller.onReceived(0, 'normal');
    h.controller.onReceived(0, 'normal');
    h.controller.onEnded();
    h.flush();
    await h.controller.whenIdle();
    h.controller.onReceived(0, 'normal');
    h.controller.onEnded();
    h.flush();
    await h.controller.whenIdle();
    assert.equal(h.calls.length, 1);
});

test('ignore history/greetings/extension messages, users, systems, disabled setting, and reasoning-only tags', async () => {
    const h = harness();
    h.controller.onReceived(0, 'normal');
    h.controller.onEnded();
    h.flush();
    await h.controller.whenIdle();
    for (const type of ['first_message', 'extension', 'command']) {
        h.receive(0, type);
        await h.controller.whenIdle();
    }
    for (const m of [{ ...message(), is_user: true }, { ...message(), is_system: true },
        { ...message('normal body'), extra: { reasoning: '<draw>hidden</draw>' } }]) {
        h.context.chat = [m];
        h.receive();
        await h.controller.whenIdle();
    }
    h.settings.enabled = false;
    h.context.chat = [message()];
    h.receive();
    await h.controller.whenIdle();
    assert.equal(h.calls.length, 0);
});

test('one image even with two tags, continuation or repeated manual click', async () => {
    const m = message('<draw>first scene</draw> story <draw>second scene</draw>');
    const h = harness([m]);
    h.receive();
    await h.controller.whenIdle();
    assert.ok(m.mes.includes('<draw>second scene</draw>'));
    h.controller.retryLast();
    h.receive(0, 'continue');
    await h.controller.whenIdle();
    assert.equal(h.calls.length, 1);
});

test('global queue is serial and locks each message during generation', async () => {
    const first = deferred();
    let active = 0;
    let peak = 0;
    const h = harness([message(), message('<draw>a mountain at dawn</draw>')], async () => {
        active++;
        peak = Math.max(peak, active);
        if (h.calls.length === 1) await first.promise;
        active--;
        return '/user/images/result.png';
    });
    h.controller.onStarted('normal');
    h.controller.onReceived(0, 'normal');
    h.controller.onReceived(1, 'normal');
    h.controller.onEnded();
    h.flush();
    h.controller.retryLast();
    assert.equal(h.calls.length, 1);
    first.resolve();
    await h.controller.whenIdle();
    assert.equal(h.calls.length, 2);
    assert.equal(peak, 1);
});

test('failures retain marker, redact raw errors, do not auto retry, and allow explicit retry', async () => {
    let shouldFail = true;
    const m = message();
    const original = m.mes;
    const h = harness([m], async () => {
        if (shouldFail) throw new Error('secret API_KEY prompt=private');
        return '/user/images/retry.png';
    });
    h.receive();
    await h.controller.whenIdle();
    assert.equal(m.mes, original);
    assert.equal(m.extra[META_KEY].status, 'failed');
    assert.ok(!h.statuses.join().includes('secret'));
    h.receive();
    await h.controller.whenIdle();
    assert.equal(h.calls.length, 1);
    shouldFail = false;
    h.controller.retryLast();
    h.controller.retryLast();
    await h.controller.whenIdle();
    assert.equal(h.calls.length, 2);
    assert.ok(!m.mes.includes('<draw>'));
});

test('empty/unsafe backend results behave like failures with marker untouched', async () => {
    for (const value of ['', undefined, 'javascript:alert(1)', '//bad/a.png']) {
        const m = message();
        const text = m.mes;
        const h = harness([m], async () => value);
        h.receive();
        await h.controller.whenIdle();
        assert.equal(m.mes, text);
        assert.equal(m.extra[META_KEY].status, 'failed');
    }
});

for (const scenario of ['chat', 'away-and-back', 'swipe', 'swipe-away-and-back', 'delete', 'edit', 'disable', 'stop', 'same-id-new-character']) {
    test(`discard in-flight result safely: ${scenario}`, async () => {
        const pending = deferred();
        const m = message();
        const text = m.mes;
        const h = harness([m], () => pending.promise);
        h.receive();
        assert.equal(h.calls.length, 1);
        const old = h.context;
        switch (scenario) {
            case 'chat':
                h.context = { ...old, chat: [message('other chat')], chatId: 'chat-B' };
                h.controller.onChanged();
                break;
            case 'away-and-back':
                h.context = { ...old, chat: [], chatId: 'chat-B' };
                h.controller.onChanged();
                h.context = old;
                h.controller.onChanged();
                break;
            case 'swipe': m.swipe_id = 1; h.controller.onMutated(); break;
            case 'swipe-away-and-back':
                m.swipe_id = 1; h.controller.onMutated(); m.swipe_id = 0; break;
            case 'delete': old.chat.splice(0, 1); h.controller.onMutated(); break;
            case 'edit': m.mes = 'user edited'; h.controller.onMutated(); break;
            case 'disable': h.settings.enabled = false; h.controller.onEnabledChanged(); break;
            case 'stop': h.controller.onStopped(); break;
            case 'same-id-new-character': h.context = { ...old, characterId: 99 }; break;
        }
        pending.resolve('/user/images/late.png');
        await h.controller.whenIdle();
        assert.equal(m.mes, scenario === 'edit' ? 'user edited' : text);
        assert.equal(h.saves.length, 0);
        assert.equal(h.renders.length, 0);
    });
}

test('queued jobs do not run after chat switch', async () => {
    const pending = deferred();
    const h = harness([message(), message('<draw>other scene</draw>')], () => pending.promise);
    h.controller.onStarted('normal');
    h.controller.onReceived(0, 'normal');
    h.controller.onReceived(1, 'normal');
    h.controller.onEnded();
    h.flush();
    h.context = { ...h.context, chat: [], chatId: 'chat-B' };
    h.controller.onChanged();
    pending.resolve('/user/images/late.png');
    await h.controller.whenIdle();
    assert.equal(h.calls.length, 1);
    assert.equal(h.saves.length, 0);
});

test('other extension display cache remains untouched, no wasted generation', async () => {
    const m = message();
    m.extra.display_text = 'other extension cache';
    const h = harness([m]);
    h.receive();
    await h.controller.whenIdle();
    assert.equal(h.calls.length, 0);
    assert.equal(m.extra.display_text, 'other extension cache');
});

test('new swipe can generate without inheriting old swipe done state', async () => {
    const m = message();
    const h = harness([m]);
    h.receive();
    await h.controller.whenIdle();
    const firstText = m.mes;
    m.swipe_id = 1;
    m.mes = '<draw>a new scene with birds</draw>';
    m.swipes.push(m.mes);
    m.swipe_info.push({ extra: {} });
    h.controller.onMutated();
    h.receive(0, 'swipe');
    await h.controller.whenIdle();
    assert.equal(h.calls.length, 2);
    assert.equal(m.swipes[0], firstText);
    assert.equal(m.swipe_info[0].extra[META_KEY].swipe, 0);
    assert.equal(m.swipe_info[1].extra[META_KEY].swipe, 1);
});

test('deleting an older swipe and reindexing cannot create a second image in an already illustrated version', async () => {
    const m = message('<draw>first scene</draw> story <draw>second scene</draw>');
    m.swipe_id = 1;
    m.swipes.unshift('older swipe');
    m.swipe_info.unshift({ extra: {} });
    const h = harness([m]);
    h.receive();
    await h.controller.whenIdle();
    m.swipes.shift();
    m.swipe_info.shift();
    m.swipe_id = 0;
    h.controller.onMutated();
    h.controller.retryLast();
    await h.controller.whenIdle();
    assert.equal(h.calls.length, 1);
});

test('render/save exceptions restore marker, without deleting unrelated data', async () => {
    const m = message();
    const text = m.mes;
    const h = harness([m]);
    h.context.saveChat = async () => { throw new Error('private backend details'); };
    h.receive();
    await h.controller.whenIdle();
    assert.equal(m.mes, text);
    assert.equal(m.swipes[0], text);
    assert.equal(m.extra.keep, 'user data');
    assert.equal(m.extra[META_KEY].status, 'failed');
});

test('continuation started before its first token invalidates an older in-flight image', async () => {
    const pending = deferred();
    const m = message();
    const original = m.mes;
    const h = harness([m], () => pending.promise);
    h.receive();
    h.controller.onStarted('continue');
    pending.resolve('/user/images/late.png');
    await Promise.resolve();
    h.controller.onEnded();
    h.flush();
    await h.controller.whenIdle();
    assert.equal(m.mes, original);
    assert.equal(h.saves.length, 0);
});

test('failed marker metadata survives a controller/page reload and requires manual retry', async () => {
    const m = message();
    const h = harness([m], async () => '');
    h.receive();
    await h.controller.whenIdle();
    const reloaded = JSON.parse(JSON.stringify(m));
    const second = harness([reloaded]);
    second.receive();
    await second.controller.whenIdle();
    assert.equal(second.calls.length, 0);
    second.controller.retryLast();
    await second.controller.whenIdle();
    assert.equal(second.calls.length, 1);
});

// Optional source-contract check: executes the REAL host functions with a mocked
// request that returns a local path. No HTTP, GPU, /prompt or server startup.
const stRoot = process.env.ST_SOURCE_ROOT;
test('source contract: real 1.18.0 /sd quiet callback returns path, posts no message, restores overrides',
    { skip: !stRoot }, async () => {
        const sd = await readFile(`${stRoot}/public/scripts/extensions/stable-diffusion/index.js`, 'utf8');
        const fn = name => {
            const start = sd.search(new RegExp(`(?:async )?function ${name}\\(`));
            assert.ok(start >= 0, `source function ${name}`);
            return sd.slice(start, sd.indexOf('\n}', start) + 2);
        };
        const start = sd.indexOf('callback: async (args, trigger) => {', sd.indexOf("name: 'imagine'"));
        const callback = sd.slice(start + 'callback: '.length, sd.indexOf('\n        },', start) + '\n        }'.length);
        let posted = 0;
        const settings = { free_extend: true, refine_mode: true, height: 768, width: 512,
            prompts: {}, character_prompts: {}, character_negative_prompts: {} };
        const mode = { FREE: 0, CHARACTER: 1, USER: 2, SCENARIO: 3, RAW_LAST: 4,
            NOW: 5, FACE: 6, BACKGROUND: 7, FREE_EXTENDED: 11 };
        let generatedPrompt;
        const sandbox = {
            console: { log() {}, trace() {}, error() {} },
            extension_settings: { sd: settings },
            defaultSettings: { free_extend: false, refine_mode: false },
            generationMode: mode, triggerWords: { 1: ['you'], 2: ['me'], 3: ['scene'], 4: ['raw_last'],
                5: ['last'], 6: ['face'], 7: ['background'] }, multimodalMap: {},
            isTrueBoolean: x => String(x) === 'true', isFalseBoolean: x => String(x) === 'false',
            isValidState: () => true, ensureSelectionExists() {}, saveSettingsDebounced() {},
            getContext: () => ({ characterId: 0, characters: [{ name: 'Test' }], chat: [] }),
            initiators: { command: 'command' }, MODULE_NAME: 'sd',
            eventSource: { emit: async () => {} }, event_types: { SD_PROMPT_PROCESSING: 'sd' },
            loader: { show: () => ({ hide: async () => {} }) }, ActionLoaderHandle: { EMPTY: {} },
            t: strings => strings.join(''), AbortController,
            setTypeSpecificDimensions: () => ({ height: 768, width: 512 }),
            restoreOriginalDimensions() {},
            sendMessage: async () => { posted++; },
            refinePrompt: () => assert.fail('edit=false must avoid prompt editor'),
            generatePrompt: () => assert.fail('extend=false/free prompt must avoid LLM'),
            sendGenerationRequest: async (type, prompt, negative, character, cb) => {
                assert.equal(type, mode.FREE);
                generatedPrompt = prompt;
                if (cb) await cb(prompt, '/user/images/mock.png');
                else posted++;
                return '/user/images/mock.png';
            },
        };
        const code = ['applyCommandArguments', 'generatePicture', 'getGenerationType', 'getQuietPrompt',
            'getPrompt', 'generateFreeModePrompt'].map(fn).join('\n') + `\n(${callback})`;
        const actualCallback = vm.runInNewContext(code, sandbox);
        const result = await actualCallback({ quiet: 'true', extend: 'false', edit: 'false' },
            'apple | /delete 0 literal');
        assert.equal(result, '/user/images/mock.png');
        assert.equal(generatedPrompt, 'apple | /delete 0 literal');
        assert.equal(posted, 0);
        assert.equal(settings.free_extend, true);
        assert.equal(settings.refine_mode, true);
    });

test('actual host Markdown engine renders portable image at the marker position', { skip: !stRoot }, () => {
    const require = createRequire(`${stRoot}/package.json`);
    const showdown = require('showdown');
    const converter = new showdown.Converter();
    const url = safeImageUrl('/user/images/a(b).png', 'http://phone:8000/');
    const html = converter.makeHtml(`before\n\n![生成图片](<${url}>)\n\nafter`);
    assert.match(html, /<img src="\/user\/images\/a%28b%29\.png" alt="生成图片"/);
    assert.ok(html.indexOf('before') < html.indexOf('<img'));
    assert.ok(html.indexOf('after') > html.indexOf('<img'));
});

test('settings UI initializes once, binds real event names, toggles settings and safely disables missing APIs', () => {
    const original = { document: globalThis.document, SillyTavern: globalThis.SillyTavern, location: globalThis.location };
    function fakeDocument() {
        const ids = new Map();
        function element() {
            return { children: [], style: {}, handlers: {}, textContent: '',
                set id(value) { this._id = value; ids.set(value, this); }, get id() { return this._id; },
                append(...nodes) { this.children.push(...nodes); },
                setAttribute() {}, addEventListener(name, fn) { this.handlers[name] = fn; } };
        }
        const container = element();
        container.id = 'extensions_settings';
        return { getElementById: id => ids.get(id), createElement: element,
            createTextNode: text => ({ textContent: text }), container };
    }
    try {
        const doc = fakeDocument();
        globalThis.document = doc;
        globalThis.location = { href: 'http://phone:8000/' };
        const listeners = new Map();
        let saved = 0;
        const names = ['GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'MESSAGE_RECEIVED',
            'CHAT_CHANGED', 'MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED', 'MESSAGE_SWIPE_DELETED'];
        const context = { chat: [], extensionSettings: {}, eventTypes: Object.fromEntries(names.map(name => [name, name.toLowerCase()])),
            eventSource: { on: (name, fn) => listeners.set(name, fn) }, saveChat: async () => {},
            updateMessageBlock() {}, saveSettingsDebounced: () => saved++ };
        globalThis.SillyTavern = { getContext: () => context };
        install();
        install();
        assert.equal(doc.container.children.length, 1);
        assert.equal(listeners.size, names.length);
        const panel = doc.getElementById('draw_inline_settings');
        const checkbox = panel.children[1].children[0];
        assert.equal(checkbox.checked, true);
        checkbox.checked = false;
        checkbox.handlers.change();
        assert.equal(context.extensionSettings.draw_inline.enabled, false);
        assert.equal(saved, 1);
        assert.ok(panel.children[3].textContent.includes('关闭'));
        const second = fakeDocument();
        globalThis.document = second;
        globalThis.SillyTavern = { getContext: () => ({}) };
        install();
        const incompatible = second.getElementById('draw_inline_settings');
        assert.equal(incompatible.children[1].children[0].disabled, true);
        assert.equal(incompatible.children[2].disabled, true);
        assert.ok(incompatible.children[3].textContent.includes('安全停用'));
    } finally {
        for (const [key, value] of Object.entries(original)) {
            if (value === undefined) delete globalThis[key];
            else globalThis[key] = value;
        }
    }
});
