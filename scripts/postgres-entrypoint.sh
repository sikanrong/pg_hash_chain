#! /bin/sh

#first need to determine whether I'm master or slave.
export MY_HOST=$(hostname)
export POD_IDX="$(echo $MY_HOST | cut -c${#MY_HOST}-${#MY_HOST})"

chmod -R 700 $PGDATA;
sudo chmod -R 777 $BDR_HOME/master-basebackup $BDR_HOME/wal-archive;
sudo chown -R app:app $BDR_HOME/master-basebackup $BDR_HOME/wal-archive;

if [ -f $BDR_HOME/config/postgresql.master$POD_IDX.conf ];
then export IS_MASTER=true && echo "${MY_HOST} is a WAL/BDR master node";

    #Master node must:
    #0) Copy configuration files from the mounted config volume
    #1) Start PostgreSQL server
    #2) Do a basebackup
    #3) CREATE the database
    #4) CREATE BDR extension(s) for the new database
    #5a) if POD_IDX == 0, we create the BDR group
    #5b) if POD_IDX != 0, we join the BDR group created by BDR master at pod 0.

    initdb -U app -A trust $PGDATA
    cp $BDR_HOME/config/pg_hba.conf $PGDATA/pg_hba.conf;
    cp $BDR_HOME/config/postgresql.master$POD_IDX.conf $PGDATA/postgresql.conf;

    export WAL_ARCHIVE_PATH="${BDR_HOME}/wal-archive/${POD_IDX}";

    rm -rf $WAL_ARCHIVE_PATH;
    mkdir -p $WAL_ARCHIVE_PATH;

    pg_ctl -w start;

    createdb -U app -p $PGPORT hash_chain -T template0;

else export IS_MASTER=false && echo "${MY_HOST} is a WAL standby replica";

    export MASTER_IDX="$(cat $BDR_HOME/config/slave$POD_IDX.master)";

    pg_basebackup -h pghc-postgres-repl-$MASTER_IDX.pghc-postgres.pghc.svc.cluster.local -U app -p $PGPORT -D $PGDATA;

    cp $BDR_HOME/config/pg_hba.conf $PGDATA/pg_hba.conf;
    cp $BDR_HOME/config/postgresql.slave$POD_IDX.conf $PGDATA/postgresql.conf;
    cp $BDR_HOME/config/recovery.slave$POD_IDX.conf $PGDATA/recovery.conf;

    pg_ctl -w start;
fi;

tail -f $PGDATA/pg_log/*;