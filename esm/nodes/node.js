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
        this.host = $config.nodes[this.zk_myid].host;
        this.user = $config.nodes[this.zk_myid].user;
    }

    async setZkMyid(){
        return new Promise((resolve, reject) => {
            exec(`cat ${$config.zk_config_path}/myid`, (err, stdout) => {
                this.zk_myid = stdout.trim();
                resolve(this.zk_myid);
            });
        });
    }

    async updateJsonZKData(path, data, maxRetries){
        let tries = 0;

        if(maxRetries === undefined)
            maxRetries = $config.zk_update_retries;

        return new Promise((resolve, reject) => {
            const doUpdate = async () => {
                let reply = await this.zk.get(path).then(_r => {return _r;}, (err) => {
                    throw new Error(err);
                });

                const newData = Object.assign(JSON.parse(reply.data), data);

                reply = await this.zk.set(path, JSON.stringify(newData), reply.stat.version).then(_r => {
                    return _r;
                }, (err) => {
                    if(err.name == 'ZBADVERSION'){
                        console.log(`${err.toString()}: ${err.path}`);
                    }else{
                        throw new Error(err);
                    }
                });

                if(!reply){
                    if(++tries > max_retries){
                        throw new Error(`Update ${path}: max_retries (${max_retries}) exceeded`);
                    }else{
                        return await doUpdate(path, data);
                    }
                }else{
                    return reply.stat;
                }
            };

            doUpdate().then(resolve);
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
                if(_data.initialized){
                    deferreds[_c].resolve();
                    console.log(`monitorInitialized: ${this.zk_path} init signal received`);
                }


                reply.watch.then((event) => {
                    monitorChild(_c);
                });
            }, (err) => {
                deferreds[_c].reject(err);
                throw new Error(err);
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

                console.log(`MonitorInitialized: monitoring ${reply.children.length} for init signal.`);

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