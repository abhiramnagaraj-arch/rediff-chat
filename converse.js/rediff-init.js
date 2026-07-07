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

await converse.initialize(config);

const getConverseApi = () => window.rediffConverse?.api || window.converse?.api;

const bareJID = (jid) => jid?.split('/')[0];
const waitWithTimeout = (promise, ms) =>
    Promise.race([promise, new Promise((resolve) => window.setTimeout(resolve, ms))]);
const isChatMounted = () => Boolean(document.querySelector('.chatbox:not(#controlbox), .chatroom'));

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

openInitialRosterChat();
setTimeout(() => !isChatMounted() && clickFirstRosterContact(), 1000);
setTimeout(() => !isChatMounted() && clickFirstRosterContact(), 2500);
setTimeout(() => !isChatMounted() && clickFirstRosterContact(), 5000);
