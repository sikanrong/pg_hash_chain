import * as fs from "fs";
import * as path from "path";
import * as $config from "../cluster";
import Handlebars from "handlebars";
import ZooKeeper from "zk";
import StandbyNode from "./standby_node";
import ZkUtil from "./zk_util";
import {fork} from "child_process";
import Node from "./node";

class ManagerNode extends Node{
    constructor(){
        super();

        this.init();
    }

    init () {
        super.init();

        this.zk = new ZooKeeper({
            connect: `${$config.nodes[0].host}:${$config.zk_client_port}`,
            timeout: 20000,
            debug_level: ZooKeeper.ZOO_LOG_LEVEL_WARN,
            host_order_deterministic: false
        });

        this.zk.connect().then(async () => {
            console.log ("zk session established, id=%s", this.zk.client_id);
            this.zk.create('/config/node.',
                JSON.stringify({pid: process.pid, initialized: false}),
                ZooKeeper.ZOO_SEQUENCE)
                .then(async (_path) => {

                    await this.zk.create(path.join(_path, 'master_lock')).then(()=>{}, (reason)=>{
                        throw new Error(`Could not create ${path.join(_path, 'master_lock')}: ${reason}`);
                    });

                    this.zk_path = _path;
                    this.apoptosisMonitor();

                    //spin up the standby nodes...
                    for(let i = 0; i < $config.pg_slave_count + 1; i++){ //one more sub-node created (will be master)
                        let cp = fork(path.join(__dirname, 'standby_node.js'), [
                            `db_port=${$config.pg_port_start + i}`,
                            `app_port=${$config.app_port_start + i}`
                        ], {
                            execArgv: [`--inspect=${$config.app_debug_port_start + i}`]
                        });
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

    }

}

new ManagerNode();