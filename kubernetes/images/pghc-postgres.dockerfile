FROM pghc-base

RUN apt-get install -y postgresql-bdr-9.4 postgresql-bdr-contrib-9.4 postgresql-bdr-9.4-bdr-plugin postgresql-bdr-server-dev-9.4
ENV PATH="/usr/lib/postgresql/9.4/bin:${PATH}"

RUN chown -R app:app /var/run/postgresql

USER app
ENV HOME="/home/app"
ENV BDR_HOME="${HOME}/bdr"
ENV PGDATA="${BDR_HOME}/data"
ENV PGPORT=5432

RUN mkdir -p $PGDATA $BDR_HOME/config $BDR_HOME/master-basebackup $BDR_HOME/wal-archive
RUN sudo chmod -R 700 $PGDATA
RUN sudo chown -R app:app $BDR_HOME

VOLUME ["$BDR_HOME/config", "$BDR_HOME/master-basebackup", "$BDR_HOME/wal-archive"]

EXPOSE $PGPORT
COPY scripts/postgres-entrypoint.sh /home/app/postgres-entrypoint.sh
RUN sudo chmod +x /home/app/postgres-entrypoint.sh

ENTRYPOINT ["/home/app/postgres-entrypoint.sh"]