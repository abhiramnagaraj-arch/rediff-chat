import { getBareJid, getCurrentJid, isSameTenantJid } from '../rediff-shared/index.js';

const GROUPS_URL = '/api/groups';
const USER_SEARCH_URL = '/api/users/search';

const escapeHTML = (value) =>
    String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

const debounce = (callback, delay) => {
    let timeout;
    return (...args) => {
        window.clearTimeout(timeout);
        timeout = window.setTimeout(() => callback(...args), delay);
    };
};

const describeFetchError = async (response, fallback) => {
    try {
        const data = await response.json();
        return data?.detail || fallback;
    } catch (_) {
        return fallback;
    }
};

export class RediffGroupsModal extends HTMLElement {
    constructor() {
        super();
        this.api = null;
        this.auth = null;
        this.mode = 'groups';
        this.groups = [];
        this.memberResults = [];
        this.selectedMembers = new Map();
        this.editingGroup = null;
        this.status = '';
        this.loading = false;

        this.participantMucJid = null;
        this.participantGroup = null;
        this.participantMembers = [];
        this.participantResults = [];
        this.participantSelected = new Map();
        this.participantStatus = '';
        this.participantLoading = false;

        this.searchMembers = debounce(() => this.searchMembersNow(), 250);
        this.searchParticipants = debounce(() => this.searchParticipantsNow(), 250);
        this.className = 'modal rediff-groups-modal';
        this.tabIndex = -1;
        this.setAttribute('aria-hidden', 'true');
    }

    connectedCallback() {
        this.render();
    }

    show() {
        const container = document.querySelector('#converse-modals') || document.body;
        if (!this.isConnected) container.append(this);
        this.classList.add('show', 'is-open');
        this.style.display = 'block';
        this.setAttribute('aria-hidden', 'false');
        this.render();
        if (this.mode === 'participants') {
            this.loadParticipantGroup();
            window.setTimeout(() => this.querySelector('input[name="participant_query"]')?.focus());
        } else {
            this.loadGroups();
            window.setTimeout(() => this.querySelector('input[name="name"]')?.focus());
        }
    }

    close() {
        this.classList.remove('show', 'is-open');
        this.style.display = 'none';
        this.setAttribute('aria-hidden', 'true');
        this.remove();
    }

    refreshManagedSidebar() {
        window.rediffConverse?.groups?.refreshSidebar?.();
    }

    setStatus(message) {
        this.status = message || '';
        this.render();
    }

    setParticipantStatus(message) {
        this.participantStatus = message || '';
        this.render();
    }

    async fetchJson(url, options = {}) {
        const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
        const { response, missingToken } = await this.auth.authenticatedFetch(url, { ...options, headers });
        if (missingToken) throw new Error('Please log out and log in again to enable groups');
        if (!response.ok) throw new Error(await describeFetchError(response, `Request failed: ${response.status}`));
        if (response.status === 204) return null;
        return response.json();
    }

    rememberGroups(groups) {
        this.groups = Array.isArray(groups) ? groups : [];
    }

    async loadGroups() {
        if (this.loading) return;
        this.loading = true;
        this.status = 'Loading groups...';
        this.render();
        try {
            this.rememberGroups(await this.fetchJson(GROUPS_URL));
            this.status = '';
            this.syncManagedBookmarks(this.groups).catch((error) => {
                console.warn('Unable to sync managed bookmarks', error);
            });
        } catch (error) {
            console.error(error);
            this.status = error?.message || 'Unable to load groups';
        } finally {
            this.loading = false;
            this.render();
        }
    }

    async getGroupDetail(group) {
        if (!group?.id) return null;
        return this.fetchJson(`${GROUPS_URL}/${group.id}`);
    }

    async findGroupByMuc(mucJid) {
        const safeMucJid = getBareJid(mucJid);
        if (!this.groups.length) this.rememberGroups(await this.fetchJson(GROUPS_URL));
        return this.groups.find((group) => getBareJid(group.muc_jid) === safeMucJid) || null;
    }

    async loadParticipantGroup() {
        if (this.participantLoading) return;
        this.participantLoading = true;
        this.participantStatus = 'Loading participants...';
        this.participantResults = [];
        this.participantSelected.clear();
        this.render();
        try {
            const group = await this.findGroupByMuc(this.participantMucJid);
            if (!group) throw new Error('This room is not a managed Rediff group');
            const detail = await this.getGroupDetail(group);
            this.participantGroup = detail;
            this.participantMembers = Array.isArray(detail?.members) ? detail.members : [];
            this.participantStatus = '';
        } catch (error) {
            console.error(error);
            this.participantGroup = null;
            this.participantMembers = [];
            this.participantStatus = error?.message || 'Unable to load participants';
        } finally {
            this.participantLoading = false;
            this.render();
        }
    }

    async searchMembersNow() {
        const input = this.querySelector('input[name="member_query"]');
        const query = input?.value.trim() || '';
        this.memberResults = [];
        if (!query) {
            this.render();
            return;
        }

        try {
            const results = await this.fetchJson(`${USER_SEARCH_URL}?q=${encodeURIComponent(query)}`);
            this.memberResults = (Array.isArray(results) ? results : []).filter(
                (result) => result?.jid && isSameTenantJid(this.api, result.jid)
            );
            this.status = '';
        } catch (error) {
            console.error(error);
            this.status = error?.message || 'Unable to search members';
        }
        this.render();
    }

    async searchParticipantsNow() {
        const input = this.querySelector('input[name="participant_query"]');
        const query = input?.value.trim() || '';
        this.participantResults = [];
        if (!query) {
            this.render();
            return;
        }

        try {
            const existingJids = new Set(this.participantMembers.map((member) => getBareJid(member.member_jid)));
            const selectedJids = new Set(this.participantSelected.keys());
            const results = await this.fetchJson(`${USER_SEARCH_URL}?q=${encodeURIComponent(query)}`);
            this.participantResults = (Array.isArray(results) ? results : []).filter((result) => {
                const jid = getBareJid(result?.jid);
                return jid && isSameTenantJid(this.api, jid) && !existingJids.has(jid) && !selectedJids.has(jid);
            });
            this.participantStatus = this.participantResults.length ? '' : 'No eligible users found';
        } catch (error) {
            console.error(error);
            this.participantStatus = error?.message || 'Unable to search participants';
        }
        this.render();
    }

    selectMember(index) {
        const result = this.memberResults[index];
        if (!result?.jid) return;
        this.selectedMembers.set(getBareJid(result.jid), result.display_name || result.jid);
        this.memberResults = [];
        this.render();
        const input = this.querySelector('input[name="member_query"]');
        if (input) input.value = '';
    }

    selectParticipant(index) {
        const result = this.participantResults[index];
        if (!result?.jid) return;
        this.participantSelected.set(getBareJid(result.jid), result.display_name || result.jid);
        this.participantResults = [];
        this.participantStatus = '';
        this.render();
        const input = this.querySelector('input[name="participant_query"]');
        if (input) input.value = '';
    }

    removeMember(jid) {
        this.selectedMembers.delete(jid);
        this.render();
    }

    removeSelectedParticipant(jid) {
        this.participantSelected.delete(jid);
        this.render();
    }

    resetForm() {
        this.editingGroup = null;
        this.selectedMembers.clear();
        this.memberResults = [];
        this.status = '';
        this.render();
    }

    beginEdit(id) {
        const group = this.groups.find((item) => Number(item.id) === Number(id));
        if (!group) return;
        this.editingGroup = group;
        this.selectedMembers.clear();
        this.memberResults = [];
        this.render();
    }

    async saveGroup(ev) {
        ev.preventDefault();
        const data = new FormData(ev.currentTarget);
        const payload = {
            name: String(data.get('name') || '').trim(),
            description: String(data.get('description') || '').trim(),
        };
        if (!payload.name) return;

        try {
            this.setStatus(this.editingGroup ? 'Saving group...' : 'Creating group...');
            if (this.editingGroup) {
                await this.fetchJson(`${GROUPS_URL}/${this.editingGroup.id}`, {
                    method: 'PATCH',
                    body: JSON.stringify(payload),
                });
                this.resetForm();
                await this.loadGroups();
                return;
            }

            const memberJids = [...this.selectedMembers.keys()];
            const group = await this.fetchJson(GROUPS_URL, {
                method: 'POST',
                body: JSON.stringify({ ...payload, initial_members: memberJids }),
            });
            this.resetForm();
            await this.loadGroups();
            await this.openApprovedRoom(group.muc_jid, group.room_config, true);
            await this.syncMucInvites(group.muc_jid, memberJids, 'You were added to this group');
            this.refreshManagedSidebar();
            this.close();
        } catch (error) {
            console.error(error);
            this.setStatus(error?.message || 'Unable to save group');
        }
    }

    async addParticipants(ev) {
        ev?.preventDefault?.();
        const group = this.participantGroup;
        const jids = [...this.participantSelected.keys()];
        if (!group?.id || !jids.length) {
            this.setParticipantStatus('Select at least one participant');
            return;
        }

        try {
            this.setParticipantStatus('Adding participants...');
            for (const member_jid of jids) {
                await this.fetchJson(`${GROUPS_URL}/${group.id}/members`, {
                    method: 'POST',
                    body: JSON.stringify({ member_jid, role: 'member' }),
                });
            }
            await this.syncMucInvites(group.muc_jid, jids, 'You were added to this group');
            this.participantSelected.clear();
            this.refreshManagedSidebar();
            await this.loadParticipantGroup();
            this.setParticipantStatus('Participant added');
        } catch (error) {
            console.error(error);
            this.setParticipantStatus(error?.message || 'Unable to add participant');
        }
    }

    async removeParticipant(jid) {
        const group = this.participantGroup;
        if (!group?.id || !jid) return;
        try {
            this.setParticipantStatus('Removing participant...');
            await this.fetchJson(`${GROUPS_URL}/${group.id}/members/${encodeURIComponent(jid)}`, { method: 'DELETE' });
            this.refreshManagedSidebar();
            await this.loadParticipantGroup();
            await this.refreshOpenRoom(group.muc_jid);
            this.setParticipantStatus('Participant removed');
        } catch (error) {
            console.error(error);
            this.setParticipantStatus(error?.message || 'Unable to remove participant');
        }
    }

    async exitGroup() {
        const group = this.participantGroup;
        const jid = getCurrentJid(this.api);
        if (!group?.id || !jid) return;
        try {
            this.setParticipantStatus('Exiting group...');
            await this.fetchJson(`${GROUPS_URL}/${group.id}/members/${encodeURIComponent(jid)}`, { method: 'DELETE' });
            await this.closeOpenRoom(group.muc_jid, 'Exited group');
            this.refreshManagedSidebar();
            this.close();
        } catch (error) {
            console.error(error);
            this.setParticipantStatus(error?.message || 'Unable to exit group');
        }
    }

    async openGroup(id) {
        try {
            this.setStatus('Opening group...');
            const data = await this.fetchJson(`${GROUPS_URL}/${id}/join`, { method: 'POST', body: '{}' });
            await this.openApprovedRoom(data.muc_jid, data.room_config, false);
            this.refreshManagedSidebar();
            this.close();
        } catch (error) {
            console.error(error);
            this.setStatus(error?.message || 'You are not allowed to open this group');
        }
    }

    async openApprovedRoom(mucJid, roomConfig, autoConfigure) {
        if (!this.api?.rooms?.open) throw new Error('Converse rooms API is unavailable');
        const nick = getCurrentJid(this.api).split('@')[0];
        const group = this.groups.find((item) => getBareJid(item.muc_jid) === getBareJid(mucJid));
        if (group) {
            this.syncManagedBookmark(group, { autojoin: true }).catch((error) => {
                console.warn('Unable to sync bookmark before opening group', error);
            });
        }
        return this.api.rooms.open(
            mucJid,
            {
                nick,
                auto_configure: Boolean(autoConfigure),
                roomconfig: roomConfig || {},
            },
            true
        );
    }

    async getOpenRoom(mucJid) {
        if (!this.api?.rooms?.get || !mucJid) return null;
        try {
            return await this.api.rooms.get(mucJid);
        } catch (error) {
            console.warn('Unable to get open MUC room', mucJid, error);
            return null;
        }
    }

    async updateMucAffiliations(mucJid, changes, { optional = false } = {}) {
        const room = await this.getOpenRoom(mucJid);
        if (room?.initialized?.then) {
            await Promise.race([
                Promise.resolve(room.initialized).catch(() => null),
                new Promise((resolve) => window.setTimeout(resolve, 1200)),
            ]);
        }

        try {
            const removals = changes.filter((change) => change?.affiliation === 'none');
            const additions = changes.filter((change) => change?.affiliation !== 'none');

            if (additions.length) {
                if (!room?.updateMemberLists) throw new Error('Unable to update live group membership');
                await room.updateMemberLists(additions);
            }
            if (removals.length) {
                if (!this.api?.rooms?.affiliations?.set) throw new Error('Unable to revoke live group membership');
                await this.api.rooms.affiliations.set(mucJid, removals);
            }
            await room?.occupants?.fetchMembers?.();
        } catch (error) {
            console.warn('Unable to update live MUC affiliations', error);
            if (!optional) throw error;
        }
    }

    async refreshOpenRoom(mucJid) {
        if (!this.api?.rooms?.get) return;
        try {
            const room = await this.api.rooms.get(mucJid);
            if (room?.fetchMembers) await room.fetchMembers();
        } catch (error) {
            console.warn('Unable to refresh MUC members', error);
        }
    }

    async closeOpenRoom(mucJid, reason) {
        const room = await this.getOpenRoom(mucJid);
        if (!room) return;
        try {
            if (room.leave) await room.leave(reason);
            await room.close?.({ name: 'rediffExitGroup' });
        } catch (error) {
            console.warn('Unable to close exited group room', error);
        }
    }

    async syncManagedBookmark(group, { autojoin = false } = {}) {
        if (!this.api?.bookmarks?.set || !group?.muc_jid) return;
        try {
            const existing = this.api.bookmarks.get ? await this.api.bookmarks.get(group.muc_jid) : null;
            await this.api.bookmarks.set({
                jid: group.muc_jid,
                name: group.name || group.muc_jid,
                nick: getCurrentJid(this.api).split('@')[0],
                autojoin: Boolean(existing?.get?.('autojoin') || autojoin),
            });
        } catch (error) {
            console.warn('Unable to sync bookmark for managed group', group?.muc_jid, error);
        }
    }

    async syncManagedBookmarks(groups) {
        await Promise.all((groups || []).map((group) => this.syncManagedBookmark(group)));
    }

    async syncMucInvites(roomOrJid, memberJids, reason) {
        const jids = [...new Set((memberJids || []).map(getBareJid).filter(Boolean))].filter((jid) => jid !== getCurrentJid(this.api));
        if (!jids.length) return;

        let room = typeof roomOrJid === 'string' ? null : roomOrJid;
        if (!room && this.api?.rooms?.get) {
            try {
                room = await this.api.rooms.get(roomOrJid);
            } catch (error) {
                console.warn('Unable to get MUC for invite sync', error);
            }
        }

        if (room?.initialized?.then) {
            await Promise.race([
                Promise.resolve(room.initialized).catch(() => null),
                new Promise((resolve) => window.setTimeout(resolve, 1200)),
            ]);
        }

        if (room?.updateMemberLists) {
            await room.updateMemberLists(jids.map((jid) => ({ jid, affiliation: 'member', reason })));
        }

        for (const jid of jids) {
            try {
                room?.directInvite?.(jid, reason);
            } catch (error) {
                console.warn(`Unable to send MUC invite for ${jid}`, error);
            }
        }
    }

    renderGroupList() {
        if (this.loading) return '';
        if (!this.groups.length) return '<li class="rediff-groups-empty">No groups yet</li>';
        return this.groups
            .map(
                (group) => `
                    <li class="rediff-groups-item">
                        <div class="rediff-groups-copy">
                            <strong>${escapeHTML(group.name)}</strong>
                            <span>${escapeHTML(group.description || group.muc_jid)}</span>
                        </div>
                        <div class="rediff-groups-row-actions">
                            <button type="button" data-rediff-open-group="${group.id}" ${!group.can_join && !group.can_open ? 'disabled' : ''}>${group.can_open ? 'Open' : 'Join'}</button>
                            ${group.can_edit ? `<button type="button" data-rediff-edit-group="${group.id}">Edit</button>` : ''}
                        </div>
                    </li>
                `
            )
            .join('');
    }

    renderParticipantsBody() {
        const group = this.participantGroup;
        const currentJid = getCurrentJid(this.api);
        const canEdit = Boolean(group?.can_edit);
        const isOwner = group?.owner_jid && getBareJid(group.owner_jid) === currentJid;
        const memberRows = this.participantMembers.length
            ? this.participantMembers
                  .map((member) => {
                      const jid = getBareJid(member.member_jid);
                      const isSelf = jid === currentJid;
                      const canRemove = canEdit && !isSelf && jid !== getBareJid(group?.owner_jid);
                      return `
                        <li class="rediff-groups-item rediff-participant-item">
                            <div class="rediff-groups-copy">
                                <strong>${escapeHTML(jid)}${isSelf ? ' (you)' : ''}</strong>
                                <span>${escapeHTML(member.role || member.affiliation || 'member')}</span>
                            </div>
                            <div class="rediff-groups-row-actions">
                                ${canRemove ? `<button type="button" data-rediff-remove-participant="${escapeHTML(jid)}">Remove</button>` : ''}
                            </div>
                        </li>`;
                  })
                  .join('')
            : '<li class="rediff-groups-empty">No participants found</li>';

        return `
            <div class="rediff-participant-summary">
                <strong>${escapeHTML(group?.name || 'Participants')}</strong>
                <span>${escapeHTML(group?.muc_jid || this.participantMucJid || '')}</span>
            </div>
            ${canEdit ? `
                <form class="rediff-participants-form">
                    <div class="rediff-groups-member-search">
                        <input class="form-control" name="participant_query" type="search" placeholder="Search same-tenant users to add" autocomplete="off" />
                        <ul class="rediff-groups-member-results">
                            ${this.participantResults
                                .map(
                                    (result, index) => `
                                        <li><button type="button" data-rediff-select-participant="${index}">${escapeHTML(result.display_name || result.jid)} ${result.email ? `(${escapeHTML(result.email)})` : ''}</button></li>
                                    `
                                )
                                .join('')}
                        </ul>
                    </div>
                    <ul class="rediff-groups-member-chips">
                        ${[...this.participantSelected.entries()]
                            .map(
                                ([jid, label]) => `
                                    <li>${escapeHTML(label || jid)} <button type="button" aria-label="Remove ${escapeHTML(jid)}" data-rediff-remove-selected-participant="${escapeHTML(jid)}">x</button></li>
                                `
                            )
                            .join('')}
                    </ul>
                    <div class="rediff-groups-actions">
                        <button type="submit" class="rediff-groups-save btn btn-primary">Add Participant</button>
                    </div>
                </form>
            ` : ''}
            <div class="rediff-groups-status" role="status">${escapeHTML(this.participantStatus)}</div>
            <ul class="rediff-groups-list rediff-participants-list">${this.participantLoading ? '' : memberRows}</ul>
            ${!isOwner && group ? '<button type="button" class="rediff-exit-group btn btn-secondary">Exit Group</button>' : ''}
        `;
    }

    renderGroupsBody() {
        const editing = this.editingGroup;
        return `
            <form class="rediff-groups-form">
                <input class="form-control" name="name" type="text" placeholder="Group name" maxlength="120" required value="${escapeHTML(editing?.name || '')}" />
                <textarea class="form-control" name="description" placeholder="Description" maxlength="1000">${escapeHTML(editing?.description || '')}</textarea>
                <div class="rediff-groups-member-search">
                    <input class="form-control" name="member_query" type="search" placeholder="Search members" autocomplete="off" />
                    <ul class="rediff-groups-member-results">
                        ${this.memberResults
                            .map(
                                (result, index) => `
                                    <li><button type="button" data-rediff-select-member="${index}">${escapeHTML(result.display_name || result.jid)} ${result.email ? `(${escapeHTML(result.email)})` : ''}</button></li>
                                `
                            )
                            .join('')}
                    </ul>
                </div>
                <ul class="rediff-groups-member-chips">
                    ${[...this.selectedMembers.entries()]
                        .map(
                            ([jid, label]) => `
                                <li>${escapeHTML(label || jid)} <button type="button" aria-label="Remove ${escapeHTML(jid)}" data-rediff-remove-member="${escapeHTML(jid)}">x</button></li>
                            `
                        )
                        .join('')}
                </ul>
                <div class="rediff-groups-actions">
                    <button type="submit" class="rediff-groups-save btn btn-primary">${editing ? 'Save' : 'Create'}</button>
                    ${editing ? '<button type="button" class="rediff-groups-cancel btn btn-secondary">Cancel</button>' : ''}
                </div>
            </form>
            <div class="rediff-groups-status" role="status">${escapeHTML(this.status)}</div>
            <ul class="rediff-groups-list">${this.renderGroupList()}</ul>
        `;
    }

    render() {
        const participantsMode = this.mode === 'participants';
        this.dataset.mode = participantsMode ? 'participants' : 'groups';
        this.innerHTML = `
            <div class="modal-dialog rediff-groups-dialog ${participantsMode ? 'rediff-groups-dialog--participants' : 'rediff-groups-dialog--groups'}" role="document">
                <div class="modal-content">
                    <header class="modal-header rediff-groups-header">
                        <h5 class="modal-title" id="rediff-groups-title">${participantsMode ? 'Participants' : 'Groups'}</h5>
                        <button class="btn-close rediff-groups-close" type="button" aria-label="Close" data-rediff-close-groups></button>
                    </header>
                    <div class="modal-body rediff-groups-body ${participantsMode ? 'rediff-groups-body--participants' : 'rediff-groups-body--groups'}">
                        ${participantsMode ? this.renderParticipantsBody() : this.renderGroupsBody()}
                    </div>
                </div>
            </div>
        `;

        this.querySelector('[data-rediff-close-groups]')?.addEventListener('click', () => this.close());
        this.querySelector('.rediff-groups-form')?.addEventListener('submit', (ev) => this.saveGroup(ev));
        this.querySelector('.rediff-groups-cancel')?.addEventListener('click', () => this.resetForm());
        this.querySelector('input[name="member_query"]')?.addEventListener('input', () => this.searchMembers());
        this.querySelectorAll('[data-rediff-select-member]').forEach((button) => {
            button.addEventListener('click', () => this.selectMember(Number(button.dataset.rediffSelectMember)));
        });
        this.querySelectorAll('[data-rediff-remove-member]').forEach((button) => {
            button.addEventListener('click', () => this.removeMember(button.dataset.rediffRemoveMember));
        });
        this.querySelectorAll('[data-rediff-open-group]').forEach((button) => {
            button.addEventListener('click', () => this.openGroup(button.dataset.rediffOpenGroup));
        });
        this.querySelectorAll('[data-rediff-edit-group]').forEach((button) => {
            button.addEventListener('click', () => this.beginEdit(button.dataset.rediffEditGroup));
        });

        this.querySelector('.rediff-participants-form')?.addEventListener('submit', (ev) => this.addParticipants(ev));
        this.querySelector('input[name="participant_query"]')?.addEventListener('input', () => this.searchParticipants());
        this.querySelectorAll('[data-rediff-select-participant]').forEach((button) => {
            button.addEventListener('click', () => this.selectParticipant(Number(button.dataset.rediffSelectParticipant)));
        });
        this.querySelectorAll('[data-rediff-remove-selected-participant]').forEach((button) => {
            button.addEventListener('click', () => this.removeSelectedParticipant(button.dataset.rediffRemoveSelectedParticipant));
        });
        this.querySelectorAll('[data-rediff-remove-participant]').forEach((button) => {
            button.addEventListener('click', () => this.removeParticipant(button.dataset.rediffRemoveParticipant));
        });
        this.querySelector('.rediff-exit-group')?.addEventListener('click', () => this.exitGroup());
    }
}

export const defineRediffGroupsModal = (api, auth) => {
    if (!customElements.get('converse-rediff-groups-modal')) {
        customElements.define('converse-rediff-groups-modal', RediffGroupsModal);
    }

    const originalCreate = api.modal?.create?.bind(api.modal);
    if (originalCreate && !api.modal.create.rediffGroupsFactory) {
        api.modal.create = (name, properties = {}) => {
            const modal = originalCreate(name, properties);
            if (name === 'converse-rediff-groups-modal') {
                modal.api = api;
                modal.auth = auth;
            }
            return modal;
        };
        api.modal.create.rediffGroupsFactory = true;
    }
};
