import { RediffGroupsModal } from '../modal.js';

describe('Rediff managed groups modal', function () {
    beforeEach(function () {
        if (!customElements.get('converse-rediff-groups-modal')) {
            customElements.define('converse-rediff-groups-modal', RediffGroupsModal);
        }
    });

    it('clears the bookmark when exiting a managed group', async function () {
        const modal = document.createElement('converse-rediff-groups-modal');
        const destroy = vi.fn().mockResolvedValue();
        const bookmark = { destroy };

        modal.api = {
            user: { jid: () => 't1.u1@v1.chat.rediff.com' },
            bookmarks: {
                get: vi.fn().mockResolvedValue(bookmark),
            },
        };
        modal.participantGroup = {
            id: 42,
            muc_jid: 'team-42@conference.v1.chat.rediff.com',
        };
        modal.fetchJson = vi.fn().mockResolvedValue({ success: true });
        modal.closeOpenRoom = vi.fn().mockResolvedValue(undefined);
        modal.refreshManagedSidebar = vi.fn();
        modal.close = vi.fn();

        await modal.exitGroup();

        expect(modal.fetchJson).toHaveBeenCalledOnce();
        expect(modal.fetchJson).toHaveBeenCalledWith(
            '/api/groups/42/members/t1.u1%40v1.chat.rediff.com',
            { method: 'DELETE' },
        );
        expect(modal.api.bookmarks.get).toHaveBeenCalledWith('team-42@conference.v1.chat.rediff.com');
        expect(destroy).toHaveBeenCalledOnce();
        expect(modal.closeOpenRoom).toHaveBeenCalledWith('team-42@conference.v1.chat.rediff.com', 'Exited group');
        expect(modal.refreshManagedSidebar).toHaveBeenCalledOnce();
        expect(modal.close).toHaveBeenCalledOnce();
    });
});
