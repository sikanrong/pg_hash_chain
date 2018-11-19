FROM ubuntu:18.04
RUN apt-get update
RUN apt-get install -y zookeeper zookeeper-bin zookeeperd
ENV PATH="/usr/share/zookeeper/bin/:${PATH}"

ENTRYPOINT ["zkServer.sh"]
CMD ["start-foreground"]

