import { mountRediffWorkspace } from './src/plugins/rediff-new-chat/workspace.js';

const configElement = document.getElementById('converse-config');
const config = configElement ? JSON.parse(configElement.textContent) : {};
const params = new URLSearchParams(window.location.search);

const xmppHost = params.get('xmppHost') || `${window.location.hostname || 'localhost'}:5280`;
const isHttps = window.location.protocol === 'https:';
const httpProtocol = isHttps ? 'https:' : 'http:';
const wsProtocol = isHttps ? 'wss:' : 'ws:';
const selectedDomain = params.get('domain');

config.bosh_service_url = config.bosh_service_url || `${httpProtocol}//${xmppHost}/bosh`;
config.websocket_url = config.websocket_url || `${wsProtocol}//${xmppHost}/ws`;

if (selectedDomain) {
    config.locked_domain = selectedDomain;
    config.muc_domain = `conference.${selectedDomain}`;
}

if (config.muc_domain) {
    config.locked_muc_domain = true;
}

await converse.initialize(config);

const getConverseApi = () => window.rediffConverse?.api || window.converse?.api;

const bareJID = (jid) => jid?.split('/')[0];
const waitWithTimeout = (promise, ms) =>
    Promise.race([promise, new Promise((resolve) => window.setTimeout(resolve, ms))]);
const isChatMounted = () => Boolean(document.querySelector('.chatbox:not(#controlbox), .chatroom'));
const isLoginScreenVisible = () => Boolean(document.querySelector('converse-login-form, converse-registration-form, #converse-login, #converse-register'));

function ensureRediffWorkspace() {
    if (isLoginScreenVisible()) {
        document.querySelector('.rediff-sidebar-actions')?.remove();
        document.querySelector('converse-rediff-overlay')?.remove();
        document.querySelector('converse-rediff-workspace')?.remove();
        document.body.classList.add('rediff-login-screen');
        document.body.classList.remove('rediff-workspace-mounted');
        return;
    }

    document.body.classList.remove('rediff-login-screen');
    const api = getConverseApi();
    const rediff = window.rediffConverse || {};
    if (!api || !rediff._converse) return;

    const actions = {
        openNewChat: (event) => window.rediffConverse?.newChat?.open?.(event),
        openGroups: (event) => window.rediffConverse?.groups?.open?.(event),
        openParticipants: (mucJid, event) => window.rediffConverse?.groups?.openParticipants?.(mucJid, event),
    };
    mountRediffWorkspace(api, rediff._converse, actions, rediff.newChat?.auth || null);
}

function clickFirstRosterContact() {
    const links = [...document.querySelectorAll('#controlbox .open-chat, converse-roster .open-chat')];
    const firstContactLink = links.find((link) => {
        const label = link.textContent || '';
        return label.trim() && !label.includes('(me)');
    });

    if (firstContactLink) {
        firstContactLink.click();
        return true;
    }
    return false;
}

async function openInitialRosterChat() {
    if (isLoginScreenVisible()) return;

    const api = getConverseApi();
    if (!api?.waitUntil) {
        clickFirstRosterContact();
        return;
    }

    try {
        await waitWithTimeout(api.waitUntil('chatBoxesFetched'), 800);
        await waitWithTimeout(api.waitUntil('rosterContactsFetched'), 1200);

        const contacts = (await waitWithTimeout(Promise.resolve(api.contacts.get()), 300)) || [];
        const ownJID = bareJID(api.user.jid?.());
        const firstContact = contacts.find((contact) => {
            const jid = contact?.get?.('jid');
            return jid && jid !== ownJID && !contact.get?.('requesting');
        });

        if (firstContact) {
            await api.chats.open(firstContact.get('jid'), {}, true);
        }

        if (!isChatMounted()) {
            clickFirstRosterContact();
        }
    } catch (error) {
        console.warn('Unable to auto-open the initial roster chat via API', error);
        clickFirstRosterContact();
    }
}

ensureRediffWorkspace();
openInitialRosterChat();
setTimeout(() => { ensureRediffWorkspace(); !isLoginScreenVisible() && !isChatMounted() && clickFirstRosterContact(); }, 1000);
setTimeout(() => { ensureRediffWorkspace(); !isLoginScreenVisible() && !isChatMounted() && clickFirstRosterContact(); }, 2500);
setTimeout(() => { ensureRediffWorkspace(); !isLoginScreenVisible() && !isChatMounted() && clickFirstRosterContact(); }, 5000);

const workspaceObserver = new MutationObserver(() => {
    if (isLoginScreenVisible() || !document.querySelector('converse-rediff-workspace')) {
        ensureRediffWorkspace();
    }
});
workspaceObserver.observe(document.body, { childList: true, subtree: true });
window.addEventListener('beforeunload', () => workspaceObserver.disconnect());
