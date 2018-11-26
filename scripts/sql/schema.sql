--All these hours of work just to set up this one dinky schema :D

--First thing, I have to unregister any bdr handlers from any relations before they are DROPped
create or replace function drop_ch_if_exists()
returns void as $BODY$
declare _i integer;
BEGIN
    if exists(select 1 from bdr.bdr_conflict_handlers where ch_name='public.chain_conflict_handler_ins_ins') then
        select 1 into _i from bdr.bdr_drop_conflict_handler(
             ch_rel := 'public.chain',
             ch_name := 'public.chain_conflict_handler_ins_ins');
    end if;
END
$BODY$ language plpgsql;

select drop_ch_if_exists();

TRUNCATE bdr.bdr_conflict_handlers;
DROP TABLE IF EXISTS chain CASCADE;

CREATE TABLE chain (
    zk_id integer PRIMARY KEY,
    hash char(32) UNIQUE,
    node_id varchar(64)
);

--pghc_add_link is the logic to correctly add a new link to the hash chain

drop function if exists pghc_add_link();
create or replace function pghc_add_link(seqId integer, nId varchar(64))
returns chain AS $ADDLNK$
declare lastHash char(32);
declare outRow chain;
declare timeoutSeconds float;
declare waitCheck float;
declare waitFor float;
begin

    if exists(select 1 from chain) then
        timeoutSeconds := 0.0;
        waitFor := 10;
        waitCheck := 0.10;

        while (
            timeoutSeconds < waitFor and
            not exists(select 1 from chain where zk_id = (seqId - 1))
        ) loop
            perform pg_sleep(waitCheck);
            timeoutSeconds := timeoutSeconds + waitCheck;
        end loop;

        select hash into lastHash from chain where zk_id = (seqId - 1);
        if lastHash is null then
            --if we can't find numerically previous record in time, just use the last one available.
            select hash into lastHash from chain order by zk_id desc limit 1;
        end if;
    end if;

    insert into chain
    values (
        seqId,
        MD5(seqId::text || nId || coalesce(lastHash, '') ),
        nId
    )
    returning *
    into outRow;

    return outRow;
end
$ADDLNK$ language plpgsql;

--Add a custom BDR conflict handler for the chain table, make it take most recent zk_id
create or replace function public.chain_conflict_handler_ins_ins (
    row1 public.chain,
    row2 public.chain,
    table_name text,
    table_regclass regclass,
    -- [insert_insert | insert_update | update_update | update_delete | delete_delete | unhandled_tx_abort]
    conflict_type bdr.bdr_conflict_type,
    OUT row_out public.chain,
    -- [IGNORE | ROW | SKIP]
    OUT handler_action bdr.bdr_conflict_handler_action)
    RETURNS record AS $BODY$
BEGIN
    raise warning 'conflict detected for public.chain, old_row: %, incoming_row: %', row1, row2;

    IF (row1.zk_id > row2.zk_id) THEN
        row_out := row1;
    ELSE
        row_out := row2;
    END IF;

    raise warning 'conflict resolved: selected row %', row_out;

    handler_action := 'ROW';
END;
$BODY$ LANGUAGE plpgsql;

-- after writing the handler procedure we also need to register it as an handler
select * from bdr.bdr_create_conflict_handler(
     ch_rel := 'public.chain',
     ch_name := 'public.chain_conflict_handler_ins_ins',
     ch_proc := 'public.chain_conflict_handler_ins_ins(public.chain, public.chain, text, regclass, bdr.bdr_conflict_type)',
     ch_type := 'insert_insert');