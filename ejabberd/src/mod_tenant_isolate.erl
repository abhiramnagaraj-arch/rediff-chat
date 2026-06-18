-module(mod_tenant_isolate).
-author("Rediff Enterprise").
-behavior(gen_mod).

-export([start/2, stop/1, filter_packet/1, depends/2, mod_opt_type/1, mod_options/1]).

start(Host, _Opts) ->
    ejabberd_hooks:add(filter_packet, global, ?MODULE, filter_packet, 50),
    logger:info("mod_tenant_isolate started on ~p", [Host]),
    ok.

stop(Host) ->
    ejabberd_hooks:delete(filter_packet, global, ?MODULE, filter_packet, 50),
    logger:info("mod_tenant_isolate stopped on ~p", [Host]),
    ok.

depends(_Host, _Opts) -> [].
mod_opt_type(_) -> [].
mod_options(_) -> [].

filter_packet(drop) -> drop;
filter_packet(Packet) ->
    try
        From = xmpp:get_from(Packet),
        To = xmpp:get_to(Packet),
        case {From, To} of
            {undefined, _} -> Packet;
            {_, undefined} -> Packet;
            {{jid, _, FromDomain, _, LUserFrom, _, _}, {jid, _, ToDomain, _, LUserTo, _, _}} ->
                case is_allowed(LUserFrom, FromDomain, LUserTo, ToDomain) of
                    true -> Packet;
                    false ->
                        logger:info("Tenant Isolation: Blocked packet from ~s@~s to ~s@~s", [LUserFrom, FromDomain, LUserTo, ToDomain]),
                        drop
                end;
            _ -> Packet
        end
    catch
        _Class:_Reason -> Packet
    end.

is_allowed(LUserFrom, Domain, LUserTo, Domain) ->
    %% Same domain, check tenant prefix
    case {extract_tenant(LUserFrom), extract_tenant(LUserTo)} of
        {undefined, _} -> true; %% Allow server/admin messages
        {_, undefined} -> true;
        {TenantFrom, TenantTo} when TenantFrom =:= TenantTo -> true;
        _ -> false
    end;
is_allowed(_, <<"localhost">>, _, _) -> true;
is_allowed(_, _, _, <<"localhost">>) -> true;
is_allowed(_, FromDomain, _, ToDomain) ->
    %% Allow communication with MUC and Upload domains of the same VHost
    ConfDomainFrom = <<"conference.", FromDomain/binary>>,
    UploadDomainFrom = <<"upload.", FromDomain/binary>>,
    case ToDomain of
        ConfDomainFrom -> true;
        UploadDomainFrom -> true;
        _ ->
            ConfDomainTo = <<"conference.", ToDomain/binary>>,
            UploadDomainTo = <<"upload.", ToDomain/binary>>,
            case FromDomain of
                ConfDomainTo -> true;
                UploadDomainTo -> true;
                _ -> false %% Block cross-vhost communication entirely
            end
    end.

extract_tenant(<<"">>) -> undefined;
extract_tenant(User) when is_binary(User) ->
    case binary:split(User, <<".">>) of
        [Tenant, _] -> Tenant;
        _ -> undefined
    end;
extract_tenant(_) -> undefined.
