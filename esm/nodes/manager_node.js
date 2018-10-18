import * as fs from "fs";
import * as path from "path";
import * as $config from "../../cluster";
import Handlebars from "handlebars";
import ZooKeeper from "zk";
import StandbyNode from "./standby_node";
import {fork} from "child_process";
import Node from "./node";

class ManagerNode extends Node{
    constructor(){
        super();

        this.init();
    }

    init () {
        this.zk.connect().then(async () => {
            console.log ("zk session established, id=%s", this.zk.client_id);
            this.zk.create('/config/node.',
                JSON.stringify({pid: process.pid, initialized: false}),
                ZooKeeper.ZOO_SEQUENCE | ZooKeeper.ZOO_EPHEMERAL)
                .then(async (_path) => {

                    // await this.zk.create(path.join(_path, 'master_lock'), JSON.stringify({initialized: false})).then(()=>{}, (reason)=>{
                    //     console.warn(`Could not create ${path.join(_path, 'master_lock')}: ${reason}`);
                    // });

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
                });
        });

    }

}

new ManagerNode();