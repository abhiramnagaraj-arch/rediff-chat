export const getBareJid = (jid) => String(jid || '').split('/')[0].trim().toLowerCase();

export const getTenantFromJid = (jid) => {
    const localpart = getBareJid(jid).split('@')[0];
    return localpart.split('.')[0] || '';
};

export const getDomainFromJid = (jid) => {
    const bare = getBareJid(jid);
    return bare.includes('@') ? bare.split('@').pop() : '';
};

export const getCurrentJid = (api) => {
    const connection = api?.connection?.get?.();
    return getBareJid(api?.user?.jid?.() || connection?.jid || api?.settings?.get?.("jid"));
};

export const getCurrentTenant = (api) => getTenantFromJid(getCurrentJid(api));

export const getCurrentDomain = (api) => getDomainFromJid(getCurrentJid(api));

export const isSameTenantJid = (api, jid) => {
    const currentTenant = getCurrentTenant(api);
    const currentDomain = getCurrentDomain(api);
    return Boolean(
        currentTenant &&
            currentDomain &&
            getTenantFromJid(jid) === currentTenant &&
            getDomainFromJid(jid) === currentDomain
    );
};

export const isSameTenantResult = (api, result) => {
    const currentTenant = getCurrentTenant(api);
    const currentDomain = getCurrentDomain(api);
    return Boolean(
        currentTenant &&
            currentDomain &&
            result?.jid &&
            result?.tenant === currentTenant &&
            getTenantFromJid(result.jid) === currentTenant &&
            getDomainFromJid(result.jid) === currentDomain
    );
};
