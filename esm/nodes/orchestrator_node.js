import q from "q";
import * as $config from "../../cluster";
import * as path from "path";
import Node from "./node";
import exec from "ssh-exec";
import ZooKeeper from "zookeeper";

export default class OrchestratorNode extends Node{
    constructor(spawn_remote){
        super();
        this.spawn_remote = spawn_remote;
        this.init_promise = this.init();
    }

    init(){
        return this.zk.connect().then(async () => {
            console.log ("OrchestratorNode: zk session established, id=%s", this.zk.client_id);

            await this.zkMkdirp('/config');

            for(let myid in $config.nodes){
                await this.zkMkdirp(`/lock/${myid}`, "[]");
            }

            return this.zk.create(
                '/config/deploy.',
                "[]",
                (ZooKeeper.ZOO_SEQUENCE)
            ).then(_p => {
                this.zk_path = _p;
                return this.zk.getChildren('/config').then(async (reply)=>{

                    let _pchild = null;
                    if(reply.children.length > 1)
                        _pchild = reply.children.sort()[reply.children.length - 2];

                    if(!_pchild) //if there is no previous deploy, go to the next step.
                        return;

                    const _r = await this.zk.getChildren(path.join('/config', _pchild)).then(_r => {return _r}, (reason)=>{
                        console.warn(`Cannot get data from ${path.join('/config', _pchild)}: ${reason}`);
                    });

                    return Promise.all(_r.children.map(async child => {
                        const _r = await this.zk.get(path.join('/config', _pchild, child));
                        const json_str = String(_r.data);

                        const _o = JSON.parse(json_str);

                        const pids = [_o.pid, _o.pg_pid].filter(_p => {
                            return (_p !== undefined);
                        });

                        return new Promise((resolve, reject) => {
                            exec(`sudo kill ${pids.join(' ')}`, {
                                user: _o.user,
                                host: _o.host,
                                key: $config.ssh_key
                            }, (err, stdout) => {
                                if(err){
                                    console.warn(`Could not kill process with pid ${_o.pid}: process not running.`);
                                }
                                
                                resolve();
                            });
                        });
                    }));
                });
            }).then(async () => {
                this.spawn_remote(this.zk_path);
            }).then(() => {
                const total_nodes = (Object.keys($config.nodes).length * ($config.pg_slave_count + 1));
                return this.monitorInitialized(total_nodes);
            }).then(() => {
                this.zk.close();
            });
        });
    }
}