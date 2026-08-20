import { api } from "@converse/headless";
import { html } from 'lit';
import 'shared/registry.js';
import 'shared/modals/image.js';
import { CustomElement } from 'shared/components/element.js';
import renderTexture from 'shared/texture/directives/texture.js';

import './styles/message-body.scss';

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


export default class MessageBody extends CustomElement {

    static get properties () {
        return {
            // We make this a string instead of a boolean, since we want to
            // distinguish between true, false and undefined states
            hide_url_previews: { type: String },
            is_me_message: { type: Boolean },
            model: { type: Object },
            text: { type: String },
        }
    }

    constructor () {
        super();
        this.text = null;
        this.model = null;
        this.hide_url_previews = null;
    }

    initialize () {
        const settings = api.settings.get();
        this.listenTo(settings, 'change:allowed_audio_domains', () => this.requestUpdate());
        this.listenTo(settings, 'change:allowed_image_domains', () => this.requestUpdate());
        this.listenTo(settings, 'change:allowed_video_domains', () => this.requestUpdate());
        this.listenTo(settings, 'change:render_media', () => this.requestUpdate());
    }

    /** @param {MouseEvent} ev */
    onImgClick (ev) {
        ev.preventDefault();
        const img = /** @type {HTMLImageElement} */ (ev.target);
        api.modal.show('converse-image-modal', { src: img.src, filename: img.dataset.filename }, ev);
    }

    onImgLoad () {
        this.dispatchEvent(new CustomEvent('imageLoaded', { detail: this, bubbles: true }));
    }

    getFileAttachmentURL () {
        const text = String(this.text || '').trim();
        const url = this.model?.get?.('oob_url') || text;
        if (!url || isImageURL(url) || !URL_PATTERN.test(url)) return '';
        if (this.model?.get?.('rediff_file_attachment') || this.model?.get?.('file') || this.model?.get?.('upload')) return url;
        return isLikelyUploadedFileURL(url) ? url : '';
    }

    renderFileAttachment (url) {
        return html`<a class="chat-msg__file-attachment" href="${url}" target="_blank" rel="noopener" download>
            <span class="chat-msg__file-attachment-icon" aria-hidden="true">↧</span>
            <span class="chat-msg__file-attachment-copy">
                <span class="chat-msg__file-attachment-name">${getFileNameFromURL(url)}</span>
                <span class="chat-msg__file-attachment-meta">Open file</span>
            </span>
        </a>`;
    }

    render () {
        const file_attachment_url = this.getFileAttachmentURL();
        if (file_attachment_url) return this.renderFileAttachment(file_attachment_url);

        const callback = () => this.model.collection?.trigger('rendered', this.model);
        const offset = 0;
        /** @type {{ [key: string]: any }} */
        const options = {
            media_urls: this.model.get('media_urls'),
            mentions: this.model.get('references'),
            nick: this.model.chatbox.get('nick'),
            onImgClick: /** @param {MouseEvent} ev */ (ev) => this.onImgClick(ev),
            onImgLoad: () => this.onImgLoad(),
            render_styling: !this.model.get('is_unstyled') && api.settings.get('allow_message_styling'),
            show_me_message: true,
        }
        if (this.hide_url_previews === "false") {
            options.embed_audio = true;
            options.embed_videos = true;
            options.show_images = true;
        } else if (this.hide_url_previews === "true") {
            options.embed_audio = false;
            options.embed_videos = false;
            options.show_images = false;
        }
        return renderTexture(this.text, offset, options, callback);
    }
}

api.elements.define('converse-chat-message-body', MessageBody);
