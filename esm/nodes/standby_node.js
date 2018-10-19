import * as fs from "fs";
import * as path from "path";
import Handlebars from "handlebars";
import ZooKeeper from "zk";
import * as $config from "../../cluster";
import Node from "./node";

class StandbyNode extends Node{
    constructor(){
        super();

        this.is_master = false;
        this.master_lock_path = null;

        this.init();
    }

    async getMasterLock(){
        //Get in line to get ahold of the master lock
        const _lock_path = `/lock/${this.zk_myid}`;

        this.master_lock_path = await this.zk.create(path.join(_lock_path, 'master.'),
            new String(),
            (ZooKeeper.ZOO_SEQUENCE | ZooKeeper.ZOO_EPHEMERAL)).then(_p => {return _p}, (err)=>{
                throw new Error(err);
        });

        const gc_reply = await this.zk.getChildren(_lock_path).then(_r => {return _r}, (err) => {
            throw new Error(err);
        });

        const sorted_locks = gc_reply.children.sort();
        const mylock_idx = sorted_locks.indexOf(path.basename(this.master_lock_path));
        if(mylock_idx == 0){
            //if my lock is first i just exit happily
            this.is_master = true;
            return;
        }

        //I don't have the lock :(
        const _prev_lock_path = path.join(path.dirname(_lock_path), sorted_locks[mylock_idx - 1]);
        await this.zk.exists(_prev_lock_path, true).then(reply => {
            reply.watch.then((event) => {
                if(event.type == 'deleted'){
                    //This node is the new master!
                    console.log(`Node (pid: ${this.pid}) ${this.zk_path} is now being promoted to MASTER.`);
                    this.is_master = true;
                }
            });
        },
        reason => {
            throw new Error(reason);
        });
    }

    async setInitialized(){
        await this.updateJsonZKData(this.zk_path, {initialized: true});
    }

    async init(){
        await super.init();
        await this.zk.connect().then(() => {
            return this.zk.create(
                path.join(this.zk_parent_path, 'subnode.'),
                JSON.stringify({
                    initialized: false,
                    pid: this.pid,
                    host: this.host,
                    user: this.user
                }),
                ZooKeeper.ZOO_EPHEMERAL | ZooKeeper.ZOO_SEQUENCE
            ).then(async _path => {
                this.zk_path = _path;
                await  this.getMasterLock();
            }).then(()=>{
                //start Apoptosis monitor
                this.apoptosisMonitor();
                return;
            }).then(async () => {
                await this.setInitialized();
            });
        });
    }
}

new StandbyNode();
