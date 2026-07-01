# Rediff Converse plugin customizations

Rediff-specific Converse UI behavior lives in native plugin modules under `converse.js/src/plugins/rediff-*`.

## Current structure

- `converse.js/rediff-new-chat.js` is a thin browser loader for the Rediff New Chat plugin.
- `converse.js/src/plugins/rediff-new-chat/` registers the `rediff_new_chat` Converse plugin, owns the New Chat modal, and bridges Rediff actions into Converse roster/roomslist/sidebar components.
- `converse.js/src/plugins/rediff-groups/` owns the native Rediff Groups modal for listing, creating, editing, and opening tenant groups.
- `converse.js/src/plugins/rediff-shared/` contains reusable Rediff helpers for JID normalization, tenant checks, token-backed fetch, login credential capture, toast display, and UI guards.

## New Chat flow

The `rediff_new_chat` plugin registers Rediff settings with `api.settings.extend`, installs tenant guards around `api.contacts.add` and `api.chats.open`, captures login credentials for `/api/oidc/token`, and registers `converse-rediff-new-chat-modal` as a modal element.

The roster's native `showNewChatModal` and `showAddContactModal` methods are bridged to `api.modal.show('converse-rediff-new-chat-modal')`, so the existing Converse Start New Chat and Add Contact actions open the Rediff tenant-safe search modal instead of a page-level overlay. Search still uses `/api/users/search` with a bearer token and filters results to the current tenant and vhost before allowing add/open.

## Groups entry point

`converse.js/rediff-groups.js` is now only a compatibility bridge. The Rediff plugin adds normal `+ New Chat` and `+ New Group` actions to the Converse sidebar from component lifecycle hooks, adds a `New Group` item to the roomslist dropdown, and opens `converse-rediff-groups-modal` through `api.modal.show(...)`. The same modal also has a participant-management mode for managed MUCs: owners/admins can search same-tenant/vhost users, existing members are excluded from add results, owners/admins can remove non-owner participants, and non-owner participants can exit the group.

## Adding future Rediff features

Add future product behavior as a `converse.js/src/plugins/rediff-*/` module and keep shared concerns in `rediff-shared`. Future Rediff features should follow the same pattern: register settings in `api.settings.extend`, expose a custom modal/component, invoke it from Converse lifecycle-backed actions with `api.modal.show`, and use shared authenticated fetch and tenant checks instead of injecting floating UI into `document.body`.
