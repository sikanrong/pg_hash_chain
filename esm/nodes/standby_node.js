import * as fs from "fs";
import * as path from "path";
import Handlebars from "handlebars";
import ZooKeeper from "zk";
import * as $config from "../../cluster";
import Node from "./node";
import {fork} from "child_process";

class StandbyNode extends Node{
    constructor(){
        super();

        this.is_master = false;
        this.slave_lock_held = null;
        this.slave_lock_path = null;
        this.master_lock_path = null;

        this.init();
    }

    async getMasterLock(){
        return new Promise(async (resolve, reject) => {
            this.getLock(`/lock/master/${this.zk_myid}`).subscribe(async _o => {
                switch(_o.action){
                    case 'granted':
                        this.is_master = true;

                        if(this.slave_lock_held){
                            //release the slave lock we hold so that another process can take over that slave slot
                            const g_reply = await this.zk.get(this.slave_lock_path).then(_r => {return _r}, err => {
                                throw new Error(err);
                            });

                            await this.zk.delete(this.slave_lock_path, g_reply.stat.version).then(_r => {return _r}, err => {
                                throw new Error(err);
                            });

                            this.slave_lock_held = null;
                            this.slave_lock_path = null;
                        }

                        this.replenishSlaves();

                        //***THERE IS NO BREAK HERE JUST SO YOU KNOW***
                        //#iGotYourBackBro
                    case 'queued':
                        this.master_lock_path = _o.lockfile;

                        resolve(this.master_lock_path);
                        break;
                }
            });
        });
    }

    getSlaveLocks(){
        return new Promise(async (resolve, reject) => {
            for(var i = 0; i < $config.pg_slave_count; i++){
                this.getLock(`/lock/slave/${this.zk_myid}/${i}`).subscribe(async _o => {
                    switch(_o.action){
                        case 'granted':
                            const slave_idx = path.basename(_o.path);
                            if(this.slave_lock_held == null && !this.is_master){
                                this.slave_lock_held = slave_idx;
                                this.slave_lock_path = _o.lockfile;
                                resolve();
                            }else{
                                const g_reply = await this.zk.get(_o.lockfile).then(_r => {return _r}, (err) => {
                                    throw new Error(err);
                                });
                                const d_reply = await this.zk.delete(_o.lockfile, g_reply.stat.version).then(_r => {return _r}, (err) => {
                                    throw new Error(err);
                                });
                            }

                            break;
                        case 'queued':
                            //Do nothing until a slave lock is actually granted.
                            break;
                    }
                });
            }
        });
    }

    async setInitialized(){
        await this.updateJsonZKData(this.zk_path, {initialized: true});
    }

    replenishSlaves(){
        const watchSlaveLocks = async () => {
            for(let i = 0; i < $config.pg_slave_count; i++){
                const gc_reply = await this.zk.getChildren(`/lock/slave/${this.zk_myid}/${i}`, true);
                if(gc_reply.children.length == 0){
                    //spin up a new process
                    console.log(`Master (pid: ${this.pid}) is spinning up a new process for ${slave_lock_path}`);
                    fork(path.join($config.app_deploy_path, 'current', 'cjs', 'nodes', 'standby_node.js'), [
                        `zk_parent_path=${this.zk_parent_path}`
                    ]);
                }

                gc_reply.watch.then(watchSlaveLocks.bind(this));
            }
        };

        watchSlaveLocks();
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

                setTimeout(()=>{
                    if(this.is_master == false && this.slave_lock_held == null){
                        console.log(`Killing (pid: ${this.pid}) ${this.zk_path} for not being able to aquire any locks.`);
                        //kill this process if it has obtained no locks after the timeout
                        process.kill(process.pid);
                    }
                }, $config.app_lock_timeout);

                await this.getMasterLock();

                if(!this.is_master){
                    await this.getSlaveLocks();
                }
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
