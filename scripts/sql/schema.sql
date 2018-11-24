--All these hours of work just to set up this one dinky schema :D

DROP TABLE IF EXISTS chain CASCADE;

CREATE TABLE chain (
    zk_id integer PRIMARY KEY,
    hash char(32) UNIQUE,
    node_id varchar(64)
);