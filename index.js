// Scene Backdrop for SillyTavern
// Shows one of your own images behind the chat messages, picked to match the
// current scene. You give each image a label; after each character reply a
// short AI call picks the label that fits best. Images can be shown as a plain
// silhouette (any colour) so only their outline remains.

import { buildSheet, canCleanUp } from './cleanup.js';

const VERSION = '1.7.0';
const MODULE = 'scene_backdrop';
const SWIPES_KEY = `${MODULE}_swipes`;

const DEFAULT_LABELS = ['Handjob', 'Tittyfuck', 'Footjob', 'Blowjob', 'Penetrative', 'Touchless pleasure', 'Touchless orgasm'];

const DEFAULTS = {
    enabled: true,
    slots: DEFAULT_LABELS.map((label, n) => ({ id: `s${n + 1}`, label, hint: '', path: '', onlyWith: '', needsEffect: '' })),
    allowNone: false,
    contextMessages: 4,
    silhouette: true,
    color: '#000000',
    opacity: 55,
    size: 85,
    anchor: 'auto',
    cleanup: true,
    softness: 0,
    glow: 6,
    glowColor: '#c8b4ff',
    allChats: false,
};

let busy = false;
let armed = false;
let preview = null; // slot id while previewing

// ---------- helpers ----------

function ctx() {
    return SillyTavern.getContext();
}

function settings() {
    const store = ctx().extensionSettings;
    if (!store[MODULE] || typeof store[MODULE] !== 'object') store[MODULE] = structuredClone(DEFAULTS);
    const s = store[MODULE];
    for (const [k, v] of Object.entries(DEFAULTS)) if (s[k] === undefined) s[k] = structuredClone(v);
    if (!Array.isArray(s.slots)) s.slots = structuredClone(DEFAULTS.slots);
    if ('position' in s) {
        delete s.position; // replaced by "anchor", which adds "auto"
        s.anchor = 'auto';
    }
    if (!s.grouped) {
        // Older setups: a label with conditions whose name contains a plain
        // label's name ("Kemono Handjob") becomes a variant in that group.
        for (const sl of s.slots) {
            if (sl.group) continue;
            const parent = legacyParent(sl, s.slots);
            sl.group = parent ? parent.label.trim() : sl.label.trim();
        }
        for (const name of new Set(s.slots.map(groupName))) {
            const list = s.slots.filter(sl => groupName(sl) === name);
            if (!list.some(sl => sl.isDefault)) {
                const plain = list.find(sl => !hasConditions(sl));
                if (plain) plain.isDefault = true;
            }
        }
        s.grouped = 1;
    }
    return s;
}

function save() {
    ctx().saveSettingsDebounced();
}

function toast(type, message) {
    globalThis.toastr?.[type]?.(message, 'Scene backdrop');
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function hasChat() {
    const c = ctx();
    return (c.characterId !== undefined && c.characterId !== null) || !!c.groupId;
}

function chatKey() {
    const c = ctx();
    return c.getCurrentChatId?.() ?? c.chatId ?? null;
}

// ---------- label conditions ----------
// "Only with": any of the listed characters is in the chat (card or group
// member) or named in the recent messages. "Needs effect": every listed
// SillyStatus effect is active (by name or icon, optionally "Name>=3");
// use | inside an item for alternatives, e.g. "Fox ears|Cat ears".

function splitList(text) {
    return String(text ?? '').split(/[,;]/).map(x => x.trim()).filter(Boolean);
}

function chatCharacterNames() {
    const c = ctx();
    const names = new Set();
    if (c.groupId) {
        const group = c.groups?.find(g => g.id == c.groupId);
        for (const avatar of group?.members ?? []) {
            const ch = c.characters?.find(x => x.avatar === avatar);
            if (ch?.name) names.add(ch.name.toLowerCase());
        }
    } else if (c.name2) {
        names.add(String(c.name2).toLowerCase());
    }
    if (c.name1) names.add(String(c.name1).toLowerCase());
    return names;
}

function recentText(upto) {
    const chat = ctx().chat ?? [];
    const end = Math.min(upto ?? chat.length - 1, chat.length - 1);
    const start = Math.max(0, end - settings().contextMessages + 1);
    let out = '';
    for (let i = start; i <= end; i++) if (chat[i] && !chat[i].is_system) out += ` ${cleanMessage(chat[i].mes)}`;
    return out.toLowerCase();
}

function escapeRegex(t) {
    return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function activeEffects() {
    try {
        return globalThis.SillyStatus?.getEffects?.() ?? null;
    } catch {
        return null;
    }
}

// Everything that describes who is in the scene, as separate sources so a
// match can say where it came from: each character card in the chat
// (description, personality, scenario, tags), your persona description, and
// the recent messages.
function traitSources(upto) {
    const c = ctx();
    const cards = [];
    if (c.groupId) {
        const group = c.groups?.find(g => g.id == c.groupId);
        for (const avatar of group?.members ?? []) {
            const ch = c.characters?.find(x => x.avatar === avatar);
            if (ch) cards.push(ch);
        }
    } else if (c.characterId !== undefined && c.characterId !== null) {
        const ch = c.characters?.[c.characterId];
        if (ch) cards.push(ch);
    }
    const out = [];
    for (const ch of cards) {
        const tagNames = [
            ...(Array.isArray(ch.data?.tags) ? ch.data.tags : []),
            ...(c.tagMap?.[ch.avatar] ?? []).map(id => c.tags?.find(t => String(t.id) === String(id))?.name),
        ].filter(Boolean);
        const text = [ch.description, ch.personality, ch.scenario, ch.data?.description !== ch.description ? ch.data?.description : '',
            tagNames.length ? `Tags: ${tagNames.join(', ')}` : ''].filter(Boolean).join('\n');
        out.push({ kind: 'card', who: ch.name, text, lower: text.toLowerCase() });
    }
    const persona = c.powerUserSettings?.persona_description;
    if (persona) out.push({ kind: 'persona', who: c.name1 ?? 'User', text: persona, lower: persona.toLowerCase() });
    const recent = recentText(upto);
    out.push({ kind: 'recent', who: 'recent messages', text: recent, lower: recent });
    return out;
}

function wordAt(lower, word) {
    const m = new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRegex(word)})($|[^\\p{L}\\p{N}])`, 'u').exec(lower);
    return m ? m.index + m[1].length : -1;
}

// A short snippet of the source around the match, trimmed to whole words.
function excerpt(src, at, len, room = 170) {
    let a = Math.max(0, at - room);
    let b = Math.min(src.text.length, at + len + room);
    if (a > 0) a = src.text.indexOf(' ', a) + 1 || a;
    if (b < src.text.length) b = src.text.lastIndexOf(' ', b) > at + len ? src.text.lastIndexOf(' ', b) : b;
    return `${a > 0 ? '…' : ''}${src.text.slice(a, b).replace(/\s+/g, ' ').trim()}${b < src.text.length ? '…' : ''}`;
}

// One "Needs" item. Returns how it was met (or null): an active SillyStatus
// effect, or (without a stage comparison) the trait on a card, the persona
// or the recent messages.
function matchItem(item, effects, sources) {
    for (const alt of item.split('|').map(x => x.trim()).filter(Boolean)) {
        const m = alt.match(/^(.*?)\s*(>=|>|<=|<|=)\s*(\d+)$/);
        const name = (m ? m[1] : alt).trim().toLowerCase();
        const op = m?.[2];
        const n = m ? Number(m[3]) : null;
        const eff = (effects ?? []).find(e => {
            if (!(e.stage > 0)) return false;
            const hit = (e.icon && e.icon.toLowerCase() === name)
                || (e.visual && e.visual.toLowerCase() === name)
                || String(e.name ?? '').toLowerCase().includes(name);
            if (!hit) return false;
            if (!op) return true;
            return { '>=': e.stage >= n, '>': e.stage > n, '<=': e.stage <= n, '<': e.stage < n, '=': e.stage === n }[op];
        });
        if (eff) return { via: 'effect', alt, who: eff.target ?? '' };
        if (op) continue;
        // Recent messages first: the AI reads them anyway, so no snippet is needed.
        const order = [...sources.filter(x => x.kind === 'recent'), ...sources.filter(x => x.kind !== 'recent')];
        for (const src of order) {
            const at = wordAt(src.lower, name);
            if (at >= 0) return { via: src.kind, alt, who: src.who, note: src.kind === 'recent' ? '' : excerpt(src, at, name.length) };
        }
    }
    return null;
}

// A "Needs" text written as a description rather than a keyword list, like
// "Any perky animal ears (cat, fox, dog...)". Treated as one condition the AI
// judges; its notable words are only used to find who might qualify.
function isDescribed(text) {
    if (/[()]/.test(text) || /\b(e\.g\.|for example|such as)\b/i.test(text)) return true;
    return splitList(text).some(item => item.split('|').some(alt => alt.trim().split(/\s+/).length >= 3));
}

const STOPWORDS = new Set(('a an the and or of for with without to in on at by from as is are be any some all each '
    + 'like such example eg e g etc kind type sort style version only when while who whose that this these those it its '
    + 'girl girls boy boys woman women man men person people character characters someone one ones has have having '
    + 'very really quite more most less little big small perky cute').split(' '));

function keywordsOf(text) {
    const words = String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3 && !STOPWORDS.has(w));
    return [...new Set(words)].slice(0, 12);
}

// Word-start match, so "cat" also finds "catgirl" and "cats" (the AI confirms anyway).
function wordStartAt(lower, word) {
    const m = new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRegex(word)})`, 'u').exec(lower);
    return m ? m.index + m[1].length : -1;
}

function describedMatch(text, effects, sources) {
    const keys = keywordsOf(text);
    const notes = [];
    let found = false;
    for (const e of effects ?? []) {
        if (e.stage > 0 && keys.some(k => String(e.name ?? '').toLowerCase().includes(k))) found = true;
    }
    for (const src of sources) {
        for (const k of keys) {
            const at = wordStartAt(src.lower, k);
            if (at < 0) continue;
            found = true;
            if (src.kind !== 'recent' && notes.length < 3 && !notes.some(n => n.who === src.who && n.at !== undefined && Math.abs(n.at - at) < 200)) {
                notes.push({ who: src.who, text: excerpt(src, at, k.length), at });
            }
        }
    }
    return { found, keys, notes };
}

// { met, conditional, confirm, notes, why } for a label at a point in the chat.
// confirm: the AI should check the trait is true right now (a word match can
// be backstory, another form, or something that has since changed).
function conditionsOf(slot, upto) {
    if (slot.isDefault) return { met: true, conditional: false, confirm: false, notes: [], why: '' };
    const people = splitList(slot.onlyWith);
    const needs = splitList(slot.needsEffect);
    if (!people.length && !needs.length) return { met: true, conditional: false, confirm: false, notes: [], why: '' };
    const reasons = [];
    const notes = [];
    let met = true;
    let confirm = false;
    if (people.length) {
        const names = chatCharacterNames();
        const text = recentText(upto);
        const present = people.filter(p => names.has(p.toLowerCase()) || new RegExp(`\\b${escapeRegex(p.toLowerCase())}\\b`).test(text));
        if (!present.length) {
            met = false;
            reasons.push(`none of ${people.join(', ')} here`);
        } else reasons.push(`${present.join(', ')} here`);
    }
    if (needs.length && isDescribed(slot.needsEffect)) {
        const d = describedMatch(slot.needsEffect, activeEffects(), traitSources(upto));
        if (!d.found) {
            met = false;
            reasons.push(`no sign of it (looked for: ${d.keys.join(', ') || 'nothing to look for'})`);
        } else {
            confirm = true;
            notes.push(...d.notes);
            reasons.push('possible here · AI confirms');
        }
    } else if (needs.length) {
        const effects = activeEffects();
        const sources = traitSources(upto);
        const missing = [];
        const found = [];
        for (const item of needs) {
            const hit = matchItem(item, effects, sources);
            if (!hit) {
                missing.push(item);
                continue;
            }
            found.push(`${hit.alt} (${hit.via === 'effect' ? 'effect' : hit.via === 'recent' ? 'in recent messages' : `${hit.who}'s ${hit.via === 'persona' ? 'persona' : 'card'}`})`);
            // Traits found as words (not effects) get confirmed by the AI. Card and
            // persona matches send a short snippet; recent-message matches need
            // none, since the AI reads those messages anyway.
            if (hit.via !== 'effect' && slot.aiConfirm !== false) {
                confirm = true;
                if (hit.note) notes.push({ who: hit.who, text: hit.note });
            }
        }
        if (missing.length) {
            met = false;
            reasons.push(`missing ${missing.join(', ')}${!effects && missing.some(x => /[<>=]\s*\d+$/.test(x)) ? ' (SillyStatus not found)' : ''}`);
        } else reasons.push(`found: ${found.join(', ')}${confirm ? ' · AI confirms' : ''}`);
    }
    return { met, conditional: true, confirm: met && confirm, notes: met ? notes : [], why: reasons.join(' · ') };
}

// ---------- groups ----------
// Images sharing a Group are variants of the same action. The default
// variant is used whenever no other variant applies.

function groupName(slot) {
    return String(slot.group ?? '').trim() || String(slot.label ?? '').trim();
}

function defaultOf(name, slots = settings().slots) {
    return slots.find(sl => groupName(sl) === name && sl.isDefault) ?? null;
}

function legacyParent(slot, slots) {
    if (!hasConditions(slot)) return null;
    const name = String(slot.label ?? '').trim().toLowerCase();
    const generals = slots.filter(sl => sl !== slot && String(sl.label ?? '').trim() && !hasConditions(sl));
    const base = name.replace(/\s*[(\[].*[)\]]\s*$/, '').trim();
    return generals.find(g => g.label.trim().toLowerCase() === base)
        ?? generals.filter(g => wordAt(name, g.label.trim().toLowerCase()) >= 0).sort((a, b) => b.label.length - a.label.length)[0]
        ?? null;
}

function hasConditions(slot) {
    return !!(splitList(slot.onlyWith).length || String(slot.needsEffect ?? '').trim());
}

// When a special label isn't available, use the general one for the same
// action: "Blowjob (ears)" falls back to "Blowjob".
function fallbackFor(label) {
    const slot = slotByLabel(label);
    if (!slot) return null;
    const def = defaultOf(groupName(slot));
    return def && def !== slot && def.path ? def : null;
}

function usableSlots(upto) {
    return settings().slots.filter(sl => sl.label.trim() && sl.path && conditionsOf(sl, upto).met);
}

function slotByLabel(label) {
    const l = String(label ?? '').trim().toLowerCase();
    return settings().slots.find(sl => sl.label.trim().toLowerCase() === l) ?? null;
}

// ---------- per-chat switch ----------

function chatOn() {
    if (!hasChat()) return false;
    const s = settings();
    const meta = ctx().chatMetadata?.[MODULE];
    if (meta && typeof meta.on === 'boolean') return meta.on;
    return !!s.allChats;
}

async function setChatOn(on) {
    const c = ctx();
    if (!hasChat()) return;
    c.chatMetadata[MODULE] = { ...(c.chatMetadata[MODULE] ?? {}), on };
    await c.saveMetadata();
    refresh();
    toast('info', on ? 'On in this chat.' : 'Off in this chat.');
}

// ---------- scene per message (tied to the exact swipe) ----------

function swipeTag(msg) {
    const id = Number(msg?.swipe_id ?? 0);
    const date = msg?.swipe_info?.[id]?.send_date ?? msg?.send_date ?? '';
    return `${id}@${date}`;
}

function ownScene(msg) {
    const map = msg?.extra?.[SWIPES_KEY];
    if (!map) return undefined;
    const tag = swipeTag(msg);
    return Object.prototype.hasOwnProperty.call(map, tag) ? map[tag] : undefined;
}

// The label in force at the end of the chat (or before a given message).
function sceneBefore(index) {
    const chat = ctx().chat ?? [];
    for (let i = Math.min(index, chat.length) - 1; i >= 0; i--) {
        const s = ownScene(chat[i]);
        if (s !== undefined) return s;
    }
    return null;
}

function currentScene() {
    return sceneBefore((ctx().chat ?? []).length);
}

async function writeScene(index, label) {
    const c = ctx();
    const msg = c.chat?.[index];
    if (!msg) return;
    const tag = swipeTag(msg);
    const put = (extra) => {
        const map = { ...(extra[SWIPES_KEY] ?? {}) };
        map[tag] = label;
        const keys = Object.keys(map);
        for (const k of keys.slice(0, Math.max(0, keys.length - 30))) delete map[k];
        extra[SWIPES_KEY] = map;
    };
    msg.extra ??= {};
    put(msg.extra);
    const swipe = Array.isArray(msg.swipe_info) ? msg.swipe_info[msg.swipe_id ?? 0] : null;
    if (swipe && typeof swipe === 'object') {
        swipe.extra ??= {};
        put(swipe.extra);
    }
    await (c.saveChat ?? c.saveChatConditional)?.();
}

// ---------- the AI pick ----------

function cleanMessage(mes) {
    return String(mes ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2500);
}

// The AI answers in one request: which group (action) is happening, and
// which variant of it fits the character involved right now ("default" if
// none). Only variants that are plausible in this chat are shown to it.
function pickPlan(index) {
    const groups = new Map();
    for (const sl of usableSlots(index)) {
        const name = groupName(sl);
        if (!groups.has(name)) groups.set(name, { name, def: null, variants: [] });
        const g = groups.get(name);
        if (sl.isDefault) g.def = sl;
        else g.variants.push({ slot: sl, cond: conditionsOf(sl, index) });
    }
    return [...groups.values()];
}

function conditionText(slot) {
    const t = String(slot.needsEffect ?? '').trim();
    const parts = [];
    if (t) parts.push(isDescribed(t) ? t : splitList(t).map(x => x.replace(/\|/g, ' or ')).join(' and '));
    if (splitList(slot.onlyWith).length) parts.push(`the character involved is ${splitList(slot.onlyWith).join(' or ')}`);
    return parts.join('; ') || 'no condition';
}

function buildPick(index, current) {
    const c = ctx();
    const s = settings();
    const plan = pickPlan(index);
    const groupLines = plan.map(g => {
        const hint = (g.def ?? g.variants[0]?.slot)?.hint;
        const onlyVariants = !g.def ? ' (only when one of its variants applies)' : '';
        return `- ${g.name}${hint ? `: ${hint}` : ''}${onlyVariants}`;
    }).join('\n');

    const notes = new Map();
    const variantBlocks = [];
    for (const g of plan) {
        if (!g.variants.length) continue;
        const lines = [];
        if (g.def) lines.push('  - default: when none of the variants below fits');
        for (const v of g.variants) {
            lines.push(`  - "${v.slot.label}"${v.slot.hint ? ` (${v.slot.hint})` : ''}: ${conditionText(v.slot)}${v.cond.confirm ? '' : ' [known to be true right now]'}`);
            for (const n of v.cond.notes) if (n.text) notes.set(`${n.who}|${n.text}`, `- ${n.who}: "${n.text}"`);
        }
        variantBlocks.push(`${g.name}\n${lines.join('\n')}`);
    }
    const variantBlock = variantBlocks.length
        ? `\n\nVARIANTS. Some groups have variants. If you pick one of these groups, also pick the variant that fits the character involved in the current scene right now; if several fit, choose the best fit for this moment. Backstory, ancestry, or a form the character is not in right now does not count.${notes.size ? ' Use the CHARACTER NOTES and the story.' : ''}\n${variantBlocks.join('\n')}`
        : '';
    const noteBlock = notes.size ? `\n\nCHARACTER NOTES (short excerpts):\n${[...notes.values()].slice(0, 6).join('\n')}` : '';

    const curSlot = current ? slotByLabel(current) : null;
    const curName = curSlot ? groupName(curSlot) : (current ?? 'none');

    const start = Math.max(0, index - s.contextMessages + 1);
    const lines = [];
    for (let i = start; i <= index; i++) {
        const m = c.chat[i];
        if (!m || m.is_system) continue;
        lines.push(`${m.name}: ${cleanMessage(m.mes)}`);
    }
    const noneRule = s.allowNone
        ? 'If none of them is happening at all, answer "none" as the group.'
        : 'Always pick one of them, the closest match, even if the fit is loose. Never answer "none".';
    const system = `You label scenes in an adult roleplay so a matching background image can be shown. You never write story text.
Pick the group that best matches what is physically happening in the newest message.
${noneRule}
The current group is "${curName}". Keep it unless a different group clearly fits the newest message better.
Answer with JSON only: {"group": "<one group exactly as written>", "variant": "<variant name exactly as written, or default>"}

GROUPS:
${groupLines}${variantBlock}${noteBlock}`;
    const user = `RECENT STORY (oldest first, the last message is the one to label):\n\n${lines.join('\n\n')}\n\nAnswer with the JSON now.`;
    return { system, user };
}

async function askModel({ system, user }) {
    const c = ctx();
    if ((c.mainApi ?? 'openai') === 'openai') {
        return await c.generateRaw({ prompt: [{ role: 'system', content: system }, { role: 'user', content: user }] });
    }
    return await c.generateRaw({ systemPrompt: system, prompt: user });
}

function parseAnswer(raw) {
    const t = String(raw ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?/gi, '');
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) {
        try {
            const p = JSON.parse(t.slice(a, b + 1));
            const group = typeof p?.group === 'string' ? p.group.trim() : typeof p?.label === 'string' ? p.label.trim() : '';
            const variant = typeof p?.variant === 'string' ? p.variant.trim() : '';
            if (group || variant) return { group, variant, text: t };
        } catch { /* fall through */ }
    }
    return { group: '', variant: '', text: t };
}

// Turns the AI's answer into one image, using the plan for this message.
function decide(answer, plan) {
    const low = x => String(x ?? '').trim().toLowerCase();
    let g = plan.find(x => low(x.name) === low(answer.group));
    // It may have answered with a variant or label name instead of a group.
    const named = [answer.variant, answer.group].map(low).filter(Boolean);
    if (!g) g = plan.find(x => x.variants.some(v => named.includes(low(v.slot.label))) || (x.def && named.includes(low(x.def.label))));
    if (!g) {
        // Plain-text answer: look for a group or variant name in it.
        const text = low(answer.text);
        const byLen = (a, b) => b.length - a.length;
        const name = [...plan.flatMap(x => x.variants.map(v => v.slot.label)), ...plan.map(x => x.name)].sort(byLen).find(n => text.includes(low(n)));
        if (name) {
            g = plan.find(x => low(x.name) === low(name) || x.variants.some(v => low(v.slot.label) === low(name)));
            if (g && !answer.variant) answer = { ...answer, variant: name };
        }
    }
    if (!g) return undefined; // keep the current image
    const picked = g.variants.find(v => low(v.slot.label) === low(answer.variant) || low(v.slot.label) === low(answer.group));
    if (picked) return picked.slot;
    // No variant named: a variant whose condition is certain still applies.
    const certain = g.variants.find(v => !v.cond.confirm);
    if (certain) return certain.slot;
    return g.def ?? undefined;
}

async function runPick(index, manual = false) {
    const s = settings();
    if (!s.enabled || !chatOn()) return;
    if (!usableSlots(index).length) {
        if (manual) toast('info', 'Add at least one image with a label first.');
        return;
    }
    if (busy) return;
    const c = ctx();
    const msg = c.chat?.[index];
    if (!msg || msg.is_user || msg.is_system) return;
    const key = chatKey();
    busy = true;
    try {
        const current = sceneBefore(index);
        const raw = await askModel(buildPick(index, current));
        if (chatKey() !== key || ctx().chat?.[index] !== msg) return;
        const answer = parseAnswer(raw);
        let result;
        if (answer.group.toLowerCase() === 'none' && s.allowNone) result = 'none';
        else {
            const slot = decide(answer, pickPlan(index));
            result = slot ? slot.label : current;
        }
        await writeScene(index, result ?? null);
        if (manual) toast('info', `Scene: ${result ?? 'none'}`);
    } catch (err) {
        console.error('[Scene Backdrop] pick failed', err);
        if (manual) toast('error', `Pick failed: ${err?.message ?? err}`);
    } finally {
        busy = false;
        refresh();
    }
}

// ---------- the backdrop layer ----------
// It lives inside the chat area as a sticky, zero-height first child, so it
// stays in view while scrolling and paints above the chat's own background
// colour but below every message.

let holder = null;
let shownSlot = null;

function ensureHolder() {
    const chatEl = document.getElementById('chat');
    if (!chatEl) return null;
    if (!holder) {
        holder = document.createElement('div');
        holder.id = 'ssb-holder';
        holder.innerHTML = '<div class="ssb-stage"><div class="ssb-glow"><div class="ssb-fig"></div><div class="ssb-fig"></div></div></div>';
    }
    if (holder.parentElement !== chatEl || chatEl.firstElementChild !== holder) chatEl.prepend(holder);
    const stage = holder.querySelector('.ssb-stage');
    stage.style.height = `${chatEl.clientHeight}px`;
    stage.style.width = `${chatEl.clientWidth}px`;
    return holder;
}

function urlOf(path) {
    return path.startsWith('/') || /^[a-z]+:/i.test(path) ? path : `/${path}`;
}

function setMask(el, value) {
    el.style.maskImage = value;
    el.style.webkitMaskImage = value;
}

// One figure slot of the crossfade. Plays a cleaned frame sheet itself, or
// falls back to the original image when there is no sheet.
class Figure {
    constructor(el) {
        this.el = el;
        this.slot = null;
        this.frame = 0;
        this.due = 0;
    }

    show(slot) {
        this.slot = slot;
        this.frame = 0;
        this.due = performance.now() + (slot?.sheet?.durations?.[0] ?? 100);
        this.style();
        this.layout();
        loop();
    }

    clear() {
        this.slot = null;
    }

    get animated() {
        return !!(this.slot?.sheet && this.slot.sheet.n > 1 && settings().silhouette);
    }

    style() {
        const s = settings();
        const el = this.el;
        const slot = this.slot;
        if (!slot) return;
        el.style.filter = s.softness > 0 ? `blur(${s.softness}px)` : 'none';
        if (s.silhouette) {
            const src = slot.sheet?.path ?? slot.path;
            el.style.backgroundImage = 'none';
            el.style.backgroundColor = s.color;
            setMask(el, `url("${encodeURI(urlOf(src))}")`);
            el.style.maskRepeat = el.style.webkitMaskRepeat = 'no-repeat';
        } else {
            setMask(el, 'none');
            el.style.backgroundColor = 'transparent';
            el.style.backgroundImage = `url("${encodeURI(urlOf(slot.path))}")`;
            el.style.backgroundRepeat = 'no-repeat';
        }
    }

    // Size and place the figure inside the stage.
    layout() {
        const slot = this.slot;
        const stage = this.el.parentElement?.parentElement;
        if (!slot || !stage) return;
        const s = settings();
        const sw = stage.clientWidth;
        const sh = stage.clientHeight;
        const sheet = s.silhouette ? slot.sheet : null;
        const aspect = sheet ? sheet.fw / sheet.fh : (slot.aspect || 0.75);
        const h = Math.round(sh * (s.size / 100));
        const w = Math.round(h * aspect);
        let anchor = s.anchor;
        if (anchor === 'auto') anchor = sheet?.touchBottom ? 'bottom' : sheet?.touchTop && !sheet?.touchBottom ? 'top' : 'center';
        const top = anchor === 'bottom' ? sh - h : anchor === 'top' ? 0 : Math.round((sh - h) / 2);
        Object.assign(this.el.style, { right: 'auto', bottom: 'auto', left: `${Math.round((sw - w) / 2)}px`, top: `${top}px`, width: `${w}px`, height: `${h}px` });
        this.w = w;
        this.h = h;
        if (sheet) {
            const size = `${w * sheet.cols}px ${h * sheet.rows}px`;
            this.el.style.maskSize = this.el.style.webkitMaskSize = size;
            this.placeFrame();
        } else if (s.silhouette) {
            this.el.style.maskSize = this.el.style.webkitMaskSize = 'contain';
            this.el.style.maskPosition = this.el.style.webkitMaskPosition = 'center';
        } else {
            this.el.style.backgroundSize = 'contain';
            this.el.style.backgroundPosition = 'center';
        }
    }

    placeFrame() {
        const sheet = this.slot?.sheet;
        if (!sheet) return;
        const col = this.frame % sheet.cols;
        const row = Math.floor(this.frame / sheet.cols);
        const pos = `${-col * this.w}px ${-row * this.h}px`;
        this.el.style.maskPosition = this.el.style.webkitMaskPosition = pos;
    }

    tick(now) {
        if (!this.animated || now < this.due) return;
        const sheet = this.slot.sheet;
        let guard = 0;
        while (now >= this.due && guard++ < sheet.n) {
            this.frame = (this.frame + 1) % sheet.n;
            this.due += sheet.durations[this.frame] ?? 100;
        }
        if (now - this.due > 1000) this.due = now + (sheet.durations[this.frame] ?? 100); // after the tab was in the background
        this.placeFrame();
    }
}

let figures = [];
let looping = false;

function loop() {
    if (looping) return;
    looping = true;
    const step = (now) => {
        const active = figures.filter(f => f.animated && f.el.classList.contains('ssb-on'));
        if (!active.length) {
            looping = false;
            return;
        }
        for (const f of active) f.tick(now);
        requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
}

function renderBackdrop() {
    const s = settings();
    let slot = null;
    if (preview) slot = s.slots.find(sl => sl.id === preview && sl.path) ?? null;
    else if (s.enabled && chatOn()) {
        const label = currentScene();
        slot = label && label !== 'none' ? slotByLabel(label) : null;
        if (slot && slot.path && !conditionsOf(slot).met) slot = fallbackFor(slot.label);
        if (slot && !slot.path) slot = null;
    }
    const h = ensureHolder();
    if (!h) return;
    if (!figures.length || figures[0].el.parentElement !== h.querySelector('.ssb-glow')) {
        figures = [...h.querySelectorAll('.ssb-fig')].map(el => new Figure(el));
    }
    h.style.setProperty('--ssb-opacity', String(s.opacity / 100));
    // Edge glow: a soft halo following the silhouette's outline, so a dark
    // shape stays readable on a dark chat background.
    const glowEl = h.querySelector('.ssb-glow');
    glowEl.style.filter = s.glow > 0
        ? `drop-shadow(0 0 ${s.glow}px ${s.glowColor}) drop-shadow(0 0 ${Math.max(1, Math.round(s.glow / 3))}px ${s.glowColor})`
        : 'none';
    const [a, b] = figures;
    const sig = slot ? `${slot.id}|${slot.path}|${slot.sheet?.path ?? ''}|${s.silhouette}|${s.color}|${s.size}|${s.anchor}|${s.softness}` : '';
    if (sig === shownSlot) {
        for (const f of figures) if (f.slot) f.layout();
        return;
    }
    const sameImage = slot && shownSlot && shownSlot.split('|').slice(0, 3).join('|') === sig.split('|').slice(0, 3).join('|');
    shownSlot = sig;
    const front = a.el.classList.contains('ssb-on') ? a : b;
    if (sameImage) {
        // Only the look changed: restyle in place, no crossfade.
        front.style();
        front.layout();
        return;
    }
    // Crossfade: the hidden figure takes the new image and fades in.
    const back = front === a ? b : a;
    if (slot) {
        back.show(slot);
        back.el.classList.add('ssb-on');
    } else {
        back.clear();
    }
    front.el.classList.remove('ssb-on');
}

// ---------- uploads ----------

function readAsBase64(blob) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
        r.onerror = () => reject(r.error);
        r.readAsDataURL(blob);
    });
}

async function putFile(name, blob) {
    const res = await fetch('/api/files/upload', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({ name, data: await readAsBase64(blob) }),
    });
    if (!res.ok) throw new Error(await res.text() || `upload failed (${res.status})`);
    return (await res.json()).path;
}

function dropFile(path) {
    if (path && path.includes('/files/scene_')) {
        fetch('/api/files/delete', { method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify({ path }) }).catch(() => {});
    }
}

function imageAspect(url) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img.naturalWidth / Math.max(1, img.naturalHeight));
        img.onerror = () => resolve(0.75);
        img.src = url;
    });
}

// Cleans an image into a frame sheet and stores it on the slot.
async function cleanSlot(slot, file) {
    if (!canCleanUp()) throw new Error('this browser cannot clean up animations');
    const status = document.querySelector(`.ssb-slot[data-slot="${slot.id}"] .ssb-progress`);
    const { blob, meta } = await buildSheet(file, (k, n) => {
        if (status) status.textContent = `Cleaning up… ${k}/${n}`;
    });
    const path = await putFile(`scene_${slot.id}_sheet_${Date.now()}.png`, blob);
    const old = slot.sheet?.path;
    slot.sheet = { path, ...meta };
    save();
    dropFile(old);
}

async function uploadImage(slot, file) {
    const ext = (file.name.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'gif').toLowerCase();
    if (!['gif', 'png', 'webp', 'apng', 'jpg', 'jpeg', 'avif'].includes(ext)) {
        toast('warning', 'Use a GIF, PNG, WebP, APNG, AVIF or JPG image.');
        return;
    }
    const path = await putFile(`scene_${slot.id}_${Date.now()}.${ext}`, file);
    const old = slot.path;
    slot.path = path;
    slot.aspect = await imageAspect(urlOf(path));
    const oldSheet = slot.sheet?.path;
    delete slot.sheet;
    save();
    dropFile(old);
    dropFile(oldSheet);
    if (settings().cleanup && canCleanUp()) {
        try {
            await cleanSlot(slot, file);
        } catch (err) {
            console.warn('[Scene Backdrop] clean-up failed, using the original image', err);
            toast('warning', `Couldn't clean up this image (${err?.message ?? err}); using it as it is.`);
        }
    }
}

// Re-cleans an image that was uploaded earlier.
async function recleanSlot(slot) {
    const res = await fetch(urlOf(slot.path));
    if (!res.ok) throw new Error(`couldn't load the image (${res.status})`);
    const blob = await res.blob();
    const file = new File([blob], slot.path.split('/').pop(), { type: blob.type });
    await cleanSlot(slot, file);
}

// ---------- settings UI ----------

function slotRow(sl) {
    let thumb = '<div class="ssb-thumb ssb-thumb-empty">no image</div>';
    if (sl.path && settings().silhouette && sl.sheet) {
        const sh = sl.sheet;
        thumb = `<div class="ssb-thumb ssb-thumb-sil" style="--img:url('${escapeHtml(encodeURI(urlOf(sh.path)))}');--ms:${sh.cols * 100}% ${sh.rows * 100}%;--fa:${sh.fw}/${sh.fh}"></div>`;
    } else if (sl.path) {
        thumb = `<div class="ssb-thumb ${settings().silhouette ? 'ssb-thumb-sil ssb-thumb-raw' : ''}" style="--img:url('${escapeHtml(encodeURI(urlOf(sl.path)))}')"></div>`;
    }
    return `<div class="ssb-slot${sl.isDefault ? '' : ' ssb-variant'}" data-slot="${escapeHtml(sl.id)}">
        ${thumb}
        <div class="ssb-slot-fields">
            <input class="text_pole" data-f="label" placeholder="Name" value="${escapeHtml(sl.label)}" maxlength="60">
            <div class="ssb-group-row">
                <input class="text_pole" data-f="group" list="ssb-group-names" placeholder="Group (same as name if empty)" value="${escapeHtml(sl.group ?? '')}" maxlength="60">
                <label class="checkbox_label"><input type="checkbox" data-f="isDefault"${sl.isDefault ? ' checked' : ''}> Default</label>
            </div>
            <input class="text_pole" data-f="hint" placeholder="Hint for the AI (optional)" value="${escapeHtml(sl.hint)}" maxlength="200">
            ${sl.isDefault ? '<small class="ssb-cond-note">Default: used whenever no other variant in its group applies.</small>' : ''}
            <input class="text_pole${sl.isDefault ? ' ssb-hidden' : ''}" data-f="onlyWith" placeholder="Only with characters (optional, e.g. Mira, Kit)" value="${escapeHtml(sl.onlyWith ?? '')}" maxlength="200">
            <input class="text_pole${sl.isDefault ? ' ssb-hidden' : ''}" data-f="needsEffect" placeholder="Needs trait or effect (optional: keywords like fox ears|kitsune, or describe it)" value="${escapeHtml(sl.needsEffect ?? '')}" maxlength="200">
            <label class="checkbox_label ssb-confirm${sl.isDefault ? ' ssb-hidden' : ''}"><input type="checkbox" data-f="aiConfirm"${sl.aiConfirm === false ? '' : ' checked'}> AI confirms traits found on cards (backstory and other forms don't count)</label>
            <small class="ssb-cond"></small>
            <div class="ssb-slot-buttons">
                <label class="menu_button ssb-file">Image<input type="file" accept="image/gif,image/png,image/webp,image/apng,image/avif,image/jpeg" hidden></label>
                <button type="button" class="menu_button" data-a="preview"${sl.path ? '' : ' disabled'}>Show</button>
                <button type="button" class="menu_button" data-a="use"${sl.path ? '' : ' disabled'} title="Use this for the current scene">Use now</button>
                <button type="button" class="menu_button" data-a="clean"${sl.path ? '' : ' disabled'} title="Fill holes and remove stray pixels">Clean up</button>
                <button type="button" class="menu_button" data-a="remove">✕</button>
            </div>
            <small class="ssb-progress">${sl.path ? (sl.sheet ? `Cleaned · ${sl.sheet.n} frame${sl.sheet.n === 1 ? '' : 's'}` : 'Original image (not cleaned)') : ''}</small>
        </div>
    </div>`;
}

function renderSlots() {
    const box = document.getElementById('ssb-slots');
    if (!box) return;
    const groups = new Map();
    for (const sl of settings().slots) {
        const name = groupName(sl) || 'New';
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(sl);
    }
    const names = [...groups.keys()];
    box.innerHTML = `<datalist id="ssb-group-names">${names.map(n => `<option value="${escapeHtml(n)}"></option>`).join('')}</datalist>`
        + [...groups].map(([name, list]) => {
            list.sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0));
            const variants = list.length - (list.some(x => x.isDefault) ? 1 : 0);
            return `<div class="ssb-group">
                <div class="ssb-group-head">
                    <b>${escapeHtml(name)}</b>
                    <small>${list.some(x => x.isDefault) ? 'default' : 'no default'}${variants ? ` · ${variants} variant${variants === 1 ? '' : 's'}` : ''}</small>
                    <button type="button" class="menu_button" data-a="add-variant" data-group="${escapeHtml(name)}">+ Variant</button>
                </div>
                ${list.map(slotRow).join('')}
            </div>`;
        }).join('');
    renderConditions();
}

function renderConditions() {
    for (const row of document.querySelectorAll('.ssb-slot')) {
        const slot = settings().slots.find(sl => sl.id === row.dataset.slot);
        const out = row.querySelector('.ssb-cond');
        if (!slot || !out) continue;
        const c = conditionsOf(slot);
        out.textContent = c.conditional ? `${c.met ? '✓ Conditions met' : '✗ Not available now'} · ${c.why}` : '';
        out.classList.toggle('ssb-cond-met', c.conditional && c.met);
    }
}

function renderStatus() {
    renderConditions();
    const el = document.getElementById('ssb-status');
    if (!el) return;
    const on = chatOn();
    const scene = currentScene();
    el.textContent = !hasChat() ? 'No chat open.'
        : `This chat: ${on ? 'on' : 'off'} · current scene: ${scene ?? 'none yet'}${busy ? ' · picking…' : ''}`;
    const btn = document.getElementById('ssb-chat-toggle');
    if (btn) btn.textContent = on ? 'Turn off in this chat' : 'Turn on in this chat';
    const menu = document.getElementById('ssb-menu-item');
    if (menu) menu.querySelector('span').textContent = on ? 'Scene backdrop: on' : 'Scene backdrop: off';
}

function buildSettings() {
    const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!host || document.getElementById('ssb-settings')) return;
    const s = settings();
    const wrap = document.createElement('div');
    wrap.id = 'ssb-settings';
    wrap.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Scene Backdrop <small>v${VERSION}</small></b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div id="ssb-status" class="ssb-status"></div>
                <div class="ssb-row">
                    <button type="button" class="menu_button" id="ssb-chat-toggle">Turn on in this chat</button>
                    <button type="button" class="menu_button" id="ssb-pick-now">Pick now</button>
                    <button type="button" class="menu_button" id="ssb-clear">Clear</button>
                </div>
                <label class="checkbox_label"><input type="checkbox" data-k="enabled"> Enabled</label>
                <label class="checkbox_label"><input type="checkbox" data-k="allChats"> On in every chat unless turned off there</label>
                <label class="checkbox_label"><input type="checkbox" data-k="allowNone"> Allow "none" (show nothing when no label fits)</label>
                <hr>
                <b>Look</b>
                <label class="checkbox_label"><input type="checkbox" data-k="silhouette"> Show as a plain silhouette</label>
                <label>Silhouette colour <input type="color" data-k="color"></label>
                <label>Strength <span data-v="opacity"></span><input type="range" min="5" max="100" step="5" data-k="opacity"></label>
                <label>Size <span data-v="size"></span><input type="range" min="30" max="100" step="5" data-k="size"></label>
                <label>Edge glow <span data-v="glow"></span><input type="range" min="0" max="24" step="1" data-k="glow"></label>
                <label>Edge glow colour <input type="color" data-k="glowColor"></label>
                <label>Soft edges <span data-v="softness"></span><input type="range" min="0" max="12" step="1" data-k="softness"></label>
                <label>Position
                    <select class="text_pole" data-k="anchor">
                        <option value="auto">Automatic (bottom if the figure is cut off there)</option>
                        <option value="center">Middle</option>
                        <option value="bottom">Bottom</option>
                        <option value="top">Top</option>
                    </select>
                </label>
                <label class="checkbox_label"><input type="checkbox" data-k="cleanup"> Clean up new images (fill holes, remove stray pixels)</label>
                <label>Messages the pick reads <input class="text_pole" type="number" min="1" max="12" data-k="contextMessages"></label>
                <hr>
                <b>Images</b>
                <small>Images in the same <b>group</b> are variants of one action. The AI picks the group, then the variant that fits right now; the <b>Default</b> is used when no variant applies. Variants can have conditions: <b>Only with</b> (character names) and <b>Needs trait or effect</b> (a plain description, keywords like fox ears|kitsune, or a SillyStatus effect like Hypnosis&gt;=4). Use GIFs with a transparent background.</small>
                <div id="ssb-slots"></div>
                <div class="ssb-row">
                    <button type="button" class="menu_button" id="ssb-add">Add group</button>
                    <button type="button" class="menu_button" id="ssb-stop">Stop preview</button>
                    <button type="button" class="menu_button" id="ssb-diagnose">Diagnose</button>
                </div>
                <pre id="ssb-diag" class="ssb-diag" hidden></pre>
            </div>
        </div>`;
    host.appendChild(wrap);

    const showVal = () => {
        for (const el of wrap.querySelectorAll('[data-v]')) {
            const k = el.dataset.v;
            el.textContent = k === 'softness' || k === 'glow' ? `${s[k]}px` : `${s[k]}%`;
        }
    };
    for (const input of wrap.querySelectorAll('[data-k]')) {
        const k = input.dataset.k;
        if (input.type === 'checkbox') input.checked = !!s[k];
        else input.value = s[k];
        const onChange = () => {
            if (input.type === 'checkbox') s[k] = input.checked;
            else if (input.type === 'range' || input.type === 'number') {
                const n = Math.round(Number(input.value));
                s[k] = Math.min(Number(input.max), Math.max(Number(input.min), Number.isFinite(n) ? n : DEFAULTS[k]));
            } else s[k] = input.value;
            showVal();
            save();
            if (k === 'silhouette') renderSlots();
            shownSlot = null;
            refresh();
        };
        input.addEventListener(input.type === 'range' || input.type === 'color' ? 'input' : 'change', onChange);
    }
    showVal();
    renderSlots();

    wrap.querySelector('#ssb-chat-toggle').addEventListener('click', () => setChatOn(!chatOn()));
    wrap.querySelector('#ssb-pick-now').addEventListener('click', () => {
        const chat = ctx().chat ?? [];
        let i = chat.length - 1;
        while (i >= 0 && (chat[i].is_user || chat[i].is_system)) i--;
        if (i < 0) toast('info', 'There is no character reply yet.');
        else if (!chatOn()) toast('info', 'Turn it on in this chat first.');
        else runPick(i, true);
    });
    wrap.querySelector('#ssb-clear').addEventListener('click', async () => {
        const chat = ctx().chat ?? [];
        if (chat.length) await writeScene(chat.length - 1, null);
        refresh();
    });
    wrap.querySelector('#ssb-add').addEventListener('click', () => {
        const n = s.slots.reduce((m, sl) => Math.max(m, Number(sl.id.slice(1)) || 0), 0) + 1;
        s.slots.push({ id: `s${n}`, label: '', group: '', hint: '', path: '', onlyWith: '', needsEffect: '', isDefault: true });
        save();
        renderSlots();
    });
    wrap.querySelector('#ssb-diagnose').addEventListener('click', async () => {
        const out = wrap.querySelector('#ssb-diag');
        out.hidden = false;
        out.textContent = 'Checking…';
        out.textContent = await diagnose();
    });
    wrap.querySelector('#ssb-stop').addEventListener('click', () => {
        preview = null;
        shownSlot = null;
        refresh();
    });

    const slots = wrap.querySelector('#ssb-slots');
    slots.addEventListener('change', async (event) => {
        const row = event.target.closest('.ssb-slot');
        const slot = s.slots.find(sl => sl.id === row?.dataset.slot);
        if (!slot) return;
        if (event.target.type === 'file') {
            const file = event.target.files?.[0];
            if (!file) return;
            try {
                toast('info', 'Uploading…');
                await uploadImage(slot, file);
                toast('success', 'Image saved.');
                renderSlots();
                shownSlot = null;
                refresh();
            } catch (err) {
                console.error('[Scene Backdrop] upload failed', err);
                toast('error', `Upload failed: ${err?.message ?? err}`);
            }
            return;
        }
        const f = event.target.dataset.f;
        if (f === 'aiConfirm') {
            slot.aiConfirm = event.target.checked;
            save();
            renderStatus();
            return;
        }
        if (f === 'isDefault') {
            const on = event.target.checked;
            if (on) for (const other of s.slots) if (other !== slot && groupName(other) === groupName(slot)) other.isDefault = false;
            slot.isDefault = on;
            save();
            renderSlots();
            shownSlot = null;
            refresh();
            return;
        }
        if (f === 'group' || f === 'label') {
            const oldGroup = groupName(slot);
            slot[f] = event.target.value.trim();
            // A default that moved to a group that already has one stops being default there.
            if (slot.isDefault && groupName(slot) !== oldGroup && s.slots.some(o => o !== slot && o.isDefault && groupName(o) === groupName(slot))) slot.isDefault = false;
            save();
            renderSlots();
            renderStatus();
            return;
        }
        if (f) {
            slot[f] = event.target.value.trim();
            save();
            renderStatus();
        }
    });
    slots.addEventListener('click', async (event) => {
        const btn = event.target.closest('button[data-a]');
        if (!btn) return;
        if (btn.dataset.a === 'add-variant') {
            const n = s.slots.reduce((m, sl) => Math.max(m, Number(sl.id.slice(1)) || 0), 0) + 1;
            const group = btn.dataset.group;
            s.slots.push({ id: `s${n}`, label: `${group} variant`, group, hint: '', path: '', onlyWith: '', needsEffect: '', isDefault: false });
            save();
            renderSlots();
            return;
        }
        const row = btn.closest('.ssb-slot');
        const slot = s.slots.find(sl => sl.id === row?.dataset.slot);
        if (!slot) return;
        const a = btn.dataset.a;
        if (a === 'preview') {
            preview = slot.id;
            shownSlot = null;
            refresh();
            toast('info', 'Previewing. Close this panel to see it, then tap Stop preview.');
        } else if (a === 'use') {
            const chat = ctx().chat ?? [];
            if (!chat.length || !slot.label.trim()) return;
            await writeScene(chat.length - 1, slot.label.trim());
            preview = null;
            refresh();
        } else if (a === 'clean') {
            btn.disabled = true;
            try {
                await recleanSlot(slot);
                toast('success', 'Cleaned up.');
            } catch (err) {
                console.error('[Scene Backdrop] clean-up failed', err);
                toast('error', `Clean-up failed: ${err?.message ?? err}`);
            }
            renderSlots();
            shownSlot = null;
            refresh();
        } else if (a === 'remove') {
            if (!btn.classList.contains('ssb-sure')) {
                btn.classList.add('ssb-sure');
                btn.textContent = 'Sure?';
                return;
            }
            s.slots = s.slots.filter(sl => sl !== slot);
            dropFile(slot.path);
            dropFile(slot.sheet?.path);
            save();
            renderSlots();
            refresh();
        }
    });
}

// ---------- diagnostics ----------

function loadImage(url) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(`loads (${img.naturalWidth}x${img.naturalHeight})`);
        img.onerror = () => resolve('FAILS to load');
        img.src = url;
        setTimeout(() => resolve('timed out'), 8000);
    });
}

async function diagnose() {
    const s = settings();
    const lines = [`clean-up supported: ${canCleanUp()}`, `v${VERSION} · enabled ${s.enabled} · chat on ${chatOn()} · scene ${currentScene() ?? 'none'} · preview ${preview ?? 'off'}`];
    lines.push(`look: silhouette ${s.silhouette}, colour ${s.color}, strength ${s.opacity}%, size ${s.size}%, glow ${s.glow}px ${s.glowColor}`);
    const chatEl = document.getElementById('chat');
    if (!chatEl) lines.push('chat area: missing');
    else {
        const r = chatEl.getBoundingClientRect();
        const cs = getComputedStyle(chatEl);
        lines.push(`chat area: ${Math.round(r.width)}x${Math.round(r.height)}, align-items ${cs.alignItems}, bg ${cs.backgroundColor}`);
        const h = document.getElementById('ssb-holder');
        if (!h) lines.push('layer: missing');
        else {
            const st = h.querySelector('.ssb-stage');
            const sr = st.getBoundingClientRect();
            const hr = h.getBoundingClientRect();
            lines.push(`layer: first in chat ${chatEl.firstElementChild === h}, holder ${Math.round(hr.width)}px wide, stage ${Math.round(sr.width)}x${Math.round(sr.height)} at y${Math.round(sr.top)}, opacity ${getComputedStyle(st).opacity}`);
            const on = h.querySelector('.ssb-fig.ssb-on');
            if (!on) lines.push('figure: none showing');
            else {
                const fcs = getComputedStyle(on);
                lines.push(`figure: opacity ${fcs.opacity}, mask ${(fcs.webkitMaskImage || fcs.maskImage || 'none').slice(0, 70)}`);
            }
        }
    }
    for (const sl of s.slots.filter(x => x.path)) {
        const url = urlOf(sl.path);
        lines.push(`${sl.label}: ${url} → ${await loadImage(url)}${sl.sheet ? ` · cleaned ${sl.sheet.n} frames ${sl.sheet.fw}x${sl.sheet.fh}, sheet ${await loadImage(urlOf(sl.sheet.path))}` : ' · not cleaned'}`);
    }
    if (!s.slots.some(x => x.path)) lines.push('no images uploaded yet');
    for (const g of pickPlan()) {
        lines.push(`group ${g.name}: default ${g.def?.label ?? 'none'}${g.variants.length ? `; variants available now: ${g.variants.map(v => `${v.slot.label}${v.cond.confirm ? ' (AI confirms)' : ' (certain)'}`).join(', ')}` : ''}`);
    }
    const effects = activeEffects();
    lines.push(`SillyStatus: ${effects ? `${effects.length} active effect(s)${effects.length ? ': ' + effects.map(e => `${e.icon ?? ''}${e.name} ${e.stage}/${e.max}`).join(', ') : ''}` : 'not found'}`);
    for (const sl of s.slots) {
        const c = conditionsOf(sl);
        if (c.conditional) lines.push(`${sl.label}: ${c.met ? 'available' : 'not available'} (${c.why})`);
    }
    return lines.join('\n');
}

// Quick on/off in the wand menu next to the message box.
function buildMenuItem() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('ssb-menu-item')) return;
    const item = document.createElement('div');
    item.id = 'ssb-menu-item';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = '<div class="fa-solid fa-image extensionsMenuExtensionButton"></div><span>Scene backdrop</span>';
    item.addEventListener('click', () => setChatOn(!chatOn()));
    menu.appendChild(item);
}

// ---------- wiring ----------

function refresh() {
    renderBackdrop();
    renderStatus();
}

let observer = null;
function watchChat() {
    const chatEl = document.getElementById('chat');
    if (!chatEl || observer) return;
    observer = new MutationObserver(() => {
        if (holder && chatEl.firstElementChild !== holder) {
            ensureHolder();
        }
    });
    observer.observe(chatEl, { childList: true });
    new ResizeObserver(() => {
        ensureHolder();
        for (const f of figures) if (f.slot) f.layout();
    }).observe(chatEl);
}

let statusTimer = null;
document.addEventListener('sillystatus:changed', () => {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(refresh, 150);
});

function wireEvents() {
    const { eventSource, event_types: ev } = ctx();
    eventSource.on(ev.CHAT_CHANGED, () => {
        armed = false;
        preview = null;
        shownSlot = null;
        refresh();
    });
    eventSource.on(ev.GENERATION_STARTED, (type, _o, dryRun) => {
        if (dryRun || type === 'quiet' || type === 'impersonate') return;
        armed = true;
    });
    eventSource.on(ev.GENERATION_STOPPED, () => {
        armed = false;
    });
    eventSource.on(ev.CHARACTER_MESSAGE_RENDERED, (messageId) => {
        const index = Number(messageId);
        const shouldPick = armed && index === (ctx().chat ?? []).length - 1;
        armed = false;
        refresh();
        if (shouldPick) runPick(index);
    });
    for (const name of ['MESSAGE_SWIPED', 'MESSAGE_DELETED', 'MESSAGE_EDITED']) {
        if (ev[name]) eventSource.on(ev[name], () => refresh());
    }
}

jQuery(() => {
    try {
        settings();
        buildSettings();
        buildMenuItem();
        watchChat();
        wireEvents();
        refresh();
    } catch (err) {
        console.error('[Scene Backdrop] failed to start', err);
    }
});
