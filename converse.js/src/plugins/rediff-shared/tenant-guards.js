import { getCurrentTenant, isSameTenantJid } from './jid.js';

export const installTenantGuards = (api) => {
    if (api.contacts?.add && !api.contacts.add.rediffTenantGuarded) {
        const addContact = api.contacts.add.bind(api.contacts);
        api.contacts.add = async (attributes, ...args) => {
            const jid = attributes?.jid;
            if (jid && getCurrentTenant(api) && !isSameTenantJid(api, jid)) {
                throw new Error('Cross-tenant contacts are not allowed');
            }
            return addContact(attributes, ...args);
        };
        api.contacts.add.rediffTenantGuarded = true;
    }

    if (api.chats?.open && !api.chats.open.rediffTenantGuarded) {
        const openChat = api.chats.open.bind(api.chats);
        api.chats.open = async (jid, ...args) => {
            const jids = Array.isArray(jid) ? jid : [jid];
            if (getCurrentTenant(api) && jids.some((item) => item && !isSameTenantJid(api, item))) {
                throw new Error('Cross-tenant chats are not allowed');
            }
            return openChat(jid, ...args);
        };
        api.chats.open.rediffTenantGuarded = true;
    }
};
