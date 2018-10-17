import * as $config from "../cluster.json"
import ZooKeeper from "zk";
import * as path from "path";

export default {
    configZookeeper: function () {
        return new ZooKeeper({
            connect: `${$config.nodes[0].host}:${$config.zk_client_port}`,
            timeout: 20000,
            debug_level: ZooKeeper.ZOO_LOG_LEVEL_WARN,
            host_order_deterministic: false
        });
    },

    //Will monitor all children of a given path and resolve when they all have
    //the 'initialized' key set to 'true

    monitorInitialized: (_p, zk) => {
        const deferreds = {};
        const _d = Promise.defer();

        const monitorChild = (_c) => {
            zk.get(path.join(_p, _c), true).then(reply => {
                const _d = JSON.parse(reply.data);
                if(_d.initialized)
                    deferreds[_c].resolve();

                reply.watch.then((event) => {
                    if(event.type == 'deleted'){
                        deferreds[_c].reject('deleted');
                    }
                    monitorChild(_c);
                });
            });
        };

        zk.getChildren(_p, true).then((reply) => {
            reply.children.forEach(child => {
                if(deferreds[child])
                    return;

                deferreds[child] = Promise.defer();
                monitorChild(child);
            });

            if(Object.keys(deferreds).length == $config.nodes.length){

                Promise.all(Object.keys(deferreds).map(_k => {
                    return deferreds[_k].promise;
                })).then(_d.resolve);
            }

            reply.watch.then(event => {
                this.monitorInitialized(_p, zk);
            })
        });

        return _d.promise;
    }
}