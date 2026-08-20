/**
 * @typedef {import('@converse/headless').MUCOccupant} MUCOccupant
 */
import { html } from "lit";
import { repeat } from 'lit/directives/repeat.js';
import { __ } from 'i18n';
import 'shared/components/list-filter.js';
import './../sidebar-occupant.js';
import tplOccupantsFilter from './occupants-filter.js';

/**
 * @param {import('../occupants').default} el
 * @param {MUCOccupant} occ
 */
function isOccupantFiltered (el, occ) {
    if (!el.model.get('filter_visible')) return false;

    const type = el.filter.get('type');
    const q = (type === 'state') ? el.filter.get('state').toLowerCase() : el.filter.get('text').toLowerCase();

    if (!q) return false;

    if (type === 'state') {
        const presence = occ.get('presence');
        if (q === 'online') {
            return ["offline", "unavailable"].includes(presence);
        } else if (q === 'ofline') {
            return presence === 'online';
        }
        return !occ.get('show')?.includes(q);
    } else if (type === 'items')  {
        return !occ.getDisplayName().toLowerCase().includes(q);
    }
}


function getRediffOccupantIdentityKey(occ) {
    const current_host = String(window.rediffConverse?.api?.user?.jid?.() || '').split('@')[1]?.split('/')[0]?.toLowerCase() || '';
    const raw = String(occ.get('jid') || occ.get('nick') || occ.getDisplayName?.() || occ.id || '').split('/')[0].trim().toLowerCase();
    if (!raw) return '';
    if (raw.includes('@')) return raw.split('@')[0];
    if (current_host && raw.endsWith(`@${current_host}`)) return raw.slice(0, -current_host.length - 1);
    return raw;
}

function getRediffOccupantRank(occ) {
    const presence = String(occ.get('presence') || '').toLowerCase();
    const is_offline = ['offline', 'unavailable'].includes(presence);
    const has_jid = Boolean(occ.get('jid'));
    return (is_offline ? 0 : 4) + (has_jid ? 1 : 0);
}

function getRediffVisibleOccupants(occupants) {
    const winners = new Map();
    occupants.forEach((occ) => {
        const key = getRediffOccupantIdentityKey(occ);
        if (!key) return;
        const current = winners.get(key);
        if (!current || getRediffOccupantRank(occ) > getRediffOccupantRank(current)) {
            winners.set(key, occ);
        }
    });
    return occupants.filter((occ) => winners.get(getRediffOccupantIdentityKey(occ)) === occ);
}

/**
 * @param {import('../occupants').default} el
 */
export default (el) => {
    const visible_occupants = getRediffVisibleOccupants(el.model.occupants.models);
    const i18n_participants = visible_occupants.length === 1 ? __('Participant') : __('Participants');
    const i18n_close = __('Hide');
    const i18n_show_filter = __('Show filter');
    const i18n_hide_filter = __('Hide filter');
    const is_filter_visible = el.model.get('filter_visible');
    const i18n_invite = __('Invite someone')
    const i18n_invite_title = __('Invite someone to join this groupchat')

    const btns = /** @type {TemplateResult[]} */ [];

    if (el.model.invitesAllowed()) {
        btns.push(html`
            <a href="#"
               class="dropdown-item open-invite-modal"
               role="button"
               title="${i18n_invite_title}"
               @click=${(/** @type {MouseEvent} */ev) => el.showInviteModal(ev)}>
                <converse-icon size="1em" class="fa fa-user-plus"></converse-icon>
                ${i18n_invite}
            </a>
        `);
    }

    if (el.model.occupants.length > 5) {
        btns.push(html`
            <a href="#"
               class="dropdown-item toggle-filter"
               role="button"
               @click=${(/** @type {MouseEvent} */ev) => el.toggleFilter(ev)}>
                <converse-icon size="1em" class="fa fa-filter"></converse-icon>
                ${is_filter_visible ? i18n_hide_filter : i18n_show_filter}
            </a>
        `);
    }

    if (btns.length) {
        btns.push(html`
            <a href="#" class="dropdown-item" role="button"
                @click=${(/** @type {MouseEvent} */ev) => el.closeSidebar(ev)}>
                <converse-icon size="1em" class="fa fa-times"></converse-icon>
                ${i18n_close}
            </a>
        `);
    } else {
        // Only a single button is shown, not a dropdown.
        btns.push(
            html` <i class="hide-occupants" @click=${(/** @type {MouseEvent} */ev) => el.closeSidebar(ev)}>
                <converse-icon class="fa fa-times" size="1em"></converse-icon>
            </i>`
        );
    }

    return html`
        <div class="occupants">
            <div class="occupants-header">
                <div class="occupants-header--title">
                    <span class="occupants-heading sidebar-heading">${visible_occupants.length} ${i18n_participants}</span>
                    <button
                        type="button"
                        class="rediff-add-participant-button"
                        title="Add participant"
                        @click=${(/** @type {MouseEvent} */ ev) => {
                            ev.preventDefault();
                            ev.stopPropagation();
                            window.rediffGroups?.openAddParticipant?.(el.model.get('jid'));
                        }}
                    >+ Add</button>
                    ${btns.length === 1
                        ? btns[0]
                            : html`<converse-dropdown
                                class="chatbox-btn btn-group dropstart"
                                .items=${btns}></converse-dropdown>`}
                </div>
            </div>
            <ul class="items-list occupant-list">
                ${is_filter_visible
                    ? html` <converse-list-filter
                        @update=${() => el.requestUpdate()}
                        .promise=${el.model.initialized}
                        .items=${el.model.occupants}
                        .template=${tplOccupantsFilter}
                        .model=${el.filter}
                    ></converse-list-filter>`
                    : ''}
                ${repeat(
                    visible_occupants,
                    (occ) => getRediffOccupantIdentityKey(occ) || occ.id,
                    (occ) => isOccupantFiltered(el, occ) ? '' : html`<converse-muc-occupant-list-item .muc="${el.model}" .model="${occ}" />`
                )}
            </ul>
        </div>
    `;
};
