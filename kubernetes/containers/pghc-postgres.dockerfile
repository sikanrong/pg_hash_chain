FROM pghc-base

RUN apt-get install -y postgresql-bdr-9.4 postgresql-bdr-contrib-9.4 postgresql-bdr-9.4-bdr-plugin postgresql-bdr-server-dev-9.4
ENV PATH="/usr/lib/postgresql/9.4/bin:${PATH}"
VOLUME ["/home/app/bdr/config", "/home/app/bdr/master-basebackup", "/home/app/bdr/wal-archive"]
USER app
ENTRYPOINT bash