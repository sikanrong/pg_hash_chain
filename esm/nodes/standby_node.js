import * as fs from "fs";
import * as path from "path";
import Handlebars from "handlebars";
import ZooKeeper from "zk";
import * as $config from "../../cluster";
import Node from "./node";

class StandbyNode extends Node{
    constructor(_p, db_port, app_port){
        super();

        this.zk_parent_path = _p;
        this.db_port = db_port;
        this.app_port = app_port;
        this.is_master = false;

        this.init();
    }

    async init(){
        await this.zk.connect().then(() => {
            return this.zk.create(
                path.join('/config', 'subnode.'),
                JSON.stringify({
                    initialized: true,
                    pid: this.pid,
                    db_port: this.db_port,
                    app_port: this.app_port
                }),
                ZooKeeper.ZOO_EPHEMERAL | ZooKeeper.ZOO_SEQUENCE
            ).then(async _path => {
                this.zk_path = _path;
                // const _lock_path = await this.zk.create(
                //     path.join(this.zk_parent_path, 'master_lock', 'lock.'),
                //     new String(),
                //     ZooKeeper.ZOO_EPHEMERAL | ZooKeeper.ZOO_SEQUENCE );
                //
                //
                // await this.zk.getChildren(path.join(this.zk_parent_path, 'master_lock')).then(reply => {
                //     const sorted_locks = reply.children.sort();
                //     const mylock_idx = sorted_locks.indexOf(path.basename(_lock_path));
                //     if(mylock_idx > 0){
                //         //I don't have the lock :(
                //         const _prev_lock_path = path.join(path.dirname(_lock_path), sorted_locks[mylock_idx - 1]);
                //         this.zk.exists(_prev_lock_path, true).then(
                //             reply => {
                //                 reply.watch.then((event) => {
                //                     if(event.type == 'deleted'){
                //                         //This node is the new master!
                //                         console.log(`Node (pid: ${this.pid}) ${this.zk_path} is now being promoted to MASTER.`);
                //                         this.is_master = true;
                //                     }
                //                 });
                //             },
                //             reason => {
                //                 throw new Error(`Unable to wait for : ${reason}`)
                //             });
                //     }
                //
                //     //otherwise, the lock is mine and I just exit the protocol
                // });
            }).then(this.apoptosisMonitor.bind(this));
        });
    }
}

process.on('message', _p => {
    new StandbyNode(_p, process.argv['db_port'], process.argv['app_port']);
});