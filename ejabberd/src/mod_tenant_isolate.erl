-module(mod_tenant_isolate).
-author("Rediff Enterprise").
-behavior(gen_mod).

-export([start/2, stop/1, filter_packet/1, depends/2, mod_opt_type/1, mod_options/1, sync_room_tenant/2, get_room_tenant/1]).

-define(ROOM_TABLE, muc_tenant_rooms).

start(Host, _Opts) ->
    ensure_room_table(),
    ejabberd_hooks:add(filter_packet, global, ?MODULE, filter_packet, 50),
    logger:info("mod_tenant_isolate started on ~p", [Host]),
    ok.

stop(Host) ->
    ejabberd_hooks:delete(filter_packet, global, ?MODULE, filter_packet, 50),
    logger:info("mod_tenant_isolate stopped on ~p", [Host]),
    ok.

depends(_Host, _Opts) -> [].

%% Public helper for registry-managed rooms. This lets an external provisioning
%% path pre-bind room_jid -> tenant in Mnesia instead of relying on first join.
sync_room_tenant(RoomJid0, Tenant0) ->
    ensure_room_table(),
    RoomJid = to_binary(RoomJid0),
    Tenant = to_binary(Tenant0),
    bind_room_tenant(RoomJid, Tenant).

get_room_tenant(RoomJid0) ->
    ensure_room_table(),
    lookup_room_tenant(to_binary(RoomJid0)).

mod_opt_type(_) -> [].
mod_options(_) -> [].

filter_packet(drop) -> drop;
filter_packet({From, To, Packet}) ->
    case process_packet(From, To, Packet) of
        drop -> drop;
        _ -> Packet
    end;
filter_packet(Packet) ->
    try
        From = xmpp:get_from(Packet),
        To = xmpp:get_to(Packet),
        case process_packet(From, To, Packet) of
            drop -> drop;
            _ -> Packet
        end
    catch
        Class:Reason ->
            logger:error("FILTER_PACKET CRASHED: ~p:~p on packet ~p", [Class, Reason, Packet]),
            Packet
    end.

process_packet(From, To, _Packet) ->
    case {From, To} of
        {{jid, _, _, _, LUserFrom, LServerFrom, LResFrom}, {jid, _, _, _, LUserTo, LServerTo, LResTo}} ->
            case is_allowed(LUserFrom, LServerFrom, LResFrom, LUserTo, LServerTo, LResTo) of
                true -> ok;
                false ->
                    logger:info("Tenant Isolation BLOCKED: ~s@~s -> ~s@~s", [LUserFrom, LServerFrom, LUserTo, LServerTo]),
                    drop
            end;
        _ -> ok
    end.

%% Standard User-to-User isolation (Same domain)
is_allowed(LUserFrom, Domain, _LResFrom, LUserTo, Domain, _LResTo) ->
    TenantFrom = extract_tenant(LUserFrom),
    TenantTo = extract_tenant(LUserTo),
    case {TenantFrom, TenantTo} of
        {undefined, _} -> true; %% Allow server-originated or system stanzas
        {_, undefined} -> true; %% Allow stanzas to server components
        {T, T} -> true;         %% Same tenant
        _ -> false              %% Different tenants
    end;

%% Global localhost/admin traffic
is_allowed(_, <<"localhost">>, _, _, _, _) -> true;
is_allowed(_, _, _, _, <<"localhost">>, _) -> true;

%% MUC isolation: room tenant is learned from the first authenticated user that joins it.
is_allowed(LUserFrom, FromDomain, LResFrom, LUserTo, ToDomain, LResTo) ->
    case {is_muc_component(ToDomain, FromDomain), is_muc_component(FromDomain, ToDomain)} of
        {true, false} ->
            resolve_muc_tenant(LUserFrom, FromDomain, LUserTo, ToDomain);
        {false, true} ->
            resolve_muc_tenant(LUserFrom, FromDomain, LUserTo, ToDomain);
        _ ->
            case is_component(ToDomain, FromDomain) orelse is_component(FromDomain, ToDomain) of
                true -> true;
                false -> false
            end
    end.

is_component(Comp, Parent) ->
    (Comp =:= << "conference.", Parent/binary >>) orelse
    (Comp =:= << "pubsub.",     Parent/binary >>) orelse
    (Comp =:= << "upload.",     Parent/binary >>).

is_muc_component(Comp, Parent) ->
    Comp =:= << "conference.", Parent/binary >>.

ensure_room_table() ->
    case catch mnesia:add_table_copy(?ROOM_TABLE, node(), ram_copies) of
        {atomic, ok} -> ok;
        {aborted, {already_exists, ?ROOM_TABLE}} -> ok;
        _ ->
            case catch mnesia:create_table(?ROOM_TABLE, [
                {attributes, [room_jid, tenant]},
                {type, set},
                {ram_copies, [node()]}
            ]) of
                {atomic, ok} -> ok;
                {aborted, {already_exists, ?ROOM_TABLE}} -> ok;
                _ -> ok
            end
    end.

resolve_muc_tenant(LUserFrom, FromDomain, LUserTo, ToDomain) ->
    case muc_context(LUserFrom, FromDomain, LUserTo, ToDomain) of
        {to_room, RoomJid, UserTenant} ->
            resolve_or_bind_room_tenant(RoomJid, UserTenant, true);
        {from_room, RoomJid, UserTenant} ->
            resolve_or_bind_room_tenant(RoomJid, UserTenant, false);
        undefined ->
            true
    end.

muc_context(LUserFrom, FromDomain, LUserTo, ToDomain) ->
    case {is_muc_component(ToDomain, FromDomain), is_muc_component(FromDomain, ToDomain)} of
        {true, false} ->
            SenderTenant = extract_tenant(LUserFrom),
            RoomJid = room_jid(LUserTo, ToDomain),
            case SenderTenant of
                undefined -> undefined;
                _ -> {to_room, RoomJid, SenderTenant}
            end;
        {false, true} ->
            UserTenant = extract_tenant(LUserTo),
            RoomJid = room_jid(LUserFrom, FromDomain),
            case UserTenant of
                undefined -> undefined;
                _ -> {from_room, RoomJid, UserTenant}
            end;
        _ ->
            undefined
    end.

resolve_or_bind_room_tenant(RoomJid, UserTenant, BindIfMissing) ->
    case lookup_room_tenant(RoomJid) of
        {ok, RoomTenant} ->
            RoomTenant =:= UserTenant;
        not_found when BindIfMissing ->
            bind_room_tenant(RoomJid, UserTenant);
        not_found ->
            true
    end.

lookup_room_tenant(RoomJid) ->
    Fun = fun() ->
        case mnesia:read(?ROOM_TABLE, RoomJid) of
            [{?ROOM_TABLE, RoomJid, Tenant}] -> {ok, Tenant};
            [] -> not_found
        end
    end,
    case mnesia:transaction(Fun) of
        {atomic, Result} -> Result;
        _ -> not_found
    end.

bind_room_tenant(RoomJid, Tenant) ->
    Fun = fun() ->
        case mnesia:read(?ROOM_TABLE, RoomJid) of
            [] ->
                mnesia:write({?ROOM_TABLE, RoomJid, Tenant}),
                ok;
            [{?ROOM_TABLE, RoomJid, Tenant}] ->
                ok;
            [{?ROOM_TABLE, RoomJid, Existing}] ->
                {conflict, Existing}
        end
    end,
    case mnesia:transaction(Fun) of
        {atomic, ok} -> true;
        {atomic, {conflict, _Existing}} -> false;
        _ -> false
    end.

room_jid(User, Domain) ->
    <<User/binary, "@", Domain/binary>>.

extract_tenant(<<>>) -> undefined;
extract_tenant(User) when is_binary(User) ->
    case binary:split(User, <<".">>) of
        [Tenant, _] -> Tenant;
        _ -> undefined
    end;
extract_tenant(_) -> undefined.

to_binary(Value) when is_binary(Value) -> Value;
to_binary(Value) when is_list(Value) -> unicode:characters_to_binary(Value);
to_binary(Value) when is_atom(Value) -> atom_to_binary(Value, utf8);
to_binary(Value) -> unicode:characters_to_binary(io_lib:format("~p", [Value])).

