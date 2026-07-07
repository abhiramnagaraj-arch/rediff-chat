import { getCurrentJid } from '../rediff-shared/index.js';

const STORAGE_KEY = 'rediff_overlay_state_v2';
const LEGACY_STORAGE_KEY = 'rediff_overlay_state_v1';
const MAX_RECENT = 8;
const MAX_ROSTER = 10;
const MAX_MESSAGES = 12;
const MAX_SEARCH_RESULTS = 10;
const DEFAULT_WINDOW_ORDER_STEP = 1000;
const EMOJI_OPTIONS = ['😀', '😁', '😂', '🤣', '😊', '😍', '😘', '😎', '🥳', '🤔', '👍', '🙏', '🎉', '🔥', '💡', '❤️'];

const escapeHTML = (value) =>
    String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

const getMessageText = (message) =>
    String(message?.get?.('body') || message?.get?.('message') || message?.get?.('plaintext') || '').trim();

const IMAGE_URL_PATTERN = /\.(?:png|jpe?g|gif|webp|bmp|svg)(?:[?#].*)?$/i;

const isImageURL = (value) => {
    if (!value) return false;
    try {
        return IMAGE_URL_PATTERN.test(new URL(value, window.location.href).pathname);
    } catch (error) {
        return IMAGE_URL_PATTERN.test(String(value));
    }
};

const getMessageImageURL = (message) => message?.get?.('oob_url') || getMessageText(message);

const getTimestamp = (message) => {
    const value = message?.get?.('time') || message?.get?.('edited') || message?.get?.('received') || message?.get?.('created');
    const stamp = value ? new Date(value).getTime() : Number.NaN;
    return Number.isNaN(stamp) ? 0 : stamp;
};

const formatTime = (message) => {
    const stamp = getTimestamp(message);
    if (!stamp) return '';
    return new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' }).format(new Date(stamp));
};

const getChatName = (model) =>
    model?.getDisplayName?.() || model?.get?.('name') || model?.get?.('fullname') || model?.get?.('jid') || 'Conversation';

const getPresenceLabel = (contact) => {
    const value = String(contact?.get?.('presence') || contact?.get?.('show') || 'offline').toLowerCase();
    return (
        {
            online: 'Active',
            chat: 'Active',
            away: 'Away',
            xa: 'Away',
            dnd: 'Busy',
            unavailable: 'Offline',
            offline: 'Offline',
        }[value] || 'Offline'
    );
};

const getPresenceClass = (contact) => {
    const value = String(contact?.get?.('presence') || contact?.get?.('show') || 'offline').toLowerCase();
    return ['chat', 'online', 'away', 'xa', 'dnd'].includes(value) ? value : 'offline';
};

const bareJid = (jid) => String(jid || '').split('/')[0];

const getInitial = (model) => getChatName(model).trim().slice(0, 1).toUpperCase() || '?';

const getActiveChatCandidate = (chatboxes) =>
    chatboxes.find((chat) => !chat.get('closed')) || chatboxes[0] || null;

const getWindowId = (jid) => bareJid(jid);

export class RediffOverlay extends HTMLElement {
    constructor() {
        super();
        this.api = null;
        this._converse = null;
        this.actions = {};
        this.state = {
            hub_open: false,
            windows: [],
            active_jid: '',
            query: '',
            emoji_picker_jid: '',
            drafts: {},
            pending_images: {},
        };
        this.messageListeners = new Map();
        this.collectionListeners = [];
        this.renderQueued = false;
        this.shouldScrollToBottom = false;
        this.shouldRefocusSearch = false;
        this.searchSelection = null;
        this.onClick = (ev) => this.handleClick(ev);
        this.onInput = (ev) => this.handleInput(ev);
        this.onChange = (ev) => this.handleChange(ev);
        this.onKeyDown = (ev) => this.handleKeyDown(ev);
        this.onSubmit = (ev) => this.handleSubmit(ev);
        this.onDocumentPointerDown = (ev) => this.handleDocumentPointerDown(ev);
    }

    connectedCallback() {
        if (this.connected) return;
        this.connected = true;
        this.className = 'rediff-overlay-host';
        this.addEventListener('click', this.onClick);
        this.addEventListener('input', this.onInput);
        this.addEventListener('change', this.onChange);
        this.addEventListener('keydown', this.onKeyDown);
        this.addEventListener('submit', this.onSubmit);
        document.addEventListener('pointerdown', this.onDocumentPointerDown);
        this.restoreState();
        this.render();
    }

    disconnectedCallback() {
        this.connected = false;
        this.removeEventListener('click', this.onClick);
        this.removeEventListener('input', this.onInput);
        this.removeEventListener('change', this.onChange);
        this.removeEventListener('keydown', this.onKeyDown);
        this.removeEventListener('submit', this.onSubmit);
        document.removeEventListener('pointerdown', this.onDocumentPointerDown);
        Object.values(this.state.pending_images || {}).forEach((images) => this.revokePendingImages(images));
        this.unbindCollections();
    }

    setContext(api, _converse, actions = {}) {
        this.api = api;
        this._converse = _converse;
        this.actions = actions;
        this.bindCollections();
        this.ensureActiveChat();
        this.queueRender();
    }

    restoreState() {
        try {
            const persisted =
                JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null') ||
                JSON.parse(window.localStorage.getItem(LEGACY_STORAGE_KEY) || '{}');
            const legacyOpen = Boolean(persisted?.open || persisted?.window_open);
            const legacyJid = persisted?.active_jid ? bareJid(persisted.active_jid) : '';
            const legacyType = persisted?.active_type || 'chat';
            const legacyWindows =
                Array.isArray(persisted?.windows) && persisted.windows.length
                    ? persisted.windows
                    : legacyOpen && legacyJid
                      ? [
                            {
                                jid: legacyJid,
                                type: legacyType,
                                minimized: Boolean(persisted?.minimized),
                                order: Date.now(),
                            },
                        ]
                      : [];
            this.state = {
                ...this.state,
                ...(persisted && typeof persisted === 'object' ? persisted : {}),
                windows: this.normalizeWindows(legacyWindows),
                drafts: persisted?.drafts || {},
            };
        } catch (error) {
            console.warn('Unable to restore Rediff overlay state', error);
        }
    }

    persistState() {
        try {
            window.localStorage.setItem(
                STORAGE_KEY,
                JSON.stringify({
                    windows: this.state.windows,
                    active_jid: this.state.active_jid,
                    hub_open: this.state.hub_open,
                    drafts: this.state.drafts,
                }),
            );
        } catch (error) {
            console.warn('Unable to persist Rediff overlay state', error);
        }
    }

    setState(nextState) {
        this.state = { ...this.state, ...nextState };
        this.persistState();
        this.queueRender();
    }

    getDraft(jid) {
        return this.state.drafts?.[getWindowId(jid)] || '';
    }

    setDraft(jid, value) {
        const target = getWindowId(jid);
        if (!target) return;
        this.state.drafts = {
            ...(this.state.drafts || {}),
            [target]: value,
        };
        this.persistState();
    }

    updateDraft(jid, updater) {
        const target = getWindowId(jid);
        if (!target) return '';
        const next = updater(this.getDraft(target));
        this.setDraft(target, next);
        return next;
    }

    normalizeWindows(windows = []) {
        const seen = new Set();
        return windows
            .map((entry, index) => ({
                jid: bareJid(entry?.jid),
                type: entry?.type === 'groupchat' ? 'groupchat' : 'chat',
                minimized: Boolean(entry?.minimized),
                order: Number.isFinite(Number(entry?.order)) ? Number(entry.order) : (index + 1) * DEFAULT_WINDOW_ORDER_STEP,
            }))
            .filter((entry) => {
                if (!entry.jid || seen.has(entry.jid)) return false;
                seen.add(entry.jid);
                return true;
            })
            .sort((a, b) => a.order - b.order);
    }

    getWindows() {
        return this.normalizeWindows(this.state.windows).map((window) => ({
            ...window,
            chat: this.findChatbox(window.jid),
        }));
    }

    getWindow(jid) {
        return this.getWindows().find((window) => window.jid === getWindowId(jid)) || null;
    }

    setWindows(windows) {
        this.state.windows = this.normalizeWindows(windows);
        this.ensureActiveChat();
        this.persistState();
        this.queueRender();
    }

    upsertWindow(jid, type = 'chat', patch = {}) {
        const target = getWindowId(jid);
        if (!target) return;
        const windows = [...this.state.windows];
        const index = windows.findIndex((window) => window.jid === target);
        const order = Date.now();
        if (index >= 0) {
            windows[index] = {
                ...windows[index],
                type: type === 'groupchat' ? 'groupchat' : windows[index].type || 'chat',
                ...patch,
                jid: target,
                order: patch.order ?? order,
            };
        } else {
            windows.push({
                jid: target,
                type: type === 'groupchat' ? 'groupchat' : 'chat',
                minimized: Boolean(patch.minimized),
                order,
            });
        }
        this.setWindows(windows);
    }

    minimizeWindow(jid) {
        const target = getWindowId(jid);
        if (!target) return;
        this.upsertWindow(target, this.getWindow(target)?.type || 'chat', { minimized: true, order: Date.now() });
        if (this.state.active_jid === target) {
            this.state.active_jid = this.getWindows().find((window) => !window.minimized)?.jid || target;
            this.persistState();
        }
    }

    restoreWindow(jid) {
        const target = getWindowId(jid);
        if (!target) return;
        this.upsertWindow(target, this.getWindow(target)?.type || 'chat', {
            minimized: false,
            order: Date.now(),
        });
        this.state.active_jid = target;
        this.persistState();
    }

    closeWindow(jid) {
        const target = getWindowId(jid);
        if (!target) return;
        this.setWindows(this.state.windows.filter((window) => window.jid !== target));
    }

    focusWindow(jid) {
        const target = getWindowId(jid);
        if (!target) return;
        const window = this.getWindow(target);
        if (!window) return;
        this.upsertWindow(target, window.type, { minimized: false, order: Date.now() });
        this.state.active_jid = target;
        this.persistState();
    }

    bindCollections() {
        this.unbindCollections();
        const chatboxes = this._converse?.state?.chatboxes;
        const roster = this._converse?.roster;
        if (chatboxes) {
            const handler = () => {
                this.bindMessageCollections();
                this.ensureActiveChat();
                this.shouldScrollToBottom = true;
                this.queueRender();
            };
            chatboxes.on('add remove reset sort change:hidden change:closed change:num_unread change:num_unread_general', handler);
            this.collectionListeners.push([chatboxes, 'add remove reset sort change:hidden change:closed change:num_unread change:num_unread_general', handler]);
            this.bindMessageCollections();
        }
        if (roster) {
            const handler = () => this.queueRender();
            roster.on('add remove reset sort change:num_unread change:presence change:show change:fullname', handler);
            this.collectionListeners.push([roster, 'add remove reset sort change:num_unread change:presence change:show change:fullname', handler]);
        }
    }

    unbindCollections() {
        this.collectionListeners.forEach(([collection, events, handler]) => collection?.off?.(events, handler));
        this.collectionListeners = [];
        this.messageListeners.forEach(({ messages, handler }) => messages?.off?.('add remove reset change', handler));
        this.messageListeners.clear();
    }

    bindMessageCollections() {
        const chatboxes = this.getRecentChatboxes();
        const live = new Set(chatboxes.map((chat) => chat.cid));
        chatboxes.forEach((chat) => {
            if (this.messageListeners.has(chat.cid) || !chat.messages) return;
            const handler = () => {
                this.ensureActiveChat();
                this.shouldScrollToBottom = true;
                this.queueRender();
            };
            chat.messages.on('add remove reset change', handler);
            this.messageListeners.set(chat.cid, { messages: chat.messages, handler });
        });
        [...this.messageListeners.keys()].forEach((cid) => {
            if (live.has(cid)) return;
            const listener = this.messageListeners.get(cid);
            listener?.messages?.off?.('add remove reset change', listener.handler);
            this.messageListeners.delete(cid);
        });
    }

    getRecentChatboxes() {
        const chatboxes = this._converse?.state?.chatboxes?.models || [];
        return chatboxes
            .filter((chat) => chat.get('id') !== 'controlbox' && !chat.get('closed'))
            .sort((a, b) => this.getChatSortScore(b) - this.getChatSortScore(a));
    }

    getChatSortScore(chat) {
        const unread = (chat.get('num_unread') || 0) + (chat.get('num_unread_general') || 0);
        const messages = chat.messages?.models || [];
        return unread * 1e13 + getTimestamp(messages[messages.length - 1]);
    }

    getContacts() {
        return [...(this._converse?.roster?.models || [])]
            .filter((contact) => contact.get('jid') && contact.get('jid') !== getCurrentJid(this.api) && !contact.get('requesting'))
            .sort((a, b) => getChatName(a).localeCompare(getChatName(b), undefined, { sensitivity: 'base' }));
    }

    ensureActiveChat() {
        const recent = this.getRecentChatboxes();
        const windows = this.state.windows.filter((window) => recent.some((chat) => bareJid(chat.get('jid')) === window.jid));
        if (windows.length !== this.state.windows.length) {
            this.state.windows = this.normalizeWindows(windows);
        }
        if (this.state.active_jid && recent.some((chat) => bareJid(chat.get('jid')) === bareJid(this.state.active_jid))) return;
        const candidate = this.getWindows().find((window) => !window.minimized) || getActiveChatCandidate(recent);
        const jid = candidate?.jid || candidate?.get?.('jid') || '';
        if (jid !== this.state.active_jid) {
            this.state.active_jid = jid;
            this.persistState();
        }
    }

    findChatbox(jid) {
        const target = bareJid(jid);
        return (this._converse?.state?.chatboxes?.models || []).find((chat) => bareJid(chat.get('jid')) === target) || null;
    }

    getActiveChat() {
        return this.findChatbox(this.state.active_jid) || null;
    }

    getActiveWindow() {
        return this.getWindow(this.state.active_jid) || this.getWindows().find((window) => !window.minimized) || null;
    }

    getUnreadCount() {
        return this.getRecentChatboxes().reduce(
            (count, chat) => count + (chat.get('num_unread') || 0) + (chat.get('num_unread_general') || 0),
            0,
        );
    }

    getFilteredRecents() {
        const query = this.state.query.trim().toLowerCase();
        const items = this.getRecentChatboxes();
        if (!query) return items.slice(0, MAX_RECENT);
        return items
            .filter((chat) => `${getChatName(chat)} ${chat.get('jid')}`.toLowerCase().includes(query))
            .slice(0, MAX_SEARCH_RESULTS);
    }

    getFilteredContacts() {
        const query = this.state.query.trim().toLowerCase();
        const activeJids = new Set(this.getRecentChatboxes().map((chat) => bareJid(chat.get('jid'))));
        const contacts = this.getContacts();
        const filtered = query
            ? contacts.filter((contact) => `${getChatName(contact)} ${contact.get('jid')}`.toLowerCase().includes(query))
            : contacts;
        return filtered
            .filter((contact) => !activeJids.has(bareJid(contact.get('jid'))) || contact.get('num_unread'))
            .slice(0, MAX_ROSTER);
    }

    getSearchResults() {
        const query = this.state.query.trim().toLowerCase();
        if (!query) return [];

        const results = [];
        const seen = new Set();
        const push = (item) => {
            if (!item?.jid || seen.has(bareJid(item.jid)) || results.length >= MAX_SEARCH_RESULTS) return;
            seen.add(bareJid(item.jid));
            results.push(item);
        };

        this.getRecentChatboxes().forEach((chat) => {
            const haystack = `${getChatName(chat)} ${chat.get('jid')}`.toLowerCase();
            if (!haystack.includes(query)) return;
            const messages = chat.messages?.models || [];
            const lastMessage = [...messages].reverse().find((message) => getMessageText(message));
            push({
                jid: chat.get('jid'),
                name: getChatName(chat),
                type: chat.get('type') || 'chat',
                meta: lastMessage ? getMessageText(lastMessage).slice(0, 48) : chat.get('type') === 'groupchat' ? 'Group quick chat' : 'Direct quick chat',
                unread: (chat.get('num_unread') || 0) + (chat.get('num_unread_general') || 0),
                time: formatTime(lastMessage),
            });
        });

        this.getContacts().forEach((contact) => {
            const haystack = `${getChatName(contact)} ${contact.get('jid')}`.toLowerCase();
            if (!haystack.includes(query)) return;
            push({
                jid: contact.get('jid'),
                name: getChatName(contact),
                type: 'chat',
                meta: getPresenceLabel(contact),
                unread: contact.get('num_unread') || 0,
                presenceClass: getPresenceClass(contact),
            });
        });

        return results;
    }

    queueRender() {
        if (this.renderQueued) return;
        this.renderQueued = true;
        window.requestAnimationFrame(() => {
            this.renderQueued = false;
            this.render();
        });
    }

    restoreSearchFocus() {
        if (!this.shouldRefocusSearch) return;
        this.shouldRefocusSearch = false;
        const input = this.querySelector('.rediff-overlay-hub__search input');
        if (!input) return;
        input.focus();
        if (this.searchSelection) {
            input.setSelectionRange(this.searchSelection.start, this.searchSelection.end);
        }
    }

    async ensureChatModel(jid, type = 'chat') {
        if (!jid || !this.api) return null;
        const existing = this.findChatbox(jid);
        if (existing) {
            existing.save({ closed: false });
            return existing;
        }
        if (type === 'groupchat') {
            return this.api.rooms.open(jid, { hidden: true }, false);
        }
        return this.api.chats.get(jid, { hidden: true }, true);
    }

    async openQuickChat(jid, type = 'chat') {
        const chat = await this.ensureChatModel(jid, type);
        if (!chat) return;
        this.upsertWindow(chat.get('jid') || jid, type, { minimized: false, order: Date.now() });
        this.setState({
            active_jid: chat.get('jid') || jid,
            hub_open: true,
        });
    }

    async openWorkspaceChat(jid, type = 'chat') {
        if (!jid || !this.api) return;
        if (type === 'groupchat') {
            await this.api.rooms.open(jid, {}, true);
        } else {
            await this.api.chats.open(jid, {}, true);
        }
        this.upsertWindow(jid, type, { minimized: false, order: Date.now() });
        this.setState({
            active_jid: jid,
            hub_open: true,
        });
    }

    getPendingImages(jid) {
        return this.state.pending_images?.[getWindowId(jid)] || [];
    }

    revokePendingImages(images = []) {
        images.forEach((entry) => {
            if (entry.preview_url) URL.revokeObjectURL(entry.preview_url);
        });
    }

    setPendingImages(jid, files) {
        const target = getWindowId(jid);
        if (!target) return;
        const previous = this.getPendingImages(target);
        this.revokePendingImages(previous);
        this.state.pending_images = {
            ...(this.state.pending_images || {}),
            [target]: files.map((file) => ({ file, preview_url: URL.createObjectURL(file) })),
        };
        this.queueRender();
    }

    clearPendingImages(jid) {
        const target = getWindowId(jid);
        if (!target) return;
        this.revokePendingImages(this.getPendingImages(target));
        const next = { ...(this.state.pending_images || {}) };
        delete next[target];
        this.state.pending_images = next;
        const input = this.getMessageFileInput(target);
        if (input) input.value = '';
        this.queueRender();
    }

    removePendingImage(jid, index) {
        const target = getWindowId(jid);
        const pending = [...this.getPendingImages(target)];
        const [removed] = pending.splice(index, 1);
        if (removed?.preview_url) URL.revokeObjectURL(removed.preview_url);
        if (pending.length) {
            this.state.pending_images = { ...(this.state.pending_images || {}), [target]: pending };
            this.queueRender();
        } else {
            this.clearPendingImages(target);
        }
    }

    async sendPendingImages(jid) {
        const target = getWindowId(jid);
        const window = this.getWindow(target);
        const files = this.getPendingImages(target).map((entry) => entry.file);
        if (window?.chat && files.length) {
            await window.chat.sendFiles(files);
            this.clearPendingImages(target);
            this.shouldScrollToBottom = true;
        }
    }

    getMessageFileInput(window_jid) {
        return this.querySelector(`input[data-rediff-overlay-file-input="${window_jid}"]`);
    }

    insertEmoji(textarea) {
        if (!textarea) return;
        const emoji = EMOJI_OPTIONS[0];
        const start = textarea.selectionStart ?? textarea.value.length;
        const end = textarea.selectionEnd ?? textarea.value.length;
        textarea.setRangeText(emoji, start, end, 'end');
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.focus();
    }

    handleFileSelection(ev) {
        const input = /** @type {HTMLInputElement} */ (ev.target);
        const jid = input.getAttribute('data-rediff-overlay-file-input');
        const files = Array.from(input.files || []).filter((file) => file.type?.startsWith('image/'));
        if (jid && files.length) this.setPendingImages(jid, files);
    }

    async handleSubmit(ev) {
        const form = ev.target.closest?.('.rediff-overlay-window__composer');
        if (!form) return;
        ev.preventDefault();
        const jid = form.closest('.rediff-overlay-window')?.getAttribute('data-jid');
        const activeChat = this.findChatbox(jid || this.state.active_jid);
        const textarea = form.querySelector('textarea');
        const body = textarea?.value?.trim();
        if (!activeChat || !body) return;
        await activeChat.sendMessage({ body });
        textarea.value = '';
        if (jid) this.setDraft(jid, '');
        if (this.state.emoji_picker_jid) {
            this.setState({ emoji_picker_jid: '' });
        }
        this.shouldScrollToBottom = true;
        this.queueRender();
    }

    handleInput(ev) {
        if (ev.target.matches('.rediff-overlay-hub__search input')) {
            this.shouldRefocusSearch = true;
            this.searchSelection = {
                start: ev.target.selectionStart ?? ev.target.value.length,
                end: ev.target.selectionEnd ?? ev.target.value.length,
            };
            this.state.query = ev.target.value;
            this.queueRender();
            return;
        }
        if (ev.target.matches('.rediff-overlay-window__composer textarea')) {
            const jid = ev.target.closest('.rediff-overlay-window')?.getAttribute('data-jid');
            if (jid) this.setDraft(jid, ev.target.value);
        }
    }

    handleChange(ev) {
        if (!ev.target.matches('input[type="file"][data-rediff-overlay-file-input]')) return;
        this.handleFileSelection(ev);
    }

    scrollVisibleWindowsToBottom() {
        window.requestAnimationFrame(() => {
            this.querySelectorAll('.rediff-overlay-window__messages').forEach((el) => {
                el.scrollTop = el.scrollHeight;
            });
        });
    }

    handleDocumentPointerDown(ev) {
        if (!this.state.hub_open) return;
        if (!this.contains(ev.target)) {
            this.setState({ hub_open: false, emoji_picker_jid: '' });
            return;
        }
        const picker = ev.target.closest?.('[data-rediff-overlay-emoji-picker]');
        const toggle = ev.target.closest?.('[data-rediff-overlay-emoji-button]');
        if (!picker && !toggle && this.state.emoji_picker_jid) {
            this.setState({ emoji_picker_jid: '' });
        }
    }

    async handleClick(ev) {
        const button = ev.target.closest('button, [role="button"], a');
        if (!button) return;

        if (button.matches('[data-rediff-overlay-toggle-hub]')) {
            this.setState({ hub_open: !this.state.hub_open });
            return;
        }
        if (button.matches('[data-rediff-overlay-close-hub]')) {
            this.setState({ hub_open: false, query: '', emoji_picker_jid: '' });
            return;
        }
        if (button.matches('[data-rediff-overlay-open-window]')) {
            const jid = button.getAttribute('data-jid');
            if (jid) this.restoreWindow(jid);
            this.setState({ emoji_picker_jid: '' });
            this.shouldScrollToBottom = true;
            return;
        }
        if (button.matches('[data-rediff-overlay-minimize-window]')) {
            const jid = button.getAttribute('data-jid');
            if (jid) this.minimizeWindow(jid);
            this.setState({ emoji_picker_jid: '' });
            return;
        }
        if (button.matches('[data-rediff-overlay-close-window]')) {
            const jid = button.getAttribute('data-jid');
            if (jid) this.closeWindow(jid);
            this.setState({ emoji_picker_jid: '' });
            return;
        }
        if (button.matches('[data-rediff-overlay-new-chat]')) {
            this.actions.openNewChat?.(ev);
            this.setState({ hub_open: false });
            return;
        }
        if (button.matches('[data-rediff-overlay-new-group]')) {
            this.actions.openGroups?.(ev);
            this.setState({ hub_open: false });
            return;
        }
        if (button.matches('[data-rediff-overlay-manage-participants]')) {
            const jid = button.getAttribute('data-jid');
            if (jid) this.actions.openParticipants?.(jid, ev);
            return;
        }
        if (button.matches('[data-rediff-overlay-open-workspace]')) {
            const jid = button.getAttribute('data-jid');
            const chat = jid ? this.findChatbox(jid) : null;
            if (chat) await this.openWorkspaceChat(chat.get('jid'), chat.get('type'));
            this.setState({ emoji_picker_jid: '' });
            return;
        }
        if (button.matches('[data-rediff-overlay-open-chat]')) {
            const jid = button.getAttribute('data-jid');
            const type = button.getAttribute('data-chat-type') || 'chat';
            await this.openQuickChat(jid, type);
            this.setState({ emoji_picker_jid: '' });
            return;
        }
        if (button.matches('[data-rediff-overlay-emoji-button]')) {
            const jid = button.getAttribute('data-jid');
            this.setState({
                emoji_picker_jid: this.state.emoji_picker_jid === getWindowId(jid) ? '' : getWindowId(jid),
            });
            return;
        }
        if (button.matches('[data-rediff-overlay-emoji-option]')) {
            const emoji = button.getAttribute('data-emoji') || '';
            const jid = button.getAttribute('data-jid');
            const target_jid = getWindowId(jid);
            const textarea = this.querySelector(`textarea[data-rediff-overlay-textarea="${target_jid}"]`);
            if (emoji && target_jid) {
                const start = textarea?.selectionStart ?? this.getDraft(target_jid).length;
                const end = textarea?.selectionEnd ?? this.getDraft(target_jid).length;
                const next = this.updateDraft(target_jid, (draft) => `${draft.slice(0, start)}${emoji}${draft.slice(end)}`);
                if (textarea) {
                    textarea.value = next;
                    textarea.focus();
                }
            }
            this.setState({ emoji_picker_jid: '' });
            return;
        }
        if (button.matches('[data-rediff-overlay-remove-image]')) {
            const jid = button.getAttribute('data-jid');
            const index = Number(button.getAttribute('data-index'));
            this.removePendingImage(jid, index);
            return;
        }
        if (button.matches('[data-rediff-overlay-send-images]')) {
            const jid = button.getAttribute('data-jid');
            await this.sendPendingImages(jid);
            return;
        }
        if (button.matches('[data-rediff-overlay-file-button]')) {
            const jid = button.getAttribute('data-jid');
            this.setState({ emoji_picker_jid: '' });
            this.getMessageFileInput(getWindowId(jid))?.click();
            return;
        }
    }

    handleKeyDown(ev) {
        if (ev.key === 'Escape') {
            if (this.state.hub_open) {
                this.setState({ hub_open: false });
                return;
            }
            const activeWindow = this.getActiveWindow();
            if (activeWindow && !activeWindow.minimized) {
                this.minimizeWindow(activeWindow.jid);
                return;
            }
        }
        if (ev.target.matches('.rediff-overlay-window__composer textarea') && ev.key === 'Enter' && !ev.shiftKey) {
            ev.preventDefault();
            ev.target.closest('form')?.requestSubmit();
        }
    }

    renderListItem(item, options = {}) {
        const openWindow = this.getWindow(item.jid);
        const active = this.state.active_jid && bareJid(this.state.active_jid) === bareJid(item.jid);
        const isGroup = item.type === 'groupchat';
        const avatarClasses = ['rediff-overlay-list__avatar'];
        if (isGroup) {
            avatarClasses.push('is-group');
        } else if (item.presenceClass) {
            avatarClasses.push('is-presence', item.presenceClass);
        }
        return `
            <button type="button" class="rediff-overlay-list__item ${active || openWindow ? 'is-active' : ''}" data-rediff-overlay-open-chat data-jid="${escapeHTML(
            item.jid,
        )}" data-chat-type="${escapeHTML(item.type || 'chat')}">
                <span class="${avatarClasses.join(' ')}">${escapeHTML(getInitial(item))}</span>
                <span class="rediff-overlay-list__body">
                    <span class="rediff-overlay-list__title">${escapeHTML(item.name)}</span>
                    <span class="rediff-overlay-list__meta">${escapeHTML(item.meta || (isGroup ? 'Group quick chat' : 'Direct quick chat'))}</span>
                </span>
                <span class="rediff-overlay-list__aside">
                    ${options.showTime && item.time ? `<span class="rediff-overlay-list__time">${escapeHTML(item.time)}</span>` : ''}
                    ${item.unread ? `<span class="rediff-overlay-count">${item.unread > 99 ? '99+' : item.unread}</span>` : ''}
                </span>
            </button>
        `;
    }

    renderHubContent() {
        const query = this.state.query.trim();
        if (query) {
            const results = this.getSearchResults();
            return `
                <section class="rediff-overlay-hub__section">
                    <div class="rediff-overlay-hub__section-header">
                        <h3>Search results</h3>
                        <span>${results.length}</span>
                    </div>
                    <div class="rediff-overlay-hub__list">
                        ${results.length
                    ? results.map((item) => this.renderListItem(item, { showTime: true })).join('')
                    : '<p class="rediff-overlay-empty">No matching people, rooms, or recent chats.</p>'
                }
                    </div>
                </section>
            `;
        }

        const recents = this.getFilteredRecents().map((chat) => {
            const messages = chat.messages?.models || [];
            const lastMessage = [...messages].reverse().find((message) => getMessageText(message));
            return {
                jid: chat.get('jid'),
                name: getChatName(chat),
                type: chat.get('type') || 'chat',
                meta: lastMessage ? getMessageText(lastMessage).slice(0, 48) : chat.get('type') === 'groupchat' ? 'Group quick chat' : 'Start chatting',
                unread: (chat.get('num_unread') || 0) + (chat.get('num_unread_general') || 0),
                time: formatTime(lastMessage),
            };
        });
        const roster = this.getFilteredContacts().map((contact) => ({
            jid: contact.get('jid'),
            name: getChatName(contact),
            type: 'chat',
            meta: getPresenceLabel(contact),
            unread: contact.get('num_unread') || 0,
            presenceClass: getPresenceClass(contact),
        }));

        return `
            <section class="rediff-overlay-hub__section">
                <div class="rediff-overlay-hub__section-header">
                    <h3>Recent chats</h3>
                    <span>${recents.length}</span>
                </div>
                <div class="rediff-overlay-hub__list">
                    ${recents.length ? recents.map((item) => this.renderListItem(item, { showTime: true })).join('') : '<p class="rediff-overlay-empty">Start from the workspace once and conversations appear here.</p>'}
                </div>
            </section>
            <section class="rediff-overlay-hub__section">
                <div class="rediff-overlay-hub__section-header">
                    <h3>Roster</h3>
                    <span>${roster.length}</span>
                </div>
                <div class="rediff-overlay-hub__list">
                    ${roster.length ? roster.map((item) => this.renderListItem(item)).join('') : '<p class="rediff-overlay-empty">No additional contacts available in quick chat.</p>'}
                </div>
            </section>
        `;
    }

    renderWindow() {
        const windows = this.getWindows();
        if (!windows.length) return '';
        const activeWindows = windows.filter((window) => !window.minimized && window.chat);
        const minimizedWindows = windows.filter((window) => window.minimized && window.chat);

        const renderMessageMarkup = (chat) => {
            const messages = (chat.messages?.models || []).filter((message) => getMessageText(message)).slice(-MAX_MESSAGES);
            return messages.length
                ? messages
                      .map((message) => {
                          const own = message.get('sender') === 'me';
                          const author = own ? 'You' : message.get('from')?.split('@')[0] || getChatName(chat);
                          const text = getMessageText(message);
                          const imageURL = getMessageImageURL(message);
                          const bodyMarkup = isImageURL(imageURL)
                              ? `<a class="rediff-overlay-window__message-image" href="${escapeHTML(imageURL)}" target="_blank" rel="noopener"><img src="${escapeHTML(imageURL)}" alt="Shared image" /></a>`
                              : `<p class="rediff-overlay-window__message-body">${escapeHTML(text)}</p>`;
                          return `
                              <article class="rediff-overlay-window__message ${own ? 'is-own' : ''}">
                                  <p class="rediff-overlay-window__message-meta">${escapeHTML(author)}${formatTime(message) ? ` · ${escapeHTML(formatTime(message))}` : ''}</p>
                                  ${bodyMarkup}
                              </article>
                          `;
                      })
                      .join('')
                : '<p class="rediff-overlay-empty">No messages yet. Start here or continue in the main workspace.</p>';
        };

        return `
            <div class="rediff-overlay-window-group">
                <div class="rediff-overlay-window-group__active">
                    ${activeWindows
                        .map((window) => {
                            const activeChat = window.chat;
                            const isGroup = activeChat.get('type') === 'groupchat';
                            const pendingImages = this.getPendingImages(window.jid);
                            const pendingImageMarkup = pendingImages.length
                                ? `
                                    <div class="rediff-overlay-window__image-preview">
                                        <div class="rediff-overlay-window__image-preview-items">
                                            ${pendingImages
                                                .map(
                                                    (entry, index) => `
                                                        <div class="rediff-overlay-window__image-preview-item">
                                                            <img src="${escapeHTML(entry.preview_url)}" alt="${escapeHTML(entry.file.name || 'Selected image')}" />
                                                            <button type="button" data-rediff-overlay-remove-image data-jid="${escapeHTML(window.jid)}" data-index="${index}" aria-label="Remove image">×</button>
                                                        </div>
                                                    `,
                                                )
                                                .join('')}
                                        </div>
                                        <button type="button" class="rediff-overlay-window__image-preview-send" data-rediff-overlay-send-images data-jid="${escapeHTML(window.jid)}">Send</button>
                                    </div>
                                `
                                : '';
                            return `
                                <section class="rediff-overlay-window" data-jid="${escapeHTML(window.jid)}" aria-hidden="false">
                                    <header class="rediff-overlay-window__header">
                                        <button type="button" class="rediff-overlay-window__identity ${isGroup ? 'is-group' : ''}" data-rediff-overlay-open-workspace data-jid="${escapeHTML(window.jid)}">
                                            <span class="rediff-overlay-window__avatar">${escapeHTML(getInitial(activeChat))}</span>
                                            <span class="rediff-overlay-window__identity-copy">
                                                <span class="rediff-overlay-window__kicker">${isGroup ? 'Group quick chat' : 'Direct quick chat'}</span>
                                                <span class="rediff-overlay-window__title">${escapeHTML(getChatName(activeChat))}</span>
                                            </span>
                                        </button>
                                        <div class="rediff-overlay-window__actions">
                                            ${isGroup
                                                ? `<button type="button" class="rediff-overlay-window__action" data-rediff-overlay-manage-participants data-jid="${escapeHTML(window.jid)}">Members</button>`
                                                : ''
                                            }
                                            <button type="button" class="rediff-overlay-window__action" data-rediff-overlay-minimize-window data-jid="${escapeHTML(window.jid)}">_</button>
                                            <button type="button" class="rediff-overlay-window__action is-danger" data-rediff-overlay-close-window data-jid="${escapeHTML(window.jid)}">×</button>
                                        </div>
                                    </header>
                                    <div class="rediff-overlay-window__messages">${renderMessageMarkup(activeChat)}</div>
                                    <form class="rediff-overlay-window__composer" data-jid="${escapeHTML(window.jid)}">
                                        ${pendingImageMarkup}
                                        <div class="rediff-overlay-window__composer-actions">
                                            <div class="rediff-overlay-window__composer-tools">
                                                <button type="button" class="rediff-overlay-window__tool" data-rediff-overlay-emoji-button data-jid="${escapeHTML(window.jid)}" aria-label="Insert emoji" aria-expanded="${this.state.emoji_picker_jid === getWindowId(window.jid) ? 'true' : 'false'}">☺</button>
                                                <button type="button" class="rediff-overlay-window__tool" data-rediff-overlay-file-button data-jid="${escapeHTML(window.jid)}" aria-label="Send image" title="Send image">📎</button>
                                                <input type="file" accept="image/*" multiple hidden data-rediff-overlay-file-input="${escapeHTML(window.jid)}" />
                                            </div>
                                        </div>
                                        <div class="rediff-overlay-window__composer-body">
                                            <textarea rows="2" placeholder="Reply without leaving the current page" data-rediff-overlay-textarea="${escapeHTML(window.jid)}">${escapeHTML(this.getDraft(window.jid))}</textarea>
                                            <button type="submit" class="rediff-overlay-window__send">Send</button>
                                        </div>
                                        ${this.state.emoji_picker_jid === getWindowId(window.jid)
                                            ? `
                                                <div class="rediff-overlay-window__emoji-picker" data-rediff-overlay-emoji-picker>
                                                    ${EMOJI_OPTIONS.map(
                                                        (emoji) => `
                                                            <button
                                                                type="button"
                                                                class="rediff-overlay-window__emoji-option"
                                                                data-rediff-overlay-emoji-option
                                                                data-jid="${escapeHTML(window.jid)}"
                                                                data-emoji="${escapeHTML(emoji)}"
                                                                aria-label="Insert ${escapeHTML(emoji)}"
                                                            >${escapeHTML(emoji)}</button>
                                                        `,
                                                    ).join('')}
                                                </div>
                                            `
                                            : ''
                                        }
                                    </form>
                                </section>
                            `;
                        })
                        .join('')}
                </div>
                <div class="rediff-overlay-window-group__minimized">
                    ${minimizedWindows
                        .map(
                            (window) => `
                                <button type="button" class="rediff-overlay-window-chip" data-rediff-overlay-open-window data-jid="${escapeHTML(window.jid)}">
                                    <span class="rediff-overlay-window-chip__avatar">${escapeHTML(getInitial(window.chat))}</span>
                                    <span class="rediff-overlay-window-chip__copy">
                                        <span class="rediff-overlay-window-chip__title">${escapeHTML(getChatName(window.chat))}</span>
                                        <span class="rediff-overlay-window-chip__meta">${escapeHTML(window.type === 'groupchat' ? 'Group minimized' : 'Minimized')}</span>
                                    </span>
                                </button>
                            `,
                        )
                        .join('')}
                </div>
            </div>
        `;
    }

    render() {
        const unread = this.getUnreadCount();
        this.innerHTML = `
            <div class="rediff-overlay">
                <div class="rediff-overlay-stack">
                    <div class="rediff-overlay-shell ${this.state.hub_open ? 'is-open' : ''}">
                        ${this.renderWindow()}
                        ${this.state.hub_open
                ? `
                                    <section class="rediff-overlay-hub" aria-label="Quick chat hub">
                                        <header class="rediff-overlay-hub__header">
                                            <div>
                                                <p class="rediff-overlay-kicker">Rediff Enterprise</p>
                                                <h2>Quick chat</h2>
                                            </div>
                                            <button type="button" class="rediff-overlay-hub__close" data-rediff-overlay-close-hub aria-label="Close quick chat hub">×</button>
                                        </header>
                                        <div class="rediff-overlay-hub__actions">
                                            <button type="button" class="rediff-overlay-hub__cta is-primary" data-rediff-overlay-new-chat>New chat</button>
                                            <button type="button" class="rediff-overlay-hub__cta" data-rediff-overlay-new-group>New group</button>
                                        </div>
                                        <label class="rediff-overlay-hub__search">
                                            <span>Search chats and people</span>
                                            <input type="search" placeholder="Search quick chat" value="${escapeHTML(this.state.query)}" />
                                        </label>
                                        <div class="rediff-overlay-hub__content">
                                            ${this.renderHubContent()}
                                        </div>
                                    </section>
                                `
                : ''
            }
                    </div>
                    <button type="button" class="rediff-overlay-launcher" data-rediff-overlay-toggle-hub aria-label="Toggle quick chat">
                        <span class="rediff-overlay-launcher__pulse"></span>
                        <span class="rediff-overlay-launcher__copy">
                            <span class="rediff-overlay-launcher__title">Quick chat</span>
                            <span class="rediff-overlay-launcher__meta">${unread ? `${unread} unread` : 'Ready'}</span>
                        </span>
                        <span class="rediff-overlay-launcher__badge ${unread ? '' : 'is-hidden'}">${unread > 99 ? '99+' : unread}</span>
                    </button>
                </div>
            </div>
        `;
        this.restoreSearchFocus();
        if (this.shouldScrollToBottom) {
            this.shouldScrollToBottom = false;
            this.scrollVisibleWindowsToBottom();
        }
    }
}

export const defineRediffOverlay = (api, _converse, actions) => {
    if (!customElements.get('converse-rediff-overlay')) {
        customElements.define('converse-rediff-overlay', RediffOverlay);
    }

    let overlay = document.querySelector('converse-rediff-overlay');
    if (!overlay) {
        overlay = document.createElement('converse-rediff-overlay');
        document.body.append(overlay);
    }
    overlay.setContext(api, _converse, actions);
    return overlay;
};
