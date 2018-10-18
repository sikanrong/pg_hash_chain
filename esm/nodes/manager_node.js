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
            }).then(()=>{
                return new Promise((resolve, reject) => {
                    const watchChildren = () => {
                        this.zk.getChildren('/config', true).then(async reply =>{
                            const matching_children = reply.children.filter(child => {
                                return (child.indexOf(path.basename(this.zk_path)) != -1);
                            });

                            if(matching_children.length == (2 + $config.pg_slave_count)){
                                await this.zk.get(this.zk_path).then(async reply => {
                                    const _o = JSON.parse(reply.data);
                                    _o.initialized = true;
                                    await this.zk.set(this.zk_path, JSON.stringify(_o), -1);
                                });

                                resolve();
                            }

                            reply.watch.then(event => {
                                watchChildren();
                            });
                        });
                    };

                    watchChildren();
                });
            });
        });

    }

}

new ManagerNode();