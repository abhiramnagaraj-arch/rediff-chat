import { getCurrentJid } from '../rediff-shared/index.js';

const STORAGE_KEY = 'rediff_overlay_state_v1';
const MAX_RECENT = 8;
const MAX_ROSTER = 10;
const MAX_MESSAGES = 10;

const escapeHTML = (value) =>
    String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

const getMessageText = (message) =>
    String(message?.get?.('body') || message?.get?.('message') || message?.get?.('plaintext') || '').trim();

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
            online: 'Online',
            chat: 'Online',
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

const getActiveChatCandidate = (chatboxes) =>
    chatboxes.find((chat) => !chat.get('hidden') && !chat.get('closed')) || chatboxes[0] || null;

export class RediffOverlay extends HTMLElement {
    constructor() {
        super();
        this.api = null;
        this._converse = null;
        this.actions = {};
        this.state = {
            open: false,
            minimized: false,
            active_jid: '',
            query: '',
        };
        this.messageListeners = new Map();
        this.collectionListeners = [];
        this.renderQueued = false;
        this.onClick = (ev) => this.handleClick(ev);
        this.onInput = (ev) => this.handleInput(ev);
        this.onKeyDown = (ev) => this.handleKeyDown(ev);
        this.onSubmit = (ev) => this.handleSubmit(ev);
    }

    connectedCallback() {
        if (this.connected) return;
        this.connected = true;
        this.className = 'rediff-overlay-host';
        this.addEventListener('click', this.onClick);
        this.addEventListener('input', this.onInput);
        this.addEventListener('keydown', this.onKeyDown);
        this.addEventListener('submit', this.onSubmit);
        this.restoreState();
        this.render();
    }

    disconnectedCallback() {
        this.connected = false;
        this.removeEventListener('click', this.onClick);
        this.removeEventListener('input', this.onInput);
        this.removeEventListener('keydown', this.onKeyDown);
        this.removeEventListener('submit', this.onSubmit);
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
            const persisted = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}');
            this.state = {
                ...this.state,
                ...(persisted && typeof persisted === 'object' ? persisted : {}),
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
                    open: this.state.open,
                    minimized: this.state.minimized,
                    active_jid: this.state.active_jid,
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

    bindCollections() {
        this.unbindCollections();
        const chatboxes = this._converse?.state?.chatboxes;
        const roster = this._converse?.roster;
        if (chatboxes) {
            const handler = () => {
                this.bindMessageCollections();
                this.ensureActiveChat();
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
        return [...(this._converse?.roster?.models || [])].sort((a, b) =>
            getChatName(a).localeCompare(getChatName(b), undefined, { sensitivity: 'base' }),
        );
    }

    ensureActiveChat() {
        const recent = this.getRecentChatboxes();
        if (this.state.active_jid && recent.some((chat) => chat.get('jid') === this.state.active_jid)) return;
        const active = getActiveChatCandidate(recent);
        if (active?.get('jid') !== this.state.active_jid) {
            this.state.active_jid = active?.get('jid') || '';
            this.persistState();
        }
    }

    getActiveChat() {
        return this.getRecentChatboxes().find((chat) => chat.get('jid') === this.state.active_jid) || null;
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
        return items.filter((chat) => {
            const haystack = `${getChatName(chat)} ${chat.get('jid')}`.toLowerCase();
            return haystack.includes(query);
        });
    }

    getFilteredContacts() {
        const query = this.state.query.trim().toLowerCase();
        const activeJids = new Set(this.getRecentChatboxes().map((chat) => chat.get('jid')));
        const contacts = this.getContacts().filter((contact) => contact.get('jid') !== getCurrentJid(this.api));
        const filtered = query
            ? contacts.filter((contact) => {
                  const haystack = `${getChatName(contact)} ${contact.get('jid')}`.toLowerCase();
                  return haystack.includes(query);
              })
            : contacts;
        return filtered
            .filter((contact) => !activeJids.has(contact.get('jid')) || contact.get('num_unread'))
            .slice(0, MAX_ROSTER);
    }

    queueRender() {
        if (this.renderQueued) return;
        this.renderQueued = true;
        window.requestAnimationFrame(() => {
            this.renderQueued = false;
            this.render();
        });
    }

    async openChat(jid, type = 'chat') {
        if (!jid || !this.api) return;
        if (type === 'groupchat') {
            await this.api.rooms.open(jid, {}, true);
        } else {
            await this.api.chats.open(jid, {}, true);
        }
        this.setState({
            active_jid: jid,
            open: true,
            minimized: false,
        });
    }

    async handleSubmit(ev) {
        const form = ev.target.closest?.('.rediff-overlay-composer');
        if (!form) return;
        ev.preventDefault();
        const activeChat = this.getActiveChat();
        const textarea = form.querySelector('textarea');
        const body = textarea?.value?.trim();
        if (!activeChat || !body) return;
        await activeChat.sendMessage({ body });
        textarea.value = '';
        this.queueRender();
    }

    handleInput(ev) {
        if (ev.target.matches('.rediff-overlay-search-input')) {
            this.setState({ query: ev.target.value });
        }
    }

    async handleClick(ev) {
        const button = ev.target.closest('button, [role="button"], a');
        if (!button) return;
        if (button.matches('[data-rediff-overlay-toggle]')) {
            this.setState({ open: !this.state.open, minimized: false });
            return;
        }
        if (button.matches('[data-rediff-overlay-minimize]')) {
            this.setState({ open: true, minimized: true });
            return;
        }
        if (button.matches('[data-rediff-overlay-close]')) {
            this.setState({ open: false, minimized: false });
            return;
        }
        if (button.matches('[data-rediff-overlay-restore]')) {
            this.setState({ open: true, minimized: false });
            return;
        }
        if (button.matches('[data-rediff-overlay-new-chat]')) {
            this.actions.openNewChat?.(ev);
            this.setState({ open: true, minimized: false });
            return;
        }
        if (button.matches('[data-rediff-overlay-new-group]')) {
            this.actions.openGroups?.(ev);
            this.setState({ open: true, minimized: false });
            return;
        }
        if (button.matches('[data-rediff-overlay-manage-participants]')) {
            const activeChat = this.getActiveChat();
            if (activeChat) this.actions.openParticipants?.(activeChat.get('jid'), ev);
            return;
        }
        if (button.matches('[data-rediff-overlay-open-workspace]')) {
            const activeChat = this.getActiveChat();
            if (activeChat) this.openChat(activeChat.get('jid'), activeChat.get('type'));
            return;
        }
        if (button.matches('[data-rediff-overlay-open-chat]')) {
            const jid = button.getAttribute('data-jid');
            const type = button.getAttribute('data-chat-type') || 'chat';
            await this.openChat(jid, type);
            return;
        }
    }

    handleKeyDown(ev) {
        if (ev.key === 'Escape' && this.state.open && !this.state.minimized) {
            this.setState({ open: false, minimized: false });
            return;
        }
        if (ev.target.matches('.rediff-overlay-composer textarea') && ev.key === 'Enter' && !ev.shiftKey) {
            ev.preventDefault();
            ev.target.closest('form')?.requestSubmit();
        }
    }

    renderRecentList() {
        const recents = this.getFilteredRecents();
        if (!recents.length) {
            return '<p class="rediff-overlay-empty">Open a conversation in the main workspace and it appears here for quick access.</p>';
        }
        return recents
            .map((chat) => {
                const jid = chat.get('jid');
                const unread = (chat.get('num_unread') || 0) + (chat.get('num_unread_general') || 0);
                const messages = chat.messages?.models || [];
                const lastMessage = [...messages].reverse().find((message) => getMessageText(message));
                const preview = lastMessage ? getMessageText(lastMessage) : chat.get('type') === 'groupchat' ? 'Group ready' : 'Start chatting';
                const active = this.state.active_jid === jid;
                return `
                    <button type="button" class="rediff-overlay-item ${active ? 'is-active' : ''}" data-rediff-overlay-open-chat data-jid="${escapeHTML(jid)}" data-chat-type="${escapeHTML(chat.get('type') || 'chat')}">
                        <span class="rediff-overlay-item__avatar ${chat.get('type') === 'groupchat' ? 'is-group' : ''}">${escapeHTML(getChatName(chat).slice(0, 1))}</span>
                        <span class="rediff-overlay-item__body">
                            <span class="rediff-overlay-item__title">${escapeHTML(getChatName(chat))}</span>
                            <span class="rediff-overlay-item__meta">${escapeHTML(preview.slice(0, 60))}</span>
                        </span>
                        <span class="rediff-overlay-item__aside">
                            ${lastMessage ? `<span class="rediff-overlay-item__time">${escapeHTML(formatTime(lastMessage))}</span>` : ''}
                            ${unread ? `<span class="rediff-overlay-count">${unread > 99 ? '99+' : unread}</span>` : ''}
                        </span>
                    </button>
                `;
            })
            .join('');
    }

    renderRosterList() {
        const contacts = this.getFilteredContacts();
        if (!contacts.length) {
            return '<p class="rediff-overlay-empty">Use New Chat to search your tenant or open a recent conversation.</p>';
        }
        return contacts
            .map((contact) => {
                const jid = contact.get('jid');
                return `
                    <button type="button" class="rediff-overlay-item rediff-overlay-item--contact" data-rediff-overlay-open-chat data-jid="${escapeHTML(jid)}" data-chat-type="chat">
                        <span class="rediff-overlay-item__avatar rediff-overlay-item__presence ${getPresenceClass(contact)}">${escapeHTML(
                            getChatName(contact).slice(0, 1),
                        )}</span>
                        <span class="rediff-overlay-item__body">
                            <span class="rediff-overlay-item__title">${escapeHTML(getChatName(contact))}</span>
                            <span class="rediff-overlay-item__meta">${escapeHTML(getPresenceLabel(contact))}</span>
                        </span>
                        ${
                            contact.get('num_unread')
                                ? `<span class="rediff-overlay-count">${contact.get('num_unread') > 99 ? '99+' : contact.get('num_unread')}</span>`
                                : ''
                        }
                    </button>
                `;
            })
            .join('');
    }

    renderActiveChat() {
        const activeChat = this.getActiveChat();
        if (!activeChat) {
            return `
                <section class="rediff-overlay-conversation rediff-overlay-conversation--empty">
                    <div>
                        <p class="rediff-overlay-kicker">Quick chat</p>
                        <h3>Pick a conversation</h3>
                        <p>Use recent chats or your roster to open a lightweight chat panel without leaving the fullscreen workspace.</p>
                    </div>
                </section>
            `;
        }

        const messages = (activeChat.messages?.models || []).filter((message) => getMessageText(message)).slice(-MAX_MESSAGES);
        const isGroup = activeChat.get('type') === 'groupchat';
        const body = messages.length
            ? messages
                  .map((message) => {
                      const own = message.get('sender') === 'me';
                      const author = own ? 'You' : message.get('from')?.split('@')[0] || getChatName(activeChat);
                      return `
                            <article class="rediff-overlay-message ${own ? 'is-own' : ''}">
                                <p class="rediff-overlay-message__meta">${escapeHTML(author)} ${formatTime(message) ? `· ${escapeHTML(formatTime(message))}` : ''}</p>
                                <p class="rediff-overlay-message__body">${escapeHTML(getMessageText(message))}</p>
                            </article>
                        `;
                  })
                  .join('')
            : '<p class="rediff-overlay-empty">No messages yet. Send the first one from here or continue in the main workspace.</p>';

        return `
            <section class="rediff-overlay-conversation">
                <header class="rediff-overlay-conversation__header">
                    <div>
                        <p class="rediff-overlay-kicker">${isGroup ? 'Group quick view' : 'Direct quick view'}</p>
                        <h3>${escapeHTML(getChatName(activeChat))}</h3>
                        <p class="rediff-overlay-conversation__subline">${escapeHTML(activeChat.get('jid'))}</p>
                    </div>
                    <div class="rediff-overlay-conversation__actions">
                        ${
                            isGroup
                                ? '<button type="button" class="rediff-overlay-icon-button" data-rediff-overlay-manage-participants aria-label="Manage participants">Members</button>'
                                : ''
                        }
                        <button type="button" class="rediff-overlay-icon-button" data-rediff-overlay-open-workspace aria-label="Open in workspace">Expand</button>
                    </div>
                </header>
                <div class="rediff-overlay-messages">${body}</div>
                <form class="rediff-overlay-composer">
                    <textarea rows="2" placeholder="Reply without leaving the workspace"></textarea>
                    <div class="rediff-overlay-composer__actions">
                        <span>Enter to send</span>
                        <button type="submit" class="rediff-overlay-send">Send</button>
                    </div>
                </form>
            </section>
        `;
    }

    render() {
        const unread = this.getUnreadCount();
        const panelState = this.state.open ? (this.state.minimized ? 'is-minimized' : 'is-open') : 'is-closed';
        this.innerHTML = `
            <div class="rediff-overlay rediff-overlay--${panelState}">
                <button type="button" class="rediff-overlay-launcher" data-rediff-overlay-toggle aria-label="Toggle quick chat">
                    <span class="rediff-overlay-launcher__badge ${unread ? '' : 'is-hidden'}">${unread > 99 ? '99+' : unread}</span>
                    <span class="rediff-overlay-launcher__label">${this.state.open && !this.state.minimized ? 'Hide quick chat' : 'Quick chat'}</span>
                </button>
                <section class="rediff-overlay-panel ${this.state.open ? 'is-visible' : ''} ${this.state.minimized ? 'is-minimized' : ''}" aria-hidden="${this.state.open && !this.state.minimized ? 'false' : 'true'}">
                    <header class="rediff-overlay-panel__header">
                        <div>
                            <p class="rediff-overlay-kicker">Rediff Enterprise</p>
                            <h2>Quick Chat</h2>
                        </div>
                        <div class="rediff-overlay-panel__actions">
                            <button type="button" class="rediff-overlay-icon-button" data-rediff-overlay-new-chat aria-label="New chat">New Chat</button>
                            <button type="button" class="rediff-overlay-icon-button" data-rediff-overlay-new-group aria-label="New group">New Group</button>
                            <button type="button" class="rediff-overlay-icon-button" data-rediff-overlay-minimize aria-label="Minimize">Min</button>
                            <button type="button" class="rediff-overlay-icon-button" data-rediff-overlay-close aria-label="Close">Close</button>
                        </div>
                    </header>
                    <div class="rediff-overlay-panel__body">
                        <aside class="rediff-overlay-sidebar">
                            <label class="rediff-overlay-search">
                                <span>Search chats and people</span>
                                <input class="rediff-overlay-search-input" type="search" placeholder="Search quick chat" value="${escapeHTML(this.state.query)}" />
                            </label>
                            <section class="rediff-overlay-section">
                                <div class="rediff-overlay-section__heading">
                                    <h3>Recent</h3>
                                    <span>${this.getRecentChatboxes().length}</span>
                                </div>
                                <div class="rediff-overlay-list">${this.renderRecentList()}</div>
                            </section>
                            <section class="rediff-overlay-section">
                                <div class="rediff-overlay-section__heading">
                                    <h3>Roster</h3>
                                    <span>${this.getContacts().length}</span>
                                </div>
                                <div class="rediff-overlay-list">${this.renderRosterList()}</div>
                            </section>
                        </aside>
                        ${this.renderActiveChat()}
                    </div>
                </section>
                ${
                    this.state.open && this.state.minimized
                        ? '<button type="button" class="rediff-overlay-restore" data-rediff-overlay-restore aria-label="Restore quick chat">Restore quick chat</button>'
                        : ''
                }
            </div>
        `;
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
