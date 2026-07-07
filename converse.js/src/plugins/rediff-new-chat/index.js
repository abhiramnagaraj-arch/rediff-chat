import { createRediffAuth, getCurrentJid, installTenantGuards } from '../rediff-shared/index.js';
import { defineRediffNewChatModal } from './modal.js';
import { defineRediffGroupsModal } from '../rediff-groups/modal.js';
import { defineRediffOverlay } from './overlay.js';
import { mountRediffWorkspace } from './workspace.js';

const pluginName = 'rediff_new_chat';
const GROUPS_URL = '/api/groups';
let managedGroups = [];

const escapeHTML = (value) =>
    String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

const IMAGE_URL_PATTERN = /\.(?:png|jpe?g|gif|webp|bmp|svg)(?:[?#].*)?$/i;
const IMAGE_FILE_PATTERN = /\.(?:png|jpe?g|gif|webp|bmp|svg)$/i;
const URL_PATTERN = /^https?:\/\//i;

const isImageURL = (value) => {
    if (!value) return false;
    try {
        return IMAGE_URL_PATTERN.test(new URL(value, window.location.href).pathname);
    } catch (error) {
        return IMAGE_URL_PATTERN.test(String(value));
    }
};

const getMessageImageURL = (message) => message?.get?.('oob_url') || message?.get?.('body') || message?.get?.('message') || '';

const isImageFile = (file) => file?.type?.startsWith('image/') || IMAGE_FILE_PATTERN.test(file?.name || '');

const isLikelyUploadedFileURL = (value) => {
    if (!URL_PATTERN.test(value || '')) return false;
    try {
        const url = new URL(value, window.location.href);
        return url.pathname.includes('/upload/') || /\.[a-z0-9]{1,12}$/i.test(url.pathname);
    } catch (error) {
        return /\/[uU]pload\//.test(String(value)) || /\.[a-z0-9]{1,12}(?:[?#].*)?$/i.test(String(value));
    }
};

const getFileNameFromURL = (value) => {
    try {
        const url = new URL(value, window.location.href);
        return decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || 'Shared file');
    } catch (error) {
        return String(value || '').split('/').pop() || 'Shared file';
    }
};

const getFileAttachmentURL = (model, text) => {
    const url = model?.get?.('oob_url') || String(text || '').trim();
    if (!url || isImageURL(url) || !URL_PATTERN.test(url)) return '';
    if (model?.get?.('rediff_file_attachment') || model?.get?.('file') || model?.get?.('upload')) return url;
    return isLikelyUploadedFileURL(url) ? url : '';
};

const getConfiguredUploadBaseURL = (api) => {
    const configured = api.settings.get('rediff_upload_base_url');
    if (configured) return configured.replace(/\/$/, '');

    const params = new URLSearchParams(window.location.search);
    const xmppHost = params.get('xmppHost') || `${window.location.hostname || 'localhost'}:5280`;
    const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
    return `${protocol}//${xmppHost}`.replace(/\/$/, '');
};

const shouldRewriteUploadURL = (url) => {
    const host = url.hostname.toLowerCase();
    return url.pathname.startsWith('/upload') && (host.endsWith('.chat.rediff.com') || host === 'chat.rediff.com');
};

const rewriteUploadURL = (api, value) => {
    if (!value || api.settings.get('rediff_rewrite_upload_urls') === false) return value;
    try {
        const url = new URL(value, window.location.href);
        if (!shouldRewriteUploadURL(url)) return value;
        return `${getConfiguredUploadBaseURL(api)}${url.pathname}${url.search}${url.hash}`;
    } catch (error) {
        return value;
    }
};

const installUploadURLRewrite = (api, _converse) => {
    const patchMessageClass = (MessageClass) => {
        const proto = MessageClass?.prototype;
        if (!proto?.getRequestSlotURL || proto.getRequestSlotURL.rediffUploadRewrite) return;

        const original = proto.getRequestSlotURL;
        proto.getRequestSlotURL = async function rediffGetRequestSlotURL(...args) {
            const result = await original.apply(this, args);
            const put = rewriteUploadURL(api, this.get('put'));
            const get = rewriteUploadURL(api, this.get('get'));
            if (put !== this.get('put') || get !== this.get('get')) {
                this.save({ put, get });
            }
            return result;
        };
        proto.getRequestSlotURL.rediffUploadRewrite = true;
    };

    patchMessageClass(_converse?.exports?.Message);
    patchMessageClass(_converse?.exports?.MUCMessage);
};


const markImageMessageInline = (message) => {
    if (isImageURL(getMessageImageURL(message)) && message.get('hide_url_previews') !== false) {
        message.save({ hide_url_previews: false });
    }
};

const showExistingImageMessagesInline = (_converse) => {
    (_converse?.state?.chatboxes?.models || []).forEach((chatbox) => {
        (chatbox.messages?.models || []).forEach(markImageMessageInline);
    });
};

const installFileAttachmentRendering = () => {
    const MessageBodyElement = customElements.get('converse-chat-message-body');
    if (!MessageBodyElement?.prototype) {
        customElements.whenDefined('converse-chat-message-body').then(() => installFileAttachmentRendering());
        return;
    }

    const proto = MessageBodyElement.prototype;
    if (proto.render?.rediffFileAttachmentRendering) return;

    const originalRender = proto.render;
    proto.render = function rediffRenderMessageBody(...args) {
        const fileURL = getFileAttachmentURL(this.model, this.text);
        if (fileURL) {
            const html = window.converse?.env?.html;
            if (!html) return originalRender.apply(this, args);
            return html`<a class="chat-msg__file-attachment" href="${fileURL}" target="_blank" rel="noopener" download>
                <span class="chat-msg__file-attachment-icon" aria-hidden="true">↧</span>
                <span class="chat-msg__file-attachment-copy">
                    <span class="chat-msg__file-attachment-name">${getFileNameFromURL(fileURL)}</span>
                    <span class="chat-msg__file-attachment-meta">Open file</span>
                </span>
            </a>`;
        }
        return originalRender.apply(this, args);
    };
    proto.render.rediffFileAttachmentRendering = true;

    document.querySelectorAll('converse-chat-message-body').forEach((el) => el.requestUpdate?.());
};

const markFileAttachmentMessage = (message) => {
    const url = message?.get?.('oob_url') || message?.get?.('body') || message?.get?.('message') || '';
    if (url && !isImageURL(url) && URL_PATTERN.test(url) && isLikelyUploadedFileURL(url) && message.get('rediff_file_attachment') !== true) {
        message.save({ rediff_file_attachment: true, hide_url_previews: true });
    }
};

const showExistingFileAttachments = (_converse) => {
    (_converse?.state?.chatboxes?.models || []).forEach((chatbox) => {
        (chatbox.messages?.models || []).forEach(markFileAttachmentMessage);
    });
};

const installImageMessageRendering = (api, _converse) => {
    installFileAttachmentRendering();

    if (!api.rediffImageRenderingInstalled) {
        api.rediffImageRenderingInstalled = true;

        api.listen.on('afterFileUploaded', (message, attrs) => {
            const uploadURL = attrs?.oob_url || attrs?.body || attrs?.message;
            return isImageURL(uploadURL)
                ? { ...attrs, hide_url_previews: false }
                : { ...attrs, rediff_file_attachment: true, hide_url_previews: true };
        });

        api.listen.on('afterMessageCreated', (_chatbox, message) => {
            markImageMessageInline(message);
            markFileAttachmentMessage(message);
        });
    }

    showExistingImageMessagesInline(_converse);
    showExistingFileAttachments(_converse);
};

const revokePendingUploadURLs = (toolbar) => {
    (toolbar.rediff_pending_images || []).forEach((entry) => {
        if (entry.preview_url) URL.revokeObjectURL(entry.preview_url);
    });
};

const getNativeUploadPreviewHost = (toolbar) =>
    toolbar.closest('.chat-message-form, form') || toolbar.parentElement || toolbar;

const renderNativeUploadPreview = (toolbar) => {
    const host = getNativeUploadPreviewHost(toolbar);
    host.querySelector('[data-rediff-native-upload-preview]')?.remove();
    const pending = toolbar.rediff_pending_images || [];
    host.classList.toggle('rediff-has-native-upload-preview', Boolean(pending.length));
    if (!pending.length) return;

    const preview = document.createElement('div');
    preview.className = 'rediff-native-upload-preview';
    preview.setAttribute('data-rediff-native-upload-preview', 'true');
    preview.innerHTML = `
        <div class="rediff-native-upload-preview__items">
            ${pending
                .map(
                    (entry, index) => entry.is_image
                        ? `
                            <div class="rediff-native-upload-preview__item is-image">
                                <img src="${escapeHTML(entry.preview_url)}" alt="${escapeHTML(entry.file.name || 'Selected image')}" />
                                <button type="button" class="rediff-native-upload-preview__remove" data-rediff-native-upload-remove="${index}" aria-label="Remove file">×</button>
                            </div>
                        `
                        : `
                            <div class="rediff-native-upload-preview__item is-file">
                                <span class="rediff-native-upload-preview__icon" aria-hidden="true">↧</span>
                                <span class="rediff-native-upload-preview__name">${escapeHTML(entry.file.name || 'Selected file')}</span>
                                <button type="button" class="rediff-native-upload-preview__remove" data-rediff-native-upload-remove="${index}" aria-label="Remove file">×</button>
                            </div>
                        `,
                )
                .join('')}
        </div>
    `;

    preview.addEventListener('click', (ev) => {
        const remove = ev.target.closest?.('[data-rediff-native-upload-remove]');
        if (remove) {
            ev.preventDefault();
            toolbar.removeRediffPendingImage(Number(remove.getAttribute('data-rediff-native-upload-remove')));
            return;
        }
    });

    host.prepend(preview);
};

const installNativeImageUploadPreview = () => {
    const ToolbarElement = customElements.get('converse-chat-toolbar');
    if (!ToolbarElement?.prototype) {
        customElements.whenDefined('converse-chat-toolbar').then(() => installNativeImageUploadPreview());
        return;
    }
    const proto = ToolbarElement.prototype;
    if (proto.onFileSelection?.rediffImagePreview) return;

    const originalOnFileSelection = proto.onFileSelection;
    const originalUpdated = proto.updated;
    const originalDisconnected = proto.disconnectedCallback;

    proto.setRediffPendingImages = function setRediffPendingImages(files) {
        revokePendingUploadURLs(this);
        this.rediff_pending_images = files.map((file) => ({
            file,
            is_image: isImageFile(file),
            preview_url: isImageFile(file) ? URL.createObjectURL(file) : '',
        }));
        this.querySelector('.fileupload')?.removeAttribute('accept');
        this.requestUpdate?.();
        window.requestAnimationFrame(() => renderNativeUploadPreview(this));
    };

    proto.removeRediffPendingImage = function removeRediffPendingImage(index) {
        const pending = [...(this.rediff_pending_images || [])];
        const [removed] = pending.splice(index, 1);
        if (removed?.preview_url) URL.revokeObjectURL(removed.preview_url);
        this.rediff_pending_images = pending;
        const input = this.querySelector('.fileupload');
        if (!pending.length && input) input.value = '';
        this.requestUpdate?.();
        window.requestAnimationFrame(() => renderNativeUploadPreview(this));
    };

    proto.clearRediffPendingImages = function clearRediffPendingImages() {
        revokePendingUploadURLs(this);
        this.rediff_pending_images = [];
        getNativeUploadPreviewHost(this).classList.remove('rediff-has-native-upload-preview');
        const input = this.querySelector('.fileupload');
        if (input) input.value = '';
        this.requestUpdate?.();
        window.requestAnimationFrame(() => renderNativeUploadPreview(this));
    };

    proto.bindRediffNativeSendButton = function bindRediffNativeSendButton() {
        const sendButton = this.querySelector('.send-button');
        if (!sendButton || sendButton.rediffImagePreviewBound) return;
        sendButton.addEventListener('click', (ev) => {
            if ((this.rediff_pending_images || []).length) this.sendRediffPendingImages(ev);
        });
        sendButton.rediffImagePreviewBound = true;
    };

    proto.sendRediffPendingImages = function sendRediffPendingImages(ev) {
        ev?.preventDefault?.();
        ev?.stopPropagation?.();
        const files = (this.rediff_pending_images || []).map((entry) => entry.file);
        if (files.length) this.model.sendFiles(files);
        this.clearRediffPendingImages();
    };

    proto.onFileSelection = function rediffOnFileSelection(ev) {
        const input = /** @type {HTMLInputElement} */ (ev.target);
        const files = Array.from(input.files || []);
        if (files.length) {
            this.setRediffPendingImages(files);
            return;
        }
        originalOnFileSelection?.call(this, ev);
    };
    proto.onFileSelection.rediffImagePreview = true;

    proto.updated = function rediffToolbarUpdated(...args) {
        originalUpdated?.apply(this, args);
        this.querySelector('.fileupload')?.removeAttribute('accept');
        this.bindRediffNativeSendButton();
        renderNativeUploadPreview(this);
    };
    proto.updated.rediffImagePreview = true;

    proto.disconnectedCallback = function rediffToolbarDisconnected(...args) {
        revokePendingUploadURLs(this);
        originalDisconnected?.apply(this, args);
    };
};

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

        if (group.id && auth?.authenticatedFetch) {
            await auth.authenticatedFetch(`${GROUPS_URL}/${group.id}/sync`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
            }).catch((error) => {
                console.warn('Unable to sync managed group before opening', group?.muc_jid, error);
            });
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

        if (group.id && auth?.authenticatedFetch) {
            await auth.authenticatedFetch(`${GROUPS_URL}/${group.id}/sync`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
            }).catch((error) => {
                console.warn('Unable to sync managed group after opening', group?.muc_jid, error);
            });
        }
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

    if (rosterSection) {
        pane.insertBefore(dock, rosterSection);
        return;
    }

    pane.prepend(dock);
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

const ensureManagedParticipantsHeading = (api, root = document) => {
    const elements = root.matches?.('converse-muc-heading')
        ? [root]
        : [...root.querySelectorAll('converse-muc-heading')];
    elements.forEach((el) => {
        const model = el.model;
        const mucJid = model?.get?.('jid') || el.getAttribute('jid');
        if (!mucJid) return;

        const title = el.querySelector('.chatbox-title__text');
        if (title && !title.dataset.rediffParticipantsBound) {
            title.dataset.rediffParticipantsBound = 'true';
            title.classList.add('rediff-participants-trigger');
            title.setAttribute('role', 'button');
            title.setAttribute('tabindex', '0');
            title.setAttribute('title', 'View participants');
            title.addEventListener('click', (ev) => openRediffParticipants(api, mucJid, ev));
            title.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    openRediffParticipants(api, mucJid, ev);
                }
            });
        }

        const avatarLink = el.querySelector('[data-room-jid]');
        if (avatarLink && !avatarLink.dataset.rediffParticipantsBound) {
            avatarLink.dataset.rediffParticipantsBound = 'true';
            avatarLink.setAttribute('title', 'View participants');
            avatarLink.addEventListener('click', (ev) => openRediffParticipants(api, mucJid, ev));
        }

        el.querySelectorAll('.chatbox-title__buttons [title], .chatbox-title__buttons [aria-label]').forEach((button) => {
            const label = `${button.getAttribute('title') || ''} ${button.getAttribute('aria-label') || ''}`.toLowerCase();
            if (label.includes('participants') || label.includes('show participants') || label.includes('hide participants')) {
                button.classList.add('rediff-hidden-participants-toggle');
            }
        });
    });
};

const hideNativeMucSidebar = (_converse) => {
    (_converse?.state?.chatboxes?.models || []).forEach((chat) => {
        if (!chat?.occupants || chat.get('hidden_occupants')) return;
        chat.save({ hidden_occupants: true });
    });
};

const installManagedParticipantsHeading = (api, _converse) => {
    const headingElement = customElements.get('converse-muc-heading');
    if (!headingElement?.prototype) {
        customElements.whenDefined('converse-muc-heading').then(() => installManagedParticipantsHeading(api, _converse));
        return;
    }
    if (!headingElement.prototype.updated?.rediffManagedParticipantsHeading) {
        const originalUpdated = headingElement.prototype.updated;
        headingElement.prototype.updated = function rediffManagedParticipantsHeadingUpdated(...args) {
            originalUpdated?.apply(this, args);
            this.updateComplete?.then(() => ensureManagedParticipantsHeading(api, this));
        };
        headingElement.prototype.updated.rediffManagedParticipantsHeading = true;
    }

    const chatboxes = _converse?.state?.chatboxes;
    if (chatboxes && !chatboxes.rediffHideMucSidebarBound) {
        const handler = () => hideNativeMucSidebar(_converse);
        chatboxes.on('add reset', handler);
        chatboxes.rediffHideMucSidebarBound = true;
    }

    hideNativeMucSidebar(_converse);
    ensureManagedParticipantsHeading(api);
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

const syncWorkspaceSurface = (api, _converse, actions, auth) => {
    const overlay = defineRediffOverlay(api, _converse, actions);
    const workspace = mountRediffWorkspace(api, _converse, actions, auth);
    window.rediffConverse = Object.assign(window.rediffConverse || {}, { overlay, workspace });
    return { overlay, workspace };
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
                rediff_message_search_url: '/api/messages/search',
                rediff_new_chat_token: null,
                rediff_stable_roster_order: true,
                rediff_rewrite_upload_urls: true,
                rediff_upload_base_url: null,
                render_media: true,
                allowed_image_domains: null,
            });

            const auth = createRediffAuth(api);
            const workspaceActions = {
                openNewChat: (ev) => openRediffNewChat(api, ev),
                openGroups: (ev) => openRediffGroups(api, ev),
                openParticipants: (mucJid, ev) => openRediffParticipants(api, mucJid, ev),
            };
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
            syncWorkspaceSurface(api, this._converse, workspaceActions, auth);
            installNativeEntryBridge(api, auth);
            installManagedParticipantsHeading(api, this._converse);
            installUploadURLRewrite(api, this._converse);
            installImageMessageRendering(api, this._converse);
            installNativeImageUploadPreview();
            installTenantGuards(api);
            auth.installLoginCapture();

            api.listen.on('initialized', () => {
                installTenantGuards(api);
                syncWorkspaceSurface(api, this._converse, workspaceActions, auth);
                installManagedParticipantsHeading(api, this._converse);
                installUploadURLRewrite(api, this._converse);
                installImageMessageRendering(api, this._converse);
                installNativeImageUploadPreview();
            });
            api.listen.on('connected', () => {
                installTenantGuards(api);
                auth.bootstrapStoredSearchToken();
                syncWorkspaceSurface(api, this._converse, workspaceActions, auth);
                installManagedParticipantsHeading(api, this._converse);
                installUploadURLRewrite(api, this._converse);
                installImageMessageRendering(api, this._converse);
                installNativeImageUploadPreview();
                window.setTimeout(() => syncManagedGroupsToSidebar(api, auth), 500);
            });
            api.listen.on('chatBoxesFetched', () => {
                syncWorkspaceSurface(api, this._converse, workspaceActions, auth);
                installManagedParticipantsHeading(api, this._converse);
                installNativeImageUploadPreview();
            });

            auth.bootstrapStoredSearchToken();
            window.setTimeout(() => syncManagedGroupsToSidebar(api, auth), 1500);
        },
    });
}
