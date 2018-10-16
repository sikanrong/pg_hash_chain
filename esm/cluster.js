import * as fs from "fs";
import * as path from "path";
import * as $config from "../cluster.json";
import Handlebars from "handlebars";
import ZooKeeper from "zk";

//define a single-master cluster running on a single node,
//where the master is part of a BDR multi-master setup.

export class Cluster{
    Cluster(){
        this.zk_path = null;
        this.zk = null;

        this.init();
    }

    init () {
        this.zk = new ZooKeeper({
            connect: `${$config.nodes[0].host}:${$config.zk_client_port}`,
            timeout: 20000,
            debug_level: ZooKeeper.ZOO_LOG_LEVEL_WARN,
            host_order_deterministic: false
        });

        this.zk.connect().then(() => {
            console.log ("zk session established, id=%s", zk.client_id);
            this.zk.create('/config/node.',
                JSON.stringify({pid: process.pid, init: true}),
                ZooKeeper.ZOO_EPHEMERAL | ZooKeeper.ZOO_SEQUENCE)
            .then((_path) => {
                this.zk_path = path;
            });
        });

        process.on('exit', this.closeConnection.bind(this));
        process.on('SIGINT', this.closeConnection.bind(this));
        process.on('SIGUSR1', this.closeConnection.bind(this));
        process.on('SIGUSR2', this.closeConnection.bind(this));

    }

    closeConnection () {
        this.zk.delete(this.zk_path, 0).then(() => {
            this.zk.close();
        });
    }

}

