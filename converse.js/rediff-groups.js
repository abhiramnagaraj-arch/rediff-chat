(() => {
    if (window.rediffGroupsInstalled) return;
    window.rediffGroupsInstalled = true;

    const GROUPS_URL = '/api/groups';
    const USER_SEARCH_URL = '/api/users/search';
    const state = {
        groups: [],
        selectedMembers: new Map(),
        editingGroup: null,
        participantMucJid: null,
        activeMucJid: null,
        activeGroupId: null,
        groupByMuc: new Map(),
        participantMembers: new Map(),
    };

    const getApi = () => window.rediffConverse?.api || window.converse?.api;
    const getBareJid = (jid) => String(jid || '').split('/')[0].trim().toLowerCase();
    const getCurrentJid = () => getBareJid(getApi()?.user?.jid?.());
    const getTenantFromJid = (jid) => getBareJid(jid).split('@')[0].split('.')[0];
    const getDomainFromJid = (jid) => getBareJid(jid).split('@').pop() || '';
    const isSameTenantJid = (jid) => {
        const current = getCurrentJid();
        return Boolean(
            current &&
                getTenantFromJid(current) === getTenantFromJid(jid) &&
                getDomainFromJid(current) === getDomainFromJid(jid)
        );
    };

    const isAuthenticatedView = () => {
        const jid = getCurrentJid();
        const hasAuthForm = Boolean(
            document.querySelector('#converse-login, #converse-register, converse-login, converse-register')
        );
        const hasShell = Boolean(
            document.querySelector('#controlbox, converse-controlbox, converse-chatbox, converse-muc, .chatbox')
        );
        const newChatVisible = Boolean(document.querySelector('.rediff-new-chat-button.is-visible'));
        return Boolean((newChatVisible || hasShell) && jid && jid.includes('@') && !hasAuthForm);
    };

    const tokenKeys = ['rediff_access_token', 'access_token', 'keycloak_token', 'kc_token'];
    const getToken = () => {
        if (window.REDIFF_ACCESS_TOKEN) return window.REDIFF_ACCESS_TOKEN;
        for (const storage of [window.sessionStorage, window.localStorage]) {
            for (const key of tokenKeys) {
                const token = storage.getItem(key);
                if (token) return token;
            }
        }
        return null;
    };

    const authHeaders = () => {
        const token = getToken();
        if (!token) throw new Error('Missing access token');
        return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    };

    const ensurePanel = () => {
        let panel = document.querySelector('.rediff-groups-panel');
        if (panel) return panel;

        panel = document.createElement('section');
        panel.className = 'rediff-groups-panel';
        panel.setAttribute('aria-hidden', 'true');
        panel.innerHTML = `
            <div class="rediff-groups-backdrop" data-rediff-close-groups></div>
            <div class="rediff-groups-dialog" role="dialog" aria-modal="true" aria-labelledby="rediff-groups-title">
                <header class="rediff-groups-header">
                    <h2 id="rediff-groups-title">Groups</h2>
                    <button class="rediff-groups-close" type="button" aria-label="Close" data-rediff-close-groups>&times;</button>
                </header>
                <div class="rediff-groups-body">
                    <form class="rediff-groups-form">
                        <input name="name" type="text" placeholder="Group name" maxlength="120" required />
                        <textarea name="description" placeholder="Description" maxlength="1000"></textarea>
                        <div class="rediff-groups-member-search">
                            <input name="member_query" type="search" placeholder="Search members" autocomplete="off" />
                            <ul class="rediff-groups-member-results"></ul>
                        </div>
                        <ul class="rediff-groups-member-chips"></ul>
                        <div class="rediff-groups-actions">
                            <button type="submit" class="rediff-groups-save">Create</button>
                            <button type="button" class="rediff-groups-cancel hidden">Cancel</button>
                        </div>
                    </form>
                    <div class="rediff-groups-status" role="status"></div>
                    <ul class="rediff-groups-list"></ul>
                </div>
            </div>
        `;
        document.body.appendChild(panel);

        panel.addEventListener('click', (ev) => {
            if (ev.target.closest('[data-rediff-close-groups]')) closePanel();
        });
        panel.querySelector('.rediff-groups-form').addEventListener('submit', saveGroup);
        panel.querySelector('.rediff-groups-cancel').addEventListener('click', resetForm);
        panel.querySelector('input[name="member_query"]').addEventListener('input', debounce(searchMembers, 250));
        return panel;
    };

    const setStatus = (message) => {
        ensurePanel().querySelector('.rediff-groups-status').textContent = message || '';
    };

    const renderMemberChips = () => {
        const list = ensurePanel().querySelector('.rediff-groups-member-chips');
        list.replaceChildren();
        for (const [jid, label] of state.selectedMembers.entries()) {
            const item = document.createElement('li');
            item.textContent = label || jid;
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.setAttribute('aria-label', `Remove ${jid}`);
            remove.textContent = 'x';
            remove.addEventListener('click', () => {
                state.selectedMembers.delete(jid);
                renderMemberChips();
            });
            item.append(remove);
            list.append(item);
        }
    };

    const resetForm = () => {
        const panel = ensurePanel();
        state.editingGroup = null;
        state.selectedMembers.clear();
        panel.querySelector('.rediff-groups-form').reset();
        panel.querySelector('.rediff-groups-save').textContent = 'Create';
        panel.querySelector('.rediff-groups-cancel').classList.add('hidden');
        panel.querySelector('.rediff-groups-member-results').replaceChildren();
        renderMemberChips();
    };


    const ensureParticipantPanel = () => {
        let panel = document.querySelector('.rediff-add-participant-panel');
        if (panel) return panel;

        panel = document.createElement('section');
        panel.className = 'rediff-add-participant-panel';
        panel.setAttribute('aria-hidden', 'true');
        panel.innerHTML = `
            <div class="rediff-add-participant-backdrop" data-rediff-close-participants></div>
            <div class="rediff-add-participant-dialog" role="dialog" aria-modal="true" aria-labelledby="rediff-add-participant-title">
                <header class="rediff-add-participant-header">
                    <h2 id="rediff-add-participant-title">Add Participant</h2>
                    <button class="rediff-add-participant-close" type="button" aria-label="Close" data-rediff-close-participants>&times;</button>
                </header>
                <form class="rediff-add-participant-form">
                    <input name="participant_query" type="search" placeholder="Search people in your tenant" autocomplete="off" />
                    <ul class="rediff-add-participant-results"></ul>
                    <ul class="rediff-add-participant-chips"></ul>
                    <div class="rediff-add-participant-status" role="status"></div>
                    <button type="submit" class="rediff-add-participant-save">Add</button>
                </form>
            </div>
        `;
        document.body.appendChild(panel);
        panel.addEventListener('click', (ev) => {
            if (ev.target.closest('[data-rediff-close-participants]')) closeAddParticipantPanel();
        });
        panel.querySelector('.rediff-add-participant-form').addEventListener('submit', saveParticipants);
        panel.querySelector('input[name="participant_query"]').addEventListener('input', debounce(searchParticipants, 250));
        return panel;
    };

    const setParticipantStatus = (message) => {
        ensureParticipantPanel().querySelector('.rediff-add-participant-status').textContent = message || '';
    };

    const describeFetchError = async (response, fallback) => {
        try {
            const data = await response.json();
            return data?.detail || fallback;
        } catch (_) {
            return fallback;
        }
    };

    const rememberGroups = (groups) => {
        state.groups = Array.isArray(groups) ? groups : [];
        state.groupByMuc.clear();
        for (const group of state.groups) {
            if (group?.muc_jid) state.groupByMuc.set(getBareJid(group.muc_jid), group);
        }
    };

    const rememberActiveGroup = (groupOrId, mucJid) => {
        const safeMucJid = getBareJid(mucJid || groupOrId?.muc_jid);
        const group = typeof groupOrId === 'object' ? groupOrId : state.groups.find((item) => Number(item.id) === Number(groupOrId));
        state.activeMucJid = safeMucJid || state.activeMucJid;
        state.activeGroupId = group?.id || state.activeGroupId;
        if (group?.muc_jid) state.groupByMuc.set(getBareJid(group.muc_jid), group);
    };

    const renderParticipantChips = () => {
        const list = ensureParticipantPanel().querySelector('.rediff-add-participant-chips');
        list.replaceChildren();
        for (const [jid, label] of state.participantMembers.entries()) {
            const item = document.createElement('li');
            item.textContent = label || jid;
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.setAttribute('aria-label', `Remove ${jid}`);
            remove.textContent = 'x';
            remove.addEventListener('click', () => {
                state.participantMembers.delete(jid);
                renderParticipantChips();
            });
            item.append(remove);
            list.append(item);
        }
    };

    async function searchParticipants() {
        const panel = ensureParticipantPanel();
        const input = panel.querySelector('input[name="participant_query"]');
        const query = input.value.trim();
        const list = panel.querySelector('.rediff-add-participant-results');
        list.replaceChildren();
        if (!query) return;

        try {
            const response = await fetch(`${USER_SEARCH_URL}?q=${encodeURIComponent(query)}`, { headers: authHeaders() });
            if (!response.ok) throw new Error(`Participant search failed: ${response.status}`);
            const results = (await response.json()).filter((result) => result?.jid && isSameTenantJid(result.jid));
            results.forEach((result) => {
                const item = document.createElement('li');
                const button = document.createElement('button');
                button.type = 'button';
                button.textContent = `${result.display_name || result.jid} ${result.email ? `(${result.email})` : ''}`;
                button.addEventListener('click', () => {
                    state.participantMembers.set(getBareJid(result.jid), result.display_name || result.jid);
                    input.value = '';
                    list.replaceChildren();
                    renderParticipantChips();
                });
                item.append(button);
                list.append(item);
            });
        } catch (error) {
            console.error(error);
            setParticipantStatus('Unable to search users');
        }
    }

    const findGroupForMuc = async (mucJid) => {
        const wanted = getBareJid(mucJid) || state.activeMucJid;
        if (wanted && state.groupByMuc.has(wanted)) return state.groupByMuc.get(wanted);

        const groups = await loadGroups();
        if (wanted && state.groupByMuc.has(wanted)) return state.groupByMuc.get(wanted);
        if (state.activeGroupId) return groups.find((group) => Number(group.id) === Number(state.activeGroupId)) || null;

        const currentRoom = await getCurrentManagedRoom();
        if (currentRoom?.jid && state.groupByMuc.has(currentRoom.jid)) {
            state.activeMucJid = currentRoom.jid;
            return state.groupByMuc.get(currentRoom.jid);
        }
        return groups.length === 1 ? groups[0] : null;
    };

    const getCurrentManagedRoom = async () => {
        const api = getApi();
        if (!api?.rooms?.get) return null;
        try {
            const rooms = await api.rooms.get();
            const list = Array.isArray(rooms) ? rooms : [rooms];
            for (const room of list) {
                const jid = getBareJid(room?.get?.('jid'));
                if (jid && state.groupByMuc.has(jid)) return { jid, room };
            }
        } catch (error) {
            console.warn('Unable to inspect open MUC rooms', error);
        }
        return null;
    };

    async function saveParticipants(ev) {
        ev.preventDefault();
        const memberJids = [...state.participantMembers.keys()];
        if (!memberJids.length) {
            setParticipantStatus('Select at least one participant');
            return;
        }

        try {
            setParticipantStatus('Adding participants...');
            const group = await findGroupForMuc(state.participantMucJid);
            if (!group?.id) throw new Error(`No managed group found for ${state.participantMucJid || 'current room'}`);
            rememberActiveGroup(group, group.muc_jid);
            for (const member_jid of memberJids) {
                const response = await fetch(`${GROUPS_URL}/${group.id}/members`, {
                    method: 'POST',
                    headers: authHeaders(),
                    body: JSON.stringify({ member_jid, role: 'member' }),
                });
                if (!response.ok) throw new Error(await describeFetchError(response, `Member add failed: ${response.status}`));
            }
            await syncMucInvites(group.muc_jid, memberJids, 'You were added to this group');
            state.participantMembers.clear();
            renderParticipantChips();
            setParticipantStatus('Participant added');
            window.setTimeout(closeAddParticipantPanel, 500);
        } catch (error) {
            console.error(error);
            setParticipantStatus(error?.message || 'Unable to add participant');
        }
    }

    function openAddParticipantPanel(mucJid) {
        const safeMucJid = getBareJid(mucJid);
        if (!safeMucJid) return;
        state.participantMucJid = safeMucJid || state.activeMucJid;
        state.participantMembers.clear();
        const panel = ensureParticipantPanel();
        panel.querySelector('.rediff-add-participant-form').reset();
        panel.querySelector('.rediff-add-participant-results').replaceChildren();
        renderParticipantChips();
        setParticipantStatus('');
        panel.classList.add('is-open');
        panel.setAttribute('aria-hidden', 'false');
        panel.querySelector('input[name="participant_query"]').focus();
    }

    function closeAddParticipantPanel() {
        const panel = ensureParticipantPanel();
        panel.classList.remove('is-open');
        panel.setAttribute('aria-hidden', 'true');
    }

    const renderGroups = () => {
        const list = ensurePanel().querySelector('.rediff-groups-list');
        list.replaceChildren();
        if (!state.groups.length) {
            const empty = document.createElement('li');
            empty.className = 'rediff-groups-empty';
            empty.textContent = 'No groups yet';
            list.append(empty);
            return;
        }

        state.groups.forEach((group) => {
            const item = document.createElement('li');
            item.className = 'rediff-groups-item';
            const text = document.createElement('div');
            text.className = 'rediff-groups-copy';
            const name = document.createElement('strong');
            name.textContent = group.name;
            const desc = document.createElement('span');
            desc.textContent = group.description || group.muc_jid;
            text.append(name, desc);

            const actions = document.createElement('div');
            actions.className = 'rediff-groups-row-actions';
            const open = document.createElement('button');
            open.type = 'button';
            open.textContent = group.can_open ? 'Open' : 'Join';
            open.disabled = !group.can_join && !group.can_open;
            open.addEventListener('click', () => openGroup(group.id));
            actions.append(open);

            if (group.can_edit) {
                const edit = document.createElement('button');
                edit.type = 'button';
                edit.textContent = 'Edit';
                edit.addEventListener('click', () => beginEdit(group));
                actions.append(edit);
            }

            item.append(text, actions);
            list.append(item);
        });
    };

    const loadGroups = async () => {
        setStatus('Loading groups...');
        try {
            const response = await fetch(GROUPS_URL, { headers: authHeaders() });
            if (!response.ok) throw new Error(`Group load failed: ${response.status}`);
            rememberGroups(await response.json());
            renderGroups();
            setStatus('');
            return state.groups;
        } catch (error) {
            console.error(error);
            setStatus('Unable to load groups');
            return [];
        }
    };

    async function searchMembers() {
        const panel = ensurePanel();
        const input = panel.querySelector('input[name="member_query"]');
        const query = input.value.trim();
        const list = panel.querySelector('.rediff-groups-member-results');
        list.replaceChildren();
        if (!query) return;

        try {
            const response = await fetch(`${USER_SEARCH_URL}?q=${encodeURIComponent(query)}`, { headers: authHeaders() });
            if (!response.ok) throw new Error(`Member search failed: ${response.status}`);
            const results = (await response.json()).filter((result) => result?.jid && isSameTenantJid(result.jid));
            results.forEach((result) => {
                const item = document.createElement('li');
                const button = document.createElement('button');
                button.type = 'button';
                button.textContent = `${result.display_name || result.jid} ${result.email ? `(${result.email})` : ''}`;
                button.addEventListener('click', () => {
                    state.selectedMembers.set(getBareJid(result.jid), result.display_name || result.jid);
                    input.value = '';
                    list.replaceChildren();
                    renderMemberChips();
                });
                item.append(button);
                list.append(item);
            });
        } catch (error) {
            console.error(error);
            setStatus('Unable to search members');
        }
    }

    async function saveGroup(ev) {
        ev.preventDefault();
        const form = ev.target;
        const data = new FormData(form);
        const payload = {
            name: String(data.get('name') || '').trim(),
            description: String(data.get('description') || '').trim(),
        };
        if (!payload.name) return;

        try {
            const wasEditing = Boolean(state.editingGroup);
            setStatus(wasEditing ? 'Saving group...' : 'Creating group...');
            let response;
            if (wasEditing) {
                response = await fetch(`${GROUPS_URL}/${state.editingGroup.id}`, {
                    method: 'PATCH',
                    headers: authHeaders(),
                    body: JSON.stringify(payload),
                });
            } else {
                const selectedMemberJids = [...state.selectedMembers.keys()];
                response = await fetch(GROUPS_URL, {
                    method: 'POST',
                    headers: authHeaders(),
                    body: JSON.stringify({ ...payload, initial_members: selectedMemberJids }),
                });
                if (!response.ok) throw new Error(`Group save failed: ${response.status}`);
                const group = await response.json();
                rememberActiveGroup(group, group.muc_jid);
                resetForm();
                await loadGroups();
                const room = await openApprovedRoom(group.muc_jid, group.room_config, true);
                await syncMucInvites(room, selectedMemberJids, 'You were added to this group');
                setStatus('');
                return;
            }
            if (!response.ok) throw new Error(`Group save failed: ${response.status}`);
            resetForm();
            await loadGroups();
            setStatus('');
        } catch (error) {
            console.error(error);
            setStatus('Unable to save group');
        }
    }

    const beginEdit = (group) => {
        const panel = ensurePanel();
        state.editingGroup = group;
        panel.querySelector('input[name="name"]').value = group.name || '';
        panel.querySelector('textarea[name="description"]').value = group.description || '';
        panel.querySelector('.rediff-groups-save').textContent = 'Save';
        panel.querySelector('.rediff-groups-cancel').classList.remove('hidden');
        state.selectedMembers.clear();
        renderMemberChips();
    };

    const openGroup = async (id) => {
        try {
            setStatus('Opening group...');
            const response = await fetch(`${GROUPS_URL}/${id}/join`, {
                method: 'POST',
                headers: authHeaders(),
            });
            if (!response.ok) throw new Error(`Join denied: ${response.status}`);
            const data = await response.json();
            rememberActiveGroup(id, data.muc_jid);
            await openApprovedRoom(data.muc_jid, data.room_config, false);
            closePanel();
        } catch (error) {
            console.error(error);
            setStatus('You are not allowed to open this group');
        }
    };

    const openApprovedRoom = async (mucJid, roomConfig, autoConfigure) => {
        const api = getApi();
        if (!api?.rooms?.open) throw new Error('Converse rooms API is unavailable');
        const safeMucJid = getBareJid(mucJid);
        state.activeMucJid = safeMucJid || state.activeMucJid;
        const nick = getCurrentJid().split('@')[0];
        return api.rooms.open(
            mucJid,
            {
                nick,
                auto_configure: Boolean(autoConfigure),
                roomconfig: roomConfig || {},
            },
            true
        );
    };

    const syncMucInvites = async (roomOrJid, memberJids, reason) => {
        const jids = [...new Set((memberJids || []).map(getBareJid).filter(Boolean))].filter((jid) => jid !== getCurrentJid());
        if (!jids.length) return;

        const api = getApi();
        let room = typeof roomOrJid === 'string' ? null : roomOrJid;
        if (!room && api?.rooms?.get) {
            try {
                room = await api.rooms.get(roomOrJid);
            } catch (error) {
                console.warn('Unable to get MUC for invite sync', error);
            }
        }

        if (room?.initialized?.then) {
            await Promise.race([Promise.resolve(room.initialized).catch(() => null), new Promise((resolve) => window.setTimeout(resolve, 1200))]);
        }

        if (room?.updateMemberLists) {
            await room.updateMemberLists(jids.map((jid) => ({ jid, affiliation: 'member', reason })));
        }

        for (const jid of jids) {
            try {
                if (room?.directInvite) {
                    room.directInvite(jid, reason);
                }
            } catch (error) {
                console.warn(`Unable to send MUC invite for ${jid}`, error);
            }
        }
    };

    function openPanel() {
        const panel = ensurePanel();
        panel.classList.add('is-open');
        document.body.classList.add('rediff-groups-open');
        panel.setAttribute('aria-hidden', 'false');
        loadGroups();
        panel.querySelector('input[name="name"]').focus();
    }

    function closePanel() {
        const panel = ensurePanel();
        panel.classList.remove('is-open');
        document.body.classList.remove('rediff-groups-open');
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
        return true;
    };

    const hideButton = () => {
        document.querySelector('.rediff-groups-button')?.classList.remove('is-visible');
        if (document.body.classList.contains('rediff-groups-open')) closePanel();
    };

    const injectButton = () => {
        if (!isAuthenticatedView()) {
            hideButton();
            return false;
        }

        let button = document.querySelector('.rediff-groups-button');
        if (!button) {
            button = document.createElement('button');
            button.type = 'button';
            button.className = 'rediff-groups-button rediff-groups-button--fixed';
            button.textContent = '+ New Group';
            button.addEventListener('click', openPanel);
            document.body.appendChild(button);
        }
        const ready = positionButton(button);
        button.classList.toggle('is-visible', ready);
        return ready;
    };

    const getMucJidFromOccupants = (occupantsEl) => {
        const modelJid = occupantsEl?.model?.get?.('jid');
        if (modelJid) return modelJid;
        const mucEl = occupantsEl?.closest?.('converse-muc, converse-muc-chatarea, converse-chatbox');
        return mucEl?.model?.get?.('jid') || mucEl?.getAttribute?.('jid') || '';
    };

    const enhanceParticipantButtons = () => {
        document.querySelectorAll('converse-muc-occupants').forEach((occupantsEl) => {
            const header = occupantsEl.querySelector('.occupants-header--title');
            if (!header || header.querySelector('.rediff-add-participant-button')) return;
            const mucJid = getMucJidFromOccupants(occupantsEl) || state.activeMucJid;
            if (!mucJid && !state.activeGroupId) return;
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'rediff-add-participant-button';
            button.title = 'Add participant';
            button.textContent = '+ Add';
            button.addEventListener('click', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                openAddParticipantPanel(getMucJidFromOccupants(occupantsEl) || mucJid);
            });
            const menu = header.querySelector('converse-dropdown, .chatbox-btn');
            if (menu) header.insertBefore(button, menu);
            else header.appendChild(button);
        });
    };

    const start = () => {
        injectButton();
        enhanceParticipantButtons();
        window.setTimeout(() => { injectButton(); enhanceParticipantButtons(); }, 250);
        window.setTimeout(() => { injectButton(); enhanceParticipantButtons(); }, 600);
        window.setTimeout(() => { injectButton(); enhanceParticipantButtons(); }, 1200);
        window.setTimeout(() => { injectButton(); enhanceParticipantButtons(); }, 2500);
        window.setInterval(() => { injectButton(); enhanceParticipantButtons(); }, 2000);
        new MutationObserver(() => { injectButton(); enhanceParticipantButtons(); }).observe(document.body, { childList: true, subtree: true });
        window.addEventListener('resize', injectButton);
    };

    window.rediffGroups = {
        open: openPanel,
        openAddParticipant: openAddParticipantPanel,
        inject: injectButton,
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();
