//Yeah so this file has an unfortunate name, but it seemed stupid to avoid it when it's probably
//(linguistally) the best choice.

import ZooKeeper from "zk";
import * as $config from "../../cluster";
import * as path from "path";
import q from "q";
import {exec} from "child_process";
import {Subject, ReplaySubject} from "rxjs";

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
        this.pg_pid = null;
        this.zk_myid = null;
        this.host = null;
        this.user = null;
    }

    async init(){
        await this.setZkMyid();
        this.host = $config.nodes[this.zk_myid].host;
        this.user = $config.nodes[this.zk_myid].user;

        setInterval(async () => {
            //heartbeat change
            const g_reply = await this.zk.get('/config').then(_r => {return _r}, (err) => {
                if(err.name == 'ZNONODE'){
                    this.apoptosis();
                }

                throw new Error(err);
            });

        }, 1000);
    }

    async setZkMyid(){
        return new Promise((resolve, reject) => {
            exec(`cat ${$config.zk_config_path}/myid`, (err, stdout) => {
                this.zk_myid = stdout.trim();
                resolve(this.zk_myid);
            });
        });
    }

    lockSlot(){
        let sbj = new Subject();


        this.zk.create(`/lock/${this.zk_myid}/slot.`, new String(this.pid), (ZooKeeper.ZOO_SEQUENCE | ZooKeeper.ZOO_EPHEMERAL)).then( _lf => {
            const lockfile = path.basename(_lf);
            sbj.next({
                message: 'lockfile_created',
                lockfile: lockfile
            });

            let attemptGetSlot = () => {
                this.zk.getChildren(`/lock/${this.zk_myid}`, true).then(async _r => {

                    const node_idx = _r.children.sort().indexOf(lockfile);

                    if(node_idx > $config.pg_slave_count){
                        sbj.next({
                            message: 'queued',
                            lock_idx: node_idx
                        });

                        //watch for possibility to get un-queued
                        _r.watch.then(attemptGetSlot.bind(this), _e => {
                            throw new Error(_e);
                        });

                        return;
                    }

                    let g_reply = await this.zk.get(`/lock/${this.zk_myid}`).then(_r => {return _r}, _e => {
                        throw new Error(_e);
                    });

                    let slot_ar = JSON.parse(g_reply.data);
                    let slot_idx = null;

                    for(let i = 0; i <= $config.pg_slave_count; i++){
                        if( slot_ar[i] === undefined ||
                            slot_ar[i] == lockfile ||
                            _r.children.indexOf(slot_ar[i]) == -1){
                                slot_ar[i] = lockfile;
                                slot_idx = i;
                                break;
                        }
                    }

                    await this.zk.set(`/lock/${this.zk_myid}`, JSON.stringify(slot_ar), g_reply.stat.version).then(_r => {
                        sbj.next({
                            message: 'granted',
                            lock_idx: node_idx,
                            slot_idx: slot_idx
                        });

                        return _r;
                    }, _e => {
                        if(_e.name == 'ZBADVERSION'){
                            attemptGetSlot();
                        }else{
                            throw new Error(_e);
                        }
                    });

                }, _e => {
                    throw new Error(_e);
                });
            };

            attemptGetSlot();

        }, (err) => {
            throw new Error(err);
        });

        return sbj;
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
                    if(++tries > maxRetries){
                        throw new Error(`Update ${path}: maxRetries (${maxRetries}) exceeded`);
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
        process.kill(this.pid);
        try{
            process.kill(this.pg_pid);
        }catch(_e){
            console.log(_e.toString());
        }

    }

    apoptosisMonitor () {
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

    //same args as zk.create
    //same idea as POSIX mkdirp
    //data is only inserted for last node in chain
    async zkMkdirp(_path, data){
        const path_ar = _path.substr(1).split('/');
        const path_constructed_ar = [];
        while(path_ar.length > 0){
            path_constructed_ar.push(path_ar.shift());
            let insert_data = undefined;
            if(path_ar.length == 0){
                insert_data = data; //insert data on the last iteration
            }
            await this.zk.create(`/${path.join.apply(this, path_constructed_ar)}`, insert_data).then(_p => {return _p}, (err) => {
                if(err.name != 'ZNODEEXISTS'){
                    throw new Error(err);
                }
            })
        }
    }

    //Will monitor all children of a given path and resolve when they all have
    //the 'initialized' key set to 'true

    monitorInitialized(desiredChildCount) {
        const observables = {};
        const subscriptions = {};
        const initialized = {};
        let nodesInitialized = 0;
        const _d = q.defer();

        const checkFinished = () => {
            if(nodesInitialized == desiredChildCount){
                _d.resolve();
            }
        }

        const monitorChild = (_c) => {
            const outstream = observables[_c];

            const _cpath = path.join(this.zk_path, _c);
            this.zk.get(_cpath, true).then(reply => {
                const _data = JSON.parse(reply.data);
                if(_data.initialized){
                    initialized[_c] = true;
                    outstream.next({
                        path: _cpath,
                        action: 'init'
                    });
                }

                reply.watch.then((event) => {
                    if(event.type == 'deleted'){
                        outstream.next({
                            path: _cpath,
                            action: (initialized[_c])? 'init_deleted' : 'uninit_deleted'
                        });
                    }else{
                        monitorChild(_c);
                    }
                });
            }, (err) => {
                if(err.name == 'ZNONODE'){
                    outstream.next({
                        path: _cpath,
                        action: (initialized[_c])? 'init_deleted' : 'uninit_deleted'
                    });
                }else{
                    throw new Error(err);
                }
            });

            return outstream;
        };

        const monitorChildren = () => {
            this.zk.getChildren(this.zk_path, true).then((reply) => {
                reply.children.forEach(child => {
                    if(observables[child])
                        return;

                    observables[child] = new Subject();
                    subscriptions[child] = observables[child].subscribe(_o => {
                        switch(_o.action){
                            case 'init':
                                nodesInitialized++;
                                subscriptions[child].unsubscribe();
                                console.log(`monitorInitialized: ${_o.path} INIT signal received (${nodesInitialized}/${desiredChildCount})`);
                                break;
                            case 'init_deleted':
                                nodesInitialized--;
                            case 'uninit_deleted':
                                delete observables[child];
                                subscriptions[child].unsubscribe();
                                delete subscriptions[child];
                                console.log(`monitorInitialized: ${_o.path} DELETE signal received (${nodesInitialized}/${desiredChildCount})`);
                                break;
                        }

                        checkFinished();
                    });

                    monitorChild(child);

                });

                checkFinished();

                reply.watch.then(event => {
                    monitorChildren();
                });
            });
        };

        monitorChildren();

        return _d.promise;
    }

}