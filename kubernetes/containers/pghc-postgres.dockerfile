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
apt-get update

RUN apt-get install -y postgresql-bdr-9.4 postgresql-bdr-contrib-9.4 postgresql-bdr-9.4-bdr-plugin postgresql-bdr-server-dev-9.4

