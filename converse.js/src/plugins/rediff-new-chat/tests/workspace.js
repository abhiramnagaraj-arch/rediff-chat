import mock from '../../../shared/tests/mock.js';
import converse from '../../../../../dist/converse.js';
import '../index.js';

const { u } = converse.env;

const settings = {
    view_mode: 'fullscreen',
    whitelisted_plugins: ['rediff_new_chat'],
};

describe('Rediff workspace shell', function () {
    beforeEach(function () {
        document.querySelector('converse-rediff-workspace')?.remove();
        document.body.classList.remove('rediff-workspace-mounted');
    });

    it(
        'mounts a recent-chat rail and search shell alongside the fullscreen workspace',
        mock.initConverse(converse, ['chatBoxesFetched'], settings, async function (_converse) {
            await mock.waitForRoster(_converse, 'current', 3);
            const workspace = await u.waitUntil(() => document.querySelector('converse-rediff-workspace'));
            expect(workspace).not.toBe(null);
            expect(workspace.textContent.includes('Recent chats')).toBe(true);
            expect(document.body.classList.contains('rediff-workspace-mounted')).toBe(true);
        }),
    );

    it(
        'opens a roster contact from the workspace search input',
        mock.initConverse(converse, ['chatBoxesFetched'], settings, async function (_converse) {
            await mock.waitForRoster(_converse, 'current', 3);
            const workspace = await u.waitUntil(() => document.querySelector('converse-rediff-workspace'));
            const input = workspace.querySelector('.rediff-workspace-search-input');

            input.value = 'Mercutio';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

            const chatbox = await u.waitUntil(() => _converse.chatboxes.get('mercutio@montague.lit'));
            expect(chatbox).not.toBeUndefined();
        }),
    );
});
