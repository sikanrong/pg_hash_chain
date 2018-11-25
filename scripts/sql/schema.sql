--All these hours of work just to set up this one dinky schema :D

DROP TABLE IF EXISTS chain CASCADE;

CREATE TABLE chain (
    zk_id integer PRIMARY KEY,
    hash char(32) UNIQUE,
    node_id varchar(64)
);

drop function if exists pghc_add_link();
create or replace function pghc_add_link(seqId integer, nId varchar(64))
returns chain AS $ADDLNK$
declare lastHash char(32);
declare outRow chain;
begin
    select c.hash into lastHash
    from chain as c
    group by c.zk_id
    order by c.zk_id desc
    limit 1;

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

