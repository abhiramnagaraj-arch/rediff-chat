import { getBareJid } from './jid.js';

const tokenStorageKey = 'rediff_access_token';
const tokenKeys = [tokenStorageKey, 'access_token', 'keycloak_token', 'kc_token'];

export const createRediffAuth = (api) => {
    let tokenRequest = null;
    let lastLoginCredentials = null;

    const getSearchToken = () => {
        const configured = api.settings.get('rediff_new_chat_token');
        if (configured) return configured;
        if (window.REDIFF_ACCESS_TOKEN) return window.REDIFF_ACCESS_TOKEN;

        for (const storage of [window.sessionStorage, window.localStorage]) {
            for (const key of tokenKeys) {
                const token = storage.getItem(key);
                if (token) return token;
            }
        }
        return null;
    };

    const rememberSearchToken = (token) => {
        if (!token) return;
        window.REDIFF_ACCESS_TOKEN = token;
        window.sessionStorage.setItem(tokenStorageKey, token);
    };

    const clearSearchToken = () => {
        delete window.REDIFF_ACCESS_TOKEN;
        for (const storage of [window.sessionStorage, window.localStorage]) {
            for (const key of tokenKeys) {
                storage.removeItem(key);
            }
        }
    };

    const rememberLoginCredentials = (jid, password) => {
        const safeJid = getBareJid(jid);
        if (safeJid && password) {
            lastLoginCredentials = { jid: safeJid, password };
        }
        return lastLoginCredentials;
    };

    const getLoginCredentials = () => {
        if (lastLoginCredentials?.jid && lastLoginCredentials?.password) return lastLoginCredentials;

        const connection = api.connection?.get?.();
        const jid = api.settings.get('jid') || api.user?.jid?.() || connection?.jid;
        const password = api.settings.get('password') || connection?.pass || connection?.password;
        return rememberLoginCredentials(jid, password);
    };

    const requestSearchToken = async (jid, password) => {
        const safeJid = getBareJid(jid);
        if (!safeJid || !password) return null;
        if (tokenRequest) return tokenRequest;

        tokenRequest = fetch(api.settings.get('rediff_new_chat_token_url'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid: safeJid, password }),
        })
            .then(async (response) => {
                if (!response.ok) throw new Error(`Token request failed: ${response.status}`);
                const data = await response.json();
                rememberSearchToken(data.access_token);
                return data.access_token || null;
            })
            .catch((error) => {
                console.warn('Unable to prepare tenant search token', error);
                return null;
            })
            .finally(() => {
                tokenRequest = null;
            });

        return tokenRequest;
    };

    const readLoginFormCredentials = (form) => {
        const jid = form?.querySelector?.('input[name="jid"]')?.value?.trim();
        const password = form?.querySelector?.('input[name="password"]')?.value || '';
        return rememberLoginCredentials(jid, password);
    };

    const installLoginCapture = () => {
        if (installLoginCapture.installed) return;
        installLoginCapture.installed = true;

        document.addEventListener(
            'submit',
            (ev) => {
                const form = ev.target?.closest?.('#converse-login');
                if (!form) return;

                const credentials = readLoginFormCredentials(form);
                if (credentials) requestSearchToken(credentials.jid, credentials.password);
            },
            true
        );
    };

    const bootstrapStoredSearchToken = () => {
        const credentials = getLoginCredentials();
        if (credentials) requestSearchToken(credentials.jid, credentials.password);
    };

    const authenticatedFetch = async (url, options = {}) => {
        let token = getSearchToken();
        if (!token && tokenRequest) token = await tokenRequest;
        if (!token) return { response: null, missingToken: true };

        const headers = { ...(options.headers || {}), Authorization: `Bearer ${token}` };
        let response = await fetch(url, { ...options, headers });
        if (response.status !== 401) return { response };

        clearSearchToken();
        const credentials = getLoginCredentials();
        if (!credentials) return { response };

        token = await requestSearchToken(credentials.jid, credentials.password);
        if (!token) return { response };

        response = await fetch(url, {
            ...options,
            headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
        });
        return { response };
    };

    return {
        authenticatedFetch,
        bootstrapStoredSearchToken,
        clearSearchToken,
        getLoginCredentials,
        getSearchToken,
        installLoginCapture,
        requestSearchToken,
    };
};
