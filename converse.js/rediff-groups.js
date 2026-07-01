(() => {
    const openWhenReady = (ev) => {
        ev?.preventDefault?.();
        ev?.stopPropagation?.();
        const open = window.rediffConverse?.groups?.open;
        if (open) {
            open(ev);
            return;
        }
        window.dispatchEvent(new CustomEvent('rediff:open-groups', { detail: { event: ev } }));
    };

    window.rediffGroups = {
        open: openWhenReady,
        inject: () => {},
        openAddParticipant: (mucJid, ev) => {
            const open = window.rediffConverse?.groups?.openParticipants;
            if (open) {
                open(mucJid, ev);
                return;
            }
            window.dispatchEvent(new CustomEvent('rediff:open-participants', { detail: { mucJid, event: ev } }));
        },
    };
})();
