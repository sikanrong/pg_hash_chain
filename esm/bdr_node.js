import * as fs from "fs";
import * as path from "path";
import * as $config from "../cluster";
import Handlebars from "handlebars";
import ZooKeeper from "zk";
import StandbyNode from "./standby_node";
import ZkUtil from "./zk_util";
import {spawn} from "child_process";

export default class BDRNode{
    constructor(cluster_ctl){
        this.zk_path = null;
        this.zk = null;
        this.cluster_ctl = cluster_ctl;

        this.init();
    }

    async apoptosis(){ //programmed cluster death
        console.log("Node death requested. %s is shutting down...", this.zk_path);
        await this.closeConnection();
        process.exit(0);
    }

    apoptosisMonitor () {
        console.log("Monitoring for signs of shutdown signal...");
        this.zk.exists(this.zk_path, true).then(reply => {
            if(!reply.stat){
                this.apoptosis();
            }else{
                reply.watch.then(event => {
                    if(event.type == 'deleted'){
                        this.apoptosis();
                    }else{
                        this.apoptosisMonitor()
                    }
                });
            }
        });
    }

    init () {
        this.zk = new ZooKeeper({
            connect: `${$config.nodes[0].host}:${$config.zk_client_port}`,
            timeout: 20000,
            debug_level: ZooKeeper.ZOO_LOG_LEVEL_WARN,
            host_order_deterministic: false
        });

        this.zk.connect().then(() => {
            console.log ("zk session established, id=%s", this.zk.client_id);
            this.zk.create('/config/node.',
                JSON.stringify({pid: process.pid, initialized: false}),
                ZooKeeper.ZOO_EPHEMERAL | ZooKeeper.ZOO_SEQUENCE)
                .then((_path) => {
                    this.zk_path = _path;
                    this.apoptosisMonitor();

                    //spin up the standby nodes...
                    for(let i = 0; i < $config.pg_slave_count + 1; i++){ //one more sub-node created (will be master)
                        let cp = spawn(`node --inspect=9229 ${path.join(__dirname, 'standby_node.js')}`);
                        cp.send(_path);
                    }

                    ZkUtil.monitorInitialized(_path, this.zk).then(async () => {
                        await zk.get(_path).then(async (reply) => {
                            let _o = JSON.parse(reply.data);
                            _o.initialized = true;
                            await zk.set(_path, JSON.stringify(_o), -1);
                        });
                    });
                });
        });

        process.on('exit', this.closeConnection.bind(this));
        process.on('SIGINT', this.closeConnection.bind(this));
        process.on('SIGUSR1', this.closeConnection.bind(this));
        process.on('SIGUSR2', this.closeConnection.bind(this));

    }

    async closeConnection () {
        if(this.zk_path){
            await this.zk.exists(this.zk_path).then(reply => {
                if(reply.stat){
                    return this.zk.delete(this.zk_path).then(() => {
                        return this.zk.close();
                    });
                }else{
                    return this.zk.close();
                }
            })

        }else{
            await this.zk.close();
        }

    }

}

new BDRNode();