import { createRediffAuth, getCurrentJid, installTenantGuards } from '../rediff-shared/index.js';
import { defineRediffNewChatModal } from './modal.js';
import { defineRediffGroupsModal } from '../rediff-groups/modal.js';
import { defineRediffOverlay } from './overlay.js';

const pluginName = 'rediff_new_chat';
const GROUPS_URL = '/api/groups';
let managedGroups = [];

const escapeHTML = (value) =>
    String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

const getConverseApi = (plugin) => plugin.api || plugin._converse?.api || window.converse?.api;

const openRediffNewChat = (api, ev) => {
    ev?.preventDefault?.();
    ev?.stopPropagation?.();
    api.modal.show('converse-rediff-new-chat-modal', {}, ev);
};

const openRediffGroups = (api, ev) => {
    ev?.preventDefault?.();
    ev?.stopPropagation?.();
    api.modal.show('converse-rediff-groups-modal', { mode: 'groups' }, ev);
};

const openRediffParticipants = (api, mucJid, ev) => {
    ev?.preventDefault?.();
    ev?.stopPropagation?.();
    api.modal.show('converse-rediff-groups-modal', {
        mode: 'participants',
        participantMucJid: mucJid,
    }, ev);
};

const openManagedGroupFromSidebar = async (api, auth, group, ev) => {
    ev?.preventDefault?.();
    ev?.stopPropagation?.();
    if (!group?.muc_jid || !api?.rooms?.open) return;

    try {
        let roomData = group;
        if (group.id && auth?.authenticatedFetch) {
            const { response, missingToken } = await auth.authenticatedFetch(`${GROUPS_URL}/${group.id}/join`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
            });
            if (!missingToken && response?.ok) roomData = await response.json();
        }

        await api.rooms.open(
            roomData.muc_jid || group.muc_jid,
            {
                nick: getCurrentJid(api).split('@')[0],
                name: group.name || group.muc_jid,
                auto_configure: false,
                roomconfig: roomData.room_config || {},
            },
            true
        );
    } catch (error) {
        console.warn('Unable to open managed group from sidebar', group?.muc_jid, error);
    }
};

const getGroupKey = (group) => String(group?.muc_jid || '').split('/')[0].trim().toLowerCase();

const positionRediffSidebarSections = (pane, dock) => {
    const rosterSection = pane.querySelector('#converse-roster');
    const nativeChatrooms = pane.querySelector('#chatrooms');
    nativeChatrooms?.classList.remove('rediff-native-chatrooms-hidden');

    if (
        rosterSection &&
        nativeChatrooms &&
        rosterSection.compareDocumentPosition(nativeChatrooms) & Node.DOCUMENT_POSITION_PRECEDING
    ) {
        pane.insertBefore(rosterSection, nativeChatrooms);
    }

    if (nativeChatrooms) {
        nativeChatrooms.append(dock);
        return;
    }

    if (rosterSection && dock.previousElementSibling !== rosterSection) {
        rosterSection.insertAdjacentElement('afterend', dock);
    }
};

const renderManagedGroups = (api, auth) => {
    const dock = document.querySelector('.rediff-sidebar-actions');
    if (!dock) return;

    let list = dock.querySelector('.rediff-managed-groups-list');
    if (!list) {
        list = document.createElement('section');
        list.className = 'rediff-managed-groups-list';
        dock.prepend(list);
    }

    list.hidden = true;
    list.innerHTML = '';
};

const syncManagedGroupsToSidebar = async (api, auth) => {
    if (!api?.rooms?.open || !auth?.authenticatedFetch || syncManagedGroupsToSidebar.running) return;
    syncManagedGroupsToSidebar.running = true;

    try {
        const { response, missingToken } = await auth.authenticatedFetch(GROUPS_URL);
        if (missingToken || !response?.ok) return;

        const groups = await response.json();
        const seenGroups = new Set();
        managedGroups = (Array.isArray(groups) ? groups : []).filter((group) => {
            const key = getGroupKey(group);
            if (!key || seenGroups.has(key)) return false;
            seenGroups.add(key);
            return true;
        });
        ensureSidebarActions(api, auth);
        renderManagedGroups(api, auth);

        const nick = getCurrentJid(api).split('@')[0];
        for (const group of managedGroups) {
            try {
                if (!api.bookmarks?.set) continue;
                const existing = api.bookmarks.get ? await api.bookmarks.get(group.muc_jid) : null;
                await api.bookmarks.set({
                    jid: group.muc_jid,
                    name: group.name || group.muc_jid,
                    nick,
                    autojoin: Boolean(existing?.get?.('autojoin')),
                });
            } catch (error) {
                console.warn('Unable to bookmark managed group', group?.muc_jid, error);
            }
        }
    } catch (error) {
        console.warn('Unable to sync managed groups to sidebar', error);
    } finally {
        syncManagedGroupsToSidebar.running = false;
    }
};


const rediffOccupantKey = (api, occ) => {
    const currentHost = String(api?.user?.jid?.() || '').split('@')[1]?.split('/')[0]?.toLowerCase() || '';
    const raw = String(occ?.get?.('jid') || occ?.get?.('nick') || occ?.getDisplayName?.() || occ?.id || '')
        .split('/')[0]
        .trim()
        .toLowerCase();
    if (!raw) return '';
    if (raw.includes('@')) return raw.split('@')[0];
    if (currentHost && raw.endsWith(`@${currentHost}`)) return raw.slice(0, -currentHost.length - 1);
    return raw;
};

const rediffOccupantRank = (occ) => {
    const presence = String(occ?.get?.('presence') || '').toLowerCase();
    const isOffline = ['offline', 'unavailable'].includes(presence);
    const hasJid = Boolean(occ?.get?.('jid'));
    return (isOffline ? 0 : 4) + (hasJid ? 1 : 0);
};

const dedupeMucOccupants = (api, el) => {
    const occupants = el?.model?.occupants?.models || [];
    if (!occupants.length) return;

    const winners = new Map();
    occupants.forEach((occ) => {
        const key = rediffOccupantKey(api, occ);
        if (!key) return;
        const current = winners.get(key);
        if (!current || rediffOccupantRank(occ) > rediffOccupantRank(current)) winners.set(key, occ);
    });

    const visibleIds = new Set([...winners.values()].map((occ) => occ.id).filter(Boolean));
    el.querySelectorAll('converse-muc-occupant-list-item, .occupant').forEach((item) => {
        const model = item.model;
        const id = model?.id || item.id || item.getAttribute('id');
        const hide = id && !visibleIds.has(id);
        item.classList.toggle('rediff-duplicate-occupant', Boolean(hide));
    });

    const heading = el.querySelector('.occupants-heading');
    if (heading) {
        const count = visibleIds.size;
        heading.textContent = `${count} ${count === 1 ? 'Participant' : 'Participants'}`;
    }
};


const ensureMucParticipantActions = (api, root = document) => {
    const elements = root.matches?.('converse-muc-occupants')
        ? [root]
        : [...root.querySelectorAll('converse-muc-occupants')];
    elements.forEach((el) => {
        dedupeMucOccupants(api, el);

        const header = el.querySelector('.occupants-header--title');
        if (!header || header.querySelector('.rediff-add-participant-button')) return;

        const mucJid = el.model?.get?.('jid') || el.getAttribute('jid');
        if (!mucJid) return;

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'rediff-add-participant-button';
        button.title = 'Manage participants';
        button.textContent = 'Manage';
        button.addEventListener('click', (ev) => openRediffParticipants(api, mucJid, ev));

        const menu = header.querySelector('converse-dropdown, .chatbox-btn, .hide-occupants');
        if (menu) header.insertBefore(button, menu);
        else header.append(button);
    });
};

const installMucParticipantActions = (api) => {
    const occupantsElement = customElements.get('converse-muc-occupants');
    if (!occupantsElement?.prototype) {
        customElements.whenDefined('converse-muc-occupants').then(() => installMucParticipantActions(api));
        return;
    }
    if (occupantsElement.prototype.updated?.rediffParticipantActions) return;

    const originalUpdated = occupantsElement.prototype.updated;
    occupantsElement.prototype.updated = function rediffMucOccupantsUpdated(...args) {
        originalUpdated?.apply(this, args);
        this.updateComplete?.then(() => ensureMucParticipantActions(api, this));
    };
    occupantsElement.prototype.updated.rediffParticipantActions = true;
    ensureMucParticipantActions(api);
};

const ensureSidebarActions = (api, auth) => {
    const pane = document.querySelector('#controlbox .controlbox-pane, converse-controlbox .controlbox-pane, #controlbox, converse-controlbox');
    const roster = document.querySelector('#converse-roster, converse-roster');
    if (!pane || !roster) return false;

    let dock = pane.querySelector('.rediff-sidebar-actions');
    if (!dock) {
        dock = document.createElement('div');
        dock.className = 'rediff-sidebar-actions';
    }
    positionRediffSidebarSections(pane, dock);

    let chat = dock.querySelector('.rediff-new-chat-button');
    if (!chat) {
        chat = document.createElement('button');
        chat.type = 'button';
        chat.className = 'rediff-new-chat-button is-visible';
        chat.textContent = '+ New Chat';
        chat.addEventListener('click', (ev) => openRediffNewChat(api, ev));
        dock.append(chat);
    }

    let groups = dock.querySelector('.rediff-groups-button');
    if (!groups) {
        groups = document.createElement('button');
        groups.type = 'button';
        groups.className = 'rediff-groups-button is-visible';
        groups.textContent = '+ New Group';
        groups.addEventListener('click', (ev) => openRediffGroups(api, ev));
        dock.append(groups);
    }

    chat.classList.add('is-visible');
    groups.classList.add('is-visible');
    positionRediffSidebarSections(pane, dock);
    renderManagedGroups(api, auth);
    return true;
};

const installRosterAction = (api) => {
    const rosterElement = customElements.get('converse-roster');
    if (!rosterElement?.prototype || rosterElement.prototype.showNewChatModal?.rediffNativeAction) return;

    rosterElement.prototype.showNewChatModal = function showRediffNewChatModal(ev) {
        openRediffNewChat(api, ev);
    };
    rosterElement.prototype.showNewChatModal.rediffNativeAction = true;

    rosterElement.prototype.showAddContactModal = function showRediffAddContactModal(ev) {
        openRediffNewChat(api, ev);
    };
    rosterElement.prototype.showAddContactModal.rediffNativeAction = true;
};

const ensureRoomslistGroupAction = (el, api) => {
    const dropdown = el.querySelector('converse-dropdown .dropdown-menu');
    if (!dropdown || dropdown.querySelector('[data-rediff-groups-action]')) return;

    const item = document.createElement('li');
    item.innerHTML = `
        <a class="dropdown-item rediff-groups-action" role="button" href="#" data-rediff-groups-action>
            <converse-icon class="fa fa-users" size="1em"></converse-icon>
            New Group
        </a>
    `;
    item.querySelector('a').addEventListener('click', (ev) => openRediffGroups(api, ev));
    dropdown.append(item);
};

const installRoomslistGroupAction = (api) => {
    const roomsListElement = customElements.get('converse-rooms-list');
    if (!roomsListElement?.prototype || roomsListElement.prototype.updated?.rediffNativeGroupsAction) return;

    const originalUpdated = roomsListElement.prototype.updated;
    roomsListElement.prototype.updated = function rediffRoomsListUpdated(...args) {
        originalUpdated?.apply(this, args);
        this.updateComplete?.then(() => ensureRoomslistGroupAction(this, api));
    };
    roomsListElement.prototype.updated.rediffNativeGroupsAction = true;
};

const installNativeEntryBridge = (api, auth) => {
    installRosterAction(api);
    installRoomslistGroupAction(api);
    installMucParticipantActions(api);
    ensureSidebarActions(api, auth);
    api.listen.on('controlBoxInitialized', () => ensureSidebarActions(api, auth));
    api.listen.on('rosterViewInitialized', () => {
        installRosterAction(api);
        ensureSidebarActions(api, auth);
    });
    api.listen.on('chatBoxesFetched', () => {
        installRoomslistGroupAction(api);
        installMucParticipantActions(api);
        ensureSidebarActions(api, auth);
    });
    window.setTimeout(() => {
        ensureSidebarActions(api, auth);
        ensureMucParticipantActions(api);
    }, 0);
};

const installOverlay = (api, _converse) => {
    const overlay = defineRediffOverlay(api, _converse, {
        openGroups: (ev) => openRediffGroups(api, ev),
        openNewChat: (ev) => openRediffNewChat(api, ev),
        openParticipants: (mucJid, ev) => openRediffParticipants(api, mucJid, ev),
    });
    window.rediffConverse = Object.assign(window.rediffConverse || {}, { overlay });
    return overlay;
};

if (!window.rediffNewChatPluginLoaded) {
    window.rediffNewChatPluginLoaded = true;

    converse.plugins.add(pluginName, {
        initialize() {
            const api = getConverseApi(this);
            if (!api?.settings) {
                console.error(`${pluginName}: Converse API is unavailable`);
                return;
            }

            window.rediffConverse = Object.assign(window.rediffConverse || {}, { api, _converse: this._converse });

            api.settings.extend({
                rediff_new_chat_search_url: '/api/users/search',
                rediff_new_chat_token_url: '/api/oidc/token',
                rediff_new_chat_token: null,
            });

            const auth = createRediffAuth(api);
            window.rediffConverse.newChat = {
                open: (ev) => openRediffNewChat(api, ev),
                auth,
            };
            window.rediffConverse.groups = {
                open: (ev) => openRediffGroups(api, ev),
                openParticipants: (mucJid, ev) => openRediffParticipants(api, mucJid, ev),
                refreshSidebar: () => syncManagedGroupsToSidebar(api, auth),
            };
            window.addEventListener('rediff:open-groups', (ev) => openRediffGroups(api, ev.detail?.event));
            window.addEventListener('rediff:open-participants', (ev) => {
                openRediffParticipants(api, ev.detail?.mucJid, ev.detail?.event);
            });

            defineRediffNewChatModal(api, auth);
            defineRediffGroupsModal(api, auth);
            installNativeEntryBridge(api, auth);
            installOverlay(api, this._converse);
            installTenantGuards(api);
            auth.installLoginCapture();

            api.listen.on('initialized', () => installTenantGuards(api));
            api.listen.on('connected', () => {
                installTenantGuards(api);
                installOverlay(api, this._converse);
                auth.bootstrapStoredSearchToken();
                window.setTimeout(() => syncManagedGroupsToSidebar(api, auth), 500);
            });
            api.listen.on('chatBoxesFetched', () => installOverlay(api, this._converse));
            api.listen.on('rosterContactsFetched', () => installOverlay(api, this._converse));

            auth.bootstrapStoredSearchToken();
            window.setTimeout(() => syncManagedGroupsToSidebar(api, auth), 1500);
        },
    });
}
