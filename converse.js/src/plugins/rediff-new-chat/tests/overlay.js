import mock from '../../../shared/tests/mock.js';
import converse from '../../../../../dist/converse.js';
import { RediffNewChatModal } from '../modal.js';
import '../index.js';

const { u } = converse.env;

const settings = {
    view_mode: 'fullscreen',
    whitelisted_plugins: ['rediff_new_chat'],
};

describe('Rediff quick chat overlay', function () {
    beforeEach(function () {
        window.localStorage.removeItem('rediff_overlay_state_v1');
        document.querySelector('converse-rediff-overlay')?.remove();
    });

    it(
        'opens, minimizes and restores without replacing the fullscreen workspace',
        mock.initConverse(converse, ['chatBoxesFetched'], settings, async function (_converse) {
            await mock.waitForRoster(_converse, 'current', 3);
            await mock.openControlBox(_converse);

            const overlay = await u.waitUntil(() => document.querySelector('converse-rediff-overlay'));
            const launcher = overlay.querySelector('[data-rediff-overlay-toggle]');
            const panel = overlay.querySelector('.rediff-overlay-panel');

            expect(panel.classList.contains('is-visible')).toBe(false);
            launcher.click();
            await u.waitUntil(() => panel.classList.contains('is-visible'));

            overlay.querySelector('[data-rediff-overlay-minimize]').click();
            await u.waitUntil(() => overlay.querySelector('[data-rediff-overlay-restore]'));
            expect(panel.classList.contains('is-minimized')).toBe(true);

            overlay.querySelector('[data-rediff-overlay-restore]').click();
            await u.waitUntil(() => !panel.classList.contains('is-minimized'));
            expect(document.querySelector('#conversejs')).not.toBe(null);
        }),
    );

    it(
        'opens a roster contact in quick chat and sends replies via the existing chat model',
        mock.initConverse(converse, ['chatBoxesFetched'], settings, async function (_converse) {
            await mock.waitForRoster(_converse, 'current', 3);
            await mock.openControlBox(_converse);

            const contact_jid = 'mercutio@montague.lit';
            const overlay = await u.waitUntil(() => document.querySelector('converse-rediff-overlay'));
            overlay.querySelector('[data-rediff-overlay-toggle]').click();

            const rosterButton = await u.waitUntil(() => overlay.querySelector(`[data-jid="${contact_jid}"]`));
            rosterButton.click();

            const chatbox = await u.waitUntil(() => _converse.chatboxes.get(contact_jid));
            expect(chatbox).not.toBeUndefined();
            expect(overlay.textContent.includes('Mercutio')).toBe(true);

            const spy = vi.spyOn(chatbox, 'sendMessage').mockResolvedValue({});
            const textarea = overlay.querySelector('.rediff-overlay-composer textarea');
            textarea.value = 'Quick reply';
            overlay.querySelector('.rediff-overlay-composer').requestSubmit();

            await u.waitUntil(() => spy.mock.calls.length === 1);
            expect(spy).toHaveBeenCalledWith({ body: 'Quick reply' });
            expect(textarea.value).toBe('');
        }),
    );

    it(
        'surfaces unread counts on the launcher badge',
        mock.initConverse(converse, ['chatBoxesFetched'], settings, async function (_converse) {
            await mock.waitForRoster(_converse, 'current', 2);
            await mock.openControlBox(_converse);

            const contact_jid = 'mercutio@montague.lit';
            await _converse.api.chats.open(contact_jid, {}, true);
            const chatbox = await u.waitUntil(() => _converse.chatboxes.get(contact_jid));
            chatbox.save({ num_unread: 4 });

            const overlay = await u.waitUntil(() => document.querySelector('converse-rediff-overlay'));
            const badge = await u.waitUntil(() => overlay.querySelector('.rediff-overlay-launcher__badge:not(.is-hidden)'));
            expect(badge.textContent.trim()).toBe('4');
        }),
    );
});

describe('Rediff new chat tenant guard', function () {
    it('blocks cross-tenant results before adding or opening a chat', async function () {
        if (!customElements.get('converse-rediff-new-chat-modal')) {
            customElements.define('converse-rediff-new-chat-modal', RediffNewChatModal);
        }
        const modal = document.createElement('converse-rediff-new-chat-modal');
        modal.api = {
            user: { jid: () => 't1.u1@v1.chat.rediff.com' },
            contacts: {
                add: vi.fn(),
                get: vi.fn(),
            },
            chats: {
                open: vi.fn(),
            },
            toast: {
                show: vi.fn(),
            },
        };
        modal.auth = {};

        await modal.addAndOpen({
            jid: 't2.u2@v1.chat.rediff.com',
            tenant: 't2',
        });

        expect(modal.api.toast.show).toHaveBeenCalledOnce();
        expect(modal.api.contacts.add).not.toHaveBeenCalled();
        expect(modal.api.chats.open).not.toHaveBeenCalled();
    });
});
