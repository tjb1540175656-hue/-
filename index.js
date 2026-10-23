// No tool registration, remote dependencies, direct ComfyUI requests, or prompt execution.
export const SETTINGS_KEY = 'draw_inline';
export const META_KEY = 'draw_inline';
export const MAX_PROMPT = 4000;
const RESERVED = /^(you|me|scene|raw_last|last|face|background)$/i;

export function hashText(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    }
    return (hash >>> 0).toString(16);
}

// Keep offsets identical to the original text. Never scan extra.reasoning.
export function findDraw(text) {
    if (typeof text !== 'string' || text.length > 200000) return null;
    const hidden = text
        .replace(/<(think|thinking|analysis|reasoning)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, s => ' '.repeat(s.length))
        .replace(/(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\1[^\n]*(?:\n|$)|$)/g, s => ' '.repeat(s.length))
        .replace(/`[^`\n]*`/g, s => ' '.repeat(s.length));
    const match = /<draw>([\s\S]*?)<\/draw>/i.exec(hidden);
    if (!match) return null;
    const raw = text.slice(match.index, match.index + match[0].length);
    const prompt = raw.slice(6, -7).trim();
    if (!prompt || prompt.length > MAX_PROMPT || /<\/?draw\b/i.test(prompt)
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(prompt)
        || /\{\{|\}\}/.test(prompt) || RESERVED.test(prompt)) {
        return { error: true };
    }
    return { index: match.index, raw, prompt, drawHash: hashText(prompt) };
}

export function safeImageUrl(value, baseUrl) {
    if (typeof value !== 'string' || !value.trim() || value.length > 8192) throw new Error('invalid-url');
    const raw = value.trim();
    if (/[\u0000-\u001f\u007f\\]/.test(raw) || raw.startsWith('//') || raw.startsWith('#')
        || (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https?:\/\//i.test(raw))) {
        throw new Error('invalid-url');
    }
    const url = new URL(raw, baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid-url');
    // Angle-bracket Markdown destination + escaped delimiters; no AI text in alt/title.
    const portable = url.origin === new URL(baseUrl).origin ? url.pathname + url.search + url.hash : url.href;
    return portable.replace(/[()\[\]<>"']/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

// Invoke the EXISTING registered /sd callback, not a parsed command string.
// Verified against SillyTavern 1.18.0 stable-diffusion/index.js:5492-5525.
export async function generateWithSd(context, prompt) {
    const command = context.SlashCommandParser?.commands?.sd;
    const args = command?.namedArgumentList?.map(arg => arg.name) ?? [];
    if (typeof command?.callback !== 'function' || command.isThirdParty === true
        || command.source !== 'stable-diffusion'
        || !['quiet', 'extend', 'edit'].every(name => args.includes(name))) {
        throw new Error('sd-unavailable');
    }
    // These are temporary /sd options, restored by its own finally block.
    // No workflow, URL, model, LoRA, dimensions or sampler override.
    return command.callback({ quiet: 'true', extend: 'false', edit: 'false' }, prompt);
}

function chatKey(context) {
    return JSON.stringify([context.groupId ?? null, context.characterId ?? null,
        context.getCurrentChatId?.() ?? context.chatId ?? null]);
}

function assistant(message) {
    return message && !message.is_user && !message.is_system && typeof message.mes === 'string';
}

// Only our text and metadata are synchronized. Existing images/media/display_text
// and all unrelated extra fields are left untouched.
function writeMeta(message, metadata) {
    message.extra ??= {};
    message.extra[META_KEY] = metadata;
    const id = message.swipe_id;
    if (Number.isInteger(id) && Array.isArray(message.swipes)
        && typeof message.swipes[id] === 'string') {
        message.swipes[id] = message.mes;
        if (message.swipe_info?.[id]) {
            message.swipe_info[id].extra ??= {};
            message.swipe_info[id].extra[META_KEY] = { ...metadata };
        }
    }
}

export function createController({ getContext, settings, status = () => {},
    generate = generateWithSd, baseUrl = 'http://localhost/', defer = fn => setTimeout(fn, 0) }) {
    let epoch = 0;
    let generating = false;
    let stopped = false;
    let observedGeneration = false;
    let scheduled = false;
    let running = false;
    let queue = [];
    const received = new Set();
    const locks = new WeakSet();
    const attempts = new WeakMap();
    const waiters = [];

    function idle() {
        if (!running && !scheduled && !queue.length && !received.size) {
            for (const resolve of waiters.splice(0)) resolve();
        }
    }

    function valid(job) {
        const context = getContext();
        return settings.enabled && epoch === job.epoch && context.chat === job.chat
            && chatKey(context) === job.chatKey && context.chat.indexOf(job.message) === job.index
            && assistant(job.message) && job.message.swipe_id === job.swipe
            && job.message.mes === job.text;
    }

    async function saveIfCurrent(job) {
        const context = getContext();
        if (epoch !== job.epoch || context.chat !== job.chat || chatKey(context) !== job.chatKey
            || context.chat[job.index] !== job.message || job.message.swipe_id !== job.swipe) return false;
        // The host owns saving and error notifications. Its 1.18.0 saveChat
        // wrapper swallows server errors; do not pretend to verify disk writes.
        await context.saveChat();
        return true;
    }

    async function fail(job) {
        if (!valid(job)) return;
        writeMeta(job.message, { version: 1, status: 'failed', swipe: job.swipe,
            drawHash: job.draw.drawHash });
        try { await saveIfCurrent(job); } catch { /* no raw errors/prompts */ }
        status('配图失败；标记已保留，可点“重试最后一条”。', true);
    }

    async function run(job) {
        try {
            if (!valid(job)) return;
            status('正在使用酒馆当前生图配置生成 1 张图片…');
            const path = await generate(getContext(), job.draw.prompt);
            if (!valid(job)) {
                status('原消息或会话已变化，结果未插入；需要时请重试。');
                return;
            }
            const url = safeImageUrl(path, baseUrl);
            const markdown = `![生成图片](<${url}>)`;
            const updated = job.text.slice(0, job.draw.index) + '\n\n' + markdown + '\n\n'
                + job.text.slice(job.draw.index + job.draw.raw.length);
            const oldMeta = job.message.extra?.[META_KEY];
            job.message.mes = updated;
            writeMeta(job.message, { version: 1, status: 'done', swipe: job.swipe,
                drawHash: job.draw.drawHash, url });
            // There is no await between the identity check and the write/save call.
            try {
                getContext().updateMessageBlock(job.index, job.message);
                await saveIfCurrent(job);
            } catch {
                // Roll back only our own write if the same message remains current.
                if (job.message.mes === updated && job.message.swipe_id === job.swipe
                    && epoch === job.epoch && getContext().chat === job.chat) {
                    job.message.mes = job.text;
                    writeMeta(job.message, oldMeta ?? { version: 1, status: 'failed',
                        swipe: job.swipe, drawHash: job.draw.drawHash });
                    try { getContext().updateMessageBlock(job.index, job.message); } catch { /* safe */ }
                }
                await fail(job);
                return;
            }
            if (epoch === job.epoch && getContext().chat === job.chat) {
                status('图片已插入；已请求酒馆保存聊天。');
            }
        } catch {
            await fail(job);
        } finally {
            locks.delete(job.message);
        }
    }

    async function drain() {
        if (running || generating) return;
        running = true;
        try {
            while (queue.length && !generating) await run(queue.shift());
        } finally {
            running = false;
            idle();
        }
    }

    function enqueue(message, manual = false) {
        const context = getContext();
        if (!settings.enabled || !assistant(message) || locks.has(message)) return;
        const index = context.chat.indexOf(message);
        if (index < 0) return;
        const draw = findDraw(message.mes);
        if (!draw) {
            if (manual) status('最后一条 AI 回复没有可处理的 <draw> 标记。');
            return;
        }
        if (draw.error) {
            status('标记无效：提示词须为 1–4000 字符的画面描述，不含宏或生图保留词。', true);
            return;
        }
        // Cached display text would hide the inline result; never delete another
        // extension's cache or attachments to work around that.
        if (typeof message.extra?.display_text === 'string') {
            status('此消息有其他扩展的显示缓存，未改动；移除冲突后可手动重试。', true);
            return;
        }
        const meta = message.extra?.[META_KEY];
        const sameSwipe = meta?.swipe === message.swipe_id;
        const hasOurImage = typeof meta?.url === 'string' && message.mes.includes(`![生成图片](<${meta.url}>)`);
        if (meta?.status === 'done' && (sameSwipe || hasOurImage)) {
            if (manual) status('此回复版本已配图；每条最多 1 张。');
            return;
        }
        const token = `${message.swipe_id}:${draw.drawHash}`;
        let seen = attempts.get(message);
        if (!seen) attempts.set(message, seen = new Set());
        if (!manual && (seen.has(token) || (meta?.status === 'failed' && sameSwipe && meta.drawHash === draw.drawHash))) return;
        seen.add(token);
        locks.add(message);
        queue.push({ epoch, message, index, chat: context.chat, chatKey: chatKey(context),
            text: message.mes, swipe: message.swipe_id, draw });
    }

    function schedule() {
        if (scheduled) return;
        scheduled = true;
        defer(() => {
            scheduled = false;
            if (!generating) {
                for (const message of received) enqueue(message);
                received.clear();
                void drain();
            }
            idle();
        });
    }

    function invalidate() {
        epoch++;
        received.clear();
        for (const job of queue) locks.delete(job.message);
        queue = [];
        idle();
    }

    return {
        onStarted(type, options, dryRun) {
            if (dryRun || type === 'quiet' || type === 'impersonate') return;
            // A continuation/swipe may temporarily still have exactly the old
            // body before its first token. Never commit an older image into it.
            if (['continue', 'append', 'appendFinal', 'swipe', 'regenerate'].includes(type)) invalidate();
            generating = true;
            stopped = false;
            observedGeneration = true;
        },
        onReceived(index, type) {
            // Ignore greetings, history, slash-generated and SD-generated messages.
            if (!observedGeneration || stopped || ['first_message', 'extension', 'command', 'quiet', 'impersonate'].includes(type)) return;
            const message = getContext().chat[Number(index)];
            if (assistant(message)) received.add(message);
            schedule();
        },
        onEnded() { generating = false; schedule(); },
        onStopped() { stopped = true; generating = false; invalidate(); },
        onChanged() {
            generating = false;
            stopped = false;
            observedGeneration = false;
            invalidate();
            status('就绪：只处理此后生成的 AI 正文；历史不会自动补图。');
        },
        onMutated() { invalidate(); },
        onEnabledChanged() {
            if (!settings.enabled) invalidate();
            status(settings.enabled ? '已启用；等待下一条完整回复。' : '已关闭；在途结果不会插入。');
        },
        retryLast() {
            if (!settings.enabled) return status('请先启用正文自动配图。');
            if (generating) return status('请等待文字回复结束，再重试。');
            const message = [...getContext().chat].reverse().find(assistant);
            if (!message) return status('当前聊天没有 AI 回复。');
            if (locks.has(message)) return status('这条回复已在配图队列中，请勿重复点击。');
            enqueue(message, true);
            void drain();
        },
        whenIdle() { return new Promise(resolve => { waiters.push(resolve); idle(); }); },
    };
}

export function install() {
    const getContext = () => globalThis.SillyTavern.getContext();
    const context = getContext();
    const container = document.getElementById('extensions_settings');
    if (!container || document.getElementById('draw_inline_settings')) return;
    const panel = document.createElement('div');
    panel.id = 'draw_inline_settings';
    panel.className = 'extension_container';
    const title = document.createElement('h4');
    title.textContent = 'Draw Inline / 正文自动配图';
    const label = document.createElement('label');
    label.className = 'checkbox_label';
    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'menu_button';
    button.textContent = '重试最后一条';
    const state = document.createElement('small');
    state.style.display = 'block';
    state.setAttribute('role', 'status');
    panel.append(title, label, button, state);
    label.append(enabled, document.createTextNode('启用：完整 AI 回复中的 <draw> 自动配图（每条最多 1 张）'));
    container.append(panel);
    const status = text => { state.textContent = text; };
    const types = context.eventTypes ?? context.event_types;
    const compatible = typeof context.saveChat === 'function' && typeof context.updateMessageBlock === 'function'
        && context.extensionSettings && context.eventSource?.on
        && ['GENERATION_STARTED', 'GENERATION_ENDED', 'MESSAGE_RECEIVED', 'CHAT_CHANGED',
            'MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_DELETED'].every(name => types?.[name]);
    if (!compatible) {
        enabled.disabled = button.disabled = true;
        status('此酒馆缺少必需接口，已安全停用；请查看 README 兼容说明。');
        return;
    }
    const settings = context.extensionSettings[SETTINGS_KEY] ??= { enabled: true };
    settings.enabled = settings.enabled !== false;
    enabled.checked = settings.enabled;
    const controller = createController({ getContext, settings, status, baseUrl: location.href });
    enabled.addEventListener('change', () => {
        settings.enabled = enabled.checked;
        getContext().saveSettingsDebounced?.();
        controller.onEnabledChanged();
    });
    button.addEventListener('click', () => controller.retryLast());
    const listen = (name, handler) => {
        if (types[name]) context.eventSource.on(types[name], handler);
    };
    listen('GENERATION_STARTED', controller.onStarted);
    listen('GENERATION_ENDED', controller.onEnded);
    listen('GENERATION_STOPPED', controller.onStopped);
    listen('MESSAGE_RECEIVED', controller.onReceived);
    listen('CHAT_CHANGED', controller.onChanged);
    for (const name of ['MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED',
        'MESSAGE_DELETED', 'MESSAGE_SWIPE_DELETED']) listen(name, controller.onMutated);
    controller.onChanged();
}

// Classic extension entry point: also works without the newer manifest hooks.
if (globalThis.document && globalThis.jQuery && globalThis.SillyTavern?.getContext) {
    globalThis.jQuery(install);
}
