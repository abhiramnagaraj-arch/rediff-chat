export const showToast = (api, id, type, body) => {
    if (api?.toast?.show) {
        api.toast.show(id, { type, body });
    } else {
        console[type === 'danger' ? 'error' : 'warn'](body);
    }
};
