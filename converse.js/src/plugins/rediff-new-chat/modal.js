import { getBareJid, getCurrentTenant, isSameTenantJid, isSameTenantResult, showToast } from '../rediff-shared/index.js';

const escapeHTML = (value) =>
    String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

const debounce = (callback, delay) => {
    let timeout;
    return (...args) => {
        window.clearTimeout(timeout);
        timeout = window.setTimeout(() => callback(...args), delay);
    };
};

export class RediffNewChatModal extends HTMLElement {
    constructor() {
        super();
        this.api = null;
        this.auth = null;
        this.results = [];
        this.status = 'Search people in your organization';
        this.search = debounce(() => this.searchAndRender(), 250);
        this.className = 'modal rediff-new-chat-modal';
        this.tabIndex = -1;
        this.setAttribute('aria-hidden', 'true');
    }

    connectedCallback() {
        this.render();
    }

    show() {
        const container = document.querySelector('#converse-modals') || document.body;
        if (!this.isConnected) container.append(this);

        document.body.classList.add('rediff-modal-open');
        this.classList.add('show');
        this.style.display = 'block';
        this.setAttribute('aria-hidden', 'false');
        this.render();
        window.setTimeout(() => this.querySelector('input[type="search"]')?.focus());
    }

    close() {
        this.classList.remove('show');
        this.style.display = 'none';
        this.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('rediff-modal-open');
        this.remove();
    }

    setStatus(message) {
        this.status = message;
        this.render();
    }

    setResults(results) {
        this.results = results;
        this.status = results.length ? '' : 'No users found in your tenant';
        this.render();
    }

    async searchAndRender() {
        const query = this.querySelector('input[type="search"]')?.value.trim() || '';
        this.results = [];

        if (!query) {
            this.setStatus('Search people in your organization');
            return;
        }

        if (!getCurrentTenant(this.api)) {
            this.setStatus('Unable to search users right now');
            return;
        }

        this.setStatus('Searching...');
        try {
            const url = `${this.api.settings.get('rediff_new_chat_search_url')}?q=${encodeURIComponent(query)}`;
            const { response, missingToken } = await this.auth.authenticatedFetch(url);
            if (missingToken) {
                this.setStatus('Please log out and log in again to enable user search');
                return;
            }
            if (response.status === 401) {
                this.setStatus('Please log out and log in again to enable user search');
                return;
            }
            if (!response.ok) throw new Error(`Search failed: ${response.status}`);

            const data = await response.json();
            this.setResults((Array.isArray(data) ? data : []).filter((result) => isSameTenantResult(this.api, result)));
        } catch (error) {
            console.error(error);
            this.setStatus('Unable to search users right now');
        }
    }

    async addAndOpen(result) {
        const jid = getBareJid(result?.jid);
        if (!isSameTenantResult(this.api, result) || !isSameTenantJid(this.api, jid)) {
            showToast(this.api, 'rediff-cross-tenant-blocked', 'danger', 'Cross-tenant contacts are not allowed');
            return;
        }

        try {
            const existing = await this.api.contacts.get(jid);
            if (!existing) {
                await this.api.contacts.add({ jid, name: result.display_name || jid }, true, true);
            }
            await this.api.chats.open(jid, {}, true);
            this.close();
        } catch (error) {
            console.error(error);
            this.setStatus('Unable to search users right now');
        }
    }

    render() {
        const query = this.querySelector('input[type="search"]')?.value || '';
        this.innerHTML = `
            <div class="modal-dialog rediff-new-chat-dialog" role="document">
                <div class="modal-content">
                    <header class="modal-header rediff-new-chat-header">
                        <h5 class="modal-title" id="rediff-new-chat-title">New Chat</h5>
                        <button class="btn-close rediff-new-chat-close" type="button" aria-label="Close" data-rediff-close-new-chat></button>
                    </header>
                    <div class="modal-body">
                        <div class="rediff-new-chat-search">
                            <input class="form-control" type="search" placeholder="Search people in your organization" autocomplete="off" value="${escapeHTML(query)}" />
                        </div>
                        <div class="rediff-new-chat-status" role="status">${escapeHTML(this.status)}</div>
                        <ul class="rediff-new-chat-results">
                            ${this.results
                                .map(
                                    (result, index) => `
                                        <li class="rediff-new-chat-result">
                                            <div class="rediff-new-chat-identity">
                                                <strong>${escapeHTML(result.display_name || result.jid)}</strong>
                                                <span>${escapeHTML(result.email || result.jid)}</span>
                                            </div>
                                            <button type="button" class="btn btn-primary btn-sm" data-rediff-result="${index}">Add</button>
                                        </li>
                                    `
                                )
                                .join('')}
                        </ul>
                    </div>
                </div>
            </div>
        `;

        this.querySelector('[data-rediff-close-new-chat]')?.addEventListener('click', () => this.close());
        this.querySelector('input[type="search"]')?.addEventListener('input', () => this.search());
        this.querySelector('input[type="search"]')?.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape') this.close();
        });
        this.querySelectorAll('[data-rediff-result]').forEach((button) => {
            button.addEventListener('click', () => this.addAndOpen(this.results[Number(button.dataset.rediffResult)]));
        });
    }
}

export const defineRediffNewChatModal = (api, auth) => {
    if (!customElements.get('converse-rediff-new-chat-modal')) {
        customElements.define('converse-rediff-new-chat-modal', RediffNewChatModal);
    }

    const originalCreate = api.modal?.create?.bind(api.modal);
    if (originalCreate && !api.modal.create.rediffNewChatFactory) {
        api.modal.create = (name, properties = {}) => {
            const modal = originalCreate(name, properties);
            if (name === 'converse-rediff-new-chat-modal') {
                modal.api = api;
                modal.auth = auth;
            }
            return modal;
        };
        api.modal.create.rediffNewChatFactory = true;
    }
};
