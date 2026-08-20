import { describe, expect, it, beforeEach, vi } from 'vitest';
import { createRediffAuth } from '../auth.js';

const makeApi = (jid = 'alice@v1.chat.rediff.com/resource') => ({
    user: {
        jid: vi.fn(() => jid),
    },
    connection: {
        get: vi.fn(() => ({ jid })),
        connected: vi.fn(() => true),
    },
    settings: {
        get: vi.fn(() => null),
    },
});

describe('createRediffAuth', () => {
    beforeEach(() => {
        window.sessionStorage.clear();
        window.localStorage.clear();
        delete window.REDIFF_ACCESS_TOKEN;
    });

    it('ignores generic stored tokens and only reads the scoped token for the current user', () => {
        const api = makeApi();
        const auth = createRediffAuth(api);

        window.sessionStorage.setItem('access_token', 'shared-token');
        window.sessionStorage.setItem('rediff_access_token:alice@v1.chat.rediff.com', 'alice-token');

        expect(auth.getSearchToken()).toBe('alice-token');
    });

    it('stores tokens under the current user JID and clears only scoped entries', async () => {
        const api = makeApi();
        const auth = createRediffAuth(api);

        const fetchSpy = vi.spyOn(window, 'fetch').mockResolvedValue({
            ok: true,
            json: async () => ({ access_token: 'fresh-token' }),
        });

        await auth.requestSearchToken('alice@v1.chat.rediff.com', 'secret');

        expect(window.sessionStorage.getItem('rediff_access_token:alice@v1.chat.rediff.com')).toBe('fresh-token');
        expect(window.REDIFF_ACCESS_TOKEN).toEqual({
            jid: 'alice@v1.chat.rediff.com',
            token: 'fresh-token',
        });

        auth.clearSearchToken();

        expect(window.sessionStorage.getItem('rediff_access_token:alice@v1.chat.rediff.com')).toBeNull();
        expect(window.REDIFF_ACCESS_TOKEN).toBeUndefined();

        fetchSpy.mockRestore();
    });
});
