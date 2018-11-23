#!/usr/bin/env bash

export MY_HOST=$(hostname)
export POD_IDX="$(echo $MY_HOST | cut -c${#MY_HOST}-${#MY_HOST})"

sudo cp /home/app/zk_conf/zoo.cfg /etc/zookeeper/conf/zoo.cfg;
sudo cp /home/app/zk_conf/zk_myid.$POD_IDX /home/app/zk_data/myid;

zkServer.sh start;
tail -f /var/log/zookeeper/*;