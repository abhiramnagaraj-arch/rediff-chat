import { api } from '@converse/headless';
import { __ } from 'i18n/index.js';
import { html } from 'lit';

/**
 * @param {import('../message').default} el
 */
function tplEditedIcon(el) {
    const i18n_edited = __('This message has been edited');
    return html`<converse-icon
        title="${i18n_edited}"
        class="fa fa-edit chat-msg__edit-modal"
        @click=${el.showMessageVersionsModal}
        size="1em"
    ></converse-icon>`;
}

const IMAGE_URL_PATTERN = /\.(?:png|jpe?g|gif|webp|bmp|svg)(?:[?#].*)?$/i;
const URL_PATTERN = /^https?:\/\//i;

const isImageURL = (value) => {
    if (!value) return false;
    try {
        return IMAGE_URL_PATTERN.test(new URL(value, window.location.href).pathname);
    } catch (error) {
        return IMAGE_URL_PATTERN.test(String(value));
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

const isLikelyUploadedFileURL = (value) => {
    if (!URL_PATTERN.test(value || '')) return false;
    try {
        const url = new URL(value, window.location.href);
        return url.pathname.includes('/upload/') || /\.[a-z0-9]{1,12}$/i.test(url.pathname);
    } catch (error) {
        return /\/[uU]pload\//.test(String(value)) || /\.[a-z0-9]{1,12}(?:[?#].*)?$/i.test(String(value));
    }
};

const getFileAttachmentURL = (model, text) => {
    const url = model.get('oob_url') || text;
    if (!url || isImageURL(url) || !URL_PATTERN.test(url)) return '';
    if (model.get('rediff_file_attachment') || model.get('file') || model.get('upload') || model.get('oob_url')) return url;
    return isLikelyUploadedFileURL(url) ? url : '';
};

function tplCheckmark(label, extra_class = '') {
    return html`<converse-icon
        title="${label}"
        size="0.75em"
        color="var(--chat-color)"
        class="fa fa-check chat-msg__receipt ${extra_class}"
    ></converse-icon>`;
}

function tplReceiptStatus(model, is_groupchat_message) {
    if (model.get('sender') !== 'me' || model.isMeCommand() || is_groupchat_message || model.get('error')) {
        return '';
    }

    if (model.get('marker_displayed') || model.get('marker_acknowledged')) {
        return html`<span class="chat-msg__receipt-group chat-msg__receipt-group--read" title="${__('Read')}">
            ${tplCheckmark(__('Read'))}${tplCheckmark(__('Read'), 'chat-msg__receipt--second')}
        </span>`;
    }

    if (model.get('marker_received') || model.get('received')) {
        return html`<span class="chat-msg__receipt-group chat-msg__receipt-group--delivered" title="${__('Delivered')}">
            ${tplCheckmark(__('Delivered'))}
        </span>`;
    }

    return html`<span class="chat-msg__receipt-group chat-msg__receipt-group--sent" title="${__('Sent')}">
        ${tplCheckmark(__('Sent'))}
    </span>`;
}

/**
 * @param {import('../message').default} el
 */
export default (el) => {
    const i18n_show = __('Show more');
    const is_groupchat_message = el.model.get('type') === 'groupchat';
    const i18n_show_less = __('Show less');
    const error_text = el.model.get('error_text') || el.model.get('error');
    const i18n_error = `${__('Message delivery failed.')}\n${error_text}`;

    const tplSpoilerHint = html`
        <div class="chat-msg__spoiler-hint">
            <span class="spoiler-hint">${el.model.get('spoiler_hint')}</span>
            <a class="badge badge-info spoiler-toggle" href="#" @click=${el.toggleSpoilerMessage}>
                <converse-icon
                    size="1em"
                    color="var(--background-color)"
                    class="fa ${el.model.get('is_spoiler_visible') ? 'fa-eye-slash' : 'fa-eye'}"
                ></converse-icon>
                ${el.model.get('is_spoiler_visible') ? i18n_show_less : i18n_show}
            </a>
        </div>
    `;

    const spoiler_classes = el.model.get('is_spoiler')
        ? `spoiler ${el.model.get('is_spoiler_visible') ? '' : 'hidden'}`
        : '';
    const text = el.model.getMessageText();
    const file_attachment_url = getFileAttachmentURL(el.model, text);
    const show_oob = el.model.get('oob_url') && text !== el.model.get('oob_url');
    const render_media = api.settings.get('render_media');

    return html`
        ${el.model.get('is_spoiler') ? tplSpoilerHint : ''}
        ${el.model.get('subject') ? html`<div class="chat-msg__subject">${el.model.get('subject')}</div>` : ''}
        <span class="chat-msg__body--wrapper ${error_text ? 'error' : ''}">
            ${file_attachment_url
                ? html`<a
                      class="chat-msg__file-attachment"
                      href="${file_attachment_url}"
                      target="_blank"
                      rel="noopener"
                      download
                  >
                      <span class="chat-msg__file-attachment-icon" aria-hidden="true">↧</span>
                      <span class="chat-msg__file-attachment-copy">
                          <span class="chat-msg__file-attachment-name">${getFileNameFromURL(file_attachment_url)}</span>
                          <span class="chat-msg__file-attachment-meta">Open file</span>
                      </span>
                  </a>`
                : html`<converse-chat-message-body
                      class="chat-msg__text ${el.model.get('is_only_emojis')
                          ? 'chat-msg__text--larger'
                          : ''} ${spoiler_classes}"
                      .model="${el.model}"
                      hide_url_previews=${el.model.get('hide_url_previews')}
                      ?is_me_message=${el.model.isMeCommand()}
                      text="${text}"
                  ></converse-chat-message-body>`}
            ${tplReceiptStatus(el.model, is_groupchat_message)}
            ${el.model.get('edited') ? tplEditedIcon(el) : ''}
        </span>
        ${show_oob
            ? html`<div class="chat-msg__media">
                  <converse-texture
                      text="${el.model.get('oob_url')}"
                      .onImgClick="${/** @param {MouseEvent} ev */ (ev) => el.onImgClick(ev)}"
                      ?embed_audio="${render_media}"
                      ?embed_videos="${render_media}"
                      ?show_images="${render_media}"
                  />
              </div>`
            : ''}
        ${error_text ? html`<div class="chat-msg__error">${i18n_error}</div>` : ''}
    `;
};
