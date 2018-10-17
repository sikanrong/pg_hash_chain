import ZooKeeper from "zk";
import * as $config from "../../cluster";
import q from "q";

export default class Node {

    constructor(){
        this.zk_path = null;
        this.zk = this.configZookeeper();
        this.pid = process.pid;
    }

    apoptosis(){ //programmed cluster death
        console.log("Node death requested. %s is shutting down...", this.zk_path);
        process.kill(process.pid);
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
        }, () => {
            this.apoptosis();
        });
    }

    configZookeeper () {
        return new ZooKeeper({
            connect: `${$config.nodes[0].host}:${$config.zk_client_port}`,
            timeout: 200000,
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
                const _d = JSON.parse(reply.data);
                if(_d.initialized)
                    deferreds[_c].resolve();

                reply.watch.then((event) => {
                    monitorChild(_c);
                });
            });
        };

        this.zk.getChildren(this.zk_path, true).then((reply) => {
            reply.children.forEach(child => {
                if(deferreds[child])
                return;

                deferreds[child] = q.defer();
                monitorChild(child);
            });

            if(Object.keys(deferreds).length == desiredChildCount){

                q.all(Object.keys(deferreds).map(_k => {
                    return deferreds[_k].promise;
                })).then(_d.resolve);
            }

            reply.watch.then(event => {
                this.monitorInitialized(desiredChildCount);
            });
        });

        return _d.promise;
    }

}