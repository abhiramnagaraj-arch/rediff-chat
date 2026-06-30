converse.plugins.add('rediff_new_chat', {
    initialize() {
        const api = this.api || this._converse?.api || window.converse?.api;
        if (!api?.settings) {
            console.error('rediff_new_chat: Converse API is unavailable');
            return;
        }

        window.rediffConverse = Object.assign(window.rediffConverse || {}, { api });

        api.settings.extend({
            rediff_new_chat_search_url: '/api/users/search',
            rediff_new_chat_token_url: '/api/oidc/token',
            rediff_new_chat_token: null,
        });

        const getBareJid = (jid) => String(jid || '').split('/')[0].trim().toLowerCase();

        const getTenantFromJid = (jid) => {
            const bare = getBareJid(jid);
            const localpart = bare.split('@')[0];
            return localpart.split('.')[0];
        };

        const getDomainFromJid = (jid) => {
            const bare = getBareJid(jid);
            return bare.includes('@') ? bare.split('@').pop() : '';
        };

        const getCurrentJid = () => getBareJid(api.user?.jid?.());
        const getCurrentTenant = () => getTenantFromJid(getCurrentJid());
        const getCurrentDomain = () => getDomainFromJid(getCurrentJid());

        const isSameTenantJid = (jid) => {
            const currentTenant = getCurrentTenant();
            const currentDomain = getCurrentDomain();
            return Boolean(
                currentTenant &&
                    currentDomain &&
                    getTenantFromJid(jid) === currentTenant &&
                    getDomainFromJid(jid) === currentDomain
            );
        };

        const isSameTenantResult = (result) => {
            const currentTenant = getCurrentTenant();
            const currentDomain = getCurrentDomain();
            return Boolean(
                currentTenant &&
                    currentDomain &&
                    result?.jid &&
                    result?.tenant === currentTenant &&
                    getTenantFromJid(result.jid) === currentTenant &&
                    getDomainFromJid(result.jid) === currentDomain
            );
        };

        const tokenStorageKey = 'rediff_access_token';
        let tokenRequest = null;
        let lastLoginCredentials = null;
        let hasConnectedSession = false;

        const isAuthenticatedView = () => {
            const jid = getCurrentJid();
            const hasAuthenticatedShell = Boolean(
                document.querySelector('#controlbox, converse-controlbox, converse-chatbox, converse-muc')
            );
            const hasAuthForm = Boolean(
                document.querySelector('#converse-login, #converse-register, converse-login, converse-register')
            );
            return Boolean((hasConnectedSession || hasAuthenticatedShell) && jid && jid.includes('@') && !hasAuthForm);
        };

        const hideButton = () => {
            document.querySelector('.rediff-new-chat-button')?.classList.remove('is-visible');
            document.querySelector('.rediff-groups-button')?.classList.remove('is-visible');
            if (document.body.classList.contains('rediff-new-chat-open')) closePanel();
        };

        const getSearchToken = () => {
            const configured = api.settings.get('rediff_new_chat_token');
            if (configured) return configured;
            if (window.REDIFF_ACCESS_TOKEN) return window.REDIFF_ACCESS_TOKEN;

            const keys = [tokenStorageKey, 'access_token', 'keycloak_token', 'kc_token'];
            for (const storage of [window.sessionStorage, window.localStorage]) {
                for (const key of keys) {
                    const token = storage.getItem(key);
                    if (token) return token;
                }
            }
            return null;
        };

        const rememberSearchToken = (token) => {
            if (!token) return;
            window.REDIFF_ACCESS_TOKEN = token;
            window.sessionStorage.setItem(tokenStorageKey, token);
        };

        const clearSearchToken = () => {
            delete window.REDIFF_ACCESS_TOKEN;
            for (const storage of [window.sessionStorage, window.localStorage]) {
                for (const key of [tokenStorageKey, 'access_token', 'keycloak_token', 'kc_token']) {
                    storage.removeItem(key);
                }
            }
        };

        const rememberLoginCredentials = (jid, password) => {
            const safeJid = getBareJid(jid);
            if (safeJid && password) {
                lastLoginCredentials = { jid: safeJid, password };
            }
            return lastLoginCredentials;
        };

        const getLoginCredentials = () => {
            if (lastLoginCredentials?.jid && lastLoginCredentials?.password) return lastLoginCredentials;

            const connection = api.connection?.get?.();
            const jid = api.settings.get('jid') || getCurrentJid() || connection?.jid;
            const password = api.settings.get('password') || connection?.pass || connection?.password;
            return rememberLoginCredentials(jid, password);
        };

        const requestSearchToken = async (jid, password) => {
            const safeJid = getBareJid(jid);
            if (!safeJid || !password) return null;
            if (tokenRequest) return tokenRequest;

            tokenRequest = fetch(api.settings.get('rediff_new_chat_token_url'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jid: safeJid, password }),
            })
                .then(async (response) => {
                    if (!response.ok) throw new Error(`Token request failed: ${response.status}`);
                    const data = await response.json();
                    rememberSearchToken(data.access_token);
                    return data.access_token || null;
                })
                .catch((error) => {
                    console.warn('Unable to prepare tenant search token', error);
                    return null;
                })
                .finally(() => {
                    tokenRequest = null;
                });

            return tokenRequest;
        };

        const readLoginFormCredentials = (form) => {
            const jid = form?.querySelector?.('input[name="jid"]')?.value?.trim();
            const password = form?.querySelector?.('input[name="password"]')?.value || '';
            return rememberLoginCredentials(jid, password);
        };

        const captureLoginForm = (form) => {
            if (!form || form.rediffTokenCaptureInstalled) return;
            form.rediffTokenCaptureInstalled = true;
            form.addEventListener(
                'submit',
                () => {
                    const credentials = readLoginFormCredentials(form);
                    if (credentials) requestSearchToken(credentials.jid, credentials.password);
                },
                true
            );
        };

        const captureLoginCredentials = () => {
            if (captureLoginCredentials.installed) return;
            captureLoginCredentials.installed = true;

            document.addEventListener(
                'submit',
                (ev) => {
                    const form = ev.target?.closest?.('#converse-login');
                    if (!form) return;

                    const credentials = readLoginFormCredentials(form);
                    if (credentials) requestSearchToken(credentials.jid, credentials.password);
                },
                true
            );
        };

        const watchLoginForm = () => {
            captureLoginForm(document.querySelector('#converse-login'));
        };

        const bootstrapStoredSearchToken = () => {
            const credentials = getLoginCredentials();
            if (credentials) {
                requestSearchToken(credentials.jid, credentials.password);
            }
        };

        const showToast = (id, type, body) => {
            if (api.toast?.show) {
                api.toast.show(id, { type, body });
            } else {
                console[type === 'danger' ? 'error' : 'warn'](body);
            }
        };

        const patchTenantGuards = () => {
            if (api.contacts?.add && !api.contacts.add.rediffTenantGuarded) {
                const addContact = api.contacts.add.bind(api.contacts);
                api.contacts.add = async (attributes, ...args) => {
                    const jid = attributes?.jid;
                    if (jid && getCurrentTenant() && !isSameTenantJid(jid)) {
                        throw new Error('Cross-tenant contacts are not allowed');
                    }
                    return addContact(attributes, ...args);
                };
                api.contacts.add.rediffTenantGuarded = true;
            }

            if (api.chats?.open && !api.chats.open.rediffTenantGuarded) {
                const openChat = api.chats.open.bind(api.chats);
                api.chats.open = async (jid, ...args) => {
                    const jids = Array.isArray(jid) ? jid : [jid];
                    if (getCurrentTenant() && jids.some((item) => item && !isSameTenantJid(item))) {
                        throw new Error('Cross-tenant chats are not allowed');
                    }
                    return openChat(jid, ...args);
                };
                api.chats.open.rediffTenantGuarded = true;
            }
        };

        const ensurePanel = () => {
            let panel = document.querySelector('.rediff-new-chat-panel');
            if (panel) return panel;

            panel = document.createElement('section');
            panel.className = 'rediff-new-chat-panel';
            panel.setAttribute('aria-hidden', 'true');
            panel.innerHTML = `
                <div class="rediff-new-chat-backdrop" data-rediff-close-new-chat></div>
                <div class="rediff-new-chat-dialog" role="dialog" aria-modal="true" aria-labelledby="rediff-new-chat-title">
                    <header class="rediff-new-chat-header">
                        <h2 id="rediff-new-chat-title">New Chat</h2>
                        <button class="rediff-new-chat-close" type="button" aria-label="Close" data-rediff-close-new-chat>&times;</button>
                    </header>
                    <div class="rediff-new-chat-search">
                        <input type="search" placeholder="Search people in your organization" autocomplete="off" />
                    </div>
                    <div class="rediff-new-chat-status" role="status">Search people in your organization</div>
                    <ul class="rediff-new-chat-results"></ul>
                </div>
            `;
            document.body.appendChild(panel);

            panel.addEventListener('click', (ev) => {
                if (ev.target.closest('[data-rediff-close-new-chat]')) closePanel();
            });
            panel.querySelector('input').addEventListener('input', debounce(searchAndRender, 250));
            panel.querySelector('input').addEventListener('keydown', (ev) => {
                if (ev.key === 'Escape') closePanel();
            });
            return panel;
        };

        const setStatus = (message) => {
            const panel = ensurePanel();
            panel.querySelector('.rediff-new-chat-status').textContent = message;
        };

        const renderResults = (results) => {
            const panel = ensurePanel();
            const list = panel.querySelector('.rediff-new-chat-results');
            list.replaceChildren();

            if (!results.length) {
                setStatus('No users found in your tenant');
                return;
            }

            setStatus('');
            results.forEach((result) => {
                const item = document.createElement('li');
                item.className = 'rediff-new-chat-result';

                const identity = document.createElement('div');
                identity.className = 'rediff-new-chat-identity';

                const name = document.createElement('strong');
                name.textContent = result.display_name || result.jid;

                const detail = document.createElement('span');
                detail.textContent = result.email || result.jid;

                const button = document.createElement('button');
                button.type = 'button';
                button.textContent = 'Add';
                button.addEventListener('click', () => addAndOpen(result));

                identity.append(name, detail);
                item.append(identity, button);
                list.append(item);
            });
        };

        async function searchAndRender() {
            const panel = ensurePanel();
            const query = panel.querySelector('input').value.trim();
            panel.querySelector('.rediff-new-chat-results').replaceChildren();

            if (!query) {
                setStatus('Search people in your organization');
                return;
            }

            if (!getCurrentTenant()) {
                setStatus('Unable to search users right now');
                return;
            }

            setStatus('Searching...');
            try {
                let token = getSearchToken();
                if (!token && tokenRequest) {
                    setStatus('Preparing secure search...');
                    token = await tokenRequest;
                }
                if (!token) {
                    setStatus('Please log out and log in again to enable user search');
                    return;
                }

                const url = `${api.settings.get('rediff_new_chat_search_url')}?q=${encodeURIComponent(query)}`;
                let response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
                if (response.status === 401) {
                    clearSearchToken();
                    const credentials = getLoginCredentials();
                    if (credentials) {
                        setStatus('Refreshing secure search...');
                        token = await requestSearchToken(credentials.jid, credentials.password);
                        if (token) {
                            response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
                        }
                    }
                }
                if (response.status === 401) {
                    setStatus('Please log out and log in again to enable user search');
                    return;
                }
                if (!response.ok) throw new Error(`Search failed: ${response.status}`);

                const data = await response.json();
                const safeResults = (Array.isArray(data) ? data : []).filter(isSameTenantResult);
                renderResults(safeResults);
            } catch (error) {
                console.error(error);
                setStatus('Unable to search users right now');
            }
        }

        async function addAndOpen(result) {
            const jid = getBareJid(result?.jid);
            if (!isSameTenantResult(result) || !isSameTenantJid(jid)) {
                showToast('rediff-cross-tenant-blocked', 'danger', 'Cross-tenant contacts are not allowed');
                return;
            }

            try {
                const existing = await api.contacts.get(jid);
                if (!existing) {
                    await api.contacts.add({ jid, name: result.display_name || jid }, true, true);
                }
                await api.chats.open(jid, {}, true);
                closePanel();
            } catch (error) {
                console.error(error);
                setStatus('Unable to search users right now');
            }
        }

        function openPanel() {
            const panel = ensurePanel();
            panel.classList.add('is-open');
            document.body.classList.add('rediff-new-chat-open');
            panel.setAttribute('aria-hidden', 'false');
            panel.querySelector('input').focus();
        }

        function closePanel() {
            const panel = ensurePanel();
            panel.classList.remove('is-open');
            document.body.classList.remove('rediff-new-chat-open');
            panel.setAttribute('aria-hidden', 'true');
        }

        function debounce(callback, delay) {
            let timeout;
            return (...args) => {
                window.clearTimeout(timeout);
                timeout = window.setTimeout(() => callback(...args), delay);
            };
        }

        const ensureRediffActionDock = () => {
            const pane = document.querySelector('#controlbox .controlbox-pane, converse-controlbox .controlbox-pane, #controlbox, converse-controlbox');
            const roster = document.querySelector('#converse-roster, converse-roster');
            if (!pane || !roster) return null;

            let dock = pane.querySelector('.rediff-sidebar-actions');
            if (!dock) {
                dock = document.createElement('div');
                dock.className = 'rediff-sidebar-actions';
                roster.parentNode?.insertBefore(dock, roster);
            }
            return dock;
        };

        const positionButton = (button) => {
            const dock = ensureRediffActionDock();
            if (!dock) return false;
            if (button.parentElement !== dock) dock.appendChild(button);
            button.style.position = '';
            button.style.left = '';
            button.style.top = '';
            button.style.width = '';
            button.style.minHeight = '';
            button.style.display = '';
            button.style.alignItems = '';
            button.style.justifyContent = '';
            button.style.zIndex = '';
            button.style.visibility = '';
            button.style.opacity = '';
            button.style.pointerEvents = '';
            return true;
        };

        const groupScriptUrl = './rediff-groups.js?v=tenant-groups-20260630-14';
        let groupScriptRequest = null;

        const ensureGroupScript = async () => {
            if (window.rediffGroups?.open) return window.rediffGroups;
            if (!groupScriptRequest) {
                groupScriptRequest = import(groupScriptUrl).then(() => window.rediffGroups || null);
            }
            return groupScriptRequest;
        };

        const openGroupPanel = async () => {
            try {
                const groups = await ensureGroupScript();
                if (!groups?.open) throw new Error('Group UI did not initialize');
                groups.open();
            } catch (error) {
                console.error('Unable to open Rediff Groups UI', error);
                showToast('rediff-groups-open-error', 'danger', 'Unable to open groups right now');
            }
        };

        const positionGroupButton = (button) => positionButton(button);

        const hideGroupButton = () => {
            document.querySelector('.rediff-groups-button')?.classList.remove('is-visible');
        };

        const injectGroupButton = (chatButton) => {
            if (!chatButton) {
                hideGroupButton();
                return false;
            }

            let button = document.querySelector('.rediff-groups-button');
            if (!button) {
                button = document.createElement('button');
                button.type = 'button';
                button.className = 'rediff-groups-button rediff-groups-button--fixed';
                button.textContent = '+ New Group';
                button.addEventListener('click', openGroupPanel);
                document.body.appendChild(button);
            }

            const ready = positionGroupButton(button);
            button.classList.toggle('is-visible', ready);
            return ready;
        };

        const suppressNativeAddContact = () => {
            if (suppressNativeAddContact.installed) return;
            suppressNativeAddContact.installed = true;
            document.addEventListener(
                'click',
                (ev) => {
                    const nativeAdd = ev.target?.closest?.('.add-contact, [data-target="#add-contact-modal"]');
                    if (!nativeAdd) return;

                    ev.preventDefault();
                    ev.stopImmediatePropagation();
                    openPanel();
                },
                true
            );
        };

        const injectButton = () => {
            if (!isAuthenticatedView()) {
                hideButton();
                return false;
            }

            let button = document.querySelector('.rediff-new-chat-button');
            if (!button) {
                button = document.createElement('button');
                button.type = 'button';
                button.className = 'rediff-new-chat-button rediff-new-chat-button--fixed';
                button.textContent = '+ New Chat';
                button.addEventListener('click', openPanel);
                document.body.appendChild(button);
            }

            const sidebarReady = positionButton(button);
            button.classList.toggle('is-visible', sidebarReady);
            injectGroupButton(sidebarReady ? button : null);
            return sidebarReady;
        };

        captureLoginCredentials();
        watchLoginForm();
        suppressNativeAddContact();
        patchTenantGuards();
        api.listen.on('initialized', patchTenantGuards);
        api.listen.on('connected', () => {
            hasConnectedSession = true;
            patchTenantGuards();
            bootstrapStoredSearchToken();
            injectButton();
        });
        api.listen.on('disconnected', () => {
            hasConnectedSession = false;
            hideButton();
        });
        api.listen.on('logout', () => {
            hasConnectedSession = false;
            hideButton();
        });
        api.listen.on('controlBoxInitialized', injectButton);
        api.listen.on('rosterViewInitialized', injectButton);

        bootstrapStoredSearchToken();
        injectButton();
        window.addEventListener('resize', injectButton);
        window.setTimeout(injectButton, 500);
        window.setTimeout(injectButton, 1500);
        window.setTimeout(injectButton, 3000);
        window.setInterval(injectButton, 2000);

        const observer = new MutationObserver(() => {
            watchLoginForm();
            injectButton();
        });
        observer.observe(document.body, { childList: true, subtree: true });
    },
});
