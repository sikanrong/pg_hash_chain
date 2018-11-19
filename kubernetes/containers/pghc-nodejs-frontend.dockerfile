FROM ubuntu:18.04
RUN apt-get update
RUN apt-get install -y nodejs nodejs-dev npm socat

#Deal with all of the SSL stuff to be able to use the BDR packages in the 2ndquadrant APT repository
RUN apt-get install -y git build-essential sudo wget iputils-ping curl software-properties-common gnupg2 ca-certificates apt-transport-https
RUN echo "deb https://apt.2ndquadrant.com/ bionic-2ndquadrant main" > /etc/apt/sources.list.d/cluster.repos.list && \
mkdir -p /root/apt_keys && \
curl https://apt.2ndquadrant.com/site/keys/9904CD4BD6BAF0C3.asc > /root/apt_keys/bdr.asc && \
apt-key add /root/apt_keys/bdr.asc && \
apt-get update
RUN apt-get install -y postgresql-bdr-server-dev-9.4

#Add the app user
RUN adduser --disabled-password app

#Make app user sudoer with no password required
RUN echo "app ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers
USER app

RUN mkdir -p /home/app/hash_chain
WORKDIR /home/app/hash_chain
COPY package.json package.json
RUN npm install --production
COPY esm esm
RUN npm run build

EXPOSE 9228 8080

CMD nohup socat TCP-LISTEN:9228,fork TCP:127.0.0.1:31001 & \
node --inspect=31001 cjs/pghc-api.js;

