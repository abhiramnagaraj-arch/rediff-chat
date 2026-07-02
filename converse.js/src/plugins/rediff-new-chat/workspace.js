import { getCurrentJid } from '../rediff-shared/index.js';

const MAX_RECENTS = 18;
const MAX_RESULTS = 8;

const escapeHTML = (value) =>
    String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

const getChatName = (model) =>
    model?.getDisplayName?.() || model?.get?.('name') || model?.get?.('fullname') || model?.get?.('jid') || 'Conversation';

const getMessageText = (message) =>
    String(message?.get?.('body') || message?.get?.('message') || message?.get?.('plaintext') || '').trim();

const getTimestamp = (message) => {
    const value = message?.get?.('time') || message?.get?.('edited') || message?.get?.('received') || message?.get?.('created');
    const stamp = value ? new Date(value).getTime() : Number.NaN;
    return Number.isNaN(stamp) ? 0 : stamp;
};

const formatTime = (timestamp) => {
    if (!timestamp) return '';
    return new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' }).format(new Date(timestamp));
};

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

export class RediffWorkspace extends HTMLElement {
    constructor() {
        super();
        this.api = null;
        this._converse = null;
        this.actions = {};
        this.state = {
            query: '',
            active_jid: '',
        };
        this.collectionListeners = [];
        this.messageListeners = new Map();
        this.renderQueued = false;
        this.onClick = (ev) => this.handleClick(ev);
        this.onInput = (ev) => this.handleInput(ev);
        this.onKeyDown = (ev) => this.handleKeyDown(ev);
    }

    connectedCallback() {
        if (this.connected) return;
        this.connected = true;
        this.className = 'rediff-workspace-host';
        this.addEventListener('click', this.onClick);
        this.addEventListener('input', this.onInput);
        this.addEventListener('keydown', this.onKeyDown);
        document.body.classList.add('rediff-workspace-mounted');
        this.render();
    }

    disconnectedCallback() {
        this.connected = false;
        this.removeEventListener('click', this.onClick);
        this.removeEventListener('input', this.onInput);
        this.removeEventListener('keydown', this.onKeyDown);
        this.unbindCollections();
        document.body.classList.remove('rediff-workspace-mounted');
    }

    setContext(api, _converse, actions = {}) {
        this.api = api;
        this._converse = _converse;
        this.actions = actions;
        this.bindCollections();
        this.ensureActiveChat();
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
        const chats = this.getRecentChatboxes();
        const live = new Set(chats.map((chat) => chat.cid));
        chats.forEach((chat) => {
            if (this.messageListeners.has(chat.cid) || !chat.messages) return;
            const handler = () => this.queueRender();
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

    queueRender() {
        if (this.renderQueued) return;
        this.renderQueued = true;
        window.requestAnimationFrame(() => {
            this.renderQueued = false;
            this.render();
        });
    }

    getRecentChatboxes() {
        const chatboxes = this._converse?.state?.chatboxes?.models || [];
        return chatboxes
            .filter((chat) => chat.get('id') !== 'controlbox' && !chat.get('closed'))
            .sort((a, b) => this.getSortScore(b) - this.getSortScore(a));
    }

    getSortScore(chat) {
        const unread = (chat.get('num_unread') || 0) + (chat.get('num_unread_general') || 0);
        const messages = chat.messages?.models || [];
        return unread * 1e13 + getTimestamp(messages[messages.length - 1]);
    }

    getRosterContacts() {
        const ownJid = getCurrentJid(this.api);
        return [...(this._converse?.roster?.models || [])]
            .filter((contact) => contact.get('jid') && contact.get('jid') !== ownJid && !contact.get('requesting'))
            .sort((a, b) => getChatName(a).localeCompare(getChatName(b), undefined, { sensitivity: 'base' }));
    }

    getActiveChatCandidate(chatboxes) {
        return chatboxes.find((chat) => !chat.get('hidden') && !chat.get('closed')) || chatboxes[0] || null;
    }

    ensureActiveChat() {
        const recent = this.getRecentChatboxes();
        if (this.state.active_jid && recent.some((chat) => chat.get('jid') === this.state.active_jid)) return;
        this.state.active_jid = this.getActiveChatCandidate(recent)?.get('jid') || '';
    }

    getSearchResults() {
        const query = this.state.query.trim().toLowerCase();
        if (!query) return [];

        const results = [];
        const seen = new Set();
        const push = (item) => {
            if (!item?.jid || seen.has(item.jid) || results.length >= MAX_RESULTS) return;
            seen.add(item.jid);
            results.push(item);
        };

        this.getRecentChatboxes().forEach((chat) => {
            const haystack = `${getChatName(chat)} ${chat.get('jid')}`.toLowerCase();
            if (haystack.includes(query)) {
                push({
                    jid: chat.get('jid'),
                    name: getChatName(chat),
                    type: chat.get('type') || 'chat',
                    meta: chat.get('type') === 'groupchat' ? 'Recent group' : 'Recent direct message',
                });
            }
        });

        this.getRosterContacts().forEach((contact) => {
            const haystack = `${getChatName(contact)} ${contact.get('jid')}`.toLowerCase();
            if (haystack.includes(query)) {
                push({
                    jid: contact.get('jid'),
                    name: getChatName(contact),
                    type: 'chat',
                    meta: getPresenceLabel(contact),
                });
            }
        });

        return results;
    }

    findChatbox(jid) {
        const target = bareJid(jid);
        return (this._converse?.state?.chatboxes?.models || []).find((chat) => bareJid(chat.get('jid')) === target) || null;
    }

    revealChatbox(jid) {
        const chatboxes = this._converse?.state?.chatboxes?.models || [];
        const target = bareJid(jid);
        const targetChat = chatboxes.find((chat) => bareJid(chat.get('jid')) === target);
        if (!targetChat) return false;
        chatboxes.forEach((chat) => {
            if (chat.get('id') === 'controlbox') return;
            const isTarget = chat === targetChat;
            chat.save({
                hidden: !isTarget,
                closed: false,
            });
        });
        return true;
    }

    async openChat(jid, type = 'chat') {
        if (!jid || !this.api) return;
        const existing = this.findChatbox(jid);

        if (!existing) {
            if (type === 'groupchat') {
                await this.api.rooms.open(jid, {}, true);
            } else {
                await this.api.chats.open(jid, {}, true);
            }
        } else {
            existing.save({ closed: false, hidden: false });
        }

        if (!this.revealChatbox(jid)) {
            await new Promise((resolve) => window.setTimeout(resolve, 60));
            this.revealChatbox(jid);
        }
        this.state.active_jid = jid;
        this.queueRender();
    }

    handleInput(ev) {
        if (ev.target.matches('.rediff-workspace-search-input')) {
            this.state.query = ev.target.value || '';
            this.queueRender();
        }
    }

    async handleClick(ev) {
        const button = ev.target.closest('button, a, [role="button"]');
        if (!button) return;

        if (button.matches('[data-rediff-workspace-open]')) {
            const jid = button.getAttribute('data-jid');
            const type = button.getAttribute('data-chat-type') || 'chat';
            await this.openChat(jid, type);
            this.state.query = '';
            this.queueRender();
            return;
        }
        if (button.matches('[data-rediff-workspace-new-chat]')) {
            this.actions.openNewChat?.(ev);
            return;
        }
        if (button.matches('[data-rediff-workspace-new-group]')) {
            this.actions.openGroups?.(ev);
            return;
        }
        if (button.matches('[data-rediff-workspace-clear-search]')) {
            this.state.query = '';
            this.queueRender();
        }
    }

    async handleKeyDown(ev) {
        if (ev.key === 'Escape' && this.state.query) {
            this.state.query = '';
            this.queueRender();
            return;
        }
        if (ev.key === 'Enter' && ev.target.matches('.rediff-workspace-search-input')) {
            const [first] = this.getSearchResults();
            if (first) {
                ev.preventDefault();
                await this.openChat(first.jid, first.type);
                this.state.query = '';
                this.queueRender();
            }
        }
    }

    renderSearchResults() {
        const results = this.getSearchResults();
        if (!this.state.query.trim()) return '';
        if (!results.length) {
            return '<div class="rediff-workspace-search-results"><p class="rediff-workspace-empty">No matching chats or people.</p></div>';
        }

        return `
            <div class="rediff-workspace-search-results">
                ${results
                    .map(
                        (result) => `
                            <button
                                type="button"
                                class="rediff-workspace-search-result"
                                data-rediff-workspace-open
                                data-jid="${escapeHTML(result.jid)}"
                                data-chat-type="${escapeHTML(result.type)}"
                            >
                                <span class="rediff-workspace-search-result__avatar ${result.type === 'groupchat' ? 'is-group' : ''}">
                                    ${escapeHTML(result.name.slice(0, 1))}
                                </span>
                                <span class="rediff-workspace-search-result__body">
                                    <span class="rediff-workspace-search-result__title">${escapeHTML(result.name)}</span>
                                    <span class="rediff-workspace-search-result__meta">${escapeHTML(result.meta)}</span>
                                </span>
                            </button>
                        `,
                    )
                    .join('')}
            </div>
        `;
    }

    renderRecents() {
        const recents = this.getRecentChatboxes().slice(0, MAX_RECENTS);
        if (!recents.length) {
            return '<p class="rediff-workspace-empty">Recent conversations appear here after you open them.</p>';
        }
        return recents
            .map((chat) => {
                const messages = chat.messages?.models || [];
                const lastMessage = [...messages].reverse().find((message) => getMessageText(message));
                const preview = lastMessage ? getMessageText(lastMessage) : chat.get('type') === 'groupchat' ? 'Open this group' : 'Start chatting';
                const timestamp = lastMessage ? getTimestamp(lastMessage) : 0;
                const unread = (chat.get('num_unread') || 0) + (chat.get('num_unread_general') || 0);
                const active = this.state.active_jid === chat.get('jid');
                return `
                    <button
                        type="button"
                        class="rediff-workspace-recent ${active ? 'is-active' : ''}"
                        data-rediff-workspace-open
                        data-jid="${escapeHTML(chat.get('jid'))}"
                        data-chat-type="${escapeHTML(chat.get('type') || 'chat')}"
                    >
                        <span class="rediff-workspace-recent__avatar ${chat.get('type') === 'groupchat' ? 'is-group' : ''}">
                            ${escapeHTML(getChatName(chat).slice(0, 1))}
                        </span>
                        <span class="rediff-workspace-recent__body">
                            <span class="rediff-workspace-recent__row">
                                <span class="rediff-workspace-recent__title">${escapeHTML(getChatName(chat))}</span>
                                ${timestamp ? `<span class="rediff-workspace-recent__time">${escapeHTML(formatTime(timestamp))}</span>` : ''}
                            </span>
                            <span class="rediff-workspace-recent__meta">${escapeHTML(preview.slice(0, 84))}</span>
                        </span>
                        ${
                            unread
                                ? `<span class="rediff-workspace-recent__badge">${unread > 99 ? '99+' : unread}</span>`
                                : ''
                        }
                    </button>
                `;
            })
            .join('');
    }

    render() {
        const totalContacts = this.getRosterContacts().length;
        const totalRecents = this.getRecentChatboxes().length;
        const activeElement = document.activeElement;
        const restoreSearchFocus =
            activeElement instanceof HTMLInputElement &&
            activeElement.classList.contains('rediff-workspace-search-input');
        const selectionStart = restoreSearchFocus ? activeElement.selectionStart : null;
        const selectionEnd = restoreSearchFocus ? activeElement.selectionEnd : null;

        this.innerHTML = `
            <div class="rediff-workspace-shell" aria-label="Rediff workspace">
                <header class="rediff-workspace-searchbar">
                    <div class="rediff-workspace-searchbar__field">
                        <span class="rediff-workspace-searchbar__icon" aria-hidden="true">⌕</span>
                        <input
                            class="rediff-workspace-search-input"
                            type="search"
                            placeholder="Search chats, people, and groups"
                            value="${escapeHTML(this.state.query)}"
                            aria-label="Search chats, people, and groups"
                        />
                        ${
                            this.state.query
                                ? '<button type="button" class="rediff-workspace-searchbar__clear" data-rediff-workspace-clear-search aria-label="Clear search">×</button>'
                                : ''
                        }
                    </div>
                    <div class="rediff-workspace-searchbar__actions">
                        <button type="button" class="rediff-workspace-pill" data-rediff-workspace-new-chat>New chat</button>
                        <button type="button" class="rediff-workspace-pill is-secondary" data-rediff-workspace-new-group>New group</button>
                    </div>
                    ${this.renderSearchResults()}
                </header>
                <aside class="rediff-workspace-recents" aria-label="Recent conversations">
                    <div class="rediff-workspace-recents__header">
                        <div>
                            <p class="rediff-workspace-kicker">Workspace</p>
                            <h2>Recent chats</h2>
                        </div>
                        <div class="rediff-workspace-stats">
                            <span>${totalRecents} recent</span>
                            <span>${totalContacts} contacts</span>
                        </div>
                    </div>
                    <div class="rediff-workspace-recents__list">${this.renderRecents()}</div>
                </aside>
            </div>
        `;

        if (restoreSearchFocus) {
            const input = this.querySelector('.rediff-workspace-search-input');
            if (input instanceof HTMLInputElement) {
                window.requestAnimationFrame(() => {
                    input.focus();
                    if (selectionStart !== null && selectionEnd !== null) {
                        input.setSelectionRange(selectionStart, selectionEnd);
                    }
                });
            }
        }
    }
}

export const mountRediffWorkspace = (api, _converse, actions) => {
    if (!customElements.get('converse-rediff-workspace')) {
        customElements.define('converse-rediff-workspace', RediffWorkspace);
    }

    const shell = document.querySelector('.rediff-shell') || document.body;
    let workspace = shell.querySelector('converse-rediff-workspace');
    if (!workspace) {
        workspace = document.createElement('converse-rediff-workspace');
        shell.append(workspace);
    }
    workspace.setContext(api, _converse, actions);
    return workspace;
};
