FROM pghc-base

RUN apt-get update
RUN apt-get install -y zookeeper zookeeper-bin zookeeperd


RUN mkdir -p /var/log/zookeeper/ && \
touch /var/log/zookeeper/zookeeper.log && \
touch /var/log/zookeeper/zookeeper.out && \
chown -R app:app /var/log/zookeeper;

USER app
ENV PATH="/usr/share/zookeeper/bin/:${PATH}"

RUN mkdir -p /home/app/zk_data;
WORKDIR /home/app

EXPOSE 2181 3888 2888

VOLUME ["/home/app/zk_conf"]
COPY scripts/zookeeper-entrypoint.sh zookeeper-entrypoint.sh
RUN sudo chmod +x /home/app/zookeeper-entrypoint.sh

ENTRYPOINT ["/home/app/zookeeper-entrypoint.sh"]