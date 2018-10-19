//Yeah so this file has an unfortunate name, but it seemed stupid to avoid it when it's probably
//(linguistally) the best choice.

import ZooKeeper from "zk";
import * as $config from "../../cluster";
import * as path from "path";
import q from "q";
import {exec} from "child_process";

export default class Node {

    constructor(){
        this.zk_path = null;
        //parse out the parent path from the ARGV
        const zk_parent_arg = process.argv.filter(arg => {
            return (arg.indexOf('zk_parent_path') > -1)
        })[0]
        this.zk_parent_path = (zk_parent_arg)? zk_parent_arg.split('=')[1] : null;
        this.zk = this.configZookeeper();
        this.pid = process.pid;
        this.zk_myid = null;
        this.host = null;
        this.user = null;
    }

    async init(){
        await this.setZkMyid();
        this.host = $config[this.zk_myid].host;
        this.user = $config[this.zk_myid].user;
    }

    async setZkMyid(){
        return new Promise((resolve, reject) => {
            exec(`cat ${$config.zk_config_path}/myid`, (err, stdout) => {
                this.zk_myid = stdout.trim();
                resolve(this.zk_myid);
            });
        });
    }

    apoptosis(){ //programmed cluster death
        console.log("Node death requested. %s is shutting down...", this.zk_path);
        process.kill(process.pid);
    }

    apoptosisMonitor () {
        console.log(`${this.zk_path} ONLINE: Monitoring for signs of shutdown signal...`);
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
        }, () => {
            this.apoptosis();
        });
    }

    configZookeeper () {
        return new ZooKeeper({
            connect: `${$config.nodes[Object.keys($config.nodes)[0]].host}:${$config.zk_client_port}`,
            timeout: $config.zk_connection_timeout,
            debug_level: ZooKeeper.ZOO_LOG_LEVEL_WARN,
            host_order_deterministic: false
        });
    }

    //Will monitor all children of a given path and resolve when they all have
    //the 'initialized' key set to 'true

    monitorInitialized(desiredChildCount) {
        const deferreds = {};
        const _d = q.defer();

        const monitorChild = (_c) => {
            this.zk.get(path.join(this.zk_path, _c), true).then(reply => {
                const _data = JSON.parse(reply.data);
                if(_data.initialized)
                    deferreds[_c].resolve();

                reply.watch.then((event) => {
                    monitorChild(_c);
                });
            });
        };

        const monitorChildren = () => {
            this.zk.getChildren(this.zk_path, true).then((reply) => {
                reply.children.forEach(child => {
                    if(deferreds[child])
                        return;

                    deferreds[child] = q.defer();
                    monitorChild(child);
                });

                console.log(`MonitorInitialized seeing ${reply.children.length} children initialized.`);

                if(reply.children.length == desiredChildCount){

                    q.all(Object.keys(deferreds).map(_k => {
                        return deferreds[_k].promise;
                    })).then(()=>{
                        _d.resolve();
                    });
                }

                reply.watch.then(event => {
                    monitorChildren();
                });
            });
        };

        monitorChildren();

        return _d.promise;
    }

}