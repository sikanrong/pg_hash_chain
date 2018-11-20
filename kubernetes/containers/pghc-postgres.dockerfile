FROM pghc-base

RUN apt-get install -y postgresql-bdr-9.4 postgresql-bdr-contrib-9.4 postgresql-bdr-9.4-bdr-plugin postgresql-bdr-server-dev-9.4
ENV PATH="/usr/lib/postgresql/9.4/bin:${PATH}"

RUN chown -R app:app /var/run/postgresql

USER app
ENV HOME="/home/app"
ENV BDR_HOME="${HOME}/bdr"
ENV PGDATA="${BDR_HOME}/data"
RUN mkdir -p $PGDATA
RUN initdb $PGDATA

VOLUME ["/home/app/bdr/config", "/home/app/bdr/master-basebackup", "/home/app/bdr/wal-archive"]

ENTRYPOINT ["postgres"]