FROM ubuntu:18.04

RUN apt-get update

#configure time zone
RUN export DEBIAN_FRONTEND=noninteractive && \
apt-get install -y tzdata && \
ln -fs /usr/share/zoneinfo/Europe/London /etc/localtime && \
dpkg-reconfigure --frontend noninteractive tzdata

#Deal with all of the SSL stuff to be able to use the BDR packages in the 2ndquadrant APT repository
RUN apt-get install -y git build-essential sudo wget iputils-ping curl software-properties-common gnupg2 ca-certificates apt-transport-https
RUN echo "deb https://apt.2ndquadrant.com/ bionic-2ndquadrant main" > /etc/apt/sources.list.d/cluster.repos.list && \
mkdir -p /root/apt_keys && \
curl https://apt.2ndquadrant.com/site/keys/9904CD4BD6BAF0C3.asc > /root/apt_keys/bdr.asc && \
apt-key add /root/apt_keys/bdr.asc && \
apt-get update && \
apt-get upgrade -y

#Install BDR and any other necessary packages
RUN apt-get install -y postgresql-bdr-9.4 postgresql-bdr-contrib-9.4 postgresql-bdr-9.4-bdr-plugin postgresql-bdr-server-dev-9.4
RUN apt-get install -y zookeeper zookeeper-bin zookeeperd
RUN apt-get install -y nodejs nodejs-dev npm
RUN apt-get install -y vim haproxy socat

#Add the app user
RUN adduser --disabled-password app

#Make app user sudoer with no password required
RUN echo "app ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers
USER app

#Configure ZooKeeper
ENV PATH="/usr/lib/postgresql/9.4/bin:/usr/share/zookeeper/bin/:${PATH}"
RUN cp -R /etc/zookeeper/conf_example /home/app/zookeeper_conf
COPY tmp/zoo.cfg /home/app/zookeeper_conf/zoo.cfg
RUN sudo rm /etc/zookeeper/conf && \
sudo ln -s /home/app/zookeeper_conf /etc/zookeeper/conf && \
sudo chown -R app:app /var/log/zookeeper /var/lib/zookeeper

#configure postgres
ENV BDR_HOME="/home/app/pg_bdr_cluster"
ARG PGHC_POSTGRES_NODES
RUN mkdir -p $BDR_HOME && \
rm -rf "${BDR_HOME}/*" && \
mkdir -p "${BDR_HOME}/wal_archive" && \
mkdir -p "${BDR_HOME}/master_backup" && \
mkdir -p "${BDR_HOME}/node0" && \
initdb -D "${BDR_HOME}/node0" -A trust -U app && \
sudo chown -R app:app /var/run/postgresql && \
for i in $(seq 1 $(echo $PGHC_POSTGRES_NODES)); \
do mkdir -p "${BDR_HOME}/node${i}"; \
done;
COPY tmp/recovery.slave*.conf $BDR_HOME/
COPY tmp/postgresql.master.conf $BDR_HOME/node0/postgresql.conf
COPY remote_cfg/postgresql.slave.conf $BDR_HOME/
COPY tmp/pg_hba.conf $BDR_HOME/
RUN for i in $(seq 1 $(echo $(expr $PGHC_POSTGRES_NODES - 1))); \
do mv $BDR_HOME/recovery.slave$i.conf $BDR_HOME/node$i/recovery.conf; \
cp -n $BDR_HOME/postgresql.slave.conf $BDR_HOME/node$i/postgresql.conf && \
cp $BDR_HOME/pg_hba.conf $BDR_HOME/node$i/pg_hba.conf; \
done && \
cp $BDR_HOME/pg_hba.conf $BDR_HOME/node0/pg_hba.conf && \
rm $BDR_HOME/pg_hba.conf && \
rm $BDR_HOME/postgresql.slave.conf;

#Configure NodeJS app
RUN mkdir -p /home/app/hash_chain
COPY package.json /home/app/hash_chain/
COPY cluster.json /home/app/hash_chain/
WORKDIR /home/app/hash_chain
RUN npm install --production
WORKDIR  /home/app/hash_chain
#Copy the esm directory and rebuild last so that when I update code it only takes like 10s to recompile the image
COPY esm esm
RUN npm run build

#Expose all ports
EXPOSE 2181 2888 3888 $V8_DEBUG_PORT

#CMD statement:
#1) set Zookeeper myid
#2) start Zookeeper
#3) start socat to provide tunneling for remote debugging
#4) start Postgres
#5) start HAProxy
#6) start node standby_node.js

CMD echo $ZK_MYID > /var/lib/zookeeper/myid && \
zkServer.sh start && \
if [ -z "${V8_DEBUG_PORT}" ]; \
then node cjs/nodes/standby_node.js; \
else nohup socat TCP-LISTEN:$V8_DEBUG_PORT,fork TCP:127.0.0.1:9229 & \
  node --inspect-brk=9229 cjs/nodes/standby_node.js; \
fi;