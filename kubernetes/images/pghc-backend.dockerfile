FROM pghc-base

RUN apt-get install -y nodejs nodejs-dev npm socat postgresql-bdr-server-dev-9.4

RUN mkdir -p /home/app/hash_chain
WORKDIR /home/app/hash_chain
COPY package.json package.json
RUN npm install --production
COPY esm esm
COPY kubernetes kubernetes
COPY scripts scripts
RUN npm run build

EXPOSE 9228 8080

CMD nohup socat TCP-LISTEN:9228,fork TCP:127.0.0.1:31001 & \
node --inspect=31001 cjs/pghc-api.js;

