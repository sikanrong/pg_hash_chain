--All these hours of work just to set up this one dinky schema :D

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
